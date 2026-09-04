import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BadRequestError } from "@autonoma/errors";
import { logger as rootLogger } from "@autonoma/logger";
import type { ApplicationMemory } from "@autonoma/types";
import { parseApplicationMemoryFile } from "./parse-application-memory-file";

const MEMORY_FILE_EXTENSION = ".md";

/**
 * Reads every `.md` file directly inside `dir` as one memory (see `parseApplicationMemoryFile`),
 * in name order. Uniqueness of slugs is the file system's: two files cannot share a name.
 */
export async function readApplicationMemoriesDirectory(dir: string): Promise<ApplicationMemory[]> {
    const logger = rootLogger.child({ name: "readApplicationMemoriesDirectory" });
    logger.info("Reading memories directory", { extra: { dir } });

    const entries = await readdir(dir, { withFileTypes: true });
    const fileNames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(MEMORY_FILE_EXTENSION))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    if (fileNames.length === 0) {
        throw new BadRequestError(`No memories found in ${dir}: each memory is one ${MEMORY_FILE_EXTENSION} file.`);
    }

    const memories = await Promise.all(
        fileNames.map(async (fileName) =>
            parseApplicationMemoryFile(fileName, await readFile(join(dir, fileName), "utf8")),
        ),
    );

    logger.info("Read memories directory", { extra: { dir, memories: memories.length } });
    return memories;
}
