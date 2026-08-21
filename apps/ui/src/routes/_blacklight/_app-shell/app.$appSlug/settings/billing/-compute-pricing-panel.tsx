import { Badge, Button, Input, Label, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { formatRelativeTime } from "lib/format";
import {
  useAdminComputePricing,
  useAdminComputePricingReference,
  useUpdateComputePricing,
} from "lib/query/admin.queries";
import { useActiveOrg } from "lib/query/auth.queries";
import { useEffect, useState } from "react";

/**
 * Admin-only previewkit compute pricing: the global, AWS-derived reference rate (kept current by
 * the weekly aws-compute-pricing-drift cronjob) next to a form to set this org's live billed rate.
 * Applying it is always a deliberate admin action here, never something the cronjob does on its
 * own. Lives in billing settings rather than a specific environment's Usage tab, since the rate is
 * an org-wide setting, not tied to any one preview. Self-hides for non-staff viewers: the
 * underlying queries are `internalProcedure`-gated and error out for anyone who isn't Autonoma
 * staff, same as every other admin-only panel in the product.
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
  const [creditsPerVcpuHour, setCreditsPerVcpuHour] = useState("");
  const [creditsPerGbMemoryHour, setCreditsPerGbMemoryHour] = useState("");

  // Keep the inputs in sync once the org's live rate loads (or another admin applied a change).
  useEffect(() => {
    if (pricing == null) return;
    setCreditsPerVcpuHour(String(pricing.creditsPerVcpuHour));
    setCreditsPerGbMemoryHour(String(pricing.creditsPerGbMemoryHour));
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
          The rate previewkit build and running compute is billed at for {activeOrg.name}. Zero means the pricing is
          currently zeroed out (shadow mode) - usage is measured but not charged.
        </p>

        <div className="space-y-2">
          <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
            AWS pricing reference
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
                  <span>${row.usdPerVcpuHour.toFixed(5)}/vCPU-hr</span>
                  <span>${row.usdPerGbHour.toFixed(5)}/GB-hr</span>
                  {row.spotFraction != null && (
                    <span>
                      {(row.spotFraction * 100).toFixed(0)}% spot (n={row.sampleSize})
                    </span>
                  )}
                  <span className="ml-auto">updated {formatRelativeTime(row.updatedAt)}</span>
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
                creditsPerVcpuHour: Number(creditsPerVcpuHour),
                creditsPerGbMemoryHour: Number(creditsPerGbMemoryHour),
              });
            }}
          >
            <span className="font-mono text-2xs font-semibold uppercase tracking-widest text-text-secondary">
              {activeOrg.name}'s billed rate
            </span>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="credits-per-vcpu-hour" className="text-2xs">
                  credits/vCPU-hr
                </Label>
                <Input
                  id="credits-per-vcpu-hour"
                  type="number"
                  min={0}
                  step="any"
                  value={creditsPerVcpuHour}
                  onChange={(event) => setCreditsPerVcpuHour(event.target.value)}
                  className="h-9 w-28 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="credits-per-gb-hour" className="text-2xs">
                  credits/GB-hr
                </Label>
                <Input
                  id="credits-per-gb-hour"
                  type="number"
                  min={0}
                  step="any"
                  value={creditsPerGbMemoryHour}
                  onChange={(event) => setCreditsPerGbMemoryHour(event.target.value)}
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
