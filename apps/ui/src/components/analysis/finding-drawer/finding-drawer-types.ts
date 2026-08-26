import type { RouterOutputs } from "lib/trpc";

/** The drawer's whole payload - the `analysisFindingDetail` read, non-null once the route resolved it. */
export type FindingDetailView = NonNullable<RouterOutputs["branches"]["analysisFindingDetail"]>;

export type FindingDetailClassification = NonNullable<FindingDetailView["classification"]>;
export type FindingDetailGeneration = NonNullable<FindingDetailView["generation"]>;
export type FindingDetailStep = FindingDetailGeneration["steps"][number];

export const FINDING_DRAWER_TABS = ["summary", "steps", "plan", "debug"] as const;
export type FindingDrawerTab = (typeof FINDING_DRAWER_TABS)[number];

/**
 * Which tabs this finding's state can serve: the summary needs a verdict, steps and debug need a generation
 * (debug additionally only exists for admins - the server omits it otherwise), and the plan always renders.
 */
export function availableDrawerTabs(view: FindingDetailView): FindingDrawerTab[] {
    const tabs: FindingDrawerTab[] = [];
    if (view.classification != null) tabs.push("summary");
    if (view.generation != null) tabs.push("steps");
    tabs.push("plan");
    if (view.generation?.debug != null) tabs.push("debug");
    return tabs;
}

/**
 * The result page's rail tabs: every drawer tab except the summary (the result page renders that as its own main
 * column, not a tab). Both the constant and the per-state availability are derived from the drawer's, so a new
 * drawer tab flows into the rail automatically instead of being silently dropped by a hand-maintained copy.
 */
export type FindingRailTab = Exclude<FindingDrawerTab, "summary">;

const isRailTab = (tab: FindingDrawerTab): tab is FindingRailTab => tab !== "summary";

export const FINDING_RAIL_TABS = FINDING_DRAWER_TABS.filter(isRailTab);

export function availableRailTabs(view: FindingDetailView): FindingRailTab[] {
    return availableDrawerTabs(view).filter(isRailTab);
}
