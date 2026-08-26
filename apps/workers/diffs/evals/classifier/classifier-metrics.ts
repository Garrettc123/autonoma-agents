import {
    ANALYSIS_VERDICT,
    type AnalysisVerdict,
    type AnalysisVerdictPlane,
    analysisVerdictPlane,
    analysisVerdictSchema,
} from "@autonoma/types";

/**
 * The fewest ground-truth examples a per-category recall needs before it reads as a number rather than a coin
 * flip. Below it a single flipped case swings the ratio by more than 0.2, so the report withholds the figure and
 * prints the support count instead. Tuned to the adjudicated corpus: at 5, `plan_mismatch` (3), `client_bug` (1)
 * and `engine_artifact` (0) are withheld and everything the corpus actually supports is shown.
 */
const MIN_SUPPORT = 5;

/** The verdict axis of the confusion matrix, in the taxonomy's own order. */
const VERDICTS: readonly AnalysisVerdict[] = analysisVerdictSchema.options;

/**
 * The order the planes are headlined in (app-health first - the plane that speaks to the app's behavior). A
 * `satisfies Record` over the plane union, so a new plane is a compile error here until it is given a position.
 */
const PLANE_ORDER = { app_health: 0, coverage: 1 } satisfies Record<AnalysisVerdictPlane, number>;

/** The planes present across the verdict taxonomy, derived from the SSOT and ordered by {@link PLANE_ORDER}. */
const PLANES: readonly AnalysisVerdictPlane[] = [...new Set(VERDICTS.map(analysisVerdictPlane))].sort(
    (a, b) => PLANE_ORDER[a] - PLANE_ORDER[b],
);

/**
 * One graded case reduced to the only two facts the matrix needs: its authored ground-truth verdict and what the
 * classifier predicted. `expected` that is not a real verdict (an unauthored case) makes the row UNLABELED; a
 * missing `predicted` (a skipped case, or one whose classifier threw before committing) makes it UNSCORED. Only
 * rows with both feed the matrix.
 */
export interface ClassifierResultRow {
    expected: string;
    predicted?: string;
}

/**
 * Precision/recall over a subset of verdicts - the one shape a category, a plane, and the `client_bug` slice all
 * take, because each is just "grade the classifier over these verdicts". A single category is a subset of size 1,
 * for which the block sum below collapses to the diagonal `cell(c, c)`; a plane is a larger subset. `undefined`
 * ratios mark an unmeasurable denominator, not a real 0%.
 */
export interface SubsetStats {
    /** Ground-truth count in the subset - the recall denominator. */
    support: number;
    /** How often the classifier predicted into the subset - the precision denominator. */
    predicted: number;
    /** Predictions that stayed inside the subset for a case whose truth is also in it - the block sum / diagonal. */
    correct: number;
    precision?: number;
    recall?: number;
}

/** One verdict's precision/recall, plus whether its ground-truth support is too small to trust the recall. */
export interface CategoryMetric extends SubsetStats {
    category: AnalysisVerdict;
    /** support < {@link MIN_SUPPORT}: recall here is withheld from the headline as too noisy to read. */
    lowSupport: boolean;
}

/** One plane's precision/recall - the stable layer, with real N on both sides of the corpus. */
export interface PlaneMetric extends SubsetStats {
    plane: AnalysisVerdictPlane;
}

/**
 * The `client_bug` slice, called out on its own because it is the customer-facing decision: the corpus is shaped
 * to catch OVER-reporting (a false `client_bug`), so precision and the raw false-positive count are the money
 * numbers. Recall is only reportable when the ground-truth support clears {@link MIN_SUPPORT} - it does not on the
 * current corpus (N=1), so it is withheld rather than shown as a coin flip.
 */
export interface ClientBugMetric {
    support: number;
    predicted: number;
    truePositives: number;
    falsePositives: number;
    precision?: number;
    recallReportable: boolean;
    recall?: number;
}

/** `counts[expected][predicted]` - a plain object so it serializes into the result JSON as-is. */
export type ConfusionMatrix = Record<string, Record<string, number>>;

