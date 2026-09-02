import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import { db } from "@autonoma/db";
import { computeRunSubject, skipSelectionForEmptySubject } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { type OpenSnapshot, TestSuiteStore } from "@autonoma/test-suite";
import type { AnalysisInvestigationTarget } from "@autonoma/workflow/activities";
import type { SnapshotContext } from "../codebase/snapshot-context";
import { loadImpactInputs } from "./load-impact-inputs";
import { type AgentSelection, materializeSelection } from "./materialize-selection";
import { EMPTY_MERGE_FLOW_RESULT, type MergeFlowResult, runMergeFlow } from "./merge-flow";
import { reverifyOpenIssues } from "./reverify-issues";
import { runDiffsAgent } from "./run-diffs-agent";

const logger = rootLogger.child({ name: "selectImpactTargets" });

export interface SelectImpactTargetsParams {
    /** The run's own snapshot the pipeline operates on. */
    snapshotId: string;
    /**
     * The clone plus the resolved branch/GitHub metadata for the run, owned by the activity. Carries the PR's
     * target-branch tip (`context.targetSha`, fetched into the clone) that scopes the run subject.
     */
    context: SnapshotContext;
    events: ResolvedAnalysisEvent[];
}

/**
 * The Impact Analysis stage of the merged pipeline.
 *
 * On a main-branch run it first absorbs the merge flow (see {@link runMergeFlow}): the plan edits of the PRs that
 * merged in since the last main run are imported and their deletions propagated, so main grades the diff against
 * the suite those PRs actually left behind rather than re-deriving a pre-fix plan and failing it.
 *
 * Then it reuses the DiffsAgent (the same stateless selection the diffs job ran - diff + current suite, no prior-run
 * history, no carry-forward) to mark affected tests and author brand-new ones. A brand-new test is authored onto the
 * run's OWN snapshot via `addTest`; an affected test needs no suite write at all. Finally it adds the covering tests
 * of the branch's open issues of every kind (see {@link reverifyOpenIssues}), which is what lets a fixed bug - or a
 * closed environment/scenario gap - resolve rather than sit open forever.
 *
 * The result is a target list of `(test, reason, origin)` - merge-imported, new, affected and re-verified tests
 * enter the Investigator fan-out identically, deduplicated by test, and each Investigator starts its own runs.
 */
export async function selectImpactTargets({
    snapshotId,
    context,
    events,
}: SelectImpactTargetsParams): Promise<ImpactSelection> {
    logger.info("Impact Analysis selection started");

    const store = new TestSuiteStore(db);
    const snapshot = await store.reopen(snapshotId);

    const merge = await absorbMergedBranchWork({ store, snapshot, context });

    const agentResult = await runSelection({ snapshot, context, merge, events });

    const selected = await materializeSelection({ snapshot, agentResult });
    const reverified = await reverifyOpenIssues({ db, snapshot });

    // One target per test, wherever the sources overlap (a re-verified test the diff also affected, a merge import
    // the conflict pass also named). First wins: the more specific provenance comes earlier in the list.
    const targets = dedupeTargets([
        // The TestCase is a real suite member, authored and already run on the branch that merged it.
        ...merge.imports.map((imported) => ({
            slug: imported.slug,
            testCaseId: imported.testCaseId,
            reason: imported.reason,
            origin: "pre_existing" as const,
        })),
        ...selected,
        // A re-verified test is a real suite member too - it is only in the run set because it once exposed an open issue.
        ...reverified.map((test) => ({
            slug: test.slug,
            testCaseId: test.testCaseId,
            reason: test.reason,
            origin: "pre_existing" as const,
        })),
    ]);

    logger.info("Impact Analysis selection complete", { extra: { targets: targets.length } });
    return { targets, reasoning: agentResult.reasoning };
}

/** The Impact Analysis selection: the tests to investigate + the agent's overall account of why it chose them. */
export interface ImpactSelection {
    targets: AnalysisInvestigationTarget[];
    reasoning: string;
}

/**
 * Two Investigators on one test would race for its single `(snapshot, testCase)` finding row, so the target list
 * holds one entry per test. First entry wins; a duplicate is logged and skipped.
 */
