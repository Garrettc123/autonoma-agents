import { z } from "zod";

/**
 * The kind of occurrence an analysis event records. One consumer drains every type in `createdAt` order
 * regardless of kind, so this is a single flat enum rather than a table per type. New kinds (a user prompt, a
 * previewkit-config change) are added here on demand, never speculatively.
 */
export const analysisEventTypeSchema = z.enum(["commits_pushed"]);
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
]);
export type AnalysisEventSource = z.infer<typeof analysisEventSourceSchema>;

/** The payload a `commits_pushed` event carries: the head being analyzed, its base, and the webhook delivery id for forensics. */
export const commitsPushedPayloadSchema = z.object({
    headSha: z.string(),
    baseSha: z.string().optional(),
    deliveryId: z.string().optional(),
});
export type CommitsPushedPayload = z.infer<typeof commitsPushedPayloadSchema>;

/**
 * A whole analysis event - its `type` tag paired with the payload that tag implies. The store validates a raw
 * `{ type, payload }` pair against this at the read/write boundary, so a row's JSONB payload can never disagree
 * with its `type` column.
 */
export const analysisEventBodySchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("commits_pushed"), payload: commitsPushedPayloadSchema }),
]);
export type AnalysisEventBody = z.infer<typeof analysisEventBodySchema>;

/** The union of every event's payload shape - the type of the `analysis_event.payload` JSONB column. */
export type AnalysisEventPayload = AnalysisEventBody["payload"];
