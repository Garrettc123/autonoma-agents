import type { ResolvedAnalysisEvent } from "@autonoma/analysis";
import type { BranchHistory, DiffAnalysis, MergeContextInfo, PreClassifiedConflictInfo } from "../../diffs-agent";
import type { FlowIndex } from "../../flow-index";
import { buildPlanAuthoringContext } from "../../plan-authoring";
import { MAX_PRIOR_REPORT_CHARS, truncate } from "../../prompt-truncate";
import type { RunSubject } from "../../run-subject";
import { type ScenarioRecipeData, summarizeScenarioRecipes } from "../../scenario-recipe";

/**
 * How many changed paths to name before eliding. Orientation, not an inventory: the agent is told the range and
 * can read the rest itself, and a generated-client or lockfile churn PR would otherwise paste thousands of
 * lines in before it has done anything.
 */
const MAX_LISTED_FILES = 50;

/**
 * Cap on the inherited-changes `--stat` block. The target's movement inside a range is unbounded (a monorepo
 * lockfile churn can touch thousands of files), and it is context, not subject - orientation is enough.
 */
const MAX_INHERITED_STAT_CHARS = 2_000;

export interface DiffsPromptInput {
    analysis: DiffAnalysis;
    /** The PR's commit range. Rendered so the agent can read the patch itself; without it the only range it can
     * guess is `HEAD~1`, which on a multi-commit PR is silently a fraction of the change. */
    range: { baseSha: string; headSha: string };
    /** The scoped subject, when the run computed one. Replaces the plain-range presentation. */
    subject?: RunSubject | undefined;
    /** The analysis events the run claimed, oldest first. Empty renders no section at all. */
    events: ResolvedAnalysisEvent[];
    flowIndex: FlowIndex;
    merges: MergeContextInfo[];
    preClassifiedConflicts: PreClassifiedConflictInfo[];
    testScopeGuidelines?: string;
    /** Recipe templates for the scenarios the tests in scope reference. Empty when none apply. */
    scenarioRecipes: ScenarioRecipeData[];
    /** A bounded slice of the branch's analysis history. Absent on a brand-new branch, where the prompt is
     * byte-identical to a stateless run. */
    branchHistory?: BranchHistory;
}

/**
 * Builds the per-run user prompt for the diffs agent. The system prompt is
 * static; everything snapshot-specific (diff summary, merges, conflicts,
 * authoring context) goes through here.
 */
