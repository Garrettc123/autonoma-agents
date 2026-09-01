import { APICallError, generateText, wrapLanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { MODEL_RETRY_CONFIG, retryMiddleware } from "../src/agent/retry-middleware";
import { noopLogger, setDefaultLogger } from "../src/logger";
import { buildRetry } from "../src/retry";

setDefaultLogger(noopLogger);

const NO_WAIT = { maxRetries: 3, initialDelayInMs: 0, backoffFactor: 1, maxDelayInMs: 0 };
const FAKE_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

function retryable(): APICallError {
    return new APICallError({ message: "429 rate limited", url: "u", requestBodyValues: {}, isRetryable: true });
}

function failsUntil(succeedOn: number, calls: { n: number }): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => {
            calls.n += 1;
            if (calls.n < succeedOn) throw retryable();
            return {
                content: [{ type: "text", text: "ok" }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: FAKE_USAGE,
                warnings: [],
            };
        },
    });
}

/** The real policy on a no-wait schedule, so the tests exercise what ships without sleeping through it. */
function withRetry(model: MockLanguageModelV3) {
    return wrapLanguageModel({
        model,
        middleware: [retryMiddleware({ ...NO_WAIT, shouldRetry: MODEL_RETRY_CONFIG.shouldRetry })],
    });
}

describe("retryMiddleware", () => {
    it("rides out a rate limit and returns the answer once it lands", async () => {
        const calls = { n: 0 };

        const { text } = await generateText({ model: withRetry(failsUntil(3, calls)), prompt: "go", maxRetries: 0 });

        expect(text).toBe("ok");
        expect(calls.n).toBe(3);
    });

    it("gives up after the policy's attempts rather than retrying forever", async () => {
        const calls = { n: 0 };
        const model = withRetry(failsUntil(Number.MAX_SAFE_INTEGER, calls));

        await expect(generateText({ model, prompt: "go", maxRetries: 0 })).rejects.toThrow();
        expect(calls.n).toBe(NO_WAIT.maxRetries + 1);
    });

    it("reports a bug in our own code instead of repeating it", async () => {
        let attempts = 0;
        const model = withRetry(
            new MockLanguageModelV3({
                doGenerate: async () => {
                    attempts += 1;
                    throw new TypeError("cannot read properties of undefined");
                },
            }),
        );

        await expect(generateText({ model, prompt: "go", maxRetries: 0 })).rejects.toThrow(/cannot read properties/);
        expect(attempts).toBe(1);
    });
});

describe("MODEL_RETRY_CONFIG", () => {
    it("keeps the SDK's policy: provider errors are retried, our own bugs are not", () => {
        const decide = MODEL_RETRY_CONFIG.shouldRetry;

        expect(decide?.(retryable())).toBe(true);
        expect(decide?.(new TypeError("boom"))).toBe(false);
    });

    it("caps the backoff, so the schedule fits a caller's budget instead of one wait dwarfing it", () => {
        expect(MODEL_RETRY_CONFIG.maxDelayInMs).toBe(30_000);
    });
});

describe("buildRetry and aborts", () => {
    it("does not retry an abort - it is a decision to stop, not a failure to ride out", async () => {
        let attempts = 0;
        const abort = Object.assign(new Error("aborted"), { name: "AbortError" });

        await expect(
            buildRetry(NO_WAIT)(async () => {
                attempts += 1;
                throw abort;
            }),
        ).rejects.toThrow("aborted");

        expect(attempts).toBe(1);
    });

    it("stops waiting out its backoff the moment the caller's deadline expires", async () => {
        const controller = new AbortController();
        const slow = { maxRetries: 5, initialDelayInMs: 30_000, backoffFactor: 2, maxDelayInMs: 30_000 };
        let attempts = 0;

        const startedAt = Date.now();
        const run = buildRetry(slow)(async () => {
            attempts += 1;
            if (attempts === 1) setTimeout(() => controller.abort(), 20);
            throw retryable();
        }, controller.signal);

        await expect(run).rejects.toThrow();
        // Without an abortable wait this would sit out the full 30s delay before noticing.
        expect(Date.now() - startedAt).toBeLessThan(5_000);
        expect(attempts).toBe(1);
    });
});
