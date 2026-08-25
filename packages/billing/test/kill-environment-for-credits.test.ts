import { PreviewkitAppStatus } from "@autonoma/db";
import { integrationTestSuite } from "@autonoma/integration-test";
import { logger } from "@autonoma/logger";
import { expect } from "vitest";
import { killEnvironmentForCreditExhaustion } from "../src/kill-environment-for-credits";
import { BillingTestHarness } from "./billing-harness";

const KILL_REASON = "Insufficient credits - build/deploy stopped mid-run";

/** The environment's apps: two still in flight, plus one that already failed on its own. */
const APP_INSTANCES: ReadonlyArray<{ appName: string; status: PreviewkitAppStatus; port: number; error?: string }> = [
    { appName: "web", status: PreviewkitAppStatus.building, port: 3000 },
    { appName: "worker", status: PreviewkitAppStatus.pending, port: 3001 },
    // Already terminal - must be left alone, not relabelled with this error.
    { appName: "api", status: PreviewkitAppStatus.build_failed, port: 3002, error: "boom" },
];

integrationTestSuite({
    name: "killEnvironmentForCreditExhaustion",
    createHarness: () => BillingTestHarness.create(),
    cases: (test) => {
        test("marks the environment failed and every in-flight app row deploy_failed", async ({ harness }) => {
            const orgId = await harness.createOrgWithBalance(0);
            const environment = await harness.createPreviewkitEnvironment({
                organizationId: orgId,
                status: "building",
            });
            // Each instance FKs a topology app row, and they share one config, so seed them in order.
            for (const app of APP_INSTANCES) {
                const appId = await harness.createPreviewkitApp(orgId, app.appName);
                await harness.db.previewkitAppInstance.create({
                    data: {
                        environmentId: environment.id,
                        appId,
                        appName: app.appName,
                        status: app.status,
                        port: app.port,
                        error: app.error,
                    },
                });
            }

            await killEnvironmentForCreditExhaustion(harness.db, environment.namespace, KILL_REASON, logger);

            const updatedEnv = await harness.db.previewkitEnvironment.findUniqueOrThrow({
                where: { namespace: environment.namespace },
            });
            expect(updatedEnv.status).toBe("failed");
            expect(updatedEnv.phase).toBe("failed");
            expect(updatedEnv.error).toBe(KILL_REASON);

            const apps = await harness.db.previewkitAppInstance.findMany({
                where: { environmentId: environment.id },
                orderBy: { appName: "asc" },
            });
            expect(apps.map((app) => [app.appName, app.status, app.error])).toEqual([
                ["api", "build_failed", "boom"],
                ["web", "deploy_failed", KILL_REASON],
                ["worker", "deploy_failed", KILL_REASON],
            ]);
        });

        test("is a no-op when no environment row exists for the namespace", async ({ harness }) => {
            await expect(
                killEnvironmentForCreditExhaustion(harness.db, "preview-does-not-exist", KILL_REASON, logger),
            ).resolves.toBeUndefined();
        });
    },
});
