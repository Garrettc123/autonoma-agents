import { setTimeout as delay } from "node:timers/promises";
import { db } from "@autonoma/db";
import { createSentryConfig, type Logger, logger as rootLogger } from "@autonoma/logger";
import * as Sentry from "@sentry/node";
import "./env";
import { startHealthServer } from "./health-server";
import { sweepExhaustedOrgs } from "./sweep";

const SERVICE_NAME = "previewkit-credits-watcher";

/**
 * How long an exhausted org's build is allowed to keep burning compute before this watcher stops
 * it. Faster than a CronJob could ever be scheduled - one minute is the finest cron granularity -
 * and it costs nothing extra here, because the process, its connection pool and its Kubernetes
 * client are already warm between sweeps.
 */
const SWEEP_INTERVAL_MS = 30_000;

const HEALTH_PORT = 8080;

/**
 * A sweep that has not come back within this long means the loop is wedged rather than merely
 * failing - a failing sweep still returns and still schedules the next one. Generous enough that a
 * slow-but-progressing sweep over many environments is never mistaken for a hung one.
 */
const SWEEP_STALE_MS = SWEEP_INTERVAL_MS * 6;

const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

const shutdown = new AbortController();
let lastSweepCompletedAt = Date.now();

/**
 * Runs one sweep and reports it to the same Sentry cron monitor the CronJob used, so the "did this
 * actually run" alerting survives the move to a long-running process. Never throws: a sweep that
 * fails is captured and the loop carries on to the next one.
 */
async function runSweep(logger: Logger): Promise<void> {
    const checkInId = Sentry.captureCheckIn({ monitorSlug: SERVICE_NAME, status: "in_progress" });
    try {
        const outcome = await sweepExhaustedOrgs(logger);
        Sentry.captureCheckIn({ checkInId, monitorSlug: SERVICE_NAME, status: "ok" });
        logger.info("Sweep complete", { extra: outcome });
    } catch (error) {
        Sentry.captureCheckIn({ checkInId, monitorSlug: SERVICE_NAME, status: "error" });
        logger.captureError(error);
    } finally {
        lastSweepCompletedAt = Date.now();
    }
}

/** Waits out the gap between sweeps, cut short the moment a shutdown signal arrives. */
async function waitForNextSweep(logger: Logger): Promise<void> {
    try {
        await delay(SWEEP_INTERVAL_MS, undefined, { signal: shutdown.signal });
    } catch (err) {
        // `delay` rejects with an AbortError the moment SIGTERM fires - the expected way a
        // terminating pod skips the rest of its interval instead of sitting it out and being
        // SIGKILLed at the end of the grace period.
        logger.debug("Sweep interval cut short by shutdown", { extra: { err } });
    }
}

async function main(): Promise<void> {
    Sentry.init(
        createSentryConfig({
            tags: { package: SERVICE_NAME, service: SERVICE_NAME },
            contextType: "service",
            contextName: SERVICE_NAME,
        }),
    );

    const logger = rootLogger.child({ name: SERVICE_NAME });
    const health = startHealthServer({
        port: HEALTH_PORT,
        isLive: () => Date.now() - lastSweepCompletedAt < SWEEP_STALE_MS,
        logger,
    });

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        process.on(signal, () => {
            logger.info("Shutdown requested", { extra: { signal } });
            shutdown.abort();
        });
    }

    logger.info("Previewkit credits watcher started", { extra: { sweepIntervalMs: SWEEP_INTERVAL_MS } });
    while (!shutdown.signal.aborted) {
        await runSweep(logger);
        if (shutdown.signal.aborted) break;
        await waitForNextSweep(logger);
    }

    logger.info("Previewkit credits watcher stopping");
    await new Promise<void>((resolve) => health.close(() => resolve()));
    await db.$disconnect();
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
}

main()
    .then(() => process.exit(0))
    .catch(async (error: unknown) => {
        console.error("[FATAL] Previewkit credits watcher failed:", error);
        Sentry.captureException(error);
        await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS);
        process.exit(1);
    });
