import type { Prisma, PullRequestCacheState, SnapshotStatus } from "@autonoma/db";
import type { AnalysisEventSource } from "@autonoma/types";
import { expect } from "vitest";
import { type AnalysisHarness, analysisSuite, type SeededAnalysis } from "./harness";

/** A second branch on the run's app, carrying a PR in the given lifecycle state. */
async function createPrBranch(
    harness: AnalysisHarness,
    run: SeededAnalysis,
    prNumber: number,
    prState?: PullRequestCacheState,
): Promise<string> {
    const branch = await harness.db.branch.create({
        data: {
            name: `feature/${prNumber}`,
            applicationId: run.applicationId,
            organizationId: run.organizationId,
            prInfo: { create: { applicationId: run.applicationId, prNumber, prState } },
        },
        select: { id: true },
    });
    return branch.id;
}

async function enqueueCommits(
    harness: AnalysisHarness,
    run: SeededAnalysis,
    headSha: string,
    options?: { baseSha?: string; source?: AnalysisEventSource },
): Promise<string> {
    const { id } = await harness.eventStore.enqueue({
        branchId: run.branchId,
        organizationId: run.organizationId,
        source: options?.source ?? "webhook",
        event: { type: "commits_pushed", payload: { headSha, baseSha: options?.baseSha } },
    });
    return id;
}

/** Force a row's `createdAt` so ordering assertions are not at the mercy of same-millisecond inserts. */
async function stampCreatedAt(harness: AnalysisHarness, id: string, createdAt: Date): Promise<void> {
    await harness.db.analysisEvent.update({ where: { id }, data: { createdAt } });
}

function claim(harness: AnalysisHarness, branchId: string, snapshotId: string): Promise<number> {
    return harness.db.$transaction((tx: Prisma.TransactionClient) =>
        harness.eventStore.claimPending(tx, branchId, snapshotId),
    );
}

async function claimedBy(harness: AnalysisHarness, id: string): Promise<string | undefined> {
    const row = await harness.db.analysisEvent.findUniqueOrThrow({
        where: { id },
        select: { claimedBySnapshotId: true },
    });
    return row.claimedBySnapshotId ?? undefined;
}

const RECLAIMABLE_STATUSES: SnapshotStatus[] = ["superseded", "cancelled", "failed"];
const LIVE_STATUSES: SnapshotStatus[] = ["processing", "active"];

