import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.updateKillJobsOnCreditExhaustion",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("sets the flag for an org that already has a billing customer row", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);

            await harness.creditsService.updateKillJobsOnCreditExhaustion(orgId, true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.killJobsOnCreditExhaustion).toBe(true);
        });

        test("creates a billing customer row for an org that doesn't have one yet", async ({ harness }) => {
            const org = await harness.db.organization.create({
                data: { name: "No Billing Customer Org", slug: `no-billing-customer-${Date.now()}` },
            });

            await harness.creditsService.updateKillJobsOnCreditExhaustion(org.id, true);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: org.id },
            });
            expect(customer.killJobsOnCreditExhaustion).toBe(true);
            expect(customer.creditBalance).toBe(0);
        });

        test("can be turned back off", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.creditsService.updateKillJobsOnCreditExhaustion(orgId, true);

            await harness.creditsService.updateKillJobsOnCreditExhaustion(orgId, false);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.killJobsOnCreditExhaustion).toBe(false);
        });
    },
});
