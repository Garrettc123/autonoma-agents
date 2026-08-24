import { Badge, cn, StatusDot, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import {
  type AnalysisFlow,
  type AnalysisVerdictState,
  type AnalysisVerdictSummary,
  analysisFlowPillLabel,
  analysisPrTitle,
  tallyAnalysisFlows,
} from "@autonoma/types";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { VERDICT_TONE } from "components/analysis/verdict-headline";
import type * as React from "react";

type DotStatus = NonNullable<React.ComponentProps<typeof StatusDot>["status"]>;

/**
 * The banner's tinted hero background per status tone - a border + wash of the same `status-*` colour the dot and
 * badge carry. Keyed by `DotStatus` and read off the SSOT `VERDICT_TONE` dot, so the tint can never disagree with
 * the tone beside it; `neutral` is unreachable from any verdict state today but keeps the record exhaustive.
 */
const STATUS_TINT: Record<DotStatus, string> = {
  critical: "border-status-critical/40 bg-status-critical/5",
  warn: "border-status-warn/40 bg-status-warn/5",
  success: "border-status-success/40 bg-status-success/5",
  neutral: "border-border-dim bg-surface-base",
};

/**
 * Plain-language explanation of what each verdict means - the (i) hover copy, and the banner's ONLY per-state data.
 * The dot, badge tone and tint all derive from the shared `VERDICT_TONE`; a new state is a compile error here (its
 * description) and there (its tone), never a silently-stale colour.
 */
const VERDICT_DESCRIPTION: Record<AnalysisVerdictState, string> = {
  bug_found:
    "Autonoma reproduced at least one bug this PR introduces. These block the PR - open an issue for the evidence and a fix.",
  not_confirmed:
    "No bug was reproduced, but some checks couldn't be completed, so this change wasn't fully confirmed. Review what's still unverified below.",
  no_tests_needed:
    "Impact analysis reviewed this diff and decided it needed no test - nothing existing was affected, and no new one was worth authoring.",
  healthy: "Autonoma exercised the flows this PR touches and the app held up. Nothing to fix here.",
};

/**
 * The PR overview hero: a colored verdict banner answering "did my PR break anything?" at a glance. The state's
 * tint and dot, the compressed verdict badge (with an (i) explaining what the verdict means), the Reporter's
 * one-paragraph headline - the only always-visible prose on the page - and the three counts a reader scans first:
 * open issues, flows covered, tests run.
 *
 * The badge label and title come from the shared `@autonoma/types` helpers, so the banner can never word the same
 * verdict differently from the header pill or the GitHub comment.
 */
export function VerdictBanner({
  verdict,
  title,
  headline,
  flows,
  openIssueCount,
  testsRunCount,
}: {
  verdict: AnalysisVerdictSummary;
  title: string;
  headline: string;
  flows: AnalysisFlow[];
  openIssueCount: number;
  testsRunCount: number;
}) {
  const tone = VERDICT_TONE[verdict.state];
  const tally = tallyAnalysisFlows(flows);
  const badgeLabel = analysisFlowPillLabel(verdict.state, tally, verdict.bugCount);
  const resolvedTitle = analysisPrTitle(title, verdict.state, verdict.bugCount);

  return (
    <section className={cn("flex flex-col gap-4 border px-5 py-5", STATUS_TINT[tone.dot])}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={tone.variant} className="gap-1 font-mono uppercase tracking-wider">
          <StatusDot status={tone.dot} />
          {badgeLabel}
        </Badge>
        <VerdictStateInfo description={VERDICT_DESCRIPTION[verdict.state]} />
      </div>

      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-text-primary">{resolvedTitle}</h2>
        <p className="mt-1.5 text-sm text-text-secondary">{headline}</p>
      </div>

      <VerdictCounts openIssueCount={openIssueCount} flowsCovered={tally.total} testsRunCount={testsRunCount} />
    </section>
  );
}

/** The (i) that explains what the banner's verdict state means. */
function VerdictStateInfo({ description }: { description: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="What this verdict means"
            className="flex items-center text-text-secondary opacity-60 transition-opacity hover:opacity-100"
          >
            <InfoIcon size={14} />
          </button>
        }
      />
      <TooltipContent className="max-w-xs normal-case">{description}</TooltipContent>
    </Tooltip>
  );
}

function VerdictCounts({
  openIssueCount,
  flowsCovered,
  testsRunCount,
}: {
  openIssueCount: number;
  flowsCovered: number;
  testsRunCount: number;
}) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-3 border-t border-border-dim/60 pt-4">
      <VerdictCount value={openIssueCount} label={openIssueCount === 1 ? "open issue" : "open issues"} />
      <VerdictCount value={flowsCovered} label={flowsCovered === 1 ? "flow covered" : "flows covered"} />
      <VerdictCount value={testsRunCount} label={testsRunCount === 1 ? "test run" : "tests run"} />
    </div>
  );
}

function VerdictCount({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl font-semibold leading-none tabular-nums text-text-primary">{value}</span>
      <span className="font-mono text-2xs uppercase tracking-wider text-text-secondary">{label}</span>
    </div>
  );
}
