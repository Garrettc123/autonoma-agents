import { analytics } from "@autonoma/analytics";
import {
    CreditTransactionType,
    type Prisma,
    type PrismaClient,
    VercelBillingPeriodStatus,
    VercelInstallationStatus,
} from "@autonoma/db";
import { BadRequestError } from "@autonoma/errors";
import type { BillingTopupPackageService } from "./billing-topup-package.service";
import { isUniqueConstraintError } from "./billing-utils";
import { Service } from "./service";
import { getCurrentSpendPeriodKey, type SpendCapService } from "./spend-cap.service";
import type { VercelCreditPurchaseResult, VercelInvoiceSubmitter } from "./types";

/** Vercel's own status string for a settled invoice, as carried on `VercelInvoice.status`. */
const INVOICE_STATUS_PAID = "paid";
/** Vercel's status once the money has been handed back - see `processVercelInvoiceRefunded`. */
const INVOICE_STATUS_REFUNDED = "refunded";

/**
 * The invoice states that end a purchase's claim on the one-outstanding-at-a-time slot. Paid is the
 * obvious one; refunded is the other resolution - the money came and went, the credits go back with
 * it, and nothing is owed. Anything else (pending, failed) still holds the slot.
 */
const SETTLED_INVOICE_STATUSES = [INVOICE_STATUS_PAID, INVOICE_STATUS_REFUNDED];

/**
 * Lets a Vercel-billed org buy credits from the same `BillingTopupPackage` catalog a Stripe org
 * buys from - the piece that makes the Vercel rail pay-as-you-go rather than a fixed monthly
 * allotment that hard-stops when it runs out.
 *
 * **Sell now, collect now, but deliver immediately.** The credits are granted the moment the
 * customer buys, and an invoice is raised on Vercel in the same breath rather than waiting for the
 * cycle invoice up to 30 days later. That leaves a real but bounded exposure - the customer holds
 * credits before the money lands - and the bound is the rule enforced here: **exactly one
 * unpaid purchase at a time.** Until Vercel reports that invoice paid, the org cannot buy again,
 * so the most any org can walk away with is a single package.
 *
 * That bound is only worth as much as its enforcement, so it is enforced twice. {@link grant} takes
 * a row lock on the org's `billing_customer` before it re-reads the outstanding-purchase state, so
 * two sales racing on the same org serialise instead of both seeing a clean slate; and a partial
 * unique index on `vercel_credit_purchase (organization_id) WHERE invoice_id IS NULL` refuses the
 * second insert outright, for any path that ever grants without holding that lock.
 *
 * The ordering is deliberate: grant first, then invoice. If it were reversed, a failure after the
 * invoice call would leave a customer billed for credits they never received - the one outcome
 * worth avoiding outright. This way a failure leaves credits granted and the invoice still owed,
 * which the outstanding-purchase block makes visible and a retry can settle. The retry is safe to
 * repeat because the submission carries the purchase id as Vercel's `externalId`: a POST that
 * landed but whose invoice link never committed is rejected on the next sweep rather than billed
 * again.
 */
