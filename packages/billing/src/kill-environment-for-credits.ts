import { PreviewkitAppStatus, type PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";

/** The `PreviewkitAppInstance` statuses that already carry a final verdict; mirrors previewkit's own list. */
const TERMINAL_APP_STATUSES: PreviewkitAppStatus[] = [
    PreviewkitAppStatus.ready,
    PreviewkitAppStatus.build_failed,
    PreviewkitAppStatus.deploy_failed,
    PreviewkitAppStatus.skipped,
];

/**
 * Marks an in-flight previewkit environment `failed` for a zero-tolerance org's mid-run credit
 * exhaustion, and every one of its still-in-flight app rows along with it - the same "no row left
 * claiming to still be in progress" invariant previewkit's own `PreviewPipeline.fail` upholds
 * (`apps/previewkit/src/pipeline/preview-pipeline.ts`), reproduced here because the caller
 * (the `previewkit-credits-watcher`, `apps/jobs/previewkit-credits-watcher`) runs as a separate process with no
 * access to that app's code - only its database.
 *
 * The runner has no in-process moment to detect this itself: build-cost deduction only happens
 * after every app in a deploy attempt has already finished building, so by the time any deduction
 * fires there is nothing left running to interrupt. Hence the external watcher, and this being its
 * write path rather than a call into previewkit's own `recordPhaseChanged`/`failInFlightApps`.
 *
 * Callers must write this BEFORE killing the underlying Kubernetes Job, so the DB reaches a
 * well-defined terminal state deterministically regardless of whether the runner's own SIGTERM
 * drain wins the race.
 *
 * Both writes go in one transaction: the environment reaching `failed` is what takes it out of the
 * watcher's in-flight sweep, so a partial write would strand its still-in-progress app rows under
 * a terminal environment that nothing ever revisits.
 */
export async function killEnvironmentForCreditExhaustion(
    db: PrismaClient,
    namespace: string,
    error: string,
    logger: Logger,
): Promise<void> {
    const failedInFlightAppCount = await db.$transaction(async (tx) => {
        const env = await tx.previewkitEnvironment.findUnique({ where: { namespace }, select: { id: true } });
        if (env == null) return undefined;

        const appUpdate = await tx.previewkitAppInstance.updateMany({
            where: { environmentId: env.id, status: { notIn: TERMINAL_APP_STATUSES } },
            data: { status: "deploy_failed", error },
        });
        await tx.previewkitEnvironment.update({
            where: { namespace },
            data: { status: "failed", phase: "failed", error },
        });
        return appUpdate.count;
    });

    if (failedInFlightAppCount == null) {
        logger.warn("Cannot kill environment for credit exhaustion: no environment row found", { namespace });
        return;
    }

    logger.info("Killed previewkit environment for credit exhaustion", {
        namespace,
        failedInFlightAppCount,
    });
}
