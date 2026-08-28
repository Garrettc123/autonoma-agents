import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import { logger as rootLogger } from "@autonoma/logger";
import type { RunSubject } from "../../run-subject";
import type { DiffsAgentResult } from "./diffs-agent";

/**
 * The deterministic replacement for a selection run with nothing to select against: an empty subject (the range
 * brought nothing the branch owns) and no claimed event beyond the pushes the subject already accounts for.
 * Selecting on such a run is not a judgement call - the branch's standing content was already assessed by
 * earlier completed runs and inherited changes are the target pipeline's responsibility - so the agent is not
 * invoked at all: an LLM asked to do nothing does something a measurable fraction of the time, and each of
 * those runs costs real test executions.
 *
 * Returns `undefined` when the agent must run: a non-empty subject (owned content to analyze), no subject at
 * all (main-branch and unscoped runs), or any claimed non-push event. `commits_pushed` is the one event type
 * the subject computation fully answers; every other type - a directive today, whatever the inbox carries
 * tomorrow - is a standing reason the agent must see, so new types fail open to a real run by default.
 */
export function skipSelectionForEmptySubject(
    subject: RunSubject | undefined,
    events: ResolvedAnalysisEvent[],
): DiffsAgentResult | undefined {
    if (subject == null || subject.commits.length > 0) return undefined;
    if (events.some((event) => event.type !== "commits_pushed")) return undefined;

    const reasoning = emptySubjectReasoning(subject);
    rootLogger
        .child({ name: "skipSelectionForEmptySubject" })
        .info("Skipping selection deterministically: empty subject, push events only", {
            extra: { ...subject.ledger },
        });
    return { affectedTests: [], createdTests: [], reasoning };
}

function emptySubjectReasoning(subject: RunSubject): string {
    const { inheritedCount, replayedCount, cleanMergeCount } = subject.ledger;
    const parts: string[] = [];
    if (inheritedCount > 0) parts.push(`${inheritedCount} inherited from the target branch`);
    if (replayedCount > 0) parts.push(`${replayedCount} replayed already-analyzed content (a rebase or force-push)`);
    if (cleanMergeCount > 0) parts.push(`${cleanMergeCount} clean merge commit(s) with nothing hand-authored`);
    const accounting = parts.length > 0 ? ` Of the commits in the range: ${parts.join(", ")}.` : "";
    return (
        "Selection skipped deterministically: this push brought nothing the branch owns." +
        accounting +
        " The branch's standing content was already assessed by earlier completed runs, and the run claimed no" +
        " events beyond the pushes this accounting covers, so there is nothing new to select against."
    );
}