export class VercelCreditPurchaseService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly packageService: BillingTopupPackageService,
        private readonly spendCapService: SpendCapService,
        private readonly invoiceSubmitter?: VercelInvoiceSubmitter,
    ) {
        super();
    }

    public async purchase(organizationId: string, packageId: string): Promise<VercelCreditPurchaseResult> {
        this.logger.info("Purchasing Vercel credits", { organizationId, extra: { packageId } });

        // Nothing can raise an invoice on this host, so a sale here would be credits given away.
        if (this.invoiceSubmitter == null) {
            this.logger.warn("Vercel credit purchase unavailable - no invoice submitter configured", {
                organizationId,
            });
            return { purchased: false, reason: "not_supported" };
        }

        const topupPackage = await this.packageService.findById(packageId);
        if (topupPackage == null || !topupPackage.isActive) {
            throw new BadRequestError("Selected credit package is not available");
        }

        const installation = await this.db.vercelInstallation.findFirst({
            where: { organizationId, status: VercelInstallationStatus.active },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                accessTokenEnc: true,
            },
        });
        if (installation == null) {
            throw new BadRequestError("This organization is not billed through Vercel");
        }

        // The plan's `paymentMethodRequired` is deliberately NOT consulted. A plan that carries no
        // payment method still gets an invoice raised on it, and Vercel owns collecting against it -
        // a free plan means we have no card of theirs, not that the charge is uncollectable. What
        // bounds the risk is the one-unpaid-purchase rule below: an organization that never settles
        // walks away with a single package and cannot buy again.
        //
        // The access token is a different matter and still refused: it is what authorises the
        // invoice call, so without it there is no way to bill at all.
        if (installation.accessTokenEnc == null) {
            throw new BadRequestError("This Vercel installation cannot be invoiced");
        }

        const period = await this.db.vercelBillingPeriod.findFirst({
            where: { installationId: installation.id, status: VercelBillingPeriodStatus.active },
            orderBy: { startDate: "desc" },
            select: { id: true },
        });
        if (period == null) {
            throw new BadRequestError("No active Vercel billing period to bill this purchase to");
        }

        // Unlocked pre-flight, so the common refusal costs nothing and no spend is reserved only to
        // be released again. `grant` re-asks the same question under a lock - that is the answer
        // this decision actually rests on.
        if (await this.hasOutstandingPurchase(this.db, organizationId)) {
            this.logger.info("Vercel credit purchase refused - a previous purchase is still unpaid", {
                organizationId,
                extra: { packageId },
            });
            return { purchased: false, reason: "awaiting_payment" };
        }

        // Checks the ceiling and books the spend in one locked statement. A refusal here means the
        // purchase would breach the org's own cap, and nothing has been granted.
        const reservation = await this.spendCapService.reserveForAutoTopUp(organizationId, topupPackage.priceCents);
        if (!reservation.eligible) {
            this.logger.info("Vercel credit purchase refused by spend cap", {
                organizationId,
                extra: { packageId, priceCents: topupPackage.priceCents },
            });
            return { purchased: false, reason: "spend_cap_exceeded" };
        }

        const granted = await this.grantOrReleaseSpend(
            organizationId,
            installation.id,
            period.id,
            topupPackage,
            reservation.periodId,
        );
        if (granted == null) {
            this.logger.info("Vercel credit purchase refused under lock - a concurrent purchase is still unpaid", {
                organizationId,
                extra: { packageId },
            });
            return { purchased: false, reason: "awaiting_payment" };
        }

        const { purchaseId, newBalance } = granted;
        await this.raiseInvoice(organizationId, installation.id, period.id, purchaseId, topupPackage);

        this.logger.info("Purchased Vercel credits", {
            organizationId,
            extra: {
                packageId,
                creditsGranted: topupPackage.creditsGranted,
                priceCents: topupPackage.priceCents,
                newBalance,
            },
        });

        // The Vercel twin of `billing.topup_purchased`, so revenue analytics see both rails' sales
        // rather than only the Stripe one. Keyed on the organization for the same reason that event
        // is: a purchase belongs to the account being billed, and the webhook-driven Stripe path has
        // no user to attribute it to either.
        analytics.capture(organizationId, "billing.vercel_credits_purchased", {
            organizationId,
            purchaseId,
            packageId,
            packageName: topupPackage.name,
            creditsGranted: topupPackage.creditsGranted,
            priceCents: topupPackage.priceCents,
            newBalance,
        });
        return {
            purchased: true,
            creditsGranted: topupPackage.creditsGranted,
            priceCents: topupPackage.priceCents,
            newBalance,
        };
    }

    /**
     * Re-submits invoices for purchases whose invoice call failed at the point of sale. Those orgs
     * are holding credits nobody has billed for, and are blocked from buying again until this
     * clears, so a stuck row is both a revenue hole and a support ticket waiting to happen.
     *
     * Idempotent by construction, on both sides: a purchase drops out of the query the moment it
     * gets an invoice, and a resubmission carries the same `externalId` Vercel already holds, so a
     * purchase whose POST landed but whose link never committed is refused instead of billed twice.
     * One that fails again is simply picked up next run. Returns what it managed to settle so the
     * caller can log it.
     */
    public async retryUnbilledPurchases(limit: number): Promise<{ attempted: number; invoiced: number }> {
        if (this.invoiceSubmitter == null) {
            this.logger.warn("Cannot retry unbilled Vercel purchases - no invoice submitter configured");
            return { attempted: 0, invoiced: 0 };
        }

        const unbilled = await this.db.vercelCreditPurchase.findMany({
            where: { invoiceId: null },
            orderBy: { createdAt: "asc" },
            take: limit,
            select: {
                id: true,
                organizationId: true,
                installationId: true,
                billingPeriodId: true,
                creditsGranted: true,
                priceCents: true,
                topupPackage: { select: { name: true } },
            },
        });

        if (unbilled.length === 0) return { attempted: 0, invoiced: 0 };
        this.logger.info("Retrying unbilled Vercel credit purchases", { extra: { count: unbilled.length } });

        let invoiced = 0;
        for (const purchase of unbilled) {
            await this.raiseInvoice(
                purchase.organizationId,
                purchase.installationId,
                purchase.billingPeriodId,
                purchase.id,
                {
                    name: purchase.topupPackage.name,
                    creditsGranted: purchase.creditsGranted,
                    priceCents: purchase.priceCents,
                },
            );

            const settled = await this.db.vercelCreditPurchase.count({
                where: { id: purchase.id, invoiceId: { not: null } },
            });
            invoiced += settled;
        }

        this.logger.info("Retried unbilled Vercel credit purchases", {
            extra: { attempted: unbilled.length, invoiced },
        });
        return { attempted: unbilled.length, invoiced };
    }

    /**
     * Takes back the credits a refunded purchase invoice paid for, and reopens the spend-cap
     * headroom that purchase consumed. The Vercel mirror of `CreditsService.revokeTopupCredits`.
     *
     * Without this a refund is a way to keep credits for free: this rail grants before it collects,
     * so the money going back leaves the credits behind. That matters more here than on Stripe,
     * where the charge settles before anything is granted.
     *
     * Clamped at the current balance rather than driven negative, matching the Stripe path: an org
     * that already spent the credits keeps the work it did, and the refund takes back only what is
     * left. The alternative pushes an org into a debt it cannot see coming from a refund it may not
     * have asked for.
     *
     * Idempotent on a transaction id derived from the purchase, because a webhook is retried and
     * `processVercelInvoiceRefunded` has no way to tell a repeat from a new refund.
     */
    public async revokeForRefundedInvoice(vercelInvoiceId: string): Promise<void> {
        const purchase = await this.db.vercelCreditPurchase.findFirst({
            where: { invoice: { vercelInvoiceId } },
            select: { id: true, organizationId: true, creditsGranted: true, priceCents: true },
        });

        // Cycle invoices have no purchase behind them - they bill the plan, and nothing was granted
        // against them here.
        if (purchase == null) return;

        const transactionId = `ctr_vercel_purchase_revoke_${purchase.id}`;
        const grant = await this.db.creditTransaction.findUnique({
            where: { id: `ctr_vercel_purchase_${purchase.id}` },
            select: { billingPeriodKey: true },
        });

        // A unique violation on `transactionId` means a retried webhook: the whole transaction rolls
        // back with it, so neither the balance decrement nor the spend-cap reversal lands twice.
        const revoked = await this.db
            .$transaction(async (tx) => {
                // Locked before the balance is read, because the clamp below is computed in JS from
                // that read and then applied as a relative `decrement`. Unlocked, a deduction
                // committing in between makes the clamp stale - it is sized against a balance that
                // no longer exists, and the decrement takes the org negative, which is the debt from
                // a refund they did not ask for that the clamp exists to prevent. `grant` locks the
                // same row first, so the two serialise rather than deadlock.
                await tx.$queryRaw`SELECT id FROM billing_customer WHERE organization_id = ${purchase.organizationId} FOR UPDATE`;

                const customer = await tx.billingCustomer.findUnique({
                    where: { organizationId: purchase.organizationId },
                    select: { creditBalance: true },
                });
                if (customer == null) return 0;

                const amount = Math.min(customer.creditBalance, purchase.creditsGranted);
                if (amount <= 0) return 0;

                const updated = await tx.billingCustomer.update({
                    where: { organizationId: purchase.organizationId },
                    data: { creditBalance: { decrement: amount } },
                    select: { creditBalance: true },
                });

                // Negative row of the SAME type the grant used, so the pair nets to zero. A
                // `TOPUP_REFUND` here would read as a Stripe refund and skew `hasEverPaid`, which
                // sums that rail's purchases net of its refunds.
                await tx.creditTransaction.create({
                    data: {
                        id: transactionId,
                        organizationId: purchase.organizationId,
                        type: CreditTransactionType.VERCEL_TOPUP_GRANT,
                        amount: -amount,
                        balanceAfter: updated.creditBalance,
                    },
                });

                // Inside the transaction so the unique id above governs it too: `recordRefund`
                // subtracts, and a redelivered webhook rolls this decrement back with the ledger row
                // rather than reopening the headroom a second time. Safe on lock order - the update
                // above already holds this org's `billing_customer` row, which is the order every
                // other locker of `billing_topup_spend_period` uses.
                await this.spendCapService.recordRefund(
                    purchase.organizationId,
                    grant?.billingPeriodKey ?? null,
                    purchase.priceCents,
                    tx,
                );

                return amount;
            })
            .catch((error: unknown) => {
                if (isUniqueConstraintError(error)) {
                    this.logger.info("Refunded Vercel credit purchase already revoked, skipping", {
                        organizationId: purchase.organizationId,
                        extra: { purchaseId: purchase.id, vercelInvoiceId },
                    });
                    return 0;
                }
                throw error;
            });

        if (revoked === 0) {
            this.logger.info("Nothing to revoke for the refunded Vercel credit purchase", {
                organizationId: purchase.organizationId,
                extra: { purchaseId: purchase.id, vercelInvoiceId },
            });
            return;
        }

        this.logger.info("Revoked credits for a refunded Vercel credit purchase", {
            organizationId: purchase.organizationId,
            extra: { purchaseId: purchase.id, vercelInvoiceId, revoked, priceCents: purchase.priceCents },
        });
    }

    /**
     * True while the org holds credits it has not paid for: either an invoice that Vercel has not
     * reported paid, or a purchase whose invoice call never succeeded (`invoiceId` still null).
     * Both are money owed, so both block the next sale.
     */
    private async hasOutstandingPurchase(client: Prisma.TransactionClient, organizationId: string): Promise<boolean> {
        const outstanding = await client.vercelCreditPurchase.count({
            where: {
                organizationId,
                OR: [{ invoiceId: null }, { invoice: { status: { notIn: SETTLED_INVOICE_STATUSES } } }],
            },
        });
        return outstanding > 0;
    }

    /**
     * {@link grant}, plus the compensation the spend cap needs when it does not go through. The
     * reservation was booked against the org's monthly ceiling before this point, so a refusal or a
     * failure here has to hand that headroom back or the org loses it to a purchase that never
     * happened - the same reserve/release protocol `AutoTopUpService` follows around its Stripe call.
     */
    private async grantOrReleaseSpend(
        organizationId: string,
        installationId: string,
        billingPeriodId: string,
        topupPackage: { id: string; creditsGranted: number; priceCents: number },
        reservationPeriodId: string | undefined,
    ): Promise<{ purchaseId: string; newBalance: number } | undefined> {
        const release = async (): Promise<void> => {
            if (reservationPeriodId == null) return;
            await this.spendCapService.releaseReservation(organizationId, reservationPeriodId, topupPackage.priceCents);
        };

        try {
            const granted = await this.grant(organizationId, installationId, billingPeriodId, topupPackage);
            if (granted == null) await release();
            return granted;
        } catch (error) {
            await release();
            throw error;
        }
    }

    /**
     * Writes the purchase row, the ledger entry and the balance in one transaction, so a credited
     * balance can never exist without the row that records what is owed for it. `undefined` means
     * the org turned out to already hold an unpaid purchase and nothing was written.
     */
    private async grant(
        organizationId: string,
        installationId: string,
        billingPeriodId: string,
        topupPackage: { id: string; creditsGranted: number; priceCents: number },
    ): Promise<{ purchaseId: string; newBalance: number } | undefined> {
        return await this.db.$transaction(async (tx) => {
            // Serialises every sale for this org on one row, which is what makes the check below
            // authoritative: without it two concurrent calls both read "nothing outstanding" and
            // both grant, and the one-unpaid-purchase bound this whole flow rests on is gone. The
            // same row `SpendCapService.reserveForAutoTopUp` locks, taken in the same order, so the
            // two cannot deadlock against each other.
            await tx.$queryRaw`SELECT id FROM billing_customer WHERE organization_id = ${organizationId} FOR UPDATE`;

            if (await this.hasOutstandingPurchase(tx, organizationId)) return undefined;

            const purchase = await tx.vercelCreditPurchase.create({
                data: {
                    organizationId,
                    installationId,
                    billingPeriodId,
                    packageId: topupPackage.id,
                    creditsGranted: topupPackage.creditsGranted,
                    priceCents: topupPackage.priceCents,
                },
                select: { id: true },
            });

            const customer = await tx.billingCustomer.update({
                where: { organizationId },
                data: { creditBalance: { increment: topupPackage.creditsGranted } },
                select: { creditBalance: true },
            });

            await tx.creditTransaction.create({
                data: {
                    // Deterministic on the purchase row that funds it, matching every other grant.
                    id: `ctr_vercel_purchase_${purchase.id}`,
                    organizationId,
                    type: CreditTransactionType.VERCEL_TOPUP_GRANT,
                    amount: topupPackage.creditsGranted,
                    balanceAfter: customer.creditBalance,
                    topupPackageId: topupPackage.id,
                    // Which month's spend cap this charge was booked against, so a refund reopens the
                    // headroom in the period that lost it rather than whichever month it arrives in.
                    // Same reason the Stripe rail stamps it - see `grantTopupCredits`.
                    billingPeriodKey: getCurrentSpendPeriodKey(),
                },
            });

            return { purchaseId: purchase.id, newBalance: customer.creditBalance };
        });
    }

    /**
     * Bills Vercel for the purchase that was just granted. A failure here is logged rather than
     * thrown: the sale succeeded and the customer has their credits, so surfacing an error would
     * be misleading. The purchase stays `invoiceId: null`, which both blocks the next sale and
     * marks it for retry.
     */
    private async raiseInvoice(
        organizationId: string,
        installationId: string,
        billingPeriodId: string,
        purchaseId: string,
        topupPackage: { name: string; creditsGranted: number; priceCents: number },
    ): Promise<void> {
        try {
            const submission = await this.requireSubmitter().submitCreditPurchaseInvoice({
                purchaseId,
                installationId,
                billingPeriodId,
                packageName: topupPackage.name,
                creditsGranted: topupPackage.creditsGranted,
                priceCents: topupPackage.priceCents,
            });

            // An earlier attempt's POST reached Vercel but its linking transaction did not commit,
            // so the customer is already billed and there is nothing left to submit. Vercel's
            // duplicate rejection does not name the invoice it collided with, so the link cannot be
            // repaired from here - left `invoiceId: null` and reported loudly, since that keeps the
            // org blocked from buying again (the money is genuinely owed) until someone reconciles.
            if (submission.outcome === "already_submitted") {
                this.logger.error(
                    "Vercel credit purchase is already invoiced at Vercel but unlinked here - reconcile manually",
                    undefined,
                    { organizationId, extra: { purchaseId, priceCents: topupPackage.priceCents } },
                );
                return;
            }

            const { vercelInvoiceId } = submission;

            await this.db.$transaction(async (tx) => {
                const invoice = await tx.vercelInvoice.create({
                    data: {
                        vercelInvoiceId,
                        billingPeriodId,
                        installationId,
                        amount: (topupPackage.priceCents / 100).toFixed(2),
                        kind: "purchase",
                    },
                    select: { id: true },
                });
                await tx.vercelCreditPurchase.update({
                    where: { id: purchaseId },
                    data: { invoiceId: invoice.id },
                });
            });

            this.logger.info("Raised Vercel invoice for credit purchase", {
                organizationId,
                extra: { purchaseId, vercelInvoiceId },
            });
        } catch (err) {
            this.logger.error("Failed to raise Vercel invoice for a granted credit purchase", err, {
                organizationId,
                extra: { purchaseId, priceCents: topupPackage.priceCents },
            });
        }
    }

    private requireSubmitter(): VercelInvoiceSubmitter {
        const submitter = this.invoiceSubmitter;
        if (submitter == null) throw new Error("No Vercel invoice submitter configured");
        return submitter;
    }
}
