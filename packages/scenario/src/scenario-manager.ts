import { randomUUID } from "node:crypto";
import type { PrismaClient, ScenarioInstance } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import {
    normalizeProtocolVersion,
    RefsSchema,
    type DiscoverResponse,
    type ScenarioRecipe,
    type ScenarioVariableScalar,
    type UpResponse,
} from "@autonoma/types";
import { resolveRecipePayload } from "@autonoma/types/scenario-recipe-resolver";
import { withColdStartRetry } from "./cold-start-retry";
import { DbSdkCallRecorder } from "./db-sdk-call-recorder";
import type { EncryptionHelper } from "./encryption";
import { hashRecipe } from "./hash-recipe";
import { ScenarioRecipeStore } from "./scenario-recipe-store";
import type { ScenarioSubject } from "./scenario-subject";
import { SdkCallError } from "./sdk-call-error";
import { SdkClient, type SdkCallOptions, type SdkDownParams } from "./sdk-client";
import { resolveSdkConfig, type SdkConfig } from "./sdk-config-resolver";

const DEFAULT_EXPIRES_IN_SECONDS = 2 * 60 * 60; // 2 hours

/** Build the persisted `lastError` from a caught throw, carrying the `SdkFailure` tag when the SDK client raised it
 * (so the analysis workflow classifies from the tag) and degrading to message-only for any other failure. */
function toScenarioLastError(err: unknown): PrismaJson.ScenarioLastError {
    const message = err instanceof Error ? err.message : String(err);
    return err instanceof SdkCallError ? { message, failure: err.failure } : { message };
}

interface ScenarioApplicationData {
    organizationId: string;
    sdkConfig: SdkConfig;
}

export class ScenarioManager {
    private readonly logger: Logger;
    private readonly recipeStore: ScenarioRecipeStore;
    private readonly recorder: DbSdkCallRecorder;

    constructor(
        private readonly db: PrismaClient,
        private readonly encryption: EncryptionHelper,
    ) {
        this.logger = logger.child({ name: this.constructor.name });
        this.recipeStore = new ScenarioRecipeStore(db);
        this.recorder = new DbSdkCallRecorder(db);
    }

    /**
     * `sdkUrlOverride` asks a specific endpoint what it can build rather than the one the deployment
     * row records - which is what lets a caller interrogate a preview that has only just announced
     * itself, before any deployment row points at it.
     */
    async discover(
        applicationId: string,
        deploymentId: string,
        options?: SdkCallOptions,
        sdkUrlOverride?: string,
    ): Promise<DiscoverResponse> {
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId, sdkUrlOverride);
        const sdkClient = this.createSdkClient(applicationData);

        this.logger.info("Calling discover on SDK endpoint", { applicationId });
        const response = await sdkClient.discover(options);

