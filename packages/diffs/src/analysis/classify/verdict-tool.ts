import { declinable, ReportResultTool } from "@autonoma/ai";
import { z } from "zod";
import { Confidence, EvidenceSource, RunVerdict, type Category, type RunVerdict as RunVerdictResult } from "../schema";
import type { ClassifierAgentLoop } from "./classifier-agent-loop";

/**
 * Field vocabulary shared by more than one verdict, worded once so the same field cannot drift between the
 * tools that carry it. A field only one verdict uses lives inline in that verdict's spec below, not here.
 */
const EXPECTED_BEHAVIOR = z
    .string()
    .min(1)
    .describe(
        "What the app should have done at the moment that matters, against the baseline, in 1-3 sentences. Put supporting code, logs, and queried data in evidence.",
    );
const ACTUAL_BEHAVIOR = z
    .string()
    .min(1)
    .describe(
        "What the app actually did in the run, including any app errors directly observed, in 1-3 sentences. Name a mechanism only when the evidence proves it.",
    );
const FALSE_POSITIVE_RISK = z
    .string()
    .min(1)
    .describe(
        "Actively check whether this could instead be an intended change, scenario gap, environment problem, or salvageable test, and state what rules those alternatives out.",
    );
const WHAT_HAPPENED = z
    .string()
    .min(1)
    .describe(
        "In 2-3 sentences, explain what blocked coverage and why the owner is the harness, environment, or scenario rather than the app.",
    );
const PLAN_FORMAT =
    "The complete revised plan, ready to replace the original. Preserve its wording, numbering and structure and change only the lines that must change. Use Setup / Steps / Verification; the user is already authenticated; steps use only click, type, scroll, assert, hover, drag, read, refresh, or wait (never verify, navigate, select, check); assert exact visible on-screen text with location context, never toasts; ground every label in the code (grep the locale file). Never submit a blank or whitespace-only plan.";

const EvidenceForModel = z.object({
    source: EvidenceSource.describe("Where this evidence came from."),
    detail: z.string().min(1).describe("The self-contained observation and what it proves."),
    repo: declinable(z.string().min(1)).describe(
        "The dependency repository as owner/repo when applicable; pass null for the primary repository.",
    ),
    file: declinable(z.string().min(1)).describe(
        "The repository-relative path for code or diff evidence; pass null when not applicable.",
    ),
    lines: declinable(z.string().min(1)).describe(
        "The cited line range, such as 34-41; pass null when not applicable.",
    ),
    snippet: declinable(z.string().min(1)).describe(
        "The exact relevant code or log excerpt; pass null when not applicable.",
    ),
    stepIndex: declinable(z.number().int().positive()).describe(
        "The trace step number whose frame shows this screenshot or video evidence; pass null when no single frame applies.",
    ),
});

/** The fields every verdict carries; each tool extends this with the fields specific to its category. */
const verdictWireBase = z.object({
    ran: z.boolean().describe("Whether the run got past load/login and executed steps against the app."),
    confidence: Confidence.describe("Confidence in the selected owner based on the evidence gathered."),
    headline: z
        .string()
        .min(1)
        .describe(
            "A short one-line title (about 12 words maximum) naming the user-visible symptom. Do not include code spans, file paths, quotes, or a because clause.",
        ),
    evidence: z
        .array(EvidenceForModel)
        .min(1)
        .describe("The self-contained proof for the verdict. Every verdict except engine_artifact requires an item."),
    keyStepIndex: declinable(z.number().int().positive()).describe(
        "The trace step number whose still most clearly shows the finding; pass null when no frame is representative.",
    ),
    observedAppIssues: declinable(z.string().min(1)).describe(
        "Confirmed app problems independent of this test's outcome; pass null when the app looked healthy.",
    ),
});

/** One terminal tool per category: its `description` (when to choose it) and the `fields` it adds to the base. */
interface VerdictToolSpec {
    category: Category;
    description: string;
    fields: z.ZodRawShape;
}

/**
 * The classifier's terminal tools, one per {@link Category} and IN Category order (the coupling test pins that
 * the tool names are exactly `verdict_<category>` for every category). Each entry reads top to bottom: when to
 * pick this verdict, then the fields that verdict alone requires.
 */
