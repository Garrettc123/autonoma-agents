import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Input,
  Label,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
} from "@autonoma/blacklight";
import { CreditCardIcon } from "@phosphor-icons/react/CreditCard";
import { GiftIcon } from "@phosphor-icons/react/Gift";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { formatSubscriptionStatus, formatTransactionType } from "lib/billing/formatters";
import { formatDate } from "lib/format";
import {
  useBillingStatus,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useRedeemPromoCode,
  useTopupPackages,
  useUpdateAutoTopUp,
} from "lib/query/billing.queries";
import { toastManager } from "lib/toast-manager";
import { useEffect, useState } from "react";
import { ComputePricingPanel } from "./-compute-pricing-panel";
import { SpendCapFields } from "./-spend-cap-fields";
import { VercelOveragePanel } from "./-vercel-overage-panel";

export function BillingPanel() {
  const { data } = useBillingStatus();
  const { data: topupPackages } = useTopupPackages();
  const createCheckout = useCreateCheckoutSession();
  const createPortal = useCreatePortalSession();
  const updateAutoTopUp = useUpdateAutoTopUp();
  const redeemPromo = useRedeemPromoCode();

  const [promoCode, setPromoCode] = useState("");
  const [autoTopUpEnabled, setAutoTopUpEnabled] = useState(data.autoTopUpEnabled);
  const [autoTopUpThreshold, setAutoTopUpThreshold] = useState(String(data.autoTopUpThreshold));
  const [autoTopUpPackageId, setAutoTopUpPackageId] = useState(data.autoTopUpPackageId ?? "");

  useEffect(() => {
    setAutoTopUpEnabled(data.autoTopUpEnabled);
    setAutoTopUpThreshold(String(data.autoTopUpThreshold));
    setAutoTopUpPackageId(data.autoTopUpPackageId ?? "");
  }, [data.autoTopUpEnabled, data.autoTopUpThreshold, data.autoTopUpPackageId]);

  // Vercel-provisioned orgs pay through Vercel's own billing, never Stripe - Upgrade,
  // Open billing portal, and Buy top-up all create Stripe checkout/portal sessions,
  // which is the wrong destination (and would fail: these orgs have no
  // stripeCustomerId). Auto top-up is the Stripe-rail equivalent of the Vercel-native
  // pay-per-usage overage panel, so the two are swapped in, not stacked.
  const isVercel = data.provider === "vercel";

  const topupBalance = Math.max(0, data.creditBalance - data.subscriptionCreditBalance);
  const thresholdValue = Number.parseInt(autoTopUpThreshold, 10);
  const canSaveAutoTopUp =
    Number.isFinite(thresholdValue) &&
    thresholdValue >= 0 &&
    (!autoTopUpEnabled || autoTopUpPackageId.length > 0) &&
    (autoTopUpEnabled !== data.autoTopUpEnabled ||
      thresholdValue !== data.autoTopUpThreshold ||
      autoTopUpPackageId !== (data.autoTopUpPackageId ?? ""));

  function handleCreateCheckout(packageId?: string) {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    createCheckout.mutate(
      { returnPath, packageId },
      {
        onSuccess: (result) => {
          if (result.url == null) return;
          window.location.href = result.url;
        },
      },
    );
  }

  function handleOpenPortal() {
    const returnPath = `${window.location.pathname}${window.location.search}`;
    createPortal.mutate(
      { returnPath },
      {
        onSuccess: (result) => {
          if (result.url == null) return;
          window.location.href = result.url;
        },
      },
    );
  }

  function handleSaveAutoTopUp() {
    if (!Number.isFinite(thresholdValue) || thresholdValue < 0) return;
    if (autoTopUpEnabled && autoTopUpPackageId.length === 0) return;
    updateAutoTopUp.mutate({
      enabled: autoTopUpEnabled,
      threshold: thresholdValue,
      packageId: autoTopUpPackageId.length > 0 ? autoTopUpPackageId : undefined,
    });
  }

  function handleRedeemPromoCode() {
    const code = promoCode.trim();
    if (code.length === 0) return;

    redeemPromo.mutate(
      { code },
      {
        onSuccess: (result) => {
          setPromoCode("");
          toastManager.add({
            type: "success",
            title: `Code applied: +${result.grantedCredits.toLocaleString()} credits`,
          });
        },
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <PanelHeader>
            <PanelTitle>Total credits</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <p className="text-3xl font-semibold text-text-primary">{data.creditBalance.toLocaleString()}</p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Subscription credits</PanelTitle>
          </PanelHeader>
          <PanelBody>
            <p className="text-3xl font-semibold text-text-primary">
              {data.subscriptionCreditBalance.toLocaleString()}
            </p>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Top-up credits</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-3">
            <p className="text-3xl font-semibold text-text-primary">{topupBalance.toLocaleString()}</p>
            {!isVercel && (
              <div className="space-y-1.5">
                {topupPackages.length === 0 ? (
                  <p className="text-2xs text-text-secondary">No top-up packages are available yet.</p>
                ) : (
                  topupPackages.map((pkg) => (
                    <Button
                      key={pkg.id}
                      variant="outline"
                      className="h-auto w-full flex-col items-start gap-1 py-2"
                      onClick={() => handleCreateCheckout(pkg.id)}
                      disabled={createCheckout.isPending}
                      aria-label={`billing-buy-topup-${pkg.id}`}
                    >
                      {/* Stacked, not name-left/price-right: this panel is one of four columns, so a
                          single row cannot hold a name beside "$100.00 · 150,000 credits" without the
                          Button's whitespace-nowrap pushing it out through the side of the panel. Each
                          line gets the full width, and min-w-0 lets an overlong name ellipse instead. */}
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <LightningIcon size={14} />
                        <span className="truncate" title={pkg.name}>
                          {pkg.name}
                        </span>
                      </span>
                      <span className="w-full truncate text-left font-mono text-2xs text-text-secondary">
                        ${(pkg.priceCents / 100).toFixed(2)} · {pkg.creditsGranted.toLocaleString()} credits
                      </span>
                    </Button>
                  ))
                )}
              </div>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle className="flex items-center gap-2">
              <TerminalWindowIcon size={14} />
              AI CLI usage
            </PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-1">
            <p className="text-3xl font-semibold text-text-primary">{data.cliCreditsSpent.toLocaleString()}</p>
            <p className="text-2xs text-text-secondary">credits spent all-time on the planner CLI</p>
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Subscription</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-4">
            <Alert>
              <AlertTitle>Status</AlertTitle>
              <AlertDescription className="flex items-center gap-2">
                <span className="rounded border border-border-dim px-2 py-1 text-2xs">
                  {formatSubscriptionStatus(data.subscriptionStatus)}
                </span>
                {data.currentPeriodEnd != null ? (
                  <span>Current period ends {formatDate(data.currentPeriodEnd)}</span>
                ) : null}
              </AlertDescription>
            </Alert>

            {isVercel ? (
              <p className="text-sm text-text-secondary">Your plan and billing are managed in the Vercel dashboard.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={handleOpenPortal}
                  disabled={createPortal.isPending}
                  aria-label="billing-open-portal"
                >
                  <CreditCardIcon size={14} />
                  Open billing portal
                </Button>
              </div>
            )}
          </PanelBody>
        </Panel>

        {isVercel ? (
          <VercelOveragePanel />
        ) : (
          <Panel>
            <PanelHeader>
              <PanelTitle>Top-up controls</PanelTitle>
            </PanelHeader>
            <PanelBody className="space-y-4">
              <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Auto top-up</p>

              <label htmlFor="billing-auto-topup-enabled" className="flex items-center gap-3">
                <Checkbox
                  id="billing-auto-topup-enabled"
                  checked={autoTopUpEnabled}
                  onCheckedChange={(checked) => setAutoTopUpEnabled(checked === true)}
                />
                <span className="text-sm text-text-secondary">Enable automatic top-up when credits are low</span>
              </label>

              <div className="space-y-2">
                <Label htmlFor="billing-auto-topup-threshold">Threshold</Label>
                <Input
                  id="billing-auto-topup-threshold"
                  type="number"
                  min={0}
                  value={autoTopUpThreshold}
                  onChange={(e) => setAutoTopUpThreshold(e.target.value)}
                  aria-label="billing-auto-topup-threshold"
                />
                <p className="font-mono text-3xs text-text-secondary">
                  When balance goes below this value, a top-up payment is attempted automatically.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="billing-auto-topup-package">Package to recharge</Label>
                <Select value={autoTopUpPackageId} onValueChange={(value) => setAutoTopUpPackageId(value ?? "")}>
                  <SelectTrigger id="billing-auto-topup-package" className="w-full">
                    <SelectValue placeholder="Select a package">
                      {topupPackages.find((pkg) => pkg.id === autoTopUpPackageId)?.name}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {topupPackages.map((pkg) => (
                      <SelectItem key={pkg.id} value={pkg.id}>
                        {pkg.name} - ${(pkg.priceCents / 100).toFixed(2)} for {pkg.creditsGranted.toLocaleString()}{" "}
                        credits
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                variant="outline"
                onClick={handleSaveAutoTopUp}
                disabled={!canSaveAutoTopUp || updateAutoTopUp.isPending}
                aria-label="billing-auto-topup-save"
              >
                Save auto top-up
              </Button>

              <Separator />

              <SpendCapFields />
            </PanelBody>
          </Panel>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader>
            <PanelTitle>Gift card / promo code</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-3">
            <div className="flex gap-2">
              <Input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value)}
                placeholder="0bugs"
                aria-label="billing-promo-code-input"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleRedeemPromoCode();
                  }
                }}
              />
              <Button
                onClick={handleRedeemPromoCode}
                disabled={promoCode.trim().length === 0 || redeemPromo.isPending}
                aria-label="billing-promo-code-redeem"
              >
                <GiftIcon size={14} />
                Redeem
              </Button>
            </div>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Recent transactions</PanelTitle>
          </PanelHeader>
          <PanelBody className="space-y-2">
            {data.transactions.length === 0 ? (
              <p className="text-sm text-text-secondary">
                No transactions yet. Preview deploys and runs draw down credits, and each one appears here as it
                accrues.
              </p>
            ) : (
              data.transactions.slice(0, 10).map((tx) => (
                <div
                  key={tx.id}
                  className="flex items-center justify-between rounded-md border border-border-dim px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-2xs text-text-primary">{formatTransactionType(tx.type)}</p>
                    <p className="font-mono text-3xs text-text-secondary">{formatDate(tx.createdAt)}</p>
                  </div>
                  <p className={`font-mono text-xs ${tx.amount >= 0 ? "text-status-success" : "text-text-primary"}`}>
                    {tx.amount > 0 ? "+" : ""}
                    {tx.amount}
                  </p>
                </div>
              ))
            )}
          </PanelBody>
        </Panel>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ComputePricingPanel />
      </div>
    </div>
  );
}
