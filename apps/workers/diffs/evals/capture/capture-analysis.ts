import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { assembleDiffsAgentInput } from "../../src/analysis/assemble-input";
import { getGitHubApp } from "../../src/github-app";
import { serializeAnalysisInput } from "../analysis/analysis-input";
import { casesDir } from "../framework/cases-dir";
import { type CodebaseCoords, ensureFetchable } from "../framework/codebase-cache";
import { resolveSnapshotCoords } from "./snapshot-coords";

export interface CaptureAnalysisParams {
    snapshotId: string;
    /** Case folder name (defaults to the snapshot id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
    /**
     * Freeze this sha as the PR's target-branch tip, so the eval scopes the run subject against it. Passed
     * explicitly rather than resolved live: for a historical snapshot the target has long moved on, and the
     * faithful tip is the one the head was built against (a rebased head's parent, a merge's second parent).
     */
    targetSha?: string;
    /**
     * Fabricate the `commits_pushed` event this run would have claimed, with the given pre-push head. For
     * snapshots that predate the event inbox; the event carries `deliveryId: "eval-fabricated"` so it can
     * never be mistaken for a real delivery.
     */
    fabricatePushBeforeSha?: string;
}

/**
 * Capture an Analysis eval case from a live snapshot.
 *
 * Resolves the snapshot's git coordinates, validates both SHAs are fetchable
 * (refusing to write a case otherwise), runs the shared Analysis side-input
 * loaders against a real codebase clone, freezes the assembled `DiffsAgentInput`
 * to `input.json` (codebase as coords, `FlowIndex` as an array), and scaffolds a
 * blank `expected.md` (`skip: true`) for the author to fill in. Re-capturing keeps an existing one.
 *
 * The test suite is loaded from the *previous* snapshot (`testSuiteSource:
 * "previous"`): by capture time the pipeline has rewritten this snapshot's own
 * assignments, so only the previous snapshot still holds the baseline analysis
 * actually saw.
 */
export async function captureAnalysis(params: CaptureAnalysisParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureAnalysis" });
    const { snapshotId } = params;
    const name = params.name ?? snapshotId;
    const caseDir = path.join(casesDir("analysis"), name);

    logger.info("Capturing analysis case", { extra: { snapshotId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to re-freeze its inputs)`);
    }

    const githubApp = getGitHubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);

    // Warm the same cache the eval uses and validate SHA-fetchability (throws
    // UnfetchableShaError on a dead SHA, so we never write an unrunnable case).
    await ensureFetchable(coords, { githubApp });
    // A frozen target tip is load-bearing for the case (the subject scoping keys on it), so its
    // fetchability is validated as hard as the base/head - never best-effort.
    if (params.targetSha != null) {
        await ensureFetchable({ ...coords, baseSha: params.targetSha }, { githubApp });
    }

    // Use the *previous* snapshot's suite as the baseline: by capture time the
    // pipeline has already rewritten this snapshot's own assignments, so reading
    // them would not reflect what analysis actually saw. The previous snapshot
    // holds the unmutated baseline the production run started from.
    const { agentInput } = await assembleDiffsAgentInput({ snapshotId });
    const events = await withFabricatedPush(snapshotId, coords, agentInput.events ?? [], params);
    const frozenInput = serializeAnalysisInput(coords, { ...agentInput, events }, { targetSha: params.targetSha });

    const expectedPath = path.join(caseDir, "expected.md");
    // A re-capture refreshes the frozen inputs. The expectation is hand-authored, so it is never one of them.
    const expectationExists = existsSync(expectedPath);

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    if (!expectationExists) await writeFile(expectedPath, blankExpected(snapshotId), "utf-8");

    logger.info("Captured analysis case", {
        extra: {
            caseDir,
            keptExpectation: expectationExists,
            existingTests: frozenInput.existingTests.length,
            flows: frozenInput.flowIndex.length,
        },
    });

    return caseDir;
}

/**
 * Append the `commits_pushed` event a pre-inbox run would have claimed, when asked to. Timestamped at the
 * snapshot's own creation so the prompt's event ordering reads as it would have in production.
 */
async function withFabricatedPush(
    snapshotId: string,
    coords: CodebaseCoords,
    events: ResolvedAnalysisEvent[],
    params: CaptureAnalysisParams,
): Promise<ResolvedAnalysisEvent[]> {
    if (params.fabricatePushBeforeSha == null) return events;
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { createdAt: true },
    });
    return [
        ...events,
        {
            type: "commits_pushed",
            payload: {
                headSha: coords.headSha,
                baseSha: params.targetSha,
                beforeSha: params.fabricatePushBeforeSha,
                deliveryId: "eval-fabricated",
            },
            source: "webhook",
            createdAt: snapshot.createdAt,
        },
    ];
}

function blankExpected(snapshotId: string): string {
    return `---
description: "Captured from snapshot ${snapshotId} - TODO: describe what this case exercises"
skip: true
# Deterministic checks (uncomment + fill in, then set skip: false):
# affected:
#   include: []   # slugs that MUST be reported affected
#   exclude: []   # slugs that must NOT be reported affected
#   exact: []     # the exact affected set (order-insensitive)
# createdTests:               # dedup guardrail for tests authored via create_test
#   count:
#     minCount: 0             # how many new tests are expected (maxCount: 0 = diff fully covered)
#     maxCount: 0
#   folders:
#     include: []             # folder names a new test MUST land in
#     exclude: []             # folders nothing new may be authored into (already covered)
#     exact: []               # the exact folder set new tests land in (order-insensitive)
---

TODO: author the LLM-judge rubric here.

The judge sees only the agent's structured output plus this body - never the
codebase or screenshots. Grade qualities the deterministic checks above cannot
express:
  - Was the affected-test reasoning sound, with the right rationale?
  - Is each test authored via create_test a genuinely new, on-topic flow - not
    one already covered by an existing test? Name the closest existing test it
    must not duplicate.
  - Does each created test's coverageJustification soundly explain why those
    existing tests do not already cover it (not a placeholder)?
  - Is each created test's description a specific, falsifiable claim about what
    the feature does (what the user does, what should happen, why it matters) -
    not a restatement of the steps or the coverage justification?
Keep every point additive to the frontmatter, and phrase each as something
checkable from the output alone.
`;
}
