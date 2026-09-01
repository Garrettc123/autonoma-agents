/**
 * Which rail settles an organization's money, as stored on `BillingCustomer.provider`. The credit
 * layer is identical either way - the same balance, the same deduction code, the same catalog - so
 * this only ever decides how a charge is collected: Stripe directly, or an invoice raised on the
 * Vercel installation.
 *
 * Deliberately not shared with `VERCEL_PROVIDER` in the API's posthog module, which happens to hold
 * the same string for a different column: `User.provider`, marking an account created by the Vercel
 * marketplace flow rather than better-auth. Two unrelated concepts that would have to move together
 * if they shared a constant.
 */
export const BILLING_PROVIDERS = {
    STRIPE: "stripe",
    VERCEL: "vercel",
} as const;

export type BillingProvider = (typeof BILLING_PROVIDERS)[keyof typeof BILLING_PROVIDERS];

export const BILLING_PAYMENT_INTENT_TYPES = {
    TOPUP: "topup",
} as const;

export type BillingPaymentIntentType = (typeof BILLING_PAYMENT_INTENT_TYPES)[keyof typeof BILLING_PAYMENT_INTENT_TYPES];

/** Which path created a top-up PaymentIntent - a manually-purchased Checkout, or an off-session auto-top-up charge. */
export const BILLING_TOPUP_SOURCES = {
    MANUAL: "manual",
    AUTO: "auto",
} as const;

export type BillingTopupSource = (typeof BILLING_TOPUP_SOURCES)[keyof typeof BILLING_TOPUP_SOURCES];

export const BILLING_STRIPE_SUBSCRIPTION_SYNC_EVENT_TYPES = [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
    "customer.subscription.trial_will_end",
] as const;

export const BILLING_STRIPE_WEBHOOK_EVENT_TYPES = [
    ...BILLING_STRIPE_SUBSCRIPTION_SYNC_EVENT_TYPES,
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "payment_intent.succeeded",
    "checkout.session.completed",
    "refund.created",
] as const;

export type BillingStripeWebhookEventType = (typeof BILLING_STRIPE_WEBHOOK_EVENT_TYPES)[number];
