import { describe, expect, test } from "vitest";
import type { BillingPricingValues } from "../src/billing-pricing.types";
import { usdToCreditCost } from "../src/billing-utils";

/** Schema defaults: a $100 top-up grants 150,000 credits, i.e. 1,500 credits per USD. */
const DEFAULT_PRICING: BillingPricingValues = {
    creditsPerSubscription: 1_000_000,
    creditsPerTopup: 150_000,
    creditsFreeStart: 100_000,
    creditsWebGenerationCost: 500,
    creditsIosGenerationCost: 700,
    creditsAndroidGenerationCost: 540,
    creditsWebRunCost: 10,
    creditsIosRunCost: 200,
    creditsAndroidRunCost: 40,
    stripeTopupAmountCents: 10_000,
    creditsPerVcpuHour: 0,
    creditsPerGbMemoryHour: 0,
    meteredMarkupBps: 10_000,
};

function withMarkup(bps: number): BillingPricingValues {
    return { ...DEFAULT_PRICING, meteredMarkupBps: bps };
}

describe("usdToCreditCost", () => {
    test("at the default markup, bills exactly what the spend cost - 1500 credits per USD", () => {
        expect(usdToCreditCost(1, DEFAULT_PRICING)).toBe(1_500);
        expect(usdToCreditCost(0.5, DEFAULT_PRICING)).toBe(750);
        expect(usdToCreditCost(10, DEFAULT_PRICING)).toBe(15_000);
    });

    test("a 2x markup doubles the charge, and 1.5x scales proportionally", () => {
        expect(usdToCreditCost(1, withMarkup(20_000))).toBe(3_000);
        expect(usdToCreditCost(1, withMarkup(15_000))).toBe(2_250);
    });

    test("a markup below 1.0x bills under cost, which is a discount rather than an error", () => {
        expect(usdToCreditCost(1, withMarkup(5_000))).toBe(750);
    });

    test("any real spend still costs at least one credit, however small", () => {
        expect(usdToCreditCost(0.0000001, DEFAULT_PRICING)).toBe(1);
        expect(usdToCreditCost(0.0000001, withMarkup(20_000))).toBe(1);
    });

    test("rounds up, so a fractional credit is never given away", () => {
        // 1500 * 1.0001 = 1500.15
        expect(usdToCreditCost(1, withMarkup(10_001))).toBe(1_501);
    });

    test("refuses a non-positive markup rather than making all consumption free", () => {
        expect(usdToCreditCost(1, withMarkup(0))).toBeUndefined();
        expect(usdToCreditCost(1, withMarkup(-10_000))).toBeUndefined();
    });

    test("still refuses an unusable exchange rate, markup notwithstanding", () => {
        // A hand-edited zero would divide to an infinite rate and charge an unbounded amount.
        expect(usdToCreditCost(1, { ...DEFAULT_PRICING, stripeTopupAmountCents: 0 })).toBeUndefined();
        expect(usdToCreditCost(1, { ...DEFAULT_PRICING, creditsPerTopup: 0 })).toBeUndefined();
    });
});
