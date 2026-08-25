import { CreditsExhaustedError } from "@autonoma/billing";
import { CREDITS_EXHAUSTED_FAILURE_TYPE } from "@autonoma/workflow";
import { ApplicationFailure } from "@temporalio/activity";

/**
 * The one exception to `persistAiCosts`'s best-effort contract: every activity that calls it wraps
 * the call in a blanket `.catch` (a billing side-effect must never fail a whole analysis run), but a
 * zero-tolerance org running out of credits mid-run is deliberately NOT swallowed here - it's
 * rethrown as an `ApplicationFailure` so `withAnalysisRunSettlement` can detect it and settle the
 * run with a distinct "insufficient credits" reason instead of finishing normally. Every other
 * error from `persistAiCosts` (DB hiccups, pricing lookups) still falls through to the caller's own
 * `logger.warn` and the run proceeds.
 */
export function rethrowIfCreditsExhausted(error: unknown): void {
    if (error instanceof CreditsExhaustedError) {
        throw ApplicationFailure.nonRetryable(error.message, CREDITS_EXHAUSTED_FAILURE_TYPE);
    }
}
