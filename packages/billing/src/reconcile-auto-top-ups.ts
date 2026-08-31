import type { PrismaClient } from "@autonoma/db";
import { AutoTopUpReconciler, type AutoTopUpReconcileResult } from "./auto-topup-reconciler.service";
import { AutoTopUpService } from "./auto-topup.service";
import { BillingTopupPackageService } from "./billing-topup-package.service";
import { LoggingBillingAlertNotifier } from "./logging-billing-alert-notifier";
import { SpendCapService } from "./spend-cap.service";

/**
 * Composition root for {@link AutoTopUpReconciler}, for a caller holding a `PrismaClient` and
 * nothing else - today, the cronjob. Mirrors `maybeTriggerAutoTopUp`, and carries the same caveat:
 * this host has no email transport, so a recharge that fails here is recorded on `BillingCustomer`
 * (which the billing page renders) but not emailed, and a spend-cap threshold crossed by a recharge
 * from here is logged rather than sent. Enforcement and the customer-visible failure are unaffected;
 * only the mail is lost.
 *
 * No `STRIPE_ENABLED` guard is needed: a candidate must already hold a `stripeCustomerId`, which a
 * deployment that never enabled billing has none of, so the sweep finds nothing and does nothing.
 */
export async function reconcileAutoTopUps(db: PrismaClient): Promise<AutoTopUpReconcileResult> {
    const packageService = new BillingTopupPackageService(db);
    const spendCapService = new SpendCapService(db, new LoggingBillingAlertNotifier());
    const autoTopUpService = new AutoTopUpService(db, packageService, spendCapService);

    return new AutoTopUpReconciler(db, autoTopUpService, packageService, spendCapService).reconcile();
}
