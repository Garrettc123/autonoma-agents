import { Badge, cn, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton, StatusDot } from "@autonoma/blacklight";
import type { AnalysisFlow, AnalysisIssueSummary, AnalysisTestRun, CheckpointTone } from "@autonoma/types";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { ChatCircleIcon } from "@phosphor-icons/react/ChatCircle";
import { GitCommitIcon } from "@phosphor-icons/react/GitCommit";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { useSuspenseQueries } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { AnalysisJobStatus } from "components/analysis/analysis-job-status";
import { AnalyzingBanner } from "components/analysis/analyzing-banner";
import { AnalysisFlowList } from "components/analysis/flow-list";
import { AnalysisOpenIssuesList } from "components/analysis/open-issues-list";
import { ReportDrawer } from "components/analysis/report-drawer";
import { AnalysisTestsRunSection } from "components/analysis/tests-run-section";
import { VerdictBanner } from "components/analysis/verdict-banner";
import { InfoHint } from "components/info-hint";
import { CheckpointSummaryPill } from "components/pr-status/checkpoint-summary-pill";
import { prStatusPresentation } from "components/pr-status/pr-status-presentation";
import { ShaRange } from "components/snapshot/sha-range";
import { CATEGORY, buildSections, type EntryCategory } from "components/snapshot/snapshot-entries";
import { formatRelativeTime } from "lib/format";
import {
  ensureAnalysisIssuesData,
  ensureAnalysisJobData,
  ensureAnalysisReportData,
  ensureBranchByPrData,
  ensureSnapshotHistoryData,
  useAnalysisIssues,
  useAnalysisJob,
  useAnalysisReport,
  useBranchByPr,
  useCheckpointEvents,
  useSnapshotHistory,
} from "lib/query/branches.queries";
import { useCommitFromGitHub } from "lib/query/github.queries";
import { trpc } from "lib/trpc";
import type { RouterOutputs } from "lib/trpc";
import { type ReactNode, Suspense, useMemo, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { ExecutedTestLink } from "../../-components/executed-test-link";
import { formatCheckpointMetrics } from "../../-components/format-checkpoint-metrics";

type Snapshot = RouterOutputs["branches"]["snapshotHistory"][number];
type CheckpointEvent = RouterOutputs["branches"]["checkpointEvents"][number];
type SnapshotDetail = RouterOutputs["branches"]["snapshotDetail"];
type ExecutedTest = SnapshotDetail["executedTests"][number];
type PRExecutedTest = ExecutedTest & { snapshotId: string; category?: EntryCategory };
type PRTestRunSection = { key: string; title: string; entries: PRExecutedTest[] };

const CHECKPOINT_HISTORY_HELP =
  "One analysis of the branch at a specific commit, newest first - so you can see how the verdict changed as you pushed.";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/_tabs/")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    const branch = await ensureBranchByPrData(context.queryClient, app.id, prNumber);
    // Prefetch the latest snapshot's analysis job + report so the authoritative-vs-diffs gate resolves without a
    // client-side waterfall. Both resolve to null for a diffs PR (cheap), leaving today's layout untouched.
    //
    // The issues read is branch-scoped, so it only needs `branch.id` and rides along with the snapshot history
    // instead of waiting behind it - which is what keeps this chain two round trips deep rather than three. It
    // prewarms the issues-first report column so it never suspends once the report lands; empty for a diffs branch.
    const [snapshots] = await Promise.all([
      ensureSnapshotHistoryData(context.queryClient, branch.id),
      ensureAnalysisIssuesData(context.queryClient, branch.id),
    ]);
    // The history is contractually newest-first, so its first element is the branch's latest run.
    const latest = snapshots[0];
    if (latest != null) {
      await Promise.all([
        ensureAnalysisJobData(context.queryClient, latest.id),
        ensureAnalysisReportData(context.queryClient, latest.id),
      ]);
    }
  },
  pendingComponent: OverviewSkeleton,
  component: OverviewTab,
});

function OverviewTab() {
  const { prNumber } = Route.useParams();

  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewContent prNumber={prNumber} />
    </Suspense>
  );
}

