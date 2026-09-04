import { AgentTool, FixableToolError } from "@autonoma/ai";
import { type ApplicationMemory, READ_MEMORY_TOOL_NAME } from "@autonoma/types";
import { z } from "zod";

const readMemoryInputSchema = z.object({
    slug: z.string().describe("The slug of the memory to read, exactly as it appears in the `## App memories` index."),
});

type ReadMemoryInput = z.infer<typeof readMemoryInputSchema>;

type ReadMemoryOutput = { title: string; content: string };

/**
 * Raised when no memory has the requested slug - the tool declining to answer, so it goes through
 * `AgentTool`'s error channel rather than a hand-rolled in-band payload. The fix points back at the index
 * in the prompt, the only place the valid slugs are listed (there is no `list_memories` tool).
 */
class UnknownMemoryError extends FixableToolError {
    constructor(public readonly slug: string) {
        super(`Memory "${slug}" not found.`);
    }

    override suggestFix(): string {
        return "Use a slug exactly as it appears in the `## App memories` index in your prompt; there is no other list of memories to read from.";
    }
}

/**
 * Read one application memory in full by slug - the drill-down the `## App memories` index points at.
 *
 * Holds the memory list it serves and the calling agent's name, both taken in its constructor: the same
 * memory list the prompt's index was rendered from, so the two cannot disagree, and the same
 * capability-in-the-constructor shape every run-scoped classifier tool uses (see `AnalyzeVideoTool`). One
 * tool class still serves every agent - each just constructs it with its own memories and name.
 *
 * An unknown slug throws a fixable error, exactly as `read_scenario` handles an unknown scenario id - the
 * tool cannot answer, so it declines through the error channel rather than nesting an `{ error }` inside
 * `AgentTool`'s own success envelope.
 */
export class ReadMemoryTool extends AgentTool<ReadMemoryInput, ReadMemoryOutput> {
    constructor(
        private readonly memories: readonly ApplicationMemory[],
        private readonly agentName: string,
    ) {
        super({
            name: READ_MEMORY_TOOL_NAME,
            description:
                "Read one application memory in full by its slug, as listed in the `## App memories` index. " +
                "Returns the memory's title and content; errors when no memory has that slug.",
            inputSchema: readMemoryInputSchema,
        });
    }

    protected async execute({ slug }: ReadMemoryInput): Promise<ReadMemoryOutput> {
        this.logger.info("Reading an application memory", { extra: { agent: this.agentName, slug } });
        const memory = this.memories.find((m) => m.slug === slug);
        if (memory == null) throw new UnknownMemoryError(slug);
        return { title: memory.title, content: memory.content };
    }
}

/**
 * The `read_memory` tool an agent registers, gated on data presence exactly as the classifier gates its
 * other tools: an application with no enabled memories produces no tool, so its prompt and tool set are
 * byte-identical to one for an application that has no memories at all. The gated list IS the tool's list.
 */
export function buildReadMemoryTools(memories: readonly ApplicationMemory[], agentName: string): ReadMemoryTool[] {
    return memories.length > 0 ? [new ReadMemoryTool(memories, agentName)] : [];
}
