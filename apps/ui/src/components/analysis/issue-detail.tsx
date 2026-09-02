import { Badge, Separator, Skeleton, cn } from "@autonoma/blacklight";
import type { AnalysisIssueCoveredTest, AnalysisIssueDetail } from "@autonoma/types";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { IssueBackLink } from "components/analysis/issue-back-link";
import {
  analysisIssueKindMeta,
  analysisIssueSeverityMeta,
  analysisIssueStatusMeta,
} from "components/analysis/issue-meta";
import { RAIL_FRAME_CLASS, RailPanel } from "components/analysis/rail-panel";
import { ExpectedActualSections } from "components/analysis/verdict-story";
import { CodeBlock } from "components/investigation/code-block";
import { ScreenshotLightbox } from "components/screenshot-lightbox";
import { ReasoningMarkdown } from "components/snapshot/reasoning-block";
import { formatRelativeTime } from "lib/format";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

type PrimaryScreenshot = NonNullable<AnalysisIssueDetail["primaryScreenshot"]>;

/**
 * The full detail page for one branch-scoped analysis issue, laid out like the finding test-result page: a claim
 * column (kind-aware behavior, the grounded narrative, the suspected code-level cause) beside a pinned "proof" rail
 * (the hero screenshot capped so it is never giant, then the distinct tests this issue was seen in). An issue
 * aggregates many findings with no single run, so the finding page's run rail is repurposed as the aggregate's proof.
 *
 * The finding's test-result page is app-scoped (keyed by finding id alone), so a test links whether or not the issue
 * has a PR - an issue on main links its tests and `finding:` tokens just like a PR-scoped one.
 */
