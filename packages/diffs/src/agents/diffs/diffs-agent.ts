import { Agent, type AgentTool, type LanguageModel, type ModelMessage } from "@autonoma/ai";
import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { Codebase } from "../../codebase";
import { buildRepoManifestSection } from "../../codebase";
import type {
    BranchHistory,
    DiffAnalysis,
    ExistingTestInfo,
    MergeContextInfo,
    PreClassifiedConflictInfo,
} from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import { readPrChangedFiles, readPrCommitSubjects } from "../../pr-range";
import type { RunSubject } from "../../run-subject";
import type { ScenarioIndex } from "../../scenario-index";
import type { ScenarioRecipeData } from "../../scenario-recipe";
import { sharedCompactor } from "../compaction";
import {
    buildCodebaseTools,
    ListFlowsTool,
    ListScenariosTool,
    ListTestsTool,
    ReadScenarioRecipeEntitiesTool,
    ReadScenarioTool,
    ReadTestsTool,
    SubagentTool,
} from "../tools";
import type { AffectedTest } from "./affected-test";
import { DiffsAgentLoop } from "./diffs-agent-loop";
import { DIFFS_SYSTEM_PROMPT, buildDiffsUserPrompt } from "./diffs-prompt";
import { DiffsResultTool } from "./diffs-result-tool";
import { PLAN_AUTHORING_GUIDE } from "./plan-authoring-guide";
import { CreateTestTool, type CreatedTest } from "./tools/create-test-tool";
import { ExplainMergeConflictTool } from "./tools/explain-merge-conflict-tool";
import { MarkAffectedTestTool } from "./tools/mark-affected-test-tool";

export interface DiffsAgentConfig {
    model: LanguageModel;
}

/**
 * Per-snapshot input for the DiffsAgent.
 *
 * The base SHA + head SHA bound the diff to analyse; `codebase` is the on-disk
 * clone the tools read from. Everything else is suite metadata so the agent
 * can ground its decisions without re-querying the DB.
 */
export interface DiffsAgentInput {
    headSha: string;
    baseSha: string;
    codebase: Codebase;
    flowIndex: FlowIndex;
    existingTests: ExistingTestInfo[];
    /** Merges in the range that were deterministically processed before the agent ran. Empty for non-merge runs. */
    merges?: MergeContextInfo[];
    /** Merge-conflict tests to enrich with reasoning. Empty for non-merge runs. */
    preClassifiedConflicts?: PreClassifiedConflictInfo[];
    /** Free-text testing guidelines from the application owner. */
    testScopeGuidelines?: string;
    /**
     * The application's scenarios (named test data environments). Exposed via
     * `list_scenarios` / `read_scenario` so the agent can bind a `scenarioId`
     * when it authors a new test that needs seeded preconditions.
     */
    scenarios: ScenarioIndex;
    /**
     * Recipe **templates** for the scenarios the tests in scope reference,
     * resolved at setup from each scenario's point-in-time
     * `ScenarioRecipeVersion.fixtureJson`. This is template data (what each
     * scenario is designed to seed), NOT per-run instance data - analysis runs
     * before any replay, so no instance exists yet. Omitted/empty when no test in
     * scope references a scenario with a usable recipe.
     */
    scenarioRecipes?: ScenarioRecipeData[];
    /**
     * A bounded slice of the branch's analysis history - the tests prior runs removed as `invalid_test`, the
     * branch's recent Reporter reports, and its open bug-kind issues. Lets the selector avoid re-authoring a test
     * already thrown away and weight its choices with what has gone wrong on the branch. Absent on a brand-new
     * branch, where selection is identical to a stateless run.
     */
    branchHistory?: BranchHistory;
    /**
     * The analysis events the run claimed, oldest first - the record of repo movement (push bursts, rebases,
     * force pushes) the base..head diff alone cannot describe. Absent/empty leaves the prompt byte-identical to
     * an event-less run.
     */
    events?: ResolvedAnalysisEvent[];
    /**
     * The run's scoped subject - the branch's own unassessed content, with target-inherited and rebase-replayed
     * changes subtracted. Absent (main-branch runs, or an unresolvable scope) the prompt presents the plain
     * `base..head` range.
     */
    subject?: RunSubject | undefined;
}

export interface DiffsAgentResult {
    affectedTests: AffectedTest[];
    /** New tests the agent authored via `create_test`. The runner mints each one. */
    createdTests: CreatedTest[];
    reasoning: string;
}

const SYSTEM_PROMPT = `${DIFFS_SYSTEM_PROMPT}\n\n${PLAN_AUTHORING_GUIDE}`;

/**
 * QA-engineer agent: analyses a code diff between two SHAs and produces an
 * affected-test list + new-test suggestions. Owns a fixed set of action,
 * lookup, and codebase tools assembled at construction time; per-run state
 * (codebase, flow tree, validation sets) flows through {@link DiffsAgentLoop}.
 */
