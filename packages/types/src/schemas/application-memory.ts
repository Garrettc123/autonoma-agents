import { z } from "zod";

/**
 * The name of the tool every pipeline agent calls to read one memory in full. Named here, next
 * to the index that tells agents to call it, so the instruction and the tool cannot drift apart.
 */
export const READ_MEMORY_TOOL_NAME = "read_memory";

/**
 * One piece of owner-authored knowledge about an application. `slug` is the handle agents address
 * it by - the `toSlug` form of a short name, such as `checkout-toast-is-transient`, which agents
 * handle far better than a cuid. `description` says WHEN an agent should read the memory: it is
 * all an agent sees in the index before deciding to read `content`, so it carries the whole
 * weight of progressive disclosure. Whether a memory is visible to the pipeline is a switch on the
 * stored row, not part of the memory itself.
 */
export const ApplicationMemorySchema = z.object({
    slug: z.string().min(1),
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    content: z.string().trim().min(1),
});

export type ApplicationMemory = z.infer<typeof ApplicationMemorySchema>;
