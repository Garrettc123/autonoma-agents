import { cn } from "@autonoma/blacklight";
import type { ReactNode } from "react";

/** A rail is pinned beside the main column on wide screens and capped at the viewport, so the main column scrolls
 * past it while each panel scrolls within the rail instead of growing the page. 6.5rem clears the top bar plus the
 * rail's sticky offset and a bottom breath. Shared by the finding test-result page and the analysis issue page. */
export const RAIL_FRAME_CLASS = "lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100dvh-6.5rem)]";

/** An always-visible, higher-contrast scrollbar so a panel that overflows plainly reads as scrollable. The default
 * overlay scrollbar hides at rest on macOS, and the theme's border tones (#333/#444) vanish against the panel; a
 * reserved gutter plus a light thumb keeps the indicator on screen. `scrollbar-width` is left unset on purpose - a
 * non-auto value makes Chromium ignore the `::-webkit-scrollbar` rules and fall back to a hairline native bar. */
const RAIL_SCROLLBAR_CLASS =
  "[scrollbar-gutter:stable] " +
  "[&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-track]:bg-transparent " +
  "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/40 [&::-webkit-scrollbar-thumb]:hover:bg-white/60";

/**
 * A rail panel: a framed box that fills the rail's leftover height and scrolls internally, showing an always-visible
 * scrollbar (see {@link RAIL_SCROLLBAR_CLASS}) so an overflowing panel plainly reads as scrollable rather than
 * looking like it simply ends. `className` styles the inner scroll region (e.g. padding).
 */
export function RailPanel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-dim bg-surface-base",
        RAIL_SCROLLBAR_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}
