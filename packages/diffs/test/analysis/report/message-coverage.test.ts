import { FixableToolError } from "@autonoma/ai";
import { describe, expect, it } from "vitest";
import { resolveAddressedMessages } from "../../../src/analysis/report/message-coverage";

describe("resolveAddressedMessages", () => {
    it("returns the entries when every claimed message is addressed exactly once", () => {
        const claimed = new Set(["evt-1", "evt-2"]);
        const addressed = [
            { eventId: "evt-1", response: "Re-ran checkout; it passed." },
            { eventId: "evt-2", response: "Cannot edit the suite; re-analyzed instead." },
        ];
        expect(resolveAddressedMessages(claimed, addressed)).toEqual(addressed);
    });

    it("accepts an empty list when the run claimed no message (a commits-only run)", () => {
        expect(resolveAddressedMessages(new Set(), [])).toEqual([]);
    });

    it("throws a fixable error when a claimed message is left unaddressed", () => {
        const claimed = new Set(["evt-1", "evt-2"]);
        expect(() => resolveAddressedMessages(claimed, [{ eventId: "evt-1", response: "done" }])).toThrow(
            FixableToolError,
        );
        try {
            resolveAddressedMessages(claimed, [{ eventId: "evt-1", response: "done" }]);
        } catch (error) {
            expect(String(error)).toContain("evt-2");
        }
    });

    it("throws when an addressed eventId was not claimed this run", () => {
        expect(() =>
            resolveAddressedMessages(new Set(["evt-1"]), [
                { eventId: "evt-1", response: "done" },
                { eventId: "evt-ghost", response: "invented" },
            ]),
        ).toThrow(FixableToolError);
    });

    it("throws when a message is addressed more than once", () => {
        expect(() =>
            resolveAddressedMessages(new Set(["evt-1"]), [
                { eventId: "evt-1", response: "a" },
                { eventId: "evt-1", response: "b" },
            ]),
        ).toThrow(FixableToolError);
    });
});
