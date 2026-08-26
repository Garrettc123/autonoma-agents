import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    ANALYSIS_VERDICT,
    type AnalysisFlow,
    type AnalysisIssueKind,
    type AnalysisIssueStatus,
    type AnalysisTestRun,
    type AnalysisVerdictCounts,
    type AnalysisVerdictSummary,
    type RunPlaneSummary,
    analysisIssueKindSchema,
    analysisIssueStatusSchema,
} from "@autonoma/types";
import { readPlaneSummary } from "./queries/finding-coverage";
import { readBranchTestRuns } from "./queries/read-branch-test-runs";
import { type Issue, issueStatusFilter, readIssues } from "./queries/read-issues";
import { type AnalysisLifecycle, lifecycleSelect, toLifecycle } from "./queries/read-lifecycle";
import { type SettledReport, readLatestSettledReport } from "./queries/read-report";
import { derivePrVerdict } from "./verdict";

/**
 * How many prior branch reports the Reporter carries as cumulative context. Exported so every consumer of the
 * branch's report history (the Reporter itself, and the Impact Analysis selector) reuses the one bound instead of
 * inventing its own.
 */
export const PRIOR_REPORTS_LIMIT = 3;

/**
 * Cap on how many `invalid_test`-removed tests the selector is shown. A branch rarely removes many, but the slice
 * is bounded by construction so a pathological branch cannot flood the prompt.
 */
const REMOVED_INVALID_TESTS_LIMIT = 25;

export interface IssueFilter {
    status?: AnalysisIssueStatus;
    kind?: AnalysisIssueKind;
}

export interface CoveredIssue {
    issueId: string;
    title: string;
    coveredTests: { testCaseId: string; slug: string }[];
}

export interface PriorReport {
    snapshotId: string;
    reportMarkdown: string;
}

/**
 * A test a prior analysis run removed from the branch because the Investigator judged it `invalid_test` - its
 * target feature/flow does not exist, so it can never pass. The `TestCase` survives the removal (only the
 * snapshot's assignment is dropped), so its slug and name are read straight off it; the reason is the
 * Investigator's impossibility justification.
 */
export interface RemovedInvalidTest {
    testCaseId: string;
    slug: string;
    name: string;
    /** The Investigator's account of why the test is unexecutable; absent when neither note nor headline was set. */
    reason?: string;
}

/**
 * The read side of the branch's issue ledger. Accepts a transaction client so a settlement can read it inside
 * the transaction that writes it; every method is a plain read.
 *
 * Obtained via `AnalysisStore.forBranch` or `Analysis.branch`, never constructed directly.
 */
export class BranchLedger {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient | Prisma.TransactionClient,
        public readonly branchId: string,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * The branch's issues, in the canonical list order every surface renders (see {@link readIssues}). Unfiltered
     * it returns open AND resolved rows: the Reporter reconciles against both (a regression reopens a resolved
     * issue), and the PR page links resolved ones.
     */
    public async issues(filter?: IssueFilter): Promise<Issue[]> {
        const issues = await readIssues(this.db, {
            branchId: this.branchId,
            resolvedAt: filter?.status != null ? issueStatusFilter(filter.status) : undefined,
            // Kind is authored content, on the issue's current version.
            currentVersion: filter?.kind != null ? { kind: filter.kind } : undefined,
        });
        this.logger.info("Loaded branch issues", {
            branch: { branchId: this.branchId },
            extra: { count: issues.length, filter },
        });
        return issues;
    }

    public async openIssues(filter?: { kind?: AnalysisIssueKind }): Promise<Issue[]> {
        return this.issues({ status: analysisIssueStatusSchema.enum.open, kind: filter?.kind });
    }

    /** Counted by the kind enum's exact string, so a malformed row can never block a PR. */
    public async openBugCount(): Promise<number> {
        return this.db.analysisIssue.count({
            where: {
                branchId: this.branchId,
                resolvedAt: issueStatusFilter(analysisIssueStatusSchema.enum.open),
                currentVersion: { kind: analysisIssueKindSchema.enum.bug },
            },
        });
    }

    public async openIssueCount(): Promise<number> {
        return this.db.analysisIssue.count({
            where: {
                branchId: this.branchId,
                resolvedAt: issueStatusFilter(analysisIssueStatusSchema.enum.open),
            },
        });
    }

