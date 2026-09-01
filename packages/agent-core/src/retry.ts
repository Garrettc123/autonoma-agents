/**
 * Adapted from https://github.com/vercel/ai/blob/main/packages/ai/src/util/retry-with-exponential-backoff.ts
 */
import { APICallError } from "ai";
import { getDefaultLogger } from "./logger";

export interface RetryConfig {
    maxRetries: number;
    initialDelayInMs: number;
    backoffFactor: number;
    /** Cap on the delay between retries. Defaults to 10 seconds. */
    maxDelayInMs?: number;
    /** Which failures are worth another attempt. An abort is never retried, whatever this returns. */
    shouldRetry?: (error: unknown) => boolean;
}

/**
 * Default retry policy for model calls. Deliberately generous - transient provider hiccups
 * (rate limits, 5xx, dropped connections) are common enough that a single-digit retry count
 * surfaces as spurious hard failures. The exponential backoff is capped by `maxDelayInMs` so
 * the total wait before giving up stays bounded (~3 minutes of pure backoff at these values)
 * instead of ballooning to the tens of minutes an uncapped 2^n curve would reach by retry 10.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxRetries: 10,
    initialDelayInMs: 1000,
    backoffFactor: 2,
    maxDelayInMs: 30_000,
};

/**
 * Calculate retry delay based on retry headers and exponential backoff
 */
function getRetryDelayInMs(error: APICallError, exponentialBackoffDelay: number): number {
    const headers = error.responseHeaders;

    if (!headers) return exponentialBackoffDelay;

    let ms: number | undefined;

    // retry-ms is more precise than retry-after and used by e.g. OpenAI
    const retryAfterMs = headers["retry-after-ms"];
    if (retryAfterMs) {
        const timeoutMs = Number.parseFloat(retryAfterMs);
        if (!Number.isNaN(timeoutMs)) {
            ms = timeoutMs;
        }
    }

    // About the Retry-After header: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Retry-After
    const retryAfter = headers["retry-after"];
    if (retryAfter && ms === undefined) {
        const timeoutSeconds = Number.parseFloat(retryAfter);
        if (!Number.isNaN(timeoutSeconds)) ms = timeoutSeconds * 1000;
        else ms = Date.parse(retryAfter) - Date.now();
    }

    // check that the delay is reasonable:
    if (ms != null && !Number.isNaN(ms) && 0 <= ms && (ms < 60 * 1000 || ms < exponentialBackoffDelay)) {
        return ms;
    }

    return exponentialBackoffDelay;
}

/** Matched by name because an abort reaches us as whatever the aborter chose. */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "TimeoutError"]);

function isAbort(error: unknown): boolean {
    return error instanceof Error && ABORT_ERROR_NAMES.has(error.name);
}

/** Sleep, waking early if `abortSignal` fires. Resolves either way; the caller decides what an abort means. */
function abortableDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal == null) return new Promise((resolve) => setTimeout(resolve, ms));
    if (abortSignal.aborted) return Promise.resolve();

    return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish(): void {
            clearTimeout(timer);
            abortSignal?.removeEventListener("abort", finish);
            resolve();
        }
        abortSignal.addEventListener("abort", finish, { once: true });
    });
}

/**
 * Only retry errors that stand a chance of succeeding on a subsequent attempt. Provider errors
 * carry an explicit `isRetryable` signal (true for 408/409/429/5xx, false for 4xx like a bad
 * request or invalid API key) - honour it so we fail fast on permanent errors instead of
 * hammering them through the full backoff schedule. Non-`APICallError` failures (network drops,
 * timeouts, unknown errors) are treated as transient and retried - except an abort, which is a
 * decision to stop and is never retried.
 */
function shouldRetryByDefault(error: Error | unknown): boolean {
    if (APICallError.isInstance(error)) return error.isRetryable !== false;
    return true;
}

/** The AI SDK's own rule, for callers replacing its schedule but not its policy. */
export function shouldRetryProviderErrorsOnly(error: Error | unknown): boolean {
    return APICallError.isInstance(error) && error.isRetryable === true;
}

/**
 * Build a retry wrapper for a policy. The optional `abortSignal` matters during the WAIT: without it a deadline
 * expiring mid-backoff sleeps out the remaining delay before noticing.
 */
export function buildRetry({
    maxRetries = 5,
    initialDelayInMs = 100,
    backoffFactor = 2,
    maxDelayInMs = 10_000,
    shouldRetry: shouldRetryError = shouldRetryByDefault,
}: RetryConfig): <T>(operation: () => PromiseLike<T>, abortSignal?: AbortSignal) => Promise<T> {
    const shouldRetry = (error: unknown): boolean => !isAbort(error) && shouldRetryError(error);

    return async (operation, abortSignal) => {
        let delay = initialDelayInMs;

        for (let i = 0; i < maxRetries + 1; i++) {
            try {
                return await operation();
            } catch (error) {
                if (!shouldRetry(error)) throw error;

                // If we've retried the max number of times, throw the error
                if (i === maxRetries) throw error;

                let currentDelay = Math.min(delay, maxDelayInMs);

                // A `Retry-After` may only ever SHORTEN the wait. Unclamped it accepts up to a minute, which
                // outweighs the cap the caller sized its budget on.
                if (APICallError.isInstance(error)) {
                    currentDelay = Math.min(getRetryDelayInMs(error, currentDelay), maxDelayInMs);
                }

                getDefaultLogger().warn("AI request failed, retrying", {
                    attempt: i + 1,
                    maxRetries,
                    delayMs: currentDelay,
                    error: error instanceof Error ? error.message : String(error),
                });

                await abortableDelay(currentDelay, abortSignal);
                // The wait, not the attempt, is what an abort interrupts - so re-check rather than spending an
                // attempt to discover it.
                if (abortSignal?.aborted === true) throw error;

                // Increase delay for next retry (exponential backoff)
                delay *= backoffFactor;
            }
        }

        throw new Error("Unreachable code");
    };
}
