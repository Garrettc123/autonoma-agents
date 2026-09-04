import { basename, extname } from "node:path";
import matter from "@11ty/gray-matter";
import { BadRequestError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import { type ApplicationMemory, ApplicationMemorySchema } from "@autonoma/types";
import { toSlug } from "@autonoma/utils";
import type { z } from "zod";

/** The frontmatter is the memory minus what the file itself supplies: its slug (the name) and content (the body). */
const FrontmatterSchema = ApplicationMemorySchema.pick({ title: true, description: true }).strict();

/**
 * Parses one memory file: YAML frontmatter carrying `title` and `description`, a body that is the
 * memory's content, and a file name that is its slug. The name is the identity the row is upserted
 * by, so it must already be in `toSlug` form - nothing is derived, and a title edit is just a
 * frontmatter edit.
 */
export function parseApplicationMemoryFile(fileName: string, text: string): ApplicationMemory {
    const logger = rootLogger.child({ name: "parseApplicationMemoryFile" });
    logger.info("Parsing memory file", { extra: { fileName } });

    const slug = basename(fileName, extname(fileName));
    if (slug !== toSlug(slug)) {
        throw new BadRequestError(
            `${fileName}: the file name is the memory's slug and must be slug-shaped; rename it to ${toSlug(slug)}.md.`,
        );
    }

    if (!matter.test(text)) {
        throw new BadRequestError(`${fileName}: must start with YAML frontmatter carrying title and description.`);
    }
    const { data, content } = matter(text);
    const frontmatter = parseOrExplain(fileName, FrontmatterSchema, data);
    const memory = parseOrExplain(fileName, ApplicationMemorySchema, {
        slug,
        title: frontmatter.title,
        description: frontmatter.description,
        content,
    });

    logger.info("Parsed memory file", { extra: { fileName, slug } });
    return memory;
}

function parseOrExplain<T extends z.ZodTypeAny>(fileName: string, schema: T, value: unknown): z.infer<T> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;

    const issues = parsed.error.issues
        .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
    throw new BadRequestError(`${fileName}: ${issues}`);
}
