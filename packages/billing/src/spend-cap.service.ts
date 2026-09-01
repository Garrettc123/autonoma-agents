import { Prisma, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { isUniqueConstraintError } from "./billing-utils";
import { Service } from "./service";
import type { BillingAlertNotifier, SpendCapStatus } from "./types";

type TxClient = Prisma.TransactionClient;
type RawTxClient = TxClient & Pick<PrismaClient, "$queryRaw">;
/**
 * The slice of a client {@link SpendCapService.recordRefund} needs, so a caller can hand it the
 * transaction that revoked the credits instead of a standalone connection.
 */
type RawExecutor = Pick<PrismaClient, "$executeRaw">;

/** 50/80/100% - hardcoded for v1, not admin-configurable. */
const ALERT_THRESHOLDS: readonly (50 | 80 | 100)[] = [50, 80, 100];

interface ReservationResult {
    eligible: boolean;
    periodId?: string;
}

type SpendReservationRow = {
    inserted_count: bigint;
    period_id: string | null;
    amount_charged_cents: number | null;
    cap_amount_cents: number | null;
    threshold_before: number | null;
    threshold_after: number | null;
};

/**
 * Enforces `BillingCustomer.spendCapAmountCents` - a self-serve, per-calendar-month USD ceiling on
 * top-up spend (manual purchases + auto-top-up combined) - and fires threshold alerts as an org
 * approaches it. Distinct from `VercelOverageService`'s cap: that one proactively grants an
 * internal credit ledger entry (fully atomic, nothing external can fail after the DB commits);
 * this one gates a real Stripe charge that happens outside the DB transaction, so the two charge
 * paths get different treatment:
 *
 * - Auto-top-up is the one path this service fully controls: {@link reserveForAutoTopUp} reserves
 *   the spend BEFORE the Stripe call, {@link releaseReservation} compensates if the charge fails.
 * - Manual Checkout cannot be reserved this way - Stripe Checkout is a hosted, human-paced
 *   redirect, so by the time the charge is confirmed (webhook) the card has already been charged.
 *   {@link checkCheckoutEligibility} is the only intervention point (refusing to *create* the
 *   Checkout Session), and {@link recordManualCharge} just records what already happened. This
 *   leaves a small human-speed race (two tabs open near the cap boundary) that is not solved here.
 */
export class SpendCapService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly alertNotifier: BillingAlertNotifier,
    ) {
        super();
    }

    async getStatus(organizationId: string): Promise<SpendCapStatus> {
        const { periodKey, endDate } = currentPeriodBounds();
        const [customer, period] = await Promise.all([
            this.db.billingCustomer.findUnique({ where: { organizationId }, select: { spendCapAmountCents: true } }),
            this.db.billingTopupSpendPeriod.findUnique({
                where: { organizationId_periodKey: { organizationId, periodKey } },
                select: { amountChargedCents: true },
            }),
        ]);

        return {
            capAmountCents: customer?.spendCapAmountCents ?? undefined,
            amountChargedCentsThisPeriod: period?.amountChargedCents ?? 0,
            periodKey,
            periodEnd: endDate,
        };
    }

    async updateCap(organizationId: string, capAmountCents: number | undefined): Promise<void> {
        const customer = await this.db.billingCustomer.findUnique({ where: { organizationId }, select: { id: true } });
        if (customer == null) throw new NotFoundError("No billing customer found for this organization");

        await this.db.billingCustomer.update({
            where: { organizationId },
            data: { spendCapAmountCents: capAmountCents },
        });
        this.logger.info("Updated spend cap", { organizationId, capAmountCents });
    }

    /**
     * Read-only pre-flight for a manual Checkout purchase - never reserves anything (the org may
     * abandon the session), just refuses to *create* one that would already be over cap.
     */
    async checkCheckoutEligibility(organizationId: string, priceCents: number): Promise<{ allowed: boolean }> {
        const status = await this.getStatus(organizationId);
        if (status.capAmountCents == null) return { allowed: true };
        return { allowed: status.amountChargedCentsThisPeriod + priceCents <= status.capAmountCents };
    }

    /**
     * Atomically reserves `priceCents` of spend for an auto-top-up charge about to be attempted,
     * before calling Stripe. Ensures the current period row exists, then locks the org's cap and
     * that row `FOR UPDATE` so two concurrent auto-top-up attempts can't both slip under the cap.
     * Fires the alert notifier (best-effort, after the transaction commits) when this reservation
     * just crossed a new threshold.
     */
    async reserveForAutoTopUp(organizationId: string, priceCents: number): Promise<ReservationResult> {
        const { periodId, periodEnd } = await this.ensurePeriodRow(organizationId);

        const { crossedThreshold, ...result } = await this.db.$transaction(async (tx) => {
            const rawTx = tx as RawTxClient;
            const [row] = await rawTx.$queryRaw<Array<SpendReservationRow>>`
                WITH locked_customer AS (
                    SELECT spend_cap_amount_cents
                    FROM billing_customer
                    WHERE organization_id = ${organizationId}
                    FOR UPDATE
                ),
                locked_period AS (
                    SELECT id, amount_charged_cents, last_alert_threshold_sent
                    FROM billing_topup_spend_period
                    WHERE id = ${periodId}
                    FOR UPDATE
                ),
                eligible AS (
                    SELECT locked_period.id, locked_period.amount_charged_cents, locked_period.last_alert_threshold_sent,
                           locked_customer.spend_cap_amount_cents
                    FROM locked_period, locked_customer
                    WHERE locked_customer.spend_cap_amount_cents IS NULL
                       OR locked_period.amount_charged_cents + ${priceCents} <= locked_customer.spend_cap_amount_cents
                ),
                updated AS (
                    UPDATE billing_topup_spend_period p
                    SET amount_charged_cents = eligible.amount_charged_cents + ${priceCents},
                        last_alert_threshold_sent = GREATEST(
                            eligible.last_alert_threshold_sent,
                            ${highestCrossedThresholdExpr(priceCents, "eligible.spend_cap_amount_cents", "eligible.amount_charged_cents")}
                        )
                    FROM eligible
                    WHERE p.id = eligible.id
                    RETURNING p.id, p.amount_charged_cents, p.last_alert_threshold_sent
                )
                SELECT
                    (SELECT COUNT(*)::bigint FROM eligible) AS inserted_count,
                    (SELECT id FROM updated) AS period_id,
                    (SELECT amount_charged_cents FROM updated) AS amount_charged_cents,
                    (SELECT spend_cap_amount_cents FROM eligible) AS cap_amount_cents,
                    (SELECT last_alert_threshold_sent FROM eligible) AS threshold_before,
                    (SELECT last_alert_threshold_sent FROM updated) AS threshold_after
            `;
            return toReservationOutcome(row);
        });

        if (crossedThreshold != null && result.eligible && result.periodId != null && result.capAmountCents != null) {
            await this.notifyThreshold(
                organizationId,
                crossedThreshold,
                result.capAmountCents,
                result.amountChargedCents ?? 0,
                periodEnd,
            );
        }

        return { eligible: result.eligible, periodId: result.periodId };
    }

    /** Compensating decrement - call when the Stripe charge reserved by {@link reserveForAutoTopUp} failed. */
    async releaseReservation(organizationId: string, periodId: string, priceCents: number): Promise<void> {
        await this.db.billingTopupSpendPeriod.update({
            where: { id: periodId },
            data: { amountChargedCents: { decrement: priceCents } },
        });
        this.logger.info("Released spend-cap reservation after a failed auto-top-up charge", {
            organizationId,
            periodId,
            priceCents,
        });
    }

    /**
     * Records a manual (Checkout) top-up purchase that has already been charged - there is nothing
     * left to gate, only to record and threshold-check. Returns the period key the charge landed in.
     *
     * Not idempotent, by design: nothing in the period row identifies which charge moved it, so a
     * second call for the same purchase silently doubles that purchase's draw on the cap. The caller
     * is responsible for calling this exactly once per charge - `CreditsService.grantTopupCredits`
     * does so by calling it only after the grant transaction actually committed the grant, which is
     * what makes a redelivered Stripe webhook a no-op here too.
     */
    async recordManualCharge(organizationId: string, priceCents: number): Promise<string> {
        const { periodId, periodKey, periodEnd } = await this.ensurePeriodRow(organizationId);

        const { crossedThreshold, ...result } = await this.db.$transaction(async (tx) => {
            const rawTx = tx as RawTxClient;
            const [row] = await rawTx.$queryRaw<Array<SpendReservationRow>>`
                WITH locked_customer AS (
                    SELECT spend_cap_amount_cents
                    FROM billing_customer
                    WHERE organization_id = ${organizationId}
                    FOR UPDATE
                ),
                locked_period AS (
                    SELECT id, amount_charged_cents, last_alert_threshold_sent
                    FROM billing_topup_spend_period
                    WHERE id = ${periodId}
                    FOR UPDATE
                ),
                context AS (
                    SELECT locked_period.id, locked_period.amount_charged_cents, locked_period.last_alert_threshold_sent,
                           locked_customer.spend_cap_amount_cents
                    FROM locked_period, locked_customer
                ),
                updated AS (
                    UPDATE billing_topup_spend_period p
                    SET amount_charged_cents = context.amount_charged_cents + ${priceCents},
                        last_alert_threshold_sent = GREATEST(
                            context.last_alert_threshold_sent,
                            ${highestCrossedThresholdExpr(priceCents, "context.spend_cap_amount_cents", "context.amount_charged_cents")}
                        )
                    FROM context
                    WHERE p.id = context.id
                    RETURNING p.id, p.amount_charged_cents, p.last_alert_threshold_sent
                )
                SELECT
                    1::bigint AS inserted_count,
                    (SELECT id FROM updated) AS period_id,
                    (SELECT amount_charged_cents FROM updated) AS amount_charged_cents,
                    (SELECT spend_cap_amount_cents FROM context) AS cap_amount_cents,
                    (SELECT last_alert_threshold_sent FROM context) AS threshold_before,
                    (SELECT last_alert_threshold_sent FROM updated) AS threshold_after
            `;
            return toReservationOutcome(row);
        });

        if (crossedThreshold != null && result.periodId != null && result.capAmountCents != null) {
            await this.notifyThreshold(
                organizationId,
                crossedThreshold,
                result.capAmountCents,
                result.amountChargedCents ?? 0,
                periodEnd,
            );
        }

        return periodKey;
    }

    /**
     * Reopens cap headroom in the period the original charge landed in, clamped at 0. The clamp and
     * the decrement happen in one statement so a concurrent charge on the same period row (a
     * reservation, a manual charge, or a second refund) can't be overwritten by a total computed
     * from a stale read - `GREATEST` in SQL rather than `Math.max` around a separate `findUnique`.
     *
     * Not idempotent on its own - it subtracts, so a second call for the same refund takes the
     * headroom back twice. Pass `client` the transaction that revokes the credits, whose unique
     * ledger id already refuses a redelivered webhook: rolling that transaction back takes this
     * decrement with it, which is what makes the pair exactly-once. Callers that cannot (no
     * transaction to join) keep the default and own the once-per-refund guarantee themselves.
     *
     * Lock order matters when joining a transaction: this touches `billing_topup_spend_period`, and
     * every other locker (`reserveForAutoTopUp`, `recordManualCharge`) takes `billing_customer`
     * first. A caller holding a `billing_customer` row lock is therefore in the right order; one
     * that later locks `billing_customer` would invert it and can deadlock.
     */
    async recordRefund(
        organizationId: string,
        periodKey: string | null,
        refundedPriceCents: number,
        client: RawExecutor = this.db,
    ): Promise<void> {
        if (periodKey == null) return;

        const updatedRows = await client.$executeRaw`
            UPDATE billing_topup_spend_period
            SET amount_charged_cents = GREATEST(0, amount_charged_cents - ${refundedPriceCents})
            WHERE organization_id = ${organizationId} AND period_key = ${periodKey}
        `;
        if (updatedRows === 0) {
            this.logger.warn("No spend period found for top-up refund, skipping cap reversal", {
                organizationId,
                periodKey,
            });
            return;
        }

        this.logger.info("Reversed spend-cap total for a top-up refund", {
            organizationId,
            periodKey,
            refundedPriceCents,
        });
    }

    /**
     * Ensures this org's current-calendar-month period row exists, without touching its total if
     * it already does. Two concurrent auto-top-up attempts can both see "no row yet" and race the
     * `upsert`'s create branch - only one insert wins, so the loser's `upsert` throws a unique
     * constraint violation rather than falling back to its update branch. Caught and re-read here
     * rather than left to bubble, since `reserveForAutoTopUp` relies on both racers reaching the
     * same, single period row for their `FOR UPDATE` lock to actually serialize them.
     */
    private async ensurePeriodRow(
        organizationId: string,
    ): Promise<{ periodId: string; periodKey: string; periodEnd: Date }> {
        const { periodKey, startDate, endDate } = currentPeriodBounds();

        try {
            const period = await this.db.billingTopupSpendPeriod.upsert({
                where: { organizationId_periodKey: { organizationId, periodKey } },
                create: { organizationId, periodKey, startDate, endDate },
                update: {},
                select: { id: true },
            });
            return { periodId: period.id, periodKey, periodEnd: endDate };
        } catch (error) {
            if (!isUniqueConstraintError(error)) throw error;

            const period = await this.db.billingTopupSpendPeriod.findUniqueOrThrow({
                where: { organizationId_periodKey: { organizationId, periodKey } },
                select: { id: true },
            });
            return { periodId: period.id, periodKey, periodEnd: endDate };
        }
    }

    private async notifyThreshold(
        organizationId: string,
        thresholdPercent: 50 | 80 | 100,
        capAmountCents: number,
        amountChargedCents: number,
        periodEnd: Date,
    ): Promise<void> {
        try {
            await this.alertNotifier.notifySpendCapThreshold({
                organizationId,
                thresholdPercent,
                capAmountCents,
                amountChargedCents,
                periodEnd,
            });
        } catch (error) {
            this.logger.warn("Failed to send spend-cap threshold alert", {
                organizationId,
                thresholdPercent,
                err: error,
            });
        }
    }
}