function OverviewContent({ prNumber }: { prNumber: number }) {
  const app = useCurrentApplication();
  const { data: branch } = useBranchByPr(app.id, prNumber);
  const { data: snapshots } = useSnapshotHistory(branch.id);
  const latestSnapshot = snapshots[0];

  if (latestSnapshot == null) {
    return (
      <div className="p-6">
        {branch.lastBlockedReason != null ? (
          <BlockedPanel reason={branch.lastBlockedReason} blockedAt={branch.lastBlockedAt} />
        ) : (
          <NoSnapshotsPanel />
        )}
      </div>
    );
  }

  return <PrOverview branchId={branch.id} prNumber={prNumber} snapshots={snapshots} latestSnapshot={latestSnapshot} />;
}

// The overview gate. An authoritative snapshot (the merged pipeline ran on it, so it has an `AnalysisJob`) gets
// the findings-first layout; every other PR - shadow/diffs alike - renders exactly as before. The job also
// distinguishes a still-running authoritative snapshot (no report yet) from a diffs one, which the report-presence
// gate alone cannot.
function PrOverview({
  branchId,
  prNumber,
  snapshots,
  latestSnapshot,
}: {
  branchId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
}) {
  // `analyzed` is the same fork the badge and health beside it came from, so the overview cannot pick a
  // different pipeline than the summary it renders. A payload stale enough to lack the lifecycle falls back.
  const { data: analysisJob } = useAnalysisJob(latestSnapshot.id);

  if (!latestSnapshot.analyzed || analysisJob == null) {
    return <CheckpointsSection prNumber={prNumber} snapshots={snapshots} latestSnapshot={latestSnapshot} />;
  }

  return (
    <AuthoritativePrOverview
      branchId={branchId}
      prNumber={prNumber}
      snapshots={snapshots}
      latestSnapshot={latestSnapshot}
      analysisJob={analysisJob}
    />
  );
}

// The authoritative PR overview: the latest completed report leads with its verdict banner (its full prose a drawer
// off the banner header), then issues, coverage and the tests run. While a run is live the banner becomes an
// "Analyzing..." hero into the checkpoint's staged view; the last settled report stays below it. No live progress
// here - that is the checkpoint page's job.
function AuthoritativePrOverview({
  branchId,
  prNumber,
  snapshots,
  latestSnapshot,
  analysisJob,
}: {
  branchId: string;
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
  analysisJob: NonNullable<RouterOutputs["branches"]["analysisJob"]>;
}) {
  // No `jobStatus`: the PR page does not poll - the analyzing banner sends the reader to the checkpoint to watch.
  const { data: latestReport } = useAnalysisReport(latestSnapshot.id);
  const runInFlight = latestReport == null && analysisJob.status !== "failed";
  // While the latest run is unsettled, show the most recent earlier settled run's report (latest excluded).
  const earlierSettled = latestReport == null ? snapshots.slice(1).find((snapshot) => snapshot.settled) : undefined;
  // Whichever report the left column renders is the one the rail's tests-run mirrors: the latest when settled, else the
  // earlier-settled fallback. Undefined only while a first run analyzes with nothing settled behind it (no tests-run).
  const reportSnapshotId = latestReport != null ? latestSnapshot.id : earlierSettled?.id;

  return (
    <div className="p-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {latestReport != null ? (
            <Suspense fallback={<AuthoritativeReportSkeleton />}>
              <AuthoritativeReportColumn
                branchId={branchId}
                prNumber={prNumber}
                snapshotId={latestSnapshot.id}
                report={latestReport}
              />
            </Suspense>
          ) : runInFlight ? (
            <>
              <AnalyzingBanner
                prNumber={prNumber}
                snapshotId={latestSnapshot.id}
                startedAt={analysisJob.startedAt ?? undefined}
              />
              {earlierSettled != null && (
                <Suspense fallback={<AuthoritativeReportSkeleton />}>
                  <SettledReportColumn branchId={branchId} prNumber={prNumber} snapshotId={earlierSettled.id} />
                </Suspense>
              )}
            </>
          ) : earlierSettled != null ? (
            <Suspense fallback={<AuthoritativeReportSkeleton />}>
              <SettledReportColumn branchId={branchId} prNumber={prNumber} snapshotId={earlierSettled.id} />
            </Suspense>
          ) : (
            <AnalysisJobStatus job={analysisJob} />
          )}
        </div>
        <AuthoritativeRail prNumber={prNumber} snapshots={snapshots} reportSnapshotId={reportSnapshotId} />
      </div>
    </div>
  );
}

