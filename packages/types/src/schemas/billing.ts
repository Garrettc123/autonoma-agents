import { z } from "zod";

export const BillingTransactionSchema = z.object({
    id: z.string(),
    type: z.enum([
        "SUBSCRIPTION_GRANT",
        "SUBSCRIPTION_RESET",
        "TOPUP_PURCHASE",
        "TOPUP_REFUND",
        "GENERATION_CONSUMPTION",
        "GENERATION_REFUND",
        "RUN_CONSUMPTION",
    ]),
    amount: z.number(),
    balanceAfter: z.number(),
    generationId: z.string().optional(),
    runId: z.string().optional(),
    stripePaymentIntentId: z.string().optional(),
    stripeInvoiceId: z.string().optional(),
    stripeRefundId: z.string().optional(),
    createdAt: z.date(),
});
export type BillingTransaction = z.infer<typeof BillingTransactionSchema>;

export const BillingStatusSchema = z.object({
    creditBalance: z.number(),
    subscriptionCreditBalance: z.number(),
    topupCreditBalance: z.number(),
    subscriptionStatus: z
        .enum(["active", "canceled", "past_due", "unpaid", "trialing", "paused", "incomplete", "incomplete_expired"])
        .optional(),
    currentPeriodEnd: z.date().optional(),
    cancelAtPeriodEnd: z.boolean(),
    gracePeriodEndsAt: z.date().optional(),
    autoTopUpEnabled: z.boolean(),
    autoTopUpThreshold: z.number(),
    transactions: z.array(BillingTransactionSchema),
});
export type BillingStatus = z.infer<typeof BillingStatusSchema>;

export const AutoTopUpInputSchema = z.object({
    enabled: z.boolean(),
    threshold: z.number().int().min(0),
});
export type AutoTopUpInput = z.infer<typeof AutoTopUpInputSchema>;

export const RunCompletedSchema = z.object({
    generationId: z.string(),
});
export type RunCompleted = z.infer<typeof RunCompletedSchema>;
