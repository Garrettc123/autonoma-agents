import type { ModelMessage } from "@autonoma/ai";
import { StorageEvidenceLoader } from "@autonoma/diffs";
import { type ModelSession, type ReporterInput, ReporterAgent, type ReporterResult } from "@autonoma/diffs/analysis";
import { type CheckFailure, type LoadedCase, type RunCaseHelpers } from "@autonoma/evals";
import { S3Storage } from "@autonoma/storage";
import { expect } from "vitest";
import {
    type EvidenceKeys,
    type RunOutcome,
    ScoredReplayEvaluation,
    rehydrateOrSkip,
    skipIfEvidenceUnreachable,
} from "../framework";
import { type ReporterFrontmatter, checkReporterResult } from "./reporter-frontmatter";
import { type ReporterCaseInput, rehydrateReporterInput } from "./reporter-input";

/** A loaded Reporter eval case: frozen reporter input + authored expectations. */
export type ReporterCase = LoadedCase<ReporterCaseInput, ReporterFrontmatter>;

/**
 * Per-case timeout. A report is a tool loop over a real clone plus on-demand screenshot reads and finish-time
 * self-heal retries.
 */
const TIMEOUT_MS = 900_000;

/**
 * The finish-time `FixableToolError` prefixes worth counting: the coverage-guarantee rejection and the
 * empty-after-sanitizing rejection. Both are stable strings the result tool throws, so their occurrence in the
 * returned transcript is how many times the agent had to self-correct at `finish`. Counted, never gating - a
 * rising count across the corpus means the prompt is drifting into finishes the tool has to reject.
 */
const FIXABLE_RETRY_PREFIXES = ["Cannot finish yet.", "Nothing was left of"];

/** What one run of the Reporter case needs: the fully rehydrated live input over the checked-out clone. */
interface ReporterContext {
    input: ReporterInput;
}

/**
 * Scored eval for the analysis Reporter.
 *
 * Each case rehydrates the codebase from frozen coords, checks every screenshot key it references is still
 * downloadable, rebuilds the frozen input, and runs {@link ReporterAgent} directly - no workflow, no DB, no writes.
 * The reconciliation the run produces is graded by the deterministic checks; the report prose is graded by the
 * output-only LLM judge.
 *
 * Every tool the Reporter uses in production is served identically in replay: `bash` over the real clone,
 * `fetch_evidence` from S3 by the frozen keys, and `read_scenario` as a pure lookup over the frozen recipes. The
 * Reporter has no live-infra tool (no preview backend, no log stream), so - unlike the classifier - there is no
 * production-only capability to record, and a replay grades an agent that saw exactly what production's did.
 *
 * A case passes when its run satisfies the deterministic checks AND the judge passes. Cases whose codebase or
 * media can no longer be fetched are skipped, not failed.
 *
 * Cases run concurrently: each rehydrates into its own git worktree off the shared repo clone.
 */
export class ReporterEvaluation extends ScoredReplayEvaluation<
    ReporterCaseInput,
    ReporterFrontmatter,
    ReporterContext,
    ReporterResult
