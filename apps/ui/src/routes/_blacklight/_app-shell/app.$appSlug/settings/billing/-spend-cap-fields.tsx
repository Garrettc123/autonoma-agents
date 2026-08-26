import { Button, Input, Label, Skeleton } from "@autonoma/blacklight";
import { formatDate } from "lib/format";
import { useSpendCapStatus, useUpdateSpendCap } from "lib/query/billing.queries";
import { Suspense, useEffect, useState } from "react";

function centsToDollarsInput(cents: number | undefined): string {
  return cents != null ? String(cents / 100) : "";
}

function SpendCapFieldsContent() {
  const { data } = useSpendCapStatus();
  const updateCap = useUpdateSpendCap();
  const [capInput, setCapInput] = useState(centsToDollarsInput(data.capAmountCents));

  useEffect(() => {
    setCapInput(centsToDollarsInput(data.capAmountCents));
  }, [data.capAmountCents]);

  const trimmedInput = capInput.trim();
  const parsedCapDollars = trimmedInput.length > 0 ? Number.parseFloat(trimmedInput) : undefined;
  const isValidCap = trimmedInput.length === 0 || (Number.isFinite(parsedCapDollars) && (parsedCapDollars ?? 0) > 0);
  const parsedCapCents = parsedCapDollars != null ? Math.round(parsedCapDollars * 100) : undefined;
  const capChanged = parsedCapCents !== data.capAmountCents;

  function handleSave() {
    if (!isValidCap) return;
    updateCap.mutate({ capAmountCents: parsedCapCents });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">
        Cap how much this organization can spend on credits each calendar month, across every purchase it makes.
        Purchases over the cap are blocked until the period rolls over, and we email your organization's owners as the
        cap fills up.
      </p>

      <div className="space-y-2">
        <Label htmlFor="billing-spend-cap">Monthly spend cap (USD)</Label>
        <Input
          id="billing-spend-cap"
          type="number"
          inputMode="decimal"
          min={0}
          step={1}
          placeholder="No cap"
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          aria-label="billing-spend-cap"
          className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <p className="text-2xs text-text-secondary">
          Leave empty to disable the cap - top-ups are unlimited, same as today.
        </p>
      </div>

      <p className="font-mono text-3xs text-text-secondary">
        This period: ${(data.amountChargedCentsThisPeriod / 100).toFixed(2)} charged
        {data.capAmountCents != null ? ` of $${(data.capAmountCents / 100).toFixed(2)}` : ""} - resets{" "}
        {formatDate(data.periodEnd)}
      </p>

      <Button
        variant="outline"
        onClick={handleSave}
        disabled={!isValidCap || !capChanged || updateCap.isPending}
        aria-label="billing-spend-cap-save"
      >
        Save spend cap
      </Button>
    </div>
  );
}

function SpendCapFieldsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-32" />
    </div>
  );
}

export function SpendCapFields() {
  return (
    <Suspense fallback={<SpendCapFieldsSkeleton />}>
      <SpendCapFieldsContent />
    </Suspense>
  );
}
