import { computePreviewUsageCost } from "@autonoma/billing";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

const RATES = { creditsPerVcpuHour: 10, creditsPerGbMemoryHour: 2 };
const SINCE = new Date("2026-01-01T00:00:00.000Z");
const UNTIL = new Date("2026-01-31T23:59:59.000Z");
const IN_WINDOW = new Date("2026-01-15T12:00:00.000Z");
const BEFORE_WINDOW = new Date("2025-12-01T00:00:00.000Z");
const BEFORE_WINDOW_END = new Date("2025-12-31T00:00:00.000Z");

/**
 * Deliberately spans the shapes the rounding turns on: a fractional cost that ceils up, a cost far
 * below one credit that still charges the one-credit minimum, an exact whole number that must NOT
 * ceil to the next credit, and a genuinely idle 0/0 row that is charged nothing at all.
 */
const USAGE_FIXTURES: ReadonlyArray<{ vcpuSeconds: number; gbSeconds: number }> = [
    { vcpuSeconds: 900, gbSeconds: 3600 }, // 2.5 + 2 = 4.5 -> 5
    { vcpuSeconds: 1, gbSeconds: 1 }, // ~0.0033 -> 1 (minimum charge)
    { vcpuSeconds: 3600, gbSeconds: 3600 }, // 10 + 2 = 12 exactly -> 12
    { vcpuSeconds: 0, gbSeconds: 0 }, // free, skipped entirely
    { vcpuSeconds: 7200, gbSeconds: 1800 }, // 20 + 1 = 21 -> 21
];

/**
 * What the real deduction would charge for one table's worth of these rows: `computePreviewUsageCost`
 * plus the same per-row `max(1, ceil(...))` `deductCreditsForPreviewUsage` applies. This is the whole
 * point of the suite - `creditsByOrg` reimplements both in SQL, and nothing but this pins them together.
 */
function expectedCredits(): number {
    return USAGE_FIXTURES.reduce((sum, usage) => {
        const rawCost = computePreviewUsageCost(usage.vcpuSeconds, usage.gbSeconds, RATES);
        if (!(rawCost > 0)) return sum;
        return sum + Math.max(1, Math.ceil(rawCost));
    }, 0);
}

function projectAtRates(harness: APITestHarness, since: Date, until: Date, rates = RATES) {
    return harness.services.usage.computeBillingProjection({
        creditsPerVcpuHour: rates.creditsPerVcpuHour,
        creditsPerGbMemoryHour: rates.creditsPerGbMemoryHour,
        since,
        until,
    });
}

apiTestSuite({
    name: "usage.computeBillingProjection",
    seed: async ({ harness }) => {
        await seedUsage(harness);
        return {};
    },
    cases: (test) => {
        test("prices each usage row the way the real deduction prices it", async ({ harness }) => {
            const projection = await projectAtRates(harness, SINCE, UNTIL);

            const row = projection.rows.find((candidate) => candidate.organizationId === harness.organizationId);
            // Both metered tables carry the same fixture set, so each side is one full per-row total.
            expect(row?.buildCredits).toBe(expectedCredits());
            expect(row?.runningCredits).toBe(expectedCredits());
            expect(row?.totalCredits).toBe(expectedCredits() * 2);
            expect(projection.totalCredits).toBe(expectedCredits() * 2);
        });

        test("excludes usage recorded outside the window", async ({ harness }) => {
            const projection = await projectAtRates(harness, BEFORE_WINDOW, BEFORE_WINDOW_END);

            const row = projection.rows.find((candidate) => candidate.organizationId === harness.organizationId);
            // The out-of-window fixture is a single 3600/3600 row in each table: 12 credits apiece.
            expect(row?.totalCredits).toBe(24);
        });

        test("charges nothing at a zero rate - the shadow-mode default", async ({ harness }) => {
            const projection = await projectAtRates(harness, SINCE, UNTIL, {
                creditsPerVcpuHour: 0,
                creditsPerGbMemoryHour: 0,
            });

            expect(projection.rows).toEqual([]);
            expect(projection.totalCredits).toBe(0);
        });

        test("flags an org the charge pushes past its floor", async ({ harness }) => {
            await harness.db.billingCustomer.update({
                where: { organizationId: harness.organizationId },
                data: { creditBalance: 10, creditFloor: 0 },
            });

            const projection = await projectAtRates(harness, SINCE, UNTIL);

            const row = projection.rows.find((candidate) => candidate.organizationId === harness.organizationId);
            expect(row?.goesUnderwater).toBe(true);
            expect(projection.organizationsUnderwater).toBe(1);
            // Unclamped by design, unlike the real deduction which stops at creditFloor.
            expect(row?.balanceAfter).toBe(10 - expectedCredits() * 2);
        });

        test("does not flag an org that was already at or below its floor", async ({ harness }) => {
            await harness.db.billingCustomer.update({
                where: { organizationId: harness.organizationId },
                data: { creditBalance: -5, creditFloor: -5 },
            });

            const projection = await projectAtRates(harness, SINCE, UNTIL);

            const row = projection.rows.find((candidate) => candidate.organizationId === harness.organizationId);
            expect(row?.totalCredits).toBeGreaterThan(0);
            expect(row?.goesUnderwater).toBe(false);
            expect(projection.organizationsUnderwater).toBe(0);
        });
    },
});

/** Writes the same fixture set into both metered tables, plus one row that falls outside the window. */
async function seedUsage(harness: APITestHarness): Promise<void> {
    const application = await harness.db.application.create({
        data: {
            name: "Compute Projection App",
            slug: "compute-projection-app",
            architecture: ApplicationArchitecture.WEB,
            organizationId: harness.organizationId,
        },
    });
    const webAppId = (await harness.seedTopology(application.id, ["web"])).get("web")!;

    const environment = await harness.db.previewkitEnvironment.create({
        data: {
            namespace: "preview-compute-projection",
            repoFullName: "Autonoma-AI/compute-projection",
            prNumber: 1,
            headSha: "projection-head",
            headRef: "feature/projection",
            organizationId: harness.organizationId,
            status: "ready",
        },
    });

    const build = await harness.db.previewkitBuild.create({
        data: { environmentId: environment.id, headSha: "projection-head", status: "ready" },
    });

    const seededRows = USAGE_FIXTURES.map((usage, index) => ({ index, usage, createdAt: IN_WINDOW }));
    seededRows.push({
        index: USAGE_FIXTURES.length,
        usage: { vcpuSeconds: 3600, gbSeconds: 3600 },
        createdAt: BEFORE_WINDOW,
    });

    for (const { index, usage, createdAt } of seededRows) {
        const appBuild = await harness.db.previewkitAppBuild.create({
            data: {
                buildId: build.id,
                appName: `web-${index}`,
                appId: webAppId,
                status: "success",
                durationMs: 1000,
            },
        });
        await harness.db.previewkitAppBuildUsage.create({
            data: {
                appBuildId: appBuild.id,
                organizationId: harness.organizationId,
                vcpuSeconds: usage.vcpuSeconds,
                gbSeconds: usage.gbSeconds,
                createdAt,
            },
        });
        await harness.db.previewkitUsageWindow.create({
            data: {
                environmentId: environment.id,
                organizationId: harness.organizationId,
                windowStart: new Date(createdAt.getTime() + index * 15 * 60 * 1000),
                windowEnd: new Date(createdAt.getTime() + (index + 1) * 15 * 60 * 1000),
                vcpuSeconds: usage.vcpuSeconds,
                gbSeconds: usage.gbSeconds,
                createdAt,
            },
        });
    }
}
