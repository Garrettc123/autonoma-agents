import { describe, expect, it } from "vitest";
import { buildVerdictTools } from "../../src/analysis/classify/verdict-tool";
import { Category, type RunVerdict } from "../../src/analysis/schema";

const tools = buildVerdictTools();

function baseVerdictInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ran: true,
        confidence: "high",
        headline: "The run reached a clear outcome",
        evidence: [
            {
                source: "run",
                detail: "The trace records the settled state.",
                repo: undefined,
                file: undefined,
                lines: undefined,
                snippet: undefined,
                stepIndex: undefined,
            },
        ],
        keyStepIndex: undefined,
        observedAppIssues: undefined,
        ...overrides,
    };
}

async function classify(toolName: string, input: Record<string, unknown>): Promise<RunVerdict> {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (tool == null) throw new Error(`Missing classifier tool ${toolName}`);
    return await tool.buildResult(input);
}

const validInputByCategory: Record<Category, Record<string, unknown>> = {
    passed: baseVerdictInput({
        expectedBehavior: "The cart shows the selected item.",
        actualBehavior: "The cart showed the selected item.",
        suggestedTestUpdate: undefined,
    }),
    client_bug: baseVerdictInput({
        expectedBehavior: "Saving persists the edited value.",
        actualBehavior: "The value reverted after reload.",
        falsePositiveRisk: "The diff and backend result rule out an intended change.",
    }),
    engine_artifact: baseVerdictInput({
        evidence: [],
        whatHappened: "A native browser dialog blocked the harness before the request was sent.",
    }),
    environment_failure: baseVerdictInput({
        whatHappened: "The preview lacked the integration key required to load the page.",
        falsePositiveRisk: "The seed cannot provide preview-level secrets.",
    }),
    scenario_issue: baseVerdictInput({
        whatHappened: "The Environment Factory did not seed the required account entitlement.",
        falsePositiveRisk: "The entitlement is app state rather than preview configuration.",
    }),
    plan_mismatch: baseVerdictInput({
        suggestedTestUpdate: "Setup\n1. Open checkout.\nSteps\n1. Click Pay.\nVerification\n1. Assert Order placed.",
        planMismatchNote: "The plan used the retired label; the rewrite targets the rendered Pay action.",
    }),
    invalid_test: baseVerdictInput({
        invalidTestNote: "The feature was removed with its route and handler, so no equivalent flow exists.",
        falsePositiveRisk: "The repository contains no replacement surface that could preserve the description.",
    }),
};

const expectedResultByCategory: Record<Category, Record<string, unknown>> = {
    passed: {
        expectedBehavior: "The cart shows the selected item.",
        actualBehavior: "The cart showed the selected item.",
    },
    client_bug: {
        expectedBehavior: "Saving persists the edited value.",
        actualBehavior: "The value reverted after reload.",
        falsePositiveRisk: "The diff and backend result rule out an intended change.",
    },
    engine_artifact: {
        whatHappened: "A native browser dialog blocked the harness before the request was sent.",
    },
    environment_failure: {
        whatHappened: "The preview lacked the integration key required to load the page.",
        falsePositiveRisk: "The seed cannot provide preview-level secrets.",
    },
    scenario_issue: {
        whatHappened: "The Environment Factory did not seed the required account entitlement.",
        falsePositiveRisk: "The entitlement is app state rather than preview configuration.",
    },
    plan_mismatch: {
        suggestedTestUpdate: "Setup\n1. Open checkout.\nSteps\n1. Click Pay.\nVerification\n1. Assert Order placed.",
        planMismatchNote: "The plan used the retired label; the rewrite targets the rendered Pay action.",
    },
    invalid_test: {
        invalidTestNote: "The feature was removed with its route and handler, so no equivalent flow exists.",
        falsePositiveRisk: "The repository contains no replacement surface that could preserve the description.",
    },
};

describe("the classifier's category terminal tools", () => {
    it("narrows every tool to its RunVerdict arm", async () => {
        for (const category of Category.options) {
            const verdict = await classify(`verdict_${category}`, validInputByCategory[category]);
            expect(verdict).toMatchObject({ category, ...expectedResultByCategory[category] });
        }
    });

    it("carries a passed verdict's optional rewrite when supplied", async () => {
        const suggestedTestUpdate =
            "Setup\n1. Open checkout.\nSteps\n1. Click Pay.\nVerification\n1. Assert Order placed.";
        const verdict = await classify(
            "verdict_passed",
            baseVerdictInput({
                expectedBehavior: "Checkout completes.",
                actualBehavior: "Checkout completed.",
                suggestedTestUpdate,
            }),
        );

        expect(verdict).toMatchObject({ category: "passed", suggestedTestUpdate });
    });

    it("preserves genuinely optional fields as undefined in the result", async () => {
        const verdict = await classify("verdict_passed", validInputByCategory.passed);

        expect(verdict.keyStepIndex).toBeUndefined();
        expect(verdict.observedAppIssues).toBeUndefined();
        expect(verdict.evidence[0]?.repo).toBeUndefined();
        expect(verdict.category === "passed" ? verdict.suggestedTestUpdate : "wrong arm").toBeUndefined();
    });

    it("rejects a missing field required by the selected tool", async () => {
        await expect(
            classify(
                "verdict_plan_mismatch",
                baseVerdictInput({ planMismatchNote: "The old plan targeted a label the app no longer renders." }),
            ),
        ).rejects.toThrow();
    });

    it("requires evidence for every verdict except engine_artifact", async () => {
        await expect(
            classify(
                "verdict_passed",
                baseVerdictInput({
                    expectedBehavior: "Checkout completes.",
                    actualBehavior: "Checkout completed.",
                    suggestedTestUpdate: undefined,
                    evidence: [],
                }),
            ),
        ).rejects.toThrow();

        await expect(classify("verdict_engine_artifact", validInputByCategory.engine_artifact)).resolves.toMatchObject({
            category: "engine_artifact",
            evidence: [],
        });
    });

    it("strips fields belonging to another verdict arm", async () => {
        const verdict = await classify(
            "verdict_passed",
            baseVerdictInput({
                expectedBehavior: "Checkout completes.",
                actualBehavior: "Checkout completed.",
                suggestedTestUpdate: undefined,
                whatHappened: "coverage-only filler",
                invalidTestNote: "invalid-test-only filler",
                isClientBug: false,
                planFidelity: "exact",
            }),
        );

        expect("whatHappened" in verdict).toBe(false);
        expect("invalidTestNote" in verdict).toBe(false);
        expect("isClientBug" in verdict).toBe(false);
        expect("planFidelity" in verdict).toBe(false);
    });
});
