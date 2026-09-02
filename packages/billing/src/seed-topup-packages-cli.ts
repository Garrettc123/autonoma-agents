import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { BillingTopupPackageService } from "./billing-topup-package.service";
import { getStripe } from "./stripe-client";

/** The product every top-up Price hangs off, looked up by name so a re-run reuses it. */
const STRIPE_PRODUCT_NAME = "Autonoma credits";

/**
 * The starting catalog. `creditsGranted` is deliberately 1,500 credits per USD at every tier - the
 * same rate `usdToCreditCost` converts spend back at - so the tiers differ in size, not in price
 * per credit. Change that only on purpose: a tier priced below the conversion rate resells AI
 * under cost.
 */
const PACKAGES = [
    { name: "Starter", priceCents: 5_000, creditsGranted: 75_000, sortOrder: 10 },
    { name: "Standard", priceCents: 10_000, creditsGranted: 150_000, sortOrder: 20 },
    { name: "Scale", priceCents: 50_000, creditsGranted: 750_000, sortOrder: 30 },
] as const;

/**
 * Seeds `BillingTopupPackage` and the Stripe Prices behind it. Nothing can be bought on either rail
 * until this has run at least once - the catalog is global and starts empty, so an organization that
 * exhausts its balance has no way to buy more and `AutoTopUpService` has nothing to recharge with.
 *
 * Creates the Stripe Price and the package row together, on purpose. `BillingTopupPackage.priceCents`
 * must equal its Price's `unit_amount` (auto-top-up charges that number directly via a raw
 * PaymentIntent, and the spend cap records it), so entering them separately is a standing chance for
 * the two to drift - a customer charged one amount while the cap counts another.
 *
 * Idempotent by package name: an existing row is left exactly as it is, never edited, because
 * changing a live package's price or credits retroactively changes what past buyers were sold. Add a
 * new tier instead, and deactivate the old one through the admin endpoint.
 *
 * Prints what it would do and writes nothing unless passed `--apply`:
 *
 *     pnpm --filter @autonoma/billing seed-topup-packages
 *     pnpm --filter @autonoma/billing seed-topup-packages --apply
 */
async function main() {
    const logger = rootLogger.child({ name: "seed-topup-packages-cli" });
    const apply = process.argv.includes("--apply");

    const packageService = new BillingTopupPackageService(db);
    const existing = await packageService.listAll();
    const existingByName = new Map(existing.map((pkg) => [pkg.name, pkg]));

    const missing = PACKAGES.filter((pkg) => !existingByName.has(pkg.name));

    logger.info("Resolved top-up catalog state", {
        extra: {
            apply,
            existing: existing.map((pkg) => ({ name: pkg.name, priceCents: pkg.priceCents, isActive: pkg.isActive })),
            missing: missing.map((pkg) => pkg.name),
        },
    });

    if (missing.length === 0) {
        logger.info("Every package in the catalog already exists, nothing to seed");
        return;
    }

    if (!apply) {
        logger.info("Dry run - re-run with --apply to create these packages and their Stripe Prices", {
            extra: { wouldCreate: missing },
        });
        return;
    }

    const stripe = getStripe();
    const productId = await resolveProductId(stripe, logger);

    for (const pkg of missing) {
        const price = await stripe.prices.create({
            product: productId,
            currency: "usd",
            unit_amount: pkg.priceCents,
            nickname: pkg.name,
        });

        const created = await packageService.create({
            name: pkg.name,
            stripePriceId: price.id,
            priceCents: pkg.priceCents,
            creditsGranted: pkg.creditsGranted,
            sortOrder: pkg.sortOrder,
        });

        logger.info("Seeded top-up package", {
            extra: {
                packageId: created.id,
                name: created.name,
                stripePriceId: price.id,
                priceCents: created.priceCents,
                creditsGranted: created.creditsGranted,
            },
        });
    }
}

/** Reuses the existing credits product when there is one, so a re-run does not fragment Prices. */
async function resolveProductId(stripe: ReturnType<typeof getStripe>, logger: ReturnType<typeof rootLogger.child>) {
    const found = await stripe.products.search({ query: `name:"${STRIPE_PRODUCT_NAME}" AND active:"true"`, limit: 1 });
    const existing = found.data[0];
    if (existing != null) {
        logger.info("Reusing existing Stripe product", { extra: { productId: existing.id } });
        return existing.id;
    }

    const created = await stripe.products.create({ name: STRIPE_PRODUCT_NAME });
    logger.info("Created Stripe product", { extra: { productId: created.id } });
    return created.id;
}

main()
    .catch((err: unknown) => {
        console.error("Failed to seed top-up packages:", err);
        process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
