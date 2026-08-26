import { FixableToolError } from "@autonoma/ai";
import type { AddressedMessage } from "@autonoma/types";

/**
 * Validate a finish's `addressedMessages` against the messages the run claimed: every claimed message answered,
 * none invented, none answered twice. Throws a {@link FixableToolError} the model can self-correct, then returns
 * the normalized entries to persist.
 */
export function resolveAddressedMessages(
    claimedMessageIds: ReadonlySet<string>,
    addressed: readonly AddressedMessage[],
): AddressedMessage[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    const unknown: string[] = [];
    for (const entry of addressed) {
        if (!claimedMessageIds.has(entry.eventId)) unknown.push(entry.eventId);
        else if (seen.has(entry.eventId)) duplicated.add(entry.eventId);
        else seen.add(entry.eventId);
    }
    const missing = [...claimedMessageIds].filter((id) => !seen.has(id));

    const problems: string[] = [];
    if (missing.length > 0) {
        problems.push(
            `These claimed messages have no addressedMessages entry: ${missing.join(", ")}. Add one entry per ` +
                `message id, answering the person who sent it - what you did about their instruction, or why you ` +
                `could not (an ask to edit the suite is out of scope: say so plainly).`,
        );
    }
    if (unknown.length > 0) {
        problems.push(
            `These addressedMessages eventIds are not messages this run claimed: ${unknown.join(", ")}. Use only ` +
                `the message ids listed in the prompt.`,
        );
    }
    if (duplicated.size > 0) {
        problems.push(`These message ids were addressed more than once: ${[...duplicated].join(", ")}.`);
    }
    if (problems.length > 0) throw new FixableToolError(`Cannot finish yet. ${problems.join(" ")}`);

    return addressed.map((entry) => ({ eventId: entry.eventId, response: entry.response }));
}
