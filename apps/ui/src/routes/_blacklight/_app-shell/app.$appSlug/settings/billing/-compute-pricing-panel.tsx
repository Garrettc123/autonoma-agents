import { Badge, Button, Input, Label, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { formatRelativeTime } from "lib/format";
import {
  useAdminComputePricing,
  useAdminComputePricingReference,
  useUpdateComputePricing,
} from "lib/query/admin.queries";
import { useActiveOrg } from "lib/query/auth.queries";
import { useEffect, useState } from "react";

// The margin the fleet default carries over AWS cost, so "apply the reference" lands on the same
// number the activation migration (20260827120100) sets. Kept in step with it.
const DEFAULT_MARGIN_MULTIPLE = 1.5;

/**
 * Admin-only previewkit compute pricing: the global, AWS-derived reference cost (kept current by
 * the weekly aws-compute-pricing-drift cronjob) next to a form overriding this org's price away
 * from the fleet default. Applying the reference is always a deliberate admin action here, never
 * something the cronjob does on its own.
 *
 * Both sides are USD per hour, so they are directly comparable and "apply" needs no arithmetic
 * from the admin - which is the whole reason prices are stored in USD rather than credits. Lives in
 * billing settings rather than a specific environment's Usage tab, since the price is an org-wide
 * setting, not tied to any one preview. Self-hides for non-staff viewers: the underlying queries
 * are `internalProcedure`-gated and error out for anyone who isn't Autonoma staff, same as every
 * other admin-only panel in the product.
 */
export function ComputePricingPanel() {
  const { data: activeOrg } = useActiveOrg();
  const enabled = activeOrg != null;
  const {
    data: pricing,
    isPending: pricingPending,
    isError: pricingError,
  } = useAdminComputePricing(activeOrg?.id ?? "", enabled);
  const { data: reference, isPending: referencePending } = useAdminComputePricingReference(enabled);
  const updateComputePricing = useUpdateComputePricing();
  const [usdPerVcpuHour, setUsdPerVcpuHour] = useState("");
  const [usdPerGbHour, setUsdPerGbHour] = useState("");

  // Keep the inputs in sync once the org's live price loads (or another admin applied a change).
  useEffect(() => {
    if (pricing == null) return;
    setUsdPerVcpuHour(pricing.usdPerVcpuHour.toFixed(6));
    setUsdPerGbHour(pricing.usdPerGbHour.toFixed(6));
  }, [pricing]);

  if (activeOrg == null || pricingError) return null;

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle className="flex items-center gap-2">
          Compute pricing
          <Badge variant="outline" className="font-mono text-2xs uppercase tracking-wider">
            Admin
          </Badge>
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <p className="text-sm text-text-secondary">
          The price previewkit build and running compute is billed at for {activeOrg.name}, in USD per hour. Every org
          starts on the fleet default ({DEFAULT_MARGIN_MULTIPLE}x the AWS reference below); this overrides it for this
          one. Zero means the pricing is zeroed out (shadow mode) - usage is measured but not charged.
        </p>

        <div className="space-y-2">
          <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
            AWS pricing reference (cost)
          </span>
          {referencePending ? (
            <Skeleton className="h-5 w-full" />
          ) : reference == null || reference.length === 0 ? (
            <p className="text-2xs text-text-secondary">No reference data yet - the weekly sync hasn't run.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {reference.map((row) => (
                <div
                  key={row.pool}
                  className="flex flex-wrap items-center gap-3 font-mono text-2xs text-text-secondary"
                >
                  <span className="w-16 shrink-0 text-text-primary">{row.pool}</span>
                  <span>${row.usdPerVcpuHour.toFixed(6)}/vCPU-hr</span>
                  <span>${row.usdPerGbHour.toFixed(6)}/GB-hr</span>
                  {row.spotFraction != null && (
                    <span>
                      {(row.spotFraction * 100).toFixed(0)}% spot (n={row.sampleSize})
                    </span>
                  )}
                  <span>updated {formatRelativeTime(row.updatedAt)}</span>
                  <Button
                    variant="outline"
                    size="xs"
                    className="ml-auto"
                    onClick={() => {
                      setUsdPerVcpuHour((row.usdPerVcpuHour * DEFAULT_MARGIN_MULTIPLE).toFixed(6));
                      setUsdPerGbHour((row.usdPerGbHour * DEFAULT_MARGIN_MULTIPLE).toFixed(6));
                    }}
                  >
                    Apply at {DEFAULT_MARGIN_MULTIPLE}x
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {pricingPending ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              updateComputePricing.mutate({
                organizationId: activeOrg.id,
                usdPerVcpuHour: Number(usdPerVcpuHour),
                usdPerGbHour: Number(usdPerGbHour),
              });
            }}
          >
            <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
              {activeOrg.name}'s billed price
            </span>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="usd-per-vcpu-hour" className="text-2xs">
                  USD/vCPU-hr
                </Label>
                <Input
                  id="usd-per-vcpu-hour"
                  type="number"
                  min={0}
                  step="any"
                  value={usdPerVcpuHour}
                  onChange={(event) => setUsdPerVcpuHour(event.target.value)}
                  className="h-9 w-28 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="usd-per-gb-hour" className="text-2xs">
                  USD/GB-hr
                </Label>
                <Input
                  id="usd-per-gb-hour"
                  type="number"
                  min={0}
                  step="any"
                  value={usdPerGbHour}
                  onChange={(event) => setUsdPerGbHour(event.target.value)}
                  className="h-9 w-28 font-mono text-xs"
                />
              </div>
              <Button type="submit" variant="outline" disabled={updateComputePricing.isPending}>
                {updateComputePricing.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        )}
      </PanelBody>
    </Panel>
  );
}
