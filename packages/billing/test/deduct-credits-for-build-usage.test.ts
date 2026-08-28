import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { deductCreditsForBuildUsage } from "../src/deduct-credits-for-build-usage";
import { BillingTestHarness } from "./billing-harness";

// $0.01/vCPU-hour and $0.002/GB-hour, which at the default sell rate of 1500 credits/USD are
// exactly 15 and 3 credits per hour - so every expectation below stays whole-number arithmetic.
const USD_PER_VCPU_HOUR_MICROS = 10_000;
const USD_PER_GB_HOUR_MICROS = 2_000;
const CREDITS_PER_VCPU_HOUR = 15;
const CREDITS_PER_GB_HOUR = 3;

async function setBuildUsageRates(harness: BillingTestHarness, organizationId: string): Promise<void> {
    await harness.db.billingPricing.upsert({
        where: { organizationId },
        create: {
            organizationId,
            usdPerVcpuHourMicros: USD_PER_VCPU_HOUR_MICROS,
            usdPerGbHourMicros: USD_PER_GB_HOUR_MICROS,
        },
        update: {
            usdPerVcpuHourMicros: USD_PER_VCPU_HOUR_MICROS,
            usdPerGbHourMicros: USD_PER_GB_HOUR_MICROS,
        },
    });
}

/** Compute is priced at 0 for an org only by explicit choice now that the fleet default is non-zero. */
async function zeroBuildUsageRates(harness: BillingTestHarness, organizationId: string): Promise<void> {
    await harness.db.billingPricing.upsert({
        where: { organizationId },
        create: { organizationId, usdPerVcpuHourMicros: 0, usdPerGbHourMicros: 0 },
        update: { usdPerVcpuHourMicros: 0, usdPerGbHourMicros: 0 },
    });
}

integrationTestSuite({
    name: "deductCreditsForBuildUsage",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("deducts the computed cost and records a PREVIEW_BUILD_CONSUMPTION transaction", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setBuildUsageRates(harness, orgId);

            // 900 vCPU-s (0.25h) * 15 = 3.75 credits; 3600 GB-s (1h) * 3 = 3 credits -> 6.75 total:
            // six charged now, 0.75 carried rather than rounded away.
            await deductCreditsForBuildUsage(harness.db, orgId, "build-1", 900, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000 - 6);
            expect(customer.creditRemainderMicros).toBe(750_000);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({ where: { id: "ctr_build_build-1" } });
            expect(tx.type).toBe(CreditTransactionType.PREVIEW_BUILD_CONSUMPTION);
            expect(tx.amount).toBe(-6);
            expect(tx.previewkitAppBuildId).toBe("build-1");
        });

        test("is idempotent on the app build id - a retry does not double-charge", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(50_000);
            await setBuildUsageRates(harness, orgId);

            await deductCreditsForBuildUsage(harness.db, orgId, "build-idem-1", 3600, 3600, logger);
            await deductCreditsForBuildUsage(harness.db, orgId, "build-idem-1", 3600, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(50_000 - (CREDITS_PER_VCPU_HOUR + CREDITS_PER_GB_HOUR));

            const count = await harness.db.creditTransaction.count({
                where: { organizationId: orgId, type: CreditTransactionType.PREVIEW_BUILD_CONSUMPTION },
            });
            expect(count).toBe(1);
        });

        test("clamps at the org's own negative credit floor instead of zero", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(5);
            await harness.db.billingCustomer.update({ where: { organizationId: orgId }, data: { creditFloor: -20 } });
            await setBuildUsageRates(harness, orgId);

            await deductCreditsForBuildUsage(harness.db, orgId, "build-floor-1", 3600, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(-13); // 5 - 18 = -13, above the -20 floor
        });

        test("skips deduction when both prices are explicitly zeroed (shadow mode)", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await zeroBuildUsageRates(harness, orgId);

            await deductCreditsForBuildUsage(harness.db, orgId, "build-zero-rate-1", 3600, 3600, logger);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });
    },
});
