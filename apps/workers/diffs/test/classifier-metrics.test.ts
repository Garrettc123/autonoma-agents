import type { AnalysisVerdict, AnalysisVerdictPlane } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    type CategoryMetric,
    type ClassifierMetrics,
    type ClassifierResultRow,
    type PlaneMetric,
    computeClassifierMetrics,
} from "../evals/classifier/classifier-metrics";

/** N copies of the same predicted/expected pair, so a corpus is described by its shape rather than by repetition. */
function pairs(count: number, expected: string, predicted?: string): ClassifierResultRow[] {
    return Array.from({ length: count }, () => ({ expected, predicted }));
}

function categoryMetric(metrics: ClassifierMetrics, category: AnalysisVerdict): CategoryMetric {
    const found = metrics.perCategory.find((metric) => metric.category === category);
    if (found == null) throw new Error(`no per-category metric for ${category}`);
    return found;
}

function planeMetric(metrics: ClassifierMetrics, plane: AnalysisVerdictPlane): PlaneMetric {
    const found = metrics.planes.find((metric) => metric.plane === plane);
    if (found == null) throw new Error(`no plane metric for ${plane}`);
    return found;
}

describe("computeClassifierMetrics", () => {
    // A corpus with a false client_bug alarm, a coverage->app_health leak, an intra-plane miss, an unauthored row,
    // and a case with no verdict - so every population and both plane directions are exercised at once.
    const rows: ClassifierResultRow[] = [
        ...pairs(4, "passed", "passed"),
        ...pairs(1, "passed", "client_bug"), // a passed case mislabeled a bug: a false client_bug alarm
        ...pairs(1, "client_bug", "client_bug"),
        ...pairs(6, "scenario_issue", "scenario_issue"),
        ...pairs(1, "scenario_issue", "passed"), // coverage leaked into the app-health plane
        ...pairs(1, "environment_failure", "engine_artifact"), // wrong category, right plane
        ...pairs(1, "(unauthored)", "passed"), // no ground truth -> unlabeled
        ...pairs(1, "invalid_test"), // produced no verdict -> unscored
    ];
    const metrics = computeClassifierMetrics(rows);

    it("partitions rows into labeled / scored / unscored / unlabeled", () => {
        expect(metrics.labeled).toBe(15);
        expect(metrics.scored).toBe(14);
        expect(metrics.unscored).toBe(1);
        expect(metrics.unlabeled).toBe(1);
    });

    it("computes per-category precision and recall from the confusion counts", () => {
        const passed = categoryMetric(metrics, "passed");
        expect(passed.support).toBe(5);
        expect(passed.predicted).toBe(5);
        expect(passed.precision).toBeCloseTo(0.8);
        expect(passed.recall).toBeCloseTo(0.8);
        expect(passed.lowSupport).toBe(false);

        const scenario = categoryMetric(metrics, "scenario_issue");
        expect(scenario.precision).toBeCloseTo(1);
        expect(scenario.recall).toBeCloseTo(6 / 7);
        expect(scenario.lowSupport).toBe(false);
    });

    it("leaves precision undefined when a verdict was never predicted, and recall undefined with no support", () => {
        const environment = categoryMetric(metrics, "environment_failure");
        expect(environment.predicted).toBe(0);
        expect(environment.precision).toBeUndefined();
        expect(environment.recall).toBeCloseTo(0);

        const engine = categoryMetric(metrics, "engine_artifact");
        expect(engine.support).toBe(0);
        expect(engine.recall).toBeUndefined();
        expect(engine.precision).toBeCloseTo(0); // predicted once, never correct
    });

    it("flags a category whose ground-truth support is too small to trust its recall", () => {
        expect(categoryMetric(metrics, "client_bug").lowSupport).toBe(true);
        expect(categoryMetric(metrics, "plan_mismatch").lowSupport).toBe(true);
        expect(categoryMetric(metrics, "passed").lowSupport).toBe(false);
    });

    it("computes plane precision/recall over the app-health vs coverage partition", () => {
        const appHealth = planeMetric(metrics, "app_health");
        expect(appHealth.support).toBe(6); // 5 passed + 1 client_bug
        expect(appHealth.predicted).toBe(7); // scenario->passed leaked in
        expect(appHealth.correct).toBe(6);
        expect(appHealth.precision).toBeCloseTo(6 / 7);
        expect(appHealth.recall).toBeCloseTo(1);

        const coverage = planeMetric(metrics, "coverage");
        expect(coverage.support).toBe(8);
        expect(coverage.predicted).toBe(7);
        expect(coverage.correct).toBe(7);
        expect(coverage.precision).toBeCloseTo(1);
        expect(coverage.recall).toBeCloseTo(7 / 8);
    });

    it("reports client_bug precision and false positives, and withholds its recall at low support", () => {
        expect(metrics.clientBug.support).toBe(1);
        expect(metrics.clientBug.predicted).toBe(2);
        expect(metrics.clientBug.truePositives).toBe(1);
        expect(metrics.clientBug.falsePositives).toBe(1);
        expect(metrics.clientBug.precision).toBeCloseTo(0.5);
        expect(metrics.clientBug.recallReportable).toBe(false);
        expect(metrics.clientBug.recall).toBeUndefined();
    });
});

describe("computeClassifierMetrics edge cases", () => {
    it("returns zeroed, undefined-ratio metrics for an empty corpus without dividing by zero", () => {
        const metrics = computeClassifierMetrics([]);
        expect(metrics.labeled).toBe(0);
        expect(metrics.scored).toBe(0);
        expect(planeMetric(metrics, "app_health").precision).toBeUndefined();
        expect(planeMetric(metrics, "app_health").recall).toBeUndefined();
        expect(categoryMetric(metrics, "passed").precision).toBeUndefined();
        expect(metrics.clientBug.precision).toBeUndefined();
    });

    it("scores a perfect run as precision and recall 1 on every populated plane", () => {
        const metrics = computeClassifierMetrics([
            ...pairs(6, "passed", "passed"),
            ...pairs(6, "client_bug", "client_bug"),
            ...pairs(6, "scenario_issue", "scenario_issue"),
        ]);
        expect(planeMetric(metrics, "app_health").precision).toBeCloseTo(1);
        expect(planeMetric(metrics, "app_health").recall).toBeCloseTo(1);
        expect(planeMetric(metrics, "coverage").precision).toBeCloseTo(1);
        expect(metrics.clientBug.falsePositives).toBe(0);
        expect(metrics.clientBug.recallReportable).toBe(true);
        expect(metrics.clientBug.recall).toBeCloseTo(1);
    });
});
