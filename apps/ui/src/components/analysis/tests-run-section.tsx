import {
  type AnalysisFindingTier,
  type AnalysisTestRun,
  analysisFindingSortKey,
  analysisFindingTier,
} from "@autonoma/types";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { CollapsiblePanel } from "components/analysis/collapsible-panel";
import { VerdictBadge } from "components/analysis/verdict-badge";
import { TIER_LABEL } from "components/analysis/verdict-meta";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

interface TierGroup {
  tier: AnalysisFindingTier;
  testRuns: AnalysisTestRun[];
}

/**
 * The "Tests run" lens on the PR overview: every test the analysis ran across the PR, one row per test at its
 * last-known verdict, grouped by outcome and collapsed by default so it never competes with the verdict banner and
 * open issues above it. Each row links to that test's result page - the verdict, video, steps and trace behind it.
 *
 * Cumulative across the branch, like the verdict, headline and flows beside it - a test carried unchanged from an
 * earlier commit still appears (which is why the count matches the banner's "tests run", not one run's findings). It
 * is a third lens on the same tests the issues (bugs) and flow itemization read - here grouped by the test's own
 * outcome via the taxonomy's `AnalysisFindingTier` (through the shared sort key), never verdict literals here, so a
 * reader meets the same tests in the same buckets on both this section and the snapshot findings panel.
 */
export function AnalysisTestsRunSection({ testRuns }: { testRuns: AnalysisTestRun[] }) {
  // No tests ran - the banner already states that, so this lens adds nothing and is omitted rather than empty-stated.
  if (testRuns.length === 0) return null;

  const groups = groupByTier(testRuns);

  return (
    <CollapsiblePanel title="Tests run" count={testRuns.length} bodyClassName="p-0">
      {groups.map((group) => (
        <TierGroupSection key={group.tier} group={group} />
      ))}
    </CollapsiblePanel>
  );
}

/**
 * Fold the test runs into outcome groups in the taxonomy's own order. Sorting by the shared key first, then merging
 * consecutive same-tier runs, keeps the group order pinned to the sort key with no private tier order to copy.
 */
function groupByTier(testRuns: AnalysisTestRun[]): TierGroup[] {
  const sorted = [...testRuns].sort((a, b) => analysisFindingSortKey(a.category) - analysisFindingSortKey(b.category));
  const groups: TierGroup[] = [];
  for (const testRun of sorted) {
    const tier = analysisFindingTier(testRun.category);
    const last = groups[groups.length - 1];
    if (last?.tier === tier) last.testRuns.push(testRun);
    else groups.push({ tier, testRuns: [testRun] });
  }
  return groups;
}

function TierGroupSection({ group }: { group: TierGroup }) {
  return (
    <div className="border-b border-border-dim last:border-b-0">
      <div className="flex items-center gap-2 bg-surface-void px-5 py-2">
        <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
          {TIER_LABEL[group.tier]}
        </span>
        <span className="font-mono text-2xs text-text-secondary">· {group.testRuns.length}</span>
      </div>
      <ul className="divide-y divide-border-dim/60">
        {group.testRuns.map((testRun) => (
          <TestRunRow key={testRun.id} testRun={testRun} />
        ))}
      </ul>
    </div>
  );
}

function TestRunRow({ testRun }: { testRun: AnalysisTestRun }) {
  return (
    <li>
      <AppLink
        to="/app/$appSlug/findings/$findingId"
        params={{ findingId: testRun.id }}
        className="group/row flex items-center gap-2 px-5 py-2 transition-colors hover:bg-surface-raised"
      >
        <VerdictBadge verdict={testRun.category} />
        <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{testRun.testCase.name}</span>
        <ArrowUpRightIcon
          size={12}
          className="shrink-0 text-text-secondary transition-colors group-hover/row:text-text-primary"
        />
      </AppLink>
    </li>
  );
}
