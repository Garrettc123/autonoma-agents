import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { SpendCapService } from "../src/spend-cap.service";
import type { BillingAlertNotifier } from "../src/types";
import { BillingTestHarness } from "./billing-harness";

class RecordingAlertNotifier implements BillingAlertNotifier {
    public readonly calls: Array<{ organizationId: string; thresholdPercent: 50 | 80 | 100 }> = [];

    async notifySpendCapThreshold(input: {
        organizationId: string;
        thresholdPercent: 50 | 80 | 100;
        capAmountCents: number;
        amountChargedCents: number;
        periodEnd: Date;
    }): Promise<void> {
        this.calls.push({ organizationId: input.organizationId, thresholdPercent: input.thresholdPercent });
    }
}

integrationTestSuite({
    name: "SpendCapService",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("reserveForAutoTopUp succeeds and increments the period total when under the cap", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.spendCapService.updateCap(orgId, 10_000);

            const reservation = await harness.spendCapService.reserveForAutoTopUp(orgId, 5_000);

            expect(reservation.eligible).toBe(true);
            expect(reservation.periodId).toBeDefined();
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(5_000);
        });

        test("reserveForAutoTopUp is denied once it would exceed the cap, and leaves the total unchanged", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.spendCapService.updateCap(orgId, 10_000);

            const first = await harness.spendCapService.reserveForAutoTopUp(orgId, 5_000);
            expect(first.eligible).toBe(true);

            const second = await harness.spendCapService.reserveForAutoTopUp(orgId, 6_000);
            expect(second.eligible).toBe(false);
            expect(second.periodId).toBeUndefined();

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(5_000);
        });

        test("reserveForAutoTopUp allows an exact-boundary charge (total equals the cap)", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.spendCapService.updateCap(orgId, 10_000);

            const reservation = await harness.spendCapService.reserveForAutoTopUp(orgId, 10_000);

            expect(reservation.eligible).toBe(true);
        });

        test("reserveForAutoTopUp is always eligible when the org has no cap set", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);

            const reservation = await harness.spendCapService.reserveForAutoTopUp(orgId, 1_000_000);

            expect(reservation.eligible).toBe(true);
        });

        test("concurrent reservations at the cap boundary: exactly one succeeds", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.spendCapService.updateCap(orgId, 10_000);

            const [a, b] = await Promise.all([
                harness.spendCapService.reserveForAutoTopUp(orgId, 6_000),
                harness.spendCapService.reserveForAutoTopUp(orgId, 6_000),
            ]);

            const eligibleCount = [a, b].filter((r) => r.eligible).length;
            expect(eligibleCount).toBe(1);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(6_000);
        });

        test("releaseReservation reverses a reservation after a simulated Stripe failure", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.spendCapService.updateCap(orgId, 10_000);

            const reservation = await harness.spendCapService.reserveForAutoTopUp(orgId, 5_000);
            expect(reservation.eligible).toBe(true);
            if (reservation.periodId == null) throw new Error("expected a periodId");

            await harness.spendCapService.releaseReservation(orgId, reservation.periodId, 5_000);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);

            // Headroom is restored, so a same-size reservation is eligible again.
            const retried = await harness.spendCapService.reserveForAutoTopUp(orgId, 5_000);
            expect(retried.eligible).toBe(true);
        });

        test("checkCheckoutEligibility never reserves - a rejected checkout leaves the total untouched", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await harness.spendCapService.updateCap(orgId, 1_000);

            const eligibility = await harness.spendCapService.checkCheckoutEligibility(orgId, 5_000);
            expect(eligibility.allowed).toBe(false);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        test("recordManualCharge records spend and returns the current period key", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);

            const periodKey = await harness.spendCapService.recordManualCharge(orgId, 5_000);

            expect(periodKey).toMatch(/^\d{4}-\d{2}$/);
            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.periodKey).toBe(periodKey);
            expect(status.amountChargedCentsThisPeriod).toBe(5_000);
        });

        test("recordRefund reopens headroom in the period the original charge landed in, even a past month", async ({
            harness,
        }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const pastPeriodKey = "2020-01";
            await harness.db.billingTopupSpendPeriod.create({
                data: {
                    organizationId: orgId,
                    periodKey: pastPeriodKey,
                    startDate: new Date("2020-01-01T00:00:00.000Z"),
                    endDate: new Date("2020-02-01T00:00:00.000Z"),
                    amountChargedCents: 5_000,
                },
            });

            await harness.spendCapService.recordRefund(orgId, pastPeriodKey, 2_000);

            const period = await harness.db.billingTopupSpendPeriod.findUniqueOrThrow({
                where: { organizationId_periodKey: { organizationId: orgId, periodKey: pastPeriodKey } },
            });
            expect(period.amountChargedCents).toBe(3_000);
        });

        test("recordRefund clamps at zero rather than going negative", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const periodKey = await harness.spendCapService.recordManualCharge(orgId, 1_000);

            await harness.spendCapService.recordRefund(orgId, periodKey, 5_000);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(0);
        });

        test("concurrent refunds against the same period both apply, with no lost update", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const periodKey = await harness.spendCapService.recordManualCharge(orgId, 10_000);

            await Promise.all([
                harness.spendCapService.recordRefund(orgId, periodKey, 3_000),
                harness.spendCapService.recordRefund(orgId, periodKey, 4_000),
            ]);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(3_000);
        });

        test("a refund concurrent with a new charge does not overwrite that charge", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const periodKey = await harness.spendCapService.recordManualCharge(orgId, 10_000);

            await Promise.all([
                harness.spendCapService.recordRefund(orgId, periodKey, 4_000),
                harness.spendCapService.recordManualCharge(orgId, 2_500),
            ]);

            const status = await harness.spendCapService.getStatus(orgId);
            expect(status.amountChargedCentsThisPeriod).toBe(8_500);
        });

        test("recordRefund is a no-op when passed a null period key", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            await expect(harness.spendCapService.recordRefund(orgId, null, 1_000)).resolves.toBeUndefined();
        });

        test("crossing a new alert threshold notifies exactly once, and re-crossing the same one does not renotify", async ({
            harness,
        }) => {
            const notifier = new RecordingAlertNotifier();
            const spendCapService = new SpendCapService(harness.db, notifier);
            const orgId = await harness.createOrgWithBalance(0);
            await spendCapService.updateCap(orgId, 10_000);

            // Crosses 50% (5000/10000).
            await spendCapService.reserveForAutoTopUp(orgId, 5_000);
            expect(notifier.calls).toEqual([{ organizationId: orgId, thresholdPercent: 50 }]);

            // Small charge that doesn't cross 80% yet - no new alert.
            await spendCapService.reserveForAutoTopUp(orgId, 1_000);
            expect(notifier.calls).toHaveLength(1);

            // Crosses 80% (8000/10000).
            await spendCapService.reserveForAutoTopUp(orgId, 2_000);
            expect(notifier.calls).toEqual([
                { organizationId: orgId, thresholdPercent: 50 },
                { organizationId: orgId, thresholdPercent: 80 },
            ]);

            // Crosses 100%.
            await spendCapService.reserveForAutoTopUp(orgId, 2_000);
            expect(notifier.calls).toEqual([
                { organizationId: orgId, thresholdPercent: 50 },
                { organizationId: orgId, thresholdPercent: 80 },
                { organizationId: orgId, thresholdPercent: 100 },
            ]);
        });

        test("updateCap throws for an organization with no billing customer row", async ({ harness }) => {
            const org = await harness.db.organization.create({
                data: { name: "No Customer Org", slug: `no-customer-${Date.now()}` },
            });

            await expect(harness.spendCapService.updateCap(org.id, 10_000)).rejects.toThrow();
        });
    },
});
