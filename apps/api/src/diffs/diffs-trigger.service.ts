import { type AnalysisEventStore, AnalysisRunGate } from "@autonoma/analysis";
import { type BillingService, clearBranchTriggerBlock, recordBranchTriggerBlocked } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, InsufficientAnalysisCreditsError, InternalError, NotFoundError } from "@autonoma/errors";
import { recordBranchDeployment } from "@autonoma/scenario";
import { type AnalysisEventSource, hasGoneLive } from "@autonoma/types";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";
import { analysisPokeGate } from "../analysis/analysis-poke-gate";
import { enqueueAnalysisEvent, enqueueAndStartAnalysisRun } from "../analysis/enqueue-and-start-analysis-run";
import { isActivationGated } from "../analysis/is-activation-gated";
import { isBaseTrunkGateEnforced } from "../github/base-trunk-gate";
import { sameGitRef } from "../github/git-ref";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { postInsufficientCreditsComment } from "../github/insufficient-credits-comment";
import { upsertPrBranch } from "../routes/branches/upsert-pr-branch";
import { Service } from "../routes/service";

interface BaseTriggerDiffsParams {
    organizationId: string;
    repoId: number;
    source: AnalysisEventSource;
    /** Set when the CALLER knows the URL - a customer-deployed preview. One Autonoma hosts records its own. */
    url?: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
    environment?: string;
}

interface TriggerPrDiffsParams extends BaseTriggerDiffsParams {
    prNumber: number;
    /** True when a merge-gate trigger (e.g. `/start analysis`) explicitly requested this run, bypassing the org's activation gate. */
    requested?: boolean;
}

type TriggerMainDiffsParams = BaseTriggerDiffsParams;

interface TriggerDiffsParams extends BaseTriggerDiffsParams {
    prNumber?: number;
    githubRef: string;
}

/** Why a trigger was a no-op, when it reports one. */
export type TriggerSkipReason = "already_analyzed" | "base_not_trunk";

export interface TriggerDiffsResult {
    /**
     * Absent when the request was refused before a branch existed to name - a PR that does not target the trunk, or
     * a PR on an application that has not gone live yet, where creating the branch is itself part of what is being
     * held back.
     */
    branchId?: string;
    /**
     * True when the request was a no-op: the head was already analyzed, activation suppressed it, the application is
     * still being set up, or the PR does not target the app's main branch. Absent means a run is under way - either
     * one this call started or one it attached to. No snapshot id: the run opens inside its workflow, so the trigger
     * never learns one.
     */
    skipped?: boolean;
    /** The skip cause, set on the deliberate no-op cases so a caller can tell them apart. */
    reason?: TriggerSkipReason;
}

export class NoApplicationLinkedError extends NotFoundError {
    constructor(public readonly repoId: number) {
        super(`No application linked to repository ${repoId}`);
    }
}

export class NoMainBranchError extends NotFoundError {
    constructor(public readonly appId: string) {
        super(`Application ${appId} has no main branch`);
    }
}

export class UnsupportedGitHubRefError extends BadRequestError {
    constructor(public readonly githubRef: string) {
        super(`Unsupported GitHub reference: ${githubRef}`);
    }
}

export class NoActiveSnapshotHeadShaError extends InternalError {
    constructor(public readonly branchId: string) {
        super(`Branch ${branchId} has no active snapshot with a headSha`);
    }
}

