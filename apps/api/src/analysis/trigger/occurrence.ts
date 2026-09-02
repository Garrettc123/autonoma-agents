import type { AnalysisEventSource } from "@autonoma/types";

/**
 * A single thing that happened and might warrant an analysis run - a push, an explicit request, a deploy signal,
 * or a user prompt. It names WHAT the event points at (the {@link AnalysisLocator}) and describes the event without
 * deciding anything: every gate and every consequence is {@link AnalysisTrigger}'s.
 */
export interface AnalysisOccurrence {
    organizationId: string;
    locator: AnalysisLocator;
    /** The shape of the event. Distinct from {@link requested}, which is the policy bit. */
    kind: AnalysisOccurrenceKind;
    /** Which producer path this came through - stamped on the analysis event when a run opens. */
    source: AnalysisEventSource;
    /**
     * A policy bit, not a fact about the event: an explicit human/agent request bypasses the gone-live and
     * activation gates. It never bypasses the base-not-trunk gate or the credit floor.
     */
    requested: boolean;
    /** A deployment coordinate the caller already knows (a customer-hosted preview URL). Recorded before any gate. */
    deployment?: OccurrenceDeployment;
    /** The head/base the caller resolved, when it holds them. Absent means the module resolves them from GitHub. */
    head?: OccurrenceHead;
}

/** What an occurrence points at. `ref` is the raw webhook form the module resolves to `main` or `pr`. */
export type AnalysisLocator =
    | { kind: "pr"; repoId: number; prNumber: number }
    | { kind: "main"; repoId: number }
    | { kind: "ref"; repoId: number; githubRef: string; prNumber?: number };

export type AnalysisOccurrenceKind = "push" | "message" | "explicit_request" | "deploy_signal";

/** A deployment the caller already knows the URL of - a customer-hosted preview. */
export interface OccurrenceDeployment {
    url: string;
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
}

/** A head the caller resolved itself, rather than leaving the module to read it from GitHub. */
export interface OccurrenceHead {
    headSha: string;
    /** The commit a run diffs against, for a branch with no active snapshot yet. */
    baseSha?: string;
}