export function buildDiffsUserPrompt(input: DiffsPromptInput): string {
    const { analysis, range, flowIndex, merges, preClassifiedConflicts, testScopeGuidelines, scenarioRecipes } = input;
    const branchHistory = input.branchHistory;

    const planAuthoringContext = buildPlanAuthoringContext({
        flows: flowIndex.listFlows().map((f) => ({
            id: f.id,
            name: f.name,
            description: f.description,
            testCount: f.testCount,
        })),
        testScopeGuidelines,
    });

    let prompt = planAuthoringContext;

    const directivesSection = renderDirectives(input.events);
    if (directivesSection !== "") prompt += `\n\n${directivesSection}`;

    prompt += `

Analyze the following code changes.

## Changes Summary
${analysis.summary}

## Affected Files
${listAffectedFiles(analysis.affectedFiles)}

${input.subject != null ? renderSubjectSection(input.subject, range, hasNonPushEvents(input.events)) : renderRangeSection(range)}`;

    if (input.subject != null) {
        const inheritedSection = renderInheritedSection(input.subject);
        if (inheritedSection !== "") prompt += `\n\n${inheritedSection}`;
    }

    const movementSection = renderMovementEvents(input.events);
    if (movementSection !== "") prompt += `\n\n${movementSection}`;

    if (merges.length > 0) {
        prompt += "\n\n## Merges in this range\n";
        prompt +=
            "These PRs were merged into the current branch in this commit range. Tests whose plans were adopted " +
            "from a single winning side (unilateral_update or new_test) have already been handled outside this " +
            "analysis and are deliberately NOT present in the Existing Tests list below. Do not attempt to " +
            "rediscover them with git or file tools - their plans were reused deterministically and they will be " +
            "replayed automatically.\n";
        for (const m of merges) {
            prompt += `\n- PR #${m.prNumber} from \`${m.sourceBranchName}\` (merge commit \`${m.mergeCommitSha}\`)`;
        }
    }

    if (preClassifiedConflicts.length > 0) {
        prompt += "\n\n## Pre-classified merge conflicts\n";
        prompt +=
            "Each of these tests was modified on multiple sides of the merge and requires re-planning. They are " +
            "ALREADY marked as affected with `affectedReason: merge_conflict` - you do not need to (and must not) " +
            "call `mark_affected_test` for them. Instead, for each one, call `explain_merge_conflict` with a " +
            "`reasoning` that explains how the plans diverge. Use `read_tests` to inspect the current plans before " +
            "writing the reasoning - pass every conflict slug in one call. They will be re-planned using all the legs listed below.\n";
        for (const c of preClassifiedConflicts) {
            prompt += `\n- **${c.slug}** (${c.testName}) - PRs involved: ${c.involvedPrNumbers.join(", ")}`;
            for (const v of c.versions) {
                const origin = v.role === "source" ? `source ${v.sourceName ?? ""} (PR #${v.prNumber ?? "?"})` : v.role;
                prompt += `\n    - ${origin}: assignment \`${v.assignmentId}\`, plan \`${v.planId ?? "<none>"}\``;
            }
        }
    }

    const recipeSummary = summarizeScenarioRecipes(scenarioRecipes);
    if (recipeSummary != null) {
        prompt += `\n\n## Scenario Recipes (test data templates)\n${recipeSummary}`;
    }

    if (branchHistory != null) {
        const historySection = renderBranchHistory(branchHistory);
        if (historySection !== "") prompt += `\n\n${historySection}`;
    }

    if (flowIndex.listFlows().length > 0) {
        prompt +=
            "\n\nFlows are listed in the Plan Authoring Context above. Use `list_tests` to see tests in a flow and `read_tests` to inspect specific tests' instructions - always pass every slug you need to read in a single call.";
    }

    prompt += "\n\nAnalyze the diff and take appropriate actions using the available tools. When done, call `finish`.";

    return prompt;
}