    /** Every open issue with its derived covered-test set - the re-verification input, all kinds. */
    public async coveredTestsForOpenIssues(): Promise<CoveredIssue[]> {
        const issues = await this.openIssues();
        return issues.map((issue) => {
            const byTestCaseId = new Map<string, { testCaseId: string; slug: string }>();
            for (const finding of issue.coveredFindings) {
                byTestCaseId.set(finding.testCaseId, { testCaseId: finding.testCaseId, slug: finding.slug });
            }
            return { issueId: issue.id, title: issue.title, coveredTests: [...byTestCaseId.values()] };
        });
    }

    /**
     * What this PR reads as - the one answer the GitHub comment, the merge-gate check, the PR page and MCP render.
     *
     * `bugCount` is the branch's live open bug issues, so the verdict is cumulative: a bug found two commits ago
     * and never fixed still counts. The coverage half is only the newest run's, so it describes the latest commit
     * rather than the whole PR.
     */
    public async verdict(): Promise<AnalysisVerdictSummary> {
        return (await this.readVerdictAndReport()).verdict;
    }

    /**
     * The verdict together with the flow itemization it was resolved from. The PR-page and main-branch headers
     * need both - the state and open-bug count from the verdict, the "X/Y features verified" ratio from the flows -
     * so this hands back the very report the verdict resolved against instead of the caller reading it a second
     * time. The flows are the branch's, accumulated across its commits; a report predating them yields `[]`, which
     * the pill renders as the verdict's own word.
     */
    public async verdictWithFlows(): Promise<{ verdict: AnalysisVerdictSummary; flows: AnalysisFlow[] }> {
        const { verdict, report } = await this.readVerdictAndReport();
        return { verdict, flows: report?.flows ?? [] };
    }

    /**
     * Every test run across the branch at its last-known verdict - the "Tests run" lens the PR overview reads, and
     * the count the verdict banner shows. Cumulative across the branch's commits, like {@link verdictWithFlows}'s
     * flows, not one run's findings. See {@link readBranchTestRuns}.
     */
    public async testRuns(): Promise<AnalysisTestRun[]> {
        const testRuns = await readBranchTestRuns(this.db, this.branchId);
        this.logger.info("Read branch test runs", {
            branch: { branchId: this.branchId },
            extra: { count: testRuns.length },
        });
        return testRuns;
    }

    /**
     * The one read behind {@link verdict} and {@link verdictWithFlows}: the open-bug count and the branch's latest
     * settled report (fetched together), resolved into a verdict, with that same report handed back so a caller
     * that also needs the report's flows does not read it again.
     */
    private async readVerdictAndReport(): Promise<{
        verdict: AnalysisVerdictSummary;
        report: SettledReport | undefined;
    }> {
        const [bugCount, report] = await Promise.all([this.openBugCount(), this.latestReport()]);
        return { verdict: await this.deriveVerdict(bugCount, report), report };
    }

    /**
     * The verdict AND the open bug issues behind it, read together. The two callers that need both - the merge-gate
     * check and the PR comment - would otherwise count the open bugs (inside {@link verdict}) and list them
     * separately, reading the same rows twice and risking a count/list disagreement under a concurrent settlement.
     * The issues arrive in the ledger's canonical order.
     *
     * `knownRunPlane` lets a caller that already computed a run's plane summary hand it in; it is reused only when
     * it is the very run the verdict resolves against (the branch's latest report), so the comment path does not
     * summarize the same snapshot's findings twice.
     */
    public async verdictWithOpenBugs(knownRunPlane?: {
        snapshotId: string;
        summary: RunPlaneSummary;
    }): Promise<{ verdict: AnalysisVerdictSummary; openBugs: Issue[] }> {
        const [openBugs, report] = await Promise.all([
            this.openIssues({ kind: analysisIssueKindSchema.enum.bug }),
            this.latestReport(),
        ]);
        const verdict = await this.deriveVerdict(openBugs.length, report, knownRunPlane);
        return { verdict, openBugs };
    }

    private async deriveVerdict(
        bugCount: number,
        report: SettledReport | undefined,
        knownRunPlane?: { snapshotId: string; summary: RunPlaneSummary },
    ): Promise<AnalysisVerdictSummary> {
        const latestRun = await this.resolveRunPlane(report, knownRunPlane);
        const counts: AnalysisVerdictCounts = {
            bugCount,
            coverageGapCount: latestRun?.coverage.total ?? 0,
            investigatedCount: latestRun?.testCount ?? 0,
        };
        // The flow itemization is the better reading when the Reporter authored one, because it spans the branch
        // rather than the newest run; the counts are the fallback for a report written before it.
        const state = derivePrVerdict({
            flows: report?.flows ?? [],
            openBugCount: counts.bugCount,
            investigatedCount: counts.investigatedCount,
            coverageGapCount: counts.coverageGapCount,
        });
        this.logger.info("Resolved branch verdict", {
            branch: { branchId: this.branchId },
            extra: { ...counts, state, flows: report?.flows.length ?? 0 },
        });
        return {
            state,
            bugCount: counts.bugCount,
            coverageGapCount: counts.coverageGapCount,
            investigatedCount: counts.investigatedCount,
        };
    }

