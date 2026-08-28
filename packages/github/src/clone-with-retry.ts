import { mkdir, rm } from "node:fs/promises";
import type { Logger } from "@autonoma/logger";
import { sleep as defaultSleep } from "@autonoma/utils/sleep";
import { GitCommandError, isUnreachableRefError } from "./git-clone-step";

interface CloneAttempt {
    timeoutMs: number;
    /** How long to wait before the NEXT attempt. Absent on the last one - which is what makes it the last one. */
    backoffMs?: number;
}

/**
 * Budgets escalate rather than repeat: a clone killed at the buzzer (`elapsed=120020ms`) says nothing about how
 * much more time it needed, so a fresh attempt under the same budget dies the same way. The worst case (9m20s of
 * git plus 20s of backoff) has to stay a fraction of the 20-minute analysis activity that owns the clone and
 * still has to run the analysis afterwards.
 */
const ATTEMPTS: readonly CloneAttempt[] = [
    { timeoutMs: 120_000, backoffMs: 5_000 },
    { timeoutMs: 180_000, backoffMs: 15_000 },
    { timeoutMs: 240_000 },
];

/** Patterns rather than values because git wraps its own wording around each of these. */
const REMOTE_REFUSED_PATTERNS = [
    /repository not found/i,
    /authentication failed/i,
    /could not read username/i,
    /invalid username or (password|token)/i,
    /permission denied/i,
    /access denied/i,
];

export interface CloneWithRetryInput {
    /**
     * Emptied before every retry: `git clone` refuses a target that exists and is non-empty, and a clone killed
     * mid-transfer leaves a partial tree behind.
     */
    targetDir: string;
    attempt: (timeoutMs: number) => Promise<void>;
    logger: Logger;
    sleep?: (ms: number) => Promise<void>;
}

/** Clone one repository, retrying only a failure that never got an answer out of the remote. */
export async function cloneWithRetry(input: CloneWithRetryInput): Promise<void> {
    const { targetDir, attempt, logger, sleep = defaultSleep } = input;

    for (const [index, { timeoutMs, backoffMs }] of ATTEMPTS.entries()) {
        try {
            logger.info("Cloning repository", {
                extra: { targetDir, attempt: index + 1, attempts: ATTEMPTS.length, timeoutMs },
            });
            await attempt(timeoutMs);
            if (index > 0) logger.info("Clone succeeded on retry", { extra: { targetDir, attempts: index + 1 } });
            return;
        } catch (error) {
            if (backoffMs == null || !isRetryable(error)) throw error;

            logger.warn("Clone attempt failed; retrying under a larger budget", {
                extra: {
                    targetDir,
                    attempt: index + 1,
                    timeoutMs,
                    backoffMs,
                    nextTimeoutMs: ATTEMPTS[index + 1]?.timeoutMs,
                    error,
                },
            });
            await rm(targetDir, { recursive: true, force: true });
            // 0700 because the caller's dir came from `mkdtemp` and holds private customer source; recreating it
            // at the default umask would widen it.
            await mkdir(targetDir, { recursive: true, mode: 0o700 });
            await sleep(backoffMs);
        }
    }
}

/**
 * A clone our timeout killed, or that died by any signal, never finished negotiating with the remote - there is no
 * answer to honour, so it is the retryable case. Anything `runGitStep` did not produce is a programming error, not
 * a flaky network.
 */
function isRetryable(error: unknown): boolean {
    if (!(error instanceof GitCommandError)) return false;
    if (error.details.timedOut || error.details.killed) return true;
    if (isUnreachableRefError(error)) return false;
    return !REMOTE_REFUSED_PATTERNS.some((pattern) => pattern.test(error.message));
}