export const DIFFS_SYSTEM_PROMPT = `You are a QA engineer that analyzes code diffs on pull requests. You have two responsibilities:

## 1. Test Impact Analysis
Identify which existing tests MIGHT be affected by the code changes. Use \`list_tests\` to browse tests by flow and \`read_tests\` to inspect test instructions - always pass every slug you want to read in a single \`read_tests\` call rather than calling the tool once per slug. Use \`mark_affected_test\` for each test that could be impacted. Be thorough but not overly broad - only mark tests whose flows directly touch the changed code.

\`mark_affected_test\` is ONLY for tests you identified yourself from the diff (they will be recorded with \`affectedReason: code_change\`).

Tests listed under "Pre-classified merge conflicts" are already recorded with \`affectedReason: merge_conflict\`; for each of them call \`explain_merge_conflict\` with a reasoning that explains how the plans diverge. Do NOT call \`mark_affected_test\` for those slugs.

Tests whose plans were imported from a merge source are handled deterministically outside the agent and are intentionally excluded from the Existing Tests list. Do not try to rediscover them.

Consider a test affected if the diff:
- Changes UI elements or flows the test exercises
- Modifies routes, URLs, or navigation the test relies on
- Alters validation logic, form behavior, or API responses the test checks
- Deletes or renames features the test covers
- Changes copy/labels the test asserts on

### Dependency and lockfile changes
A change confined to dependency manifests and lockfiles (\`package.json\`, \`package-lock.json\`, \`yarn.lock\`, \`pnpm-lock.yaml\`, \`bun.lock\`, \`go.mod\`, \`requirements.txt\`, \`Gemfile.lock\`, ...) is a version bump, not a behavior change you can read off the diff. A dependency being widely used or "core" - auth, payments, the framework, the ORM - is NOT a reason to select tests: that is the "shares a subsystem" fallacy, the same one that turns any change into a reason to run everything. Use the version change as your bar. A patch or minor bump is backward-compatible by semver contract - bug fixes or additive features, not changes to behavior existing tests exercise - so it selects NOTHING, however heavily the app leans on the library; the app merely depending on a dependency is not a mechanism. Only a MAJOR-version bump, or a specific known breaking change you can name, can put a test at risk - and then only the tests whose covered code path uses the changed behavior, named in the reasoning. A dev-dependency, a transitive/lockfile-only resolution, and every patch/minor affect no tests: mark none, author none, and say so in your finish reasoning. Never smoke-test "the whole X layer" because the bumped library is important - "X is core, so re-run its flows" is not a named mechanism. A grouped or multi-package update (a dependabot "group", a lockfile touching many packages) is judged member by member, NOT by the size of the group: assess each bumped dependency against its own version change, select only for the specific members that carry a named breaking mechanism, and treat the patch/minor and dev-dependency members as the no-ops they are. A bundle of small bumps is not a big change, and "the group is large / its collective impact is significant" is not a mechanism.

Tests will be automatically run and reviewed after your analysis completes - you do not need to run them yourself.

## 2. Test Gap Detection
Identify new functionality that has no test coverage and author a test for it with \`create_test\`. Focus on user-facing behavior introduced by the diff.

You are the sole author of new tests in this flow. Each \`create_test\` mints a real test immediately (test case + plan + a pending generation); it is then generated and run alongside the affected tests. There is **no later review gate** that culls a redundant-but-passing test, so:

- **Only author tests you are confident are real, non-redundant flows.** When in doubt, do not create the test.
- **Write the complete, generation-ready plan body** in \`plan\` - the full instructions a generator turns into steps, not a high-level summary. There is no later step that fills in the details.
- **Write the description (intent).** Every \`create_test\` requires a \`description\`: the test's durable intent - a specific, falsifiable claim about what the feature does (what the user does, what should happen, and why it matters). This is persisted as the test's immutable description and must stand on its own, independent of any other test.
- **Justify coverage separately.** Every \`create_test\` also requires a \`coverageJustification\`, which is distinct from the description: it is the creation-time dedup gate. Browse the suite first with \`list_tests\` / \`read_tests\`, then name the closest existing tests and explain what behavior this test exercises that they do not. It is discarded after authoring and is never persisted.
- **Bind a scenario when needed.** If the test depends on seeded preconditions (an authenticated user, pre-existing records), pick a \`scenarioId\` via \`list_scenarios\` / \`read_scenario\`; omit it for tests that start from a fresh, unauthenticated state.

## Available Tools

### Codebase exploration
- \`bash\`: read-only shell access to the source tree - git (\`git diff\`, \`git log\`, \`git show\`), search (\`rg\`), file reads (\`cat\`, \`sed -n '<start>,<end>p'\`), and listing (\`ls\`, \`find\`). See the tool description for the allowed verbs and grammar.
- \`subagent\`: spawn a focused research subagent to investigate a specific area

### Test discovery
- \`list_tests\`: list tests in a specific flow (folder) - returns the slug, name and description of each test
- \`read_tests\`: read one or more tests' description and full instructions by slug. Always pass every slug you need in a single \`slugs\` array.

### Scenarios (test data environments)
- \`list_scenarios\`: list the named test data environments (id, name, description) available for this application
- \`read_scenario\`: inspect a single scenario's seeded data in detail. Use these to pick a \`scenarioId\` when a test you create needs seeded preconditions.

### Scenario recipes (test data templates)
- \`read_scenario_recipe_entities\`: when the prompt includes a "Scenario Recipes" section, read the full records a scenario's recipe declares for one entity type. This is the data each scenario is *designed to seed* (a template), NOT the data of any single past run - analysis runs before any replay. Use it to judge whether a diff changes the shape of data a test depends on. Only available when the tests in scope reference scenarios with a recipe.

### Actions
- \`mark_affected_test\`: flag a test as potentially affected by the changes (must use exact slug, records as \`code_change\`)
- \`explain_merge_conflict\`: attach reasoning to a pre-classified merge-conflict test (slug must be listed in "Pre-classified merge conflicts")
- \`create_test\`: author a new test for uncovered functionality (mints the test immediately; requires a coverage justification)
- \`finish\`: call when done with your analysis

## Workflow
1. Use \`bash\` with git commands to explore the actual diff and understand what changed - the task gives you the PR's commit range; use it verbatim rather than guessing one from \`HEAD~1\` or a branch name
2. Read relevant source files to understand the changes in context - \`cat\` the paths you need (pass several at once) or \`sed -n '<start>,<end>p'\` for slices
3. Browse the test flows using \`list_tests\` to understand what tests exist
4. Identify potentially affected tests by passing every candidate slug to \`read_tests\` in one call, then \`mark_affected_test\` for each affected one
5. Identify test gaps and author new tests with \`create_test\` - browse the suite first to ground the coverage justification, and bind a \`scenarioId\` when the test needs seeded data
6. Call \`finish\` with your overall reasoning - even if no actions were needed (e.g. pure refactors), explain why`;