        this.logger.info("Discover completed", {
            applicationId,
            extra: { modelCount: response.schema?.models.length ?? 0, scenarioCount: response.scenarios?.length },
        });
        return response;
    }

    /**
     * Sync the thin v2 scenario registry from a discover's `scenarios` listing (disable-not-delete).
     * Delegates to the recipe store; exposed here because the deploy-signal handler already holds a manager.
     */
    async syncScenarioRegistry(params: {
        applicationId: string;
        scenarios: Array<{ name: string; description: string }>;
        disableMissing?: boolean;
        discoveredAt?: Date;
        discoveryId?: string;
    }): Promise<{ scenarioCount: number }> {
        return this.recipeStore.syncScenarioRegistry(params);
    }

    /**
     * Set up a scenario environment by calling the SDK endpoint.
     *
     * When `snapshotId` is provided, the recipe version pinned to that snapshot is used.
     * When `snapshotId` is omitted (dry run), the scenario's active recipe version is used.
     *
     * `candidateRecipe` overrides both: the given recipe is resolved and provisioned as-is
     * and NOTHING about it is persisted, so an agent can try an edit against the real
     * environment without making it the recipe every future run uses. The instance row and
     * its SDK call log are still written - they are how the caller tears the instance back
     * down and reads what the factory actually replied.
     */
    async up(
        subject: ScenarioSubject,
        scenarioId: string,
        opts?: {
            snapshotId?: string;
            candidateRecipe?: ScenarioRecipe;
            sdkOptions?: SdkCallOptions;
            sdkUrlOverride?: string;
            coldStartRetry?: boolean;
        },
    ): Promise<ScenarioInstance> {
        const { snapshotId, candidateRecipe, sdkOptions, sdkUrlOverride, coldStartRetry } = opts ?? {};
        const { applicationId, deploymentId } = await subject.resolveDeployment();
        const applicationData = await this.getApplicationDataForDeployment(applicationId, deploymentId, sdkUrlOverride);
        const { organizationId } = applicationData;
        const sdkClient = this.createSdkClient(applicationData);

        // Scope the scenario to the resolved application, not just its id: this is the
        // tenant-isolation boundary for provisioning. Loading by id alone would let a
        // caller run another application's (another org's) recipe against this app.
        const scenario = await this.db.scenario.findFirst({
            where: { id: scenarioId, applicationId },
            select: { id: true, name: true },
        });
        if (scenario == null) {
            throw new Error(`Scenario "${scenarioId}" not found for application "${applicationId}"`);
        }
        const instanceId = randomUUID();

        // v2 provisions by scenario NAME - the customer's code owns the data, so there is no
        // recipe to resolve and no create payload to send. A candidate recipe is a v1-only
        // concept; on a v2 deployment it has nothing to dry-run against, so it is ignored.
        // The protocol is the app's hand-set flag (resolved into sdkConfig), never auto-detected.
        const protocolVersion = applicationData.sdkConfig.protocolVersion;
        if (protocolVersion === "2.0") {
            if (candidateRecipe != null) {
                this.logger.warn("Ignoring candidate recipe: deployment speaks protocol v2", {
                    applicationId,
                    scenarioName: scenario.name,
                });
            }
            return await this.upV2({
                subject,
                scenarioId: scenario.id,
                scenarioName: scenario.name,
                instanceId,
                applicationId,
                organizationId,
                deploymentId,
                sdkClient,
                sdkOptions,
                coldStartRetry,
            });
        }

        const { createPayload, resolvedVariables, recipeProvenance } = await this.resolveV1Payload({
            scenario,
            candidateRecipe,
            snapshotId,
            instanceId,
        });

        const instance = await this.db.scenarioInstance.create({
            data: {
                id: instanceId,
                applicationId,
                organizationId,
                deploymentId,
                scenarioId: scenario.id,
                status: "REQUESTED",
                protocolVersion,
                expiresAt: new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000),
                recipeVersionId: recipeProvenance.recipeVersionId,
                recipeFingerprint: recipeProvenance.recipeFingerprint,
            },
        });

        return this.executeUp({
            instance,
            subject,
            coldStartRetry,
            logContext: { applicationId, scenarioName: scenario.name },
            callUp: () =>
                sdkClient.up({ protocolVersion: "1.0", instanceId: instance.id, create: createPayload }, sdkOptions),
            onSuccess: (response) => this.markUpSuccess(instance.id, response, createPayload, resolvedVariables),
        });
    }

    /**
     * Resolve the v1 create payload and the provenance to stamp on the run. A candidate recipe is
     * dry-run only (its fingerprint alone identifies it, no version row); a stored recipe is loaded
     * from the pinned/active version, whose identity travels with the payload. Kept branch-typed so
     * `createPayload` stays `Record<string, unknown>` for the SDK call - no post-union sniffing.
     */
    private async resolveV1Payload(params: {
        scenario: { id: string; name: string };
        candidateRecipe?: ScenarioRecipe;
        snapshotId?: string;
        instanceId: string;
    }): Promise<{
        createPayload: Record<string, unknown>;
        resolvedVariables: Record<string, ScenarioVariableScalar>;
        recipeProvenance: { recipeVersionId?: string; recipeFingerprint?: string };
    }> {
        const { scenario, candidateRecipe, snapshotId, instanceId } = params;
        if (candidateRecipe != null) {
            const resolved = resolveRecipePayload(candidateRecipe, instanceId);
            return { ...resolved, recipeProvenance: { recipeFingerprint: hashRecipe(candidateRecipe) } };
        }
        const loaded = await this.recipeStore.loadRecipePayload({
            scenarioId: scenario.id,
            snapshotId,
            testRunId: instanceId,
        });
        if (loaded == null) {
            throw new Error(
                `Scenario "${scenario.name}" does not have a stored recipe version${snapshotId != null ? ` for snapshot ${snapshotId}` : ""}. Complete the Scenario Validation step so the plugin uploads scenario recipes to Autonoma.`,
            );
        }
        return {
            createPayload: loaded.createPayload,
            resolvedVariables: loaded.resolvedVariables,
            recipeProvenance: { recipeVersionId: loaded.recipeVersionId, recipeFingerprint: loaded.recipeFingerprint },
        };
    }

    /**
     * Tear down a provisioned instance.
     *
     * `sdkUrlOverride` MUST match whatever `up` used. The instance records which deployment it
     * belongs to, not which URL it was provisioned against, so an `up` aimed at some other preview
     * would otherwise be torn down against the stored endpoint - leaving the real entities behind.
     * Callers that split up and down across processes cannot rely on this and would need the URL
     * persisted; today's only override caller does both in one function.
     */
    async down(
        scenarioInstanceId: string,
        options?: SdkCallOptions,
        sdkUrlOverride?: string,
    ): Promise<ScenarioInstance | undefined> {
        const instance = await this.db.scenarioInstance.findUnique({
            where: { id: scenarioInstanceId },
        });

        if (instance == null) {
            this.logger.info("Scenario instance not found, skipping", { scenarioInstanceId });
            return undefined;
        }

        if (instance.status === "DOWN_SUCCESS" || instance.status === "DOWN_FAILED") {
            this.logger.info("Scenario already torn down, skipping", {
                instanceId: instance.id,
                status: instance.status,
            });
            return instance;
        }

        if (instance.deploymentId == null) {
            throw new Error(`Scenario instance ${scenarioInstanceId} does not have a deployment`);
        }

        const applicationData = await this.getApplicationDataForDeployment(
            instance.applicationId,
            instance.deploymentId,
            sdkUrlOverride,
        );
        const sdkClient = this.createSdkClient(applicationData);

        this.logger.info("Calling down on SDK endpoint", { scenarioInstanceId, instanceId: instance.id });

        // Down must speak the same protocol up did. The version captured on the INSTANCE at up
        // governs - it is correct even when the deployment row was never updated (an override
        // dry-run) or has since flipped; fall back to the deployment's version for legacy
        // instances predating the column, then to v1 (the installed base). v2 sends only the
        // opaque teardown token (its own column); the SDK verifies it and routes by the scenario
        // name signed inside it - no plaintext refs or name on the wire.
        const downProtocol =
            instance.protocolVersion != null
                ? normalizeProtocolVersion(instance.protocolVersion)
                : applicationData.sdkConfig.protocolVersion;
        const downParams: SdkDownParams =
            downProtocol === "2.0"
                ? {
                      protocolVersion: "2.0",
                      instanceId: instance.id,
                      teardownToken: instance.teardownToken ?? undefined,
                  }
                : {
                      protocolVersion: "1.0",
                      instanceId: instance.id,
                      refs: RefsSchema.nullable().catch(null).parse(instance.refs),
                      refsToken: instance.refsToken ?? undefined,
                  };

        try {
            await sdkClient.down(downParams, options);
        } catch (err) {
            const lastError = toScenarioLastError(err);
            this.logger.error("Scenario down failed", { error: lastError.message, instanceId: instance.id });
            return this.markDownFailure(instance.id, lastError);
        }

        this.logger.info("Scenario down succeeded", { instanceId: instance.id });
        return this.markDownSuccess(instance.id);
    }

    /**
     * The v2 provisioning path: no recipe, no create payload. The SDK is asked for the
     * scenario by name and returns auth plus the opaque teardown token.
     */
    private async upV2(params: {
        subject: ScenarioSubject;
        scenarioId: string;
        scenarioName: string;
        instanceId: string;
        applicationId: string;
        organizationId: string;
        deploymentId: string;
        sdkClient: SdkClient;
        sdkOptions?: SdkCallOptions;
        coldStartRetry?: boolean;
    }): Promise<ScenarioInstance> {
        const { subject, scenarioId, scenarioName, instanceId, applicationId, organizationId, deploymentId } = params;
        const { sdkClient, sdkOptions, coldStartRetry } = params;

        const instance = await this.db.scenarioInstance.create({
            data: {
                id: instanceId,
                applicationId,
                organizationId,
                deploymentId,
                scenarioId,
                status: "REQUESTED",
                protocolVersion: "2.0",
                expiresAt: new Date(Date.now() + DEFAULT_EXPIRES_IN_SECONDS * 1000),
            },
        });

        return this.executeUp({
            instance,
            subject,
            coldStartRetry,
            logContext: { applicationId, scenarioName },
            callUp: () => sdkClient.up({ protocolVersion: "2.0", instanceId: instance.id, scenarioName }, sdkOptions),
            validate: (response) =>
                response.teardownToken == null || response.teardownToken.trim() === ""
                    ? {
                          message: `Scenario "${scenarioName}" returned no teardownToken. Scenario v2 up must return a non-empty opaque teardown token.`,
                      }
                    : undefined,
            onSuccess: (response) => this.markUpSuccessV2(instance.id, response),
        });
    }

    /**
     * Shared provisioning shell for both protocols: link the instance, call `up` (riding through a
     * cold-start 503 with a bounded retry when the caller opts in), optionally validate the response,
     * and hand off to the protocol's success-writer. v1 and v2 differ only in the create data (written
     * by the caller before this runs), the request body (`callUp`), the optional `validate`, and `onSuccess`.
     */
    private async executeUp(params: {
        instance: ScenarioInstance;
        subject: ScenarioSubject;
        coldStartRetry?: boolean;
        logContext: { applicationId: string; scenarioName: string };
        callUp: () => Promise<UpResponse>;
        validate?: (response: UpResponse) => PrismaJson.ScenarioLastError | undefined;
        onSuccess: (response: UpResponse) => Promise<ScenarioInstance>;
    }): Promise<ScenarioInstance> {
        const { instance, subject, coldStartRetry, logContext, callUp, validate, onSuccess } = params;

        await subject.linkInstance?.(instance.id);

        this.logger.info("Calling up on SDK endpoint", { ...logContext, instanceId: instance.id });

        let response: UpResponse;
        try {
            // A scaled-to-zero ("serverless") preview 503s on the first hit while it wakes. When the
            // caller opts in (e.g. an onboarding dry-run), ride through that with a bounded retry so a
            // cold environment isn't mistaken for a broken recipe.
            response =
                coldStartRetry === true ? await withColdStartRetry(callUp, { logger: this.logger }) : await callUp();
        } catch (err) {
            const lastError = toScenarioLastError(err);
            this.logger.error("Scenario up failed", { error: lastError.message, instanceId: instance.id });
            return this.markUpFailure(instance.id, lastError);
        }

        const invalid = validate?.(response);
        if (invalid != null) {
            this.logger.error("Scenario up returned an invalid response", {
                ...logContext,
                error: invalid.message,
                instanceId: instance.id,
            });
            return this.markUpFailure(instance.id, invalid);
        }

        this.logger.info("Scenario up succeeded", { instanceId: instance.id });
        return onSuccess(response);
    }

    // -----------------------------------------------------------------------
    // Instance state transitions. Each method writes one row of the state
    // machine: REQUESTED -> UP_SUCCESS | UP_FAILED -> DOWN_SUCCESS | DOWN_FAILED.
    // -----------------------------------------------------------------------

    private markUpSuccess(
        instanceId: string,
        response: UpResponse,
        createPayload: unknown,
        resolvedVariables: Record<string, ScenarioVariableScalar>,
    ): Promise<ScenarioInstance> {
        const expiresInSeconds = response.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
        const hasResolvedVariables = Object.keys(resolvedVariables).length > 0;
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "UP_SUCCESS",
                upAt: new Date(),
                expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
                auth: response.auth,
                refs: response.refs,
                refsToken: response.refsToken,
                metadata: response.metadata,
                generatedData: createPayload,
                ...(hasResolvedVariables ? { resolvedVariables } : {}),
            },
        });
    }

    /** v2 counterpart of {@link markUpSuccess}: never writes the v1-only recipe columns. */
    private markUpSuccessV2(instanceId: string, response: UpResponse): Promise<ScenarioInstance> {
        const expiresInSeconds = response.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "UP_SUCCESS",
                upAt: new Date(),
                expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
                auth: response.auth,
                // v2 carries teardown state only in the opaque token; store it in its own column
                // (no plaintext refs) and hand it back verbatim at down.
                teardownToken: response.teardownToken,
            },
        });
    }

    private markUpFailure(instanceId: string, lastError: PrismaJson.ScenarioLastError): Promise<ScenarioInstance> {
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "UP_FAILED",
                lastError,
                completedAt: new Date(),
            },
        });
    }

    private markDownSuccess(instanceId: string): Promise<ScenarioInstance> {
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "DOWN_SUCCESS",
                downAt: new Date(),
                completedAt: new Date(),
            },
        });
    }

    private markDownFailure(instanceId: string, lastError: PrismaJson.ScenarioLastError): Promise<ScenarioInstance> {
        return this.db.scenarioInstance.update({
            where: { id: instanceId },
            data: {
                status: "DOWN_FAILED",
                downAt: new Date(),
                completedAt: new Date(),
                lastError,
            },
        });
    }

    private async getApplicationDataForDeployment(
        applicationId: string,
        deploymentId: string,
        sdkUrlOverride?: string,
    ): Promise<ScenarioApplicationData> {
        const sdkConfig = await resolveSdkConfig({
            applicationId,
            deploymentId,
            db: this.db,
            encryption: this.encryption,
            sdkUrlOverride,
        });

        const application = await this.db.application.findUniqueOrThrow({
            where: { id: applicationId },
            select: { organizationId: true },
        });

        return { organizationId: application.organizationId, sdkConfig };
    }

    private createSdkClient(applicationData: ScenarioApplicationData): SdkClient {
        return new SdkClient({
            applicationId: applicationData.sdkConfig.applicationId,
            sdkUrl: applicationData.sdkConfig.sdkUrl,
            signingSecret: applicationData.sdkConfig.signingSecret,
            customHeaders: applicationData.sdkConfig.customHeaders,
            recorder: this.recorder,
        });
    }
}