// Fetches one snapshot's report and renders the issues-first column, under its own Suspense boundary.
function SettledReportColumn({
  branchId,
  prNumber,
  snapshotId,
}: {
  branchId: string;
  prNumber: number;
  snapshotId: string;
}) {
  const { data: report } = useAnalysisReport(snapshotId);
  if (report == null) return undefined;
  return <AuthoritativeReportColumn branchId={branchId} prNumber={prNumber} snapshotId={snapshotId} report={report} />;
}

// The issues-first report column, split from the overview so it (and its open-issues query) only loads once the
// report has landed - a still-running run never pays for it. Ordered banner -> open issues -> coverage -> impact
// link, leading with the answer; the full report prose is a drawer off the banner and the tests-run lens sits in
// the rail.
function AuthoritativeReportColumn({
  branchId,
  prNumber,
  snapshotId,
  report,
}: {
  branchId: string;
  prNumber: number;
  snapshotId: string;
  report: NonNullable<RouterOutputs["branches"]["analysisReport"]>;
}) {
  const { data: issues } = useAnalysisIssues(branchId);
  // The banner + list surface only the open issues; the token resolver knows every issue id (open + resolved)
  // so a report-prose `issue:` token to a resolved issue still links (a fabricated id stays plain text).
  const openIssues = issues.filter((issue) => issue.status === "open");
  const issueIds = new Set(issues.map((issue) => issue.id));

  return (
    <>
      <VerdictBanner
        verdict={report.verdict}
        title={report.title}
        headline={report.headline}
        flows={report.flows}
        openIssueCount={openIssues.length}
        testsRunCount={report.testRuns.length}
        reportAction={
          report.reportMarkdown != null ? (
            <ReportDrawer
              markdown={report.reportMarkdown}
              evidence={report.reportEvidence}
              prNumber={prNumber}
              findings={report.findings}
              issueIds={issueIds}
            />
          ) : undefined
        }
      />
      <IssuesAndFlows openIssues={openIssues} flows={report.flows} testRuns={report.testRuns} prNumber={prNumber} />
      <LatestSnapshotLink prNumber={prNumber} snapshotId={snapshotId} />
    </>
  );
}

// Open issues ("what's wrong") and the flow coverage ("what was checked") sit side by side so the reader takes in
// both at once. A container query splits them only once the report column is genuinely wide enough for two readable
// panels; below that - or when only one of the two has anything to show - they stack full-width as before. A clean PR
// shows the green banner and its coverage alone, never an empty "Open issues (0)" panel.
function IssuesAndFlows({
  openIssues,
  flows,
  testRuns,
  prNumber,
}: {
  openIssues: AnalysisIssueSummary[];
  flows: AnalysisFlow[];
  testRuns: AnalysisTestRun[];
  prNumber: number;
}) {
  // AnalysisFlowList self-nulls when it has no flows; the open-issues list would instead render an empty-state panel,
  // so that one is guarded here. Built once so the two return branches can't drift as props change.
  const issuesPanel = openIssues.length > 0 ? <AnalysisOpenIssuesList issues={openIssues} prNumber={prNumber} /> : null;
  const flowsPanel = <AnalysisFlowList flows={flows} testRuns={testRuns} />;

  if (issuesPanel != null && flows.length > 0) {
    // `items-start` keeps each panel at its natural height rather than stretching the shorter one to match the
    // taller. A lopsided PR - many issues and few flows, or the reverse - would otherwise inflate the short panel
    // into a large empty bordered box; here the two simply end where their content ends.
    return (
      <div className="@container">
        <div className="grid items-start gap-4 @2xl:grid-cols-2">
          {issuesPanel}
          {flowsPanel}
        </div>
      </div>
    );
  }

  return (
    <>
      {issuesPanel}
      {flowsPanel}
    </>
  );
}

function AuthoritativeReportSkeleton() {
  return (
    <>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-40 w-full" />
    </>
  );
}

// A quiet link to the latest snapshot's report, where the impact-analysis reasoning, findings summary, and test
// suite changes live in full - detail the trimmed PR overview deliberately omits.
function LatestSnapshotLink({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId }}
      className="inline-flex items-center gap-1 self-start font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary"
    >
      View impact analysis and suite changes
      <ArrowRightIcon size={12} />
    </AppLink>
  );
}

