import type { AnalysisEventStore } from "@autonoma/analysis";
import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { type AnalysisEventSource, hasGoneLive } from "@autonoma/types";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";
import { NoApplicationLinkedError } from "../diffs/diffs-trigger.service";
import type { GitHubInstallationService } from "../github/github-installation.service";
import { upsertPrBranch } from "../routes/branches/upsert-pr-branch";
import { Service } from "../routes/service";
import { type AnalysisPokeDeferralReason, analysisPokeGate } from "./analysis-poke-gate";

export interface DeliverUserPromptInput {
    organizationId: string;
    repoId: number;
    prNumber: number;
    text: string;
    author: string;
    source: AnalysisEventSource;
}

export type DeliverUserPromptRefusal = "not_onboarded" | "pr_closed" | "pr_merged";

export type DeliverUserPromptDeferralReason = AnalysisPokeDeferralReason;

export type DeliverUserPromptReceipt =
    | { status: "started"; branchId: string; eventId: string }
    | { status: "deferred"; branchId: string; eventId: string; reason: DeliverUserPromptDeferralReason }
    | { status: "refused"; reason: DeliverUserPromptRefusal };

/** Delivers a `user_prompt` event to a branch's analysis run, over a transport-agnostic seam. */
export class DeliverUserPromptService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly githubInstallationService: GitHubInstallationService,
        private readonly billingService: Pick<BillingService, "checkAnalysisCreditsGate">,
        private readonly signalWithStartAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<unknown>,
        private readonly events: AnalysisEventStore,
    ) {
        super();
    }

    public async deliverUserPrompt(input: DeliverUserPromptInput): Promise<DeliverUserPromptReceipt> {
        const { organizationId, repoId, prNumber, source } = input;
        this.logger.info("Delivering user prompt to analysis run", {
            organizationId,
            extra: { repoId, prNumber, source, author: input.author },
        });

        const app = await this.db.application.findFirst({
            where: { organizationId, githubRepositoryId: repoId },
            select: { id: true },
        });
        if (app == null) throw new NoApplicationLinkedError(repoId);

        // Refuse a dead PR or un-onboarded app before creating any branch row, so a message that can never be
        // claimed leaves nothing behind.
        const pullRequest = await this.githubInstallationService.getPullRequest(organizationId, repoId, prNumber);
        if (pullRequest.state === "merged") return { status: "refused", reason: "pr_merged" };
        if (pullRequest.state === "closed") return { status: "refused", reason: "pr_closed" };
        if (!(await this.isLive(app.id))) return { status: "refused", reason: "not_onboarded" };

        const branch = await upsertPrBranch({
            db: this.db,
            applicationId: app.id,
            organizationId,
            prNumber,
            name: pullRequest.headRef,
        });
        const headSha = pullRequest.headSha;
        const baseSha = pullRequest.baseSha;

        // Persist before the gate check, so a message the gate defers is never lost.
        const { id: eventId } = await this.events.enqueue({
            branchId: branch.id,
            organizationId,
            source,
            event: { type: "user_prompt", payload: { text: input.text, author: input.author } },
        });

        // A message pokes a job: `requested` bypasses activation but still respects the credit floor.
        const decision = await analysisPokeGate(
            { db: this.db, billingService: this.billingService },
            { organizationId, requested: true, autoRunOnReady: false },
        );
        if (!decision.poke) {
            this.logger.info("User prompt deferred; event persisted for the branch's next run", {
                branchId: branch.id,
                extra: { eventId, organizationId, reason: decision.reason },
            });
            return { status: "deferred", branchId: branch.id, eventId, reason: decision.reason };
        }

        await this.signalWithStartAnalysisRun({ branchId: branch.id, headSha, baseSha });
        this.logger.info("User prompt delivered; run signalled or started", {
            branchId: branch.id,
            extra: { eventId, headSha },
        });
        return { status: "started", branchId: branch.id, eventId };
    }

    private async isLive(applicationId: string): Promise<boolean> {
        const state = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { step: true },
        });
        return hasGoneLive(state?.step);
    }
}
