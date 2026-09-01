import { db } from "@autonoma/db";
import type { ObservabilityContext } from "@autonoma/logger";

/**
 * Given a snapshot id, derive every canonical observability ID we can with one
 * Prisma query. Used by the Temporal activity interceptor (and any other code
 * that wants to bootstrap context from a snapshot id) so that every log line
 * downstream carries the same set of IDs.
 *
 * Returns groups for snapshot / branch / application / organization. If the
 * snapshot doesn't exist, returns just the snapshot group with the bare id so
 * downstream logs still carry the lookup key.
 */
export async function loadSnapshotObservabilityContext(snapshotId: string): Promise<ObservabilityContext> {
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: {
            id: true,
            headSha: true,
            baseSha: true,
            prevSnapshotId: true,
            branch: {
                select: {
                    id: true,
                    organizationId: true,
                    applicationId: true,
                    application: { select: { protocolVersion: true } },
                    prInfo: { select: { prNumber: true } },
                },
            },
        },
    });

    if (snapshot == null) return { snapshot: { snapshotId } };

    const snapshotGroup: ObservabilityContext["snapshot"] = { snapshotId: snapshot.id };
    if (snapshot.headSha != null) snapshotGroup.headSha = snapshot.headSha;
    if (snapshot.baseSha != null) snapshotGroup.baseSha = snapshot.baseSha;
    if (snapshot.prevSnapshotId != null) snapshotGroup.prevSnapshotId = snapshot.prevSnapshotId;
    if (snapshot.branch.prInfo != null) snapshotGroup.prNumber = snapshot.branch.prInfo.prNumber;

    const applicationGroup: ObservabilityContext["application"] = { applicationId: snapshot.branch.applicationId };
    if (snapshot.branch.application?.protocolVersion != null) {
        applicationGroup.protocolVersion = snapshot.branch.application.protocolVersion;
    }

    return {
        snapshot: snapshotGroup,
        branch: { branchId: snapshot.branch.id },
        application: applicationGroup,
        organization: { organizationId: snapshot.branch.organizationId },
    };
}