> {
    constructor(resultsDir: string, cases: ReporterCase[]) {
        super({ name: "diffs-reporter", resultsDir, timeoutMs: TIMEOUT_MS }, cases);
    }

    protected override testCaseInfo(testCase: ReporterCase): Record<string, string> {
        return {
            case: testCase.name,
            repo: `${testCase.input.codebase.owner}/${testCase.input.codebase.repo}`,
            headSha: testCase.input.codebase.headSha,
            baseSha: testCase.input.codebase.baseSha,
            runKind: testCase.input.target.kind,
            findings: String(testCase.input.findings.length),
            branchTests: String(testCase.input.branchTests.length),
            existingIssues: String(testCase.input.existingIssues.length),
        };
    }

    protected override async setUp(testCase: ReporterCase, helpers: RunCaseHelpers): Promise<ReporterContext> {
        const evidenceLoader = new StorageEvidenceLoader(S3Storage.createFromEnv());
        const skipContext = { logger: this.logger, caseName: testCase.name };

        // The clone and the S3 probe are independent - the probe reads only the frozen case, not the checkout - so
        // overlap the git-clone latency with the HEAD probes rather than paying them back to back.
        const [codebase] = await Promise.all([
            rehydrateOrSkip(testCase.input.codebase, helpers, skipContext),
            skipIfEvidenceUnreachable(collectScreenshotKeys(testCase.input), evidenceLoader, helpers, skipContext),
        ]);

        // The same loader the probe just walked the keys with becomes the run's `fetch_evidence` source.
        const input = rehydrateReporterInput(testCase.input, codebase, evidenceLoader);
        return { input };
    }

    protected override async runOnce(
        session: ModelSession,
        _testCase: ReporterCase,
        context: ReporterContext,
    ): Promise<RunOutcome<ReporterResult>> {
        const agent = new ReporterAgent({ model: session.getModel({ model: "reporter", tag: "reporter-eval" }) });
        const { result, conversation } = await this.report(agent, context.input);

        // The swept/duplicate/unknown counts and the finish-time retry count are the quality signals the
        // deterministic checks deliberately do not gate on (bar `unknownSlugs`, which does).
        return {
            result,
            info: {
                title: result.title,
                headline: result.headline,
                issueReconciliation: describeIssues(result),
                flowCount: result.flows.length,
                sweptSlugCount: result.flowCorrections.sweptSlugs.length,
                duplicateSlugCount: result.flowCorrections.duplicateSlugs.length,
                unknownSlugCount: result.flowCorrections.unknownSlugs.length,
                fixableRetries: countFixableRetries(conversation),
            },
        };
    }

    protected override check(result: ReporterResult, frontmatter: ReporterFrontmatter): CheckFailure[] {
        return checkReporterResult(result, frontmatter);
    }

    /**
     * Run one report. A Reporter that exhausts its steps or loses a tool fatally throws instead of returning a
     * result - in production the workflow fails the run over it, but for an eval it is simply a case that produced
     * nothing to grade.
     */
    private async report(
        agent: ReporterAgent,
        input: Parameters<ReporterAgent["run"]>[0],
    ): Promise<Awaited<ReturnType<ReporterAgent["run"]>>> {
        try {
            return await agent.run(input);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn("Reporter produced no result", { extra: { err: message } });
            expect.fail(`Reporter did not commit to a report: ${message}`);
        }
    }
}

/**
 * The distinct screenshot keys a case's findings reference, for the pre-flight reachability probe. A dead key would
 * otherwise surface mid-run as a `fetch_evidence` error the Reporter would reason about as if it were evidence
 * about the app.
 */
function collectScreenshotKeys(input: ReporterCaseInput): EvidenceKeys {
    const screenshots = new Set<string>();
    for (const finding of input.findings) {
        for (const asset of finding.screenshots) screenshots.add(asset.s3Key);
    }
    return { screenshots: [...screenshots] };
}

/** A compact, per-run account of how the run reconciled its findings, for the result file's diff. */
function describeIssues(result: ReporterResult): { opened: string[]; carried: string[]; resolved: string[] } {
    const opened: string[] = [];
    const carried: string[] = [];
    const resolved: string[] = [];
    for (const issue of result.issues) {
        if (issue.kind === "open") opened.push(issue.content.title);
        else if (issue.kind === "carry_forward") carried.push(issue.existingIssueId);
        else resolved.push(issue.existingIssueId);
    }
    return { opened, carried, resolved };
}

/**
 * How many times the run's finish was rejected and re-attempted, read off the returned transcript by the stable
 * prefixes the result tool throws (see {@link FIXABLE_RETRY_PREFIXES}). Grep the whole serialized conversation
 * rather than walk the message tree: the prefixes are unique enough that a substring count is exact, and it does
 * not couple this metric to the transcript's message shape.
 */
function countFixableRetries(conversation: ModelMessage[]): number {
    const transcript = JSON.stringify(conversation);
    return FIXABLE_RETRY_PREFIXES.reduce((total, prefix) => total + countOccurrences(transcript, prefix), 0);
}

function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
}