/** Base==head is a real case - a same-head run answering pending events - not an error. */
function renderRangeSection(range: { baseSha: string; headSha: string }): string {
    if (range.baseSha === range.headSha) {
        return `## Reading the change
This run has NO commit range: base and head are the same commit (\`${range.headSha}\`), so there is no new diff to read. The run exists because of its triggering events (below) - judge impact from those events and the current state of the code, and do not hunt for a patch.`;
    }
    return `## Reading the change
This PR's commit range is \`${range.baseSha}..${range.headSha}\`. Use these SHAs verbatim - the clone is checked out at the head and the base has NO branch name, so \`HEAD~1\`, \`origin/main\` and a merge-base all silently give you a fraction of a multi-commit PR.

Explore the patch yourself with \`bash\`, scoping to what you need rather than pulling it whole:
- \`git diff ${range.baseSha}..${range.headSha} --stat\` for the full file list with change magnitude
- \`git diff ${range.baseSha}..${range.headSha} -- <path>\` for one file or directory
- \`git log ${range.baseSha}..${range.headSha} --name-only\` for which commit touched what`;
}

/**
 * The scoped presentation: the subject commits (the branch's own unassessed content) with per-commit read
 * commands, followed by the ledger of everything subtracted - inherited, replayed, clean merges - so the
 * exclusion is visible rather than silent.
 */
function renderSubjectSection(
    subject: RunSubject,
    range: { baseSha: string; headSha: string },
    directed: boolean,
): string {
    const ledgerLines = renderLedger(subject);

    if (subject.commits.length === 0) {
        const subtractedSomething =
            subject.ledger.inheritedCount > 0 || subject.ledger.replayedCount > 0 || subject.ledger.cleanMergeCount > 0;
        if (!subtractedSomething) {
            return `## Reading the change
This run has NO new commits: the head (\`${range.headSha}\`) brings nothing that is not already analyzed, so there is no new diff to read. The run exists because of its triggering events (below) - judge impact from those events and the current state of the code, and do not hunt for a patch.`;
        }
        // A pushes-only empty-subject run never reaches the agent (skipSelectionForEmptySubject answers it
        // deterministically), so the directed branch is the one production renders; the other is the honest
        // fallback for a direct invocation.
        const job = directed
            ? `This run exists to serve its claimed non-push events - the directives and any other occurrences rendered in this prompt. They are its ENTIRE job. Serve each with what it asks for: one that asks to re-check existing behavior selects its existing tests; only one that asks for new coverage authors a new test. Select NOTHING beyond them: there is no diff to read, the branch's standing content was already assessed by earlier completed runs, and inherited changes are the target pipeline's responsibility.`
            : `There is no diff to read and no event to serve: mark no tests and create none, and explain why in your finish reasoning. The branch's standing content was already assessed by earlier completed runs, and inherited changes are the target pipeline's responsibility.`;
        return `## Reading the change
This push brought NOTHING this branch owns: every commit in the range was inherited from the target branch (an "update branch" merge or rebase) or replays content an earlier completed run already analyzed.
${ledgerLines}
${job}`;
    }

    const commitLines = subject.commits
        .map((commit) => {
            const marker =
                commit.conflictResolution != null ? " (merge - only its conflict resolutions are owned here)" : "";
            return `- \`${commit.sha}\` ${commit.subject}${marker}`;
        })
        .join("\n");
    const conflictStats = subject.commits
        .filter((commit) => commit.conflictResolution != null)
        .map((commit) => `\nConflict resolutions in \`${commit.sha}\`:\n${commit.conflictResolution?.stat ?? ""}`)
        .join("");
    const ownedRange =
        subject.ownedBaseSha != null
            ? `\n- \`git diff ${subject.ownedBaseSha} ${range.headSha}\` for the branch's WHOLE owned patch (all its commits vs the target)`
            : "";

    return `## Reading the change
This run's subject is the branch's own unassessed content - the commits below, oldest first. Changes inherited from the target branch or replayed by a rebase are deliberately NOT part of the subject (they are accounted for underneath).

${commitLines}
${conflictStats}
Read them yourself with \`bash\`, using these SHAs verbatim (the clone is checked out at the head and no other ref has a branch name):
- \`git show <sha>\` for one commit's full patch, \`git show <sha> --stat\` for its shape
- \`git diff <sha>^ <sha> -- <path>\` for one file of one commit${ownedRange}
${ledgerLines}`;
}