// The authoritative overview's right column: the checkpoint history, then the tests-run lens beneath it. It sits at
// its natural height rather than stretching the full page, and the tests-run mirrors whichever report the left column
// shows - absent only while a first run analyzes with nothing settled behind it.
function AuthoritativeRail({
  prNumber,
  snapshots,
  reportSnapshotId,
}: {
  prNumber: number;
  snapshots: Snapshot[];
  reportSnapshotId: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-4 self-start">
      <AuthoritativeCheckpointRail prNumber={prNumber} snapshots={snapshots} />
      {reportSnapshotId != null && (
        <Suspense fallback={<Skeleton className="h-11 w-full" />}>
          <RailTestsRun snapshotId={reportSnapshotId} />
        </Suspense>
      )}
    </div>
  );
}

// The tests-run lens for the report the overview displays. Reads the same cached report query the column already
// holds, so it never costs a second fetch; the section self-nulls when that report has no runs.
function RailTestsRun({ snapshotId }: { snapshotId: string }) {
  const { data: report } = useAnalysisReport(snapshotId);
  if (report == null) return undefined;
  return <AnalysisTestsRunSection testRuns={report.testRuns} />;
}

const CHECKPOINT_TONE_DOT: Record<CheckpointTone, string> = {
  success: "bg-status-success",
  critical: "bg-status-critical",
  warning: "bg-status-warn",
  neutral: "bg-text-secondary",
};
const CHECKPOINT_TONE_TEXT: Record<CheckpointTone, string> = {
  success: "text-status-success",
  critical: "text-status-critical",
  warning: "text-status-warn",
  neutral: "text-text-secondary",
};

// A seat on the spine: a fixed-width slot centred on the rail, unfilled so the line runs continuously behind it.
function SpineNode({ children }: { children: ReactNode }) {
  return <span className="relative z-10 flex size-6 shrink-0 items-center justify-center">{children}</span>;
}

// A same-width invisible seat, so a nodeless row still aligns to the content column.
function SpineSpacer() {
  return <span className="size-6 shrink-0" aria-hidden />;
}

// The checkpoint history: a vertical spine, newest-first. The newest opens by default; the list caps its height and
// scrolls internally so a long history never stretches the rail.
function AuthoritativeCheckpointRail({ prNumber, snapshots }: { prNumber: number; snapshots: Snapshot[] }) {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set(snapshots[0] != null ? [snapshots[0].id] : []));
  function toggle(id: string) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          Checkpoint history
          <InfoHint ariaLabel="What a checkpoint is" className="text-text-secondary">
            {CHECKPOINT_HISTORY_HELP}
          </InfoHint>
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="relative max-h-96 overflow-auto p-0">
        <div className="pointer-events-none absolute inset-y-6 left-7 w-px bg-border-dim" aria-hidden />
        {snapshots.map((snapshot, index) => (
          <AuthoritativeCheckpointItem
            key={snapshot.id}
            prNumber={prNumber}
            snapshot={snapshot}
            isLatest={index === 0}
            open={openIds.has(snapshot.id)}
            onToggle={() => toggle(snapshot.id)}
          />
        ))}
      </PanelBody>
    </Panel>
  );
}

