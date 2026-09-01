/**
 * What {@link AnalysisTrigger.deliver} decided. Every producer switches on `status` exhaustively, so a new outcome
 * fails compilation at every call site rather than being silently dropped. The four "did not run" families read the
 * same everywhere: `deferred` persisted the event and will run later (a top-up or an explicit request claims it),
 * `skipped` was a deliberate no-op with nothing left pending, and `refused` could not name a run to open at all.
 */
export type DeliveryReceipt =
    /** A run was started for this head. `workflowId` is absent for producers whose starter does not return one. */
    | { status: "started"; branchId: string; workflowId?: string }
    /** An in-flight run for the same head absorbed this delivery; no duplicate was started. */
    | { status: "attached"; branchId: string }
    /** The event was persisted but no run was poked - it waits for the named unblocking to claim it. */
    | { status: "deferred"; reason: DeferredReason; branchId?: string }
    /** A deliberate no-op: nothing to analyze and nothing left pending. */
    | { status: "skipped"; reason: SkippedReason; branchId?: string }
    /** No run could be named. `no_main_branch` and `no_analysis_base` carry the id their message needs. */
    | { status: "refused"; reason: "no_application_linked" }
    | { status: "refused"; reason: "no_main_branch"; applicationId: string }
    | { status: "refused"; reason: "unsupported_ref" }
    | { status: "refused"; reason: "no_analysis_base"; branchId: string }
    | { status: "refused"; reason: "base_not_trunk" }
    | { status: "refused"; reason: "branch_unresolvable" };

export type DeferredReason = "activation_gated" | "out_of_credits_analysis" | "out_of_credits_preview_deploy";

export type SkippedReason = "already_analyzed" | "not_gone_live" | "draft_pr";
