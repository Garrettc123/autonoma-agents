import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@autonoma/logger";
import { afterEach, describe, expect, it } from "vitest";
import { cloneWithRetry } from "./clone-with-retry";
import { toGitCommandError } from "./git-clone-step";

const testLogger = logger.child({ name: "clone-with-retry.test" });
const noSleep = async (): Promise<void> => {};

const TOKEN = "ghs_secrettoken";

/** The `execFile` rejection Node produces when OUR timeout kills git: it sent the signal, so `killed` is true. */
function timedOut(): Error {
    return toGitCommandError(
        { killed: true, signal: "SIGTERM", code: null, stderr: "" },
        { step: "clone", subcommand: "clone", elapsedMs: 120_020, timeoutMs: 120_000, token: TOKEN },
    );
}

function refused(stderr: string): Error {
    return toGitCommandError(
        { killed: false, signal: null, code: 128, stderr },
        { step: "clone", subcommand: "clone", elapsedMs: 900, timeoutMs: 120_000, token: TOKEN },
    );
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "clone-retry-"));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cloneWithRetry", () => {
    it("retries a clone killed by its own budget, and gives each attempt more time", async () => {
        const targetDir = await makeTempDir();
        const budgets: number[] = [];

        await cloneWithRetry({
            targetDir,
            logger: testLogger,
            sleep: noSleep,
            attempt: async (timeoutMs) => {
                budgets.push(timeoutMs);
                if (budgets.length < 3) throw timedOut();
            },
        });

        expect(budgets).toEqual([120_000, 180_000, 240_000]);
    });

    it("empties the target dir between attempts, so a retry never clones onto a dead attempt's tree", async () => {
        const targetDir = await makeTempDir();
        const seenBefore: string[][] = [];

        await cloneWithRetry({
            targetDir,
            logger: testLogger,
            sleep: noSleep,
            attempt: async () => {
                seenBefore.push(await readdir(targetDir));
                if (seenBefore.length === 1) {
                    await writeFile(path.join(targetDir, "partial.pack"), "half a packfile");
                    throw timedOut();
                }
            },
        });

        expect(seenBefore).toEqual([[], []]);
    });

    it("throws the last failure once every attempt is spent", async () => {
        const targetDir = await makeTempDir();
        let attempts = 0;

        await expect(
            cloneWithRetry({
                targetDir,
                logger: testLogger,
                sleep: noSleep,
                attempt: async () => {
                    attempts += 1;
                    throw timedOut();
                },
            }),
        ).rejects.toThrow(/git clone timed out/);

        expect(attempts).toBe(3);
    });

    it("does not retry a remote that answered - the answer will not change", async () => {
        const cases = [
            "remote: Repository not found.\nfatal: repository 'https://github.com/acme/ghost.git/' not found",
            "remote: Invalid username or token. Password authentication is not supported.\nfatal: Authentication failed",
            "fatal: remote error: upload-pack: not our ref 0f1e2d3c",
        ];

        for (const stderr of cases) {
            const targetDir = await makeTempDir();
            let attempts = 0;

            await expect(
                cloneWithRetry({
                    targetDir,
                    logger: testLogger,
                    sleep: noSleep,
                    attempt: async () => {
                        attempts += 1;
                        throw refused(stderr);
                    },
                }),
            ).rejects.toThrow();

            expect(attempts, stderr).toBe(1);
        }
    });

    it("retries a git exit that carries no answer, like a dropped connection mid-transfer", async () => {
        const targetDir = await makeTempDir();
        let attempts = 0;

        await cloneWithRetry({
            targetDir,
            logger: testLogger,
            sleep: noSleep,
            attempt: async () => {
                attempts += 1;
                if (attempts === 1) throw refused("fatal: the remote end hung up unexpectedly\nfatal: early EOF");
            },
        });

        expect(attempts).toBe(2);
    });
});
