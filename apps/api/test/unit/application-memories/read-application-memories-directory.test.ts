import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readApplicationMemoriesDirectory } from "../../../src/application-memories/read-application-memories-directory";

function memoryFile(title: string): string {
    return `---\ntitle: ${title}\ndescription: Read when ${title.toLowerCase()} matters.\n---\n${title} content.\n`;
}

describe("readApplicationMemoriesDirectory", () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "memories-"));
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it("reads every .md file directly inside the directory, in name order, and nothing else", async () => {
        await writeFile(join(dir, "dashboard-skeletons.md"), memoryFile("Dashboard skeletons"));
        await writeFile(join(dir, "checkout-toast.md"), memoryFile("Checkout toast"));
        await writeFile(join(dir, "notes.txt"), "not a memory");
        await mkdir(join(dir, "archive"));
        await writeFile(join(dir, "archive", "old-memory.md"), memoryFile("Old memory"));

        const memories = await readApplicationMemoriesDirectory(dir);

        expect(memories.map((memory) => memory.slug)).toEqual(["checkout-toast", "dashboard-skeletons"]);
        expect(memories[0]?.title).toBe("Checkout toast");
    });

    it("rejects a directory with no memory files", async () => {
        await writeFile(join(dir, "notes.txt"), "not a memory");

        await expect(readApplicationMemoriesDirectory(dir)).rejects.toThrow(/No memories found/);
    });

    it("names the offending file when one of them is malformed", async () => {
        await writeFile(join(dir, "checkout-toast.md"), memoryFile("Checkout toast"));
        await writeFile(join(dir, "broken.md"), "no frontmatter here\n");

        await expect(readApplicationMemoriesDirectory(dir)).rejects.toThrow(/broken\.md/);
    });
});