    /** The plane summary of the report's run: the caller's if it is for that same run, else read fresh. */
    private async resolveRunPlane(
        report: SettledReport | undefined,
        known?: { snapshotId: string; summary: RunPlaneSummary },
    ): Promise<RunPlaneSummary | undefined> {
        if (report == null) return undefined;
        if (known?.snapshotId === report.snapshotId) return known.summary;
        return readPlaneSummary(this.db, report.snapshotId);
    }

    /** The branch's newest settled report by run open time, or undefined when no run on it ever settled. */
    public async latestReport(): Promise<SettledReport | undefined> {
        return readLatestSettledReport(this.db, this.branchId);
    }

    /**
     * The newest analysis lifecycle on the branch, which answers "is a run going, and how did the last one end"
     * even before any report exists.
     */
    public async latestLifecycle(): Promise<(AnalysisLifecycle & { snapshotCreatedAt: Date }) | undefined> {
        const job = await this.db.analysisJob.findFirst({
            where: { snapshot: { branchId: this.branchId } },
            orderBy: { snapshot: { createdAt: "desc" } },
            select: { ...lifecycleSelect, snapshot: { select: { createdAt: true } } },
        });
        if (job == null) return undefined;
        return { ...toLifecycle(job), snapshotCreatedAt: job.snapshot.createdAt };
    }

    /**
     * The branch's most recent report proses, excluding the given snapshot's own. Empty proses (rows predating
     * the Reporter authoring one) are excluded.
     */
    public async priorReports(input: { excludeSnapshotId: string; limit: number }): Promise<PriorReport[]> {
        const rows = await this.db.analysisReport.findMany({
            where: {
                snapshot: { branchId: this.branchId },
                reportMarkdown: { not: "" },
                NOT: { snapshotId: input.excludeSnapshotId },
            },
            orderBy: { createdAt: "desc" },
            take: input.limit,
            select: { snapshotId: true, reportMarkdown: true },
        });
        return rows.map((row) => ({ snapshotId: row.snapshotId, reportMarkdown: row.reportMarkdown }));
    }

    /**
     * The tests any snapshot of this branch removed as `invalid_test`, newest first and capped. A removed test is
     * gone from the current suite, so the selector cannot see it in `existingTests` and would author it again; this
     * is what lets the prompt show it as prior work already thrown away.
     *
     * Read off the finding's CURRENT classification (self-heal appends rows, so an older classification can hold a
     * stale category) and deduped by test case - a test is removed at most once, so the newest finding per test is
     * its removal.
     */
    public async removedInvalidTests(): Promise<RemovedInvalidTest[]> {
        const rows = await this.db.analysisFinding.findMany({
            where: {
                job: { snapshot: { branchId: this.branchId } },
                currentClassification: { category: ANALYSIS_VERDICT.invalid_test },
            },
            orderBy: { createdAt: "desc" },
            // Bound the read, not just the returned slice: findings are unique per (snapshot, test) and a removed
            // test does not recur, so 3x the cap leaves ample headroom for the newest-per-test dedup below to still
            // reach LIMIT distinct tests.
            take: REMOVED_INVALID_TESTS_LIMIT * 3,
            select: {
                testCaseId: true,
                testCase: { select: { slug: true, name: true } },
                currentClassification: { select: { invalidTestNote: true, headline: true } },
            },
        });
        const byTestCase = new Map<string, RemovedInvalidTest>();
        for (const row of rows) {
            if (byTestCase.has(row.testCaseId)) continue;
            byTestCase.set(row.testCaseId, {
                testCaseId: row.testCaseId,
                slug: row.testCase.slug,
                name: row.testCase.name,
                reason: row.currentClassification?.invalidTestNote ?? row.currentClassification?.headline ?? undefined,
            });
            if (byTestCase.size >= REMOVED_INVALID_TESTS_LIMIT) break;
        }
        const removed = [...byTestCase.values()];
        this.logger.info("Loaded removed invalid tests for branch", {
            branch: { branchId: this.branchId },
            extra: { count: removed.length },
        });
        return removed;
    }
}
