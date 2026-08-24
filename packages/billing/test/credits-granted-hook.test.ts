import { integrationTestSuite } from "@autonoma/integration-test";
import { expect, vi } from "vitest";
import { AutoTopUpService } from "../src/auto-topup.service";
import { BillingPricingService } from "../src/billing-pricing.service";
import { BillingPromoService } from "../src/billing-promo.service";
import { CreditsService } from "../src/credits.service";
import { VercelOverageService } from "../src/vercel-overage.service";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "CreditsService onCreditsGranted hook",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("fires once per real top-up grant, and not on an idempotent replay", async ({ harness }) => {
            const onCreditsGranted = vi.fn().mockResolvedValue(undefined);
            const service = new CreditsService(
                harness.db,
                new AutoTopUpService(harness.db),
                new BillingPricingService(harness.db),
                new VercelOverageService(harness.db),
                onCreditsGranted,
            );
            const orgId = await harness.createOrgWithBalance(0);

            await service.grantTopupCredits(orgId, "pi_topup_1");
            expect(onCreditsGranted).toHaveBeenCalledTimes(1);
            expect(onCreditsGranted).toHaveBeenCalledWith(orgId);

            // Same payment intent: the unique constraint rolls the grant back, so the hook must not fire again.
            await service.grantTopupCredits(orgId, "pi_topup_1");
            expect(onCreditsGranted).toHaveBeenCalledTimes(1);
        });

        test("does not fire when there is no billing customer to grant to", async ({ harness }) => {
            const onCreditsGranted = vi.fn().mockResolvedValue(undefined);
            const service = new CreditsService(
                harness.db,
                new AutoTopUpService(harness.db),
                new BillingPricingService(harness.db),
                new VercelOverageService(harness.db),
                onCreditsGranted,
            );
            const org = await harness.db.organization.create({
                data: { name: "No Customer Org", slug: `no-customer-${Date.now()}` },
            });

            await service.grantTopupCredits(org.id, "pi_topup_2");

            expect(onCreditsGranted).not.toHaveBeenCalled();
        });

        test("fires when a promo code is redeemed, so a promo top-up re-pokes like a Stripe grant", async ({
            harness,
        }) => {
            const onCreditsGranted = vi.fn().mockResolvedValue(undefined);
            const promoService = new BillingPromoService(harness.db, onCreditsGranted);
            const orgId = await harness.createOrgWithBalance(0);
            await promoService.createPromoCode({ code: "WELCOME50", grantCredits: 50 });

            await promoService.redeemPromoCode(orgId, "WELCOME50");

            expect(onCreditsGranted).toHaveBeenCalledTimes(1);
            expect(onCreditsGranted).toHaveBeenCalledWith(orgId);
        });

        test("does not fire when a promo redemption is rejected", async ({ harness }) => {
            const onCreditsGranted = vi.fn().mockResolvedValue(undefined);
            const promoService = new BillingPromoService(harness.db, onCreditsGranted);
            const orgId = await harness.createOrgWithBalance(0);

            await expect(promoService.redeemPromoCode(orgId, "NONEXISTENT")).rejects.toThrow();

            expect(onCreditsGranted).not.toHaveBeenCalled();
        });
    },
});
