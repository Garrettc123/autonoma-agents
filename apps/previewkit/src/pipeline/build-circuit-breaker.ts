import type { PreviewDeployTarget } from "@autonoma/types";
import { type Logger, logger as rootLogger } from "../logger";

// Builds fetched per app beyond the threshold, so a streak-breaking success is visible.
const HISTORY_PADDING = 10;
// How long a let-through probe counts as "in flight" (it writes no build row until it
// finishes). Longer than a build; bounded so a crashed probe can't wedge the app forever.
const PROBE_TTL_MS = 60 * 60 * 1000;

/** One finished per-app build outcome, newest-first when listed. */
export interface AppBuildRecord {
    status: "success" | "failed";
    finishedAt: Date;
}

/** Persisted circuit state for one app. `openedAt` null = closed. */
export interface CircuitStateRow {
    openedAt?: Date;
    alertedAt?: Date;
    resetAt?: Date;
    consecutiveFailures?: number;
    /** When a half-open probe was last let through (see PROBE_TTL_MS). */
    probedAt?: Date;
}

/** The fields written when an app's circuit is (re-)marked open. */
export interface OpenCircuitWrite {
    openedAt: Date;
    alertedAt: Date;
    consecutiveFailures: number;
}

/** Persistence seam. Prisma reads build history + circuit rows; tests use an in-memory fake. */
export interface BuildCircuitStore {
    /** Newest-first finished builds per app for this (org, repo), across every PR; `limitPerApp` bounds each app. */
    recentAppBuilds(
        organizationId: string,
        repoFullName: string,
        appNames: string[],
        limitPerApp: number,
    ): Promise<Map<string, AppBuildRecord[]>>;
    loadStates(organizationId: string, repoFullName: string, appNames: string[]): Promise<Map<string, CircuitStateRow>>;
    markOpen(organizationId: string, repoFullName: string, appName: string, write: OpenCircuitWrite): Promise<void>;
    /** Records that a half-open probe was let through, so only one builds until its result lands. */
    markProbe(organizationId: string, repoFullName: string, appName: string, probedAt: Date): Promise<void>;
    markClosed(organizationId: string, repoFullName: string, appName: string): Promise<void>;
}

/** The payload the one-time "circuit opened" alert carries. */
export interface BuildCircuitAlert {
    repoFullName: string;
    appName: string;
    consecutiveFailures: number;
    /** First failure of the current streak. */
    since: Date;
}

/** Fired once per open episode; wired to a Sentry capture in create-services. */
export type BuildCircuitAlertFn = (alert: BuildCircuitAlert) => void;

export interface BuildCircuitConfig {
    enabled: boolean;
    failureThreshold: number;
    cooldownMs: number;
}

export interface TrippedApp {
    appName: string;
    consecutiveFailures: number;
    since: Date;
}

/** `blocked: true` = pause this build; `false` = proceed (healthy, or a half-open probe). */
export type BuildCircuitDecision =
    | { blocked: false }
    | { blocked: true; trippedApps: TrippedApp[]; maxFailures: number };

/** The slice of `BuildCircuitBreaker` the pipeline depends on (so tests can fake it). */
export interface BuildCircuitChecker {
    evaluate(target: PreviewDeployTarget, appNames: string[]): Promise<BuildCircuitDecision>;
}

/**
 * Per-app circuit breaker for preview builds. Open/closed is derived each call from
 * the build history (a leading run of `failed`); the store persists only alert-once
 * bookkeeping + the reset boundary. Half-open is derived too: a blocked push writes
 * no row, so once the newest failure is older than the cooldown the next push is let
 * through as one probe. Previews are all-or-nothing, so one tripped app blocks the repo.
 */
export class BuildCircuitBreaker implements BuildCircuitChecker {
    private readonly logger: Logger;
    private readonly now: () => Date;

    constructor(
        private readonly store: BuildCircuitStore,
        private readonly alert: BuildCircuitAlertFn,
        private readonly config: BuildCircuitConfig,
        now?: () => Date,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
        this.now = now ?? (() => new Date());
    }

