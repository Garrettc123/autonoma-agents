import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * The `/findings` segment is now only a redirect hop: its one child ($findingId) redirects to the app-scoped
 * test-result page in `beforeLoad`, before any loader here would run, so this route just passes through.
 */
export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings",
)({
  component: Outlet,
});