export interface ClassifierMetrics {
    /** Rows carrying a real ground-truth verdict. */
    labeled: number;
    /** Labeled rows that also produced a prediction - the matrix population. */
    scored: number;
    /** Labeled rows with no prediction (skipped, or the classifier threw). */
    unscored: number;
    /** Rows with no authored ground-truth verdict. */
    unlabeled: number;
    confusion: ConfusionMatrix;
    perCategory: CategoryMetric[];
    planes: PlaneMetric[];
    clientBug: ClientBugMetric;
}

/** Aggregate per-case predictions into the confusion matrix and the precision/recall the corpus supports. */
export function computeClassifierMetrics(rows: readonly ClassifierResultRow[]): ClassifierMetrics {
    const confusion = emptyConfusion();
    let labeled = 0;
    let scored = 0;
    let unscored = 0;
    let unlabeled = 0;

    for (const row of rows) {
        const expected = asVerdict(row.expected);
        if (expected == null) {
            unlabeled += 1;
            continue;
        }
        labeled += 1;

        const predicted = row.predicted != null ? asVerdict(row.predicted) : undefined;
        if (predicted == null) {
            unscored += 1;
            continue;
        }
        scored += 1;

        const rowCounts = confusion[expected];
        if (rowCounts != null) rowCounts[predicted] = (rowCounts[predicted] ?? 0) + 1;
    }

    const cell = (expected: string, predicted: string): number => confusion[expected]?.[predicted] ?? 0;

    /** Precision/recall over any subset of verdicts - the one computation a category, a plane, and client_bug share. */
    const stats = (members: readonly AnalysisVerdict[]): SubsetStats => {
        const support = members.reduce((sum, expected) => sum + VERDICTS.reduce((s, p) => s + cell(expected, p), 0), 0);
        const predicted = members.reduce((sum, pred) => sum + VERDICTS.reduce((s, e) => s + cell(e, pred), 0), 0);
        const correct = members.reduce(
            (sum, expected) => sum + members.reduce((inner, predicted) => inner + cell(expected, predicted), 0),
            0,
        );
        return { support, predicted, correct, precision: ratio(correct, predicted), recall: ratio(correct, support) };
    };

    const perCategory = VERDICTS.map((category) => {
        const subset = stats([category]);
        return { category, ...subset, lowSupport: subset.support < MIN_SUPPORT };
    });
    const planes = PLANES.map((plane) => ({ plane, ...stats(membersOf(plane)) }));
    const clientBug = toClientBug(stats([ANALYSIS_VERDICT.client_bug]));

    return { labeled, scored, unscored, unlabeled, confusion, perCategory, planes, clientBug };
}

/** The verdicts that fall on a plane, from the taxonomy SSOT - never hand-listed. */
function membersOf(plane: AnalysisVerdictPlane): AnalysisVerdict[] {
    return VERDICTS.filter((verdict) => analysisVerdictPlane(verdict) === plane);
}

/** Re-shape the `client_bug` subset stats into the false-positive-first slice, withholding recall at low support. */
function toClientBug(subset: SubsetStats): ClientBugMetric {
    const recallReportable = subset.support >= MIN_SUPPORT;
    return {
        support: subset.support,
        predicted: subset.predicted,
        truePositives: subset.correct,
        falsePositives: subset.predicted - subset.correct,
        precision: subset.precision,
        recallReportable,
        recall: recallReportable ? subset.recall : undefined,
    };
}

function emptyConfusion(): ConfusionMatrix {
    const confusion: ConfusionMatrix = {};
    for (const expected of VERDICTS) {
        const row: Record<string, number> = {};
        for (const predicted of VERDICTS) row[predicted] = 0;
        confusion[expected] = row;
    }
    return confusion;
}

function asVerdict(value: string): AnalysisVerdict | undefined {
    const parsed = analysisVerdictSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/** A ratio, or `undefined` when the denominator is zero (an unmeasurable cell, not a real 0%). */
function ratio(numerator: number, denominator: number): number | undefined {
    return denominator > 0 ? numerator / denominator : undefined;
}
