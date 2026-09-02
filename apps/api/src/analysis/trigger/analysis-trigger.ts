import { type AnalysisEventStore, AnalysisRunGate } from "@autonoma/analysis";
import { type BillingService, clearBranchTriggerBlock, recordBranchTriggerBlocked } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { recordBranchDeployment } from "@autonoma/scenario";
import { hasGoneLive } from "@autonoma/types";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";
import { isBaseTrunkGateEnforced } from "../../github/base-trunk-gate";
import { sameGitRef } from "../../github/git-ref";
import type { GitHubInstallationService } from "../../github/github-installation.service";
import { postInsufficientCreditsComment } from "../../github/insufficient-credits-comment";
import { upsertPrBranch } from "../../routes/branches/upsert-pr-branch";
import { Service } from "../../routes/service";
import { analysisPokeGate } from "../analysis-poke-gate";
import { enqueueAnalysisEvent, enqueueAndStartAnalysisRun } from "../enqueue-and-start-analysis-run";
import { isActivationGated } from "../is-activation-gated";
import type { AnalysisOccurrence, OccurrenceDeployment } from "./occurrence";
import type { DeliveryReceipt } from "./receipt";

/** The GitHub reads the trigger needs: a PR's head/base, a branch's head, the repo, and posting the credits comment. */
export type AnalysisTriggerGitHubReader = Pick<
    GitHubInstallationService,
    "getPullRequest" | "getBranchHead" | "getRepository" | "postComment" | "updateComment" | "deleteComment"
>;

/** The starter a producer injects. Returns the workflow id when it has one; the diffs producer does not. */
export type StartAnalysisRun = (input: AnalysisRunWorkflowInput) => Promise<string | undefined>;

/**
 * The one front door for starting an analysis run. Producers translate whatever they observed into an
 * {@link AnalysisOccurrence} and call {@link deliver}; the module owns every gate and returns a {@link DeliveryReceipt}
 * describing what it decided. It encodes facts and decisions only - never deploy/analysis sequencing, never build
 * ownership.
 */
