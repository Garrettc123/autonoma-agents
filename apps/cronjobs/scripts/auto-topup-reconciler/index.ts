import { reconcileAutoTopUps } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { logger as rootLogger, runWithSentry } from "@autonoma/logger";
import { captureCheckIn } from "@sentry/node";
import "../env";

const JOB_NAME = "auto-topup-reconciler";

/**
 * Recharges every organization that should have auto-topped-up and did not.
 *
 * Auto top-up is otherwise only triggered by a deduction, so a recharge that becomes possible
 * without one never fires. The case that matters: an organization out of credits *and* at its
 * monthly spend cap is blocked at the credit gate, so nothing deducts and nothing triggers - and
 * when the cap's calendar month rolls over it has no way to notice. This sweep is what resumes it,
 * with no human intervention.
 *
 * All of the decisions live in `@autonoma/billing`; this is only the schedule and the check-in.
 */
async function main() {
    const logger = rootLogger.child({ name: JOB_NAME });

    const result = await reconcileAutoTopUps(db);

    logger.info("Auto top-up reconciliation complete", { extra: { ...result } });
}

async function run() {
    const checkInId = captureCheckIn({ monitorSlug: JOB_NAME, status: "in_progress" });
    try {
        await main();
        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "ok" });
    } catch (error) {
        captureCheckIn({ checkInId, monitorSlug: JOB_NAME, status: "error" });
        throw error;
    }
}

runWithSentry({ name: JOB_NAME }, run);
