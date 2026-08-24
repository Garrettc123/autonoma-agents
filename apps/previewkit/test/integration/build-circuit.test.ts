import { integrationTestSuite } from "@autonoma/integration-test";
import type { PreviewDeployTarget } from "@autonoma/types";
import { expect, vi } from "vitest";
import { BuildCircuitBreaker, type BuildCircuitAlert } from "../../src/pipeline/build-circuit-breaker";
import { PrismaBuildCircuitStore, resetBuildCircuit } from "../../src/pipeline/prisma-build-circuit-store";
import { PreviewkitTestHarness } from "./harness";

const REPO = "acme/web";
const REPO_ID = 4242;
const THRESHOLD = 3;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const NOW = new Date("2026-08-23T12:00:00.000Z");

function target(organizationId: string): PreviewDeployTarget {
    return {
        prNumber: 7,
        repoFullName: REPO,
        organizationId,
        githubRepositoryId: REPO_ID,
        headSha: "deadbeef",
        headRef: "feature/x",
    };
}

integrationTestSuite({
    name: "previewkit build circuit",
    createHarness: () => PreviewkitTestHarness.create(),
    cases: (test) => {
        /** Seeds one finished build (its own environment/PR) with one app-build outcome. */
        async function seedBuild(
            harness: PreviewkitTestHarness,
            organizationId: string,
            appIds: Map<string, string>,
            opts: { pr: number; appName: string; status: "success" | "failed"; startedAt: Date; superseded?: boolean },
        ): Promise<void> {
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-acme-web-pr-${opts.pr}`,
                    repoFullName: REPO,
                    prNumber: opts.pr,
                    headSha: `sha-${opts.pr}`,
                    headRef: `feature/${opts.pr}`,
                    githubRepositoryId: REPO_ID,
                    organizationId,
                },
            });
            const appId = appIds.get(opts.appName);
            if (appId == null) throw new Error(`no app id for ${opts.appName}`);
            await harness.db.previewkitBuild.create({
                data: {
                    environmentId: environment.id,
                    headSha: `sha-${opts.pr}`,
                    status: opts.superseded === true ? "superseded" : "failed",
                    startedAt: opts.startedAt,
                    finishedAt: opts.startedAt,
                    appBuilds: {
                        create: { appName: opts.appName, appId, status: opts.status, durationMs: 1000 },
                    },
                },
            });
        }

        function makeBreaker(alert = vi.fn<(alert: BuildCircuitAlert) => void>()) {
            const breaker = new BuildCircuitBreaker(
                new PrismaBuildCircuitStore(),
                alert,
                { enabled: true, failureThreshold: THRESHOLD, cooldownMs: COOLDOWN_MS },
                () => NOW,
            );
            return { breaker, alert };
        }

        test("recentAppBuilds returns per-app outcomes newest-first, across PRs, excluding superseded", async ({
            harness,
        }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            const appIds = await harness.createTopology(organizationId, REPO_ID, ["web", "api"]);

            // Three failed web builds spanning three PRs, plus a superseded one that must be ignored.
            await seedBuild(harness, organizationId, appIds, {
                pr: 1,
                appName: "web",
                status: "failed",
                startedAt: new Date(NOW.getTime() - 3 * 60_000),
            });
            await seedBuild(harness, organizationId, appIds, {
                pr: 2,
                appName: "web",
                status: "failed",
                startedAt: new Date(NOW.getTime() - 2 * 60_000),
            });
            await seedBuild(harness, organizationId, appIds, {
                pr: 3,
                appName: "web",
                status: "failed",
                startedAt: new Date(NOW.getTime() - 1 * 60_000),
                superseded: true,
            });

            const history = await new PrismaBuildCircuitStore().recentAppBuilds(
                organizationId,
                REPO,
                ["web", "api"],
                50,
            );

            const web = history.get("web") ?? [];
            expect(web).toHaveLength(2); // the superseded one is excluded
            expect(web.every((record) => record.status === "failed")).toBe(true);
            // Newest-first: PR 2 (more recent) before PR 1.
            expect(web[0]!.finishedAt.getTime()).toBeGreaterThan(web[1]!.finishedAt.getTime());
            // api has no builds - a present-but-empty bucket (per-app query returns one per app).
            expect(history.get("api")).toEqual([]);
        });

        test("a low-volume failing app still trips even when a sibling app is very high-volume", async ({
            harness,
        }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            const appIds = await harness.createTopology(organizationId, REPO_ID, ["web", "api"]);

            // `api` is noisy: 30 successful builds, all NEWER than web's failures. A global
            // `take` would fill entirely with these and starve web out; a per-app query does not.
            for (let pr = 100; pr < 130; pr++) {
                await seedBuild(harness, organizationId, appIds, {
                    pr,
                    appName: "api",
                    status: "success",
                    startedAt: new Date(NOW.getTime() - 60_000 + (pr - 100) * 1000),
                });
            }
            // `web` is low-volume and hopeless: exactly THRESHOLD failures, older.
            for (let pr = 1; pr <= THRESHOLD; pr++) {
                await seedBuild(harness, organizationId, appIds, {
                    pr,
                    appName: "web",
                    status: "failed",
                    startedAt: new Date(NOW.getTime() - (THRESHOLD - pr + 10) * 60_000),
                });
            }
            const { breaker } = makeBreaker();

            const decision = await breaker.evaluate(target(organizationId), ["web", "api"]);

            expect(decision.blocked).toBe(true);
            if (decision.blocked) {
                expect(decision.trippedApps.map((app) => app.appName)).toEqual(["web"]);
            }
        });

        test("opens, blocks, alerts once, and persists the circuit row after N consecutive failures", async ({
            harness,
        }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            const appIds = await harness.createTopology(organizationId, REPO_ID, ["web"]);
            for (let pr = 1; pr <= THRESHOLD; pr++) {
                await seedBuild(harness, organizationId, appIds, {
                    pr,
                    appName: "web",
                    status: "failed",
                    startedAt: new Date(NOW.getTime() - (THRESHOLD - pr + 1) * 60_000),
                });
            }
            const { breaker, alert } = makeBreaker();

            const first = await breaker.evaluate(target(organizationId), ["web"]);
            const second = await breaker.evaluate(target(organizationId), ["web"]);

            expect(first.blocked).toBe(true);
            expect(second.blocked).toBe(true);
            // Fire once, not per push.
            expect(alert).toHaveBeenCalledTimes(1);

            const row = await harness.db.previewkitBuildCircuit.findUnique({
                where: {
                    organizationId_repoFullName_appName: { organizationId, repoFullName: REPO, appName: "web" },
                },
            });
            expect(row?.openedAt).not.toBeNull();
            expect(row?.consecutiveFailures).toBe(THRESHOLD);
        });

        test("half-open lets exactly one probe through, then blocks concurrent pushes (probedAt persisted)", async ({
            harness,
        }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            const appIds = await harness.createTopology(organizationId, REPO_ID, ["web"]);
            // All failures older than the cooldown, so the circuit is half-open.
            for (let pr = 1; pr <= THRESHOLD; pr++) {
                await seedBuild(harness, organizationId, appIds, {
                    pr,
                    appName: "web",
                    status: "failed",
                    startedAt: new Date(NOW.getTime() - COOLDOWN_MS - (THRESHOLD - pr + 1) * 60_000),
                });
            }
            const { breaker } = makeBreaker();

            const first = await breaker.evaluate(target(organizationId), ["web"]); // the probe
            const second = await breaker.evaluate(target(organizationId), ["web"]); // in flight -> blocked

            expect(first.blocked).toBe(false);
            expect(second.blocked).toBe(true);
            const row = await harness.db.previewkitBuildCircuit.findUnique({
                where: {
                    organizationId_repoFullName_appName: { organizationId, repoFullName: REPO, appName: "web" },
                },
            });
            expect(row?.probedAt).not.toBeNull();
        });

        test("closes the circuit once a newer build succeeds", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            const appIds = await harness.createTopology(organizationId, REPO_ID, ["web"]);
            for (let pr = 1; pr <= THRESHOLD; pr++) {
                await seedBuild(harness, organizationId, appIds, {
                    pr,
                    appName: "web",
                    status: "failed",
                    startedAt: new Date(NOW.getTime() - (THRESHOLD - pr + 2) * 60_000),
                });
            }
            const { breaker, alert } = makeBreaker();
            await breaker.evaluate(target(organizationId), ["web"]); // opens

            // A newer successful build breaks the streak.
            await seedBuild(harness, organizationId, appIds, {
                pr: 99,
                appName: "web",
                status: "success",
                startedAt: new Date(NOW.getTime() - 60_000),
            });
            const afterFix = await breaker.evaluate(target(organizationId), ["web"]);

            expect(afterFix.blocked).toBe(false);
            expect(alert).toHaveBeenCalledTimes(1); // no re-alert on close
            const row = await harness.db.previewkitBuildCircuit.findUnique({
                where: {
                    organizationId_repoFullName_appName: { organizationId, repoFullName: REPO, appName: "web" },
                },
            });
            expect(row?.openedAt).toBeNull();
        });

        test("a manual reset lets the next build through even before the cooldown", async ({ harness }) => {
            const organizationId = await harness.createInstallationForOwner("acme");
            const appIds = await harness.createTopology(organizationId, REPO_ID, ["web"]);
            for (let pr = 1; pr <= THRESHOLD; pr++) {
                await seedBuild(harness, organizationId, appIds, {
                    pr,
                    appName: "web",
                    status: "failed",
                    startedAt: new Date(NOW.getTime() - (THRESHOLD - pr + 1) * 60_000),
                });
            }
            const { breaker } = makeBreaker();
            expect((await breaker.evaluate(target(organizationId), ["web"])).blocked).toBe(true);

            // Reset boundary is after every seeded failure, so the streak no longer counts.
            await resetBuildCircuit(organizationId, REPO, "web", NOW);

            expect((await breaker.evaluate(target(organizationId), ["web"])).blocked).toBe(false);
        });
    },
});
