import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";

const execFileAsync = promisify(execFile);

/** Hard cap on bytes buffered from `git`, protecting the worker from a pathological diff. */
const MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Past this many candidate commits the range is not an incremental push and per-commit analysis would drown the
 * prompt; the caller falls back to the plain range presentation instead.
 */
const MAX_SUBJECT_COMMITS = 250;

/** A git object id, SHA-1 or SHA-256. */
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

export interface RunSubjectParams {
    /** Filesystem root of the primary repo's clone, checked out at `headSha`. */
    root: string;
    headSha: string;
    /** The assessed frontier: the last completed run's head (`snapshot.baseSha`). */
    frontierSha?: string | undefined;
    /** The target branch's current tip, fetched into the clone. Absent means the subject cannot be scoped. */
    targetSha?: string | undefined;
}

/** One commit of the run's subject: content authored onto the branch that no completed run has assessed. */
export interface SubjectCommit {
    sha: string;
    subject: string;
    /** The paths this commit touches. For a merge commit, only its deviation from the clean auto-merge. */
    files: string[];
    /** Present on a merge commit whose tree deviates from the clean auto-merge: the conflict resolutions. */
    conflictResolution?: {
        stat: string;
    };
}

/** The accounting of what was excluded from the subject and why - rendered so the subtraction is never silent. */
export interface SubtractionLedger {
    /** Commits in the analyzed range that are reachable from the target branch: inherited, not authored here. */
    inheritedCount: number;
    /** Candidate commits dropped because their patch-id matches content an earlier completed run assessed. */
    replayedCount: number;
    /** Merge commits whose tree equals the clean auto-merge: nothing was hand-authored in them. */
    cleanMergeCount: number;
}

/**
 * What an analysis run should consider: the branch's own unassessed content, plus the accounting of everything
 * that was subtracted to arrive at it.
 */
export interface RunSubject {
    /** The subject commits, oldest first. Empty when the range brought nothing the branch owns. */
    commits: SubjectCommit[];
    /** The union of the subject commits' paths, in commit order. */
    files: string[];
    ledger: SubtractionLedger;
    /** The merge-base of head and target: the anchor of the branch's whole owned patch. */
    ownedBaseSha?: string;
    /** `git diff --stat` of the branch's whole owned patch (`ownedBaseSha..head`). */
    ownedStat?: string;
    /** `git diff --stat` of what the target contributed within this range - context, never subject. */
    inheritedStat?: string;
}

/**
 * Compute the run's subject from the clone: commits reachable from the head but from neither the assessed
 * frontier nor the target tip, minus rebase-replayed content (patch-id equivalence against the frontier's
 * history), with merge commits reduced to their deviation from the clean auto-merge (the conflict resolutions).
 *
 * Returns `undefined` whenever the subject cannot be scoped - no target tip, a sha missing from the clone, a
 * range past {@link MAX_SUBJECT_COMMITS}, or any git failure - so the caller degrades to the plain
 * `base..head` presentation instead of silently misrepresenting the range. Every exclusion the scoped result
 * DOES make is counted in the {@link SubtractionLedger}.
 */
export async function computeRunSubject(params: RunSubjectParams): Promise<RunSubject | undefined> {
    const logger = rootLogger.child({ name: "computeRunSubject" });
    const { root, headSha, targetSha } = params;
    if (targetSha == null) {
        logger.info("No target tip; the subject cannot be scoped", { extra: { headSha } });
        return undefined;
    }

    try {
        if (!(await isPresent(root, targetSha))) {
            logger.warn("Target tip is not in the clone; falling back to the plain range", {
                extra: { targetSha },
            });
            return undefined;
        }
        // An unreachable frontier degrades to owned-content-only scoping (everything since the fork point)
        // rather than failing: over-analyzing once beats analyzing nothing.
        const frontierSha =
            params.frontierSha != null && (await isPresent(root, params.frontierSha)) ? params.frontierSha : undefined;
        if (frontierSha == null && params.frontierSha != null) {
            logger.warn("Frontier sha is not in the clone; scoping against the target tip only", {
                extra: { frontierSha: params.frontierSha },
            });
        }

        return await scopeSubject({ root, headSha, frontierSha, targetSha, logger });
    } catch (error) {
        logger.warn("Failed to scope the run subject; falling back to the plain range", {
            extra: { headSha, targetSha, error: String(error) },
        });
        return undefined;
    }
}

