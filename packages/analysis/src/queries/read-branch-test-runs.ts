import type { Prisma, PrismaClient } from "@autonoma/db";
import type { AnalysisTestRun } from "@autonoma/types";

const branchTestRunSelect = {
    id: true,
    testCaseId: true,
    testCase: { select: { name: true, slug: true } },
    currentClassification: { select: { generationId: true, category: true } },
} satisfies Prisma.AnalysisFindingSelect;

/**
 * Every test run across a branch, one row per test at its last-known verdict: the newest finding per test case,
 * across every snapshot, that reached a terminal verdict. Cumulative, matching how the flows and the branch verdict
 * read - a test carried unchanged from an earlier commit still appears, at the verdict that commit gave it, linking
 * to that run's generation.
 *
 * `currentClassificationId` filters out contained-only investigations (a crash that never judged a run), exactly as
 * the per-run findings view drops them. Read newest-finding-first (the same newest-per-test dedup
 * `removedInvalidTests` uses) so the first row seen per test is its latest run, then returned slug-ordered for a
 * stable within-tier order downstream.
 */
export async function readBranchTestRuns(
    db: PrismaClient | Prisma.TransactionClient,
    branchId: string,
): Promise<AnalysisTestRun[]> {
    const rows = await db.analysisFinding.findMany({
        where: { job: { snapshot: { branchId } }, currentClassificationId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: branchTestRunSelect,
    });
    const byTestCase = new Map<string, AnalysisTestRun>();
    for (const row of rows) {
        // The `not: null` filter guarantees the join, but Prisma still types it optional; skip defensively.
        if (row.currentClassification == null || byTestCase.has(row.testCaseId)) continue;
        byTestCase.set(row.testCaseId, {
            id: row.id,
            generationId: row.currentClassification.generationId,
            testCase: { name: row.testCase.name, slug: row.testCase.slug },
            category: row.currentClassification.category,
        });
    }
    return [...byTestCase.values()].sort((a, b) => a.testCase.slug.localeCompare(b.testCase.slug));
}
