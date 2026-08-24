import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { type ResolveSourceInput, type ResolvedSnapshotSource, TestSuiteStore } from "@autonoma/test-suite";
import { AnalysisEventStore } from "./analysis-event-store";

export interface AnalysisRunGateResult {
    resolved: ResolvedSnapshotSource;
    /** True when the trigger/run should no-op: the head is already analyzed AND the branch's inbox is empty. */
    skip: boolean;
}

/**
 * The one deriving site for the already-analyzed skip, shared by the API triggers and the run's own open step so
 * they can never disagree. Head equality alone is not enough: a pending event is a standing reason to run that
 * the head sha cannot satisfy, so it un-suppresses the skip - only a same-head trigger on an empty inbox is a
 * true duplicate.
 */
export class AnalysisRunGate {
    private readonly logger: Logger;
    private readonly suite: TestSuiteStore;
    private readonly events: AnalysisEventStore;

    constructor(db: PrismaClient) {
        this.suite = new TestSuiteStore(db);
        this.events = new AnalysisEventStore(db);
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    public async shouldSkipAlreadyAnalyzed(input: ResolveSourceInput): Promise<AnalysisRunGateResult> {
        const resolved = await this.suite.resolveSource(input);
        if (!resolved.alreadyAnalyzed) return { resolved, skip: false };

        const hasPending = await this.events.hasPending(input.branchId);
        this.logger.info("Head already analyzed; consulted the inbox for a standing reason to run", {
            branch: { branchId: input.branchId },
            extra: { headSha: input.headSha, hasPending },
        });
        return { resolved, skip: !hasPending };
    }
}