/**
 * The calendar-month period key a top-up charge granted right now would land in. Used by
 * `CreditsService.grantTopupCredits` to stamp `billingPeriodKey` on the `CreditTransaction` for the
 * refund path, on both top-up sources: auto-top-up reserved its spend via `reserveForAutoTopUp`
 * before the Stripe call, and a manual Checkout purchase records it via `recordManualCharge` after
 * the grant commits - so in neither case is the period row's identity available at the moment the
 * ledger row is written, and recomputing it here beats threading a periodId through a Stripe
 * round-trip. Assumes the grant lands in the same UTC month as the charge it records, true for both
 * near-immediate flows; a charge that happens to straddle a month boundary is an accepted,
 * undocumented-elsewhere edge, same posture as the Checkout race noted on the class doc.
 */
export function getCurrentSpendPeriodKey(): string {
    return currentPeriodBounds().periodKey;
}

/** UTC calendar month bounds - see BillingTopupSpendPeriod's doc comment for why this is the period unit. */
function currentPeriodBounds(): { periodKey: string; startDate: Date; endDate: Date } {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const periodKey = `${year}-${String(month + 1).padStart(2, "0")}`;
    const startDate = new Date(Date.UTC(year, month, 1));
    const endDate = new Date(Date.UTC(year, month + 1, 1));
    return { periodKey, startDate, endDate };
}

