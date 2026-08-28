import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { computeRunSubject } from "../src/run-subject";

const execFileAsync = promisify(execFile);

/**
 * One step of a repo history, replayed in order by {@link buildRepo}. Every commit-producing step carries a
 * `name` under which its sha is recorded, so a test addresses history points symbolically instead of by hand.
 */
type GitStep =
    | { type: "commit"; name: string; files: Record<string, string> }
    | { type: "branch"; name: string; at: string }
    | { type: "checkout"; branch: string }
    | { type: "merge"; of: string | string[]; name: string; resolve?: Record<string, string> }
    | { type: "cherry-pick"; of: string; name: string; amend?: Record<string, string> };

interface Repo {
    root: string;
    sha(name: string): string;
}

const repoRoots: string[] = [];

afterAll(async () => {
    await Promise.all(repoRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Replay a typed step list into a real repo. Each test builds exactly the history shape it exercises. */
async function buildRepo(steps: GitStep[]): Promise<Repo> {
    const root = await mkdtemp(join(tmpdir(), "run-subject-"));
    repoRoots.push(root);
    const shas = new Map<string, string>();
    const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: root })).stdout.trim();
    const writeFiles = async (files: Record<string, string>) => {
        for (const [path, content] of Object.entries(files)) {
            await fs.mkdir(join(root, dirname(path)), { recursive: true });
            await fs.writeFile(join(root, path), content);
        }
    };
    const record = async (name: string) => shas.set(name, await git("rev-parse", "HEAD"));
    const resolve = (name: string) => {
        const sha = shas.get(name);
        if (sha == null) throw new Error(`Unknown commit name: ${name}`);
        return sha;
    };

    await git("init", "--initial-branch", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");

    for (const step of steps) {
        switch (step.type) {
            case "commit": {
                await writeFiles(step.files);
                await git("add", ".");
                await git("commit", "--allow-empty", "-m", step.name);
                await record(step.name);
                break;
            }
            case "branch": {
                await git("checkout", "-b", step.name, resolve(step.at));
                break;
            }
            case "checkout": {
                await git("checkout", step.branch);
                break;
            }
            case "merge": {
                const parents = Array.isArray(step.of) ? step.of : [step.of];
                const merge = execFileAsync("git", ["merge", ...parents.map(resolve), "-m", step.name], {
                    cwd: root,
                });
                if (step.resolve == null) {
                    await merge;
                } else {
                    // A conflicted merge exits non-zero; the resolution files conclude it.
                    await merge.catch(() => undefined);
                    await writeFiles(step.resolve);
                    await git("add", ".");
                    await git("commit", "-m", step.name);
                }
                await record(step.name);
                break;
            }
            case "cherry-pick": {
                await git("cherry-pick", resolve(step.of));
                if (step.amend != null) {
                    await writeFiles(step.amend);
                    await git("add", ".");
                    await git("commit", "--amend", "--no-edit");
                }
                await record(step.name);
                break;
            }
        }
    }

    return { root, sha: resolve };
}

/** The recurring backdrop: a trunk of three commits, so branches can fork at `m1` while the target tip is `m3`. */
function trunk(): GitStep[] {
    return [
        { type: "commit", name: "m1", files: { "a.txt": "base\n" } },
        { type: "commit", name: "m2", files: { "main2.txt": "m2\n" } },
        { type: "commit", name: "m3", files: { "main3.txt": "m3\n" } },
    ];
}

describe("computeRunSubject", () => {
    it("returns undefined without a target tip", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
        ]);
        const subject = await computeRunSubject({ root: repo.root, headSha: repo.sha("f1") });
        expect(subject).toBeUndefined();
    });

    it("returns undefined when the target tip is not in the clone", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("f1"),
            frontierSha: repo.sha("m1"),
            targetSha: "0".repeat(40),
        });
        expect(subject).toBeUndefined();
    });

    it("scopes a plain push to its new commits with an empty ledger", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "commit", name: "f2", files: { "feat2.txt": "two\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("f2"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("f2")]);
        expect(subject!.commits[0]!.subject).toBe("f2");
        expect(subject!.files).toEqual(["feat2.txt"]);
        expect(subject!.ledger).toEqual({ inheritedCount: 0, replayedCount: 0, cleanMergeCount: 0 });
        expect(subject!.ownedBaseSha).toBe(repo.sha("m1"));
    });

    it("reports an all-empty subject for a same-head run", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("f1"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits).toEqual([]);
        expect(subject!.ledger).toEqual({ inheritedCount: 0, replayedCount: 0, cleanMergeCount: 0 });
        expect(subject!.ownedStat).toContain("feat1.txt");
    });

    it("reduces a clean update-branch merge to nothing owned, with the inheritance accounted", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "merge", of: "m3", name: "update" },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("update"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits).toEqual([]);
        expect(subject!.files).toEqual([]);
        expect(subject!.ledger).toEqual({ inheritedCount: 2, replayedCount: 0, cleanMergeCount: 1 });
        expect(subject!.inheritedStat).toContain("main2.txt");
        expect(subject!.inheritedStat).toContain("main3.txt");
    });

    it("keeps only the conflict resolutions of a conflicted merge", async () => {
        const repo = await buildRepo([
            { type: "commit", name: "m1", files: { "a.txt": "base\n" } },
            { type: "commit", name: "m2", files: { "a.txt": "main version\n" } },
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "a.txt": "feature version\n" } },
            { type: "merge", of: "m2", name: "update", resolve: { "a.txt": "resolved version\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("update"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m2"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("update")]);
        expect(subject!.commits[0]!.conflictResolution).toBeDefined();
        expect(subject!.commits[0]!.files).toEqual(["a.txt"]);
        expect(subject!.ledger.cleanMergeCount).toBe(0);
    });

    it("keeps new work pushed after an update-branch merge, excluding only the merge", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "merge", of: "m3", name: "update" },
            { type: "commit", name: "f2", files: { "feat2.txt": "two\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("f2"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("f2")]);
        expect(subject!.ledger).toEqual({ inheritedCount: 2, replayedCount: 0, cleanMergeCount: 1 });
    });

    it("keeps the commits a side-branch merge brings in - they are nobody else's to assess", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "side", at: "m1" },
            { type: "commit", name: "s1", files: { "side.txt": "s\n" } },
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "merge", of: "s1", name: "sideMerge" },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("sideMerge"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("s1")]);
        expect(subject!.files).toEqual(["side.txt"]);
        expect(subject!.ledger).toEqual({ inheritedCount: 0, replayedCount: 0, cleanMergeCount: 1 });
    });

    it("drops rebase-replayed commits by patch-id and keeps the genuinely new one", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "prerebase", at: "m1" },
            { type: "commit", name: "r1", files: { "r1.txt": "r1\n" } },
            { type: "commit", name: "r2", files: { "r2.txt": "r2\n" } },
            { type: "branch", name: "rebased", at: "m3" },
            { type: "cherry-pick", of: "r1", name: "r1p" },
            { type: "cherry-pick", of: "r2", name: "r2p" },
            { type: "commit", name: "r3", files: { "r3.txt": "r3\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("r3"),
            frontierSha: repo.sha("r2"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("r3")]);
        expect(subject!.files).toEqual(["r3.txt"]);
        expect(subject!.ledger.replayedCount).toBe(2);
    });

    it("keeps a commit that was modified during the rebase - changed content is unassessed content", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "prerebase", at: "m1" },
            { type: "commit", name: "r1", files: { "r1.txt": "one\n" } },
            { type: "branch", name: "rebased", at: "m3" },
            { type: "cherry-pick", of: "r1", name: "r1mod", amend: { "r1.txt": "one, modified in flight\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("r1mod"),
            frontierSha: repo.sha("r1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("r1mod")]);
        expect(subject!.ledger.replayedCount).toBe(0);
    });

    it("anchors a first run on the merge-base even when the recorded base is a drifted target tip", async () => {
        // First runs record the target's tip AT TRIGGER TIME as the base; a two-dot diff against it would show
        // the target's advance as reverse edits once the target moves past the fork point.
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "commit", name: "f2", files: { "feat2.txt": "two\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("f2"),
            frontierSha: repo.sha("m2"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.subject)).toEqual(["f1", "f2"]);
        expect(subject!.files).toEqual(["feat1.txt", "feat2.txt"]);
        expect(subject!.ownedBaseSha).toBe(repo.sha("m1"));
        expect(subject!.ownedStat).toContain("feat1.txt");
    });

    it("degrades to owned-content scoping when the frontier is not in the clone", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "commit", name: "f2", files: { "feat2.txt": "two\n" } },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("f2"),
            frontierSha: "f".repeat(40),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.subject)).toEqual(["f1", "f2"]);
    });

    it("carries an empty commit through without a patch-id and without files", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "commit", name: "empty", files: {} },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("empty"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        expect(subject!.commits.map((c) => c.sha)).toEqual([repo.sha("empty")]);
        expect(subject!.commits[0]!.files).toEqual([]);
        expect(subject!.ledger.replayedCount).toBe(0);
    });

    it("keeps an octopus merge whole - over-including rather than guessing at its deviation", async () => {
        const repo = await buildRepo([
            ...trunk(),
            { type: "branch", name: "sideA", at: "m1" },
            { type: "commit", name: "sa", files: { "sa.txt": "a\n" } },
            { type: "branch", name: "sideB", at: "m1" },
            { type: "commit", name: "sb", files: { "sb.txt": "b\n" } },
            { type: "branch", name: "feature", at: "m1" },
            { type: "commit", name: "f1", files: { "feat1.txt": "one\n" } },
            { type: "merge", of: ["sa", "sb"], name: "octo" },
        ]);
        const subject = await computeRunSubject({
            root: repo.root,
            headSha: repo.sha("octo"),
            frontierSha: repo.sha("f1"),
            targetSha: repo.sha("m3"),
        });

        expect(subject).toBeDefined();
        const octo = subject!.commits.find((c) => c.sha === repo.sha("octo"));
        expect(octo).toBeDefined();
        expect(octo!.files.sort()).toEqual(["sa.txt", "sb.txt"]);
        expect(subject!.ledger.cleanMergeCount).toBe(0);
    });
});
