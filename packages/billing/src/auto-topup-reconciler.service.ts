import type { PrismaClient } from "@autonoma/db";
import type { AutoTopUpService } from "./auto-topup.service";
import type { BillingTopupPackageService } from "./billing-topup-package.service";
import { Service } from "./service";
import type { SpendCapService } from "./spend-cap.service";

/**
 * Bounds one run. The candidate set is every organization currently below its recharge threshold,
 * which is small in practice - this is a runaway guard, not a real page size. Least-recently-touched
 * first, so a fleet past the cap rotates through its backlog across runs rather than starving the
 * tail.
 */
const CANDIDATE_LIMIT = 500;

/**
 * How long a recorded auto-top-up failure suppresses further attempts. Without it a card that will
 * keep declining until a human replaces it is retried on every tick - at a 15-minute cadence that is
 * ~96 Stripe charges and ~96 customer notifications a day, for an outcome that cannot change.
 */
const FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;

type ReconcileOutcome = "attempted" | "recentFailure" | "spendCapReached" | "packageUnavailable";

export interface AutoTopUpReconcileResult {
    candidates: number;
    attempted: number;
    recentFailure: number;
    spendCapReached: number;
    packageUnavailable: number;
}

interface ReconcileCandidate {
    organizationId: string;
    autoTopUpPackageId: string | null;
    autoTopUpLastFailureAt: Date | null;
}

/**
 * Level-triggered safety net for auto top-up.
 *
 * `maybeTriggerAutoTopUp` is edge-triggered - it only runs after a deduction. That misses every case
 * where a recharge *becomes* possible without one, and the worst is routine: an organization that
 * exhausts both its balance and its monthly spend cap is blocked at the credit gate, so nothing
 * deducts, so nothing triggers - and when the calendar month rolls over and the cap frees up, no
 * deduction arrives to notice. It stays blocked with a live card, an enabled recharge and a full
 * cap until a human buys manually. A card replaced after a decline, and a package reactivated after
 * being pulled, have the same shape.
 *
 * This sweeps the state rather than reacting to a transition: an organization that *should* be
 * recharged is, within one tick, regardless of what did or did not happen to it. The deduction hook
 * stays as the fast path - it recharges within seconds, mid-run - and this only catches what that
 * missed.
 *
 * The checks below decide nothing. `AutoTopUpService` re-reads and re-checks every one of them, and
 * its spend-cap reservation is the atomic authority. They are here to keep a sweep cheap - skipping
 * an organization the cap will refuse avoids one Stripe round trip per tick per capped organization,
 * since the payment-method lookup happens before the reservation - and to apply the backoff, which
 * is the one rule that belongs to sweeping rather than to any single recharge.
 */
export class AutoTopUpReconciler extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly autoTopUpService: AutoTopUpService,
        private readonly packageService: BillingTopupPackageService,
        private readonly spendCapService: SpendCapService,
    ) {
        super();
    }

    async reconcile(): Promise<AutoTopUpReconcileResult> {
        this.logger.info("Starting auto top-up reconciliation");

        const candidates = await this.findCandidates();
        const result: AutoTopUpReconcileResult = {
            candidates: candidates.length,
            attempted: 0,
            recentFailure: 0,
            spendCapReached: 0,
            packageUnavailable: 0,
        };

        // Deliberately sequential rather than a Promise.all: every attempt can charge a real card,
        // and a burst of concurrent off-session PaymentIntents is both unkind to Stripe's rate
        // limits and much harder to read afterwards. The candidate set is small enough that the
        // wall-clock cost is not real.
        for (const candidate of candidates) {
            const outcome = await this.reconcileOne(candidate);
            result[outcome] += 1;
        }

        this.logger.info("Auto top-up reconciliation finished", { extra: { ...result } });
        return result;
    }

    private async findCandidates(): Promise<ReconcileCandidate[]> {
        return this.db.billingCustomer.findMany({
            where: {
                autoTopUpEnabled: true,
                stripeCustomerId: { not: null },
                autoTopUpPackageId: { not: null },
                creditBalance: { lt: this.db.billingCustomer.fields.autoTopUpThreshold },
            },
            select: { organizationId: true, autoTopUpPackageId: true, autoTopUpLastFailureAt: true },
            orderBy: { updatedAt: "asc" },
            take: CANDIDATE_LIMIT,
        });
    }

    private async reconcileOne(candidate: ReconcileCandidate): Promise<ReconcileOutcome> {
        const { organizationId } = candidate;

        if (this.isWithinFailureBackoff(candidate.autoTopUpLastFailureAt)) {
            this.logger.info("Auto top-up reconcile skipped - a recent attempt already failed", {
                organizationId,
                extra: { lastFailureAt: candidate.autoTopUpLastFailureAt },
            });
            return "recentFailure";
        }

        // Excluded by the query; re-checked because Prisma cannot narrow the selected type from it.
        if (candidate.autoTopUpPackageId == null) return "packageUnavailable";

        const topupPackage = await this.packageService.findById(candidate.autoTopUpPackageId);
        if (topupPackage == null || !topupPackage.isActive) {
            this.logger.warn("Auto top-up reconcile skipped - selected package is missing or deactivated", {
                organizationId,
                extra: { packageId: candidate.autoTopUpPackageId },
            });
            return "packageUnavailable";
        }

        const { allowed } = await this.spendCapService.checkCheckoutEligibility(
            organizationId,
            topupPackage.priceCents,
        );
        if (!allowed) {
            this.logger.info("Auto top-up reconcile skipped - the spend cap has no room for this package", {
                organizationId,
                extra: { packageId: topupPackage.id, priceCents: topupPackage.priceCents },
            });
            return "spendCapReached";
        }

        this.logger.info("Auto top-up reconcile recharging", {
            organizationId,
            extra: { packageId: topupPackage.id, priceCents: topupPackage.priceCents },
        });
        await this.autoTopUpService.triggerAutoTopUp(organizationId);
        return "attempted";
    }

    private isWithinFailureBackoff(lastFailureAt: Date | null): boolean {
        if (lastFailureAt == null) return false;
        return Date.now() - lastFailureAt.getTime() < FAILURE_BACKOFF_MS;
    }
}
