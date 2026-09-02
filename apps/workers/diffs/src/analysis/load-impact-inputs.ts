import { AnalysisStore, PRIOR_REPORTS_LIMIT, type ResolvedAnalysisEvent } from "@autonoma/analysis";
import { db, type PrismaClient } from "@autonoma/db";
import {
    type BranchHistory,
    type DiffsAgentInput,
    FlowIndex,
    loadFlows,
    mapTestSuiteToContext,
    resolveScenarioRecipesForSnapshot,
} from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { Suite } from "@autonoma/test-suite";
import { analysisIssueKindSchema } from "@autonoma/types";
import { loadScenarioIndex } from "../load-scenario-index";
import type { MergeFlowResult } from "./merge-flow";

const logger = rootLogger.child({ name: "loadImpactInputs" });

/** The fully-assembled DiffsAgent input minus the on-disk clone, which the activity owns and injects at run time. */
export type ImpactAnalysisInputs = Omit<DiffsAgentInput, "codebase">;

export interface LoadImpactInputsParams {
    snapshotId: string;
    /** The suite the agent grades against: the post-merge run suite on a run, the baseline suite on an eval capture. */
    suite: Suite;
    /** The merge flow's output; {@link EMPTY_MERGE_FLOW_RESULT} on a run without a merge. */
    merge: MergeFlowResult;
    events: ResolvedAnalysisEvent[];
    /** The snapshot whose scenario recipe versions to read. Defaults to `snapshotId`; an eval capture passes its baseline. */
    recipeSnapshotId?: string;
    /** Defaults to the shared connection; an injected one lets tests seed and read through the same database. */
    client?: PrismaClient;
}

/**
 * Assemble the complete {@link ImpactAnalysisInputs} for a run from the suite, the merge context, and the
 * branch/application's flows, scenarios, guidelines, and bounded analysis history. Pure reads - no clone.
 */
export async function loadImpactInputs({
    snapshotId,
    suite,
    merge,
    events,
    recipeSnapshotId = snapshotId,
    client = db,
}: LoadImpactInputsParams): Promise<ImpactAnalysisInputs> {
    logger.info("Loading impact analysis inputs", { extra: { snapshotId } });

    const snapshot = await client.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { headSha: true, baseSha: true, branchId: true, branch: { select: { applicationId: true } } },
    });
    if (snapshot.headSha == null || snapshot.baseSha == null) {
        throw new Error(
            `Snapshot ${snapshotId} is missing SHAs (head: ${snapshot.headSha}, base: ${snapshot.baseSha})`,
        );
    }
    const { branchId } = snapshot;
    const applicationId = snapshot.branch.applicationId;

    // An imported test is already in the run set with its plan settled, so it is withheld from the agent's list -
    // marking it affected would only target the same test twice. Conflicts stay listed: the agent reads their
    // current plans to explain how the legs diverge.
    const importedSlugs = new Set(merge.imports.map((imported) => imported.slug));
    const existingTests = mapTestSuiteToContext(suite).existingTests.filter((test) => !importedSlugs.has(test.slug));

    const [flows, application, scenarios, branchHistory, scenarioRecipes] = await Promise.all([
        loadFlows(client, applicationId, suite),
        client.application.findUniqueOrThrow({ where: { id: applicationId }, select: { testScopeGuidelines: true } }),
        loadScenarioIndex(client, applicationId),
        loadBranchHistory(client, branchId, snapshotId),
        resolveScenarioRecipesForSnapshot(client, recipeSnapshotId, collectScenarioIds(suite)),
    ]);

    logger.info("Loaded impact analysis inputs", {
        extra: {
            existingTests: existingTests.length,
            flows: flows.length,
            scenarios: scenarios.listScenarios().length,
            hasTestScopeGuidelines: application.testScopeGuidelines != null,
            removedTests: branchHistory.removedTests.length,
            priorReports: branchHistory.priorReports.length,
            openIssues: branchHistory.openIssues.length,
            events: events.length,
            merges: merge.merges.length,
            conflicts: merge.preClassifiedConflicts.length,
        },
    });

    return {
        headSha: snapshot.headSha,
        baseSha: snapshot.baseSha,
        existingTests,
        flowIndex: new FlowIndex(flows),
        scenarios,
        scenarioRecipes,
        testScopeGuidelines: application.testScopeGuidelines ?? undefined,
        branchHistory,
        events,
        merges: merge.merges,
        preClassifiedConflicts: merge.preClassifiedConflicts,
    };
}

/**
 * The bounded slice of the branch's analysis history fed to the selector: the tests prior runs removed as
 * `invalid_test`, the branch's recent Reporter reports (excluding this run's own, capped by the Reporter's own
 * bound), and its open bug-kind issues. All three reads are branch-scoped and independent, so they run together.
 */
async function loadBranchHistory(client: PrismaClient, branchId: string, snapshotId: string): Promise<BranchHistory> {
    const ledger = new AnalysisStore(client).forBranch(branchId);
    const [removedTests, priorReports, openIssues] = await Promise.all([
        ledger.removedInvalidTests(),
        ledger.priorReports({ excludeSnapshotId: snapshotId, limit: PRIOR_REPORTS_LIMIT }),
        ledger.openIssues({ kind: analysisIssueKindSchema.enum.bug }),
    ]);

    return {
        removedTests: removedTests.map((t) => ({ slug: t.slug, name: t.name, reason: t.reason })),
        priorReports: priorReports.map((r) => ({ snapshotId: r.snapshotId, report: r.reportMarkdown })),
        openIssues: openIssues.map((issue) => ({
            title: issue.title,
            expectedBehavior: issue.expectedBehavior,
            actualBehavior: issue.actualBehavior,
            coveredSlugs: [...new Set(issue.coveredFindings.map((finding) => finding.slug))],
        })),
    };
}

/** The distinct scenario ids the suite's plans reference (for point-in-time recipe resolution). */
function collectScenarioIds(suite: Suite): string[] {
    const ids = new Set<string>();
    for (const testCase of suite.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}
