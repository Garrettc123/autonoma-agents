import { requireApiKey, type UserAuthVariables } from "@autonoma/auth";
import { db } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { env } from "../env";
import { userPromptHttpResponse } from "./analysis-http-response";
import { deliverUserPromptService } from "./user-prompt-service";

const messageBodySchema = z.object({
    repo_id: z.number(),
    pr_number: z.number().int().positive(),
    message: z.string().min(1),
    author: z.string().min(1).optional(),
});

// Called by agents/plugins with an API key. CORS is open to any origin; the API key is the trust anchor.
export const analysisHttpRouter = new Hono<{ Variables: UserAuthVariables }>()
    .use("*", cors({ origin: "*" }))
    .use("*", requireApiKey({ db, appUrl: env.APP_URL }))
    .post("/messages", async (ctx) => {
        const logger = rootLogger.child({ name: "analysisHttpRouter.messages" });
        const { organizationId } = ctx.var.user;

        const parsed = messageBodySchema.safeParse(await ctx.req.json());
        if (!parsed.success) {
            return ctx.json({ error: "Invalid request body", details: z.treeifyError(parsed.error) }, 400);
        }
        const body = parsed.data;
        logger.info("Received analysis message", {
            organizationId,
            extra: { repoId: body.repo_id, prNumber: body.pr_number },
        });

        try {
            const receipt = await deliverUserPromptService.deliverUserPrompt({
                organizationId,
                repoId: body.repo_id,
                prNumber: body.pr_number,
                text: body.message,
                author: body.author ?? "http",
                source: "http",
            });
            const { status, body: responseBody } = userPromptHttpResponse(receipt);
            return ctx.json(responseBody, status as ContentfulStatusCode);
        } catch (error) {
            if (error instanceof NotFoundError) return ctx.json({ error: error.message }, 404);
            logger.fatal("Failed to deliver analysis message", error, {
                repoId: body.repo_id,
                prNumber: body.pr_number,
            });
            return ctx.json({ error: "Failed to deliver analysis message" }, 500);
        }
    });
