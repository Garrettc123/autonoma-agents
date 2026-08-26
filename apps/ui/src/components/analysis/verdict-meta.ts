// Display metadata for an analysis finding's terminal AnalysisVerdict: a human label, the blacklight Badge
// variant, its presentation tier, its verdict plane, and whether it is actionable (counts against the PR).
// Verdicts arrive from the report as plain strings, so unknown values fall back gracefully.

import {
    type AnalysisFindingTier,
    type AnalysisVerdict,
    analysisFindingTier,
    analysisVerdictPlane,
    analysisVerdictSchema,
} from "@autonoma/types";
import type { BehaviorOutcome } from "components/analysis/verdict-story";
import type { FindingBadgeVariant } from "components/investigation/finding-category";

export type VerdictPlane = "app_health" | "coverage";

/**
 * Whether a verdict's actual behavior confirmed the expectation (a `passed` verdict) or contradicted it (everything
 * else that carries an expected/actual claim - a bug). Drives the expected/actual pair's tone so a passing verdict is
 * never painted like a failure. Derived from the taxonomy tier, so a new verdict is placed once and reaches this.
 */
export function verdictBehaviorOutcome(category: string): BehaviorOutcome {
    return analysisFindingTier(category) === "passed" ? "match" : "divergence";
}

/**
 * The outcome header a tier renders under wherever findings are grouped by tier - the PR overview's "Tests run" list
 * and the snapshot findings panel's "Needs review" group both read from this one map, so the wording cannot drift
 * between them. A `Record` over the taxonomy tier SSOT, so a new tier is a compile error here until it is named.
 */
export const TIER_LABEL: Record<AnalysisFindingTier, string> = {
    bug: "Failed",
    needs_review: "Needs review",
    coverage: "Couldn't run",
    passed: "Passed",
};

export interface AnalysisVerdictMeta {
    label: string;
    variant: FindingBadgeVariant;
    /** Which group a findings list renders this in, and the order it sorts by. */
    tier: AnalysisFindingTier;
    /** App-health verdicts drive the PR headline; coverage verdicts never count against it. */
    plane: VerdictPlane;
    /** True only for verdicts that count against the PR - the actionable list; everything else collapses. */
    actionable: boolean;
}

// UI label + Badge variant per verdict. ONLY the label and variant are chosen here: the tier, plane and actionable
// flag are derived from the `@autonoma/types` taxonomy SSOT (analysisFindingTier / analysisVerdictPlane), so no
// grouping or ordering decision can be re-invented in the UI and drift from the backend. Exhaustive over the
// AnalysisVerdict enum: adding a verdict is a compile error until styled here.
const VERDICT_STYLE: Record<AnalysisVerdict, { label: string; variant: FindingBadgeVariant }> = {
    client_bug: { label: "Client bug", variant: "critical" },
    passed: { label: "Passed", variant: "success" },
    engine_artifact: { label: "Engine artifact", variant: "high" },
    scenario_issue: { label: "Scenario issue", variant: "warn" },
    environment_failure: { label: "Environment failure", variant: "outline" },
    plan_mismatch: { label: "Plan mismatch", variant: "secondary" },
    invalid_test: { label: "Invalid test", variant: "warn" },
};

export function analysisVerdictMeta(category: string): AnalysisVerdictMeta {
    const parsed = analysisVerdictSchema.safeParse(category);
    const style = parsed.success
        ? VERDICT_STYLE[parsed.data]
        : { label: category.replace(/_/g, " "), variant: "outline" as const };
    const tier = analysisFindingTier(category);
    return {
        label: style.label,
        variant: style.variant,
        tier,
        plane: analysisVerdictPlane(category),
        actionable: tier === "bug",
    };
}
