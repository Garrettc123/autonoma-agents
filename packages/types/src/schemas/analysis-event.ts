import { z } from "zod";

/**
 * The kind of occurrence an analysis event records. One consumer drains every type in `createdAt` order
 * regardless of kind, so this is a single flat enum rather than a table per type. New kinds (a user prompt, a
 * previewkit-config change) are added here on demand, never speculatively.
 */
export const analysisEventTypeSchema = z.enum(["commits_pushed", "user_prompt"]);
export type AnalysisEventType = z.infer<typeof analysisEventTypeSchema>;

/** Which producer path an event came in through. */
export const analysisEventSourceSchema = z.enum([
    "webhook",
    "label",
    "comment",
    "ui",
    "vercel",
    "ci",
    "onboarding",
    "mcp",
    "admin",
    "http",
    // A forward from the PR-review chat, once the host confirms it (neutral across chat agents).
    "chat",
]);
export type AnalysisEventSource = z.infer<typeof analysisEventSourceSchema>;

/**
 * The payload a `commits_pushed` event carries. `headSha` is the head being analyzed; `baseSha` is the PR's
 * target-branch tip when the trigger read one (a drifting tip, not a fork point). `beforeSha` is the branch head
 * the push replaced - the one fact git cannot reconstruct after a force-push, so it is captured at enqueue when
 * the webhook carries it. `deliveryId` is the GitHub webhook delivery id, for forensics.
 */
export const commitsPushedPayloadSchema = z.object({
    headSha: z.string(),
    baseSha: z.string().optional(),
    beforeSha: z.string().optional(),
    deliveryId: z.string().optional(),
    // The head commit's full message and author login, captured at enqueue: a timeline that shows the message must
    // not depend on a later GitHub round-trip that a force-push can render unresolvable.
    message: z.string().optional(),
    author: z.string().optional(),
});
export type CommitsPushedPayload = z.infer<typeof commitsPushedPayloadSchema>;

/** A `user_prompt` event's payload: a one-shot natural-language instruction for the run that claims it, and who wrote it. */
export const userPromptPayloadSchema = z.object({
    text: z.string().min(1),
    author: z.string().min(1),
});
export type UserPromptPayload = z.infer<typeof userPromptPayloadSchema>;

/**
 * A whole analysis event - its `type` tag paired with the payload that tag implies. The store validates a raw
 * `{ type, payload }` pair against this at the read/write boundary, so a row's JSONB payload can never disagree
 * with its `type` column.
 */
export const analysisEventBodySchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("commits_pushed"), payload: commitsPushedPayloadSchema }),
    z.object({ type: z.literal("user_prompt"), payload: userPromptPayloadSchema }),
]);
export type AnalysisEventBody = z.infer<typeof analysisEventBodySchema>;

/** The union of every event's payload shape - the type of the `analysis_event.payload` JSONB column. */
export type AnalysisEventPayload = AnalysisEventBody["payload"];