/** The subtraction ledger, one line per non-zero count; `""` when nothing was subtracted. */
function renderLedger(subject: RunSubject): string {
    const lines: string[] = [];
    if (subject.ledger.inheritedCount > 0) {
        lines.push(
            `- ${subject.ledger.inheritedCount} commit(s) inherited from the target branch via merge - already the target pipeline's responsibility (context below)`,
        );
    }
    if (subject.ledger.replayedCount > 0) {
        lines.push(
            `- ${subject.ledger.replayedCount} commit(s) replayed by a rebase/force-push - their content was already analyzed under previous SHAs`,
        );
    }
    if (subject.ledger.cleanMergeCount > 0) {
        lines.push(
            `- ${subject.ledger.cleanMergeCount} clean merge commit(s) - nothing hand-authored beyond the automatic merge`,
        );
    }
    if (lines.length === 0) return "";
    return `\nExcluded from the subject:\n${lines.join("\n")}\n`;
}

/**
 * What the target branch contributed within this range - context for interference, never a subject. Collapses
 * to `""` when nothing was inherited.
 */
function renderInheritedSection(subject: RunSubject): string {
    if (subject.ledger.inheritedCount === 0) return "";
    const stat =
        subject.inheritedStat != null && subject.inheritedStat.trim() !== ""
            ? `\n\n\`\`\`\n${truncate(subject.inheritedStat.trim(), MAX_INHERITED_STAT_CHARS)}\n\`\`\``
            : "";
    return (
        "## Inherited from the target branch (context, NOT subject)\n" +
        "What the target branch contributed within this range. It was (or will be) analyzed by the target's own " +
        "pipeline, so DO NOT select a test because of an inherited change on its own. An inherited change justifies " +
        "a selection ONLY when it directly touches the same files or call sites as the branch's owned patch - name " +
        "that intersection in the reasoning. Sharing a vendor, subsystem or theme with the branch's content is NOT " +
        'interference, and "X may affect Y" without a named intersection is not either.' +
        stat
    );
}

/** `commits_pushed` is fully answered by the subject computation; every other event type is a job of its own. */
function hasNonPushEvents(events: ResolvedAnalysisEvent[]): boolean {
    return events.some((event) => event.type !== "commits_pushed");
}

/**
 * The user-prompt directives this run claimed. Collapses to `""` when the run claimed no directive, so a
 * directive-less run's prompt is byte-identical.
 */
function renderDirectives(events: ResolvedAnalysisEvent[]): string {
    const directives = events.flatMap((event) => (event.type === "user_prompt" ? [event] : []));
    if (directives.length === 0) return "";
    const lines = directives
        .map((event) => `- [${event.createdAt.toISOString()}, from ${event.payload.author}] ${event.payload.text}`)
        .join("\n");
    return (
        "## Directives - HIGHEST PRIORITY\n" +
        "Instructions a person or agent addressed to THIS analysis, oldest first. They OUTRANK the diff below: the " +
        "diff is the ground truth of what the code is; a directive is what you were asked to do about it. Your " +
        "selection MUST serve each directive, or your finish reasoning MUST say why it cannot.\n\n" +
        "Serve a directive that asks for COVERAGE - a flow to re-check, a risk to exercise - by selecting (or " +
        "authoring) the tests it points at. A directive that asks you to EDIT the suite itself (rewrite a plan, " +
        "delete a test, change an existing test) is OUT OF SCOPE for this stage today: do NOT misread it as a " +
        "selection hint and do NOT act on it - select on the code as usual and note in your reasoning that the run " +
        "can only re-analyze, not edit. The report then answers the person honestly.\n\n" +
        lines
    );
}

/**
 * The movement events this run claimed (pushes), oldest first. Collapses to `""` when the run claimed no push, so
 * an event-less run's prompt is byte-identical.
 */
