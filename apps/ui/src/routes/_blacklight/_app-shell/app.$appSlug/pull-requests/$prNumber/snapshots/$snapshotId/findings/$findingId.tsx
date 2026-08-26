import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The old snapshot-nested finding URL. A finding now has one canonical render - the app-scoped test-result page,
 * keyed by finding id alone - so this route only redirects there, keeping external deep-links (PR comments, the
 * `replayUrl` / findingKey contract) resolving. Redirect in `beforeLoad` so it fires before any loader runs.
 */
export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings/$findingId",
)({
  beforeLoad: ({ params: { appSlug, findingId } }) => {
    throw redirect({ to: "/app/$appSlug/findings/$findingId", params: { appSlug, findingId }, replace: true });
  },
});
