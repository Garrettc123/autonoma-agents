import { summarizeSessionCost } from "@autonoma/diffs";
import type { ModelSession } from "@autonoma/diffs/analysis";
import {
    type BaseFrontmatter,
    type CheckFailure,
    Evaluation,
    type LoadedCase,
    type RunCaseHelpers,
} from "@autonoma/evals";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
import { DiffsJudge } from "./judge";

/** Where a concrete scored-replay eval plugs its identity and its budget into the shared orchestration. */
export interface ScoredReplayConfig {
    /** The vitest `describe`-block name, e.g. `"diffs-classifier"`. */
    name: string;
    /** Directory the JSON result file is written to (gitignored). */
    resultsDir: string;
    /** Per-case timeout, in ms. A case runs its agent once, so this is the whole-case budget. */
    timeoutMs: number;
}

/** One run's output: the graded result plus the step-specific fields written to the result file. */
export interface RunOutcome<TResult> {
    /** The structured output the deterministic checks and the judge grade. */
    result: TResult;
    /**
     * The step-specific fields written to the result file so a change is diffable across suite runs (the
     * classifier's verdict + transcript path, the Reporter's counts + retry tally). The base owns `agentCost`,
     * `deterministicFailures` and the `judge*` keys, so `info` must not reuse those names.
     */
    info: Record<string, unknown>;
}

/**
 * The shared spine of the diffs-pipeline scored-replay evals (analysis, classifier, reporter).
 *
 * Every one of them rehydrates a frozen case, runs a real agent over it once, gates that run on deterministic
 * checks, and - only if they pass - grades the output against an LLM judge. That orchestration is identical; only
 * three things genuinely vary per step, and they are the abstract methods:
 *
 * - {@link setUp} - rebuild the live context a run needs from the frozen case (check out the codebase, probe the
 *   S3 evidence, assemble the agent input). A stale case skips from here.
 * - {@link runOnce} - run the agent once over that context and return its result plus the result-file projection.
 * - {@link check} - the deterministic frontmatter checks over the result.
 *
 * A case passes when its run satisfies the deterministic checks AND the judge passes. Cases whose codebase or
 * media can no longer be fetched are skipped, not failed (the skip is thrown from `setUp` via the framework's skip
 * guards). Stability is measured by running the whole suite more than once and diffing the result files, not by
 * re-running one case in a serial loop. Cases run concurrently: each rehydrates into its own git worktree off the
 * shared repo clone.
 */
export abstract class ScoredReplayEvaluation<
    TInput,
    TFrontmatter extends BaseFrontmatter,
    TContext,
    TResult,
> extends Evaluation<LoadedCase<TInput, TFrontmatter>> {
    private readonly judge = new DiffsJudge();
    protected readonly logger: Logger = rootLogger.child({ name: this.constructor.name });

    protected constructor(config: ScoredReplayConfig, cases: LoadedCase<TInput, TFrontmatter>[]) {
        super(
            {
                name: config.name,
                parallel: true,
                testOptions: { timeout: config.timeoutMs },
                resultsDir: config.resultsDir,
            },
            cases,
        );
    }

    protected override caseName(testCase: LoadedCase<TInput, TFrontmatter>): string {
        const note = testCase.frontmatter.description;
        return note != null ? `${testCase.name} - ${note}` : testCase.name;
    }

    protected override async runCase(
        testCase: LoadedCase<TInput, TFrontmatter>,
        addInfo: (info: Record<string, unknown>) => void,
        helpers: RunCaseHelpers,
    ): Promise<void> {
        if (testCase.frontmatter.skip === true) {
            helpers.skip("case marked skip: true in expected.md frontmatter");
        }

        const context = await this.setUp(testCase, helpers);

        // Imported here rather than at module scope: `services` pulls the worker's env, which demands the GitHub
        // App and OpenAI credentials at import time and would break the credential-free zero-case no-op.
        const { createModelSession } = await import("../../src/services");
        const session = createModelSession();

        this.logger.info("Running scored-replay eval case", { extra: { case: testCase.name } });
        const { result, info } = await this.runOnce(session, testCase, context);

        // The full output, not just a pass flag: diffing two result files is how a change is shown to have moved a
        // step. `agentCost` is owned here; the step-specific fields come from `runOnce`.
        addInfo({ ...info, agentCost: summarizeSessionCost(session.costCollector) });

        // Deterministic checks gate the (paid) judge call: a case that already fails a check cannot pass, so there
        // is nothing to judge.
        const failures = this.check(result, testCase.frontmatter);
        if (failures.length > 0) {
            const detail = failures.map((f) => `${f.check}: ${f.message}`).join("; ");
            addInfo({ deterministicFailures: detail });
            expect.fail(`Deterministic checks failed: ${detail}`);
        }

        // One judge call. The rubric grades quality, which the deterministic checks have gated.
        const judgeVerdict = await this.judge.judge({ output: result, rubric: testCase.rubric });
        addInfo({
            judgePassed: judgeVerdict.passed,
            judgeReasoning: judgeVerdict.reasoning,
            judgeCost: judgeVerdict.cost,
        });

        expect(judgeVerdict.passed, `Judge failed: ${judgeVerdict.reasoning}`).toBe(true);
    }

    /**
     * Rebuild everything one run needs from the frozen case: check out the codebase, probe the referenced S3
     * evidence, and assemble the live agent input. Skip the case from here (via the framework's `rehydrateOrSkip`
     * / `skipIfEvidenceUnreachable`) when a frozen input has rotted.
     */
    protected abstract setUp(testCase: LoadedCase<TInput, TFrontmatter>, helpers: RunCaseHelpers): Promise<TContext>;

    /**
     * Run the agent once over the set-up context. Returns the graded result plus the step-specific fields written
     * to the result file (see {@link RunOutcome}); any side artifact a field needs - the classifier's on-disk
     * transcript, a conversation-derived metric - is produced here, where the session and transcript are in hand.
     */
    protected abstract runOnce(
        session: ModelSession,
        testCase: LoadedCase<TInput, TFrontmatter>,
        context: TContext,
    ): Promise<RunOutcome<TResult>>;

    /** The deterministic frontmatter checks over the result. An empty list means the checks passed. */
    protected abstract check(result: TResult, frontmatter: TFrontmatter): CheckFailure[];
}
