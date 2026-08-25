import type { Prisma } from "@autonoma/db";
import { expect } from "vitest";
import { AnalysisEventResolver } from "../src/analysis-event-resolver";
import { type AnalysisHarness, analysisSuite, type SeededAnalysis } from "./harness";

async function enqueueCommitsAt(
    harness: AnalysisHarness,
    run: SeededAnalysis,
    headSha: string,
    createdAt: Date,
    options?: { baseSha?: string },
): Promise<void> {
    const { id } = await harness.eventStore.enqueue({
        branchId: run.branchId,
        organizationId: run.organizationId,
        source: "webhook",
        event: { type: "commits_pushed", payload: { headSha, baseSha: options?.baseSha } },
    });
    await harness.db.analysisEvent.update({ where: { id }, data: { createdAt } });
}

function claim(harness: AnalysisHarness, branchId: string, snapshotId: string): Promise<number> {
    return harness.db.$transaction((tx: Prisma.TransactionClient) =>
        harness.eventStore.claimPending(tx, branchId, snapshotId),
    );
}

analysisSuite({
    name: "AnalysisEventResolver",
    cases: (test) => {
        test("resolves a snapshot's claimed events to their recorded facts, oldest first", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const resolver = new AnalysisEventResolver(harness.eventStore);
            await enqueueCommitsAt(harness, run, "sha-newer", new Date("2026-01-02T00:00:00Z"));
            await enqueueCommitsAt(harness, run, "sha-older", new Date("2026-01-01T00:00:00Z"), {
                baseSha: "base-1",
            });

            const snapshotId = await harness.addSnapshotWithStatus(run.branchId, "processing");
            await claim(harness, run.branchId, snapshotId);

            // toEqual (not toMatchObject) also asserts the inbox bookkeeping (id, claim) is absent.
            expect(await resolver.resolveForSnapshot(snapshotId)).toEqual([
                {
                    type: "commits_pushed",
                    payload: { headSha: "sha-older", baseSha: "base-1" },
                    source: "webhook",
                    createdAt: new Date("2026-01-01T00:00:00Z"),
                },
                {
                    type: "commits_pushed",
                    payload: { headSha: "sha-newer" },
                    source: "webhook",
                    createdAt: new Date("2026-01-02T00:00:00Z"),
                },
            ]);
        });

        test("resolves to an empty list for a snapshot that claimed nothing", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const resolver = new AnalysisEventResolver(harness.eventStore);
            await enqueueCommitsAt(harness, run, "sha-pending", new Date("2026-01-01T00:00:00Z"));

            expect(await resolver.resolveForSnapshot(run.snapshotId)).toEqual([]);
        });

        test("resolves a claimed user_prompt event to its recorded instruction", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const resolver = new AnalysisEventResolver(harness.eventStore);
            const { id } = await harness.eventStore.enqueue({
                branchId: run.branchId,
                organizationId: run.organizationId,
                source: "mcp",
                event: { type: "user_prompt", payload: { text: "Re-check the checkout flow.", author: "agent" } },
            });
            await harness.db.analysisEvent.update({
                where: { id },
                data: { createdAt: new Date("2026-01-03T00:00:00Z") },
            });

            const snapshotId = await harness.addSnapshotWithStatus(run.branchId, "processing");
            await claim(harness, run.branchId, snapshotId);

            expect(await resolver.resolveForSnapshot(snapshotId)).toEqual([
                {
                    type: "user_prompt",
                    payload: { text: "Re-check the checkout flow.", author: "agent" },
                    source: "mcp",
                    createdAt: new Date("2026-01-03T00:00:00Z"),
                },
            ]);
        });
    },
});
