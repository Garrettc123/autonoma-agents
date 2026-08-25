import { mkdir, rm } from "node:fs/promises";
import type { Readable } from "node:stream";
import { sleep as defaultSleep } from "@autonoma/utils/sleep";
import { logger as rootLogger } from "../logger";
import { extractTarballStream } from "./extract-tarball-stream";

/** Backoff between attempts; its length is the number of retries AFTER the first attempt. */
const DELAYS_MS = [2_000, 5_000, 10_000, 20_000];
/** A timeout or a rate limit is worth another attempt; every other 4xx is the answer itself. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429]);

export interface DownloadRepoTarballInput {
    repoFullName: string;
    ref: string;
    targetDir: string;
    /** Issues the tarball request and hands back its gzip body. Called once per attempt. */
    openStream: () => Promise<Readable>;
    /** Injectable for tests so they don't wait real time; defaults to the shared `@autonoma/utils` sleep. */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * Download one repo tarball into `targetDir`, retrying a download that dies before it finishes.
 *
 * GitHub degrades archive downloads long before it refuses them - during its 2026-08-17 incident roughly half of
 * them dropped mid-body - and a dropped body surfaces as undici's `TypeError: terminated` with a partly extracted
 * tree already on disk. A stream cannot be resumed, so every attempt issues a fresh request into an emptied
 * `targetDir`.
 */
export async function downloadRepoTarball(input: DownloadRepoTarballInput): Promise<void> {
    const { repoFullName, ref, targetDir, openStream, sleep = defaultSleep } = input;
    const logger = rootLogger.child({ name: "downloadRepoTarball" });
    const ids = { preview: { repo: repoFullName } };

    for (let attempt = 0; ; attempt += 1) {
        try {
            logger.info("Downloading repo tarball", { ...ids, extra: { ref, attempt: attempt + 1 } });
            await extractTarballStream(await openStream(), targetDir);
            logger.info("Repo tarball extracted", { ...ids, extra: { ref, targetDir, attempts: attempt + 1 } });
            return;
        } catch (error) {
            const delayMs = DELAYS_MS[attempt];
            if (delayMs == null || !isRetryable(error)) throw error;

            logger.warn("Repo tarball download failed; retrying", {
                ...ids,
                extra: { ref, attempt: attempt + 1, delayMs, error },
            });
            await rm(targetDir, { recursive: true, force: true });
            await mkdir(targetDir, { recursive: true });
            await sleep(delayMs);
        }
    }
}

/** A dropped stream or socket carries no HTTP status at all, so the unattributable failure is the retryable one. */
function isRetryable(error: unknown): boolean {
    const status = httpStatus(error);
    if (status == null) return true;
    return status >= 500 || RETRYABLE_STATUSES.has(status);
}

function httpStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error == null || !("status" in error)) return undefined;
    const { status } = error;
    return typeof status === "number" ? status : undefined;
}
