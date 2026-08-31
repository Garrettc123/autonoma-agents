import { AutoTopUpFailureReason, type PrismaClient } from "@autonoma/db";
import { BILLING_PAYMENT_INTENT_TYPES, BILLING_TOPUP_SOURCES } from "@autonoma/types";
import type { BillingTopupPackageService } from "./billing-topup-package.service";
import { buildAutoTopUpIdempotencyKey } from "./billing-utils";
import { Service } from "./service";
import type { SpendCapService } from "./spend-cap.service";
import { getStripe } from "./stripe-client";
import type { AutoTopUpFailureReasonValue, BillingAlertNotifier } from "./types";

export class AutoTopUpService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly packageService: BillingTopupPackageService,
        private readonly spendCapService: SpendCapService,
        /**
         * Only the API host has one that can send email; everywhere else this is absent and the
         * recorded failure on `BillingCustomer` is the whole notification. Optional rather than a
         * no-op default so a host that cannot email is obvious at the construction site.
         */
        private readonly alertNotifier?: BillingAlertNotifier,
    ) {
        super();
    }

    /**
     * Never throws. A recharge is a side effect of spending, not a precondition for it - by the time
     * this runs the credits are already deducted and the caller's real work already succeeded, so a
     * Stripe outage or an unconfigured `STRIPE_SECRET_KEY` (hosts that deduct but never charge, e.g.
     * the general worker) must not surface as a deduction failure.
     */
    async triggerAutoTopUp(organizationId: string) {
        try {
            await this.runAutoTopUp(organizationId);
        } catch (error) {
            this.logger.error("Auto top-up check failed", error, { organizationId });
        }
    }

    private async runAutoTopUp(organizationId: string) {
        const customer = await this.db.billingCustomer.findUnique({
            where: { organizationId },
        });

        if (customer == null) return;
        if (!customer.autoTopUpEnabled || customer.creditBalance >= customer.autoTopUpThreshold) return;
        if (customer.stripeCustomerId == null) {
            this.logger.warn("Auto top-up skipped: Stripe customer not linked yet", { organizationId });
            return;
        }
        if (customer.autoTopUpPackageId == null) {
            this.logger.warn("Auto top-up skipped: no package selected", { organizationId });
            return;
        }

        const topupPackage = await this.packageService.findById(customer.autoTopUpPackageId);
        if (topupPackage == null || !topupPackage.isActive) {
            this.logger.warn("Auto top-up skipped: selected package is missing or deactivated", {
                organizationId,
                packageId: customer.autoTopUpPackageId,
            });
            return;
        }

        this.logger.info("Triggering auto top-up", {
            organizationId,
            creditBalance: customer.creditBalance,
            threshold: customer.autoTopUpThreshold,
            packageId: topupPackage.id,
            priceCents: topupPackage.priceCents,
        });

        const stripe = getStripe();
        const paymentMethods = await stripe.customers.listPaymentMethods(customer.stripeCustomerId, { limit: 1 });
        const paymentMethod = paymentMethods.data[0];

        if (paymentMethod == null) {
            this.logger.warn("Auto top-up: no saved payment method found", { organizationId });
            await this.recordFailure(organizationId, AutoTopUpFailureReason.no_payment_method);
            return;
        }

        const reservation = await this.spendCapService.reserveForAutoTopUp(organizationId, topupPackage.priceCents);
        if (!reservation.eligible) {
            this.logger.info("Auto top-up skipped: would exceed spend cap", {
                organizationId,
                priceCents: topupPackage.priceCents,
            });
            return;
        }

        try {
            await stripe.paymentIntents.create(
                {
                    amount: topupPackage.priceCents,
                    currency: "usd",
                    customer: customer.stripeCustomerId,
                    payment_method: paymentMethod.id,
                    confirm: true,
                    off_session: true,
                    metadata: {
                        type: BILLING_PAYMENT_INTENT_TYPES.TOPUP,
                        organizationId,
                        packageId: topupPackage.id,
                        source: BILLING_TOPUP_SOURCES.AUTO,
                    },
                },
                {
                    idempotencyKey: buildAutoTopUpIdempotencyKey(organizationId),
                },
            );

            this.logger.info("Auto top-up payment intent created", { organizationId, packageId: topupPackage.id });
            await this.clearFailure(organizationId);
        } catch (error) {
            this.logger.error("Auto top-up payment failed", error, {
                organizationId,
                stripeCustomerId: customer.stripeCustomerId,
                threshold: customer.autoTopUpThreshold,
                creditBalance: customer.creditBalance,
                packageId: topupPackage.id,
            });

            await this.recordFailure(organizationId, AutoTopUpFailureReason.payment_declined);

            if (reservation.periodId != null) {
                await this.spendCapService.releaseReservation(
                    organizationId,
                    reservation.periodId,
                    topupPackage.priceCents,
                );
            }
        }
    }

    /**
     * Leaves a breadcrumb the customer can actually see, since this runs on hosts with no way to email
     * them. Best-effort on purpose: a recharge that already failed must not also throw, and losing the
     * breadcrumb is strictly better than turning a failed recharge into a failed deduction.
     */
    private async recordFailure(organizationId: string, reason: AutoTopUpFailureReasonValue): Promise<void> {
        try {
            await this.db.billingCustomer.update({
                where: { organizationId },
                data: { autoTopUpLastFailureReason: reason, autoTopUpLastFailureAt: new Date() },
            });
            await this.alertNotifier?.notifyAutoTopUpFailed({ organizationId, reason });
        } catch (err) {
            this.logger.warn("Could not record the auto top-up failure", { organizationId, extra: { reason }, err });
        }
    }

    /** `updateMany` so a customer with nothing recorded is a no-op rather than a needless write. */
    private async clearFailure(organizationId: string): Promise<void> {
        try {
            await this.db.billingCustomer.updateMany({
                where: { organizationId, autoTopUpLastFailureReason: { not: null } },
                data: { autoTopUpLastFailureReason: null, autoTopUpLastFailureAt: null },
            });
        } catch (err) {
            this.logger.warn("Could not clear the recorded auto top-up failure", { organizationId, err });
        }
    }
}