function dedupeTargets(targets: AnalysisInvestigationTarget[]): AnalysisInvestigationTarget[] {
    const deduped: AnalysisInvestigationTarget[] = [];
    const claimedTestCaseIds = new Set<string>();
    for (const target of targets) {
        if (claimedTestCaseIds.has(target.testCaseId)) {
            logger.info("Test was already targeted this run; ignoring the duplicate", {
                extra: { slug: target.slug },
            });
            continue;
        }
        claimedTestCaseIds.add(target.testCaseId);
        deduped.push(target);
    }
    return deduped;
}

/**
 * Run the merge flow when this run is the application's main branch, where merges land. Phase 1 only handles the
 * `feat/x -> main` direction, so a PR-branch run has no merged work to absorb.
 */
async function absorbMergedBranchWork({
    store,
    snapshot,
    context,
}: {
    store: TestSuiteStore;
    snapshot: OpenSnapshot;
    context: SnapshotContext;
}): Promise<MergeFlowResult> {
    if (!context.isMainBranch) {
        logger.info("Not a main-branch run; skipping the merge flow");
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const [owner, repo] = context.repoFullName.split("/");
    if (owner == null || repo == null) {
        logger.warn("Unexpected repository fullName; skipping the merge flow", {
            extra: { fullName: context.repoFullName },
        });
        return EMPTY_MERGE_FLOW_RESULT;
    }

    const result = await runMergeFlow({
        db,
        store,
        snapshot,
        githubClient: context.githubClient,
        owner,
        repo,
        targetBranchRef: context.defaultBranch,
        baseSha: context.baseSha,
        headSha: context.headSha,
        // primaryDir, not root: in a multi-repo workspace `root` is the parent that holds the repos, not a repo -
        // the merge flow runs git against the primary repo's own clone.
        repoDir: context.codebase.primaryDir,
    });

    logger.info("Merge flow absorbed", {
        extra: {
            merges: result.merges.length,
            imports: result.imports.length,
            removed: result.removedSlugs.length,
            conflicts: result.preClassifiedConflicts.length,
        },
    });
    return result;
}

/**
 * Assemble the DiffsAgent input from the snapshot's suite - read AFTER the merge flow applied, so it already
 * carries the imported plans and no longer carries the propagated deletions (see {@link loadImpactInputs}) - and
 * run the agent over the activity's clone.
 */
async function runSelection({
    snapshot,
    context,
    merge,
    events,
}: {
    snapshot: OpenSnapshot;
    context: SnapshotContext;
    merge: MergeFlowResult;
    events: ResolvedAnalysisEvent[];
}): Promise<AgentSelection> {
    // Main is its own target: merging a PR is main's own act, so its diff is not scoped down.
    const subject = context.isMainBranch
        ? undefined
        : await computeRunSubject({
              root: context.codebase.primaryDir,
              headSha: context.headSha,
              frontierSha: context.baseSha,
              targetSha: context.targetSha,
          });

    // Nothing owned to analyze and no directives to serve: answer deterministically instead of asking an agent
    // to do nothing - each run that talks itself into "interference" costs real test executions.
    const skipped = skipSelectionForEmptySubject(subject, events);
    if (skipped != null) {
        return {
            reasoning: skipped.reasoning,
            affectedTests: [],
            createdTests: [],
            flowFolderId: () => undefined,
            testCaseIdBySlug: new Map(),
        };
    }

    const suite = await snapshot.read();
    const inputs = await loadImpactInputs({ snapshotId: snapshot.snapshotId, suite, merge, events });

    const { result } = await runDiffsAgent({
        snapshotId: snapshot.snapshotId,
        input: { ...inputs, subject },
        codebase: context.codebase,
    });
    logger.info("DiffsAgent selection complete", {
        extra: { affectedTests: result.affectedTests.length, createdTests: result.createdTests.length },
    });

    return {
        reasoning: result.reasoning,
        affectedTests: result.affectedTests.map((test) => ({
            slug: test.slug,
            reasoning: test.reasoning,
            affectedReason: test.affectedReason,
        })),
        createdTests: result.createdTests.map((test) => ({
            name: test.name,
            description: test.description,
            plan: test.plan,
            folderName: test.folderName,
            scenarioId: test.scenarioId,
        })),
        flowFolderId: (folderName) => inputs.flowIndex.getFlow(folderName)?.id,
        testCaseIdBySlug: new Map(suite.testCases.map((testCase) => [testCase.slug, testCase.id])),
    };
}
