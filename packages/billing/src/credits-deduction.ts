import { Prisma, type PrismaClient } from "@autonoma/db";
import type { CreditTransactionType } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { isUniqueConstraintError } from "./billing-utils";
import { maybeTriggerAutoTopUp } from "./maybe-trigger-auto-top-up";

type TxClient = Prisma.TransactionClient;
type RawTxClient = TxClient & Pick<PrismaClient, "$queryRaw">;

type DeductCreditsFlooredResultRow = {
    inserted_count: bigint;
    whole_credits: number | null;
    old_balance: number | null;
    new_balance: number | null;
    new_subscription_balance: number | null;
    kill_jobs_on_credit_exhaustion: boolean | null;
    credit_floor: number | null;
    unlimited_credits: boolean | null;
};

/** Which extra column on `credit_transaction` links this deduction back to the exact row it charges for. */
export interface CreditTransactionFkColumn {
    name: "ai_cost_record_id" | "previewkit_app_build_id" | "usage_window_id";
    value: string;
}

export interface DeductCreditsFlooredParams {
    organizationId: string;
    transactionId: string;
    transactionType: CreditTransactionType;
    /**
     * What to charge, in MILLIONTHS of a credit. Whole-credit callers pass
     * `credits * MICRO_CREDITS_PER_CREDIT`; only metered compute, whose 15-minute windows each
     * cost a fraction of a credit, passes a value that is not a whole multiple.
     *
     * Sub-credit amounts are not rounded up. They accumulate on the org's
     * `creditRemainderMicros` and are deducted as whole credits once they add up to one, so a
     * fleet of previews is billed for what it consumed instead of a minimum of one credit per
     * window (which overcharged 3-4x at observed usage).
     */
    costMicroCredits: number;
    fkColumn: CreditTransactionFkColumn;
}

export interface DeductCreditsFlooredResult {
    /** Whether this call was the one that recorded the charge (false on an idempotent retry). */
    deducted: boolean;
    /**
     * Whole credits this charge recorded on the ledger. Zero when the charge only moved the carry.
     * For a billing-exempt org this is what the usage WOULD have cost - the balance itself is
     * frozen, so it is not what left the wallet.
     */
    creditsDeducted?: number;
    newBalance?: number;
    /**
     * True when this deduction just pushed a zero-tolerance org (`killJobsOnCreditExhaustion`) from
     * above its floor to at-or-below it - the signal callers use to kill whatever job caused it,
     * instead of the default "let it finish, floor-clamped" behavior. Always false for an org that
     * hasn't opted into kill-mode, or one that was already at/below its floor before this deduction
     * (no *new* crossing to react to).
     */
    crossedIntoExhaustion: boolean;
    /**
     * True when the org is billing-exempt (`unlimitedCredits`): the charge was written to the
     * ledger but neither balance moved. Never true and `crossedIntoExhaustion` true together.
     */
    unlimitedCredits: boolean;
}

/**
 * Deducts `cost` credits from an org's balance, clamped at the org's own `BillingCustomer.creditFloor`
 * rather than requiring sufficiency - an already-running PR's jobs (AI calls, builds, running compute)
 * always get charged in full and never get half-billed mid-flight. Every org defaults to a floor of 0
 * (today's zero-clamp behavior, unchanged), raised only by a deliberate admin action.
 *
 * A billing-exempt org (`unlimitedCredits`) is charged on the ledger and nowhere else: the
 * `credit_transaction` row is written with the real cost, both balances stay put, and the sub-credit
 * carry still advances so successive charges accrue at true cost rather than drifting.
 *
 * Generalizes the floor-at-zero CTE pattern shared by `deductCreditsForLlmProxy`/
 * `deductCreditsForPreviewUsage`: same `FOR UPDATE` lock on `billing_customer`, same
 * `ON CONFLICT (id) DO NOTHING` idempotency on a deterministic `transactionId`, same proportional
 * `subscription_credit_balance` consumption (which still floors at 0 - only the combined
 * `credit_balance` gets the org's configurable floor). `fkColumn` is one of a small, code-controlled
 * set of column names, safe to splice as a raw identifier since it's never user input.
 *
 * A successful deduction also runs the org's auto top-up check. That lives here, on the shared
 * primitive, rather than at each call site so that a new consumption path gets it by construction:
 * the two newest paths (AI cost, previewkit build usage) call this function directly instead of
 * going through `CreditsService`, and would otherwise let an org with auto top-up enabled drain
 * past its threshold to its floor without ever recharging.
 */
