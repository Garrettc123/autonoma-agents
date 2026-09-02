import { AnalysisEventResolver, AnalysisEventStore } from "@autonoma/analysis";
import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { type Suite, TestSuiteStore } from "@autonoma/test-suite";
import { type ImpactAnalysisInputs, loadImpactInputs } from "./load-impact-inputs";
import { EMPTY_MERGE_FLOW_RESULT } from "./merge-flow";

export interface AssembledDiffsAgentInput {
    /** Everything the {@link DiffsAgent} needs except the codebase clone. */
    agentInput: ImpactAnalysisInputs;
}

export interface AssembleDiffsAgentInputParams {
    snapshotId: string;
}

/**
 * Assemble {@link ImpactAnalysisInputs} for the eval-capture utility, via the same {@link loadImpactInputs} the
 * production stage uses but against the baseline suite and recipes, with no merge flow (an empty merge).
 */
export async function assembleDiffsAgentInput({
    snapshotId,
}: AssembleDiffsAgentInputParams): Promise<AssembledDiffsAgentInput> {
    logger.info("Assembling diffs agent input", { extra: { snapshotId } });

    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { prevSnapshotId: true },
    });

    const suite = await loadBaselineSuiteInfo(snapshotId, snapshot.prevSnapshotId);
    const events = await new AnalysisEventResolver(new AnalysisEventStore(db)).resolveForSnapshot(snapshotId);

    const agentInput = await loadImpactInputs({
        snapshotId,
        suite,
        merge: EMPTY_MERGE_FLOW_RESULT,
        events,
        recipeSnapshotId: resolveBaselineSnapshotId(snapshotId, snapshot.prevSnapshotId),
    });
    logger.info("Assembled diffs agent input", { extra: { existingTests: agentInput.existingTests.length } });

    return { agentInput };
}

/**
 * Resolve the test suite that analysis grades against: the snapshot's
 * `prevSnapshotId` suite, which is the baseline as it stood before this
 * snapshot's pipeline rewrote it. Falls back to the snapshot's own suite when
 * there is no previous snapshot (a genesis snapshot has no baseline to recover).
 */
async function loadBaselineSuiteInfo(snapshotId: string, prevSnapshotId: string | null): Promise<Suite> {
    if (prevSnapshotId == null) {
        logger.warn("Snapshot has no previous snapshot; falling back to its own suite as the baseline", {
            extra: { snapshotId },
        });
        return new TestSuiteStore(db).read(snapshotId);
    }

    logger.info("Using previous snapshot's suite as the analysis baseline", {
        extra: { snapshotId, prevSnapshotId },
    });
    return new TestSuiteStore(db).read(prevSnapshotId);
}

/**
 * The snapshot whose point-in-time recipe versions analysis should read - the
 * same one its test suite came from, so it mirrors {@link loadBaselineSuiteInfo}.
 */
function resolveBaselineSnapshotId(snapshotId: string, prevSnapshotId: string | null): string {
    return prevSnapshotId ?? snapshotId;
}
