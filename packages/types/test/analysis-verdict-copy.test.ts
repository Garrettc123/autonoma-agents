import { describe, expect, it } from "vitest";
import {
    type AnalysisFlow,
    type AnalysisFlowStatus,
    type AnalysisVerdictSummary,
    analysisVerdictHeadline,
    analysisVerdictLabel,
    analysisVerdictPill,
} from "../src/schemas/analysis";

/** A resolved verdict, as `BranchLedger.verdict()` hands it to a renderer. */
function verdict(summary: AnalysisVerdictSummary): AnalysisVerdictSummary {
    return summary;
}

/** A flow with the given status; only its status feeds the pill's ratio, so the counts are placeholders. */
function flow(status: AnalysisFlowStatus): AnalysisFlow {
    return {
        title: "Flow",
        detail: "",
        status,
        owner: "none",
        passedCount: 0,
        gapCount: 0,
        bugCount: 0,
        checkedThisRunCount: 0,
        testSlugs: [],
    };
}

describe("analysisVerdictLabel + analysisVerdictHeadline", () => {
    it("leads with what we learned about the change, not with whether a bug was found", () => {
        expect(analysisVerdictLabel("healthy")).toBe("HEALTHY");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "healthy", bugCount: 0, coverageGapCount: 0, investigatedCount: 4 }),
            ),
        ).toBe("Autonoma verified this change - the app held up.");

        expect(analysisVerdictLabel("not_confirmed")).toBe("NOT CONFIRMED");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "not_confirmed", bugCount: 0, coverageGapCount: 1, investigatedCount: 4 }),
            ),
        ).toBe("Autonoma couldn't confirm this change - 1 check didn't complete.");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "not_confirmed", bugCount: 0, coverageGapCount: 2, investigatedCount: 4 }),
            ),
        ).toBe("Autonoma couldn't confirm this change - 2 checks didn't complete.");

        expect(analysisVerdictLabel("bug_found")).toBe("BUG FOUND");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "bug_found", bugCount: 1, coverageGapCount: 0, investigatedCount: 3 }),
            ),
        ).toBe("Autonoma found 1 bug in this PR.");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "bug_found", bugCount: 2, coverageGapCount: 0, investigatedCount: 3 }),
            ),
        ).toBe("Autonoma found 2 bugs in this PR.");
    });

    it("states the no-tests decision as ours, never as a claim about the reader's codebase", () => {
        expect(analysisVerdictLabel("no_tests_needed")).toBe("NO TESTS NEEDED");
        const headline = analysisVerdictHeadline(
            verdict({ state: "no_tests_needed", bugCount: 0, coverageGapCount: 0, investigatedCount: 0 }),
        );
        expect(headline).toBe("No tests needed for this change.");
        // Two of three sampled zero-test runs were user-facing changes we deliberately declined to cover, so the
        // headline may never generalize from "we ran nothing" to "this change does not touch the UI".
        expect(headline).not.toMatch(/UI|user-facing|interface/i);
    });
});

describe("analysisVerdictPill", () => {
    it("leads with the branch's open bugs, in an alarm tone and with no reason", () => {
        const pill = analysisVerdictPill(
            verdict({ state: "bug_found", bugCount: 2, coverageGapCount: 0, investigatedCount: 3 }),
            [flow("broken"), flow("verified")],
        );
        expect(pill).toEqual({ tone: "critical", label: "2 bugs", reason: undefined });
    });

    it("states the accumulated flow ratio with a NEUTRAL tone when a change is unconfirmed, and drops the redundant reason", () => {
        const flows = [flow("verified"), flow("verified"), ...Array.from({ length: 6 }, () => flow("unverified"))];
        // The ratio reads the branch's 8 flows (2 verified), so its remainder is already the 6 that could not be
        // confirmed; a "6 couldn't confirm" reason would only restate it, so the ratio pill carries no reason.
        const pill = analysisVerdictPill(
            verdict({ state: "not_confirmed", bugCount: 0, coverageGapCount: 3, investigatedCount: 8 }),
            flows,
        );
        expect(pill).toEqual({ tone: "neutral", label: "2/8 flows verified", reason: undefined });
    });

    it("shows a full ratio with no reason when every flow verified", () => {
        const pill = analysisVerdictPill(
            verdict({ state: "healthy", bugCount: 0, coverageGapCount: 0, investigatedCount: 4 }),
            [flow("verified"), flow("verified"), flow("verified"), flow("verified")],
        );
        expect(pill).toEqual({ tone: "success", label: "4/4 flows verified", reason: undefined });
    });

    it("falls back to the verdict's word and its own coverage count when no flows were itemized", () => {
        expect(
            analysisVerdictPill(
                verdict({ state: "not_confirmed", bugCount: 0, coverageGapCount: 2, investigatedCount: 5 }),
                [],
            ),
        ).toEqual({ tone: "neutral", label: "Not confirmed", reason: "2 couldn't confirm" });
        expect(
            analysisVerdictPill(
                verdict({ state: "no_tests_needed", bugCount: 0, coverageGapCount: 0, investigatedCount: 0 }),
                [],
            ),
        ).toEqual({ tone: "success", label: "No tests needed", reason: undefined });
    });
});
