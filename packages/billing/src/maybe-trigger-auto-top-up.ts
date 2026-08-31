import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { AutoTopUpService } from "./auto-topup.service";
import { BillingTopupPackageService } from "./billing-topup-package.service";
import { LoggingBillingAlertNotifier } from "./logging-billing-alert-notifier";
import { SpendCapService } from "./spend-cap.service";

/**
 * Recharge check to run after a consumption deduction, for callers that hold a `PrismaClient` and
 * nothing else - the standalone deduction paths (AI cost, previewkit build/runtime) that never
 * build a `CreditsService`.
 *
 * `AutoTopUpService.triggerAutoTopUp` already contains its own failures; the catch here covers the
 * construction above it, so that no shape of failure can turn a completed deduction into a thrown
 * error.
 *
 * Uses the no-op alert notifier, matching the default every non-API host already gets from
 * `createBillingServices`. The API keeps its real (email-sending) notifier on the paths that build
 * a `CreditsService` with an injected `AutoTopUpService`.
 *
 * Consequence worth knowing before you chase a "missing alert" report: these hosts have no email
 * transport, so an auto-top-up charge that crosses a spend-cap threshold here is logged and not
 * emailed - and since `SpendCapService` advances `lastAlertThresholdSent` in the same statement that
 * records the charge, that crossing is never re-sent later either. Cap *enforcement* is unaffected
 * (it is all in the database); only the notification is lost. Closing it properly means enqueueing
 * the alert for the API to send rather than notifying inline from whatever host happened to deduct.
 *
 * A *failed recharge* does not have that problem, and deliberately so: `AutoTopUpService` records it
 * on `BillingCustomer` before trying to notify, so the billing page shows it no matter which host
 * ran the deduction. The email is the part that only the API can add.
 */
export async function maybeTriggerAutoTopUp(db: PrismaClient, organizationId: string, logger: Logger): Promise<void> {
    try {
        const packageService = new BillingTopupPackageService(db);
        const spendCapService = new SpendCapService(db, new LoggingBillingAlertNotifier());
        const autoTopUpService = new AutoTopUpService(db, packageService, spendCapService);
        await autoTopUpService.triggerAutoTopUp(organizationId);
    } catch (error) {
        logger.error("Auto top-up check failed after deduction", error, { organizationId });
    }
}
