import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { BillingTestHarness } from "./billing-harness";

integrationTestSuite({
    name: "BillingTopupPackageService",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("creates a package and lists it as active", async ({ harness }) => {
            const created = await harness.billingService.createTopupPackage({
                name: "Small",
                stripePriceId: `price_${Date.now()}`,
                priceCents: 5000,
                creditsGranted: 75_000,
            });

            const active = await harness.billingService.listActiveTopupPackages();
            expect(active.map((pkg) => pkg.id)).toContain(created.id);
        });

        test("rejects creating a package with a duplicate Stripe price id", async ({ harness }) => {
            const stripePriceId = `price_dup_${Date.now()}`;
            await harness.billingService.createTopupPackage({
                name: "Small",
                stripePriceId,
                priceCents: 5000,
                creditsGranted: 75_000,
            });

            await expect(
                harness.billingService.createTopupPackage({
                    name: "Small Again",
                    stripePriceId,
                    priceCents: 6000,
                    creditsGranted: 80_000,
                }),
            ).rejects.toThrow();
        });

        test("listActive excludes deactivated packages, listAll includes them", async ({ harness }) => {
            const created = await harness.billingService.createTopupPackage({
                name: "Deactivate me",
                stripePriceId: `price_deactivate_${Date.now()}`,
                priceCents: 5000,
                creditsGranted: 75_000,
            });

            await harness.billingService.setTopupPackageActive(created.id, false);

            const active = await harness.billingService.listActiveTopupPackages();
            const all = await harness.billingService.listAllTopupPackages();
            expect(active.map((pkg) => pkg.id)).not.toContain(created.id);
            expect(all.map((pkg) => pkg.id)).toContain(created.id);
        });

        test("orders active packages by sortOrder then priceCents", async ({ harness }) => {
            const suffix = Date.now();
            await harness.billingService.createTopupPackage({
                name: "Second",
                stripePriceId: `price_order_b_${suffix}`,
                priceCents: 5000,
                creditsGranted: 75_000,
                sortOrder: 1,
            });
            await harness.billingService.createTopupPackage({
                name: "First",
                stripePriceId: `price_order_a_${suffix}`,
                priceCents: 5000,
                creditsGranted: 75_000,
                sortOrder: 0,
            });

            const active = await harness.billingService.listActiveTopupPackages();
            const ordered = active.filter((pkg) => pkg.name === "First" || pkg.name === "Second");
            expect(ordered.map((pkg) => pkg.name)).toEqual(["First", "Second"]);
        });

        test("updates a package's fields", async ({ harness }) => {
            const created = await harness.billingService.createTopupPackage({
                name: "Original",
                stripePriceId: `price_update_${Date.now()}`,
                priceCents: 5000,
                creditsGranted: 75_000,
            });

            const updated = await harness.billingService.updateTopupPackage(created.id, {
                name: "Renamed",
                priceCents: 6000,
            });

            expect(updated.name).toBe("Renamed");
            expect(updated.priceCents).toBe(6000);
            expect(updated.creditsGranted).toBe(75_000);
        });
    },
});
