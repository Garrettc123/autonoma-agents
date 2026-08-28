import { computePreviewUsageCostUsd, creditsPerUsd } from "@autonoma/billing";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

// USD per hour, the unit prices are stored and projected in. $0.01 and $0.002 land on exactly 15
// and 3 credits per hour at the sell rate seeded below, keeping the fixtures readable.
const RATES = { usdPerVcpuHour: 0.01, usdPerGbHour: 0.002 };
// The org's own sell rate, seeded explicitly rather than relying on the column defaults, because
// the projection converts USD to credits through it per org.
const CREDITS_PER_TOPUP = 150_000;
const STRIPE_TOPUP_AMOUNT_CENTS = 10_000;
const SINCE = new Date("2026-01-01T00:00:00.000Z");
const UNTIL = new Date("2026-01-31T23:59:59.000Z");
const IN_WINDOW = new Date("2026-01-15T12:00:00.000Z");
const BEFORE_WINDOW = new Date("2025-12-01T00:00:00.000Z");
const BEFORE_WINDOW_END = new Date("2025-12-31T00:00:00.000Z");

/**
 * Deliberately spans the shapes the arithmetic turns on: a fractional cost, a cost far below one
 * credit that must NOT be rounded up to one (the old behaviour, which overcharged), an exact whole
 * number, a genuinely idle 0/0 row charged nothing, and a large multi-credit row.
 */
const USAGE_FIXTURES: ReadonlyArray<{ vcpuSeconds: number; gbSeconds: number }> = [
    { vcpuSeconds: 900, gbSeconds: 3600 }, // 3.75 + 3   = 6.75 credits
    { vcpuSeconds: 1, gbSeconds: 1 }, //     ~0.005 credits, well under one
    { vcpuSeconds: 3600, gbSeconds: 3600 }, // 15 + 3    = 18 credits exactly
    { vcpuSeconds: 0, gbSeconds: 0 }, //      free
    { vcpuSeconds: 7200, gbSeconds: 1800 }, // 30 + 1.5  = 31.5 credits
];

/** The pricing fields the conversion reads, matching what `seedUsage` writes. */
const PRICING = {
    creditsPerSubscription: 0,
    creditsPerTopup: CREDITS_PER_TOPUP,
    creditsFreeStart: 0,
    creditsWebGenerationCost: 0,
    creditsIosGenerationCost: 0,
    creditsAndroidGenerationCost: 0,
    stripeTopupAmountCents: STRIPE_TOPUP_AMOUNT_CENTS,
    usdPerVcpuHourMicros: RATES.usdPerVcpuHour * 1_000_000,
    usdPerGbHourMicros: RATES.usdPerGbHour * 1_000_000,
    meteredMarkupBps: 10_000,
};

/**
 * What the real deduction would charge for one table's worth of these rows, computed the way
 * production computes it: sum the USD across the window, convert once at the org's own sell rate,
 * and floor. Flooring the TOTAL rather than each row is what the accrual carry makes correct -
 * sub-credit remainders roll forward instead of being rounded away or up. This is the whole point
 * of the suite: `creditsByOrg` reimplements the same arithmetic in SQL, and nothing but this pins
 * the two together.
 */
function expectedCredits(): number {
    const totalUsd = USAGE_FIXTURES.reduce(
        (sum, usage) => sum + computePreviewUsageCostUsd(usage.vcpuSeconds, usage.gbSeconds, PRICING),
        0,
    );
    return Math.floor(totalUsd * (creditsPerUsd(PRICING) ?? 0));
}

function projectAtRates(harness: APITestHarness, since: Date, until: Date, rates = RATES) {
    return harness.services.usage.computeBillingProjection({
        usdPerVcpuHour: rates.usdPerVcpuHour,
        usdPerGbHour: rates.usdPerGbHour,
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
            // Both metered tables carry the same fixture set, so each side is one full window total.
            expect(row?.buildCredits).toBe(expectedCredits());
            expect(row?.runningCredits).toBe(expectedCredits());
            expect(row?.totalCredits).toBe(expectedCredits() * 2);
            expect(projection.totalCredits).toBe(expectedCredits() * 2);
        });

        test("excludes usage recorded outside the window", async ({ harness }) => {
            const projection = await projectAtRates(harness, BEFORE_WINDOW, BEFORE_WINDOW_END);

            const row = projection.rows.find((candidate) => candidate.organizationId === harness.organizationId);
            // The out-of-window fixture is a single 3600/3600 row in each table: 18 credits apiece.
            expect(row?.totalCredits).toBe(36);
        });

        test("charges nothing at a zero price - shadow mode", async ({ harness }) => {
            const projection = await projectAtRates(harness, SINCE, UNTIL, {
                usdPerVcpuHour: 0,
                usdPerGbHour: 0,
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
    // The projection joins billing_pricing for the org's sell rate, so the row has to exist and
    // its sell rate has to be the one the expectations are computed at.
    await harness.db.billingPricing.upsert({
        where: { organizationId: harness.organizationId },
        create: {
            organizationId: harness.organizationId,
            creditsPerTopup: CREDITS_PER_TOPUP,
            stripeTopupAmountCents: STRIPE_TOPUP_AMOUNT_CENTS,
        },
        update: { creditsPerTopup: CREDITS_PER_TOPUP, stripeTopupAmountCents: STRIPE_TOPUP_AMOUNT_CENTS },
    });

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
            namespace: "autonoma-ai-compute-projection-1-c6156866caa8da6f",
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
