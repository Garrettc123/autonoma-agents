import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AgentBudgetExceeded, AgentLoop } from "../src/agent/agent-loop";
import { FinishTool } from "../src/agent/tools/agent-result";
import { noopLogger, setDefaultLogger } from "../src/logger";

setDefaultLogger(noopLogger);

const FAKE_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

function loop(model: MockLanguageModelV3, budget: { totalMs: number; stepMs: number }) {
    return new AgentLoop<{ payload: string }>({
        name: "budgeted",
        model,
        systemPrompt: "system",
        tools: [],
        reportTool: new FinishTool({ resultSchema: z.object({ payload: z.string() }) }),
        budget,
    });
}

/** A model that never answers until aborted - the shape of a provider that accepted the call and went quiet. */
function hangingModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: ({ abortSignal }) =>
            new Promise((_resolve, reject) => {
                abortSignal?.addEventListener("abort", () => reject(abortSignal.reason));
            }),
    });
}

function reportsResult(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [
                { type: "tool-call", toolCallId: "f1", toolName: "finish", input: JSON.stringify({ payload: "ok" }) },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: FAKE_USAGE,
            warnings: [],
        }),
    });
}

describe("agent budget", () => {
    it("stops a hung model call, naming the agent and how long it waited", async () => {
        const error = await loop(hangingModel(), { totalMs: 400, stepMs: 200 })
            .runLoop([{ role: "user", content: "go" }])
            .catch((e: unknown) => e);

        if (!(error instanceof AgentBudgetExceeded)) throw error;
        expect(error.message).toContain("budgeted");
        expect(error.elapsedMs).toBeGreaterThan(0);
    });

    it("does not interfere with a run that finishes inside its budget", async () => {
        const { result } = await loop(reportsResult(), { totalMs: 60_000, stepMs: 30_000 }).runLoop([
            { role: "user", content: "go" },
        ]);

        expect(result).toEqual({ payload: "ok" });
    });
});