/**
 * A raw-SQL fragment computing the highest of {@link ALERT_THRESHOLDS} the NEW total
 * (`currentTotalRef + priceCents`) reaches as a percentage of the cap, or `0` if none - fed into
 * `GREATEST(previous_threshold, this)` so `last_alert_threshold_sent` only ever moves up, and a
 * charge that doesn't cross a new threshold leaves it unchanged. `0` when the cap is null
 * (uncapped) since there's nothing to alert against.
 *
 * WHEN clauses are checked highest-first: a `CASE` returns its first matching branch, and once an
 * org is already past 50%, every higher total is *also* past 50% - checking low-to-high would
 * match the 50% branch forever and the 80%/100% alerts would never fire.
 *
 * `capAmountRef`/`currentTotalRef` are `cte_alias.column` identifiers - callers must pass only
 * names they control (no user input), since {@link Prisma.raw} inlines them unescaped.
 */
function highestCrossedThresholdExpr(priceCents: number, capAmountRef: string, currentTotalRef: string) {
    const capRef = Prisma.raw(capAmountRef);
    const totalRef = Prisma.raw(currentTotalRef);
    const descendingThresholds = [...ALERT_THRESHOLDS].sort((a, b) => b - a);
    const cases = descendingThresholds.map(
        (threshold) => Prisma.sql`WHEN ${capRef} IS NOT NULL
                AND (${totalRef} + ${priceCents}) * 100 >= ${capRef} * ${threshold}
            THEN ${threshold}`,
    );
    return Prisma.sql`(CASE ${Prisma.join(cases, " ")} ELSE 0 END)`;
}

function toReservationOutcome(row: SpendReservationRow | undefined): {
    eligible: boolean;
    periodId?: string;
    amountChargedCents?: number;
    capAmountCents?: number;
    crossedThreshold?: 50 | 80 | 100;
} {
    if (row == null || row.inserted_count === 0n || row.period_id == null) {
        return { eligible: false };
    }

    // Compared as values (not subtracted) so a first-ever crossing - where `threshold_before` is
    // NULL - is still detected, and so the result is one of the real threshold values rather than
    // an arithmetic difference between two of them.
    const crossedThreshold =
        row.threshold_after != null && row.threshold_after !== (row.threshold_before ?? null)
            ? assertAlertThreshold(row.threshold_after)
            : undefined;

    return {
        eligible: true,
        periodId: row.period_id,
        amountChargedCents: row.amount_charged_cents ?? undefined,
        capAmountCents: row.cap_amount_cents ?? undefined,
        crossedThreshold,
    };
}

function assertAlertThreshold(value: number): 50 | 80 | 100 | undefined {
    return ALERT_THRESHOLDS.find((threshold) => threshold === value);
}