const VERDICT_TOOLS: VerdictToolSpec[] = [
    {
        category: "passed",
        description:
            "Choose passed when the run reached the behavior named by the test description, even if the written steps or assertion literals drifted from the UI. State expected and actual behavior; put any drift correction in suggestedTestUpdate, which is applied without a re-run.",
        fields: {
            expectedBehavior: EXPECTED_BEHAVIOR,
            actualBehavior: ACTUAL_BEHAVIOR,
            suggestedTestUpdate: declinable(z.string().min(1)).describe(
                `${PLAN_FORMAT} This plan is applied to the test WITHOUT a re-run, so change only what this passing run proved: a drifted label, literal, or step target. Pass null when the plan needs no correction.`,
            ),
        },
    },
    {
        category: "client_bug",
        description:
            "Choose client_bug only when the app is broken and code, logs, or queried data prove the mechanism. State expected versus actual behavior and actively rule out a false positive.",
        fields: {
            expectedBehavior: EXPECTED_BEHAVIOR,
            actualBehavior: ACTUAL_BEHAVIOR,
            falsePositiveRisk: FALSE_POSITIVE_RISK,
        },
    },
    {
        category: "engine_artifact",
        description:
            "Choose engine_artifact when the test hit a terminal harness limitation or agent stall while the app and platform were healthy. Explain the harness fault; evidence may be empty only when the harness produced none.",
        fields: {
            evidence: z
                .array(EvidenceForModel)
                .min(0)
                .describe("Evidence for the harness fault; an empty array is allowed when the harness produced none."),
            whatHappened: WHAT_HAPPENED,
        },
    },
    {
        category: "environment_failure",
        description:
            "Choose environment_failure for missing preview or infrastructure configuration, secrets, integrations, migrations, or an undetermined non-app owner. Explain the failure and rule out app and scenario ownership.",
        fields: { whatHappened: WHAT_HAPPENED, falsePositiveRisk: FALSE_POSITIVE_RISK },
    },
    {
        category: "scenario_issue",
        description:
            "Choose scenario_issue when app state owned by the customer's Environment Factory was missing. Explain the missing state and rule out an app defect or preview-infrastructure failure.",
        fields: { whatHappened: WHAT_HAPPENED, falsePositiveRisk: FALSE_POSITIVE_RISK },
    },
    {
        category: "plan_mismatch",
        description:
            "Choose plan_mismatch only when the platform is healthy, the described behavior is reachable, and the run did NOT reach it because the written steps do not match the app. A complete revised plan and mismatch diagnosis are mandatory; a run that reached the behavior is passed.",
        fields: {
            suggestedTestUpdate: z
                .string()
                .min(1)
                .describe(
                    `${PLAN_FORMAT} This plan WILL BE RE-RUN against this same app and MUST PASS: assert the settled behavior you verified, never one your own diagnosis predicts will fail. Never fabricate a rewrite for a feature that does not exist.`,
                ),
            planMismatchNote: z
                .string()
                .min(1)
                .describe(
                    "Explain what the test asserted or did that no longer matches the healthy app, the concrete rewrite proposed, and, on a self-heal re-run, why the prior rewrite still failed.",
                ),
        },
    },
    {
        category: "invalid_test",
        description:
            "Choose invalid_test only when no plan can satisfy the description on a healthy platform. Prove the impossibility and actively rule out an equivalent surface that would make the test salvageable.",
        fields: {
            invalidTestNote: z
                .string()
                .min(1)
                .describe(
                    "Name the impossibility: a nonexistent feature, structurally unexecutable steps, a premise contradicted by the app, or another unrecoverable condition. Prove why no intent-preserving rewrite can recover the test.",
                ),
            falsePositiveRisk: FALSE_POSITIVE_RISK,
        },
    },
];

class CategoryVerdictTool extends ReportResultTool<object, RunVerdictResult, ClassifierAgentLoop> {
    constructor(
        private readonly category: Category,
        description: string,
        wireSchema: z.ZodSchema<object>,
    ) {
        super({ name: `verdict_${category}`, description, inputSchema: wireSchema });
    }

    async buildResult(input: object): Promise<RunVerdictResult> {
        return RunVerdict.parse({ category: this.category, ...input });
    }
}

/** Build the classifier's exhaustive set of category-selecting terminal tools. */
export function buildVerdictTools() {
    return VERDICT_TOOLS.map(
        (spec) => new CategoryVerdictTool(spec.category, spec.description, verdictWireBase.extend(spec.fields)),
    );
}
