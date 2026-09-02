import { integrationTestSuite } from "@autonoma/integration-test";
import type Stripe from "stripe";
import { expect, vi } from "vitest";
import { getStripe } from "../src/stripe-client";
import { BillingTestHarness } from "./billing-harness";

vi.mock("../src/stripe-client", () => ({ getStripe: vi.fn() }));

/**
 * `stripeHoldsPaymentMethod` only calls `customers.listPaymentMethods`, so the stub implements just
 * that - narrower than the real `Stripe` class, which the mocked return type otherwise requires. The
 * cast is a test-only boundary exception for a large third-party SDK.
 */
function stubSavedCards(cards: Array<{ id: string }>) {
    const stub: unknown = { customers: { listPaymentMethods: async () => ({ data: cards }) } };
    vi.mocked(getStripe).mockReturnValue(stub as Stripe);
}

async function createPackage(harness: BillingTestHarness): Promise<string> {
    const pkg = await harness.topupPackageService.create({
        name: `Starter ${Date.now()}`,
        stripePriceId: `price_${Date.now()}_${Math.floor(performance.now())}`,
        priceCents: 5_000,
        creditsGranted: 75_000,
    });
    return pkg.id;
}

async function linkStripeCustomer(harness: BillingTestHarness, organizationId: string): Promise<void> {
    await harness.db.billingCustomer.update({
        where: { organizationId },
        data: { stripeCustomerId: `cus_${organizationId}` },
    });
}

integrationTestSuite({
    name: "BillingCustomerService.updateAutoTopUp",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("saves the settings when a card is on file", async ({ harness }) => {
            stubSavedCards([{ id: "pm_1" }]);
            const orgId = await harness.createOrgWithBalance(0);
            await linkStripeCustomer(harness, orgId);
            const packageId = await createPackage(harness);

            await harness.billingService.updateAutoTopUp(orgId, true, 100, packageId);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.autoTopUpEnabled).toBe(true);
            expect(customer.autoTopUpThreshold).toBe(100);
            expect(customer.autoTopUpPackageId).toBe(packageId);
        });

        // The whole point of the gate: stored settings with no card are a recharge that never fires,
        // and the balance still runs out with nothing saying why.
        test("refuses to enable when Stripe holds no card", async ({ harness }) => {
            stubSavedCards([]);
            const orgId = await harness.createOrgWithBalance(0);
            await linkStripeCustomer(harness, orgId);
            const packageId = await createPackage(harness);

            await expect(harness.billingService.updateAutoTopUp(orgId, true, 100, packageId)).rejects.toThrow(
                /payment method/i,
            );

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.autoTopUpEnabled).toBe(false);
        });

        test("refuses to enable for an organization with no Stripe customer at all", async ({ harness }) => {
            stubSavedCards([{ id: "pm_1" }]);
            const orgId = await harness.createOrgWithBalance(0);
            const packageId = await createPackage(harness);

            await expect(harness.billingService.updateAutoTopUp(orgId, true, 100, packageId)).rejects.toThrow(
                /payment method/i,
            );
        });

        test("refuses to enable without a package selected", async ({ harness }) => {
            stubSavedCards([{ id: "pm_1" }]);
            const orgId = await harness.createOrgWithBalance(0);
            await linkStripeCustomer(harness, orgId);

            await expect(harness.billingService.updateAutoTopUp(orgId, true, 100)).rejects.toThrow(/package/i);
        });

        // Turning it off must stay possible for an organization that can no longer turn it on -
        // otherwise a card expiring would trap the setting in the enabled state.
        test("allows disabling with no card on file", async ({ harness }) => {
            stubSavedCards([]);
            const orgId = await harness.createOrgWithBalance(0);
            await harness.db.billingCustomer.update({
                where: { organizationId: orgId },
                data: { autoTopUpEnabled: true, autoTopUpThreshold: 100 },
            });

            await harness.billingService.updateAutoTopUp(orgId, false, 0);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId: orgId } });
            expect(customer.autoTopUpEnabled).toBe(false);
        });

        // The upsert's create branch, which replaced a `getOrCreateCustomer` that read this row a
        // second time purely to provision it.
        test("creates the billing customer row when the organization has none", async ({ harness }) => {
            stubSavedCards([]);
            const org = await harness.db.organization.create({
                data: { name: "No Billing Row", slug: `no-billing-row-${Date.now()}` },
            });

            await harness.billingService.updateAutoTopUp(org.id, false, 50);

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({
                where: { organizationId: org.id },
            });
            expect(customer.autoTopUpEnabled).toBe(false);
            expect(customer.autoTopUpThreshold).toBe(50);
            expect(customer.creditBalance).toBe(0);
        });

        test("rejects an organization that does not exist", async ({ harness }) => {
            stubSavedCards([]);

            await expect(harness.billingService.updateAutoTopUp("org_missing", false, 0)).rejects.toThrow(
                /not found/i,
            );
        });
    },
});
