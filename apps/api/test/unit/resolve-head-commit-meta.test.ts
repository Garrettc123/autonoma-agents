import type { Commit } from "@autonoma/github";
import { describe, expect, it } from "vitest";
import { type HeadCommitReader, resolveHeadCommitMeta } from "../../src/analysis/enqueue-and-start-analysis-run";

function reader(commit: Commit): HeadCommitReader {
    return { getCommitByRepo: async () => commit };
}

describe("resolveHeadCommitMeta", () => {
    it("captures the full commit message (body and all) and the author login", async () => {
        const meta = await resolveHeadCommitMeta(
            reader({
                sha: "abc",
                message: "Fix checkout\n\nRecompute validity after address.",
                authorLogin: "jrivera",
            }),
            "org_1",
            42,
            "abc",
        );
        expect(meta).toEqual({ message: "Fix checkout\n\nRecompute validity after address.", author: "jrivera" });
    });

    it("returns no message when the commit message is blank", async () => {
        const meta = await resolveHeadCommitMeta(reader({ sha: "abc", message: "   " }), "org_1", 42, "abc");
        expect(meta).toEqual({ message: undefined, author: undefined });
    });

    it("degrades to empty when the GitHub read fails, so the event still enqueues", async () => {
        const failing: HeadCommitReader = {
            getCommitByRepo: async () => {
                throw new Error("GitHub 404");
            },
        };
        await expect(resolveHeadCommitMeta(failing, "org_1", 42, "abc")).resolves.toEqual({});
    });
});
