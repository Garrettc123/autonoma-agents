import type { PrismaClient } from "@autonoma/db";
import { DisabledBillingService } from "./billing-disabled.service";
import { EnabledBillingService } from "./billing-enabled.service";
import { env } from "./env";
import type { BillingService, BillingServiceHooks, StripeBillingService } from "./types";

export type { BillingService, StripeBillingService } from "./types";
export type BillingServices = {
    billingService: BillingService;
    stripeBillingService: StripeBillingService | null;
};

export function createBillingServices(db: PrismaClient, hooks?: BillingServiceHooks): BillingServices {
    if (env.STRIPE_ENABLED) {
        const service = new EnabledBillingService(db, hooks);
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

export function createBillingService(db: PrismaClient, hooks?: BillingServiceHooks): BillingService {
    return createBillingServices(db, hooks).billingService;
}

export function createStripeBillingService(db: PrismaClient, hooks?: BillingServiceHooks): StripeBillingService | null {
    return createBillingServices(db, hooks).stripeBillingService;
}
