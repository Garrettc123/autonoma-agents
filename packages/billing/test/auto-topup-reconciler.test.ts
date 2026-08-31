import { AutoTopUpFailureReason } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import type Stripe from "stripe";
import { expect, vi } from "vitest";
import { AutoTopUpReconciler } from "../src/auto-topup-reconciler.service";
import { AutoTopUpService } from "../src/auto-topup.service";
import { getStripe } from "../src/stripe-client";
import { BillingTestHarness } from "./billing-harness";

vi.mock("../src/stripe-client", () => ({ getStripe: vi.fn() }));

const PAYMENT_METHOD = { id: "pm_fixture_01" };
const PACKAGE_PRICE_CENTS = 10_000;
const PACKAGE_CREDITS = 150_000;
const SPEND_CAP_CENTS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

/** Records the charges the sweep actually put through, which is the only observable that matters here. */
function stubStripe(overrides: { createPaymentIntent?: (input: { amount: number }) => Promise<{ id: string }> } = {}) {
    const charges: number[] = [];
    const createPaymentIntent =
        overrides.createPaymentIntent ??
        (async (input: { amount: number }) => {
            charges.push(input.amount);
            return { id: `pi_${charges.length}` };
        });

    const stub: unknown = {
        customers: { listPaymentMethods: async () => ({ data: [PAYMENT_METHOD] }) },
        paymentIntents: { create: createPaymentIntent },
    };
    vi.mocked(getStripe).mockReturnValue(stub as Stripe);
    return charges;
}

function makeReconciler(harness: BillingTestHarness): AutoTopUpReconciler {
    const autoTopUpService = new AutoTopUpService(harness.db, harness.topupPackageService, harness.spendCapService);
    return new AutoTopUpReconciler(harness.db, autoTopUpService, harness.topupPackageService, harness.spendCapService);
}

/** The UTC calendar month `monthsAgo` months back, in the shape `BillingTopupSpendPeriod` stores. */
function spendPeriodBounds(monthsAgo: number): { periodKey: string; startDate: Date; endDate: Date } {
    const now = new Date();
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
    const endDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
    const periodKey = `${startDate.getUTCFullYear()}-${String(startDate.getUTCMonth() + 1).padStart(2, "0")}`;
    return { periodKey, startDate, endDate };
}

interface RechargeableOrgOptions {
    creditBalance?: number;
    spendCapAmountCents?: number;
    lastFailureAt?: Date;
}

/**
 * An organization in the state the sweep exists for: out of credits, auto top-up enabled, a live
 * card and an active package - everything needed to recharge, and no deduction coming to trigger it.
 */
async function createRechargeableOrg(
    harness: BillingTestHarness,
    options: RechargeableOrgOptions = {},
): Promise<{ organizationId: string; packageId: string }> {
    const organizationId = await harness.createOrgWithBalance(options.creditBalance ?? 0);
    const topupPackage = await harness.topupPackageService.create({
        name: "Medium",
        stripePriceId: `price_${organizationId}`,
        priceCents: PACKAGE_PRICE_CENTS,
        creditsGranted: PACKAGE_CREDITS,
    });

    await harness.db.billingCustomer.update({
        where: { organizationId },
        data: {
            autoTopUpEnabled: true,
            autoTopUpThreshold: 100,
            autoTopUpPackageId: topupPackage.id,
            stripeCustomerId: `cus_${organizationId}`,
            spendCapAmountCents: options.spendCapAmountCents,
            autoTopUpLastFailureAt: options.lastFailureAt,
            autoTopUpLastFailureReason:
                options.lastFailureAt == null ? undefined : AutoTopUpFailureReason.payment_declined,
        },
    });

    return { organizationId, packageId: topupPackage.id };
}

async function recordSpendAgainstCap(
    harness: BillingTestHarness,
    organizationId: string,
    monthsAgo: number,
    amountChargedCents: number,
): Promise<void> {
    const { periodKey, startDate, endDate } = spendPeriodBounds(monthsAgo);
    await harness.db.billingTopupSpendPeriod.create({
        data: { organizationId, periodKey, startDate, endDate, amountChargedCents },
    });
}

