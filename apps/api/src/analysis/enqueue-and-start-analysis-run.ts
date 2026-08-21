import type { AnalysisEventStore } from "@autonoma/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalysisEventSource } from "@autonoma/types";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";

export interface AnalysisRunLaunch {
    branchId: string;
    organizationId: string;
    source: AnalysisEventSource;
    headSha: string;
    baseSha?: string;
}

interface AnalysisRunStarter<T> {
    events: AnalysisEventStore;
    startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<T>;
}

/** Writes the event before starting the run, so a started run always has a matching pending event. */
export async function enqueueAndStartAnalysisRun<T>(
    { events, startAnalysisRun }: AnalysisRunStarter<T>,
    launch: AnalysisRunLaunch,
): Promise<T> {
    const logger = rootLogger.child({ name: "enqueueAndStartAnalysisRun" });
    logger.info("Enqueuing analysis event before starting run", {
        branch: { branchId: launch.branchId },
        extra: { source: launch.source, headSha: launch.headSha },
    });
    await events.enqueue({
        branchId: launch.branchId,
        organizationId: launch.organizationId,
        source: launch.source,
        event: { type: "commits_pushed", payload: { headSha: launch.headSha, baseSha: launch.baseSha } },
    });
    return startAnalysisRun({ branchId: launch.branchId, headSha: launch.headSha, baseSha: launch.baseSha });
}
