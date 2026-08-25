import { integrationTestSuite } from "@autonoma/integration-test";
import type Stripe from "stripe";
import { expect, vi } from "vitest";
import { getStripe } from "../src/stripe-client";
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
    },
});
