import type { BillingAlertNotifier } from "@autonoma/billing";
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

    async notifySpendCapThreshold(input: {
        organizationId: string;
        thresholdPercent: 50 | 80 | 100;
        capAmountCents: number;
        amountChargedCents: number;
        periodEnd: Date;
    }): Promise<void> {
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
