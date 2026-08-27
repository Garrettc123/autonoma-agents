import { cn } from "@autonoma/blacklight";
import type { ReactNode } from "react";

/**
 * Scroll region for a single-column settings destination. The scroller spans the
 * full width of the settings frame, so the wheel works anywhere over it - including
 * the whitespace beside the content - while an inner track keeps the content at one
 * readable width shared by every destination. Only bounds its height at `lg`, where
 * the frame is fixed to the shell; below that it lays out at content height and the
 * app shell provides one natural page scroll. `className` styles the inner track (the
 * layout the destination used to put on its own root).
 */
export function SettingsScroll({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-5xl", className)}>{children}</div>
    </div>
  );
}