export class DiffsTriggerService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: GitHubInstallationService,
        private readonly billingService: Pick<BillingService, "checkAnalysisCreditsGate">,
        /** Injected so a test can observe what a trigger asked for without standing up Temporal. */
        private readonly startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<unknown>,
        private readonly events: AnalysisEventStore,
    ) {
        super();
    }

    /**
     * The out-of-credits refusal: comment on the PR (the shared, dedup'd notice, also used by the previewkit-deploy
     * gate) then throw. An already-running run is never cancelled by this, only new starts. Resolving the repo and
     * commenting are best-effort: a GitHub failure must still surface as the credits error, never a GitHub error.
     * Main-branch diffs have no PR to comment on or gate against, so this is only reached from `triggerPrDiffs`. The
     * event is already persisted by the time this runs, so it is deferred rather than lost - the branch's next push
     * or an explicit request opens a run that claims it.
     */
    private async refuseOutOfCredits(
        organizationId: string,
        repoId: number,
        prNumber: number,
        headSha: string,
        branchId: string,
    ): Promise<never> {
        this.logger.info("Blocking PR analysis: organization is out of credits", { organizationId, repoId, prNumber });

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
                repoId,
                prNumber,
                error: String(error),
            });
        }

        throw new InsufficientAnalysisCreditsError();
    }

    async triggerDiffs(params: TriggerDiffsParams): Promise<TriggerDiffsResult> {
        const mainBranchInfo = await this.db.mainBranchInfo.findFirst({
            where: {
                application: {
                    organizationId: params.organizationId,
                    githubRepositoryId: params.repoId,
                },
            },
            select: { githubRef: true },
        });

        if (mainBranchInfo?.githubRef === params.githubRef) {
            return this.triggerMainDiffs(params);
        }
        if (params.prNumber != null) {
            return this.triggerPrDiffs({ ...params, prNumber: params.prNumber });
        }
        throw new UnsupportedGitHubRefError(params.githubRef);
    }

    async triggerPrDiffs({
        organizationId,
        repoId,
        prNumber,
        url,
        webhookUrl,
        webhookHeaders,
        requested,
        source,
    }: TriggerPrDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering PR diffs analysis", { organizationId, repoId, prNumber, extra: { requested } });

        const app = await this.db.application.findFirst({
            where: {
                organizationId,
                githubRepositoryId: repoId,
            },
            select: { id: true, mainBranchInfo: { select: { githubRef: true } } },
        });

        if (app == null) throw new NoApplicationLinkedError(repoId);

        // Before the branch is created, not after: the Branch row is what puts a pull request on the customer's
        // Home screen, so an application still being set up must not leave one behind for a pull request nobody
        // reviewed. An explicit request (`/start analysis`) still runs - the same bypass the activation gate uses.
        if (!requested && !(await this.isLive(app.id))) {
            this.logger.info("Skipping PR diffs: the application has not gone live yet", {
                organizationId,
                repoId,
                prNumber,
            });
            return { skipped: true };
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
            this.logger.info("Skipping PR diffs: the PR does not target the app's main branch", {
                organizationId,
                extra: { repoId, prNumber, baseRef: pullRequest.baseRef, trunkRef },
            });
            return { skipped: true, reason: "base_not_trunk" };
        }

        const normalizedBranch = pullRequest.headRef;
        const headSha = pullRequest.headSha;

        const branch = await upsertPrBranch({
            db: this.db,
            applicationId: app.id,
            organizationId,
            prNumber,
            name: normalizedBranch,
        });
        const baseSha = pullRequest.baseSha;

        this.logger.info("Resolved branch and shas", { branchId: branch.id, headSha, baseSha });

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
                prNumber,
                headSha,
            });
            return { branchId: branch.id, skipped: true, reason: "already_analyzed" };
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
                return { branchId: branch.id };
            }
        }

        // A real analyzable event from here on: persist it whether or not we can act on it now, so a deferred push
        // is never lost. Only the poke (starting the run) is gated.
        const launch = { branchId: branch.id, organizationId, source, headSha, baseSha };

        // Ahead of the gate: a customer-hosted deployment is recorded even when its analysis is deferred.
        await this.recordDeploymentIfKnown({
            branchId: branch.id,
            organizationId,
            headSha,
            url,
            webhookUrl,
            webhookHeaders,
        });

        const decision = await analysisPokeGate(
            { db: this.db, billingService: this.billingService },
            { organizationId, requested: requested === true, autoRunOnReady: isAutoRunOnReady },
        );

        if (!decision.poke) {
            await enqueueAnalysisEvent(this.events, launch);
            // `refuseOutOfCredits` throws, so the activation log below is genuinely activation-only - the explicit
            // return makes that legible without the reader having to know the method returns `never`.
            if (decision.reason === "out_of_credits") {
                return await this.refuseOutOfCredits(organizationId, repoId, prNumber, headSha, branch.id);
            }
            this.logger.info("Activation: suppressing the automatic run; a run starts only on an explicit request", {
                branchId: branch.id,
                extra: { organizationId, headSha },
            });
            return { branchId: branch.id, skipped: true };
        }

        // The poke cleared the credits gate, so a stale "insufficient credits" block must not linger on the branch.
        await clearBranchTriggerBlock(this.db, branch.id);
        await this.startRun({ branchId: branch.id, organizationId, source, headSha, baseSha });

        this.logger.info("PR diffs analysis triggered successfully", {
            branchId: branch.id,
            headSha,
            baseSha,
        });

        return { branchId: branch.id };
    }

    async triggerMainDiffs({
        organizationId,
        repoId,
        url,
        webhookUrl,
        webhookHeaders,
        source,
    }: TriggerMainDiffsParams): Promise<TriggerDiffsResult> {
        this.logger.info("Triggering main branch diffs analysis", { organizationId, repoId });

        const app = await this.db.application.findUnique({
            where: {
                organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repoId },
            },
            select: {
                id: true,
                mainBranch: { select: { id: true } },
                mainBranchInfo: { select: { githubRef: true } },
            },
        });

        if (app == null) throw new NoApplicationLinkedError(repoId);

        if (app.mainBranch == null || app.mainBranchInfo == null) throw new NoMainBranchError(app.id);

        const branchId = app.mainBranch.id;

        // The baseline snapshot is established at go-live, so a not-live main push has no base to diff against yet.
        if (!(await this.isLive(app.id))) {
            this.logger.info("Skipping main diffs: the application has not gone live yet", { organizationId, repoId });
            return { branchId, skipped: true };
        }

        const headSha = await this.githubInstallationService.getBranchHead(
            organizationId,
            repoId,
            app.mainBranchInfo.githubRef,
        );

        // Main has no pull request to fall back on, so its baseline snapshot is the only possible base.
        const gate = await new AnalysisRunGate(this.db).shouldSkipAlreadyAnalyzed({ branchId, headSha });
        const baseSha = gate.resolved.baseSha;
        if (baseSha == null) throw new NoActiveSnapshotHeadShaError(branchId);

        this.logger.info("Resolved main branch and shas", { branchId, headSha, baseSha });

        // A re-delivered webhook for unchanged main carries the active snapshot's head; a pending event
        // un-suppresses the skip. A real commit moves headSha, so this only collapses true duplicates.
        if (gate.skip) {
            this.logger.info("Skipping main diffs: head matches active snapshot and the inbox is empty", {
                branchId,
                headSha,
            });
            return { branchId, skipped: true };
        }

        await this.recordDeploymentIfKnown({ branchId, organizationId, headSha, url, webhookUrl, webhookHeaders });

        // Deliberately not activation-gated: activation only suppresses automatic PR analysis. A migrated org's
        // baseline snapshot must keep updating on main pushes, or every later PR diff computes against a stale base.
        await this.startRun({ branchId, organizationId, source, headSha });

        this.logger.info("Main branch diffs analysis triggered successfully", { branchId, headSha, baseSha });

        return { branchId };
    }

    private async startRun(params: {
        branchId: string;
        organizationId: string;
        source: AnalysisEventSource;
        headSha: string;
        /** The PR base, for a branch with no active snapshot yet. Main always has one, so it passes none. */
        baseSha?: string;
    }): Promise<void> {
        const { branchId, organizationId, source, headSha, baseSha } = params;
        await enqueueAndStartAnalysisRun(
            { events: this.events, startAnalysisRun: this.startAnalysisRun },
            { branchId, organizationId, source, headSha, baseSha },
        );
    }

    /**
     * Record the deployment the trigger carries, when it carries one. A customer-hosted push arrives WITH its live
     * URL; a previewkit push has none until its build goes live (the run records that one itself). Called BEFORE the
     * poke gate, so a push deferred out of credits or by activation still lands the coordinate the branch's next run
     * resolves its head from - the recording is not analysis, so it is not gated by the run.
     */
    private async recordDeploymentIfKnown(params: {
        branchId: string;
        organizationId: string;
        headSha: string;
        url?: string;
        webhookUrl?: string;
        webhookHeaders?: Record<string, string>;
    }): Promise<void> {
        if (params.url == null) return;
        await recordBranchDeployment({
            db: this.db,
            branchId: params.branchId,
            organizationId: params.organizationId,
            headSha: params.headSha,
            url: params.url,
            webhookUrl: params.webhookUrl,
            webhookHeaders: params.webhookHeaders,
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