async function scopeSubject({
    root,
    headSha,
    frontierSha,
    targetSha,
    logger,
}: {
    root: string;
    headSha: string;
    frontierSha?: string | undefined;
    targetSha: string;
    logger: ReturnType<typeof rootLogger.child>;
}): Promise<RunSubject | undefined> {
    const negatives = frontierSha != null ? [`^${frontierSha}`, `^${targetSha}`] : [`^${targetSha}`];
    const candidates = await revList(root, ["--reverse", headSha, ...negatives]);
    if (candidates.length > MAX_SUBJECT_COMMITS) {
        logger.warn("Range has too many candidate commits to scope; falling back to the plain range", {
            extra: { candidates: candidates.length },
        });
        return undefined;
    }

    const rangeCount =
        frontierSha != null ? (await revList(root, [headSha, `^${frontierSha}`])).length : candidates.length;
    const inheritedCount = Math.max(0, rangeCount - candidates.length);

    const replayed = await findReplayedCommits({ root, headSha, frontierSha, targetSha, candidates });
    const subjects = await readSubjects(root, headSha, negatives);

    const commits: SubjectCommit[] = [];
    let cleanMergeCount = 0;
    for (const sha of candidates) {
        if (replayed.has(sha)) continue;
        const commit = await describeCommit(root, sha, subjects.get(sha) ?? "");
        if (commit == null) {
            cleanMergeCount += 1;
            continue;
        }
        commits.push(commit);
    }

    const ownedBaseSha = await mergeBase(root, headSha, targetSha);
    const ownedStat = ownedBaseSha != null ? await diffStat(root, ownedBaseSha, headSha) : undefined;
    const inheritedStat = await readInheritedStat({ root, frontierSha, targetSha, ownedBaseSha, inheritedCount });

    const files = [...new Set(commits.flatMap((commit) => commit.files))];
    const ledger: SubtractionLedger = { inheritedCount, replayedCount: replayed.size, cleanMergeCount };
    logger.info("Scoped the run subject", {
        extra: { commits: commits.length, files: files.length, ...ledger },
    });
    return { commits, files, ledger, ownedBaseSha, ownedStat, inheritedStat };
}

/**
 * The candidate commits whose patch-id matches content in the assessed frontier's history - a rebase or
 * force-push replaying already-analyzed commits under new shas. Merge commits carry no patch-id (their `-p`
 * diff is empty) and are handled by the auto-merge deviation instead.
 */
async function findReplayedCommits({
    root,
    headSha,
    frontierSha,
    targetSha,
    candidates,
}: {
    root: string;
    headSha: string;
    frontierSha?: string | undefined;
    targetSha: string;
    candidates: string[];
}): Promise<Set<string>> {
    if (frontierSha == null || candidates.length === 0) return new Set();
    // Commits the frontier assessed that the head no longer contains - the only source of replayed content.
    const dropped = await revList(root, [frontierSha, `^${headSha}`, `^${targetSha}`]);
    if (dropped.length === 0 || dropped.length > MAX_SUBJECT_COMMITS) return new Set();

    const assessedIds = new Set((await patchIds(root, [frontierSha, `^${headSha}`, `^${targetSha}`])).values());
    const candidateIds = await patchIds(root, [headSha, `^${frontierSha}`, `^${targetSha}`]);

    const replayed = new Set<string>();
    for (const [sha, patchId] of candidateIds) {
        if (assessedIds.has(patchId)) replayed.add(sha);
    }
    return replayed;
}

/**
 * One subject commit, or `undefined` for a merge commit whose tree equals the clean auto-merge (nothing was
 * hand-authored in it). A two-parent merge contributes only its deviation from `git merge-tree`; an octopus
 * merge (or a git without `merge-tree --write-tree`) keeps its whole first-parent diff - over-including rather
 * than silently dropping developer-authored content.
 */
async function describeCommit(root: string, sha: string, subject: string): Promise<SubjectCommit | undefined> {
    const parents = await readParents(root, sha);
    if (parents.length < 2) {
        const files = await changedFiles(root, sha);
        return { sha, subject, files };
    }

    const firstParent = parents[0];
    const secondParent = parents[1];
    if (parents.length === 2 && firstParent != null && secondParent != null) {
        const autoMergeTree = await mergeTree(root, firstParent, secondParent);
        if (autoMergeTree != null) {
            const files = await diffFiles(root, autoMergeTree, sha);
            if (files.length === 0) return undefined;
            const stat = await diffStat(root, autoMergeTree, sha);
            return { sha, subject, files, conflictResolution: { stat } };
        }
    }
    const files = firstParent != null ? await diffFiles(root, firstParent, sha) : await changedFiles(root, sha);
    return { sha, subject, files };
}