integrationTestSuite({
    name: "AutoTopUpReconciler.reconcile",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("recharges an organization whose spend cap freed up when the month rolled over", async ({ harness }) => {
            const charges = stubStripe();
            const { organizationId } = await createRechargeableOrg(harness, {
                spendCapAmountCents: SPEND_CAP_CENTS,
            });
            // Last month it spent right up to the cap and then ran dry. Nothing has deducted since,
            // because the credit gate refuses new work at zero - so nothing has triggered a recharge.
            await recordSpendAgainstCap(harness, organizationId, 1, SPEND_CAP_CENTS);

            const result = await makeReconciler(harness).reconcile();

            expect(result.attempted).toBe(1);
            expect(charges).toEqual([PACKAGE_PRICE_CENTS]);

            // The charge and the booked spend are the whole observable here: a recharge ends at a
            // PaymentIntent, and the credits arrive later from the `payment_intent.succeeded`
            // webhook, which a stubbed Stripe never delivers. The balance is deliberately not
            // asserted for that reason.
            const status = await harness.spendCapService.getStatus(organizationId);
            expect(status.amountChargedCentsThisPeriod).toBe(PACKAGE_PRICE_CENTS);
        });

        test("leaves an organization alone while the current month is still at its cap", async ({ harness }) => {
            const charges = stubStripe();
            const { organizationId } = await createRechargeableOrg(harness, {
                spendCapAmountCents: SPEND_CAP_CENTS,
            });
            await recordSpendAgainstCap(harness, organizationId, 0, SPEND_CAP_CENTS);

            const result = await makeReconciler(harness).reconcile();

            expect(result.spendCapReached).toBe(1);
            expect(result.attempted).toBe(0);
            expect(charges).toEqual([]);
            expect(await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId } })).toMatchObject({
                creditBalance: 0,
            });
        });

        test("does not retry an organization whose recharge failed within the backoff window", async ({ harness }) => {
            const charges = stubStripe();
            await createRechargeableOrg(harness, { lastFailureAt: new Date(Date.now() - HOUR_MS) });

            const result = await makeReconciler(harness).reconcile();

            expect(result.recentFailure).toBe(1);
            expect(result.attempted).toBe(0);
            expect(charges).toEqual([]);
        });

        test("retries once the failure backoff has elapsed", async ({ harness }) => {
            const charges = stubStripe();
            await createRechargeableOrg(harness, { lastFailureAt: new Date(Date.now() - 7 * HOUR_MS) });

            const result = await makeReconciler(harness).reconcile();

            expect(result.attempted).toBe(1);
            expect(charges).toEqual([PACKAGE_PRICE_CENTS]);
        });

        test("clears the recorded failure after a recharge succeeds", async ({ harness }) => {
            stubStripe();
            const { organizationId } = await createRechargeableOrg(harness, {
                lastFailureAt: new Date(Date.now() - 7 * HOUR_MS),
            });

            await makeReconciler(harness).reconcile();

            const customer = await harness.db.billingCustomer.findUniqueOrThrow({ where: { organizationId } });
            expect(customer.autoTopUpLastFailureReason).toBeNull();
            expect(customer.autoTopUpLastFailureAt).toBeNull();
        });

        test("skips an organization whose selected package has been deactivated, without calling Stripe", async ({
            harness,
        }) => {
            const charges = stubStripe();
            const { packageId } = await createRechargeableOrg(harness);
            await harness.topupPackageService.setActive(packageId, false);

            const result = await makeReconciler(harness).reconcile();

            expect(result.packageUnavailable).toBe(1);
            expect(charges).toEqual([]);
        });

        test("ignores an organization still above its recharge threshold", async ({ harness }) => {
            const charges = stubStripe();
            await createRechargeableOrg(harness, { creditBalance: 5_000 });

            const result = await makeReconciler(harness).reconcile();

            expect(result.candidates).toBe(0);
            expect(charges).toEqual([]);
        });
    },
});
