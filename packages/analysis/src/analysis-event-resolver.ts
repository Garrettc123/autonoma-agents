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
 * A claimed `user_prompt` resolved for the Reporter to address. Carries the event `id` (the other resolutions drop
 * it) because the report's `addressedMessages` must reference each message one-for-one.
 */
export interface ResolvedUserPrompt {
    eventId: string;
    text: string;
    author: string;
    createdAt: Date;
}

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

    /**
     * The `user_prompt` messages a snapshot's run claimed, oldest first, each with its event id - what the Reporter
     * must address one-for-one. Empty on a commits-only run.
     */
    public async resolveClaimedUserPrompts(snapshotId: string): Promise<ResolvedUserPrompt[]> {
        this.logger.info("Resolving claimed user prompts", { snapshot: { snapshotId } });
        const records = await this.events.listForSnapshot(snapshotId);
        const prompts = records.flatMap((record) =>
            record.type === "user_prompt"
                ? [
                      {
                          eventId: record.id,
                          text: record.payload.text,
                          author: record.payload.author,
                          createdAt: record.createdAt,
                      },
                  ]
                : [],
        );
        this.logger.info("Claimed user prompts resolved", {
            snapshot: { snapshotId },
            extra: { count: prompts.length },
        });
        return prompts;
    }
}

function resolveRecord(record: AnalysisEventRecord): ResolvedAnalysisEvent {
    switch (record.type) {
        case "commits_pushed":
            return { type: record.type, payload: record.payload, source: record.source, createdAt: record.createdAt };
        case "user_prompt":
            return { type: record.type, payload: record.payload, source: record.source, createdAt: record.createdAt };
    }
}
