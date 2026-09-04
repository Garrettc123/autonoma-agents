import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger } from "@autonoma/logger";
import type { ApplicationMemory } from "@autonoma/types";

export interface ApplicationMemoriesUpsertResult {
    /** Slugs that did not exist for the application before this run. */
    created: string[];
    /** Slugs that already existed and had their title, description and content rewritten. */
    updated: string[];
}

/**
 * Writes hand-authored memories into an application, keyed by `(applicationId, slug)`: a slug the
 * application does not have yet is created, one it has is rewritten in place. `enabled` is never
 * written - rows are created with the column's default, and a row switched off in SQL survives a
 * re-run of the files.
 */
export class ApplicationMemoriesUpserter {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async upsert(
        applicationId: string,
        memories: readonly ApplicationMemory[],
    ): Promise<ApplicationMemoriesUpsertResult> {
        this.logger.info("Upserting application memories", { applicationId, extra: { count: memories.length } });

        const result = await this.db.$transaction(async (tx) => {
            const application = await tx.application.findUnique({
                where: { id: applicationId },
                select: { organizationId: true },
            });
            if (application == null) throw new NotFoundError(`Application ${applicationId} not found`);

            const existing = await tx.applicationMemory.findMany({
                where: { applicationId, slug: { in: memories.map((memory) => memory.slug) } },
                select: { slug: true },
            });
            const existingSlugs = new Set(existing.map((row) => row.slug));

            // Sequential on purpose: an interactive transaction runs on one connection, so
            // concurrent upserts would only be queued behind each other anyway.
            for (const memory of memories) {
                await tx.applicationMemory.upsert({
                    where: { applicationId_slug: { applicationId, slug: memory.slug } },
                    create: {
                        applicationId,
                        organizationId: application.organizationId,
                        slug: memory.slug,
                        title: memory.title,
                        description: memory.description,
                        content: memory.content,
                    },
                    update: {
                        title: memory.title,
                        description: memory.description,
                        content: memory.content,
                    },
                    select: { id: true },
                });
            }

            const slugs = memories.map((memory) => memory.slug);
            return {
                created: slugs.filter((slug) => !existingSlugs.has(slug)),
                updated: slugs.filter((slug) => existingSlugs.has(slug)),
            };
        });

        this.logger.info("Application memories upserted", {
            applicationId,
            extra: { created: result.created.length, updated: result.updated.length },
        });
        return result;
    }
}
