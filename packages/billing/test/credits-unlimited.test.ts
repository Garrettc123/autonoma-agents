import { ApplicationArchitecture, CreditTransactionType } from "@autonoma/db";
import { InsufficientCreditsError } from "@autonoma/errors";
import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

// 1500 credits per USD (creditsPerTopup 150000 / stripeTopupAmountCents 10000 = $100).
const CREDITS_PER_USD = 1500;

// $0.01/vCPU-hour and $0.002/GB-hour, which at the default sell rate land on exactly 15 and 3
// credits per hour - the same rates the preview-usage suite prices against.
const USD_PER_VCPU_HOUR_MICROS = 10_000;
const USD_PER_GB_HOUR_MICROS = 2_000;

async function createExemptOrg(harness: BillingTestHarness, creditBalance: number): Promise<string> {
    const orgId = await harness.createOrgWithBalance(creditBalance);
    await harness.creditsService.updateUnlimitedCredits(orgId, true);
    return orgId;
}

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

integrationTestSuite({
    name: "CreditsService unlimited credits",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("updateUnlimitedCredits creates a billing customer row for an org that has none", async ({ harness }) => {
            const org = await harness.db.organization.create({
                data: { name: "Exempt Org", slug: `exempt-org-${Date.now()}` },
            });

            await harness.creditsService.updateUnlimitedCredits(org.id, true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: org.id },
            });
            expect(customer.unlimitedCredits).toBe(true);
            expect(customer.creditBalance).toBe(0);
        });

        test("generation gate passes on an empty balance, and blocks again once revoked", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 0);

            await expect(
                harness.creditsService.checkCreditsGate(orgId, 5, ApplicationArchitecture.WEB),
            ).resolves.toBeUndefined();

            await harness.creditsService.updateUnlimitedCredits(orgId, false);

            await expect(
                harness.creditsService.checkCreditsGate(orgId, 5, ApplicationArchitecture.WEB),
            ).rejects.toThrow(InsufficientCreditsError);
        });

        test("generation gate passes even after the subscription grace period expired", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 0);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { gracePeriodEndsAt: new Date(Date.now() - 60_000) },
            });

            await expect(
                harness.creditsService.checkCreditsGate(orgId, 1, ApplicationArchitecture.WEB),
            ).resolves.toBeUndefined();
        });

        test("floor gates pass below the org's floor", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 0);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { creditBalance: -50, creditFloor: 0 },
            });

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({ allowed: true });
            expect(await harness.creditsService.checkPreviewDeployCreditsGate(orgId)).toEqual({ allowed: true });
        });

        test("generation consumption is recorded at full cost without moving the balance", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 0);
            const generationId = await harness.createGeneration(orgId);

            const didDeduct = await harness.creditsService.deductCreditsForGeneration(generationId, {
                organizationId: orgId,
                architecture: ApplicationArchitecture.WEB,
            });
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);

            // The deduction the balance never took: a zero balance would have failed the sufficiency
            // check that gates every other org, and the row is charged in full regardless.
            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: `ctr_gen_${generationId}` },
            });
            expect(tx.type).toBe(CreditTransactionType.GENERATION_CONSUMPTION);
            expect(tx.amount).toBeLessThan(0);
            expect(tx.balanceAfter).toBe(0);
        });

        test("a failed generation's refund is recorded without crediting the balance", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 0);
            const generationId = await harness.createGeneration(orgId);

            await harness.creditsService.deductCreditsForGeneration(generationId, {
                organizationId: orgId,
                architecture: ApplicationArchitecture.WEB,
            });
            const consumption = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: `ctr_gen_${generationId}` },
            });

            await harness.db.testGeneration.update({
                where: { id: generationId },
                data: { status: "failed" },
            });
            await harness.creditsService.refundCreditsForGeneration(generationId);

            // The reversal is the case that would otherwise mint credits: the charge it reverses took
            // nothing off the balance, so paying it back must not put anything on.
            const refund = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: `ctr_gen_refund_${consumption.id}` },
            });
            expect(refund.type).toBe(CreditTransactionType.GENERATION_REFUND);
            expect(refund.amount).toBe(Math.abs(consumption.amount));
            expect(refund.balanceAfter).toBe(0);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);
            expect(customer.subscriptionCreditBalance).toBe(0);
        });

        test("llm proxy gate passes on an empty balance", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 0);

            expect(await harness.creditsService.checkLlmProxyGate(orgId, 20_000)).toEqual({ allowed: true });
        });

        test("llm proxy consumption is recorded at full cost without moving the balance", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 1_000);

            const didDeduct = await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.1, "gen-unlimited-1");
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000);

            const expectedCost = Math.ceil(0.1 * CREDITS_PER_USD);
            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_llm_gen-unlimited-1" },
            });
            expect(tx.type).toBe(CreditTransactionType.LLM_PROXY_CONSUMPTION);
            expect(tx.amount).toBe(-expectedCost);
            expect(tx.balanceAfter).toBe(1_000);
        });

        test("preview usage is recorded at full cost without moving the balance", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 5);
            await setPreviewUsageRates(harness, orgId);

            // 1h vCPU (15) + 1h memory (3) = 18 credits, which would take a balance of 5 to -13.
            const didDeduct = await harness.creditsService.deductCreditsForPreviewUsage(
                orgId,
                "win-unlimited-1",
                3600,
                3600,
            );
            expect(didDeduct).toBe(true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(5);

            const tx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_preview_win-unlimited-1" },
            });
            expect(tx.amount).toBe(-18);
            expect(tx.balanceAfter).toBe(5);
        });

        test("sub-credit consumption keeps accruing, so charges stay at true cost", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 100);
            await setPreviewUsageRates(harness, orgId);

            // 0.25h vCPU (3.75) + 1h memory (3) = 6.75: six credits charged now, 0.75 carried.
            await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-carry-1", 900, 3600);

            const afterFirst = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
            });
            expect(afterFirst.creditBalance).toBe(100);
            expect(afterFirst.creditRemainderMicros).toBe(750_000);

            // The same window again: 6.75 + the 0.75 carried = 7.5, so this one charges seven.
            await harness.creditsService.deductCreditsForPreviewUsage(orgId, "win-carry-2", 900, 3600);

            const secondTx = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { id: "ctr_preview_win-carry-2" },
            });
            expect(secondTx.amount).toBe(-7);
            expect(secondTx.balanceAfter).toBe(100);
        });

        test("revoking the exemption resumes deducting from the balance it was frozen at", async ({ harness }) => {
            const orgId = await createExemptOrg(harness, 1_000);

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.1, "gen-revoke-1");
            await harness.creditsService.updateUnlimitedCredits(orgId, false);
            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.1, "gen-revoke-2");

            const expectedCost = Math.ceil(0.1 * CREDITS_PER_USD);
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(1_000 - expectedCost);
        });
    },
});