    async evaluate(target: PreviewDeployTarget, appNames: string[]): Promise<BuildCircuitDecision> {
        // Flag off: no DB read, path byte-for-byte unchanged.
        if (!this.config.enabled) return { blocked: false };
        if (appNames.length === 0) return { blocked: false };

        const { organizationId, repoFullName, prNumber } = target;
        this.logger.info("Evaluating preview-build circuit", {
            repo: repoFullName,
            pr: prNumber,
            extra: { appCount: appNames.length },
        });

        const limitPerApp = this.config.failureThreshold + HISTORY_PADDING;
        const [historyByApp, statesByApp] = await Promise.all([
            this.store.recentAppBuilds(organizationId, repoFullName, appNames, limitPerApp),
            this.store.loadStates(organizationId, repoFullName, appNames),
        ]);

        const now = this.now();
        const blocking: TrippedApp[] = [];

        for (const appName of appNames) {
            const history = historyByApp.get(appName) ?? [];
            const state = statesByApp.get(appName);
            const evaluation = evaluateApp(history, state?.resetAt, this.config.failureThreshold);

            if (!evaluation.open) {
                if (state?.openedAt != null) {
                    await this.store.markClosed(organizationId, repoFullName, appName);
                    this.logger.info("Preview-build circuit closed - app recovered", {
                        repo: repoFullName,
                        extra: { appName },
                    });
                }
                continue;
            }

            await this.recordOpen(organizationId, repoFullName, appName, evaluation, state, now);

            const lastFailureAt = evaluation.lastFailureAt;
            // A probe launched after the last failure and within its TTL is still running.
            const probeInFlight =
                state?.probedAt != null &&
                state.probedAt > lastFailureAt &&
                now.getTime() - state.probedAt.getTime() < PROBE_TTL_MS;
            const cooledDown = now.getTime() - lastFailureAt.getTime() >= this.config.cooldownMs;

            if (!probeInFlight && cooledDown) {
                // Half-open: let one push through and record it, so the next push blocks.
                await this.store.markProbe(organizationId, repoFullName, appName, now);
                this.logger.info("Preview-build circuit half-open - letting one probe build through", {
                    repo: repoFullName,
                    extra: { appName, consecutiveFailures: evaluation.consecutiveFailures },
                });
                continue;
            }

            // Cooling down, or a probe is already in flight - block.
            blocking.push({
                appName,
                consecutiveFailures: evaluation.consecutiveFailures,
                since: evaluation.streakStartedAt,
            });
        }

        if (blocking.length === 0) return { blocked: false };

        const maxFailures = Math.max(...blocking.map((app) => app.consecutiveFailures));
        this.logger.warn("Preview-build circuit open - blocking build", {
            repo: repoFullName,
            pr: prNumber,
            extra: { blockedApps: blocking.map((app) => app.appName), maxFailures },
        });
        return { blocked: true, trippedApps: blocking, maxFailures };
    }

    /** Persists open state; fires the alert once, only on the closed->open transition. */
    private async recordOpen(
        organizationId: string,
        repoFullName: string,
        appName: string,
        evaluation: OpenAppEvaluation,
        state: CircuitStateRow | undefined,
        now: Date,
    ): Promise<void> {
        const wasOpen = state?.openedAt != null;
        // Persist on the closed->open transition and whenever the count moves; skip the
        // write on a later push that leaves an already-open circuit's count unchanged.
        const countUnchanged = wasOpen && state?.consecutiveFailures === evaluation.consecutiveFailures;
        if (!countUnchanged) {
            await this.store.markOpen(organizationId, repoFullName, appName, {
                openedAt: state?.openedAt ?? now,
                alertedAt: state?.alertedAt ?? now,
                consecutiveFailures: evaluation.consecutiveFailures,
            });
        }
        if (wasOpen) return;

        this.logger.error("Preview-build circuit opened", {
            repo: repoFullName,
            extra: { appName, consecutiveFailures: evaluation.consecutiveFailures },
        });
        this.alert({
            repoFullName,
            appName,
            consecutiveFailures: evaluation.consecutiveFailures,
            since: evaluation.streakStartedAt ?? now,
        });
    }
}

interface ClosedAppEvaluation {
    open: false;
    consecutiveFailures: number;
}
interface OpenAppEvaluation {
    open: true;
    consecutiveFailures: number;
    lastFailureAt: Date;
    streakStartedAt: Date;
}
type AppEvaluation = ClosedAppEvaluation | OpenAppEvaluation;

/** Leading run of `failed` builds (newest-first), ignoring anything at/before resetAt. */
function evaluateApp(history: AppBuildRecord[], resetAt: Date | undefined, threshold: number): AppEvaluation {
    const relevant = resetAt != null ? history.filter((record) => record.finishedAt > resetAt) : history;
    const firstNonFailure = relevant.findIndex((record) => record.status !== "failed");
    const streak = firstNonFailure === -1 ? relevant.length : firstNonFailure;

    const newest = relevant[0];
    const oldestInStreak = relevant[streak - 1];
    if (streak < threshold || newest == null || oldestInStreak == null) {
        return { open: false, consecutiveFailures: streak };
    }
    return {
        open: true,
        consecutiveFailures: streak,
        lastFailureAt: newest.finishedAt,
        streakStartedAt: oldestInStreak.finishedAt,
    };
}