// Earlier checkpoints are dimmed: they are superseded, so a past "N bugs" reads as history, not a live alarm.
function AuthoritativeCheckpointItem({
  prNumber,
  snapshot,
  isLatest,
  open,
  onToggle,
}: {
  prNumber: number;
  snapshot: Snapshot;
  isLatest: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const presentation =
    snapshot.summary != null ? prStatusPresentation({ kind: "checkpoint", summary: snapshot.summary }) : undefined;
  const tone = presentation?.tone ?? "neutral";
  return (
    <div className={cn(!isLatest && "opacity-60")}>
      {/* Row toggles the events; the Details link is layered over the date and revealed on hover/focus, so
          disclosure and navigation never share a click target. */}
      <div className="group relative">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors group-hover:bg-surface-raised"
        >
          <SpineNode>
            <span className={cn("size-3 rounded-full", CHECKPOINT_TONE_DOT[tone])} aria-hidden />
          </SpineNode>
          <CaretRightIcon
            size={12}
            weight="bold"
            className={cn("shrink-0 text-text-secondary transition-transform", open && "rotate-90")}
          />
          <span className={cn("truncate font-mono text-2xs font-bold uppercase", CHECKPOINT_TONE_TEXT[tone])}>
            {presentation?.label ?? "Checkpoint"}
          </span>
          <span className="ml-auto shrink-0 font-mono text-2xs text-text-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
            {isLatest ? "Latest · " : ""}
            {formatRelativeTime(snapshot.createdAt)}
          </span>
        </button>
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
          params={{ prNumber, snapshotId: snapshot.id }}
          className="pointer-events-none absolute top-1/2 right-4 flex -translate-y-1/2 items-center gap-1 font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 hover:text-text-primary focus-visible:pointer-events-auto focus-visible:opacity-100"
        >
          <span className="underline">Details</span>
          <ArrowSquareOutIcon size={12} />
        </AppLink>
      </div>
      {open && (
        <Suspense fallback={<CheckpointEventsSkeleton />}>
          <CheckpointEvents snapshotId={snapshot.id} />
        </Suspense>
      )}
    </div>
  );
}

function CheckpointEvents({ snapshotId }: { snapshotId: string }) {
  const { data: events } = useCheckpointEvents(snapshotId);
  if (events.length === 0) {
    return (
      <div className="flex items-center gap-2.5 px-4 pb-2">
        <SpineSpacer />
        <span className="font-mono text-2xs text-text-secondary">No events recorded.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 pb-2">
      {events.map((event) => (
        <CheckpointEventRow key={event.id} event={event} />
      ))}
    </div>
  );
}

function CheckpointEventRow({ event }: { event: CheckpointEvent }) {
  if (event.type === "commits_pushed") {
    return (
      <div className="flex items-center gap-2.5 px-4 py-0.5">
        <SpineNode>
          <GitCommitIcon size={13} className="text-primary" />
        </SpineNode>
        <span className="shrink-0 font-mono text-3xs text-text-secondary">{event.headSha.slice(0, 7)}</span>
        <span className="min-w-0 flex-1 truncate text-2xs text-text-primary">{event.message}</span>
        <span className="shrink-0 font-mono text-3xs text-text-secondary">{formatRelativeTime(event.createdAt)}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 px-4 py-0.5">
      <SpineNode>
        <ChatCircleIcon size={13} weight="fill" className="text-status-warn" />
      </SpineNode>
      <span className="min-w-0 flex-1 truncate text-2xs italic text-text-primary">&ldquo;{event.text}&rdquo;</span>
      <span className="shrink-0 font-mono text-3xs text-text-secondary">{formatRelativeTime(event.createdAt)}</span>
    </div>
  );
}

function CheckpointEventsSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-6 w-1/2" />
    </div>
  );
}

function CheckpointsSection({
  prNumber,
  snapshots,
  latestSnapshot,
}: {
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
}) {
  return (
    <section className="flex flex-col gap-3 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-text-primary">Checkpoints in this PR</h2>
        <span className="font-mono text-2xs text-text-tertiary">
          · {snapshots.length} {snapshots.length === 1 ? "checkpoint" : "checkpoints"} · sorted newest
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Suspense fallback={<AggregatedCheckpointCardSkeleton />}>
          <AggregatedCheckpointCard prNumber={prNumber} snapshots={snapshots} latestSnapshot={latestSnapshot} />
        </Suspense>
        <CheckpointRail prNumber={prNumber} snapshots={snapshots} />
      </div>
    </section>
  );
}

function CheckpointRail({ prNumber, snapshots }: { prNumber: number; snapshots: Snapshot[] }) {
  return (
    <aside className="flex min-h-0 flex-col border border-border-dim bg-surface-base">
      <div className="border-b border-border-dim px-4 py-3">
        <h3 className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-tertiary">
          Checkpoint history
        </h3>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {snapshots.map((snapshot, index) => (
          <Suspense key={snapshot.id} fallback={<CheckpointRailItemSkeleton snapshot={snapshot} />}>
            <CheckpointRailItem prNumber={prNumber} snapshot={snapshot} isLatest={index === 0} />
          </Suspense>
        ))}
      </div>
    </aside>
  );
}

function AggregatedCheckpointCard({
  prNumber,
  snapshots,
  latestSnapshot,
}: {
  prNumber: number;
  snapshots: Snapshot[];
  latestSnapshot: Snapshot;
}) {
  const app = useCurrentApplication();
  const { data: commit } = useCommitFromGitHub(app.id, latestSnapshot.headSha ?? undefined);
  const latestCommitMessage = commit?.message.split("\n")[0];
  const details = useSnapshotDetails(snapshots);
  const oldestSnapshot = snapshots[snapshots.length - 1] ?? latestSnapshot;
  const editedCategories = useMemo(() => buildCumulativeEditedCategories(details), [details]);
  const testRunSections = useMemo(() => buildPrTestRunSections(details, editedCategories), [details, editedCategories]);
  const testRunSummary = useMemo(() => buildTestRunSummary(testRunSections), [testRunSections]);
  const suiteChangeCount = editedCategories.size;

  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-dim px-5 py-3">
        {/* A pure label: the bug store this card once had a verdict from is gone, and the test outcomes it does
            still show are stated by TestChangeSummary below rather than asserted by a dot up here. */}
        <Badge
          variant="outline"
          className="font-mono uppercase tracking-wider text-primary-ink border-primary-ink bg-primary-ink/10"
        >
          PR Overview
        </Badge>
        <ShaRange baseSha={oldestSnapshot.baseSha} headSha={latestSnapshot.headSha} />
        {latestCommitMessage != null && (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{latestCommitMessage}</span>
        )}
        <div className="ml-auto flex items-center gap-3 font-mono text-2xs text-text-tertiary">
          <span>
            {snapshots.length} {snapshots.length === 1 ? "checkpoint" : "checkpoints"}
          </span>
          <span>·</span>
          <span>{formatRelativeTime(latestSnapshot.createdAt)}</span>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-text-primary">Tests run across this PR</h2>
          <TestChangeSummary items={testRunSummary} />
          <TestSuiteChangesButton prNumber={prNumber} snapshotId={latestSnapshot.id} />
        </div>
        <CompactTestsRun
          sections={testRunSections}
          suiteChangeCount={suiteChangeCount}
          prNumber={prNumber}
          snapshotId={latestSnapshot.id}
        />
      </div>
    </div>
  );
}

