import { ApplicationArchitecture, Prisma } from "@autonoma/db";
import type { BillingPricingValues } from "./billing-pricing.types";

/** `BillingPricing.meteredMarkupBps` is basis points; 10000 is 1.0x, i.e. bill exactly what it cost. */
const MARKUP_BASIS_POINTS_SCALE = 10_000;

export function isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function getGenerationCreditCost(architecture: ApplicationArchitecture, pricing: BillingPricingValues) {
    switch (architecture) {
        case ApplicationArchitecture.WEB:
            return pricing.creditsWebGenerationCost;
        case ApplicationArchitecture.IOS:
            return pricing.creditsIosGenerationCost;
        case ApplicationArchitecture.ANDROID:
            return pricing.creditsAndroidGenerationCost;
    }
}

/**
 * Raw (possibly fractional, possibly zero) credit cost of one usage window's
 * measured compute, at the org's flat per-hour rates. Not rounded - callers
 * decide how to turn this into a whole-credit charge.
 */
export function computePreviewUsageCost(
    vcpuSeconds: number,
    gbSeconds: number,
    pricing: Pick<BillingPricingValues, "creditsPerVcpuHour" | "creditsPerGbMemoryHour">,
) {
    const vcpuCost = (vcpuSeconds / 3600) * pricing.creditsPerVcpuHour;
    const gbCost = (gbSeconds / 3600) * pricing.creditsPerGbMemoryHour;
    return vcpuCost + gbCost;
}

/**
 * Whole-credit charge for a USD amount, at the org's own margin. Any real spend costs at least one
 * credit.
 *
 * Two factors, and the distinction matters. Credits are converted at the rate they are SOLD at
 * (`creditsPerTopup` per `stripeTopupAmountCents`) - so on its own this bills a customer exactly
 * what the spend cost us, zero margin. `meteredMarkupBps` is what turns that into a price. It
 * defaults to 1.0x, which preserves the historical cost-pass-through behaviour precisely.
 *
 * This is the single chokepoint for every USD-denominated metered path (the LLM proxy, AI cost,
 * and test generation), which is why the markup lives here rather than at each call site. Compute
 * rates are deliberately outside it - see the note on `meteredMarkupBps` in schema.prisma.
 *
 * Returns `undefined` when the org's row yields no usable rate - a zero `stripeTopupAmountCents`
 * (which would divide to an infinite rate and charge an unbounded number of credits), a zero
 * `creditsPerTopup`, or a non-positive markup (which would make all consumption free). None is
 * reachable through the app, so it means a hand-edited row: callers skip the deduction and log
 * rather than charge a garbage amount.
 */
export function usdToCreditCost(costUsd: number, pricing: BillingPricingValues): number | undefined {
    const creditsPerUsd = pricing.creditsPerTopup / (pricing.stripeTopupAmountCents / 100);
    if (!Number.isFinite(creditsPerUsd) || creditsPerUsd <= 0) return undefined;

    const markup = pricing.meteredMarkupBps / MARKUP_BASIS_POINTS_SCALE;
    if (!Number.isFinite(markup) || markup <= 0) return undefined;

    return Math.max(1, Math.ceil(costUsd * creditsPerUsd * markup));
}

export function buildAutoTopUpIdempotencyKey(organizationId: string) {
    const fiveMinuteBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    return `auto-topup:${organizationId}:${fiveMinuteBucket}`;
}

export function buildCustomerCreateIdempotencyKey(organizationId: string) {
    return `billing-customer:${organizationId}`;
}

export function normalizePromoCode(code: string) {
    return code.trim().toUpperCase();
}
