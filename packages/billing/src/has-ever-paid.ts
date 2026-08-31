import { CreditTransactionType, type PrismaClient, SubscriptionStatus } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { VercelInvoiceStatus } from "./vercel-invoice-status";

/** Stripe reports this once a subscription's invoice is settled; every other status is unpaid. */
const STRIPE_PAID_SUBSCRIPTION_STATUS = SubscriptionStatus.active;

/**
 * Whether money has ever actually reached us for this organization.
 *
 * The question a credit floor below zero depends on: overdrafting is extending credit, and credit
 * is only extended to someone who has settled a bill at least once. A free-start org that has
 * never paid must not be able to run into the red, however its floor is configured.
 *
 * Deliberately reads the authoritative per-rail records rather than inferring from the ledger,
 * because `SUBSCRIPTION_GRANT` cannot answer this on its own: `grantSubscriptionCredits` writes one
 * for a paid Stripe invoice, a paid Vercel cycle invoice, AND a **free** Vercel plan (which is
 * never invoiced at all - see `submitInvoiceForPeriod`'s `paymentMethodRequired` branch). Counting
 * that type would hand every free-plan org an overdraft.
 *
 * Three sources, one per way money arrives:
 *
 * - **Stripe top-ups** - `TOPUP_PURCHASE` rows only ever land after `payment_intent.succeeded`, so
 *   their existence is proof of a settled charge. Summed net of `TOPUP_REFUND` (stored negative) so
 *   an org refunded back to nothing loses the standing again, rather than keeping an overdraft it
 *   earned and then handed back.
 * - **Stripe subscription** - the one legacy subscriber pays by invoice, not by top-up, so it has
 *   no `TOPUP_PURCHASE` to find.
 * - **Vercel invoices** - covers both kinds: the cycle invoice for a paid plan and the off-cycle
 *   invoice a credit purchase raises. `paidAt` is set only when Vercel reports it settled, which is
 *   what makes a purchase that was granted-but-not-yet-collected correctly NOT count yet. A
 *   refunded invoice keeps its `paidAt` (it really was paid once), so the status is excluded
 *   explicitly - otherwise this rail would keep an overdraft alive after the money went back, which
 *   is exactly what the top-up rail's netting prevents.
 */
export async function hasEverPaid(db: PrismaClient, organizationId: string, logger: Logger): Promise<boolean> {
    const [customer, netPaidTopupCredits, paidVercelInvoiceCount] = await Promise.all([
        db.billingCustomer.findUnique({
            where: { organizationId },
            select: { subscriptionStatus: true },
        }),
        db.creditTransaction.aggregate({
            where: {
                organizationId,
                type: { in: [CreditTransactionType.TOPUP_PURCHASE, CreditTransactionType.TOPUP_REFUND] },
            },
            _sum: { amount: true },
        }),
        db.vercelInvoice.count({
            where: {
                installation: { organizationId },
                paidAt: { not: null },
                status: { not: VercelInvoiceStatus.Refunded },
            },
        }),
    ]);

    const boughtTopupCredits = (netPaidTopupCredits._sum.amount ?? 0) > 0;
    const paysBySubscription = customer?.subscriptionStatus === STRIPE_PAID_SUBSCRIPTION_STATUS;
    const settledVercelInvoice = paidVercelInvoiceCount > 0;
    const paid = boughtTopupCredits || paysBySubscription || settledVercelInvoice;

    logger.info("Resolved whether organization has ever paid", {
        organizationId,
        extra: { paid, boughtTopupCredits, paysBySubscription, settledVercelInvoice },
    });

    return paid;
}
