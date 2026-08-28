import { Badge, Skeleton } from "@autonoma/blacklight";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CoinsIcon } from "@phosphor-icons/react/Coins";
import { formatMicrodollars } from "lib/format";
import { useAdminEnvironmentComputeUsage } from "lib/query/admin.queries";

/**
 * Admin-only Previewkit compute usage for this environment - build and running compute, priced
 * through the same pricing table billing itself uses. Credits are shown fractional on purpose:
 * sub-credit consumption accrues on the org's balance rather than rounding up per window, so a
 * rounded figure here would not match what the org is charged. Collapsible (see
 * `AdminAiCostPanel`); `defaultOpen` starts it expanded for the dedicated Usage tab.
 */
export function AdminComputeUsagePanel({
  environmentId,
  defaultOpen = false,
}: {
  environmentId: string;
  defaultOpen?: boolean;
}) {
  const { data, isPending, isError } = useAdminEnvironmentComputeUsage(environmentId, true);

  // Quiet on failure - this is a bonus operational panel, not core preview content.
  if (isError) return null;

  return (
    <details className="group shrink-0 border border-border-dim bg-surface-base" open={defaultOpen ? true : undefined}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3">
        <CaretRightIcon size={12} className="shrink-0 text-text-secondary transition-transform group-open:rotate-90" />
        <CoinsIcon size={14} className="shrink-0 text-text-secondary" />
        <span className="font-mono text-xs font-semibold uppercase tracking-widest text-text-primary">
          Compute usage
        </span>
        <Badge variant="outline" className="font-mono text-2xs uppercase tracking-wider">
          Admin
        </Badge>
      </summary>
      <div className="border-t border-border-dim">
        {isPending ? (
          <ComputeUsageRowsSkeleton />
        ) : (
          <div className="flex flex-col">
            <ComputeUsageRow
              label="Build"
              vcpuSeconds={data.build.vcpuSeconds}
              gbSeconds={data.build.gbSeconds}
              count={data.build.buildCount}
              countLabel="app builds"
              credits={data.build.credits}
              realCostUsdMicrodollars={data.build.realCostUsdMicrodollars}
            />
            <ComputeUsageRow
              label="Running"
              vcpuSeconds={data.running.vcpuSeconds}
              gbSeconds={data.running.gbSeconds}
              count={data.running.windowCount}
              countLabel="windows"
              credits={data.running.credits}
            />
            <div className="px-4 py-2 font-mono text-2xs text-text-secondary">
              Priced at ${data.usdPerVcpuHour.toFixed(6)}/vCPU-hr, ${data.usdPerGbHour.toFixed(6)}/GB-hr
              {data.usdPerVcpuHour === 0 && data.usdPerGbHour === 0 && " (shadow mode - not yet billed)"}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function ComputeUsageRow({
  label,
  vcpuSeconds,
  gbSeconds,
  count,
  countLabel,
  credits,
  realCostUsdMicrodollars,
}: {
  label: string;
  vcpuSeconds: number;
  gbSeconds: number;
  count: number;
  countLabel: string;
  credits: number;
  realCostUsdMicrodollars?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border-dim px-4 py-2 last:border-b-0">
      <span className="w-16 shrink-0 text-sm font-medium text-text-primary">{label}</span>
      <span className="font-mono text-2xs text-text-secondary">
        {count} {countLabel}
      </span>
      <span className="font-mono text-2xs text-text-secondary">{vcpuSeconds.toFixed(2)} vCPU-s</span>
      <span className="font-mono text-2xs text-text-secondary">{gbSeconds.toFixed(2)} GB-s</span>
      {realCostUsdMicrodollars != null && (
        <span className="font-mono text-2xs text-text-secondary" title="Real AWS cost, decoupled from the billed rate">
          {formatMicrodollars(realCostUsdMicrodollars)} real cost
        </span>
      )}
      <span className="ml-auto font-mono text-xs text-text-primary">{credits.toFixed(4)} credits</span>
    </div>
  );
}

function ComputeUsageRowsSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      <Skeleton className="h-5 w-full" />
      <Skeleton className="h-5 w-full" />
    </div>
  );
}