function renderMovementEvents(events: ResolvedAnalysisEvent[]): string {
    const pushes = events.flatMap((event) => (event.type === "commits_pushed" ? [event] : []));
    if (pushes.length === 0) return "";
    const lines = pushes
        .map((event) => {
            const base = event.payload.baseSha != null ? `, base \`${event.payload.baseSha}\`` : "";
            return `- ${event.createdAt.toISOString()} [${event.source}] commits pushed: head \`${event.payload.headSha}\`${base}`;
        })
        .join("\n");
    return (
        "## Triggering events\n" +
        "The recorded pushes this run is answering, oldest first. The diff is the ground truth for what the code " +
        "looks like NOW; the events are the record of how and why it got there. Use them to understand the " +
        "branch's movement - a push burst, a rebase, a force push - and never count a change twice because it " +
        "shows up both in the diff and in an event.\n\n" +
        `${lines}\n\n` +
        "A recorded head that is not an ancestor of the current head means the branch was rebased or force-pushed: " +
        "the range diff then mixes the PR's own changes with replayed history, so use the recorded heads to tell " +
        "them apart. A recorded sha may or may not still be present in the clone - check with " +
        "`git cat-file -e <sha>` before diffing against one."
    );
}

/**
 * The branch's prior-analysis history, framed as work already done - NOT as verdicts to reproduce. Each subsection
 * is rendered only when it has rows, and the whole block collapses to `""` when the branch has no history at all,
 * so a brand-new branch's prompt is byte-identical to a stateless run's. The priming guard is deliberate: the
 * heading and lead-ins tell the agent this is prior work to avoid duplicating, never an expected finding to chase.
 */
function renderBranchHistory(history: BranchHistory): string {
    const sections: string[] = [];

    if (history.removedTests.length > 0) {
        const rows = history.removedTests
            .map((t) => `- **${t.name}** (\`${t.slug}\`)${t.reason != null ? `: ${t.reason}` : ""}`)
            .join("\n");
        sections.push(
            "### Tests already removed as invalid - do NOT re-create these\n" +
                "Each was authored on an earlier run and then removed because a prior analysis judged its target " +
                "feature/flow does not exist, so it can never pass. They are deliberately absent from the Existing " +
                "Tests list. Do not author a new test for the same behavior - only re-create one if THIS diff " +
                "genuinely reintroduces the feature, and say so in your reasoning when you do.\n" +
                rows,
        );
    }

    if (history.openIssues.length > 0) {
        const rows = history.openIssues
            .map((issue) => {
                const covers = issue.coveredSlugs.length > 0 ? ` (covered by: ${issue.coveredSlugs.join(", ")})` : "";
                return `- **${issue.title}** - ${issue.actualBehavior}${covers}`;
            })
            .join("\n");
        sections.push(
            "### Open issues on this branch (known problem areas)\n" +
                "Problems earlier runs already recorded on this branch. Their covering tests are re-verified " +
                "automatically, so you do NOT need to reproduce or re-cover them - use these only to understand " +
                "where the branch has been fragile when weighing what the diff affects.\n" +
                rows,
        );
    }

    if (history.priorReports.length > 0) {
        const rows = history.priorReports
            .map((r) => `#### Report for ${r.snapshotId}\n${truncate(r.report, MAX_PRIOR_REPORT_CHARS)}`)
            .join("\n\n");
        sections.push(
            "### Recent reports on this branch (for continuity)\n" +
                "The prior runs' holistic narratives, newest first - background on what this branch is doing and " +
                "what has been going wrong. Not a checklist.\n" +
                rows,
        );
    }

    if (sections.length === 0) return "";
    return (
        "## Branch history (prior analysis of THIS branch)\n" +
        "What earlier runs of this branch already did - context so you do not repeat work, NOT verdicts to " +
        "reproduce. The diff and the current suite remain the authority on what to select.\n\n" +
        sections.join("\n\n")
    );
}

/**
 * The changed paths, capped. The full list is one `git diff --stat` away and the agent is told the range, so
 * the prompt carries enough to orient a reader and no more - an uncapped join put every path of a
 * lockfile-regen or generated-client PR into the context before the agent had done anything.
 */
function listAffectedFiles(files: string[]): string {
    if (files.length === 0) return "(no files changed in this range)";
    const listed = files.slice(0, MAX_LISTED_FILES).join("\n");
    if (files.length <= MAX_LISTED_FILES) return listed;
    return `${listed}\n... and ${files.length - MAX_LISTED_FILES} more (${files.length} changed in total - use \`git diff --stat\` below for the rest)`;
}
