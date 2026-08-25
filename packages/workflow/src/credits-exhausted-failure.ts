/**
 * The `ApplicationFailure` type string a zero-tolerance org's mid-run credit exhaustion is thrown as
 * (see `packages/billing`'s `CreditsExhaustedError` and the activities that rethrow it in
 * `apps/workers/diffs`). Shared as a constant, not a hand-copied literal, so the producer (the
 * activity's rethrow) and the consumer (`withAnalysisRunSettlement`'s detection) can never drift out
 * of sync with each other.
 */
export const CREDITS_EXHAUSTED_FAILURE_TYPE = "CreditsExhausted";
