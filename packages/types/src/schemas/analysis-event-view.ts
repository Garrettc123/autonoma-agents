import { z } from "zod";
import { analysisEventSourceSchema } from "./analysis-event";

/** A checkpoint's handled `commits_pushed` / `user_prompt` event, flattened to the fields the timeline renders. */
export const analysisEventViewSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("commits_pushed"),
        id: z.string(),
        source: analysisEventSourceSchema,
        createdAt: z.date(),
        headSha: z.string(),
        message: z.string().optional(),
        author: z.string().optional(),
    }),
    z.object({
        type: z.literal("user_prompt"),
        id: z.string(),
        source: analysisEventSourceSchema,
        createdAt: z.date(),
        text: z.string(),
        author: z.string(),
    }),
]);
export type AnalysisEventView = z.infer<typeof analysisEventViewSchema>;
