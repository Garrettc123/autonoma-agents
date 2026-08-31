import { Badge, cn, Tooltip, TooltipContent, TooltipTrigger } from "@autonoma/blacklight";
import type { ComponentProps, ReactNode } from "react";

/**
 * THE tooltip-badge primitive for the analysis surfaces: a Badge whose whole surface reveals a plain-language
 * explanation on hover - the badge IS the trigger, so there is no separate (i). Used by the flow status chips, the
 * issue kind chips, and (through the OwnerBadge specialization) every owner chip, so a hoverable chip can never
 * diverge into two different controls.
 *
 * It renders as a real `button`, so the hint is keyboard-reachable rather than mouse-only, and `pointer-events-auto`
 * lets it receive hover even over a `pointer-events-none` link overlay (a click on the badge then does nothing, so an
 * enclosing card link still navigates from everywhere else). The tooltip content renders in a portal, so the badge's
 * own `overflow-hidden` can't clip it. Typography and layout are the caller's, passed via `className`.
 */
export function HintBadge({
  hint,
  variant,
  className,
  children,
}: {
  hint: string;
  variant: ComponentProps<typeof Badge>["variant"];
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant={variant} render={<button type="button" />} className={cn("pointer-events-auto", className)}>
            {children}
          </Badge>
        }
      />
      <TooltipContent className="max-w-xs normal-case">{hint}</TooltipContent>
    </Tooltip>
  );
}
