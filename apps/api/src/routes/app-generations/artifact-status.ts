import type { PrismaClient } from "@autonoma/db";
import { type ArtifactStatus, type ArtifactStatusItem, FileDataSchema } from "@autonoma/types";
import { resolveAppProtocol } from "../onboarding/setup-protocol";
import { artifactEventWhere } from "./artifact-file-events";
import { areArtifactsComplete } from "./artifacts-complete";

/**
 * Per-artifact upload progress plus the canonical `complete` flag, shared by the
 * onboarding Setup status endpoint and the onboarding state's `artifactsUploaded`
 * so the step-2 header, the per-item checks, and the bottom banner stay in sync.
 *
 * Artifact receipt remains app-wide so a retry can reuse earlier uploads, while the
 * latest non-failed setup selects the protocol and owns the completion signal.
 */
export async function computeArtifactStatus(
    db: PrismaClient,
    applicationId: string,
    organizationId?: string,
): Promise<ArtifactStatus> {
    // Push every filter into the DB instead of pulling all setups + their events into memory. Each
    // probe is an existence check or a targeted fetch; the recipe is a plain count of active scenario
    // recipe versions. Which events carry which artifact comes from `artifactEventWhere`, shared with
    // the Finish setup gate so the two cannot look in different places.
    const [setup, kbEvent, scenariosEvent, testEvents, scenarioCount] = await Promise.all([
        resolveAppProtocol(db, applicationId, { organizationId }),
        db.applicationSetupEvent.findFirst({
            where: artifactEventWhere(applicationId, "kb", organizationId),
            select: { id: true },
        }),
        db.applicationSetupEvent.findFirst({
            where: artifactEventWhere(applicationId, "scenarios", organizationId),
            select: { id: true },
        }),
        db.applicationSetupEvent.findMany({
            where: artifactEventWhere(applicationId, "tests", organizationId),
            select: { data: true },
        }),
        db.scenario.count({
            where: { applicationId, organizationId, activeRecipeVersionId: { not: null } },
        }),
    ]);

    const { protocolVersion, setupCompleted: complete } = setup;
    const hasKb = kbEvent != null;
    const hasScenarios = scenariosEvent != null;
    // Dedupe across setups: the same file can be recorded under more than one setup
    // (e.g. a re-upload targeting a fresh generation id), so count distinct paths.
    const testCount = new Set(
        testEvents.flatMap((event) => {
            const parsed = FileDataSchema.safeParse(event.data);
            return parsed.success ? [parsed.data.filePath] : [];
        }),
    ).size;

    const sharedArtifacts: ArtifactStatusItem[] = [
        {
            key: "tests",
            received: testCount > 0,
            meta: testCount > 0 ? `${testCount} file${testCount === 1 ? "" : "s"}` : undefined,
        },
        { key: "kb", received: hasKb },
    ];
    const artifacts: ArtifactStatusItem[] =
        protocolVersion === "2.0"
            ? sharedArtifacts
            : [
                  {
                      key: "recipe",
                      received: scenarioCount > 0,
                      meta:
                          scenarioCount > 0 ? `${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}` : undefined,
                  },
                  ...sharedArtifacts,
                  { key: "scenarios", received: hasScenarios },
              ];

    const stepComplete = areArtifactsComplete({
        protocolVersion,
        setupCompleted: complete,
        hasRecipe: scenarioCount > 0,
        hasTests: testCount > 0,
        hasKb,
        hasScenarios,
    });

    return { protocolVersion, complete, stepComplete, artifacts };
}
