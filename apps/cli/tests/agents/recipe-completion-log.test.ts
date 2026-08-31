import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The completion marker is absent on every poll until the agent's last act, so the
 * transcript must stay quiet through the wait - one run filled 90% of its 4MB debug
 * file with 6187 copies of that expected miss, leaving the phase with no narrative.
 * An error that is NOT the missing marker still has to land: it means the marker can
 * never arrive and the watcher would wait forever.
 */
describe("readCompletion transcript noise", () => {
    let dir: string;
    let transcript: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "completion-log-"));
        transcript = join(dir, "run.jsonl");
        vi.stubEnv("AUTONOMA_DEBUG_FILE", transcript);
        // debugFilePath resolves the path once per module instance, so each test needs a fresh one.
        vi.resetModules();
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await rm(dir, { recursive: true, force: true });
    });

    async function records(): Promise<string[]> {
        const raw = await readFile(transcript, "utf-8").catch(() => "");
        return raw.split("\n").filter((line) => line !== "");
    }

    test("writes nothing across many polls while the marker is absent", async () => {
        const { readCompletion } = await import("../../src/agents/04-recipe-builder/completion");

        for (let i = 0; i < 50; i++) expect(await readCompletion(dir)).toBe(false);

        expect(await records()).toEqual([]);
    });

    test("records a read that failed for any other reason", async () => {
        const { readCompletion } = await import("../../src/agents/04-recipe-builder/completion");
        // A file where the marker's parent directory should be: ENOTDIR, not ENOENT.
        const blocked = join(dir, "blocker");
        await writeFile(blocked, "", "utf-8");

        expect(await readCompletion(blocked)).toBe(false);

        const lines = await records();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("Cannot read the completion marker");
    });
});
