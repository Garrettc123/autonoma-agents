import type {
    AutoTopUpFailedAlert,
    AutoTopUpFailureReasonValue,
    BillingAlertNotifier,
    SpendCapThresholdAlert,
} from "@autonoma/billing";
import type { PrismaClient } from "@autonoma/db";
import { logger, type Logger } from "@autonoma/logger";
import { env } from "../env";
import { BRAND, FONT_FAMILY, escapeHtml, renderBrandedEmail } from "./brand";
import { buildEmailSender, type EmailSender } from "./email-sender";

function formatUsd(cents: number): string {
    return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function formatPeriodEnd(periodEnd: Date): string {
    return periodEnd.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * Sends the 50/80/100% spend-cap threshold email to an org's owners - there is no separate
 * "billing contact" concept in this schema, `Member.role` is the only accountability signal that
 * exists today, same as every other owner-scoped notification here.
 */
export class ResendBillingAlertNotifier implements BillingAlertNotifier {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly emailSender: EmailSender,
        private readonly appUrl: string,
        private readonly fromEmail: string,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async notifySpendCapThreshold(input: SpendCapThresholdAlert): Promise<void> {
        const { organizationId, thresholdPercent, capAmountCents, amountChargedCents, periodEnd } = input;
        this.logger.info("Sending spend-cap threshold alert", { organizationId, thresholdPercent });

        const [organization, owners] = await Promise.all([
            this.db.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
            this.db.member.findMany({
                where: { organizationId, role: "owner" },
                select: { user: { select: { email: true } } },
            }),
        ]);

        if (organization == null || owners.length === 0) {
            this.logger.warn("No organization or owners found for spend-cap alert, skipping", {
                organizationId,
                thresholdPercent,
            });
            return;
        }

        const email = this.buildEmail({
            organizationName: organization.name,
            thresholdPercent,
            capAmountCents,
            amountChargedCents,
            periodEnd,
        });

        await Promise.all(
            owners.map((owner) =>
                this.emailSender.send({ ...email, to: owner.user.email }).catch((err: unknown) => {
                    this.logger.warn("Failed to send spend-cap alert to an owner", {
                        organizationId,
                        thresholdPercent,
                        err,
                    });
                }),
            ),
        );
    }

    /**
     * The recharge the organization configured did not happen, so its balance keeps falling and
     * nothing will stop it. Sent to owners for the same reason the spend-cap alert is: `Member.role`
     * is the only accountability signal this schema has.
     */
    async notifyAutoTopUpFailed(input: AutoTopUpFailedAlert): Promise<void> {
        const { organizationId, reason } = input;
        this.logger.info("Sending auto top-up failure alert", { organizationId, extra: { reason } });

        const [organization, owners] = await Promise.all([
            this.db.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
            this.db.member.findMany({
                where: { organizationId, role: "owner" },
                select: { user: { select: { email: true } } },
            }),
        ]);

        if (organization == null || owners.length === 0) {
            this.logger.warn("No organization or owners found for auto top-up failure alert, skipping", {
                organizationId,
                extra: { reason },
            });
            return;
        }

        const email = this.buildAutoTopUpFailedEmail(organization.name, reason);

        await Promise.all(
            owners.map((owner) =>
                this.emailSender.send({ ...email, to: owner.user.email }).catch((err: unknown) => {
                    this.logger.warn("Failed to send auto top-up failure alert to an owner", {
                        organizationId,
                        extra: { reason },
                        err,
                    });
                }),
            ),
        );
    }

    private buildAutoTopUpFailedEmail(
        organizationName: string,
        reason: AutoTopUpFailureReasonValue,
    ): { subject: string; html: string; from: string } {
        const safeOrg = escapeHtml(organizationName);
        const billingUrl = new URL("/billing", this.appUrl).toString();
        const isMissingCard = reason === "no_payment_method";

        const cause = isMissingCard
            ? "There is no saved payment method to charge."
            : "The saved payment method was declined.";
        const fix = isMissingCard
            ? "Buy a credit package once to save a card, and automatic top-up will use it from then on."
            : "Update the payment method, then buy a package to confirm the new card works.";

        return {
            from: this.fromEmail,
            subject: `${safeOrg}: automatic top-up did not go through`,
            html: renderBrandedEmail({
                eyebrow: "Automatic top-up failed",
                heading: "Your credits were not topped up",
                subheading: `${safeOrg} fell below its automatic top-up threshold, but the recharge could not be completed. ${cause}`,
                contentHtml: `                    <p style="color: ${BRAND.text}; font-size: 16px; line-height: 26px; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">Until this is resolved the balance keeps falling, and new test runs, preview deploys and PR analysis stop once it reaches zero. Anything already running finishes and is charged in full.</p>

                    <p style="color: ${BRAND.muted}; font-size: 15px; line-height: 24px; margin: 0 0 24px 0; font-family: ${FONT_FAMILY};">${fix}</p>

                    <div style="margin: 0 0 24px 0;">
                        <a href="${billingUrl}" style="background-color: ${BRAND.accent}; color: ${BRAND.accentForeground}; padding: 14px 22px; text-decoration: none; font-size: 14px; font-weight: 700; font-family: ${FONT_FAMILY}; display: inline-block;">Review billing settings</a>
                    </div>`,
            }),
        };
    }

    private buildEmail(input: {
        organizationName: string;
        thresholdPercent: 50 | 80 | 100;
        capAmountCents: number;
        amountChargedCents: number;
        periodEnd: Date;
    }): { subject: string; html: string; from: string } {
        const { organizationName, thresholdPercent, capAmountCents, amountChargedCents, periodEnd } = input;
        const safeOrg = escapeHtml(organizationName);
        const billingUrl = new URL("/billing", this.appUrl).toString();
        const isAtCap = thresholdPercent >= 100;

        const eyebrow = isAtCap ? "Spend cap reached" : "Spend cap alert";
        const heading = isAtCap
            ? "Your top-up spend cap has been reached"
            : `You've used ${thresholdPercent}% of your top-up spend cap`;

        return {
            from: this.fromEmail,
            subject: `${safeOrg}: ${isAtCap ? "spend cap reached" : `${thresholdPercent}% of spend cap used`}`,
            html: renderBrandedEmail({
                eyebrow,
                heading,
                subheading: `${safeOrg} has charged ${formatUsd(amountChargedCents)} of its ${formatUsd(capAmountCents)} monthly top-up spend cap.`,
                contentHtml: `                    <p style="color: ${BRAND.text}; font-size: 16px; line-height: 26px; margin: 0 0 16px 0; font-family: ${FONT_FAMILY};">${
                    isAtCap
                        ? "No further top-up purchases or auto top-up charges will go through this period until the cap is raised or the period rolls over."
                        : "This is an early warning - nothing has been blocked yet."
                }</p>

                    <p style="color: ${BRAND.muted}; font-size: 15px; line-height: 24px; margin: 0 0 24px 0; font-family: ${FONT_FAMILY};">This period ends on ${formatPeriodEnd(periodEnd)}.</p>

                    <div style="margin: 0 0 24px 0;">
                        <a href="${billingUrl}" style="background-color: ${BRAND.accent}; color: ${BRAND.accentForeground}; padding: 14px 22px; text-decoration: none; font-size: 14px; font-weight: 700; font-family: ${FONT_FAMILY}; display: inline-block;">Review billing settings</a>
                    </div>`,
            }),
        };
    }
}

/**
 * Centralizes notifier construction so `build-services.ts` (request-scoped billing) and
 * `stripe-http.router.ts` (the Stripe webhook path) share one build instead of each
 * hand-rolling it.
 */
export function buildBillingAlertNotifier(db: PrismaClient, emailSender?: EmailSender): ResendBillingAlertNotifier {
    return new ResendBillingAlertNotifier(
        db,
        emailSender ?? buildEmailSender(env.RESEND_API_KEY, env.RESEND_FROM_EMAIL),
        env.APP_URL,
        env.RESEND_FROM_EMAIL,
    );
}
