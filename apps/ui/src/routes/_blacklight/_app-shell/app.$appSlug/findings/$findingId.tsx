import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { ArrowUpRightIcon } from "@phosphor-icons/react/ArrowUpRight";
import { createFileRoute } from "@tanstack/react-router";
import { FindingIterationSwitch, FindingStatus, timingLine } from "components/analysis/finding-drawer/finding-drawer";
import { FindingDrawerPlan } from "components/analysis/finding-drawer/finding-drawer-plan";
import { FindingDrawerSummary, FindingMediaPanel } from "components/analysis/finding-drawer/finding-drawer-summary";
import {
  FINDING_RAIL_TABS,
  type FindingDetailView,
  type FindingRailTab,
  availableRailTabs,
} from "components/analysis/finding-drawer/finding-drawer-types";
import { FindingStepsList } from "components/analysis/finding-drawer/finding-steps-list";
import { SelfHealHistory } from "components/analysis/self-heal-history";
import { DebugPanel } from "components/debug/debug-panel";
import { SystemFailurePanel, isSystemFailure } from "components/system-failure-panel";
import { ensureAnalysisFindingDetailData, useAnalysisFindingDetail } from "lib/query/branches.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { z } from "zod";

const searchSchema = z
  .object({
    tab: z.enum(FINDING_RAIL_TABS).optional(),
    iteration: z.coerce.number().int().positive().optional(),
  })
  .catch({});

/** The mono uppercase style shared by this page's up/back links (back-to-PR, issue up-link, not-found return). */
const NAV_LINK_CLASS =
  "inline-flex items-center gap-1.5 font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary transition-colors hover:text-text-primary";

/** The line tab's lean form: short text, a tight lime underline hugging it. */
const RAIL_TAB_CLASS = "h-auto flex-none py-1 after:bottom-0";

/**
 * The canonical, app-scoped test-result page for one finding: a test's analysis verdict and its raw execution
 * together, keyed by finding id alone so it carries no snapshot chrome. The verdict story owns the main column;
 * a sticky rail carries the run - its recording plus a Steps / Plan / Debug tabbed panel - beside it. Adds the
 * up-link to the finding's issue and the admin self-heal history the running-stage drawer's quick-look leaves out.
 */
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/findings/$findingId")({
  validateSearch: (search) => searchSchema.parse(search),
  loaderDeps: ({ search }) => ({ iteration: search.iteration }),
  loader: async ({ context, params, deps }) => {
    await ensureAnalysisFindingDetailData(context.queryClient, params.findingId, deps.iteration);
  },
  component: FindingResultPage,
});

function FindingResultPage() {
  return (
    <Suspense fallback={<FindingResultSkeleton />}>
      <FindingResultContent />
    </Suspense>
  );
}

function FindingResultContent() {
  const { findingId } = Route.useParams();
  const { tab, iteration } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: view } = useAnalysisFindingDetail(findingId, { iteration });

  if (view == null) return <FindingNotFound />;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackToPr prNumber={view.prNumber} />
        <IssueUpLink issueId={view.issueId} issueTitle={view.issueTitle} prNumber={view.prNumber} />
      </div>

      <FindingHeader
        view={view}
        onIterationChange={(next) =>
          void navigate({ search: (prev) => ({ ...prev, iteration: next, tab: undefined }), replace: true })
        }
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <VerdictColumn view={view} />
        <RunRail
          view={view}
          tab={tab}
          onTabChange={(next) => void navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true })}
        />
      </div>

      <SelfHealHistory classifications={view.iterations} />
    </div>
  );
}

