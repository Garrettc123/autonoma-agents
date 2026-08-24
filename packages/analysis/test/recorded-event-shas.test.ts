import { describe, expect, it } from "vitest";
import type { ResolvedAnalysisEvent } from "../src/analysis-event-resolver";
import { recordedEventShas } from "../src/recorded-event-shas";

function commitsPushed(headSha: string): ResolvedAnalysisEvent {
    return {
        type: "commits_pushed",
        payload: { headSha },
        source: "webhook",
        createdAt: new Date("2026-01-01T00:00:00Z"),
    };
}

describe("recordedEventShas", () => {
    it("collects distinct recorded heads, excluding shas the caller already has", () => {
        const events = [commitsPushed("sha-a"), commitsPushed("sha-b"), commitsPushed("sha-a")];
        expect(recordedEventShas(events, ["sha-b", "current-head"])).toEqual(["sha-a"]);
    });

    it("tolerates null/undefined entries in the already-fetched set (a snapshot with no base)", () => {
        expect(recordedEventShas([commitsPushed("sha-a")], ["head", null, undefined])).toEqual(["sha-a"]);
    });
});
