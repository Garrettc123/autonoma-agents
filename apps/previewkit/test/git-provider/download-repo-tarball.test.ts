import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as tick } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { downloadRepoTarball } from "../../src/git-provider/download-repo-tarball";
import { makeGitHubTarballBuffer } from "./github-tarball";

/** Small enough that the extraction lands files on disk before the stream dies. */
const CHUNK_BYTES = 65_536;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pk-download-out-"));
    tempDirs.push(dir);
    return dir;
}

/** undici's exact shape for a response body that dies mid-flight: message `terminated`, no HTTP status. */
function droppedConnection(): TypeError {
    return new TypeError("terminated", { cause: new Error("other side closed") });
}

/**
 * A body that delivers most of a real tarball and then drops. Fed in chunks so the extraction keeps up with it:
 * by the time it dies, a half-written file is already on disk - the state a retry has to clean up.
 */
function truncatedStream(gzipped: Buffer): Readable {
    const cut = gzipped.subarray(0, Math.floor(gzipped.length * 0.9));
    return Readable.from(
        (async function* () {
            for (let offset = 0; offset < cut.length; offset += CHUNK_BYTES) {
                yield cut.subarray(offset, offset + CHUNK_BYTES);
                await tick(0);
            }
            throw droppedConnection();
        })(),
    );
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("downloadRepoTarball", () => {
    const files = { "package.json": '{"name":"widgets"}', "src/main.ts": "export const x = 1;" };

    it("retries a download that drops mid-body, discarding what the dead attempt wrote", async () => {
        const target = await makeTempDir();
        const partial = await makeGitHubTarballBuffer("acme-widgets-abc1234", {
            "big.bin": randomBytes(400_000).toString("hex"),
        });
        const complete = await makeGitHubTarballBuffer("acme-widgets-abc1234", files);

        let attempts = 0;
        await downloadRepoTarball({
            repoFullName: "acme/widgets",
            ref: "abc1234",
            targetDir: target,
            sleep: async () => {},
            openStream: async () => {
                attempts += 1;
                return attempts < 3 ? truncatedStream(partial) : Readable.from(complete);
            },
        });

        expect(attempts).toBe(3);
        expect(await readFile(path.join(target, "package.json"), "utf8")).toBe('{"name":"widgets"}');
        expect(await readFile(path.join(target, "src/main.ts"), "utf8")).toBe("export const x = 1;");
        // The half-written file the dropped attempts left behind must not survive into the extracted tree.
        expect(await readdir(target)).not.toContain("big.bin");
    });

    it("gives up after the backoff schedule is exhausted", async () => {
        const target = await makeTempDir();
        let attempts = 0;

        await expect(
            downloadRepoTarball({
                repoFullName: "acme/widgets",
                ref: "abc1234",
                targetDir: target,
                sleep: async () => {},
                openStream: async () => {
                    attempts += 1;
                    throw droppedConnection();
                },
            }),
        ).rejects.toThrow("terminated");

        expect(attempts).toBe(5);
    });

    it("does not retry a request the repository itself refuses", async () => {
        const target = await makeTempDir();
        let attempts = 0;

        await expect(
            downloadRepoTarball({
                repoFullName: "acme/widgets",
                ref: "no-such-ref",
                targetDir: target,
                sleep: async () => {},
                openStream: async () => {
                    attempts += 1;
                    throw Object.assign(new Error("Not Found"), { status: 404 });
                },
            }),
        ).rejects.toThrow("Not Found");

        expect(attempts).toBe(1);
    });

    it("retries GitHub's own 5xx", async () => {
        const target = await makeTempDir();
        const complete = await makeGitHubTarballBuffer("acme-widgets-abc1234", files);
        let attempts = 0;

        await downloadRepoTarball({
            repoFullName: "acme/widgets",
            ref: "abc1234",
            targetDir: target,
            sleep: async () => {},
            openStream: async () => {
                attempts += 1;
                if (attempts === 1) throw Object.assign(new Error("Server Error"), { status: 502 });
                return Readable.from(complete);
            },
        });

        expect(attempts).toBe(2);
        expect(await readFile(path.join(target, "src/main.ts"), "utf8")).toBe("export const x = 1;");
    });
});
