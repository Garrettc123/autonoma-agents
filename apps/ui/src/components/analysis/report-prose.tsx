import { Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import type { AnalysisFindingView, ResolvedEvidenceAsset } from "@autonoma/types";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

/**
 * The Reporter's holistic PR report prose - the hero of the PR page's "Full report" drawer and the snapshot per-job
 * view. Renders the Markdown with its inline tokens resolved: `evidence:<assetId>` images against the report's signed
 * evidence, and `issue:<id>` / `finding:<slug>` links against this PR's known issues and this report's findings. A
 * token that references an unknown id/slug renders as plain text (a fabricated reference resolves to nothing).
 *
 * The `bare` variant returns just the resolved markdown, for the PR overview's "Full report" drawer which supplies
 * its own header and scroll chrome; the default `panel` variant wraps it as the snapshot per-job view's "Report" panel.
 */
export function AnalysisReportProse({
  markdown,
  evidence,
  prNumber,
  snapshotId,
  findings,
  issueIds,
  variant = "panel",
}: {
  markdown: string;
  evidence: ResolvedEvidenceAsset[];
  prNumber: number;
  snapshotId: string;
  findings: AnalysisFindingView[];
  /** The ids of issues this PR knows about, so a token to a real issue links and a fabricated one stays text. */
  issueIds: ReadonlySet<string>;
  /** `bare` renders only the resolved markdown (the drawer supplies its own chrome); `panel` wraps it in a "Report" panel. */
  variant?: "panel" | "bare";
}) {
  // The Reporter writes `finding:<slug>` tokens because slugs are what it reasons in; the route is keyed on the
  // finding's own id, so resolve one to the other here.
  const findingIdBySlug = new Map(findings.map((finding) => [finding.slug, finding.id]));

  const renderIssueLink = (issueId: string, children: ReactNode): ReactNode => {
    if (!issueIds.has(issueId)) return children;
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
        params={{ prNumber, issueId }}
        className="text-primary hover:underline"
      >
        {children}
      </AppLink>
    );
  };

  const renderFindingLink = (slug: string, children: ReactNode): ReactNode => {
    const findingId = findingIdBySlug.get(slug);
    if (findingId == null) return children;
    return (
      <AppLink
        to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId"
        params={{ prNumber, snapshotId, findingId }}
        className="text-primary hover:underline"
      >
        {children}
      </AppLink>
    );
  };

  const body = (
    <ReasoningMarkdown
      content={markdown}
      evidence={evidence}
      renderIssueLink={renderIssueLink}
      renderFindingLink={renderFindingLink}
    />
  );

  if (variant === "bare") {
    return body;
  }

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Report</PanelTitle>
      </PanelHeader>
      <PanelBody>{body}</PanelBody>
    </Panel>
  );
}