export async function deductCreditsFloored(
    db: PrismaClient,
    params: DeductCreditsFlooredParams,
    logger: Logger,
): Promise<DeductCreditsFlooredResult> {
    const { organizationId, transactionId, transactionType, costMicroCredits, fkColumn } = params;
    // Bound as text and cast, not as a number: a large charge in millionths exceeds int4, and
    // the carry arithmetic below must not silently overflow.
    const costMicros = String(Math.round(costMicroCredits));

    const result = await db
        .$transaction(async (tx) => {
            const rawTx = tx as RawTxClient;
            const fkColumnIdentifier = Prisma.raw(fkColumn.name);
            const [result] = await rawTx.$queryRaw<Array<DeductCreditsFlooredResultRow>>`
                WITH customer AS (
                    SELECT
                        organization_id,
                        credit_balance,
                        subscription_credit_balance,
                        credit_remainder_micros,
                        credit_floor,
                        kill_jobs_on_credit_exhaustion,
                        unlimited_credits
                    FROM billing_customer
                    WHERE organization_id = ${organizationId}
                    FOR UPDATE
                ),
                -- This charge plus whatever sub-credit consumption was carried forward, split
                -- into the whole credits to take now and the remainder to carry on. Integer
                -- division truncates, and both operands are non-negative, so this floors.
                accrued AS (
                    SELECT
                        organization_id,
                        credit_balance,
                        subscription_credit_balance,
                        credit_floor,
                        kill_jobs_on_credit_exhaustion,
                        unlimited_credits,
                        ((credit_remainder_micros::bigint + ${costMicros}::bigint) / 1000000)::int
                            AS whole_credits,
                        ((credit_remainder_micros::bigint + ${costMicros}::bigint) % 1000000)::int
                            AS new_remainder_micros
                    FROM customer
                ),
                -- Where the two balances land once this charge is applied. A billing-exempt org
                -- keeps both untouched: the transaction row below still records the full cost, so
                -- the ledger stays a complete usage record while the wallet never moves.
                eligible AS (
                    SELECT
                        *,
                        CASE
                            WHEN unlimited_credits THEN credit_balance
                            ELSE GREATEST(credit_balance - whole_credits, credit_floor)
                        END AS next_balance,
                        CASE
                            WHEN unlimited_credits THEN subscription_credit_balance
                            ELSE GREATEST(
                                subscription_credit_balance - LEAST(subscription_credit_balance, whole_credits),
                                0
                            )
                        END AS next_subscription_balance
                    FROM accrued
                ),
                -- Written even when whole_credits is 0: the row is what makes this idempotent, so
                -- a retried window must not be able to advance the carry a second time.
                inserted AS (
                    INSERT INTO credit_transaction (
                        id,
                        organization_id,
                        type,
                        amount,
                        balance_after,
                        ${fkColumnIdentifier}
                    )
                    SELECT
                        ${transactionId},
                        organization_id,
                        ${transactionType}::credit_transaction_type,
                        -whole_credits,
                        next_balance,
                        ${fkColumn.value}
                    FROM eligible
                    ON CONFLICT (id) DO NOTHING
                    RETURNING id
                ),
                updated AS (
                    UPDATE billing_customer bc
                    SET
                        credit_balance = eligible.next_balance,
                        subscription_credit_balance = eligible.next_subscription_balance,
                        credit_remainder_micros = eligible.new_remainder_micros
                    FROM eligible
                    WHERE bc.organization_id = eligible.organization_id
                      AND EXISTS (SELECT 1 FROM inserted)
                    RETURNING bc.credit_balance, bc.subscription_credit_balance
                )
                SELECT
                    (SELECT COUNT(*)::bigint FROM inserted) AS inserted_count,
                    (SELECT whole_credits FROM eligible LIMIT 1) AS whole_credits,
                    (SELECT credit_balance FROM eligible LIMIT 1) AS old_balance,
                    (SELECT credit_balance FROM updated LIMIT 1) AS new_balance,
                    (SELECT subscription_credit_balance FROM updated LIMIT 1) AS new_subscription_balance,
                    (SELECT kill_jobs_on_credit_exhaustion FROM eligible LIMIT 1) AS kill_jobs_on_credit_exhaustion,
                    (SELECT credit_floor FROM eligible LIMIT 1) AS credit_floor,
                    (SELECT unlimited_credits FROM eligible LIMIT 1) AS unlimited_credits
            `;

            if (result == null) {
                logger.warn("Floored deduction query returned no result row", { organizationId, transactionId });
                return { deducted: false, crossedIntoExhaustion: false, unlimitedCredits: false };
            }

            if (result.inserted_count === 0n) {
                logger.info("Floored deduction already recorded, skipping", { organizationId, transactionId });
                return { deducted: false, crossedIntoExhaustion: false, unlimitedCredits: false };
            }

            const crossedIntoExhaustion =
                result.unlimited_credits !== true &&
                result.kill_jobs_on_credit_exhaustion === true &&
                result.old_balance != null &&
                result.new_balance != null &&
                result.credit_floor != null &&
                result.old_balance > result.credit_floor &&
                result.new_balance <= result.credit_floor;

            logger.info("Deducted credits (floored)", {
                organizationId,
                transactionId,
                transactionType,
                extra: {
                    costMicroCredits,
                    creditsCharged: result.whole_credits,
                    unlimitedCredits: result.unlimited_credits === true,
                },
                newBalance: result.new_balance,
                crossedIntoExhaustion,
            });
            return {
                deducted: true,
                creditsDeducted: result.whole_credits ?? undefined,
                newBalance: result.new_balance ?? undefined,
                crossedIntoExhaustion,
                unlimitedCredits: result.unlimited_credits === true,
            };
        })
        .catch((error: unknown) => {
            if (isUniqueConstraintError(error)) {
                logger.info("Floored deduction already recorded, skipping", { organizationId, transactionId });
                return { deducted: false, crossedIntoExhaustion: false, unlimitedCredits: false };
            }
            throw error;
        });

    // After the commit, never inside it: the recharge re-reads the balance this deduction just
    // wrote and calls Stripe, and neither may happen while the `billing_customer` row lock is held.
    // `AutoTopUpService` skips billing-exempt orgs too; this check just avoids the round trip.
    if (result.deducted && !result.unlimitedCredits) {
        await maybeTriggerAutoTopUp(db, organizationId, logger);
    }

    return result;
}