function useSnapshotDetails(snapshots: Snapshot[]): SnapshotDetail[] {
  return useSuspenseQueries({
    queries: snapshots.map((snapshot) => trpc.branches.snapshotDetail.queryOptions({ snapshotId: snapshot.id })),
    combine: (results) => results.map((result) => result.data as SnapshotDetail),
  });
}

/**
 * How the PR's run EDITED each test it touched, across every snapshot in the PR, keyed by test case id and
 * resolved newest-snapshot-first (`details` arrives newest-first).
 *
 * Only the three edited categories appear, because they are exactly the plan diff: a proposed test the run minted
 * is `added`, a self-heal it kept is `modified`, and an `invalid_test` removal is `removed`. A test the run merely
 * selected and checked has no plan diff by definition and is deliberately absent - this card badges edits, and the
 * suite-changes tab is where the full per-test breakdown lives. So `size` is also the PR's suite-change count.
 */
function buildCumulativeEditedCategories(details: SnapshotDetail[]): Map<string, EntryCategory> {
  const categoryByTestCaseId = new Map<string, EntryCategory>();

  for (const detail of details) {
    // `buildSections` keys entries by test case id, which is what the executed-test rows look up.
    for (const section of buildSections({ changes: detail.changes, createdTests: detail.createdTests })) {
      for (const entry of section.entries) {
        if (!categoryByTestCaseId.has(entry.urlId)) categoryByTestCaseId.set(entry.urlId, entry.category);
      }
    }
  }

  return categoryByTestCaseId;
}

function buildPrTestRunSections(
  details: SnapshotDetail[],
  editedCategories: Map<string, EntryCategory>,
): PRTestRunSection[] {
  // Include in-flight (unresolved) tests so this card agrees with the checkpoint report header
  // and the checkpoint history rail, which never drop running tests. Dropping them here made the
  // PR card report fewer tests than the rest of the UI while a checkpoint was still running.
  const sections = new Map<string, PRTestRunSection>([
    ["failed", { key: "failed", title: "Failed", entries: [] }],
    ["setup_failed", { key: "setup_failed", title: "Setup Failed", entries: [] }],
    ["running", { key: "running", title: "Running", entries: [] }],
    ["passed", { key: "passed", title: "Passed", entries: [] }],
  ]);
  const seen = new Set<string>();

  for (const detail of details) {
    for (const test of detail.executedTests) {
      if (seen.has(test.testCase.id)) continue;
      seen.add(test.testCase.id);

      const category = editedCategories.get(test.testCase.id);
      const entry: PRExecutedTest = { ...test, snapshotId: detail.snapshot.id, category };
      const groupKey = groupKeyForExecutedTest(entry);
      sections.get(groupKey)?.entries.push(entry);
    }
  }

  return [...sections.values()]
    .map((section) => ({ ...section, entries: sortExecutedTests(section.entries) }))
    .filter((section) => section.entries.length > 0);
}

