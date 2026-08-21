export {
    type CheckoutHandle,
    type CodebaseCoords,
    codebaseCoordsSchema,
    ensureCachedCheckout,
    ensureFetchable,
    type EnsureCachedCheckoutOptions,
    UnfetchableShaError,
} from "./codebase-cache";
export { casesDir } from "./cases-dir";
export { type EvidenceKeys, MissingEvidenceError, probeEvidence } from "./evidence-probe";
export { DiffsJudge } from "./judge";
export { type RunOutcome, type ScoredReplayConfig, ScoredReplayEvaluation } from "./scored-replay-evaluation";
export { type CaseSkipContext, rehydrateOrSkip, skipIfEvidenceUnreachable } from "./skip";
