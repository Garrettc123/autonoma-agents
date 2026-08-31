import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { VercelInvoiceStatus } from "../src/vercel-invoice-status";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.updateCreditFloor",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("sets a new floor for a paying org that already has a billing customer row", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.recordSettledTopupPurchase(orgId);

            await harness.creditsService.updateCreditFloor(orgId, -500);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditFloor).toBe(-500);
        });

        test("creates a billing customer row when setting a floor of zero for an org without one", async ({
            harness,
        }) => {
            const org = await harness.db.organization.create({
                data: { name: "No Billing Customer Org", slug: `no-billing-customer-${Date.now()}` },
            });

            await harness.creditsService.updateCreditFloor(org.id, 0);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: org.id },
            });
            expect(customer.creditFloor).toBe(0);
            expect(customer.creditBalance).toBe(0);
        });

        // An overdraft is an extension of credit, and an org with no settled bill has earned none.
        test("refuses an overdraft for an org that has never paid", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);

            await expect(harness.creditsService.updateCreditFloor(orgId, -500)).rejects.toThrow(/never paid/i);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditFloor).toBe(0);
        });

        // Raising the floor back to zero is how an overdraft gets revoked, so it must stay possible
        // for an org that no longer qualifies for one.
        test("allows a floor of zero for an org that has never paid", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);

            await expect(harness.creditsService.updateCreditFloor(orgId, 0)).resolves.toBeUndefined();
        });

        test("counts a settled Vercel invoice as having paid", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.recordVercelInvoice(orgId);

            await harness.creditsService.updateCreditFloor(orgId, -500);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditFloor).toBe(-500);
        });

        // A purchase whose credits are granted but whose invoice Vercel has not settled yet is money
        // owed, not money received - it must not buy an overdraft on top.
        test("does not count an unpaid Vercel invoice as having paid", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.recordVercelInvoice(orgId, { status: VercelInvoiceStatus.Pending });

            await expect(harness.creditsService.updateCreditFloor(orgId, -500)).rejects.toThrow(/never paid/i);
        });

        // Refunding the purchase that earned the overdraft takes the standing with it.
        test("does not count a top-up that was fully refunded", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.recordSettledTopupPurchase(orgId, 150_000);
            await harness.recordTopupRefund(orgId, 150_000);

            await expect(harness.creditsService.updateCreditFloor(orgId, -500)).rejects.toThrow(/never paid/i);
        });

        // The same revocation on the Vercel rail: the invoice keeps its paidAt, so only the status
        // says the money went back.
        test("does not count a Vercel invoice that was refunded", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.recordVercelInvoice(orgId, { status: VercelInvoiceStatus.Refunded });

            await expect(harness.creditsService.updateCreditFloor(orgId, -500)).rejects.toThrow(/never paid/i);
        });

        // The legacy subscriber settles invoices without ever buying a top-up, so the subscription
        // status is the only thing standing between it and a refused overdraft.
        test("counts an active Stripe subscription as having paid", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            await harness.recordActiveStripeSubscription(orgId);

            await harness.creditsService.updateCreditFloor(orgId, -500);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditFloor).toBe(-500);
        });
    },
});
