import { Tabs, TabsList, TabsTrigger } from "@autonoma/blacklight";
import { useAuth } from "lib/auth";
import { usePreviewEnvironmentSummary } from "lib/query/deployments.queries";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export type PRTab = "overview" | "preview" | "usage";

// The tab switcher, rendered as a bare Tabs widget (the meta row that hosts it owns the
// border/background/padding). Analysis is the only tab every PR has, and a lone tab is not a
// switcher - so the bar appears once a second tab does: Preview Environment for a PR backed by a
// real previewkit_environment, Usage for an admin. Usage carries the branch's AI cost, which every
// PR has regardless of who hosts its previews, so a BYO-deploy PR still shows it.
export function PRTabs({
  applicationId,
  prNumber,
  active,
}: {
  applicationId: string;
  prNumber: number;
  active: PRTab;
}) {
  const { data: summary } = usePreviewEnvironmentSummary(applicationId, prNumber);
  const { isAdmin } = useAuth();
  const hasPreviewEnvironment = summary.source === "previewkit";
  if (!hasPreviewEnvironment && !isAdmin) return null;

  return (
    <Tabs value={active}>
      <TabsList variant="line">
        <TabsTrigger
          value="overview"
          render={<AppLink to="/app/$appSlug/pull-requests/$prNumber" params={{ prNumber }} />}
        >
          Analysis
        </TabsTrigger>
        {hasPreviewEnvironment && (
          <TabsTrigger
            value="preview"
            render={<AppLink to="/app/$appSlug/pull-requests/$prNumber/preview" params={{ prNumber }} />}
          >
            Preview Environment
          </TabsTrigger>
        )}
        {isAdmin && (
          <TabsTrigger
            value="usage"
            render={<AppLink to="/app/$appSlug/pull-requests/$prNumber/usage" params={{ prNumber }} />}
          >
            Usage
          </TabsTrigger>
        )}
      </TabsList>
    </Tabs>
  );
}
