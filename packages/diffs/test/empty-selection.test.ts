import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import { describe, expect, it } from "vitest";
import { skipSelectionForEmptySubject } from "../src/agents/diffs/empty-selection";
import type { RunSubject } from "../src/run-subject";

const EMPTY_SUBJECT: RunSubject = {
    commits: [],
    files: [],
    ledger: { inheritedCount: 4, replayedCount: 1, cleanMergeCount: 0 },
};

const OWNED_SUBJECT: RunSubject = {
    commits: [{ sha: "a".repeat(40), subject: "feat: real work", files: ["src/app.ts"] }],
    files: ["src/app.ts"],
    ledger: { inheritedCount: 0, replayedCount: 0, cleanMergeCount: 0 },
};

function pushEvent(): ResolvedAnalysisEvent {
    return {
        type: "commits_pushed",
        payload: { headSha: "b".repeat(40) },
        source: "webhook",
        createdAt: new Date("2026-01-01T00:00:00Z"),
    };
}

function promptEvent(): ResolvedAnalysisEvent {
    return {
        type: "user_prompt",
        payload: { text: "re-check the checkout flow", author: "someone" },
        source: "mcp",
        createdAt: new Date("2026-01-01T00:00:00Z"),
    };
}

describe("skipSelectionForEmptySubject", () => {
    it("answers a pushes-only empty subject deterministically", () => {
        const skipped = skipSelectionForEmptySubject(EMPTY_SUBJECT, [pushEvent()]);

        expect(skipped).toBeDefined();
        expect(skipped!.affectedTests).toEqual([]);
        expect(skipped!.createdTests).toEqual([]);
        expect(skipped!.reasoning.length).toBeGreaterThan(0);
    });

    it("answers an event-less empty subject deterministically", () => {
        expect(skipSelectionForEmptySubject(EMPTY_SUBJECT, [])).toBeDefined();
    });

    it("runs the agent when any non-push event was claimed", () => {
        expect(skipSelectionForEmptySubject(EMPTY_SUBJECT, [pushEvent(), promptEvent()])).toBeUndefined();
    });

    it("runs the agent when the subject holds owned commits", () => {
        expect(skipSelectionForEmptySubject(OWNED_SUBJECT, [pushEvent()])).toBeUndefined();
    });

    it("runs the agent when no subject was scoped", () => {
        expect(skipSelectionForEmptySubject(undefined, [pushEvent()])).toBeUndefined();
    });
});
