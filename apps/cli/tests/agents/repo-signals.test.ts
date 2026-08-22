import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectRepoSignals } from "../../src/agents/01-kb-generator/repo-signals";

/**
 * These build a real git repo with a controlled history and assert what enters
 * the window the KB agent sees. The bug they guard: on a monorepo the window was
 * chosen by raw churn with no filtering, so lockfiles and generated code took the
 * top slots and a fragile-but-smaller product surface got evicted by a large but
 * stable one. Behavioral, not structural - they check which paths survive and in
 * what order, never how the ranking is computed.
 */

const DAY_MS = 86_400_000;
/**
 * Building the fixture history means one git subprocess per step, and CI runs
 * ~22 packages' vitest suites together on one 8-vCPU runner, where process work
 * measures tens of times slower than locally. The default 10s hook budget does
 * not cover a cold run there, so these hooks get a deliberately generous one.
 */
const FIXTURE_SETUP_TIMEOUT_MS = 60_000;
/**
 * The window the agent sees, and the slots inside it reserved for the app under
 * test - `TOP_FILES` and `ceil(TOP_FILES * FRONTEND_WINDOW_SHARE)` in
 * repo-signals.ts. Literals rather than imports: the monorepo test below pins
 * the split at a known size, and an expectation computed from the
 * implementation's own constants would follow them wherever they moved.
 */
const WINDOW_SIZE = 40;
const FRONTEND_RESERVE = 34;

let repo: string;

/**
 * A fixture repo directory, with its path fully resolved. macOS `tmpdir()` sits
 * behind a symlink (`/var` -> `/private/var`) and `git rev-parse --show-toplevel`
 * reports the resolved path: left unresolved, an app subdirectory never shares a
 * prefix with its own repo root, so the monorepo window split below is silently
 * skipped and the window falls back to a plain repo-wide ranking.
 */
function makeRepoDir(prefix: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function run(args: string[], env?: NodeJS.ProcessEnv): void {
    execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env }, stdio: "ignore" });
}

/** Commit a change to one file, dated `daysAgo` before now so it lands inside the 18-month window. */
function commitFile(path: string, daysAgo: number): void {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `content ${daysAgo}\n`);
    const iso = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
    run(["add", "--", path]);
    run(["commit", "-m", `touch ${path}`, "--no-verify"], { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso });
}

/** Touch a file on each of the given day-offsets (newest first is irrelevant to retouch counting). */
function touchOn(path: string, daysAgoList: number[]): void {
    for (const daysAgo of daysAgoList) commitFile(path, daysAgo);
}

beforeAll(() => {
    repo = makeRepoDir("repo-signals-");
    run(["init", "-q"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "Test"]);
    run(["config", "commit.gpgsign", "false"]);

    // Product surface, small but fragile: 5 touches, all within a week of each
    // other -> 4 retouches. This is the surface the signal exists to find.
    touchOn("apps/web/components/checkout.tsx", [40, 39, 38, 37, 36]);

    // Product surface, larger but stable: 7 touches spaced >1 week apart -> 0
    // retouches. Higher churn than the fragile file; must NOT out-rank it.
    touchOn("apps/web/components/dashboard.tsx", [200, 180, 160, 140, 120, 100, 80]);

    // Product backend that plausibly feeds the UI: kept, not filtered.
    touchOn("apps/api/services/orders.ts", [30, 29, 28]);

    // Noise: a lockfile is the single most-changed path here, and would take slot
    // #1 under the old churn ranking. Must be absent.
    touchOn("pnpm-lock.yaml", [60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50]);

    // Noise: generated code, IaC, CI config, tests, build output.
    touchOn("apps/api/generated/client.ts", [45, 44, 43, 42]);
    touchOn("infra/terraform/main.tf", [70, 69, 68, 67]);
    touchOn(".github/workflows/ci.yml", [75, 74, 73]);
    touchOn("apps/web/components/checkout.test.ts", [36, 35, 34]);
    touchOn("dist/bundle.js", [20, 19, 18]);
}, FIXTURE_SETUP_TIMEOUT_MS);

afterAll(() => {
    if (repo != null) rmSync(repo, { recursive: true, force: true });
});

describe("collectRepoSignals", () => {
    it("keeps product code in the window and filters out infra noise", async () => {
        const signals = await collectRepoSignals(repo);
        expect(signals).toBeDefined();
        const paths = signals!.files.map((f) => f.path);

        expect(paths).toContain("apps/web/components/checkout.tsx");
        expect(paths).toContain("apps/web/components/dashboard.tsx");
        expect(paths).toContain("apps/api/services/orders.ts");

        expect(paths).not.toContain("pnpm-lock.yaml");
        expect(paths).not.toContain("apps/api/generated/client.ts");
        expect(paths).not.toContain("infra/terraform/main.tf");
        expect(paths).not.toContain(".github/workflows/ci.yml");
        expect(paths).not.toContain("apps/web/components/checkout.test.ts");
        expect(paths).not.toContain("dist/bundle.js");
    });

    it("ranks a fragile surface above a higher-churn but stable one", async () => {
        const signals = await collectRepoSignals(repo);
        const paths = signals!.files.map((f) => f.path);

        const fragile = paths.indexOf("apps/web/components/checkout.tsx");
        const stable = paths.indexOf("apps/web/components/dashboard.tsx");
        expect(fragile).toBeGreaterThanOrEqual(0);
        expect(stable).toBeGreaterThanOrEqual(0);
        // Retouch, not churn, decides the window: the fragile file wins despite
        // fewer total commits than the stable hub.
        expect(fragile).toBeLessThan(stable);

        const checkout = signals!.files.find((f) => f.path === "apps/web/components/checkout.tsx");
        const dashboard = signals!.files.find((f) => f.path === "apps/web/components/dashboard.tsx");
        expect(checkout!.retouches).toBeGreaterThan(dashboard!.retouches);
        expect(dashboard!.commits).toBeGreaterThan(checkout!.commits);
    });
});

