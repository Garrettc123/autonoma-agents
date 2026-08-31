import type { ReactNode } from "react";

/**
 * A badge's uppercase text label, nudged down 1px. This mono font's caps ride ~1px above the box center, so without
 * the nudge the label reads high against the badge background and any sibling icon (which sits at true center). The
 * one home for that nudge, so a label-and-icon chip and a label-only chip line up in the same row.
 */
export function BadgeLabel({ children }: { children: ReactNode }) {
  return <span className="translate-y-px">{children}</span>;
}
