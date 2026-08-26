import type { AnalysisFlow } from "@autonoma/types";
import { expect } from "vitest";
import { analysisSuite } from "./harness";

/** When a seeded issue was resolved; its presence IS the resolved status the ledger reads. */
const RESOLVED_AT = new Date("2026-07-01T00:00:00Z");

analysisSuite({
    name: "BranchLedger",
    cases: (test) => {
        test("openBugCount counts only unresolved bug-kind issues, by the kind enum's exact string", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const base = {
                branchId: run.branchId,
                organizationId: run.organizationId,
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
            };
            for (const issue of [
                { title: "Open bug", kind: "bug", severity: "high", resolvedAt: null },
                { title: "Resolved bug", kind: "bug", severity: "high", resolvedAt: RESOLVED_AT },
                { title: "Open env", kind: "environment", severity: "high", resolvedAt: null },
                { title: "Corrupt kind", kind: "BUG!", severity: "high", resolvedAt: null },
            ]) {
                await harness.seedIssue({ ...base, ...issue });
            }

            expect(await harness.store.forBranch(run.branchId).openBugCount()).toBe(1);
        });

        test("a malformed severity degrades to low instead of hiding the issue from its resolver", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Bug with corrupt severity",
                kind: "bug",
                severity: "URGENT",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
            });

            const ledger = harness.store.forBranch(run.branchId);
            const issues = await ledger.openIssues({ kind: "bug" });
            // The row counts toward the verdict, so the Reporter must see it - otherwise it can never resolve.
            expect(await ledger.openBugCount()).toBe(1);
            expect(issues).toHaveLength(1);
            expect(issues[0]?.severity).toBe("low");
        });

        test("coveredTestsForOpenIssues derives the covered set from attributed findings across snapshots", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const issue = await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Cross-snapshot bug",
                kind: "bug",
                severity: "high",
                actualBehavior: "misbehaves",
                narrativeMarkdown: "narrative",
            });
            const first = await harness.recordVerdict(run, "checkout", "client_bug");
            const laterSnapshotId = await harness.addSnapshot(run.branchId, run.organizationId);
            const second = await harness.recordVerdict(run, "checkout", "client_bug", {
                snapshotId: laterSnapshotId,
            });
            const other = await harness.recordVerdict(run, "search", "client_bug", { snapshotId: laterSnapshotId });
            await harness.db.analysisFinding.updateMany({
                where: { id: { in: [first.findingId, second.findingId, other.findingId] } },
                data: { issueId: issue.id },
            });

            const covered = await harness.store.forBranch(run.branchId).coveredTestsForOpenIssues();
            expect(covered).toHaveLength(1);
            const slugs = covered[0]?.coveredTests.map((test) => test.slug).sort();
            // `checkout` was attributed on two snapshots but covers once.
            expect(slugs).toEqual(["checkout", "search"]);
        });

        test("priorReports excludes the analysis's own report and empty proses", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const priorId = await harness.addSnapshot(run.branchId, run.organizationId);
            const emptyId = await harness.addSnapshot(run.branchId, run.organizationId);
            await harness.db.analysisReport.createMany({
                data: [
                    {
                        snapshotId: run.snapshotId,
                        organizationId: run.organizationId,
                        title: "The run",
                        headline: "own",
                        flows: [],
                        reportMarkdown: "## Own",
                    },
                    {
                        snapshotId: priorId,
                        organizationId: run.organizationId,
                        title: "The run",
                        headline: "prior",
                        flows: [],
                        reportMarkdown: "## Prior",
                    },
                    {
                        snapshotId: emptyId,
                        organizationId: run.organizationId,
                        title: "The run",
                        headline: "",
                        flows: [],
                        reportMarkdown: "",
                    },
                ],
            });

            const prior = await harness.store
                .forBranch(run.branchId)
                .priorReports({ excludeSnapshotId: run.snapshotId, limit: 3 });
            expect(prior).toEqual([{ snapshotId: priorId, reportMarkdown: "## Prior" }]);
        });

        test("removedInvalidTests returns only tests whose current verdict is invalid_test, by slug and name", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "gone-feature", "invalid_test");
            await harness.recordVerdict(run, "checkout", "client_bug");
            await harness.recordVerdict(run, "search", "passed");

            const removed = await harness.store.forBranch(run.branchId).removedInvalidTests();

            expect(removed.map((t) => t.slug)).toEqual(["gone-feature"]);
            expect(removed[0]?.name).toBe("gone-feature");
            // No note was recorded, so the reason falls back to the classification headline.
            expect(removed[0]?.reason).toBe("gone-feature invalid_test");
        });

        test("verdictWithFlows pairs the cumulative-bug verdict with the newest report's flows", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            // An open bug issue is the branch's cumulative signal - the verdict must read it, not the report's flows.
            await harness.seedIssue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                title: "Open bug",
                kind: "bug",
                severity: "high",
            });
            const flows: AnalysisFlow[] = [
                {
                    title: "Checkout",
                    detail: "The Place order button never enabled.",
                    status: "broken",
                    owner: "client",
                    passedCount: 0,
                    gapCount: 0,
                    bugCount: 1,
                    checkedThisRunCount: 1,
                    testSlugs: ["checkout"],
                },
                {
                    title: "Search",
                    detail: "Results rendered end to end.",
                    status: "verified",
                    owner: "none",
                    passedCount: 1,
                    gapCount: 0,
                    bugCount: 0,
                    checkedThisRunCount: 1,
                    testSlugs: ["search"],
                },
            ];
            await harness.db.analysisReport.create({
                data: {
                    snapshotId: run.snapshotId,
                    organizationId: run.organizationId,
                    title: "The run",
                    headline: "cumulative",
                    flows,
                    reportMarkdown: "## Report",
                },
            });

            const { verdict, flows: read } = await harness.store.forBranch(run.branchId).verdictWithFlows();
            expect(verdict.state).toBe("bug_found");
            expect(verdict.bugCount).toBe(1);
            expect(read.map((f) => f.title)).toEqual(["Checkout", "Search"]);
        });

        test("testRuns returns the newest verdict per test across snapshots, one row per test, unjudged excluded", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            // checkout ran and passed on the first snapshot...
            await harness.recordVerdict(run, "checkout", "passed");
            // ...then a later commit re-ran it and found a bug: that newer verdict is the one that shows, linking to
            // the run that reached it.
            const later = await harness.addSnapshot(run.branchId, run.organizationId);
            const rerun = await harness.recordVerdict(run, "checkout", "client_bug", { snapshotId: later });
            await harness.recordVerdict(run, "search", "passed", { snapshotId: later });
            // A selected-but-unjudged test (no verdict) must not appear - it was never run to a conclusion.
            await harness.selectTests(run, ["never-ran"]);

            const testRuns = await harness.store.forBranch(run.branchId).testRuns();

            expect(testRuns.map((testRun) => testRun.testCase.slug)).toEqual(["checkout", "search"]);
            const checkout = testRuns.find((testRun) => testRun.testCase.slug === "checkout");
            expect(checkout?.category).toBe("client_bug");
            // The row is the newer finding - the one the rerun recorded, which its test-result page link keys on.
            expect(checkout?.id).toBe(rerun.findingId);
        });

        test("testRuns is scoped to its branch", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await harness.recordVerdict(run, "checkout", "passed");
            // A different branch's run must not leak into this branch's list.
            const other = await harness.seedAnalysis();
            await harness.recordVerdict(other, "other-checkout", "client_bug");

            const testRuns = await harness.store.forBranch(run.branchId).testRuns();
            expect(testRuns.map((testRun) => testRun.testCase.slug)).toEqual(["checkout"]);
        });
    },
});
