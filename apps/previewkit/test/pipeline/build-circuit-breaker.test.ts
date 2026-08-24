import type { PreviewDeployTarget } from "@autonoma/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    type AppBuildRecord,
    type BuildCircuitAlert,
    BuildCircuitBreaker,
    type BuildCircuitStore,
    type CircuitStateRow,
    type OpenCircuitWrite,
} from "../../src/pipeline/build-circuit-breaker";

const NOW = new Date("2026-08-23T12:00:00.000Z");
const THRESHOLD = 5;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const target: PreviewDeployTarget = {
    prNumber: 42,
    repoFullName: "sandstone-team/sandstone",
    organizationId: "org_1",
    githubRepositoryId: 99,
    headSha: "abc123def4567890",
    headRef: "feature/x",
};

/** `count` failed builds, newest-first, one minute apart ending at `newestAt`. */
function failingHistory(count: number, newestAt: Date = NOW): AppBuildRecord[] {
    return Array.from({ length: count }, (_, i) => ({
        status: "failed",
        finishedAt: new Date(newestAt.getTime() - i * 60_000),
    }));
}

function record(status: "success" | "failed", finishedAt: Date): AppBuildRecord {
    return { status, finishedAt };
}

/** In-memory {@link BuildCircuitStore} that records every open/close write. */
class FakeStore implements BuildCircuitStore {
    readonly history = new Map<string, AppBuildRecord[]>();
    readonly states = new Map<string, CircuitStateRow>();
    readonly opened: Array<{ appName: string; write: OpenCircuitWrite }> = [];
    readonly probed: Array<{ appName: string; probedAt: Date }> = [];
    readonly closed: string[] = [];

    async recentAppBuilds(
        _organizationId: string,
        _repoFullName: string,
        appNames: string[],
    ): Promise<Map<string, AppBuildRecord[]>> {
        const result = new Map<string, AppBuildRecord[]>();
        for (const appName of appNames) {
            const history = this.history.get(appName);
            if (history != null) result.set(appName, history);
        }
        return result;
    }

    async loadStates(
        _organizationId: string,
        _repoFullName: string,
        appNames: string[],
    ): Promise<Map<string, CircuitStateRow>> {
        const result = new Map<string, CircuitStateRow>();
        for (const appName of appNames) {
            const state = this.states.get(appName);
            if (state != null) result.set(appName, state);
        }
        return result;
    }

    async markOpen(
        _organizationId: string,
        _repoFullName: string,
        appName: string,
        write: OpenCircuitWrite,
    ): Promise<void> {
        this.opened.push({ appName, write });
        // Merge, mirroring the Prisma update: only the open bookkeeping changes; probedAt/resetAt survive.
        const prev = this.states.get(appName) ?? {};
        this.states.set(appName, {
            ...prev,
            openedAt: write.openedAt,
            alertedAt: write.alertedAt,
            consecutiveFailures: write.consecutiveFailures,
        });
    }

    async markProbe(_organizationId: string, _repoFullName: string, appName: string, probedAt: Date): Promise<void> {
        this.probed.push({ appName, probedAt });
        const prev = this.states.get(appName) ?? {};
        this.states.set(appName, { ...prev, probedAt });
    }

    async markClosed(_organizationId: string, _repoFullName: string, appName: string): Promise<void> {
        this.closed.push(appName);
        // Prisma keeps resetAt on close; everything else clears.
        const prev = this.states.get(appName) ?? {};
        this.states.set(appName, prev.resetAt != null ? { resetAt: prev.resetAt } : {});
    }
}

function buildBreaker(store: FakeStore, enabled = true) {
    const alert = vi.fn<(alert: BuildCircuitAlert) => void>();
    const breaker = new BuildCircuitBreaker(
        store,
        alert,
        { enabled, failureThreshold: THRESHOLD, cooldownMs: COOLDOWN_MS },
        () => NOW,
    );
    return { breaker, alert };
}

