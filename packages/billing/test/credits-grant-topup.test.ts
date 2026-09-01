import { CreditTransactionType } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { BILLING_TOPUP_SOURCES } from "@autonoma/types";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService.grantTopupCredits",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("grants the package's own creditsGranted amount, not a fixed global figure", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(100);
            const smallPackage = await harness.topupPackageService.create({
                name: "Small",
                stripePriceId: `price_small_${Date.now()}`,
                priceCents: 5_000,
                creditsGranted: 42_000,
            });

            await harness.creditsService.grantTopupCredits(
                orgId,
                `pi_${Date.now()}`,
                smallPackage.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(100 + 42_000);
        });

        test("stamps billingPeriodKey and topupPackageId on the CreditTransaction row", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_medium_${Date.now()}`,
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

            const transaction = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { stripePaymentIntentId: paymentIntentId },
            });
            expect(transaction.type).toBe(CreditTransactionType.TOPUP_PURCHASE);
            expect(transaction.topupPackageId).toBe(pkg.id);
            expect(transaction.billingPeriodKey).toMatch(/^\d{4}-\d{2}$/);
        });

        test("is idempotent on a duplicate stripePaymentIntentId", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_dup_${Date.now()}`,
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
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(150_000);
        });

        test("a redelivered webhook does not charge the spend cap twice for one manual purchase", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_redeliver_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            const paymentIntentId = `pi_${Date.now()}`;

            // Stripe redelivers `payment_intent.succeeded`; the second call grants nothing.
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );
            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(150_000);
            // The cap must track the credits: one purchase granted, one purchase charged.
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(10_000);
        });

        test("a manual purchase increments the spend-cap period total", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_manual_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });

            await harness.creditsService.grantTopupCredits(
                orgId,
                `pi_${Date.now()}`,
                pkg.id,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(10_000);
        });

        test("an auto top-up grant does NOT increment the spend-cap total again (already reserved before the charge)", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_auto_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });

            // Simulates AutoTopUpService's pre-charge reservation.
            await harness.spendCapService.reserveForAutoTopUp(orgId, pkg.priceCents);
            await harness.creditsService.grantTopupCredits(
                orgId,
                `pi_${Date.now()}`,
                pkg.id,
                BILLING_TOPUP_SOURCES.AUTO,
            );

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(10_000);
        });

        test("falls back to the org's legacy top-up pricing when packageId is missing from metadata", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pricing = await harness.pricingService.getOrCreatePricing(orgId);
            const paymentIntentId = `pi_${Date.now()}`;

            await harness.creditsService.grantTopupCredits(
                orgId,
                paymentIntentId,
                undefined,
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(pricing.creditsPerTopup);

            const transaction = await harness.db.creditTransaction.findUniqueOrThrow({
                where: { stripePaymentIntentId: paymentIntentId },
            });
            expect(transaction.topupPackageId).toBeNull();

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(pricing.stripeTopupAmountCents);
        });

        test("skips the grant entirely when the referenced package no longer exists", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);

            await harness.creditsService.grantTopupCredits(
                orgId,
                `pi_${Date.now()}`,
                "topup_pkg_does_not_exist",
                BILLING_TOPUP_SOURCES.MANUAL,
            );

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.creditBalance).toBe(0);
        });
    },
});
