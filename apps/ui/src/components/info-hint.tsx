import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import { InfoIcon } from "@phosphor-icons/react/Info";
import type { ReactNode } from "react";

/**
 * An (i) icon that reveals a plain-language explanation on hover - the single info-tooltip used across the app's
 * jargony badges (preview status, verdict state, issue kind/owner) so they all read and behave identically.
 *
 * Pass `label` to auto-generate the aria-label `What "<label>" means`, or `ariaLabel` for a custom one (one is
 * required for an accessible name). `className` tunes the trigger per site - e.g. a text tone, or
 * `pointer-events-auto` to sit above a card-wide link overlay.
 */
export function InfoHint({
  label,
  ariaLabel,
  size = 11,
  className,
  children,
}: {
  label?: string;
  ariaLabel?: string;
  size?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={ariaLabel ?? (label != null ? `What "${label}" means` : undefined)}
            className={cn("flex items-center opacity-60 transition-opacity hover:opacity-100", className)}
          >
            <InfoIcon size={size} />
          </button>
        }
      />
      <TooltipContent className="max-w-xs normal-case">{children}</TooltipContent>
    </Tooltip>
  );
}