describe("BuildCircuitBreaker", () => {
    let store: FakeStore;
    beforeEach(() => {
        store = new FakeStore();
    });

    it("is a no-op (no DB read, no alert) when disabled", async () => {
        store.history.set("web", failingHistory(20));
        const readSpy = vi.spyOn(store, "recentAppBuilds");
        const { breaker, alert } = buildBreaker(store, false);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({ blocked: false });
        expect(readSpy).not.toHaveBeenCalled();
        expect(alert).not.toHaveBeenCalled();
    });

    it("stays closed below the threshold", async () => {
        store.history.set("web", failingHistory(THRESHOLD - 1));
        const { breaker, alert } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({ blocked: false });
        expect(alert).not.toHaveBeenCalled();
        expect(store.opened).toHaveLength(0);
    });

    it("stays closed when a recent success breaks the streak", async () => {
        // Newest build succeeded even though older ones failed - not a broken app.
        store.history.set("web", [
            record("success", NOW),
            ...failingHistory(THRESHOLD, new Date(NOW.getTime() - 60_000)),
        ]);
        const { breaker, alert } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({ blocked: false });
        expect(alert).not.toHaveBeenCalled();
    });

    it("opens and blocks after N consecutive failures, alerting once", async () => {
        store.history.set("web", failingHistory(THRESHOLD));
        const { breaker, alert } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({
            blocked: true,
            maxFailures: THRESHOLD,
            trippedApps: [expect.objectContaining({ appName: "web", consecutiveFailures: THRESHOLD })],
        });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(alert).toHaveBeenCalledWith(
            expect.objectContaining({
                repoFullName: target.repoFullName,
                appName: "web",
                consecutiveFailures: THRESHOLD,
            }),
        );
        expect(store.opened).toHaveLength(1);
    });

    it("does not re-alert or re-write on a later push while the count is unchanged", async () => {
        store.history.set("web", failingHistory(THRESHOLD + 2));
        const { breaker, alert } = buildBreaker(store);

        await breaker.evaluate(target, ["web"]); // opens + alerts + writes
        const second = await breaker.evaluate(target, ["web"]); // still open, count unchanged

        expect(second.blocked).toBe(true);
        expect(alert).toHaveBeenCalledTimes(1);
        // Only the closed->open write happened; the unchanged re-push skips markOpen.
        expect(store.opened).toHaveLength(1);
    });

    it("re-writes (preserving openedAt) but does not re-alert when the count grows while open", async () => {
        store.history.set("web", failingHistory(THRESHOLD));
        const { breaker, alert } = buildBreaker(store);
        await breaker.evaluate(target, ["web"]); // opens at THRESHOLD

        // A later failing push lengthens the streak.
        store.history.set("web", failingHistory(THRESHOLD + 1));
        const second = await breaker.evaluate(target, ["web"]);

        expect(second.blocked).toBe(true);
        expect(alert).toHaveBeenCalledTimes(1);
        expect(store.opened).toHaveLength(2);
        // openedAt from the first open is preserved on the second write.
        expect(store.opened[1]?.write.openedAt).toEqual(NOW);
        expect(store.opened[1]?.write.consecutiveFailures).toBe(THRESHOLD + 1);
    });

    it("half-open: allows a single probe once the cooldown has elapsed", async () => {
        // Newest failure is older than the cooldown, so this push is the probe.
        const staleNewest = new Date(NOW.getTime() - COOLDOWN_MS - 60_000);
        store.history.set("web", failingHistory(THRESHOLD, staleNewest));
        const { breaker, alert } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({ blocked: false });
        // First detection still records the open state and alerts once, and records the probe.
        expect(alert).toHaveBeenCalledTimes(1);
        expect(store.opened).toHaveLength(1);
        expect(store.probed).toHaveLength(1);
    });

    it("half-open: blocks a concurrent push while the let-through probe is still in flight", async () => {
        const staleNewest = new Date(NOW.getTime() - COOLDOWN_MS - 60_000);
        store.history.set("web", failingHistory(THRESHOLD, staleNewest));
        const { breaker } = buildBreaker(store);

        const first = await breaker.evaluate(target, ["web"]); // the probe
        // A second push arrives before the probe's build row lands (history unchanged).
        const second = await breaker.evaluate(target, ["web"]);

        expect(first.blocked).toBe(false);
        expect(second.blocked).toBe(true);
        // Only one probe was let through, not two.
        expect(store.probed).toHaveLength(1);
    });

    it("half-open: lets another probe through once the in-flight one exceeds its TTL", async () => {
        const staleNewest = new Date(NOW.getTime() - COOLDOWN_MS - 60_000);
        store.history.set("web", failingHistory(THRESHOLD, staleNewest));
        // A probe was launched over the TTL ago and never wrote a result (crashed/superseded).
        store.states.set("web", {
            openedAt: new Date(NOW.getTime() - COOLDOWN_MS),
            alertedAt: new Date(NOW.getTime() - COOLDOWN_MS),
            consecutiveFailures: THRESHOLD,
            probedAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000), // 2h ago > 1h TTL
        });
        const { breaker } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision.blocked).toBe(false);
        expect(store.probed).toHaveLength(1);
    });

    it("half-open: a failed probe re-arms the cooldown (next push blocks)", async () => {
        // The probe failed: its failure is the newest build, so cooldown restarts from it.
        const probedAt = new Date(NOW.getTime() - 30 * 60_000);
        store.history.set("web", failingHistory(THRESHOLD, NOW)); // newest failure is now (the failed probe)
        store.states.set("web", {
            openedAt: new Date(NOW.getTime() - COOLDOWN_MS),
            alertedAt: new Date(NOW.getTime() - COOLDOWN_MS),
            consecutiveFailures: THRESHOLD,
            probedAt,
        });
        const { breaker } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision.blocked).toBe(true);
        expect(store.probed).toHaveLength(0);
    });

    it("blocks during the cooldown window (probe not yet allowed)", async () => {
        const recentNewest = new Date(NOW.getTime() - COOLDOWN_MS + 60_000);
        store.history.set("web", failingHistory(THRESHOLD, recentNewest));
        const { breaker } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision.blocked).toBe(true);
    });

    it("closes the circuit when an already-open app recovers", async () => {
        store.states.set("web", { openedAt: new Date(NOW.getTime() - COOLDOWN_MS), alertedAt: new Date() });
        store.history.set("web", [record("success", NOW), ...failingHistory(THRESHOLD)]);
        const { breaker, alert } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({ blocked: false });
        expect(store.closed).toEqual(["web"]);
        expect(alert).not.toHaveBeenCalled();
    });

    it("ignores failures at or before a manual reset boundary", async () => {
        // The whole failing streak predates the reset, so it no longer counts.
        const resetAt = new Date(NOW.getTime() - 60_000);
        store.states.set("web", { resetAt });
        store.history.set("web", failingHistory(THRESHOLD, new Date(NOW.getTime() - 120_000)));
        const { breaker } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web"]);

        expect(decision).toEqual({ blocked: false });
    });

    it("blocks the whole preview when any one app is tripped", async () => {
        store.history.set("web", failingHistory(THRESHOLD)); // tripped
        store.history.set("api", failingHistory(1)); // healthy
        const { breaker } = buildBreaker(store);

        const decision = await breaker.evaluate(target, ["web", "api"]);

        expect(decision.blocked).toBe(true);
        if (decision.blocked) {
            expect(decision.trippedApps.map((app) => app.appName)).toEqual(["web"]);
        }
    });
});
