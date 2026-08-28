import { ApplicationArchitecture, Prisma } from "@autonoma/db";
import type { BillingPricingValues } from "./billing-pricing.types";

/** `BillingPricing.meteredMarkupBps` is basis points; 10000 is 1.0x, i.e. bill exactly what it cost. */
const MARKUP_BASIS_POINTS_SCALE = 10_000;
/** Compute prices and the fractional-credit carry are both stored as millionths of their unit. */
const MICRO_UNITS_PER_UNIT = 1_000_000;
const SECONDS_PER_HOUR = 3600;
const CENTS_PER_USD = 100;

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
 * A whole-credit charge expressed in the millionths `deductCreditsFloored` takes. Whole-credit
 * paths carry no fraction, so this is exact and their behaviour is unchanged; the unit is shared
 * only so metered compute can charge a fraction through the same primitive.
 */
export function toMicroCredits(credits: number): number {
    return credits * MICRO_UNITS_PER_UNIT;
}

/**
 * USD cost of one usage window's measured compute, at the org's flat per-hour prices.
 * Fractional dollars, unrounded - the credits conversion and any rounding are the
 * caller's, via {@link computePreviewUsageMicroCredits}.
 */
export function computePreviewUsageCostUsd(
    vcpuSeconds: number,
    gbSeconds: number,
    pricing: Pick<BillingPricingValues, "usdPerVcpuHourMicros" | "usdPerGbHourMicros">,
): number {
    const vcpuUsd = (vcpuSeconds / SECONDS_PER_HOUR) * (pricing.usdPerVcpuHourMicros / MICRO_UNITS_PER_UNIT);
    const gbUsd = (gbSeconds / SECONDS_PER_HOUR) * (pricing.usdPerGbHourMicros / MICRO_UNITS_PER_UNIT);
    return vcpuUsd + gbUsd;
}

/**
 * What one window of measured compute costs the org, in MILLIONTHS of a credit.
 *
 * Micro-credits rather than credits because a 15-minute window of a real preview costs a
 * small fraction of one credit (0.2 to 0.5 at the fleet rate), and the old behaviour -
 * `max(1, ceil(cost))` per row - therefore overcharged by 3-4x. An integer count of
 * millionths carries that fraction exactly through to `deductCreditsFloored`, which
 * accumulates it against the org's carry and only ever moves whole credits.
 *
 * Note what is NOT applied here: `meteredMarkupBps`. Compute prices are set as prices, with
 * their margin already inside them, so the markup belongs to the USD-cost paths
 * ({@link usdToCreditCost}) and not to this one. Returns `undefined` when the org's row
 * yields no usable credits-per-USD rate, for the reasons {@link creditsPerUsd} explains.
 */
export function computePreviewUsageMicroCredits(
    vcpuSeconds: number,
    gbSeconds: number,
    pricing: BillingPricingValues,
): number | undefined {
    const rate = creditsPerUsd(pricing);
    if (rate == null) return undefined;

    const costUsd = computePreviewUsageCostUsd(vcpuSeconds, gbSeconds, pricing);
    return Math.round(costUsd * rate * MICRO_UNITS_PER_UNIT);
}

/**
 * How many credits one USD buys for this org: the rate credits are SOLD at
 * (`creditsPerTopup` per `stripeTopupAmountCents`). Converting spend back at the same rate
 * bills exactly what it cost us, before any margin.
 *
 * Returns `undefined` when the row yields no usable rate - a zero `stripeTopupAmountCents`
 * (which would divide to an infinite rate and charge an unbounded number of credits) or a
 * zero `creditsPerTopup`. Neither is reachable through the app, so it means a hand-edited
 * row: callers skip the deduction and log rather than charge a garbage amount.
 */
export function creditsPerUsd(pricing: BillingPricingValues): number | undefined {
    const rate = pricing.creditsPerTopup / (pricing.stripeTopupAmountCents / CENTS_PER_USD);
    if (!Number.isFinite(rate) || rate <= 0) return undefined;
    return rate;
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
 * Returns `undefined` when the org's row yields no usable rate (see {@link creditsPerUsd}) or a
 * non-positive markup, which would make all consumption free. Neither is reachable through the
 * app, so it means a hand-edited row: callers skip the deduction and log rather than charge a
 * garbage amount.
 */
export function usdToCreditCost(costUsd: number, pricing: BillingPricingValues): number | undefined {
    const rate = creditsPerUsd(pricing);
    if (rate == null) return undefined;

    const markup = pricing.meteredMarkupBps / MARKUP_BASIS_POINTS_SCALE;
    if (!Number.isFinite(markup) || markup <= 0) return undefined;

    return Math.max(1, Math.ceil(costUsd * rate * markup));
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
