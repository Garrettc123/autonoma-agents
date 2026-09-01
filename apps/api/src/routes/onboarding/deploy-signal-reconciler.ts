import type { PrismaClient, Scenario } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import { reconcileTestPlanScenarios, type ScenarioManager } from "@autonoma/scenario";
import { type DiscoverResponse, normalizeProtocolVersion, ScenarioRecipeSchema } from "@autonoma/types";
import type { DeploymentSignalBody } from "./deployment-signal";
import { resolveAppProtocol } from "./setup-protocol";

/**
 * Reconciles a just-deployed SDK endpoint against what this database holds, and answers "which
 * scenarios did the live discovery batch surface". Split out of `OnboardingManager` because the
 * deploy-signal/reconcile concern is self-contained: it owns the v2 scenario-name registry sync
 * (driven by the app's protocol flag, not by detecting the wire), and it is the reader that must
 * agree with it about the live batch.
 */
export class DeploySignalReconciler {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly scenarioManager: ScenarioManager,
    ) {
        this.logger = logger.child({ name: "DeploySignalReconciler" });
    }

    /**
     * Reconcile the just-deployed endpoint against what this database holds, with a single discover.
     *
     * Discover goes to `body.sdkUrl` - the endpoint that just announced itself - not to whatever the
     * deployment row still points at, or this would interrogate the wrong build. The app's hand-set
     * protocol flag (not the discover's shape) decides what the one response drives:
     *
     * - v2: sync the thin scenario registry (name + description, disable-not-delete) from the discover's
     *   `scenarios` listing - but only for a MAIN deploy, so a PR preview advertising renamed scenarios
     *   can't disable a name main's suite still binds to. There is no recipe to check.
     * - v1: refuse a deploy whose code can no longer build the recipes its tests provision from. The
     *   recipes live here; the factory registry lives in the deployed app; nothing links them, so a
     *   deleted factory silently breaks every run (the SDK rejects the whole create graph over one unknown
     *   model). This turns that into a rejected signal naming the model.
     *
     * Fails OPEN on everything except a v1 discover that disagrees: no snapshot, no recipes, no deployment
     * to borrow config from, or an endpoint that will not answer are all ordinary states, and a signal is
     * far too load-bearing to drop over a check that could not run.
     */
    async reconcileDeployedScenarios(
        application: {
            id: string;
            protocolVersion: string;
            mainBranch: { deploymentId: string | null; activeSnapshotId: string | null } | null;
        },
        body: DeploymentSignalBody,
        isMainDeploy: boolean,
    ): Promise<void> {
        const snapshotId = application.mainBranch?.activeSnapshotId;
        const deploymentId = application.mainBranch?.deploymentId;
        if (deploymentId == null) return;

        const discovered = await this.tryDiscover(application.id, deploymentId, body.sdkUrl);
        if (discovered == null) return;

        // The app's hand-set protocol flag decides the branch - never the discover's shape (there is no
        // auto-detection). v2 syncs the thin scenario-name registry, but only for a MAIN deploy so a PR
        // preview advertising renamed scenarios can't disable a name main's suite still binds to. v1 refuses
        // a deploy whose code can no longer build the recipes its tests provision from.
        if (normalizeProtocolVersion(application.protocolVersion) === "2.0") {
            if (!isMainDeploy) return;
            // Fail open (see the class contract above): a registry write failure is an ordinary transient
            // error, so it must leave the registry stale rather than drop the whole deploy signal - which
            // also carries the preview URL and the diff trigger.
            await this.syncV2Registry(application.id, discovered).catch((err: unknown) => {
                this.logger.warn("Failed to sync v2 scenario registry from deploy signal; leaving it stale", {
                    applicationId: application.id,
                    extra: { err },
                });
            });
            return;
        }

        await this.assertV1RecipesBuildable(application.id, snapshotId, discovered);
    }

    /** List only the scenarios observed in the discovery batch the Finish setup dry run is validating. */
    async listDiscoveredScenarios(applicationId: string, organizationId: string): Promise<Scenario[]> {
        this.logger.info("Listing discovered onboarding scenarios", { applicationId, organizationId });
        const [application, setup, state] = await Promise.all([
            this.db.application.findFirst({ where: { id: applicationId, organizationId }, select: { id: true } }),
            resolveAppProtocol(this.db, applicationId, { organizationId }),
            this.db.onboardingState.findUnique({
                where: { applicationId },
                select: { lastDiscoveryId: true },
            }),
        ]);
        if (application == null) throw new NotFoundError("Application not found");

        if (setup.protocolVersion === "2.0") {
            if (state?.lastDiscoveryId == null) return [];
            return await this.db.scenario.findMany({
                where: { applicationId, isDisabled: false, discoveryId: state.lastDiscoveryId },
                orderBy: { name: "asc" },
            });
        }

        return await this.db.scenario.findMany({
            where: { applicationId, isDisabled: false, activeRecipeVersionId: { not: null } },
            orderBy: { name: "asc" },
        });
    }

    /** Discover the just-announced endpoint, failing open (a signal is too load-bearing to drop). */
    private async tryDiscover(
        applicationId: string,
        deploymentId: string,
        sdkUrl: string | undefined,
    ): Promise<DiscoverResponse | undefined> {
        try {
            return await this.scenarioManager.discover(applicationId, deploymentId, undefined, sdkUrl);
        } catch (err) {
            this.logger.warn("Discover failed - not reconciling the deployed endpoint", {
                applicationId,
                extra: { deploymentId, sdkUrl },
                err,
            });
            return undefined;
        }
    }

    /** Sync the thin v2 registry, pinning the synced names to the discovery batch onboarding recorded. */
    private async syncV2Registry(applicationId: string, discovered: DiscoverResponse): Promise<void> {
        const scenarios = (discovered.scenarios ?? []).map((scenario) => ({
            name: scenario.name,
            description: scenario.description,
        }));
        // Reuse the batch onboarding already recorded (`lastDiscoveryId` / `lastDiscoveredAt`), not a fresh
        // one. Setup-state and `listDiscoveredScenarios` identify the live batch by that key; minting a new
        // one here would strand every scenario outside it. Reusing it leaves a completed dry run intact
        // across a routine redeploy - a genuinely new scenario still lands with no in-batch teardown, so it
        // correctly re-opens `dryRunPassed` until validated. When absent (SDK not yet configured through
        // onboarding) the sync leaves the id null; nothing surfaces the batch until onboarding stamps it.
        const onboarding = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { lastDiscoveredAt: true, lastDiscoveryId: true },
        });
        await this.scenarioManager.syncScenarioRegistry({
            applicationId,
            scenarios,
            discoveredAt: onboarding?.lastDiscoveredAt ?? undefined,
            discoveryId: onboarding?.lastDiscoveryId ?? undefined,
        });
        await reconcileTestPlanScenarios(
            this.db,
            applicationId,
            scenarios.map((scenario) => scenario.name),
            this.logger,
        );
        this.logger.info("Synced v2 scenario registry from deploy signal", {
            applicationId,
            extra: { scenarioCount: scenarios.length },
        });
    }

    /** Reject a v1 deploy whose code can no longer build a model the stored recipes provision from. */
    private async assertV1RecipesBuildable(
        applicationId: string,
        snapshotId: string | null | undefined,
        discovered: DiscoverResponse,
    ): Promise<void> {
        const models = discovered.schema?.models ?? [];
        if (snapshotId == null || models.length === 0) return;

        const stored = await this.db.scenarioRecipeVersion.findMany({
            where: { applicationId, snapshotId },
            select: { scenarioNameSnapshot: true, fixtureJson: true },
        });
        if (stored.length === 0) return;

        const knownModels = new Set(models.map((model) => model.name));
        const unbuildable = stored.flatMap((version) => {
            const recipe = ScenarioRecipeSchema.safeParse(version.fixtureJson);
            if (!recipe.success) return [];
            return Object.keys(recipe.data.create)
                .filter((model) => !knownModels.has(model))
                .map((model) => `${version.scenarioNameSnapshot}: ${model}`);
        });

        if (unbuildable.length === 0) {
            this.logger.info("Deployed code can build every model the recipes name", {
                applicationId,
                extra: { snapshotId, knownModelCount: knownModels.size, recipeCount: stored.length },
            });
            return;
        }

        this.logger.error("Rejecting deployment signal: the deployed code cannot build the stored recipes", {
            applicationId,
            extra: { snapshotId, unbuildable },
        });
        throw new BadRequestError(
            `The deployed SDK endpoint has no factory for ${unbuildable.join(", ")}. Every scenario naming ` +
                `those models will fail to provision, so no test would run against this deployment. Register the ` +
                `factory again, or upload a recipe that no longer asks for the entity.`,
        );
    }
}
