import { z } from "zod";

/** An inline image parked in blob storage. `key` is content-addressed (hash of the bytes) for dedup. */
const imageRefPartSchema = z.object({
    type: z.literal("image-ref"),
    key: z.string().min(1),
    mediaType: z.string().min(1),
});

/**
 * A stored content part: an image ref, or any other SDK part kept verbatim. `.passthrough()` preserves
 * every field (including a tool-result's nested `output`, where refs also live). Image-ref is tried
 * first so a well-formed ref is validated strictly.
 */
const storedContentPartSchema = z.union([imageRefPartSchema, z.object({ type: z.string() }).passthrough()]);

const storedMessageSchema = z.object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(storedContentPartSchema)]),
    providerOptions: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The persisted shape: `ModelMessage`s with each inline image swapped for an `image-ref`; everything
 * else stays JSON-inline. Both `toStored` and `fromStored` parse through this, so drift throws a
 * `ZodError` instead of reaching the model.
 */
export const storedMessagesSchema = z.array(storedMessageSchema);

export type StoredMessages = z.infer<typeof storedMessagesSchema>;