/** What the target contributed within this range: the movement between the old and new merge-bases. */
async function readInheritedStat({
    root,
    frontierSha,
    targetSha,
    ownedBaseSha,
    inheritedCount,
}: {
    root: string;
    frontierSha?: string | undefined;
    targetSha: string;
    ownedBaseSha?: string | undefined;
    inheritedCount: number;
}): Promise<string | undefined> {
    if (frontierSha == null || ownedBaseSha == null || inheritedCount === 0) return undefined;
    const previousBase = await mergeBase(root, frontierSha, targetSha);
    if (previousBase == null || previousBase === ownedBaseSha) return undefined;
    return await diffStat(root, previousBase, ownedBaseSha);
}

async function isPresent(root: string, sha: string): Promise<boolean> {
    try {
        await git(root, ["cat-file", "-e", `${sha}^{commit}`]);
        return true;
    } catch {
        // Not an error state: presence is the question being asked.
        return false;
    }
}

async function revList(root: string, args: string[]): Promise<string[]> {
    const out = await git(root, ["rev-list", ...args]);
    return out
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
}

async function readSubjects(root: string, headSha: string, negatives: string[]): Promise<Map<string, string>> {
    const out = await git(root, ["log", "--format=%H%x09%s", headSha, ...negatives]);
    const subjects = new Map<string, string>();
    for (const line of out.trim().split("\n")) {
        if (line.length === 0) continue;
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        subjects.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return subjects;
}

async function readParents(root: string, sha: string): Promise<string[]> {
    const out = await git(root, ["rev-list", "--parents", "-n", "1", sha]);
    return out.trim().split(/\s+/).slice(1);
}

async function changedFiles(root: string, sha: string): Promise<string[]> {
    const out = await git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]);
    return splitLines(out);
}

async function diffFiles(root: string, from: string, to: string): Promise<string[]> {
    const out = await git(root, ["diff", "--name-only", from, to]);
    return splitLines(out);
}

async function diffStat(root: string, from: string, to: string): Promise<string> {
    return await git(root, ["diff", "--stat", from, to]);
}

async function mergeBase(root: string, a: string, b: string): Promise<string | undefined> {
    try {
        const out = await git(root, ["merge-base", a, b]);
        return out.trim();
    } catch (error) {
        // Expected on a shallow clone whose grafts cut the histories apart; the caller renders without an anchor.
        rootLogger
            .child({ name: "computeRunSubject" })
            .debug("merge-base failed (shallow clone?)", { extra: { a, b, error: String(error) } });
        return undefined;
    }
}

/**
 * The clean auto-merge of two parents as a tree oid (`git merge-tree --write-tree`, git >= 2.38). A conflicted
 * merge exits non-zero but still writes the tree (with conflict markers), which is exactly what the deviation
 * diff should be taken against. `undefined` when the git on this machine lacks the flag.
 */
async function mergeTree(root: string, firstParent: string, secondParent: string): Promise<string | undefined> {
    try {
        const out = await git(root, ["merge-tree", "--write-tree", firstParent, secondParent]);
        return firstOid(out);
    } catch (error) {
        const stdout = error != null && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
        const oid = typeof stdout === "string" ? firstOid(stdout) : undefined;
        if (oid != null) return oid;
        rootLogger
            .child({ name: "computeRunSubject" })
            .warn("merge-tree unavailable; keeping the merge's whole first-parent diff", {
                extra: { firstParent, secondParent, error: String(error) },
            });
        return undefined;
    }
}

/** Patch-ids of the commits in a rev-list expression, as a sha -> patch-id map. Merge commits are absent. */
async function patchIds(root: string, revs: string[]): Promise<Map<string, string>> {
    const log = await git(root, ["log", "--format=%H", "-p", ...revs]);
    const out = await pipeToGit(root, ["patch-id", "--stable"], log);
    const ids = new Map<string, string>();
    for (const line of out.trim().split("\n")) {
        if (line.length === 0) continue;
        const [patchId, sha] = line.split(/\s+/);
        if (patchId != null && sha != null) ids.set(sha, patchId);
    }
    return ids;
}

function firstOid(out: string): string | undefined {
    const first = out.trim().split("\n")[0]?.trim();
    return first != null && OBJECT_ID.test(first) ? first : undefined;
}

function splitLines(out: string): string[] {
    return out
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
}

async function git(root: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: MAX_BUFFER });
    return stdout;
}

/** Run git with `input` on stdin - `git patch-id` reads a patch stream and execFile has no stdin. */
function pipeToGit(root: string, args: string[], input: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("git", args, { cwd: root });
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
            else reject(new Error(`git ${args.join(" ")} exited ${code}: ${Buffer.concat(errChunks).toString()}`));
        });
        child.stdin.on("error", reject);
        child.stdin.end(input);
    });
}
