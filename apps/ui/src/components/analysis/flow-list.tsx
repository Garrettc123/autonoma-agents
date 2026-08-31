import type { Badge } from "@autonoma/blacklight";
import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import {
  type AnalysisFindingView,
  type AnalysisFlow,
  type AnalysisFlowStatus,
  analysisFindingSortKey,
  analysisFlowComposition,
} from "@autonoma/types";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { BadgeLabel } from "components/analysis/badge-label";
import { HintBadge } from "components/analysis/hint-badge";
import { OwnerBadge } from "components/analysis/owner-badge";
import { OWNER_META, type OwnerMeta } from "components/analysis/owner-meta";
import { VerdictBadge } from "components/analysis/verdict-badge";
import { InfoHint } from "components/info-hint";
import type * as React from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;

/**
 * THE presentation of each flow status: a human label, a badge tone, and the plain-language `description` the chip
 * reveals on hover. A `Record` over the union, so a new status is a compile error here until it is given all three,
 * and no surface re-derives its own copy.
 */
export const FLOW_STATUS_META: Record<
  AnalysisFlowStatus,
  { label: string; variant: BadgeVariant; description: string }
> = {
  broken: {
    label: "Bug",
    variant: "critical",
    description: "Autonoma reproduced a bug in this flow - a check that should pass fails on this PR.",
  },
  verified: {
    label: "Verified",
    variant: "success",
    description: "Every check covering this flow passed. Autonoma exercised it end to end and the app held up.",
  },
  partial: {
    label: "Partly verified",
    variant: "warn",
    description:
      "Some checks in this flow passed, but at least one couldn't be completed - so the flow isn't fully confirmed.",
  },
  unverified: {
    label: "Not verified",
    variant: "neutral",
    description: "No check could confirm this flow on this run, so Autonoma can't vouch for its current state.",
  },
};

/**
 * Whose a flow's gaps are - the reader's first question, drawn from the shared owner registry so the flows and
 * open-issues lists word the same owner identically. Rendered by the shared {@link OwnerBadge}, so the chip is
 * pixel-identical to the one the open-issues cards show. A flow additionally has a `none` case (no gap, no owner)
 * that shows nothing.
 */
export const FLOW_OWNER_META: Record<AnalysisFlow["owner"], OwnerMeta | undefined> = {
  client: OWNER_META.client,
  autonoma: OWNER_META.autonoma,
  none: undefined,
};

/** What a "flow" is, in the reader's language - the copy behind the (i) on the panel title. */
const FLOW_CONCEPT_HELP =
  'A flow is one piece of your app\'s behaviour - like "Guest checkout" or "Reset password" - that a group of ' +
  "Autonoma's tests covers together. This PR's changes are grouped into the flows they touch.";

/**
 * The branch's flow itemization: which parts of the app this PR has established, and which it has not.
 *
 * Ordered as the Reporter clustered them rather than by severity, because a reader looking for one feature should
 * find it where they last saw it. Every judgement rendered here - the status, the owner, the counts - is derived from
 * the tests each flow cites; the Reporter contributes only the name and the sentence.
 *
 * `findings` are only THIS run's findings; a flow can cite tests carried from an earlier checkpoint whose finding does
 * not live at this snapshot. A flow shows its findings dropdown ONLY when this run resolves every test it cites, so the
 * dropdown always accounts for the full set the cumulative status and composition above are computed from - a
 * partially-carried flow shows no dropdown rather than one whose contents the header would contradict.
 */
export function AnalysisFlowList({ flows, findings }: { flows: AnalysisFlow[]; findings: AnalysisFindingView[] }) {
  if (flows.length === 0) return null;

  const findingBySlug = new Map(findings.map((finding) => [finding.testCase.slug, finding]));

  return (
    <Panel>
      {/* min-h matches the open-issues panel's header so the two read level side by side (that one carries a button,
          this one only text). */}
      <PanelHeader className="min-h-16">
        <PanelTitle>
          Flows tested in this PR
          <InfoHint ariaLabel="What a flow is" className="text-text-secondary">
            {FLOW_CONCEPT_HELP}
          </InfoHint>
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="p-0">
        <ul className="divide-y divide-border-dim">
          {flows.map((flow) => (
            <FlowRow key={flow.title} flow={flow} findings={resolveFlowFindings(flow, findingBySlug)} />
          ))}
        </ul>
      </PanelBody>
    </Panel>
  );
}

