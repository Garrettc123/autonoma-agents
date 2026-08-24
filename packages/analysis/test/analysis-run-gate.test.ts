import { expect } from "vitest";
import { AnalysisRunGate } from "../src/analysis-run-gate";
import { type AnalysisHarness, analysisSuite, type SeededAnalysis } from "./harness";

async function activateSnapshotAt(harness: AnalysisHarness, run: SeededAnalysis, headSha: string): Promise<string> {
    const snapshotId = await harness.addSnapshotWithStatus(run.branchId, "active");
    await harness.db.branchSnapshot.update({ where: { id: snapshotId }, data: { headSha } });
    await harness.setActiveSnapshot(run.branchId, snapshotId);
    return snapshotId;
}

async function enqueueCommits(harness: AnalysisHarness, run: SeededAnalysis, headSha: string): Promise<void> {
    await harness.eventStore.enqueue({
        branchId: run.branchId,
        organizationId: run.organizationId,
        source: "webhook",
        event: { type: "commits_pushed", payload: { headSha } },
    });
}

analysisSuite({
    name: "AnalysisRunGate",
    cases: (test) => {
        test("skips a same-head trigger when the inbox is empty", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await activateSnapshotAt(harness, run, "sha-analyzed");

            const gate = await new AnalysisRunGate(harness.db).shouldSkipAlreadyAnalyzed({
                branchId: run.branchId,
                headSha: "sha-analyzed",
            });

            expect(gate.skip).toBe(true);
            expect(gate.resolved.alreadyAnalyzed).toBe(true);
        });

        test("a pending event un-suppresses the same-head skip", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await activateSnapshotAt(harness, run, "sha-analyzed");
            await enqueueCommits(harness, run, "sha-analyzed");

            const gate = await new AnalysisRunGate(harness.db).shouldSkipAlreadyAnalyzed({
                branchId: run.branchId,
                headSha: "sha-analyzed",
            });

            expect(gate.skip).toBe(false);
            // Still reported as already analyzed: the caller opens a base==head snapshot to answer the events.
            expect(gate.resolved.alreadyAnalyzed).toBe(true);
            expect(gate.resolved.baseSha).toBe("sha-analyzed");
        });

        test("a new head never skips", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await activateSnapshotAt(harness, run, "sha-analyzed");

            const gate = await new AnalysisRunGate(harness.db).shouldSkipAlreadyAnalyzed({
                branchId: run.branchId,
                headSha: "sha-new",
            });

            expect(gate.skip).toBe(false);
            expect(gate.resolved.alreadyAnalyzed).toBe(false);
            expect(gate.resolved.baseSha).toBe("sha-analyzed");
        });
    },
});