/**
 * The monorepo crowding fix: the `git log` sees the whole repo, so a busy sibling
 * app can out-rank and evict the frontend under test. When called with the app's
 * own subdirectory as its root, the window must reserve most of its slots for that
 * app while still keeping the highest-signal code from the rest of the repo.
 *
 * Every sibling file that competes for a slot here is MORE corrected than every
 * frontend file, so a plain repo-wide ranking seats the siblings first and leaves
 * the frontend well short of its reserve. That gap is what lets the assertions
 * below tell the reserve's presence from its absence.
 */
describe("collectRepoSignals on a monorepo (frontend under test is a subdirectory)", () => {
    let mono: string;

    function monoRun(args: string[], env?: NodeJS.ProcessEnv): void {
        execFileSync("git", args, { cwd: mono, env: { ...process.env, ...env }, stdio: "ignore" });
    }
    /**
     * Commit every given path in one commit, dated `daysAgo` before now. What the
     * ranking reads is per-file (its own change count, and how tightly its own
     * changes cluster), so files that share a date can share a commit: the
     * signals are identical and the fixture costs one subprocess pair instead of
     * one per file. Only a file whose OWN repeated changes are the point needs a
     * commit each.
     */
    function monoCommit(paths: string[], daysAgo: number): void {
        for (const path of paths) {
            const abs = join(mono, path);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, `content ${daysAgo}\n`);
        }
        const iso = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
        monoRun(["add", "--", ...paths]);
        monoRun(["commit", "-m", `touch ${paths.length} file(s)`, "--no-verify"], {
            GIT_AUTHOR_DATE: iso,
            GIT_COMMITTER_DATE: iso,
        });
    }

    beforeAll(() => {
        mono = makeRepoDir("repo-signals-mono-");
        monoRun(["init", "-q"]);
        monoRun(["config", "user.email", "t@e.com"]);
        monoRun(["config", "user.name", "T"]);
        monoRun(["config", "commit.gpgsign", "false"]);

        // Sibling code with nothing to say: 8 files changed once, long ago, never
        // re-touched. Sibling slots do exist, but ranking must not spend them here.
        monoCommit(
            Array.from({ length: 8 }, (_, i) => `services/api/src/handler-${i}.py`),
            300,
        );

        // The sibling that does the crowding: 19 files changed on four consecutive
        // days -> 3 re-touches each, more than any frontend file below. Nineteen
        // over-fills the non-reserved slots several times over, so an unreserved
        // window would be mostly sibling code.
        const hot = "services/api/src/hot.py";
        const corrected = [hot, ...Array.from({ length: 18 }, (_, i) => `services/api/src/busy-${i}.py`)];
        for (const daysAgo of [50, 49, 48, 47]) monoCommit(corrected, daysAgo);
        // One further change to hot.py alone, so it out-ranks its 18 neighbours and
        // is deterministically the sibling file the leftover slots must pick first.
        monoCommit([hot], 46);

        // The frontend under test: 40 files each changed twice, two days apart ->
        // one re-touch each. Genuine product surfaces, and the least-corrected code
        // in the repo, which is the position the reserve exists to protect. More
        // files than the reserve holds, so the reserve is a real cut, not a total.
        const frontend = Array.from(
            { length: 40 },
            (_, i) => `apps/web/components/feature-${String(i).padStart(2, "0")}.tsx`,
        );
        monoCommit(frontend, 60);
        monoCommit(frontend, 58);
    }, FIXTURE_SETUP_TIMEOUT_MS);

    afterAll(() => {
        if (mono != null) rmSync(mono, { recursive: true, force: true });
    });

    it("reserves most of the window for the app under test but keeps top sibling signal", async () => {
        const signals = await collectRepoSignals(join(mono, "apps/web"));
        expect(signals).toBeDefined();
        const files = signals!.files;
        expect(files.length).toBe(WINDOW_SIZE);

        const frontend = files.filter((f) => f.path.startsWith("apps/web/"));
        const sibling = files.filter((f) => f.path.startsWith("services/"));

        // The split is exact on purpose. On retouch alone the 19 corrected sibling
        // files out-rank all 40 frontend files, so a window without the reserve
        // seats 19 siblings and cuts the frontend to 21; anything looser than
        // equality here passes either way.
        expect(frontend.length).toBe(FRONTEND_RESERVE);
        expect(sibling.length).toBe(WINDOW_SIZE - FRONTEND_RESERVE);

        // The leftover slots are ranked, not arbitrary: the sibling's hottest file
        // leads them (backend-feeds-UI signal), and its never-corrected files get
        // nothing.
        expect(sibling[0]!.path).toBe("services/api/src/hot.py");
        expect(sibling.some((f) => f.path.startsWith("services/api/src/handler-"))).toBe(false);
    });
});
