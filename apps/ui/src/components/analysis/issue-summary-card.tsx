import { Badge } from "@autonoma/blacklight";
import type { AnalysisIssueSummary } from "@autonoma/types";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { BadgeLabel } from "components/analysis/badge-label";
import { HintBadge } from "components/analysis/hint-badge";
import {
  analysisIssueKindMeta,
  analysisIssueOwnerMeta,
  analysisIssueSeverityMeta,
  type IssueKindMeta,
} from "components/analysis/issue-meta";
import { OwnerBadge } from "components/analysis/owner-badge";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * One issue rendered visual-first: a bold severity chip and an owner icon lead the card, with the title on a
 * secondary line beneath them. The kind and owner badges each reveal a plain-language explanation on hover (the
 * terms clients most often misread), sourced from the shared issue meta maps - the badge itself is the tooltip
 * trigger, so there's no separate (i) affordance.
 *
 * The whole card links to the PR-level issue-detail route (issues are branch-scoped, so the route lives above
 * snapshots). The link is an overlay so the hoverable badges can receive pointer events (`pointer-events-auto`)
 * without their hover being swallowed by the anchor. Shared by the PR open-issues list and the snapshot per-job
 * issue-set changes.
 */
export function IssueSummaryCard({ issue, prNumber }: { issue: AnalysisIssueSummary; prNumber: number }) {
  const kindMeta = analysisIssueKindMeta(issue.kind);
  const severityMeta = analysisIssueSeverityMeta(issue.severity);
  const ownerMeta = analysisIssueOwnerMeta(issue.kind);

  return (
    <li className="relative rounded-lg border border-border-dim bg-surface-void transition-colors hover:border-border-mid hover:bg-surface-raised">
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
        params={{ prNumber, issueId: issue.id }}
        aria-label={issue.title}
        className="absolute inset-0 rounded-lg"
      />
      <div className="pointer-events-none relative flex items-center gap-3 px-4 py-3">
        {issue.thumbnailUrl != null ? (
          <img
            src={issue.thumbnailUrl}
            alt=""
            className="h-12 w-20 shrink-0 rounded border border-border-mid object-cover"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={severityMeta.variant} className="font-mono uppercase">
              <BadgeLabel>{severityMeta.label}</BadgeLabel>
            </Badge>
            <IssueKindBadge meta={kindMeta} />
            <OwnerBadge meta={ownerMeta} className="ml-auto" />
          </div>
          <p className="mt-1.5 truncate text-xs text-text-secondary">{issue.title}</p>
          {issue.runCount > 0 && (
            <p className="truncate font-mono text-2xs text-text-secondary">
              seen in {issue.runCount} {issue.runCount === 1 ? "run" : "runs"}
            </p>
          )}
        </div>
        <CaretRightIcon size={14} className="shrink-0 text-text-secondary" />
      </div>
    </li>
  );
}

function IssueKindBadge({ meta }: { meta: IssueKindMeta }) {
  return (
    <HintBadge hint={meta.description} variant={meta.variant} className="gap-1 font-mono uppercase">
      <BadgeLabel>{meta.label}</BadgeLabel>
    </HintBadge>
  );
}
