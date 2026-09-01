import { integrationTestSuite } from "@autonoma/integration-test";
import { BILLING_PROVIDERS } from "@autonoma/types";
import type Stripe from "stripe";
import { expect, vi } from "vitest";
import { AutoTopUpService } from "../src/auto-topup.service";
import { getStripe } from "../src/stripe-client";
import { VercelCreditPurchaseService } from "../src/vercel-credit-purchase.service";
import { BillingTestHarness } from "./billing-harness";

vi.mock("../src/stripe-client", () => ({ getStripe: vi.fn() }));

const PAYMENT_METHOD = { id: "pm_fixture_01" };

interface StripeStub {
    listPaymentMethods: () => Promise<{ data: Array<{ id: string }> }>;
    createPaymentIntent: (input: { amount: number }) => Promise<{ id: string }>;
}

/**
 * `AutoTopUpService` only ever calls `customers.listPaymentMethods` and `paymentIntents.create` on
 * the Stripe client, so the stub only implements those two - narrower than the real `Stripe` class,
 * which `getStripe`'s mocked return type otherwise requires. The cast is a deliberate, test-only
 * boundary exception (mocking a large third-party SDK), not a stand-in for typing real data.
 */
function stubStripe(overrides: Partial<StripeStub>) {
    const listPaymentMethods = overrides.listPaymentMethods ?? (async () => ({ data: [PAYMENT_METHOD] }));
    const createPaymentIntent = overrides.createPaymentIntent ?? (async () => ({ id: "pi_fixture" }));

    const stub: unknown = {
        customers: { listPaymentMethods },
        paymentIntents: { create: createPaymentIntent },
    };
    vi.mocked(getStripe).mockReturnValue(stub as Stripe);
}

integrationTestSuite({
    name: "AutoTopUpService.triggerAutoTopUp",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("reserves spend-cap headroom before calling Stripe, using the selected package's price", async ({
            harness,
        }) => {
            let createCallArgs: { amount: number } | undefined;
            stubStripe({
                createPaymentIntent: async (input) => {
                    createCallArgs = input;
                    return { id: "pi_fixture" };
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(10_000);
            expect(createCallArgs).toMatchObject({ amount: 10_000 });
        });

        test("skips the Stripe call entirely when the charge would exceed the spend cap", async ({ harness }) => {
            let createCalled = false;
            stubStripe({
                createPaymentIntent: async () => {
                    createCalled = true;
                    return { id: "pi_fixture" };
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_capped_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                    spendCapAmountCents: 1_000,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            expect(createCalled).toBe(false);
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        test("releases the reservation when the Stripe charge fails", async ({ harness }) => {
            stubStripe({
                createPaymentIntent: async () => {
                    throw new Error("card declined");
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_declined_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        test("skips without calling Stripe when no package is selected", async ({ harness }) => {
            let createCalled = false;
            stubStripe({
                createPaymentIntent: async () => {
                    createCalled = true;
                    return { id: "pi_fixture" };
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    stripeCustomerId: `cus_${Date.now()}`,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            expect(createCalled).toBe(false);
        });

        test("skips without calling Stripe when the selected package has been deactivated", async ({ harness }) => {
            let createCalled = false;
            stubStripe({
                createPaymentIntent: async () => {
                    createCalled = true;
                    return { id: "pi_fixture" };
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Deactivated",
                stripePriceId: `price_deactivated_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.topupPackageService.setActive(pkg.id, false);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            expect(createCalled).toBe(false);
        });

        // A Vercel org has no card of ours to charge, so its recharge settles the way its manual
        // purchases do: granted here, invoiced on the installation for Vercel to collect.
        test("recharges a Vercel organization by invoicing the package, never by charging a card", async ({
            harness,
        }) => {
            let createCalled = false;
            stubStripe({
                createPaymentIntent: async () => {
                    createCalled = true;
                    return { id: "pi_fixture" };
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            await harness.createVercelInstallation({ organizationId: orgId });
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_vercel_auto_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    provider: BILLING_PROVIDERS.VERCEL,
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                },
            });

            await harness.autoTopUpService.triggerAutoTopUp(orgId);

            expect(createCalled).toBe(false);
            const purchase = await harness.db.vercelCreditPurchase.findFirstOrThrow({
                where: { organizationId: orgId },
                select: { creditsGranted: true, invoiceId: true },
            });
            expect(purchase.creditsGranted).toBe(150_000);
            expect(purchase.invoiceId).not.toBeNull();

            // Unlike the Stripe rail, this grants on the spot rather than waiting for a webhook.
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(150_010);

            // Booked once against the cap, by the purchase path - not twice.
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(10_000);
        });

        // The invoice submitter is absent on hosts without the Vercel encryption key, and granting
        // credits there would be giving them away with nothing able to bill for them.
        test("skips a Vercel recharge on a host that cannot raise an invoice", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(10);
            await harness.createVercelInstallation({ organizationId: orgId });
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_vercel_nosubmitter_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    provider: BILLING_PROVIDERS.VERCEL,
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                },
            });

            const withoutSubmitter = new AutoTopUpService(
                harness.db,
                harness.topupPackageService,
                harness.spendCapService,
                new VercelCreditPurchaseService(harness.db, harness.topupPackageService, harness.spendCapService),
            );
            await withoutSubmitter.triggerAutoTopUp(orgId);

            expect(await harness.db.vercelCreditPurchase.count({ where: { organizationId: orgId } })).toBe(0);
            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: orgId },
                select: { creditBalance: true },
            });
            expect(customer.creditBalance).toBe(10);
        });

        // The recorded failure is the only signal that survives every host, so it is the behaviour
        // worth testing: the balance keeps falling and nothing else tells the customer why.
        test("records a declined charge on the customer so the billing page can show it", async ({ harness }) => {
            stubStripe({
                createPaymentIntent: async () => {
                    throw new Error("card declined");
                },
            });

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_record_declined_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.autoTopUpLastFailureReason).toBe("payment_declined");
            expect(customer.autoTopUpLastFailureAt).not.toBeNull();
        });

        test("records a missing card rather than only logging it", async ({ harness }) => {
            stubStripe({ listPaymentMethods: async () => ({ data: [] }) });

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_no_card_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.autoTopUpLastFailureReason).toBe("no_payment_method");
        });

        // A stale "still broken" banner is worse than none, so a recharge that works has to clear it.
        test("clears a recorded failure once a charge succeeds", async ({ harness }) => {
            stubStripe({});

            const orgId = await harness.createOrgWithBalance(10);
            const pkg = await harness.topupPackageService.create({
                name: "Medium",
                stripePriceId: `price_recovers_${Date.now()}`,
                priceCents: 10_000,
                creditsGranted: 150_000,
            });
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: {
                    autoTopUpEnabled: true,
                    autoTopUpThreshold: 100,
                    autoTopUpPackageId: pkg.id,
                    stripeCustomerId: `cus_${Date.now()}`,
                    autoTopUpLastFailureReason: "payment_declined",
                    autoTopUpLastFailureAt: new Date(),
                },
            });

            await harness.creditsService.deductCreditsForLlmProxy(orgId, 0.001, `req_${Date.now()}`);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.autoTopUpLastFailureReason).toBeNull();
            expect(customer.autoTopUpLastFailureAt).toBeNull();
        });
    },
});
