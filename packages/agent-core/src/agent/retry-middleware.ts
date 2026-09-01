import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { LanguageModel } from "../model";
import { buildRetry, DEFAULT_RETRY_CONFIG, type RetryConfig, shouldRetryProviderErrorsOnly } from "../retry";

export const MODEL_RETRY_CONFIG: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    shouldRetry: shouldRetryProviderErrorsOnly,
};

/**
 * Retry one model call under a capped backoff: the SDK's own retry exposes only `maxRetries`, and its uncapped
 * schedule outlasts the activity budgets these agents run under. Pair with `maxRetries: 0`, or the layers multiply.
 */
export function retryMiddleware(config: RetryConfig): LanguageModelMiddleware {
    return {
        specificationVersion: "v4",
        wrapGenerate: async ({ doGenerate, params }) => buildRetry(config)(doGenerate, params.abortSignal),
    };
}

/** Wrapping the model rather than the generation re-issues one failed call without replaying its tool calls. */
export function withModelRetry(model: LanguageModel): LanguageModel {
    return wrapLanguageModel({ model, middleware: [retryMiddleware(MODEL_RETRY_CONFIG)] });
}