/**
 * The findings behind one flow, ordered bugs-first via the shared sort key. Only THIS run's findings resolve (see the
 * component doc): a carried-over slug with no finding this run is dropped, so a flow can render fewer rows than its
 * branch-scoped status counts.
 */
function resolveFlowFindings(
  flow: AnalysisFlow,
  findingBySlug: Map<string, AnalysisFindingView>,
): AnalysisFindingView[] {
  return flow.testSlugs
    .map((slug) => findingBySlug.get(slug))
    .filter((finding): finding is AnalysisFindingView => finding != null)
    .sort((a, b) => analysisFindingSortKey(a.category) - analysisFindingSortKey(b.category));
}

function FlowRow({ flow, findings }: { flow: AnalysisFlow; findings: AnalysisFindingView[] }) {
  const status = FLOW_STATUS_META[flow.status];
  const owner = FLOW_OWNER_META[flow.owner];
  // This panel's whole frame is the PR's cumulative state, so the "carried from an earlier commit" note reads as
  // noise here - keep only the "N of M checks passed" half of the composition.
  const composition = analysisFlowComposition(flow, { includeCarriedNote: false });
  // Every cited test resolved to a finding this run, so the dropdown accounts for the whole set the header counts
  // from. When some are carried over (their findings live at an earlier snapshot), show none rather than a subset
  // the cumulative status/composition would contradict.
  const findingsBackHeader = findings.length > 0 && findings.length === flow.testSlugs.length;

  return (
    <li className="flex flex-col gap-1 px-4 py-3">
      {/* The status chip leads the row inline, so the title starts beside it and long titles wrap underneath the chip
          rather than pushing it onto its own line. The "N of M checks passed" composition trails the title, and the
          owner is pinned right and top-aligned. */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium text-text-primary">
          <HintBadge
            hint={status.description}
            variant={status.variant}
            className="mr-2 align-middle font-mono text-3xs uppercase tracking-wider"
          >
            <BadgeLabel>{status.label}</BadgeLabel>
          </HintBadge>
          {flow.title}
          {composition != null && (
            <span className="ml-2 align-middle font-mono text-3xs font-normal text-text-secondary">{composition}</span>
          )}
        </div>
        {owner != null && <OwnerBadge meta={owner} />}
      </div>
      <p className="text-xs leading-relaxed text-text-secondary">{flow.detail}</p>
      {findingsBackHeader && <FlowFindings findings={findings} />}
    </li>
  );
}

/**
 * The flow's individual checks, collapsed by default. Each row is the terminal verdict of one test the flow cites,
 * linking to its finding page - the evidence, trace and self-heal history behind the one-line judgement above.
 */
function FlowFindings({ findings }: { findings: AnalysisFindingView[] }) {
  return (
    <details className="group mt-1">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 text-text-secondary transition-colors hover:text-text-primary">
        <CaretRightIcon size={11} className="transition-transform group-open:rotate-90" />
        <span className="font-mono text-3xs font-semibold uppercase tracking-widest">
          {findings.length === 1 ? "1 finding" : `${findings.length} findings`}
        </span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-0.5 border-l border-border-dim pl-3">
        {findings.map((finding) => (
          <FlowFindingRow key={finding.id} finding={finding} />
        ))}
      </ul>
    </details>
  );
}

function FlowFindingRow({ finding }: { finding: AnalysisFindingView }) {
  return (
    <li>
      <AppLink
        to="/app/$appSlug/findings/$findingId"
        params={{ findingId: finding.id }}
        className="group/row flex items-center gap-2 py-1 transition-colors hover:text-text-primary"
      >
        <VerdictBadge verdict={finding.category} />
        <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{finding.testCase.name}</span>
        <ArrowUpRightIcon
          size={12}
          className="shrink-0 text-text-secondary transition-colors group-hover/row:text-text-primary"
        />
      </AppLink>
    </li>
  );
}