export class DiffsAgent extends Agent<DiffsAgentInput, DiffsAgentResult, DiffsAgentLoop> {
    private readonly logger: Logger;
    private readonly model: LanguageModel;

    private readonly codebaseTools = buildCodebaseTools();
    private readonly subagentTool: SubagentTool;
    private readonly listFlowsTool = new ListFlowsTool();
    private readonly listTestsTool = new ListTestsTool();
    private readonly readTestsTool = new ReadTestsTool();
    private readonly listScenariosTool = new ListScenariosTool();
    private readonly readScenarioTool = new ReadScenarioTool();
    private readonly markAffectedTestTool = new MarkAffectedTestTool();
    private readonly explainMergeConflictTool = new ExplainMergeConflictTool();
    private readonly createTestTool = new CreateTestTool();
    private readonly readScenarioRecipeEntitiesTool = new ReadScenarioRecipeEntitiesTool();
    private readonly resultTool = new DiffsResultTool();

    constructor({ model }: DiffsAgentConfig) {
        super();
        this.model = model;
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.subagentTool = new SubagentTool(model);
    }

    protected async buildUserPrompt(input: DiffsAgentInput): Promise<ModelMessage[]> {
        const analysis = await this.buildDiffAnalysis(input);
        this.logger.info("Built diff analysis", {
            extra: {
                affectedFiles: analysis.affectedFiles.length,
                summary: analysis.summary.slice(0, 200),
                scoped: input.subject != null,
            },
        });

        let prompt = buildDiffsUserPrompt({
            analysis,
            range: { baseSha: input.baseSha, headSha: input.headSha },
            subject: input.subject,
            events: input.events ?? [],
            flowIndex: input.flowIndex,
            merges: input.merges ?? [],
            preClassifiedConflicts: input.preClassifiedConflicts ?? [],
            testScopeGuidelines: input.testScopeGuidelines,
            scenarioRecipes: input.scenarioRecipes ?? [],
            branchHistory: input.branchHistory,
        });

        // A backend/dependency change can move which tests are affected, so surface the pinned dependency repos
        // (and their diffs) when the snapshot deployed a multi-repo preview.
        const manifest = input.codebase.dependencyManifest();
        if (manifest != null) {
            prompt += `\n\n## Repositories\n\n${await buildRepoManifestSection(manifest)}`;
        }

        return [{ role: "user", content: prompt }];
    }

    private async buildDiffAnalysis(input: DiffsAgentInput): Promise<DiffAnalysis> {
        if (input.subject == null) {
            const range = { root: input.codebase.primaryDir, baseSha: input.baseSha, headSha: input.headSha };
            const [affectedFiles, summary] = await Promise.all([
                readPrChangedFiles(range),
                readPrCommitSubjects(range),
            ]);
            return { affectedFiles, summary };
        }
        const subjects = input.subject.commits.map((commit) => commit.subject);
        return {
            affectedFiles: input.subject.files,
            // Newest first, matching what `git log` renders on the unscoped path.
            summary: subjects.length > 0 ? [...subjects].reverse().join("\n") : "(no changes owned by this branch)",
        };
    }

    protected async createLoop(input: DiffsAgentInput): Promise<DiffsAgentLoop> {
        const seededAffected: AffectedTest[] = (input.preClassifiedConflicts ?? []).map((c) => ({
            slug: c.slug,
            testName: c.testName,
            affectedReason: "merge_conflict" as const,
            reasoning: "",
        }));

        const scenarioRecipes = input.scenarioRecipes ?? [];

        // The recipe disclosure tool is only offered when at least one scenario
        // recipe was actually resolved - advertising a tool with no data to read
        // just wastes a turn. The recipe summary section in the prompt is gated
        // the same way.
        const tools: AgentTool<unknown, unknown>[] = [
            ...this.codebaseTools,
            this.subagentTool,
            this.listFlowsTool,
            this.listTestsTool,
            this.readTestsTool,
            this.listScenariosTool,
            this.readScenarioTool,
            this.markAffectedTestTool,
            this.explainMergeConflictTool,
            this.createTestTool,
        ];
        if (scenarioRecipes.length > 0) tools.push(this.readScenarioRecipeEntitiesTool);

        return new DiffsAgentLoop({
            name: "DiffsAgent",
            model: this.model,
            systemPrompt: SYSTEM_PROMPT,
            tools,
            reportTools: [this.resultTool],
            compactor: sharedCompactor(),
            codebase: input.codebase,
            flowIndex: input.flowIndex,
            existingTests: input.existingTests,
            scenarioIndex: input.scenarios,
            seededAffected,
            validSlugs: new Set(input.existingTests.map((t) => t.slug)),
            validConflictSlugs: new Set((input.preClassifiedConflicts ?? []).map((c) => c.slug)),
            scenarioRecipes,
        });
    }
}
