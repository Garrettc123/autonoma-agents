import { ApplicationFailure } from "@temporalio/workflow";
import { CREDITS_EXHAUSTED_FAILURE_TYPE } from "./credits-exhausted-failure";

/**
 * True when a thrown activity error is (or wraps, via Temporal's `.cause` chain) the
 * `ApplicationFailure` an activity rethrows for a zero-tolerance org's mid-run credit exhaustion.
 * Walks the same shallowest-`ApplicationFailure` chain `rootFailureMessage` does, since that is the
 * one the activity author actually threw - a deeper `ApplicationFailure` would be a different,
 * wrapped low-level cause.
 */
export function isCreditsExhaustedFailure(error: unknown): boolean {
    let current: Error | undefined = error instanceof Error ? error : undefined;

    while (current != null) {
        if (current instanceof ApplicationFailure) return current.type === CREDITS_EXHAUSTED_FAILURE_TYPE;
        const cause: unknown = current.cause;
        current = cause instanceof Error ? cause : undefined;
    }

    return false;
}
