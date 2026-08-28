import type { ComputePricingReference, PrismaClient } from "@autonoma/db";
import type { BillingPricingValues } from "./billing-pricing.types";
import { Service } from "./service";

const MICRODOLLARS_PER_USD = 1_000_000;

export class BillingPricingService extends Service {
    constructor(private readonly db: PrismaClient) {
        super();
    }

    async getOrCreatePricing(organizationId: string): Promise<BillingPricingValues> {
        const existing = await this.db.billingPricing.findUnique({
            where: { organizationId },
            select: {
                creditsPerSubscription: true,
                creditsPerTopup: true,
                creditsFreeStart: true,
                creditsWebGenerationCost: true,
                creditsIosGenerationCost: true,
                creditsAndroidGenerationCost: true,
                stripeTopupAmountCents: true,
                usdPerVcpuHourMicros: true,
                usdPerGbHourMicros: true,
                meteredMarkupBps: true,
            },
        });
        if (existing != null) return existing;

        return this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId },
            update: {},
            select: {
                creditsPerSubscription: true,
                creditsPerTopup: true,
                creditsFreeStart: true,
                creditsWebGenerationCost: true,
                creditsIosGenerationCost: true,
                creditsAndroidGenerationCost: true,
                stripeTopupAmountCents: true,
                usdPerVcpuHourMicros: true,
                usdPerGbHourMicros: true,
                meteredMarkupBps: true,
            },
        });
    }

    async updateCreditsPerSubscription(organizationId: string, creditsPerSubscription: number): Promise<void> {
        await this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId, creditsPerSubscription },
            update: { creditsPerSubscription },
        });
        this.logger.info("Updated creditsPerSubscription for organization", { organizationId, creditsPerSubscription });
    }

    /**
     * Overrides one org's previewkit compute price, away from the fleet default - a deliberate,
     * admin-triggered write, never touched by the pricing-drift cronjob (which only writes the
     * informational, global `ComputePricingReference`).
     *
     * Takes USD per hour and stores microdollars, so the caller passes the same unit the
     * `ComputePricingReference` it is comparing against is denominated in and no call site has to
     * remember the scale. Microdollars are fine-grained enough that the rounding here is
     * immaterial (a ten-thousandth of a cent per hour).
     */
    async updateComputePricing(
        organizationId: string,
        rates: { usdPerVcpuHour: number; usdPerGbHour: number },
    ): Promise<void> {
        const usdPerVcpuHourMicros = Math.round(rates.usdPerVcpuHour * MICRODOLLARS_PER_USD);
        const usdPerGbHourMicros = Math.round(rates.usdPerGbHour * MICRODOLLARS_PER_USD);

        await this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId, usdPerVcpuHourMicros, usdPerGbHourMicros },
            update: { usdPerVcpuHourMicros, usdPerGbHourMicros },
        });
        this.logger.info("Updated compute pricing for organization", {
            organizationId,
            extra: { usdPerVcpuHourMicros, usdPerGbHourMicros },
        });
    }

    /**
     * Sets the org's margin on metered, USD-denominated consumption, in basis points (10000 = 1.0x =
     * bill exactly what it cost us). Admin-only and deliberate, same rollout shape as
     * `updateComputePricing` - every org starts at 1.0x, which is the historical behaviour.
     */
    async updateMeteredMarkup(organizationId: string, meteredMarkupBps: number): Promise<void> {
        const rounded = Math.round(meteredMarkupBps);
        await this.db.billingPricing.upsert({
            where: { organizationId },
            create: { organizationId, meteredMarkupBps: rounded },
            update: { meteredMarkupBps: rounded },
        });
        this.logger.info("Updated metered markup for organization", {
            organizationId,
            meteredMarkupBps: rounded,
        });
    }

    /**
     * The global (not org-scoped) AWS-derived reference rates the pricing-drift cronjob keeps
     * current - one row per compute pool. Purely informational: shown next to an org's live
     * rate in the admin billing settings so an admin can decide whether to apply it via
     * `updateComputePricing`. Both are USD, so the two are directly comparable.
     */
    async getComputePricingReferences(): Promise<ComputePricingReference[]> {
        return this.db.computePricingReference.findMany({ orderBy: { pool: "asc" } });
    }
}