function groupKeyForExecutedTest(test: PRExecutedTest): string {
  if (test.finalOutcome === "failed") return "failed";
  if (test.finalOutcome === "setup_failed") return "setup_failed";
  if (test.finalOutcome === "passed") return "passed";
  return "running";
}

function sortExecutedTests(tests: PRExecutedTest[]): PRExecutedTest[] {
  return [...tests].sort((a, b) => b.latestRunAt.getTime() - a.latestRunAt.getTime());
}

function TestSuiteChangesButton({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running"
      params={{ prNumber, snapshotId }}
      className="ml-auto inline-flex items-center gap-1 font-mono text-2xs font-semibold uppercase tracking-widest text-text-primary transition-colors hover:underline"
    >
      View test suite changes
      <ArrowRightIcon size={12} />
    </AppLink>
  );
}

function CompactTestsRun({
  sections,
  suiteChangeCount,
  prNumber,
  snapshotId,
}: {
  sections: PRTestRunSection[];
  suiteChangeCount: number;
  prNumber: number;
  snapshotId: string;
}) {
  if (sections.length === 0) {
    // No executed tests yet; surface suite changes when the suite was edited.
    return (
      <div className="flex flex-col gap-2 bg-surface-void px-4 py-4 text-sm text-text-secondary">
        <span>No tests have run for this PR yet.</span>
        {suiteChangeCount > 0 && (
          <span className="text-text-secondary">
            {suiteChangeCount} test suite {suiteChangeCount === 1 ? "change" : "changes"} were made -{" "}
            <AppLink
              to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running"
              params={{ prNumber, snapshotId }}
              className="text-text-primary hover:underline"
            >
              view test suite changes
            </AppLink>
            .
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {sections.map((section) => (
        <details key={section.key} className="group border-b border-border-dim last:border-b-0">
          <summary className="flex cursor-pointer list-none items-center gap-2 py-3 transition-colors hover:text-text-primary">
            <CaretRightIcon size={12} className="text-text-tertiary transition-transform group-open:rotate-90" />
            <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
              {section.title} · {section.entries.length}
            </span>
          </summary>
          <ul>
            {section.entries.map((entry) => (
              <ExecutedTestRunRow key={`${entry.snapshotId}-${entry.testCase.id}`} test={entry} />
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

function ExecutedTestRunRow({ test }: { test: PRExecutedTest }) {
  return (
    <li className="border-t border-border-dim/60">
      <ExecutedTestLink
        test={test}
        className="flex min-w-0 flex-col gap-1 py-2.5 transition-colors hover:text-primary-ink"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-text-primary">{test.testCase.name}</span>
          {test.category != null && (
            <Badge variant={categoryVariant(test.category)} className="shrink-0 text-3xs">
              {categoryLabel(test.category)}
            </Badge>
          )}
        </div>
      </ExecutedTestLink>
    </li>
  );
}

type SummaryItem = {
  key: string;
  label: string;
  count: number;
  variant:
    | "status-passed"
    | "status-failed"
    | "status-running"
    | "status-pending"
    | "success"
    | "warn"
    | "critical"
    | "outline";
};

function buildTestRunSummary(sections: PRTestRunSection[]): SummaryItem[] {
  const entries = sections.flatMap((section) => section.entries);
  const finalOutcomeCount = (finalOutcome: ExecutedTest["finalOutcome"]) =>
    entries.filter((entry) => entry.finalOutcome === finalOutcome).length;

  const summary: SummaryItem[] = [
    { key: "failed", label: "failed", count: finalOutcomeCount("failed"), variant: "status-failed" },
    { key: "setup_failed", label: "setup failed", count: finalOutcomeCount("setup_failed"), variant: "warn" },
    { key: "running", label: "running", count: finalOutcomeCount("unresolved"), variant: "status-running" },
    { key: "passed", label: "passed", count: finalOutcomeCount("passed"), variant: "status-passed" },
  ];

  return summary.filter((item) => item.count > 0);
}

function TestChangeSummary({ items }: { items: SummaryItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <Badge key={item.key} variant={item.variant} className="font-mono text-3xs">
          {item.count} {item.label}
        </Badge>
      ))}
    </div>
  );
}

function categoryLabel(category: EntryCategory): string {
  if (category === "modified") return "edited";
  return CATEGORY[category].label;
}

function categoryVariant(category: EntryCategory): "success" | "warn" | "critical" | "high" | "outline" | "neutral" {
  if (category === "added") return "outline";
  return CATEGORY[category].variant;
}

function CheckpointRailItem({
  prNumber,
  snapshot,
  isLatest,
}: {
  prNumber: number;
  snapshot: Snapshot;
  isLatest: boolean;
}) {
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
      params={{ prNumber, snapshotId: snapshot.id }}
      className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-raised"
    >
      <div className="flex flex-wrap items-center gap-2">
        {isLatest && (
          <Badge
            variant="outline"
            className="gap-1 border-border-mid font-mono uppercase tracking-wider text-text-secondary"
          >
            {snapshot.summary != null && <StatusDot status={dotStatusForTone(snapshot.summary.tone)} />}
            Latest
          </Badge>
        )}
        {snapshot.summary != null && <CheckpointSummaryPill summary={snapshot.summary} />}
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{formatRelativeTime(snapshot.createdAt)}</span>
      </div>
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <span className="font-mono text-2xs text-text-tertiary">
        {formatCheckpointMetrics(snapshot.summary, snapshot.healthCounts.totalTests)}
      </span>
    </AppLink>
  );
}

function dotStatusForTone(
  tone: "success" | "critical" | "warning" | "neutral",
): "success" | "critical" | "warn" | "neutral" {
  if (tone === "success") return "success";
  if (tone === "critical") return "critical";
  if (tone === "warning") return "warn";
  return "neutral";
}

function CheckpointRailItemSkeleton({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-dim px-4 py-3 last:border-b-0">
      <div className="flex items-center gap-2">
        <Skeleton className="h-6 w-20" />
        <Skeleton className="ml-auto h-3 w-12" />
      </div>
      <ShaRange baseSha={snapshot.baseSha} headSha={snapshot.headSha} />
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

function NoSnapshotsPanel() {
  return (
    <Panel>
      <PanelBody>
        <div className="flex flex-col items-center justify-center gap-3 py-14 text-center text-text-secondary">
          <GitPullRequestIcon size={28} />
          <p className="text-sm">No checkpoints yet for this pull request</p>
        </div>
      </PanelBody>
    </Panel>
  );
}

const BLOCKED_REASON_LABEL: Record<string, string> = {
  insufficient_credits: "This organization is out of credits, so no analysis has run for this pull request yet.",
};

// Distinguishes a declined trigger (never created anything to show) from a PR that was simply never
// triggered - `NoSnapshotsPanel`'s empty state above looks identical to both without this.
function BlockedPanel({ reason, blockedAt }: { reason: string; blockedAt: Date | undefined }) {
  return (
    <Panel>
      <PanelBody>
        <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
          <StatusDot status="critical" />
          <p className="max-w-md text-sm text-text-primary">
            {BLOCKED_REASON_LABEL[reason] ?? "The last trigger for this pull request was declined."}
          </p>
          {blockedAt != null && <p className="text-2xs text-text-secondary">Blocked {formatRelativeTime(blockedAt)}</p>}
        </div>
      </PanelBody>
    </Panel>
  );
}

function AggregatedCheckpointCardSkeleton() {
  return (
    <div className="border border-border-dim bg-surface-base">
      <div className="flex items-center gap-3 border-b border-border-dim px-5 py-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-6 w-36" />
        <Skeleton className="ml-auto h-3 w-28" />
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-28 w-full" />
      </div>
    </div>
  );
}

/**
 * Mirrors the Overview tab's two stacked regions - the pipeline strip and the checkpoint card - rather than
 * two anonymous bars, so the card that arrives lands where its outline already was.
 */
function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-5 p-6">
      <Skeleton className="h-16 w-full" />
      <AggregatedCheckpointCardSkeleton />
    </div>
  );
}
