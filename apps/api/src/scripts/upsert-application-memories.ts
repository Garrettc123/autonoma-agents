/**
 * Writes the memories in a local directory into one application, creating the ones it does not
 * have and rewriting the ones it does. Re-runnable: the directory is the source of truth for every
 * memory it names, and memories it does not name are left alone.
 *
 *   pnpm --filter @autonoma/api memories:upsert -- --application-id <id> --dir ./memories
 *
 * One memory per `.md` file: YAML frontmatter with `title` and `description`, the body as content,
 * the file name as slug. The format is documented in apps/api/README.md ("Application memories").
 * `DATABASE_URL` decides which environment is written.
 */
import { parseArgs } from "node:util";
import { db } from "@autonoma/db";
import { APIError } from "@autonoma/errors";
import { ApplicationMemoriesUpserter } from "../application-memories/application-memories-upserter";
import { readApplicationMemoriesDirectory } from "../application-memories/read-application-memories-directory";

const { values } = parseArgs({
    options: {
        "application-id": { type: "string" },
        dir: { type: "string" },
    },
});
const applicationId = values["application-id"];
const dir = values.dir;
if (applicationId == null || dir == null) {
    console.error("Usage: --application-id <id> --dir <directory of memory .md files>");
    process.exit(1);
}

try {
    const memories = await readApplicationMemoriesDirectory(dir);
    const result = await new ApplicationMemoriesUpserter(db).upsert(applicationId, memories);

    console.log(`Application ${applicationId}: ${memories.length} memories in ${dir}`);
    for (const slug of result.created) console.log(`  created  ${slug}`);
    for (const slug of result.updated) console.log(`  updated  ${slug}`);
} catch (error) {
    // A malformed file or a wrong application id is the operator's to fix; the message says
    // which. Anything else is a real failure and keeps its stack.
    if (!(error instanceof APIError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await db.$disconnect();
}