analysisSuite({
    name: "AnalysisEventStore",
    cases: (test) => {
        test("enqueue persists a typed payload that a claim reads back, oldest-first", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const older = await enqueueCommits(harness, run, "sha-older", { baseSha: "base-1", source: "comment" });
            const newer = await enqueueCommits(harness, run, "sha-newer");
            await stampCreatedAt(harness, older, new Date("2026-01-01T00:00:00Z"));
            await stampCreatedAt(harness, newer, new Date("2026-01-02T00:00:00Z"));

            expect(await harness.eventStore.hasPending(run.branchId)).toBe(true);

            const snapshotId = await harness.addSnapshotWithStatus(run.branchId, "processing");
            await claim(harness, run.branchId, snapshotId);

            const listed = await harness.eventStore.listForSnapshot(snapshotId);
            expect(listed.map((event) => event.id)).toEqual([older, newer]);

            const latest = listed[1];
            expect(latest?.type).toBe("commits_pushed");
            // Narrowing on `type` exposes the payload's shape.
            if (latest?.type !== "commits_pushed") throw new Error("expected a commits_pushed event");
            expect(latest.payload.headSha).toBe("sha-newer");
            expect(latest.source).toBe("webhook");
        });

        test("enqueue rejects a payload that does not match its type", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            await expect(
                harness.eventStore.enqueue({
                    branchId: run.branchId,
                    organizationId: run.organizationId,
                    source: "webhook",
                    // headSha is required for commits_pushed; the boundary parse must reject this.
                    event: { type: "commits_pushed", payload: JSON.parse('{"baseSha":"b"}') },
                }),
            ).rejects.toThrow();
            expect(await harness.eventStore.hasPending(run.branchId)).toBe(false);
        });

        test("claimPending stamps every pending event for the opening snapshot in one transaction", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const ids = [
                await enqueueCommits(harness, run, "sha-a"),
                await enqueueCommits(harness, run, "sha-b"),
                await enqueueCommits(harness, run, "sha-c"),
            ];
            const snapshotId = await harness.addSnapshotWithStatus(run.branchId, "processing");

            expect(await claim(harness, run.branchId, snapshotId)).toBe(3);
            expect(await harness.eventStore.hasPending(run.branchId)).toBe(false);

            const listed = await harness.eventStore.listForSnapshot(snapshotId);
            expect(listed.map((event) => event.id).sort()).toEqual([...ids].sort());
        });

        test("claimPending ignores events on other branches", async ({ harness }) => {
            const run = await harness.seedAnalysis();
            const other = await harness.seedAnalysis();
            await enqueueCommits(harness, run, "sha-mine");
            await enqueueCommits(harness, other, "sha-theirs");
            const snapshotId = await harness.addSnapshotWithStatus(run.branchId, "processing");

            expect(await claim(harness, run.branchId, snapshotId)).toBe(1);
            expect(await harness.eventStore.hasPending(other.branchId)).toBe(true);
        });

        for (const status of RECLAIMABLE_STATUSES) {
            test(`a claim by a ${status} snapshot is stolen by a successor`, async ({ harness }) => {
                const run = await harness.seedAnalysis();
                const eventId = await enqueueCommits(harness, run, "sha-a");
                const deadSnapshot = await harness.addSnapshotWithStatus(run.branchId, status);
                await claim(harness, run.branchId, deadSnapshot);
                expect(await claimedBy(harness, eventId)).toBe(deadSnapshot);

                // The event is pending again purely because the snapshot's status changed - no row on the event moved.
                expect(await harness.eventStore.hasPending(run.branchId)).toBe(true);

                const successor = await harness.addSnapshotWithStatus(run.branchId, "processing");
                expect(await claim(harness, run.branchId, successor)).toBe(1);
                expect(await claimedBy(harness, eventId)).toBe(successor);
                expect(await harness.eventStore.listForSnapshot(deadSnapshot)).toHaveLength(0);
            });
        }

        for (const status of LIVE_STATUSES) {
            test(`a claim by a ${status} snapshot is not stolen`, async ({ harness }) => {
                const run = await harness.seedAnalysis();
                const eventId = await enqueueCommits(harness, run, "sha-a");
                const liveSnapshot = await harness.addSnapshotWithStatus(run.branchId, status);
                await claim(harness, run.branchId, liveSnapshot);

                expect(await harness.eventStore.hasPending(run.branchId)).toBe(false);
                const successor = await harness.addSnapshotWithStatus(run.branchId, "processing");
                expect(await claim(harness, run.branchId, successor)).toBe(0);
                expect(await claimedBy(harness, eventId)).toBe(liveSnapshot);
                expect(await harness.eventStore.listForSnapshot(successor)).toHaveLength(0);
            });
        }

        // A pending event on a terminally closed PR must not read as a standing reason to run, or it would hold
        // the already-analyzed skip open forever on a branch that can never run again.
        test("hasPending ignores events on a closed PR but sees open, cold-cache and PR-less ones", async ({
            harness,
        }) => {
            const run = await harness.seedAnalysis();
            const openBranch = await createPrBranch(harness, run, 9, "open");
            const closedBranch = await createPrBranch(harness, run, 10, "closed");
            // A just-pushed PR whose cache has not been filled yet: NULL prState must fail open, and SQL's
            // NULL-hostile `NOT IN` makes that easy to regress.
            const coldCacheBranch = await createPrBranch(harness, run, 11);

            await enqueueCommits(harness, run, "sha-main");
            await enqueueCommits(harness, { ...run, branchId: openBranch }, "sha-open");
            await enqueueCommits(harness, { ...run, branchId: closedBranch }, "sha-closed");
            await enqueueCommits(harness, { ...run, branchId: coldCacheBranch }, "sha-cold");

            expect(await harness.eventStore.hasPending(run.branchId)).toBe(true);
            expect(await harness.eventStore.hasPending(openBranch)).toBe(true);
            expect(await harness.eventStore.hasPending(coldCacheBranch)).toBe(true);
            expect(await harness.eventStore.hasPending(closedBranch)).toBe(false);
        });
    },
});
