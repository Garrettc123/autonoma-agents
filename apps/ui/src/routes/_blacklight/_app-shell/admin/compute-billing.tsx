import {
  Badge,
  Button,
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
} from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { Link, Navigate, createFileRoute } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import {
  type ComputeBillingProjectionInput,
  useAdminComputePricingReference,
  useComputeBillingProjection,
} from "lib/query/admin.queries";
import { useState } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/admin/compute-billing")({
  component: AdminComputeBillingPage,
});

/** The credits customers buy per USD, from the schema defaults: 150,000 credits per $100. */
// The margin the fleet default carries over AWS cost, used to pre-fill the form from the
// reference. Kept in step with the activation migration (20260827120100).
const DEFAULT_MARGIN_MULTIPLE = 1.5;
const DEFAULT_WINDOW_DAYS = 30;

function daysAgoInputValue(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayInputValue(): string {
  return new Date().toISOString().slice(0, 10);
}

function AdminComputeBillingPage() {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <Navigate to="/" />;

  return (
    <section className="flex-1 overflow-auto p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" render={<Link to="/admin" />}>
            <ArrowLeftIcon size={14} />
            Admin
          </Button>
          <h1 className="text-lg font-semibold text-text-primary">Compute billing projection</h1>
        </div>
        <ProjectionForm />
      </div>
    </section>
  );
}

function ProjectionForm() {
  const [vcpuRate, setVcpuRate] = useState("");
  const [gbRate, setGbRate] = useState("");
  const [since, setSince] = useState(daysAgoInputValue(DEFAULT_WINDOW_DAYS));
  const [until, setUntil] = useState(todayInputValue());
  const [committed, setCommitted] = useState<ComputeBillingProjectionInput>();

  const reference = useAdminComputePricingReference(true);
  const projection = useComputeBillingProjection(committed);

  const parsedVcpu = Number.parseFloat(vcpuRate);
  const parsedGb = Number.parseFloat(gbRate);
  const canRun =
    Number.isFinite(parsedVcpu) && parsedVcpu >= 0 && Number.isFinite(parsedGb) && parsedGb >= 0 && since <= until;

  function handleRun() {
    if (!canRun) return;
    setCommitted({
      usdPerVcpuHour: parsedVcpu,
      usdPerGbHour: parsedGb,
      // Whole UTC days, so a run is reproducible rather than shifting with the hour it was clicked.
      since: new Date(`${since}T00:00:00.000Z`),
      until: new Date(`${until}T23:59:59.999Z`),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>AWS reference rates</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-3">
          <p className="text-sm text-text-secondary">
            What compute actually costs us, refreshed weekly by the pricing-drift job. Prices are set in the same unit,
            so the fleet default is simply this times {DEFAULT_MARGIN_MULTIPLE}.
          </p>
          {reference.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="flex flex-wrap gap-6">
              {(reference.data ?? []).map((row) => (
                <div key={row.pool} className="space-y-1">
                  <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{row.pool}</p>
                  <p className="font-mono text-sm text-text-primary">${row.usdPerVcpuHour.toFixed(6)} /vCPU-hr</p>
                  <p className="font-mono text-sm text-text-primary">${row.usdPerGbHour.toFixed(6)} /GB-hr</p>
                  <p className="text-3xs text-text-secondary">
                    at {DEFAULT_MARGIN_MULTIPLE}x: ${(row.usdPerVcpuHour * DEFAULT_MARGIN_MULTIPLE).toFixed(6)} / $
                    {(row.usdPerGbHour * DEFAULT_MARGIN_MULTIPLE).toFixed(6)}
                    {row.spotFraction != null && ` · ${Math.round(row.spotFraction * 100)}% spot`}
                  </p>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      setVcpuRate((row.usdPerVcpuHour * DEFAULT_MARGIN_MULTIPLE).toFixed(6));
                      setGbRate((row.usdPerGbHour * DEFAULT_MARGIN_MULTIPLE).toFixed(6));
                    }}
                  >
                    Use for projection
                  </Button>
                </div>
              ))}
              {(reference.data ?? []).length === 0 && (
                <p className="text-sm text-text-secondary">
                  No reference stored yet - the pricing-drift job has not run.
                </p>
              )}
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Project a rate</PanelTitle>
        </PanelHeader>
        <PanelBody className="space-y-4">
          <p className="text-sm text-text-secondary">
            Reprices compute already recorded, at prices that are not saved anywhere. Nothing is charged and no
            organization is modified - this is the only way to size a price before setting one, since the deduction
            itself has no dry-run mode. Each org's credits come from its own sell rate, so the credit totals below
            differ between orgs even though the USD price is the same for all of them.
          </p>

          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-2">
              <Label htmlFor="projection-vcpu">USD / vCPU-hour</Label>
              <Input
                id="projection-vcpu"
                type="number"
                min={0}
                step="any"
                value={vcpuRate}
                onChange={(e) => setVcpuRate(e.target.value)}
                placeholder="0.051975"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="projection-gb">USD / GB-hour</Label>
              <Input
                id="projection-gb"
                type="number"
                min={0}
                step="any"
                value={gbRate}
                onChange={(e) => setGbRate(e.target.value)}
                placeholder="0.005906"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="projection-since">From (UTC)</Label>
              <Input id="projection-since" type="date" value={since} onChange={(e) => setSince(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="projection-until">To (UTC)</Label>
              <Input id="projection-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
            </div>
          </div>

          <Button onClick={handleRun} disabled={!canRun || projection.isFetching} aria-label="run-compute-projection">
            {projection.isFetching ? "Projecting..." : "Run projection"}
          </Button>
        </PanelBody>
      </Panel>

      {projection.data != null && <ProjectionResult data={projection.data} />}
    </div>
  );
}

function ProjectionResult({ data }: { data: NonNullable<ReturnType<typeof useComputeBillingProjection>["data"]> }) {
  const charged = data.rows.filter((row) => row.totalCredits > 0);

  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>
          Result: ${data.usdPerVcpuHour.toFixed(6)}/vCPU-hr, ${data.usdPerGbHour.toFixed(6)}/GB-hr
        </PanelTitle>
      </PanelHeader>
      <PanelBody className="space-y-4">
        <div className="flex flex-wrap gap-8">
          <Stat label="Orgs charged" value={data.organizationsCharged.toLocaleString()} />
          <Stat label="Total credits" value={data.totalCredits.toLocaleString()} />
          <Stat label="Total USD" value={`$${data.totalUsd.toFixed(2)}`} />
          <Stat label="Orgs pushed below floor" value={data.organizationsUnderwater.toLocaleString()} />
        </div>

        {data.organizationsUnderwater > 0 && (
          <div className="flex items-start gap-2 rounded border border-border-dim p-3">
            <WarningCircleIcon size={16} className="mt-0.5 shrink-0 text-text-primary" />
            <p className="text-sm text-text-secondary">
              These organizations would land at or below their credit floor, which blocks them from starting new PR
              analysis runs and preview deploys - not just previews. Top them up or raise their floor before setting
              this rate.
            </p>
          </div>
        )}

        <p className="text-2xs text-text-secondary">
          {formatDate(data.since)} to {formatDate(data.until)} · {charged.length} of {data.rows.length} orgs with
          measured usage would be charged
        </p>

        <div className="overflow-x-auto">
          <DataTable>
            <DataTableHead>
              <DataTableRow>
                <DataTableHeaderCell>Organization</DataTableHeaderCell>
                <DataTableHeaderCell>Build</DataTableHeaderCell>
                <DataTableHeaderCell>Running</DataTableHeaderCell>
                <DataTableHeaderCell>Total</DataTableHeaderCell>
                <DataTableHeaderCell>Balance</DataTableHeaderCell>
                <DataTableHeaderCell>After</DataTableHeaderCell>
              </DataTableRow>
            </DataTableHead>
            <DataTableBody>
              {charged.map((row) => (
                <DataTableRow key={row.organizationId}>
                  <DataTableCell>
                    <span className="flex items-center gap-2">
                      {row.organizationName}
                      {row.goesUnderwater && <Badge variant="critical">underwater</Badge>}
                      {row.unlimitedCredits && <Badge variant="success">unlimited</Badge>}
                    </span>
                  </DataTableCell>
                  <DataTableCell className="font-mono">{row.buildCredits.toLocaleString()}</DataTableCell>
                  <DataTableCell className="font-mono">{row.runningCredits.toLocaleString()}</DataTableCell>
                  <DataTableCell className="font-mono">{row.totalCredits.toLocaleString()}</DataTableCell>
                  <DataTableCell className="font-mono">{row.creditBalance.toLocaleString()}</DataTableCell>
                  <DataTableCell className="font-mono">
                    {row.unlimitedCredits ? "-" : row.balanceAfter.toLocaleString()}
                  </DataTableCell>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        </div>
      </PanelBody>
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{label}</p>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}
