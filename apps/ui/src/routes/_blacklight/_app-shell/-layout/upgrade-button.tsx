import { Button } from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { Link, useParams } from "@tanstack/react-router";
import { useIsOutOfCredits } from "lib/query/billing.queries";

/**
 * The bar's one solid call to action, shown only when the organization has run its balance down -
 * at or below zero it can no longer start a run, a preview deploy or a PR analysis, so this is the
 * one moment the top bar has something worth interrupting for. A healthy balance renders nothing,
 * and so does a billing-exempt org, which is never turned away; billing lives in the account menu
 * for everyone who is just looking.
 *
 * There is no plan to upgrade to - credits are the only thing sold - so this points at the app's
 * own billing settings rather than creating a checkout session itself.
 */
export function UpgradeButton() {
  const isOutOfCredits = useIsOutOfCredits();
  const params = useParams({ strict: false });

  if (params.appSlug == null) return undefined;
  if (isOutOfCredits !== true) return undefined;

  return (
    <Link to="/app/$appSlug/settings/billing" params={{ appSlug: params.appSlug }}>
      <Button variant="cta" size="sm" aria-label="Add credits" className="shrink-0 gap-1.5">
        <LightningIcon size={13} weight="fill" />
        <span className="hidden lg:inline">Add credits</span>
      </Button>
    </Link>
  );
}
