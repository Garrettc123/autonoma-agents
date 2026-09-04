import type { AnalysisEventStore } from "@autonoma/analysis";
import type { Commit } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalysisEventSource } from "@autonoma/types";
import type { AnalysisRunWorkflowInput } from "@autonoma/workflow";

export interface AnalysisRunLaunch {
    branchId: string;
    organizationId: string;
    source: AnalysisEventSource;
    headSha: string;
    baseSha?: string;
    /** The branch head this push replaced, when the webhook reported one. */
    beforeSha?: string;
    /** The GitHub webhook delivery id, when the launch came from a webhook. */
    deliveryId?: string;
    /** The head commit's subject line, resolved at enqueue so the timeline reads it without a later fetch. */
    message?: string;
    /** The head commit's author login, resolved alongside the message. */
    author?: string;
}

/** The commit-read the trigger paths hold, narrowed to the one method {@link resolveHeadCommitMeta} needs. */
export interface HeadCommitReader {
    getCommitByRepo(organizationId: string, repoId: number, sha: string): Promise<Commit>;
}

/**
 * The head commit's subject and author for a push event, best-effort: a GitHub read here captures them once at
 * enqueue, so the timeline never re-fetches per checkpoint and a later force-push cannot orphan the sha. A failed
 * read is not fatal - the event still enqueues, just without the message.
 */
export async function resolveHeadCommitMeta(
    reader: HeadCommitReader,
    organizationId: string,
    repoId: number,
    sha: string,
): Promise<{ message?: string; author?: string }> {
    const logger = rootLogger.child({ name: "resolveHeadCommitMeta" });
    try {
        const commit = await reader.getCommitByRepo(organizationId, repoId, sha);
        // The full message, body and all - the timeline truncates for display, and a detail view can show the rest.
        return { message: commit.message.trim() || undefined, author: commit.authorLogin };
    } catch (err) {
        logger.warn("Failed to resolve head commit meta; enqueuing the event without it", {
            organization: { organizationId },
            extra: { repoId, sha, err },
        });
        return {};
    }
}

interface AnalysisRunStarter<T> {
    events: AnalysisEventStore;
    startAnalysisRun: (input: AnalysisRunWorkflowInput) => Promise<T>;
}

/**
 * Persist the event without waking the workflow - the deferred path for a real push the org cannot act on right now
 * (out of credits, or activation-gated). It stays pending until the branch's next push or an explicit request
 * opens a run that claims it - nothing re-pokes it on its own.
 */
export async function enqueueAnalysisEvent(events: AnalysisEventStore, launch: AnalysisRunLaunch): Promise<void> {
    const logger = rootLogger.child({ name: "enqueueAnalysisEvent" });
    logger.info("Enqueuing analysis event without poking", {
        branch: { branchId: launch.branchId },
        extra: { source: launch.source, headSha: launch.headSha },
    });
    // A base equal to the head carries no range information - main-branch launches pass their own head as a
    // deliberate already-analyzed fallback for the run - so the event records nothing rather than a
    // self-referential base.
    const baseSha = launch.baseSha === launch.headSha ? undefined : launch.baseSha;
    await events.enqueue({
        branchId: launch.branchId,
        organizationId: launch.organizationId,
        source: launch.source,
        event: {
            type: "commits_pushed",
            payload: {
                headSha: launch.headSha,
                baseSha,
                beforeSha: launch.beforeSha,
                deliveryId: launch.deliveryId,
                message: launch.message,
                author: launch.author,
            },
        },
    });
}

/** Writes the event before starting the run, so a started run always has a matching pending event. */
export async function enqueueAndStartAnalysisRun<T>(
    { events, startAnalysisRun }: AnalysisRunStarter<T>,
    launch: AnalysisRunLaunch,
): Promise<T> {
    await enqueueAnalysisEvent(events, launch);
    return startAnalysisRun({ branchId: launch.branchId, headSha: launch.headSha, baseSha: launch.baseSha });
}
