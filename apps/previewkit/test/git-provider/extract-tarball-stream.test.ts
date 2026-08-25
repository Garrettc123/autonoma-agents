import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { extractTarballStream } from "../../src/git-provider/extract-tarball-stream";
import { makeGitHubTarballBuffer } from "./github-tarball";

// Tracks temp dirs so every test cleans up after itself even on failure.
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("extractTarballStream", () => {
    it("extracts a gzipped tarball, stripping GitHub's top-level wrapper directory", async () => {
        const target = await makeTempDir("pk-tarball-out-");
        const gzipped = Readable.from(
            await makeGitHubTarballBuffer("acme-widgets-abc1234", {
                "package.json": '{"name":"widgets"}',
                "apps/web/index.ts": "export const x = 1;",
                "README.md": "# Widgets",
            }),
        );

        await extractTarballStream(gzipped, target);

        // Files land directly under target with the wrapper dir removed.
        expect(await readFile(path.join(target, "package.json"), "utf8")).toBe('{"name":"widgets"}');
        expect(await readFile(path.join(target, "apps/web/index.ts"), "utf8")).toBe("export const x = 1;");
        expect(await readFile(path.join(target, "README.md"), "utf8")).toBe("# Widgets");
    });

    it("does not leave the wrapper directory behind", async () => {
        const target = await makeTempDir("pk-tarball-out-");
        const gzipped = Readable.from(
            await makeGitHubTarballBuffer("acme-widgets-deadbee", {
                "src/main.ts": "console.log('hi');",
            }),
        );

        await extractTarballStream(gzipped, target);

        expect(await readFile(path.join(target, "src/main.ts"), "utf8")).toBe("console.log('hi');");
        // The `acme-widgets-deadbee/` prefix must not survive extraction.
        await expect(readFile(path.join(target, "acme-widgets-deadbee/src/main.ts"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("rejects when the stream is not valid gzip (corrupt download)", async () => {
        const target = await makeTempDir("pk-tarball-out-");
        const notGzip = Readable.from(Buffer.from("this is plainly not a gzip stream"));

        await expect(extractTarballStream(notGzip, target)).rejects.toThrow();
    });
});
