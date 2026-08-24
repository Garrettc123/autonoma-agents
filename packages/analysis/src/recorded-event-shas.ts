import type { ResolvedAnalysisEvent } from "./analysis-event-resolver";

/**
 * The distinct shas a set of resolved events records (push heads), minus any the caller already has - what a
 * consumer feeds its checkout's best-effort fetch.
 */
export function recordedEventShas(
    events: ResolvedAnalysisEvent[],
    alreadyFetched: Iterable<string | null | undefined>,
): string[] {
    const known = new Set<string | null | undefined>(alreadyFetched);
    const shas = new Set<string>();
    for (const event of events) {
        if (event.type !== "commits_pushed") continue;
        if (!known.has(event.payload.headSha)) shas.add(event.payload.headSha);
    }
    return [...shas];
}
