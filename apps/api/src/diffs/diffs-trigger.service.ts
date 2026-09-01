import type { AnalysisEventStore } from "@autonoma/analysis";
import type { BillingService } from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { BadRequestError, InsufficientAnalysisCreditsError, InternalError, NotFoundError } from "@autonoma/errors";
import type { AnalysisEventSource } from "@autonoma/types";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";
import { AnalysisTrigger } from "../analysis/trigger/analysis-trigger";
import type { OccurrenceDeployment } from "../analysis/trigger/occurrence";
import type { DeliveryReceipt } from "../analysis/trigger/receipt";
import type { GitHubInstallationService } from "../github/github-installation.service";
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

export interface TriggerPrDiffsParams extends BaseTriggerDiffsParams {
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

/**
 * The GitHub diffs producer, now a thin adapter over {@link AnalysisTrigger}: it translates a webhook/CI/onboarding
 * signal into an {@link AnalysisOccurrence}, delivers it, and maps the {@link DeliveryReceipt} back to the
 * {@link TriggerDiffsResult}/throws this surface has always returned. Every gate and side effect lives in the module.
 */
export class DiffsTriggerService extends Service {
    private readonly trigger: AnalysisTrigger;

    constructor(
        db: PrismaClient,
        githubInstallationService: GitHubInstallationService,
        billingService: Pick<BillingService, "checkAnalysisCreditsGate">,
        /** Injected so a test can observe what a trigger asked for without standing up Temporal. */
        startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<unknown>,
        events: AnalysisEventStore,
    ) {
        super();
        this.trigger = new AnalysisTrigger(
            db,
            githubInstallationService,
            billingService,
            async (input) => {
                await startAnalysisRun(input);
                return undefined;
            },
            events,
        );
    }

    async triggerDiffs(params: TriggerDiffsParams): Promise<TriggerDiffsResult> {
        const receipt = await this.trigger.deliver({
            organizationId: params.organizationId,
            locator: { kind: "ref", repoId: params.repoId, githubRef: params.githubRef, prNumber: params.prNumber },
            kind: "push",
            source: params.source,
            requested: false,
            deployment: deploymentFrom(params),
        });
        return this.toResult(receipt, { repoId: params.repoId, githubRef: params.githubRef });
    }

    async triggerPrDiffs(params: TriggerPrDiffsParams): Promise<TriggerDiffsResult> {
        const requested = params.requested === true;
        const receipt = await this.trigger.deliver({
            organizationId: params.organizationId,
            locator: { kind: "pr", repoId: params.repoId, prNumber: params.prNumber },
            kind: requested ? "explicit_request" : "push",
            source: params.source,
            requested,
            deployment: deploymentFrom(params),
        });
        return this.toResult(receipt, { repoId: params.repoId });
    }

    async triggerMainDiffs(params: TriggerMainDiffsParams): Promise<TriggerDiffsResult> {
        const receipt = await this.trigger.deliver({
            organizationId: params.organizationId,
            locator: { kind: "main", repoId: params.repoId },
            kind: "push",
            source: params.source,
            requested: false,
            deployment: deploymentFrom(params),
        });
        return this.toResult(receipt, { repoId: params.repoId });
    }

    /** Map a receipt back to this surface's historical result/throw contract - one exhaustive switch. */
    private toResult(receipt: DeliveryReceipt, ctx: { repoId: number; githubRef?: string }): TriggerDiffsResult {
        switch (receipt.status) {
            case "started":
                return { branchId: receipt.branchId };
            case "attached":
                return { branchId: receipt.branchId };
            case "skipped":
                switch (receipt.reason) {
                    case "already_analyzed":
                        return { branchId: receipt.branchId, skipped: true, reason: "already_analyzed" };
                    case "not_gone_live":
                        // A PR refuses before a branch exists (branchId undefined); a main push carries its branch.
                        return { branchId: receipt.branchId, skipped: true };
                    case "draft_pr":
                        return { skipped: true };
                }
            case "deferred":
                switch (receipt.reason) {
                    case "activation_gated":
                        return { branchId: receipt.branchId, skipped: true };
                    case "out_of_credits_analysis":
                        throw new InsufficientAnalysisCreditsError();
                    case "out_of_credits_preview_deploy":
                        // The diffs producer never reaches the preview-deploy gate.
                        throw new InternalError("Unexpected preview-deploy refusal from a diffs trigger");
                }
            case "refused":
                switch (receipt.reason) {
                    case "no_application_linked":
                        throw new NoApplicationLinkedError(ctx.repoId);
                    case "no_main_branch":
                        throw new NoMainBranchError(receipt.applicationId);
                    case "unsupported_ref":
                        throw new UnsupportedGitHubRefError(ctx.githubRef ?? "");
                    case "no_analysis_base":
                        throw new NoActiveSnapshotHeadShaError(receipt.branchId);
                    case "base_not_trunk":
                        return { skipped: true, reason: "base_not_trunk" };
                    case "branch_unresolvable":
                        // The diffs producer resolves its branch inline (throwing on failure), never never-throw.
                        throw new InternalError("Unexpected unresolvable branch from a diffs trigger");
                }
        }
    }
}

/** A customer-hosted preview coordinate, present only when the caller knew the URL. */
function deploymentFrom(params: BaseTriggerDiffsParams): OccurrenceDeployment | undefined {
    if (params.url == null) return undefined;
    return { url: params.url, webhookUrl: params.webhookUrl, webhookHeaders: params.webhookHeaders };
}
