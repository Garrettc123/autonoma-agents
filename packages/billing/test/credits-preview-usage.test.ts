import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

// $0.01/vCPU-hour and $0.002/GB-hour. Chosen so that at the default sell rate of 1500
// credits/USD they land on exactly 15 and 3 credits per hour, keeping every expectation below
// whole-number arithmetic rather than a float comparison.
const USD_PER_VCPU_HOUR_MICROS = 10_000;
const USD_PER_GB_HOUR_MICROS = 2_000;
const CREDITS_PER_VCPU_HOUR = 15;
const CREDITS_PER_GB_HOUR = 3;

async function setPreviewUsageRates(harness: BillingTestHarness, organizationId: string): Promise<void> {
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
async function zeroPreviewUsageRates(harness: BillingTestHarness, organizationId: string): Promise<void> {
    await harness.db.billingPricing.upsert({
        where: { organizationId },
        create: { organizationId, usdPerVcpuHourMicros: 0, usdPerGbHourMicros: 0 },
        update: { usdPerVcpuHourMicros: 0, usdPerGbHourMicros: 0 },
    });
}

integrationTestSuite({
    name: "CreditsService.deductCreditsForPreviewUsage",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("deducts the computed cost and records a PREVIEW_RUNTIME_CONSUMPTION transaction", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100_000);
            await setPreviewUsageRates(harness, orgId);

            // 900 vCPU-s (0.25h) * 15 = 3.75 credits; 3600 GB-s (1h) * 3 = 3 credits -> 6.75 total.
            // Six credits are taken now and the remaining 0.75 is carried, not rounded away.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-deduct-1",
                900,
                3600,
            );
            expect(didDeduct).toBe(true);

            const expectedCost = 6;
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100_000 - expectedCost);
            expect(customer.creditRemainderMicros).toBe(750_000);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_preview_win-deduct-1" },
            });
            expect(tx.type).toBe(CreditTransactionType.PREVIEW_RUNTIME_CONSUMPTION);
            expect(tx.amount).toBe(-expectedCost);
            expect(tx.balanceAfter).toBe(100_000 - expectedCost);
            expect(tx.usageWindowId).toBe("win-deduct-1");
        });

        /**
         * The behaviour that replaced the old one-credit-per-window minimum, which overcharged
         * 3-4x at the sub-credit amounts a real 15-minute window actually costs.
         */
        test("carries a sub-credit cost instead of rounding it up to one credit", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await setPreviewUsageRates(harness, orgId);

            // 36 vCPU-s (0.01h) * 15 = 0.15 credits, far below one.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-min-1", 36, 0);
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
            expect(customer.creditRemainderMicros).toBe(150_000);
        });

        test("charges a whole credit once carried fractions add up to one", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await setPreviewUsageRates(harness, orgId);

            // Seven windows of 0.15 credits each: 1.05 total, so exactly one credit is charged
            // across the seven and 0.05 stays carried.
            for (let index = 0; index < 7; index++) {
                await harness.creditsService.deductCreditsForPreviewUsage(orgId, `win-accrue-${index}`, 36, 0);
            }

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(999);
            expect(customer.creditRemainderMicros).toBe(50_000);
        });

        /** A retry must not advance the carry either, not just the balance. */
        test("a retried sub-credit window does not advance the carry twice", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await setPreviewUsageRates(harness, orgId);

            const first = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-carry-idem", 36, 0);
            const second = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-carry-idem", 36, 0);

            expect(first).toBe(true);
            expect(second).toBe(false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditRemainderMicros).toBe(150_000);
            expect(customer.creditBalance).toBe(1_000);
        });

        test("is idempotent on the usage window id - a retry does not double-charge", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(50_000);
            await setPreviewUsageRates(harness, orgId);

            const first = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-idem-1", 3600, 3600);
            const second = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-idem-1", 3600, 3600);

            expect(first).toBe(true);
            expect(second).toBe(false);

            const expectedCost = CREDITS_PER_VCPU_HOUR + CREDITS_PER_GB_HOUR; // 18
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(50_000 - expectedCost);

            const count = await harness.db.creditTransaction.count({
                where: { organizationId: orgId, type: CreditTransactionType.PREVIEW_RUNTIME_CONSUMPTION },
            });
            expect(count).toBe(1);
        });

        test("clamps the balance at zero when a single window exceeds it", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(5);
            await setPreviewUsageRates(harness, orgId);

            // 1h vCPU + 1h memory -> 18 credits, far more than the 5-credit balance.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-clamp-1",
                3600,
                3600,
            );
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_preview_win-clamp-1" },
            });
            expect(tx.balanceAfter).toBe(0);
        });

        test("draws from the subscription pool before the top-up pool, floored at zero", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(20);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { subscriptionCreditBalance: 8 },
            });
            await setPreviewUsageRates(harness, orgId);

            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-sub-1", 3600, 3600);
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(2); // 20 - 18
            expect(customer.subscriptionCreditBalance).toBe(0); // 8 - min(8, 18), floored at 0
        });

        test("skips deduction when both prices are explicitly zeroed (shadow mode)", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await zeroPreviewUsageRates(harness, orgId);

            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-zero-rate-1",
                3600,
                3600,
            );
            expect(didDeduct).toBe(false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });

        test("clamps at the org's own negative credit floor instead of zero", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(5);
            await harness.db.billingCustomer.update({ where: { organizationId: orgId }, data: { creditFloor: -20 } });
            await setPreviewUsageRates(harness, orgId);

            // 1h vCPU + 1h memory -> 18 credits: 5 - 18 = -13, above the -20 floor, so it goes through in full.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-floor-1",
                3600,
                3600,
            );
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(-13);
        });

        test("skips deduction for a window with zero measured usage", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1_000);
            await setPreviewUsageRates(harness, orgId);

            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-zero-usage-1",
                0,
                0,
            );
            expect(didDeduct).toBe(false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);
        });
    },
});
