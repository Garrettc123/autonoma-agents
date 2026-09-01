import type { PrismaClient } from "@autonoma/db";
import { normalizeProtocolVersion, type ScenarioProtocolVersion } from "@autonoma/types";

/**
 * The application's Scenario protocol and whether a setup of that protocol has completed.
 *
 * The protocol is the hand-set flag on `Application` (`protocolVersion`) - the planner mirrors its
 * onboarding choice into it, and an operator can flip it in admin. It is the single source of truth read
 * everywhere (setup-state, artifact-status, listDiscoveredScenarios, and the provisioning wire); there is
 * no endpoint auto-detection. "Completed" means a non-failed `ApplicationSetup` of that same protocol
 * reached `completed`, which gates the Finish-setup surfaces.
 */
export async function resolveAppProtocol(
    db: PrismaClient,
    applicationId: string,
    opts?: { organizationId?: string },
): Promise<{ protocolVersion: ScenarioProtocolVersion; setupCompleted: boolean }> {
    const [app, setups] = await Promise.all([
        db.application.findUnique({ where: { id: applicationId }, select: { protocolVersion: true } }),
        db.applicationSetup.findMany({
            where: { applicationId, organizationId: opts?.organizationId, status: { not: "failed" } },
            select: { status: true, protocolVersion: true },
        }),
    ]);
    const protocolVersion = normalizeProtocolVersion(app?.protocolVersion);
    const setupCompleted = setups.some(
        (setup) => normalizeProtocolVersion(setup.protocolVersion) === protocolVersion && setup.status === "completed",
    );
    return { protocolVersion, setupCompleted };
}
