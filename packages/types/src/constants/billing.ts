export const BILLING_CHECKOUT_TYPES = {
    SUBSCRIPTION: "subscription",
    TOPUP: "topup",
} as const;

export type BillingCheckoutType = (typeof BILLING_CHECKOUT_TYPES)[keyof typeof BILLING_CHECKOUT_TYPES];

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
