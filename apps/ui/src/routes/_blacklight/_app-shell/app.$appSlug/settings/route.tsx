import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RouteErrorState } from "components/route-error-state";
import { SettingsRail } from "./-settings-rail";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/settings")({
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load these settings." reset={reset} />,
  component: SettingsLayout,
});

/**
 * Layout for every application-settings destination: the page header and the section rail render once here
 * and the destination fills the Outlet, so switching sections swaps only the body. Each destination used to
 * render its own copy of the header and declare its own active tab; the rail derives the active entry from
 * the matched route instead, so a destination no longer has to know its own name.
 */
function SettingsLayout() {
  const { appSlug } = Route.useParams();

  // At `lg` the page is a fixed-height frame pinned to the shell: the header and rail hold still and each
  // destination owns its own scroll (a single-column page scrolls its `SettingsScroll`; Previews scrolls each
  // of its panes independently). Below `lg` the frame is content-height and the app shell scrolls the page.
  return (
    <div className="flex flex-col gap-6 lg:h-full lg:overflow-hidden">
      <header className="shrink-0">
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Settings</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Configure this application</p>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        <SettingsRail appSlug={appSlug} />
        {/* A pure frame, not a scroller: it hands its full width and height to the destination, which decides
            how to scroll. A single content width still exists for every destination - it now lives in
            `SettingsScroll`, one place, rather than three different answers spread across the pages. */}
        <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-hidden">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