/** Title, verdict status, headline, timing and the self-heal attempt switch - full width above the two columns. */
function FindingHeader({
  view,
  onIterationChange,
}: {
  view: FindingDetailView;
  onIterationChange: (iteration: number) => void;
}) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-2xl font-medium tracking-tight text-text-primary">{view.testCase.name}</h1>
      {view.testCase.description != null && <p className="text-sm text-text-secondary">{view.testCase.description}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <FindingStatus view={view} />
        {view.classification != null && (
          <span className="text-sm text-text-primary">{view.classification.headline}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="font-mono text-3xs text-text-secondary">{timingLine(view)}</span>
        <FindingIterationSwitch view={view} onIterationChange={onIterationChange} />
      </div>
    </header>
  );
}

/** The main column: the verdict story with its media lifted out to the rail. Falls back to the crash reason or a
 * neutral note for a finding with no verdict yet (an unjudged or contained run). */
function VerdictColumn({ view }: { view: FindingDetailView }) {
  if (view.classification != null) {
    return (
      <FindingDrawerSummary classification={view.classification} generation={view.generation ?? undefined} hideMedia />
    );
  }
  const failure = view.generation?.failure;
  if (isSystemFailure(failure)) return <SystemFailurePanel failure={failure} />;
  return (
    <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
      This test has not been judged yet.
    </p>
  );
}

/** The sticky run rail: the recording, then a lean Steps / Plan / Debug tabbed panel whose content is its own
 * fitted box. Sticks beside the verdict story on wide screens so the story scrolls independently. */
function RunRail({
  view,
  tab,
  onTabChange,
}: {
  view: FindingDetailView;
  tab?: FindingRailTab;
  onTabChange: (tab: FindingRailTab) => void;
}) {
  const tabs = availableRailTabs(view);
  const activeTab = tab != null && tabs.includes(tab) ? tab : (tabs[0] ?? "plan");
  const generation = view.generation;

  return (
    <aside className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      {view.classification != null && (
        <FindingMediaPanel classification={view.classification} generation={generation ?? undefined} />
      )}

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          const next = tabs.find((candidate) => candidate === value);
          if (next != null) onTabChange(next);
        }}
        className="flex flex-col gap-3"
      >
        <TabsList variant="line" className="justify-start">
          {tabs.includes("steps") && (
            <TabsTrigger value="steps" className={RAIL_TAB_CLASS}>
              Steps
            </TabsTrigger>
          )}
          <TabsTrigger value="plan" className={RAIL_TAB_CLASS}>
            Plan
          </TabsTrigger>
          {tabs.includes("debug") && (
            <TabsTrigger value="debug" className={RAIL_TAB_CLASS}>
              Debug · admin
            </TabsTrigger>
          )}
        </TabsList>

        {generation != null && (
          <TabsContent value="steps">
            <FindingStepsList generation={generation} />
          </TabsContent>
        )}
        <TabsContent value="plan">
          <div className="rounded-lg border border-border-dim bg-surface-base p-4">
            <FindingDrawerPlan plan={view.plan} previousPlan={view.previousPlan ?? undefined} />
          </div>
        </TabsContent>
        {generation?.debug != null && (
          <TabsContent
            value="debug"
            className="flex flex-col gap-4 rounded-lg border border-border-dim bg-surface-base p-4"
          >
            <DebugPanel debug={generation.debug} conversationUrl={generation.conversationUrl ?? undefined} />
            {generation.temporalWorkflow != null && (
              <p className="font-mono text-3xs text-text-secondary">
                Temporal: {generation.temporalWorkflow.workflowId}
              </p>
            )}
          </TabsContent>
        )}
      </Tabs>
    </aside>
  );
}

/** Up to the PR this finding's run belongs to (its overview page), the finding's natural parent whatever surface
 * linked here. Falls back to the PR list for a finding with no PR (a main-branch run). */
function BackToPr({ prNumber }: { prNumber?: number }) {
  if (prNumber == null) {
    return (
      <AppLink to="/app/$appSlug/pull-requests" className={NAV_LINK_CLASS}>
        <ArrowLeftIcon size={12} />
        Pull requests
      </AppLink>
    );
  }
  return (
    <AppLink to="/app/$appSlug/pull-requests/$prNumber" params={{ prNumber }} className={NAV_LINK_CLASS}>
      <ArrowLeftIcon size={12} />
      PR #{prNumber}
    </AppLink>
  );
}

/** Up to the branch-scoped issue this finding was clustered into. The issue page is PR-scoped, so it renders only
 * when both the issue and its PR are known - a passing / coverage-plane check, or a main-branch run, has neither. */
function IssueUpLink({ issueId, issueTitle, prNumber }: { issueId?: string; issueTitle?: string; prNumber?: number }) {
  if (issueId == null || prNumber == null) return null;
  return (
    <AppLink
      to="/app/$appSlug/pull-requests/$prNumber/issues/$issueId"
      params={{ prNumber, issueId }}
      className={NAV_LINK_CLASS}
    >
      <ArrowUpRightIcon size={12} />
      Part of issue{issueTitle != null ? `: ${issueTitle}` : ""}
    </AppLink>
  );
}

function FindingNotFound() {
  return (
    <div className="flex flex-col gap-4">
      <AppLink to="/app/$appSlug/pull-requests" className={cn(NAV_LINK_CLASS, "self-start")}>
        <ArrowLeftIcon size={12} />
        Pull requests
      </AppLink>
      <p className="rounded-lg border border-border-dim bg-surface-base px-5 py-6 text-sm text-text-secondary">
        This test result could not be found. It may have been deleted, or the link is stale.
      </p>
    </div>
  );
}

function FindingResultSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-5 w-64" />
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
