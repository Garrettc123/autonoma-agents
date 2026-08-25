import { killEnvironmentForCreditExhaustion, recordBranchTriggerBlocked } from "@autonoma/billing";
import { db, PreviewkitStatus } from "@autonoma/db";
import { getInClusterPreviewkitJobLauncher, previewEnvKey } from "@autonoma/k8s/previewkit-jobs";
import type { Logger } from "@autonoma/logger";

const KILL_REASON = "Insufficient credits - build/deploy stopped mid-run";

// The only previewkit statuses that still have a live Kubernetes Job behind them - `ready` /
// `failed` / `superseded` / `torn_down` have nothing left running to kill.
const IN_FLIGHT_STATUSES: PreviewkitStatus[] = [
    PreviewkitStatus.pending,
    PreviewkitStatus.building,
    PreviewkitStatus.deploying,
];

export type SweepOutcome = {
    exhaustedOrgCount: number;
    environmentsKilled: number;
    jobsKilled: number;
    jobKillFailures: number;
};

/**
 * One pass of the zero-tolerance credit policy over previewkit: a build/deploy still in flight when
 * its org's balance sits at-or-below its `creditFloor` gets killed instead of allowed to finish.
 *
 * This is the previewkit half of the credit-exhaustion kill feature; the analysis-run half kills
 * in-process via `CreditsExhaustedError`/`withAnalysisRunSettlement`, because a Temporal workflow
 * has a natural per-activity checkpoint to react at. Previewkit has no such checkpoint: build-cost
 * deduction (`meterAppBuilds`, `apps/previewkit/src/db/index.ts`) only runs after every app in a
 * deploy attempt has already finished building, so by the time any deduction fires there is
 * nothing left running to interrupt in-process - hence this external sweep instead.
 *
 * The sweep is level-triggered on purpose: it asks "who is below their floor right now" rather than
 * reacting to the deduction that put them there. A balance can cross the floor through a path that
 * carries no signal at all (an admin raising `creditFloor` or flipping `killJobsOnCreditExhaustion`
 * on, the LLM-proxy deduction), and an edge that is missed once is missed forever. Re-deriving the
 * whole picture each pass converges regardless of how the org got there.
 *
 * Each pass runs two stages, in this order:
 *
 * 1. The DB write. Every in-flight environment is taken to a consistent terminal state (environment
 *    + app rows, plus the branch's `lastBlockedReason` so the PR list/overview UI picks it up with
 *    no new frontend work) BEFORE anything is SIGTERMed - see
 *    `killEnvironmentForCreditExhaustion`'s doc for why that order matters. Best-effort per
 *    environment: a failure is captured and leaves the row in flight, so the next pass retries it.
 * 2. The Job kill, keyed on the exhausted orgs' live environments rather than on what stage 1 just
 *    wrote. A delete that fails is only logged, so keying the kill on "still in flight in the DB"
 *    would make a survivor invisible forever - its row now reads `failed`, which no later pass
 *    looks at - while its runner keeps burning the compute this watcher exists to stop. Re-driving
 *    the whole fleet each pass makes the sweep idempotent and self-healing instead.
 *
 * A Job killed in stage 2 whose stage-1 write failed leaves a row reading in-flight with no runner
 * behind it until the next pass settles it. That is the intended trade: stopping the spend is the
 * point, and a briefly stale row costs less than unpaid compute.
 */
export async function sweepExhaustedOrgs(logger: Logger): Promise<SweepOutcome> {
    const killModeCustomers = await db.billingCustomer.findMany({
        where: { killJobsOnCreditExhaustion: true },
        select: { organizationId: true, creditBalance: true, creditFloor: true },
    });
    const exhaustedOrgIds = killModeCustomers
        .filter((customer) => customer.creditBalance <= customer.creditFloor)
        .map((customer) => customer.organizationId);

    if (exhaustedOrgIds.length === 0) {
        logger.info("No zero-tolerance orgs are exhausted this sweep");
        return { exhaustedOrgCount: 0, environmentsKilled: 0, jobsKilled: 0, jobKillFailures: 0 };
    }

    // `liveEnvironments` is every environment that could still have a Job behind it, in-flight or
    // not: an already-`failed` row is exactly the case where a previous pass's delete did not land.
    const [inFlightEnvironments, liveEnvironments] = await Promise.all([
        db.previewkitEnvironment.findMany({
            where: { organizationId: { in: exhaustedOrgIds }, status: { in: IN_FLIGHT_STATUSES } },
            select: { namespace: true, branchId: true },
        }),
        db.previewkitEnvironment.findMany({
            where: { organizationId: { in: exhaustedOrgIds }, tornDownAt: null },
            select: { repoFullName: true, prNumber: true },
        }),
    ]);
    logger.info("Sweeping previewkit environments for exhausted orgs", {
        extra: {
            exhaustedOrgCount: exhaustedOrgIds.length,
            inFlightEnvironmentCount: inFlightEnvironments.length,
            liveEnvironmentCount: liveEnvironments.length,
        },
    });

    let environmentsKilled = 0;
    for (const environment of inFlightEnvironments) {
        try {
            await killEnvironmentForCreditExhaustion(db, environment.namespace, KILL_REASON, logger);
            if (environment.branchId != null) {
                await recordBranchTriggerBlocked(db, environment.branchId, "insufficient_credits");
            }
            environmentsKilled += 1;
        } catch (error) {
            logger.captureError(error, { namespace: environment.namespace });
        }
    }

    const envKeys = new Set(
        liveEnvironments.map((environment) => previewEnvKey(environment.repoFullName, environment.prNumber)),
    );
    const cancelled = await getInClusterPreviewkitJobLauncher().cancelJobsForEnvironments(envKeys);
    if (cancelled.failed > 0) {
        logger.captureError(
            new Error(`Failed to kill ${cancelled.failed} in-flight preview job(s) for credit exhaustion`),
        );
    }

    return {
        exhaustedOrgCount: exhaustedOrgIds.length,
        environmentsKilled,
        jobsKilled: cancelled.deleted,
        jobKillFailures: cancelled.failed,
    };
}
