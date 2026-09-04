import { Category, type RunVerdict } from "@autonoma/diffs/analysis";
import { type CheckFailure, baseFrontmatterSchema, checkEnumEquality } from "@autonoma/evals";
import type { z } from "zod";

/**
 * The shortest a revised plan can be and still carry instruction. A `plan_mismatch` carries the COMPLETE
 * rewritten plan, so anything under this is a placeholder ("n/a", "TODO", "same") - present but empty of steps,
 * which the self-heal loop would re-run to no effect. Set well below any real multi-step plan so it only ever
 * trips on a non-answer, never a terse-but-genuine rewrite.
 */
const MIN_SUGGESTED_TEST_UPDATE_LENGTH = 20;

/**
 * Deterministic checks for a Classifier case, layered on the shared base.
 *
 * Only two things are graded here, and the omissions are deliberate:
 *
 * - `confidence` is NOT graded. It is the field most likely to move between two runs of an unchanged
 *   classifier, so asserting it would make a case flaky without saying anything a reader could act on.
 * - `evidence` is NOT graded beyond the schema's own `min(1)`. Whether the cited evidence actually supports
 *   the verdict is exactly the kind of judgement the rubric exists for.
 * - `keyStepIndex` is NOT graded. Which frame best shows a finding is a judgement call, and an index naming
 *   no step is already handled downstream by showing no screenshot at all.
 */
export const classifierFrontmatterSchema = baseFrontmatterSchema.extend({
    /**
     * The verdict this case asserts. Left BLANK by capture on purpose: pre-filling it from production would
     * make rubber-stamping a wrong verdict the path of least resistance. A case with no `category` runs its
     * rubric only.
     */
    category: Category.optional(),
    /**
     * What production said the day this case was frozen, never edited afterwards. Provenance, not an
     * assertion - when `category` is later re-baselined (an `engine_artifact` that should now read `passed`
     * because the engine grew the capability), this still shows where the case started.
     */
    capturedCategory: Category.optional(),
});

export type ClassifierFrontmatter = z.infer<typeof classifierFrontmatterSchema>;

/** Apply the Classifier deterministic checks to one verdict. An empty list means the checks passed. */
export function checkClassifierVerdict(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
    return [...checkCategory(verdict, frontmatter), ...checkSuggestedTestUpdate(verdict)];
}

function checkCategory(verdict: RunVerdict, frontmatter: ClassifierFrontmatter): CheckFailure[] {
    if (frontmatter.category == null) return [];
    return checkEnumEquality("category", verdict.category, frontmatter.category);
}

/**
 * A `plan_mismatch` carries the COMPLETE rewritten plan the self-heal loop re-runs, so a blank or
 * placeholder-length one means the classifier diagnosed a fixable test and then fixed nothing. Only applies to
 * the arm that carries the field; every other category is silent.
 */
function checkSuggestedTestUpdate(verdict: RunVerdict): CheckFailure[] {
    if (verdict.category !== "plan_mismatch") return [];

    const revisedPlan = verdict.suggestedTestUpdate.trim();
    if (revisedPlan.length >= MIN_SUGGESTED_TEST_UPDATE_LENGTH) return [];

    return [
        {
            check: "suggestedTestUpdate",
            message: `plan_mismatch carried a ${revisedPlan.length}-char revised plan (min ${MIN_SUGGESTED_TEST_UPDATE_LENGTH})`,
        },
    ];
}
