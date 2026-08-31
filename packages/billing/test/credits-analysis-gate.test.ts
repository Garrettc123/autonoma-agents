import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.checkAnalysisCreditsGate",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("allows an org with a positive balance", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(1);

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({ allowed: true });
        });

        test("blocks an org with a zero balance", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });

        test("allows a negative balance that's still above the org's own credit floor", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.recordSettledTopupPurchase(orgId);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { creditBalance: -3, creditFloor: -5 },
            });

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({ allowed: true });
        });

        test("blocks once the balance reaches the org's own credit floor", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.recordSettledTopupPurchase(orgId);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { creditBalance: -5, creditFloor: -5 },
            });

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });

        // The gate, not just `updateCreditFloor`, is what has to hold: a floor set while the org was
        // paying (or written straight to the row) must stop applying once it has not.
        test("ignores an overdraft an org has never paid for, blocking it at zero instead", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { creditBalance: -3, creditFloor: -5 },
            });

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });

        // Losing the payment standing revokes the overdraft without anyone editing the floor.
        test("stops honouring an overdraft after the purchase that earned it is refunded", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.recordSettledTopupPurchase(orgId, 150_000);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { creditBalance: -3, creditFloor: -5 },
            });
            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({ allowed: true });

            await harness.recordTopupRefund(orgId, 150_000);

            expect(await harness.creditsService.checkAnalysisCreditsGate(orgId)).toEqual({
                allowed: false,
                reason: "out_of_credits",
            });
        });
    },
});
