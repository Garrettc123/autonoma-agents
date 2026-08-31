import { cn } from "@autonoma/blacklight";
import { BadgeLabel } from "components/analysis/badge-label";
import { HintBadge } from "components/analysis/hint-badge";
import type { OwnerMeta } from "components/analysis/owner-meta";

/**
 * THE owner chip - "Yours to fix" / "On us" - a thin {@link HintBadge} specialization used wherever ownership is shown
 * (the open-issues cards, the flows list, and the fix-page coverage disclosure), so the owner always reads as the same
 * control. Icon + label, sourced from the shared `OWNER_META` registry.
 */
export function OwnerBadge({ meta, className }: { meta: OwnerMeta; className?: string }) {
  const Icon = meta.icon;
  return (
    <HintBadge
      hint={meta.description}
      variant={meta.variant}
      className={cn("shrink-0 gap-1 font-mono text-3xs uppercase tracking-wider", className)}
    >
      <Icon size={11} weight="bold" />
      <BadgeLabel>{meta.label}</BadgeLabel>
    </HintBadge>
  );
}
