import type { ClassifierMetrics } from "./classifier-metrics";

// Column widths for the stdout table - the file's layout knobs, kept together so the alignment tunes in one place.
const PCT_WIDTH = 8; // right-aligned "100.0%" (or a dash); also the withheld "N=<support>" recall cell
const COUNT_WIDTH = 6; // the support / predicted columns
const PLANE_LABEL_WIDTH = 11;
const CATEGORY_LABEL_WIDTH = 20; // also the confusion matrix's row-label column
const CONFUSION_ABBR_LENGTH = 4; // verdicts shown by their first N chars in the matrix header
const CONFUSION_CELL_WIDTH = 5;

const CAVEAT =
    "one live-model sample per case; the classifier is nondeterministic - re-run on the same prompt\n" +
    "sha and read the spread. per-category recall below support 5 is withheld (shown as N=<support>).";

/** The run identity a printed report is tagged with, so two runs are comparable by what actually changed. */
export interface ClassifierRunTag {
    /** sha256 of `CLASSIFIER_SYSTEM_PROMPT`, truncated. Group by this to compare prompt versions. */
    promptSha: string;
    /** The resolved classifier model id, e.g. `gpt-5.6-luna`. A separate axis from the prompt. */
    model: string;
}

/**
 * Render the metrics as the block a human reads off stdout and copies into the trend by hand. The plane figures
 * lead (the stable layer), then the `client_bug` slice (the money number), then the raw per-category table with
 * low-support recall withheld, then the confusion matrix and the sampling caveat.
 */
export function formatClassifierMetrics(metrics: ClassifierMetrics, tag: ClassifierRunTag): string {
    const lines: string[] = [
        "",
        "==== diffs-classifier: precision / recall ====",
        `prompt ${tag.promptSha}   model ${tag.model}`,
        `scored ${metrics.scored}/${metrics.labeled} labeled   (unscored ${metrics.unscored} - unlabeled ${metrics.unlabeled})`,
        "",
        "PLANE          precision   recall   support",
    ];

    for (const plane of metrics.planes) {
        lines.push(
            `  ${plane.plane.padEnd(PLANE_LABEL_WIDTH)} ${pct(plane.precision)} ${pct(plane.recall)}   ${plane.support}`,
        );
    }

    const bug = metrics.clientBug;
    const bugRecall = bug.recallReportable
        ? `recall ${pct(bug.recall).trim()}`
        : `recall withheld (support N=${bug.support})`;
    lines.push(
        "",
        `client_bug   precision ${pct(bug.precision).trim()}   false positives ${bug.falsePositives}   ${bugRecall}`,
        "",
        "CATEGORY               precision   recall   support   predicted",
    );

    for (const category of metrics.perCategory) {
        const recall = category.lowSupport ? rightAlign(`N=${category.support}`, PCT_WIDTH) : pct(category.recall);
        const flag = category.lowSupport ? "   low support" : "";
        lines.push(
            `  ${category.category.padEnd(CATEGORY_LABEL_WIDTH)} ${pct(category.precision)} ${recall}   ${rightAlign(String(category.support))}   ${rightAlign(String(category.predicted))}${flag}`,
        );
    }

    lines.push(
        "",
        "CONFUSION (rows = expected, cols = predicted)",
        ...confusionLines(metrics.confusion),
        "",
        CAVEAT,
        "",
    );
    return lines.join("\n");
}

/** The confusion matrix as an aligned table: a header row of predicted verdicts, then one row per expected verdict. */
function confusionLines(confusion: ClassifierMetrics["confusion"]): string[] {
    const verdicts = Object.keys(confusion);
    const abbr = (verdict: string): string => verdict.slice(0, CONFUSION_ABBR_LENGTH);
    const header = `  ${"".padEnd(CATEGORY_LABEL_WIDTH)} ${verdicts.map((verdict) => abbr(verdict).padStart(CONFUSION_CELL_WIDTH)).join(" ")}`;
    const rows = verdicts.map((expected) => {
        const cells = verdicts
            .map((predicted) => rightAlign(String(confusion[expected]?.[predicted] ?? 0), CONFUSION_CELL_WIDTH))
            .join(" ");
        return `  ${expected.padEnd(CATEGORY_LABEL_WIDTH)} ${cells}`;
    });
    return [header, ...rows];
}

/** A percentage right-aligned to the width of `100.0%`, or a right-aligned dash for an unmeasurable cell. */
function pct(value: number | undefined): string {
    const text = value == null ? "-" : `${(value * 100).toFixed(1)}%`;
    return rightAlign(text, PCT_WIDTH);
}

function rightAlign(text: string, width = COUNT_WIDTH): string {
    return text.padStart(width);
}
