import { db } from "@autonoma/db";
import type { AppBuildRecord, BuildCircuitStore, CircuitStateRow, OpenCircuitWrite } from "./build-circuit-breaker";

/** Reads build history from `PreviewkitAppBuild` (across every PR of the repo) and persists circuit rows. */
export class PrismaBuildCircuitStore implements BuildCircuitStore {
    async recentAppBuilds(
        organizationId: string,
        repoFullName: string,
        appNames: string[],
        limitPerApp: number,
    ): Promise<Map<string, AppBuildRecord[]>> {
        // One bounded query PER app (app counts are small), so a high-volume app can't
        // starve a low-volume failing app out of a shared global `take`.
        const entries = await Promise.all(
            appNames.map(async (appName) => {
                const rows = await db.previewkitAppBuild.findMany({
                    where: {
                        appName,
                        // Superseded builds were cancelled, not judged - exclude them.
                        build: {
                            status: { not: "superseded" },
                            environment: { repoFullName, organizationId },
                        },
                    },
                    select: { status: true, build: { select: { finishedAt: true, startedAt: true } } },
                    orderBy: { build: { startedAt: "desc" } },
                    take: limitPerApp,
                });
                const records: AppBuildRecord[] = rows.map((row) => ({
                    status: row.status === "failed" ? "failed" : "success",
                    finishedAt: row.build.finishedAt ?? row.build.startedAt,
                }));
                return [appName, records] as const;
            }),
        );
        return new Map(entries);
    }

    async loadStates(
        organizationId: string,
        repoFullName: string,
        appNames: string[],
    ): Promise<Map<string, CircuitStateRow>> {
        const rows = await db.previewkitBuildCircuit.findMany({
            where: { organizationId, repoFullName, appName: { in: appNames } },
            select: {
                appName: true,
                openedAt: true,
                alertedAt: true,
                resetAt: true,
                consecutiveFailures: true,
                probedAt: true,
            },
        });

        const byApp = new Map<string, CircuitStateRow>();
        for (const row of rows) {
            const state: CircuitStateRow = { consecutiveFailures: row.consecutiveFailures };
            if (row.openedAt != null) state.openedAt = row.openedAt;
            if (row.alertedAt != null) state.alertedAt = row.alertedAt;
            if (row.resetAt != null) state.resetAt = row.resetAt;
            if (row.probedAt != null) state.probedAt = row.probedAt;
            byApp.set(row.appName, state);
        }
        return byApp;
    }

    async markOpen(
        organizationId: string,
        repoFullName: string,
        appName: string,
        write: OpenCircuitWrite,
    ): Promise<void> {
        await db.previewkitBuildCircuit.upsert({
            where: { organizationId_repoFullName_appName: { organizationId, repoFullName, appName } },
            create: {
                organizationId,
                repoFullName,
                appName,
                openedAt: write.openedAt,
                alertedAt: write.alertedAt,
                consecutiveFailures: write.consecutiveFailures,
            },
            update: {
                openedAt: write.openedAt,
                alertedAt: write.alertedAt,
                consecutiveFailures: write.consecutiveFailures,
            },
        });
    }

    async markProbe(organizationId: string, repoFullName: string, appName: string, probedAt: Date): Promise<void> {
        // Row already exists (markOpen ran first); touch only probedAt.
        await db.previewkitBuildCircuit.updateMany({
            where: { organizationId, repoFullName, appName },
            data: { probedAt },
        });
    }

    async markClosed(organizationId: string, repoFullName: string, appName: string): Promise<void> {
        // updateMany so a never-opened app (no row) is a no-op.
        await db.previewkitBuildCircuit.updateMany({
            where: { organizationId, repoFullName, appName },
            data: { openedAt: null, alertedAt: null, consecutiveFailures: 0, probedAt: null },
        });
    }
}

/** Operator escape hatch: records a reset boundary and closes the circuit, so the next push probes. */
export async function resetBuildCircuit(
    organizationId: string,
    repoFullName: string,
    appName: string,
    now: Date = new Date(),
): Promise<void> {
    await db.previewkitBuildCircuit.upsert({
        where: { organizationId_repoFullName_appName: { organizationId, repoFullName, appName } },
        create: { organizationId, repoFullName, appName, resetAt: now, consecutiveFailures: 0 },
        update: { resetAt: now, openedAt: null, alertedAt: null, consecutiveFailures: 0, probedAt: null },
    });
}
