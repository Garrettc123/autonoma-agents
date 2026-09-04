import { type ApplicationMemory, READ_MEMORY_TOOL_NAME } from "./schemas/application-memory";

const SECTION_HEADING = "## App memories";

const FRAMING =
    "The application owner wrote these memories to describe how the application is EXPECTED to behave. " +
    "A memory explains what you observe; it never replaces observing it, so an observation that " +
    "contradicts a memory is still an observation.";

const READ_INSTRUCTION =
    "Each line is `slug - title: description`; when a description matches what you are doing right now, " +
    `call \`${READ_MEMORY_TOOL_NAME}\` with that slug to read the memory in full before you act on it.`;

export type ApplicationMemoryIndexEntry = Pick<ApplicationMemory, "slug" | "title" | "description">;

/**
 * Renders the memory index every agent prompt carries: one line per memory, in slug order, framed
 * by the one wording all consumers share. Returns `undefined` for no memories, so a caller drops
 * the whole section and the pipeline behaves exactly as it does for an application without any.
 * Pass only the memories the pipeline may see; which rows those are is the reader's decision.
 */
export function renderApplicationMemoryIndex(memories: readonly ApplicationMemoryIndexEntry[]): string | undefined {
    if (memories.length === 0) return undefined;

    const lines = [...memories]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((memory) => `- ${memory.slug} - ${memory.title}: ${memory.description}`);

    return [SECTION_HEADING, "", FRAMING, "", ...lines, "", READ_INSTRUCTION].join("\n");
}
