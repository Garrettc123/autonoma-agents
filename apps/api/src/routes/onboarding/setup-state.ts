import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { normalizeProtocolVersion } from "@autonoma/types";
import { artifactEventWhere } from "../app-generations/artifact-file-events";
import { areArtifactsComplete } from "../app-generations/artifacts-complete";
import { isInDiscoveryBatch } from "./discovery-batch";
import { resolveAppProtocol } from "./setup-protocol";

/**
 * The four independent signals the Finish setup gate is derived from, plus the gate itself.
 *
 * Read by both `onboarding.navState` (which needs only `setupComplete`) and `onboarding.getState`
 * (which surfaces every signal as a checklist), so the gate is defined in exactly one place.
 */
export interface SetupState {
    sdkConfigured: boolean;
    dryRunPassed: boolean;
    artifactsUploaded: boolean;
    hasContent: boolean;
    setupComplete: boolean;
}

/**
 * Whether an application has finished Finish setup, in one wave of existence probes and no writes.
 *
 * Two independent routes reach completion. The first is the real flow: the SDK discovered, every
 * artifact landed, and every provisionable scenario tore down cleanly at least once. The second is
 * a compatibility path for applications whose content arrived without a completed planner run -
 * they have scenarios and tests, so there is nothing left to ask them for.
 *
 * Deliberately derived rather than stored: `dryRunPassed`'s input is written by every real
 * pull-request test-run teardown (not just the onboarding dry run), and the predicate is not
 * monotonic - `artifactsUploaded` turning true can withdraw completion granted by the
 * compatibility route. A persisted copy would need a writer hook in five packages and would still
 * drift.
 */
export async function computeSetupState(db: PrismaClient, applicationId: string, logger: Logger): Promise<SetupState> {
    const [row, scenarios, testCase, setup, kbEvent, scenariosEvent, testEvent] = await Promise.all([
        db.onboardingState.findUnique({
            where: { applicationId },
            select: { lastDiscoveredAt: true, lastDiscoveryId: true },
        }),
        // One read answers all three scenario questions below: any scenario at all, any with an
        // active recipe, and the stricter provisionable set. An application has a handful.
        db.scenario.findMany({
            where: { applicationId },
            select: { id: true, isDisabled: true, activeRecipeVersionId: true, discoveryId: true },
        }),
        db.testCase.findFirst({ where: { applicationId }, select: { id: true } }),
        resolveAppProtocol(db, applicationId),
        db.applicationSetupEvent.findFirst({
            where: artifactEventWhere(applicationId, "kb"),
            select: { id: true },
        }),
        db.applicationSetupEvent.findFirst({
            where: artifactEventWhere(applicationId, "scenarios"),
            select: { id: true },
        }),
        // Existence, not a count: the checklist needs "3 files", the gate only needs "any". Probing
        // stops at the first row instead of pulling every matching event's JSON payload back to
        // dedupe paths in memory - the same question, asked the cheap way.
        db.applicationSetupEvent.findFirst({
            where: artifactEventWhere(applicationId, "tests"),
            select: { id: true },
        }),
    ]);

    const { protocolVersion, setupCompleted } = setup;
    const lastDiscoveredAtDate = row?.lastDiscoveredAt ?? undefined;
    const lastDiscoveryId = row?.lastDiscoveryId ?? undefined;
    const provisionable = scenarios.filter((scenario) => {
        if (scenario.isDisabled) return false;
        if (protocolVersion === "1.0") return scenario.activeRecipeVersionId != null;
        return isInDiscoveryBatch(scenario, lastDiscoveryId);
    });
    const validatedScenarioIds = await provisionedScenarioIds(db, applicationId, protocolVersion, lastDiscoveredAtDate);

    const sdkConfigured = row?.lastDiscoveredAt != null;
    const dryRunPassed =
        provisionable.length > 0 && provisionable.every((candidate) => validatedScenarioIds.has(candidate.id));
    const artifactsUploaded = areArtifactsComplete({
        protocolVersion,
        setupCompleted,
        hasRecipe: scenarios.some((scenario) => scenario.activeRecipeVersionId != null),
        hasTests: testEvent != null,
        hasKb: kbEvent != null,
        hasScenarios: scenariosEvent != null,
    });
    const hasContent = scenarios.length > 0 && testCase != null;

    const completedTheRealFlow = sdkConfigured && dryRunPassed && artifactsUploaded;
    const arrivedWithContentAlready = protocolVersion === "1.0" && hasContent && !artifactsUploaded;
    const setupComplete = completedTheRealFlow || arrivedWithContentAlready;

    logger.info("Computed onboarding setup state", {
        application: { applicationId },
        extra: { protocolVersion, sdkConfigured, dryRunPassed, artifactsUploaded, hasContent, setupComplete },
    });

    return { sdkConfigured, dryRunPassed, artifactsUploaded, hasContent, setupComplete };
}

/**
 * The scenario ids with at least one qualifying `DOWN_SUCCESS` teardown. Bounded and deduped at the query
 * (distinct by scenario, and for v2 the recency predicate pushed into the WHERE) so a UI-polled path stays
 * O(scenario count) rather than reading every DOWN_SUCCESS instance the app has ever produced.
 */
async function provisionedScenarioIds(
    db: PrismaClient,
    applicationId: string,
    protocolVersion: ReturnType<typeof normalizeProtocolVersion>,
    lastDiscoveredAt: Date | undefined,
): Promise<Set<string>> {
    // A v2 app that has not discovered yet can have no qualifying teardown, so skip the read entirely.
    if (protocolVersion === "2.0" && lastDiscoveredAt == null) return new Set();
    const rows = await db.scenarioInstance.findMany({
        where:
            protocolVersion === "2.0"
                ? {
                      applicationId,
                      status: "DOWN_SUCCESS",
                      protocolVersion: "2.0",
                      createdAt: { gte: lastDiscoveredAt },
                  }
                : { applicationId, status: "DOWN_SUCCESS" },
        select: { scenarioId: true },
        distinct: ["scenarioId"],
    });
    return new Set(rows.map((instance) => instance.scenarioId));
}
