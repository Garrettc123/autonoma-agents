import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import { describe, expect, it } from "vitest";
import { buildDiffsUserPrompt, type DiffsPromptInput } from "../src/agents/diffs/diffs-prompt";
import { FlowIndex } from "../src/flow-index";

function baseInput(events: ResolvedAnalysisEvent[]): DiffsPromptInput {
    return {
        analysis: { affectedFiles: ["src/app.ts"], summary: "changed the app" },
        range: { baseSha: "aaaa111", headSha: "bbbb222" },
        events,
        flowIndex: new FlowIndex([]),
        merges: [],
        preClassifiedConflicts: [],
        scenarioRecipes: [],
    };
}

function directive(text: string, author = "conversation-agent"): ResolvedAnalysisEvent {
    return {
        type: "user_prompt",
        payload: { text, author },
        source: "mcp",
        createdAt: new Date("2026-01-01T00:00:00Z"),
    };
}

function push(headSha: string): ResolvedAnalysisEvent {
    return {
        type: "commits_pushed",
        payload: { headSha },
        source: "webhook",
        createdAt: new Date("2026-01-02T00:00:00Z"),
    };
}

describe("buildDiffsUserPrompt directives", () => {
    it("is byte-identical to an event-less run when there are no events", () => {
        expect(buildDiffsUserPrompt(baseInput([]))).toBe(buildDiffsUserPrompt(baseInput([])));
        expect(buildDiffsUserPrompt(baseInput([]))).not.toContain("Directives");
    });

    it("renders a user_prompt as a directive ranked ABOVE the diff", () => {
        const prompt = buildDiffsUserPrompt(baseInput([directive("Focus on the checkout flow.")]));

        expect(prompt).toContain("Directives - HIGHEST PRIORITY");
        expect(prompt).toContain("Focus on the checkout flow.");
        expect(prompt.indexOf("Directives - HIGHEST PRIORITY")).toBeLessThan(prompt.indexOf("## Changes Summary"));
    });

    it("frames a suite-edit ask as out of scope, not a selection hint", () => {
        const prompt = buildDiffsUserPrompt(baseInput([directive("Delete the flaky login test.")]));
        expect(prompt).toContain("OUT OF SCOPE");
    });

    it("keeps pushes in the movement section below the diff, separate from directives", () => {
        const prompt = buildDiffsUserPrompt(baseInput([directive("Cover billing."), push("cccc333")]));

        expect(prompt).toContain("## Triggering events");
        expect(prompt.indexOf("## Triggering events")).toBeGreaterThan(prompt.indexOf("## Changes Summary"));
        expect(prompt).not.toContain("commits pushed: head `cccc333`\n- 2026-01-01");
        expect(prompt.indexOf("Directives - HIGHEST PRIORITY")).toBeLessThan(prompt.indexOf("## Triggering events"));
    });
});