export class AnalysisTrigger extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: AnalysisTriggerGitHubReader,
        private readonly billingService: Pick<BillingService, "checkAnalysisCreditsGate">,
        private readonly startAnalysisRun: StartAnalysisRun,
        private readonly events: AnalysisEventStore,
    ) {
        super();
    }

    /** Decide and, when a gate clears, act on one occurrence. Throws only on infrastructure failure, never a gate. */
    async deliver(occurrence: AnalysisOccurrence): Promise<DeliveryReceipt> {
        const locator = occurrence.locator;
        this.logger.info("Delivering analysis occurrence", {
            organizationId: occurrence.organizationId,
            extra: { locator: locator.kind, kind: occurrence.kind, requested: occurrence.requested },
        });

        switch (locator.kind) {
            case "pr":
                return this.deliverPullRequest(occurrence, locator);
            case "main":
                return this.deliverMain(occurrence, locator);
            case "ref":
                return this.deliverRef(occurrence, locator);
        }
    }

    /** The raw-webhook form: a `main` push matches the app's trunk ref, otherwise it is the PR named by `prNumber`. */
    private async deliverRef(
        occurrence: AnalysisOccurrence,
        locator: { repoId: number; githubRef: string; prNumber?: number },
    ): Promise<DeliveryReceipt> {
        const mainBranchInfo = await this.db.mainBranchInfo.findFirst({
            where: {
                application: { organizationId: occurrence.organizationId, githubRepositoryId: locator.repoId },
            },
            select: { githubRef: true },
        });

        if (mainBranchInfo?.githubRef === locator.githubRef) {
            return this.deliverMain(occurrence, { repoId: locator.repoId });
        }
        if (locator.prNumber != null) {
            return this.deliverPullRequest(occurrence, { repoId: locator.repoId, prNumber: locator.prNumber });
        }
        return { status: "refused", reason: "unsupported_ref" };
    }

    private async deliverPullRequest(
        occurrence: AnalysisOccurrence,
        locator: { repoId: number; prNumber: number },
    ): Promise<DeliveryReceipt> {
        const { organizationId, source } = occurrence;
        const { repoId, prNumber } = locator;
        const requested = occurrence.requested;

        const app = await this.db.application.findFirst({
            where: { organizationId, githubRepositoryId: repoId },
            select: { id: true, mainBranchInfo: { select: { githubRef: true } } },
        });

        if (app == null) return { status: "refused", reason: "no_application_linked" };

        // Before the branch is created, not after: the Branch row is what puts a pull request on the customer's
        // Home screen, so an application still being set up must not leave one behind for a pull request nobody
        // reviewed. An explicit request (`/start analysis`) still runs - the same bypass the activation gate uses.
        if (!requested && !(await this.isLive(app.id))) {
            this.logger.info("Skipping PR diffs: the application has not gone live yet", {
                organizationId,
                extra: { repoId, prNumber },
            });
            return { status: "skipped", reason: "not_gone_live" };
        }

        const pullRequest = await this.githubInstallationService.getPullRequest(organizationId, repoId, prNumber);

        // Only a PR merging INTO the app's trunk is in scope for orgs that opt into the gate. A PR targeting another
        // branch (a stack, an internal integration branch) is not analyzed - and this is absolute, so an explicit
        // `/start analysis` is refused too. Refuse before creating a Branch, so an out-of-scope PR leaves nothing
        // behind. An app with no recorded trunk cannot be judged either way, so it is left to proceed. The org flag
        // is read only when the base actually differs, so an in-scope PR never pays for the lookup.
        const trunkRef = app.mainBranchInfo?.githubRef;
        const baseIsOffTrunk = trunkRef != null && !sameGitRef(pullRequest.baseRef, trunkRef);
        if (baseIsOffTrunk && (await isBaseTrunkGateEnforced(this.db, organizationId))) {
            this.logger.info("Refusing PR diffs: the PR does not target the app's main branch", {
                organizationId,
                extra: { repoId, prNumber, baseRef: pullRequest.baseRef, trunkRef },
            });
            return { status: "refused", reason: "base_not_trunk" };
        }

        const headSha = occurrence.head?.headSha ?? pullRequest.headSha;
        const baseSha = occurrence.head?.baseSha ?? pullRequest.baseSha;

        const branch = await upsertPrBranch({
            db: this.db,
            applicationId: app.id,
            organizationId,
            prNumber,
            name: pullRequest.headRef,
        });

        this.logger.info("Resolved branch and shas", { branchId: branch.id, extra: { headSha, baseSha } });

        // A re-delivered webhook for an already-analyzed head has nothing new to diff; a pending event
        // un-suppresses the skip. `createSnapshot` still supersedes a pending snapshot if the head genuinely
        // moved while one was in flight.
        const gate = await new AnalysisRunGate(this.db).shouldSkipAlreadyAnalyzed({
            branchId: branch.id,
            headSha,
            fallbackBaseSha: baseSha,
        });
        if (gate.skip) {
            this.logger.info("Skipping PR diffs: head already analyzed and the inbox is empty", {
                branchId: branch.id,
                extra: { prNumber, headSha },
            });
            return { status: "skipped", reason: "already_analyzed", branchId: branch.id };
        }

        // Ready-for-review is read here rather than from the `pull_request.ready_for_review` webhook: a
        // customer-deployed preview does not exist yet at webhook time, and this runs once it is live. It is only
        // meaningful under activation - a non-activation org auto-runs regardless - so it is not read otherwise.
        const activationGated = !requested && (await isActivationGated(this.db, organizationId));
        const isAutoRunOnReady = activationGated && (await this.autoRunsOnReady(branch.id));

        // Dedupe of activation triggers racing on the same head: attach to the run an earlier trigger opened
        // instead of superseding it. This covers explicit-vs-explicit (a label added while a `/start analysis`
        // comment is mid-run) AND auto-vs-explicit (a preview-ready auto-run firing just after `/start analysis`
        // opened one).
        if (requested === true || isAutoRunOnReady) {
            const inFlight = await this.findInFlightRunForHead(branch.id, headSha);
            if (inFlight != null) {
                this.logger.info("Attaching to the in-flight run for this head; not starting a duplicate", {
                    branchId: branch.id,
                    snapshot: { snapshotId: inFlight.snapshotId },
                    extra: { headSha, requested: requested === true, isAutoRunOnReady },
                });
                return { status: "attached", branchId: branch.id };
            }
        }

        // A real analyzable event from here on: persist it whether or not we can act on it now, so a deferred push
        // is never lost. Only the poke (starting the run) is gated.
        const launch = { branchId: branch.id, organizationId, source, headSha, baseSha };

        // Ahead of the gate: a customer-hosted deployment is recorded even when its analysis is deferred.
        await this.recordDeploymentIfKnown(branch.id, organizationId, headSha, occurrence.deployment);

        const decision = await analysisPokeGate(
            { db: this.db, billingService: this.billingService },
            { organizationId, requested: requested === true, autoRunOnReady: isAutoRunOnReady },
        );

        if (!decision.poke) {
            await enqueueAnalysisEvent(this.events, launch);
            if (decision.reason === "out_of_credits") {
                await this.recordOutOfCredits(organizationId, repoId, prNumber, headSha, branch.id);
                return { status: "deferred", reason: "out_of_credits_analysis", branchId: branch.id };
            }
            this.logger.info("Activation: suppressing the automatic run; a run starts only on an explicit request", {
                branchId: branch.id,
                extra: { organizationId, headSha },
            });
            return { status: "deferred", reason: "activation_gated", branchId: branch.id };
        }

        // The poke cleared the credits gate, so a stale "insufficient credits" block must not linger on the branch.
        await clearBranchTriggerBlock(this.db, branch.id);
        const workflowId = await this.startRun({ branchId: branch.id, organizationId, source, headSha, baseSha });

        this.logger.info("PR diffs analysis triggered successfully", {
            branchId: branch.id,
            extra: { headSha, baseSha },
        });

        return { status: "started", branchId: branch.id, workflowId };
    }

    private async deliverMain(occurrence: AnalysisOccurrence, locator: { repoId: number }): Promise<DeliveryReceipt> {
        const { organizationId, source } = occurrence;
        const { repoId } = locator;

        this.logger.info("Delivering main branch diffs analysis", { organizationId, extra: { repoId } });

        const app = await this.db.application.findUnique({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repoId } },
            select: {
                id: true,
                mainBranch: { select: { id: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        if (app == null) return { status: "refused", reason: "no_application_linked" };
        if (app.mainBranch == null || app.mainBranchInfo == null) {
            return { status: "refused", reason: "no_main_branch", applicationId: app.id };
        }

        const branchId = app.mainBranch.id;

        // The baseline snapshot is established at go-live, so a not-live main push has no base to diff against yet.
        if (!(await this.isLive(app.id))) {
            this.logger.info("Skipping main diffs: the application has not gone live yet", {
                organizationId,
                extra: { repoId },
            });
            return { status: "skipped", reason: "not_gone_live", branchId };
        }

        const headSha =
            occurrence.head?.headSha ??
            (await this.githubInstallationService.getBranchHead(organizationId, repoId, app.mainBranchInfo.githubRef));

        // Main has no pull request to fall back on, so its baseline snapshot is the only possible base.
        const gate = await new AnalysisRunGate(this.db).shouldSkipAlreadyAnalyzed({ branchId, headSha });
        const baseSha = gate.resolved.baseSha;
        if (baseSha == null) {
            // A live main branch whose active snapshot has no headSha is a data inconsistency; logged fatal so it
            // reaches Sentry, since the refused receipt itself is silent.
            this.logger.fatal("Main branch has no active snapshot with a headSha", undefined, {
                branchId,
                extra: { organizationId, repoId },
            });
            return { status: "refused", reason: "no_analysis_base", branchId };
        }

        this.logger.info("Resolved main branch and shas", { branchId, extra: { headSha, baseSha } });

        // A re-delivered webhook for unchanged main carries the active snapshot's head; a pending event
        // un-suppresses the skip. A real commit moves headSha, so this only collapses true duplicates.
        if (gate.skip) {
            this.logger.info("Skipping main diffs: head matches active snapshot and the inbox is empty", {
                branchId,
                extra: { headSha },
            });
            return { status: "skipped", reason: "already_analyzed", branchId };
        }

        await this.recordDeploymentIfKnown(branchId, organizationId, headSha, occurrence.deployment);

        // Deliberately not activation-gated: activation only suppresses automatic PR analysis. A migrated org's
        // baseline snapshot must keep updating on main pushes, or every later PR diff computes against a stale base.
        const workflowId = await this.startRun({ branchId, organizationId, source, headSha });

        this.logger.info("Main branch diffs analysis triggered successfully", {
            branchId,
            extra: { headSha, baseSha },
        });

        return { status: "started", branchId, workflowId };
    }

    private async startRun(params: {
        branchId: string;
        organizationId: string;
        source: AnalysisOccurrence["source"];
        headSha: string;
        /** The PR base, for a branch with no active snapshot yet. Main always has one, so it passes none. */
        baseSha?: string;
    }): Promise<string | undefined> {
        const { branchId, organizationId, source, headSha, baseSha } = params;
        return enqueueAndStartAnalysisRun(
            { events: this.events, startAnalysisRun: this.startAnalysisRun },
            { branchId, organizationId, source, headSha, baseSha },
        );
    }

    /**
     * Record the out-of-credits refusal: comment on the PR (the shared, dedup'd notice, also used by the
     * previewkit-deploy gate) and record the block on the branch. An already-running run is never cancelled by
     * this, only new starts. Resolving the repo and commenting are best-effort: a GitHub failure must still leave
     * the refusal standing, never turn into a GitHub error. The event is already persisted by the time this runs,
     * so a later top-up can re-poke the deferred run.
     */
    private async recordOutOfCredits(
        organizationId: string,
        repoId: number,
        prNumber: number,
        headSha: string,
        branchId: string,
    ): Promise<void> {
        this.logger.info("Blocking PR analysis: organization is out of credits", {
            organizationId,
            extra: { repoId, prNumber },
        });

        await recordBranchTriggerBlocked(this.db, branchId, "insufficient_credits");

        try {
            const repository = await this.githubInstallationService.getRepository(organizationId, repoId);
            await postInsufficientCreditsComment(
                this.githubInstallationService,
                this.db,
                organizationId,
                repository.fullName,
                prNumber,
                headSha,
            );
        } catch (error) {
            this.logger.warn("Failed to post insufficient-credits PR comment", {
                organizationId,
                extra: { repoId, prNumber, error: String(error) },
            });
        }
    }

    /**
     * Record the deployment the occurrence carries, when it carries one. A customer-hosted push arrives WITH its
     * live URL; a previewkit push has none until its build goes live (the run records that one itself). Called
     * BEFORE the poke gate, so a push deferred out of credits or by activation still lands the coordinate a later
     * re-poke resolves its head from - the recording is not analysis, so it is not gated by the run.
     */
    private async recordDeploymentIfKnown(
        branchId: string,
        organizationId: string,
        headSha: string,
        deployment: OccurrenceDeployment | undefined,
    ): Promise<void> {
        if (deployment == null) return;
        await recordBranchDeployment({
            db: this.db,
            branchId,
            organizationId,
            headSha,
            url: deployment.url,
            webhookUrl: deployment.webhookUrl,
            webhookHeaders: deployment.webhookHeaders,
        });
    }

    /**
     * Undefined when there is no pending snapshot, when it is for a different head (a newer push must supersede
     * rather than attach), or when the branch has no deployment yet.
     */
    private async findInFlightRunForHead(
        branchId: string,
        headSha: string,
    ): Promise<{ snapshotId: string } | undefined> {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: {
                deploymentId: true,
                pendingSnapshot: { select: { id: true, status: true, headSha: true } },
            },
        });
        const pending = branch?.pendingSnapshot;
        if (pending == null || pending.status !== "processing") return undefined;
        if (pending.headSha !== headSha) return undefined;
        if (branch?.deploymentId == null) {
            this.logger.warn("In-flight snapshot for head has no branch deployment; cannot attach, will supersede", {
                branchId,
                snapshot: { snapshotId: pending.id },
                extra: { headSha },
            });
            return undefined;
        }
        return { snapshotId: pending.id };
    }

    /** Under activation, this is what lets an automatic preview-ready run through - fired once the preview is live. */
    private async autoRunsOnReady(branchId: string): Promise<boolean> {
        const branch = await this.db.branch.findUnique({
            where: { id: branchId },
            select: { application: { select: { triggerConfig: { select: { autoRunOnReadyForReview: true } } } } },
        });
        return branch?.application.triggerConfig?.autoRunOnReadyForReview === true;
    }

    /**
     * Whether the application has gone live. An application with no onboarding row reads as not live, which is the
     * shared predicate failing closed - see `hasGoneLive`.
     */
    private async isLive(applicationId: string): Promise<boolean> {
        const state = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { step: true },
        });
        return hasGoneLive(state?.step);
    }
}
