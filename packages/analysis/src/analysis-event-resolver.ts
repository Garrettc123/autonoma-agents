import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { AnalysisEventBody, AnalysisEventSource } from "@autonoma/types";
import type { AnalysisEventRecord, AnalysisEventStore } from "./analysis-event-store";

/** A claimed event resolved for a consumer: the recorded fact, without the inbox row's bookkeeping. */
export type ResolvedAnalysisEvent = AnalysisEventBody & {
    /** Which producer path recorded the event. */
    source: AnalysisEventSource;
    createdAt: Date;
};

/**
 * Resolves the events a run claimed into the shape consumers reason about. Resolution only reads; acting on the
 * resolved context (fetching referenced shas into a checkout, rendering a prompt) belongs to the consumer.
 */
export class AnalysisEventResolver {
    private readonly logger: Logger;

    constructor(private readonly events: AnalysisEventStore) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /** The events a snapshot's run claimed, oldest first, resolved. Empty for an unknown snapshot. */
    public async resolveForSnapshot(snapshotId: string): Promise<ResolvedAnalysisEvent[]> {
        this.logger.info("Resolving claimed analysis events", { snapshot: { snapshotId } });
        const records = await this.events.listForSnapshot(snapshotId);
        const resolved = records.map((record) => resolveRecord(record));
        this.logger.info("Claimed analysis events resolved", {
            snapshot: { snapshotId },
            extra: { count: resolved.length },
        });
        return resolved;
    }
}

function resolveRecord(record: AnalysisEventRecord): ResolvedAnalysisEvent {
    switch (record.type) {
        case "commits_pushed":
            return { type: record.type, payload: record.payload, source: record.source, createdAt: record.createdAt };
    }
}
