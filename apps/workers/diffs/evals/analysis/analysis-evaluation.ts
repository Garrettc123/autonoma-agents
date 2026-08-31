import path from "node:path";
import { recordedEventShas } from "@autonoma/analysis";
import {
    type Codebase,
    computeRunSubject,
    DiffsAgent,
    type DiffsAgentResult,
    skipSelectionForEmptySubject,
} from "@autonoma/diffs";
import type { ModelSession } from "@autonoma/diffs/analysis";
import { type CheckFailure, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { type RunOutcome, ScoredReplayEvaluation, rehydrateOrSkip } from "../framework";
import { writeAgentTranscript } from "../framework/transcript-artifact";
import { type AnalysisFrontmatter, checkAnalysisResult } from "./analysis-frontmatter";
import { type AnalysisCaseInput, type RehydratedAnalysisInput, rehydrateAnalysisInput } from "./analysis-input";

/** A loaded Analysis eval case: frozen input + authored expectations. */
export type AnalysisCase = LoadedCase<AnalysisCaseInput, AnalysisFrontmatter>;

/** Per-case timeout: the agent does real codebase exploration + model calls. */
const TIMEOUT_MS = 600_000;

/** What one run of the Analysis case needs: the checked-out clone plus the agent input minus its codebase. */
interface AnalysisContext {
    codebase: Codebase;
    agentInput: RehydratedAnalysisInput["agentInput"];
}

/**
 * Scored eval for the Diff Analysis step.
 *
 * For each case it rehydrates the codebase from the frozen coords, runs the
 * {@link DiffsAgent} directly over the frozen input (no runner, no DB), applies
 * the deterministic frontmatter checks, and finally runs the output-only LLM
 * judge against the rubric. A case passes if the deterministic checks pass
 * AND the judge passes. Cases whose codebase can no longer be fetched are
 * skipped, not failed.
 *
 * Cases run concurrently: each rehydrates into its own git worktree off the
 * shared repo clone.
 */
export class AnalysisEvaluation extends ScoredReplayEvaluation<
    AnalysisCaseInput,
    AnalysisFrontmatter,
    AnalysisContext,
    DiffsAgentResult
> {
    private readonly transcriptDir: string;

    constructor(resultsDir: string, cases: AnalysisCase[]) {
        super({ name: "diffs-analysis", resultsDir, timeoutMs: TIMEOUT_MS }, cases);
        // Stamped per suite run, so repeated runs keep every transcript - diffing two runs of an unchanged
        // prompt is how selection variance gets diagnosed.
        this.transcriptDir = path.join(resultsDir, "transcripts", String(Date.now()));
    }

    protected override testCaseInfo(testCase: AnalysisCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
        };
    }

    protected override async setUp(testCase: AnalysisCase, helpers: RunCaseHelpers): Promise<AnalysisContext> {
        const { coords, agentInput, targetSha } = rehydrateAnalysisInput(testCase.input);
        const eventShas = recordedEventShas(agentInput.events ?? [], [coords.headSha, coords.baseSha]);
        const codebase = await rehydrateOrSkip(
            coords,
            helpers,
            { logger: this.logger, caseName: testCase.name },
            { extraShas: targetSha != null ? [...eventShas, targetSha] : eventShas },
        );
        // The subject is a pure function of the clone + shas, so it is recomputed here through the same
        // production call rather than frozen - a frozen copy could only go stale against `computeRunSubject`.
        const subject =
            targetSha != null
                ? await computeRunSubject({
                      root: codebase.primaryDir,
                      headSha: coords.headSha,
                      frontierSha: coords.baseSha,
                      targetSha,
                  })
                : undefined;
        return { codebase, agentInput: { ...agentInput, subject } };
    }

    protected override async runOnce(
        session: ModelSession,
        testCase: AnalysisCase,
        context: AnalysisContext,
    ): Promise<RunOutcome<DiffsAgentResult>> {
        // The same deterministic answer production gives a pushes-only empty-subject run - the case then grades
        // the short-circuit wiring rather than an agent that was never invoked.
        const skipped = skipSelectionForEmptySubject(context.agentInput.subject, context.agentInput.events ?? []);
        if (skipped != null) {
            return { result: skipped, info: { skippedSelection: true } };
        }

        const model = session.getModel({ model: "impact", tag: "analysis-impact" });
        const agent = new DiffsAgent({ model });
        const { result, conversation } = await agent.run({ ...context.agentInput, codebase: context.codebase });
        const transcriptPath = await writeAgentTranscript({
            dir: this.transcriptDir,
            caseName: testCase.name,
            conversation,
        });
        return {
            result,
            info: {
                affectedTests: result.affectedTests.map((t) => t.slug),
                createdTestCount: result.createdTests.length,
                createdTestFolders: result.createdTests.map((t) => t.folderName),
                transcriptPath,
            },
        };
    }

    protected override check(result: DiffsAgentResult, frontmatter: AnalysisFrontmatter): CheckFailure[] {
        return checkAnalysisResult(result, frontmatter);
    }
}
