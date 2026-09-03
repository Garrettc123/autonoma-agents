import {
  type AnalysisFlow,
  type AnalysisVerdictSummary,
  analysisFlowPillLabel,
  analysisFlowPillNamesFlows,
  analysisPrTitle,
  tallyAnalysisFlows,
} from "@autonoma/types";
import { VerdictHeadline } from "components/analysis/verdict-headline";

/**
 * The "flow" unit, defined on hover of the verdict badge. Deliberately a definition only - it must never grow
 * verified / couldn't-confirm counts, which the report card's per-flow list already carries.
 */
const FLOW_DEFINITION =
  "A flow is a recognizable user journey this PR touches - each one groups several underlying checks.";

/**
 * How the PR reads, as a whole - the Reporter's own words over the branch's cumulative state.
 *
 * Both strings are authored, because a PR that verified six flows of seven has no honest two-word verdict; what a
 * reader needs is which parts are covered and which are not. The state is resolved by the server's ledger and the
 * badge is derived from the flow tally, so the colour and the ratio can never be talked into disagreeing with the
 * evidence.
 */
export function AnalysisPrIssuesHeadline({
  verdict,
  title,
  headline,
  flows,
}: {
  /** What the PR reads as, resolved by the server's ledger from the same flows rendered below. */
  verdict: AnalysisVerdictSummary;
  /** The Reporter's title. Empty on a report written before the Reporter authored one. */
  title: string;
  /** The Reporter's headline - always present, since a report exists only once one was authored. */
  headline: string;
  flows: AnalysisFlow[];
}) {
  const bugCount = verdict.bugCount;
  const tally = tallyAnalysisFlows(flows);
  // The definition only rides the pill that names the unit; the bug and no-tests-needed pills stay plain.
  const flowTooltip = analysisFlowPillNamesFlows(tally, bugCount) ? FLOW_DEFINITION : undefined;

  return (
    <VerdictHeadline
      state={verdict.state}
      badge={analysisFlowPillLabel(verdict.state, tally, bugCount)}
      badgeTooltip={flowTooltip}
      title={analysisPrTitle(title, verdict.state, bugCount)}
    >
      {headline}
    </VerdictHeadline>
  );
}
