export type BillingPricingValues = {
    creditsPerSubscription: number;
    creditsPerTopup: number;
    creditsFreeStart: number;
    creditsWebGenerationCost: number;
    creditsIosGenerationCost: number;
    creditsAndroidGenerationCost: number;
    stripeTopupAmountCents: number;
    usdPerVcpuHourMicros: number;
    usdPerGbHourMicros: number;
    meteredMarkupBps: number;
};
