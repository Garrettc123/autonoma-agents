import { db, type PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { ApplicationMemory } from "@autonoma/types";

/**
 * The ONE reader over `ApplicationMemory`: an application's ENABLED memories, in slug order. Both the
 * prompt's `## App memories` index and the `read_memory` tool are served from this single list, so a
 * disabled row is invisible to the whole pipeline by construction (the `enabled` switch lives only here,
 * never in the index renderer or the tool). With none enabled the list is empty and every consumer behaves
 * exactly as it does for an application that has no memories at all.
 *
 * Reused by every diffs-worker context load that feeds an agent memories (classifier, and later the
 * Reporter and DiffsAgent). `client` defaults to the shared connection; an injected one lets a test seed
 * and read through the same transaction.
 */
export async function loadEnabledApplicationMemories(
    applicationId: string,
    client: PrismaClient = db,
): Promise<ApplicationMemory[]> {
    const logger = rootLogger.child({ name: "loadEnabledApplicationMemories" });
    const memories = await client.applicationMemory.findMany({
        where: { applicationId, enabled: true },
        select: { slug: true, title: true, description: true, content: true },
        orderBy: { slug: "asc" },
    });
    logger.info("Loaded enabled application memories", { extra: { applicationId, count: memories.length } });
    return memories;
}
