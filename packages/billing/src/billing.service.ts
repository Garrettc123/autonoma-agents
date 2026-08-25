import type { PrismaClient } from "@autonoma/db";
import { DisabledBillingService } from "./billing-disabled.service";
import { EnabledBillingService } from "./billing-enabled.service";
import { env } from "./env";
import type { BillingService, BillingServiceOptions, StripeBillingService } from "./types";

export type { BillingService, BillingServiceOptions, StripeBillingService } from "./types";
export type BillingServices = {
    billingService: BillingService;
    stripeBillingService: StripeBillingService | null;
};

export function createBillingServices(db: PrismaClient, options: BillingServiceOptions = {}): BillingServices {
    if (env.STRIPE_ENABLED) {
        const service = new EnabledBillingService(db, options);
        return {
            billingService: service,
            stripeBillingService: service,
        };
    }

    return {
        billingService: new DisabledBillingService(db),
        stripeBillingService: null,
    };
}

export function createBillingService(db: PrismaClient, options: BillingServiceOptions = {}): BillingService {
    return createBillingServices(db, options).billingService;
}

export function createStripeBillingService(
    db: PrismaClient,
    options: BillingServiceOptions = {},
): StripeBillingService | null {
    return createBillingServices(db, options).stripeBillingService;
}
