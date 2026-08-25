import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { BILLING_TOPUP_SOURCES } from "@autonoma/types";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.revokeTopupCredits",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("a full refund reverses the exact granted credits", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_full_refund_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            const paymentIntentId = `pi_${Date.now()}`;
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            await harness.creditsService.revokeTopupCredits(orgId, `re_${Date.now()}`, paymentIntentId, 10_000, 10_000);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);
        });

        test("a partial refund reverses a proportional share of the granted credits", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_partial_refund_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            const paymentIntentId = `pi_${Date.now()}`;
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            // Half the charge refunded -> half the credits reversed.
            await harness.creditsService.revokeTopupCredits(orgId, `re_${Date.now()}`, paymentIntentId, 5_000, 10_000);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(75_000);
        });

        test("is idempotent on a duplicate stripeRefundId", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_idempotent_refund_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            const paymentIntentId = `pi_${Date.now()}`;
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );
            const refundId = `re_${Date.now()}`;

            await harness.creditsService.revokeTopupCredits(orgId, refundId, paymentIntentId, 10_000, 10_000);
            await harness.creditsService.revokeTopupCredits(orgId, refundId, paymentIntentId, 10_000, 10_000);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);
        });

        test("reopens spend-cap headroom in the period the original purchase landed in", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_cap_reopen_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            const paymentIntentId = `pi_${Date.now()}`;
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            let status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(10_000);

            await harness.creditsService.revokeTopupCredits(orgId, `re_${Date.now()}`, paymentIntentId, 10_000, 10_000);

            status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        test("records a TOPUP_REFUND transaction with a negative amount", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_refund_record_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            const paymentIntentId = `pi_${Date.now()}`;
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );
            const refundId = `re_${Date.now()}`;

            await harness.creditsService.revokeTopupCredits(orgId, refundId, paymentIntentId, 10_000, 10_000);

            const refundTransaction = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { stripeRefundId: refundId },
            });
            expect(refundTransaction.type).toBe(CreditTransactionType.TOPUP_REFUND);
            expect(refundTransaction.amount).toBe(-150_000);
        });

        test("is a no-op when no purchase is found for the payment intent", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);

            await expect(
                harness.creditsService.revokeTopupCredits(orgId, `re_${Date.now()}`, "pi_never_existed", 5_000, 10_000),
            ).resolves.toBeUndefined();
        });
    },
});