export function AnalysisIssueDetail({ issue, prNumber }: { issue: AnalysisIssueDetail; prNumber?: number }) {
  const kindMeta = analysisIssueKindMeta(issue.kind);
  const severityMeta = analysisIssueSeverityMeta(issue.severity);
  const statusMeta = analysisIssueStatusMeta(issue.status);

  // `finding:<slug>` tokens in the narrative link to the newest finding for that test; an unknown slug renders as
  // plain text. The covered-tests list is already one entry per test, so this is a direct slug -> findingId lookup.
  const findingIdBySlug = new Map(issue.coveredTests.map((test) => [test.slug, test.findingId]));
  const renderFindingLink = (slug: string, children: ReactNode): ReactNode => {
    const findingId = findingIdBySlug.get(slug);
    if (findingId == null) return children;
    return (
      <AppLink to="/app/$appSlug/findings/$findingId" params={{ findingId }} className="text-primary hover:underline">
        {children}
      </AppLink>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 text-text-secondary">
        <IssueBackLink prNumber={prNumber} />
        <span className="font-mono text-2xs uppercase tracking-widest">Issue</span>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <header className="flex flex-col gap-3">
            <h1 className="text-2xl font-medium tracking-tight text-text-primary">{issue.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={kindMeta.variant} className="uppercase">
                {kindMeta.label}
              </Badge>
              <Badge variant={severityMeta.variant} className="uppercase">
                {severityMeta.label}
              </Badge>
              <Badge variant={statusMeta.variant} className="uppercase">
                {statusMeta.label}
              </Badge>
              {issue.status === "resolved" && issue.resolvedAt != null && (
                <span className="font-mono text-2xs text-text-secondary">
                  resolved {formatRelativeTime(issue.resolvedAt)}
                </span>
              )}
            </div>
          </header>

          <BehaviorBlock issue={issue} />

          {issue.narrativeMarkdown.trim() !== "" && (
            <Section title="Why this is an issue">
              <ReasoningMarkdown
                content={issue.narrativeMarkdown}
                evidence={issue.evidence}
                renderFindingLink={renderFindingLink}
              />
            </Section>
          )}

          {issue.suspectedCause != null && (
            <>
              <Separator />
              <SuspectedCause cause={issue.suspectedCause} />
            </>
          )}
        </div>

        <IssueRail issue={issue} />
      </div>
    </div>
  );
}

/**
 * The behavior claim, branched on the issue's plane: a `bug` (app-health) gets the Expected/Actual pair, mirroring a
 * `client_bug` finding; a `scenario` or `environment` issue (coverage plane) gets a single "What happened" account
 * from `actualBehavior`, with no Expected - mirroring a coverage-fault finding, which drops expected/actual entirely.
 */
function BehaviorBlock({ issue }: { issue: AnalysisIssueDetail }) {
  if (issue.kind === "bug") {
    return (
      <ExpectedActualSections expected={issue.expectedBehavior} actual={issue.actualBehavior} outcome="divergence" />
    );
  }
  return (
    <Section title="What happened">
      <p className="text-sm leading-relaxed text-text-primary">{issue.actualBehavior}</p>
    </Section>
  );
}

/** The suspected code-level cause: the explanation plus each code reference through the shared CodeBlock (matching the
 * finding page's code evidence), falling back to a plain file:line label for a reference that carries no snippet. */
function SuspectedCause({ cause }: { cause: NonNullable<AnalysisIssueDetail["suspectedCause"]> }) {
  return (
    <Section title="Suspected cause">
      <p className="text-sm leading-relaxed text-text-secondary">{cause.explanation}</p>
      {cause.codeReferences.length > 0 && (
        <div className="flex flex-col gap-2">
          {cause.codeReferences.map((ref, i) =>
            ref.snippet != null && ref.snippet !== "" ? (
              <CodeBlock key={i} code={ref.snippet} file={ref.file} lines={ref.lines} sourceLabel={ref.repo} />
            ) : (
              <p key={i} className="font-mono text-2xs text-text-secondary">
                {ref.repo != null ? `${ref.repo} › ` : ""}
                {ref.file}
                {ref.lines != null ? `:${ref.lines}` : ""}
              </p>
            ),
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * The pinned proof rail: the hero screenshot in a fixed 16:9 frame so a tall capture never renders giant, then the
 * distinct tests this issue was seen in. On wide screens the shared rail frame caps the whole aside at the viewport
 * and the list scrolls in its leftover height; below `lg` that frame drops away, so the list carries its own `60dvh`
 * cap - `dvh` to match the frame's dynamic-viewport math - to keep scrolling within its own frame rather than
 * growing the page.
 */
function IssueRail({ issue }: { issue: AnalysisIssueDetail }) {
  const tests = issue.coveredTests;
  return (
    <aside className={cn("flex flex-col gap-3", RAIL_FRAME_CLASS)}>
      {issue.primaryScreenshot != null && <CappedImage screenshot={issue.primaryScreenshot} />}
      <RailPanel className="max-h-[60dvh] p-2 lg:max-h-none">
        <p className="px-1 pb-2 font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
          Seen in {tests.length} test{tests.length === 1 ? "" : "s"}
        </p>
        {tests.length === 0 ? (
          <p className="px-1 text-sm text-text-secondary">No tests are attributed to this issue yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {tests.map((test) => (
              <CoveredTestRow key={test.findingId} test={test} />
            ))}
          </ul>
        )}
      </RailPanel>
    </aside>
  );
}

/** The hero screenshot in a fixed 16:9 frame, contained so a portrait or oversized capture is letterboxed rather than
 * enlarged - the same treatment the finding page gives its run media. */
function CappedImage({ screenshot }: { screenshot: PrimaryScreenshot }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border-dim bg-surface-void">
      <ScreenshotLightbox
        src={screenshot.url}
        alt="The clearest view of this issue"
        points={screenshot.points.length > 0 ? screenshot.points : undefined}
        className="size-full object-contain"
      />
    </div>
  );
}

/**
 * One row per distinct test the issue covers. The verdict, commit and timestamps vary per run and belong to the
 * per-snapshot timeline the issue header already summarizes (kind, severity, recurrence), so the row shows only the
 * test - the one thing that distinguishes the rows - and links to its result page.
 */
function CoveredTestRow({ test }: { test: AnalysisIssueCoveredTest }) {
  return (
    <li>
      <AppLink
        to="/app/$appSlug/findings/$findingId"
        params={{ findingId: test.findingId }}
        className="flex items-center gap-2 rounded-md border border-border-dim bg-surface-void px-3 py-2 transition-colors hover:border-border-mid hover:bg-surface-raised"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">{test.slug}</span>
        <CaretRightIcon size={12} className="shrink-0 text-text-secondary" />
      </AppLink>
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

export function AnalysisIssueDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-24" />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
