---
title: Billing
description: How Autonoma bills - the shared credit ledger, the five ways credits are consumed, the four ways they are granted, and the two settlement rails (Stripe and Vercel Marketplace) that sit on top of them.
---

Every organization on Autonoma spends **credits**. One ledger tracks them, one package
(`@autonoma/billing`) owns every read and write to it, and two **settlement rails** put money behind
them: Stripe for direct customers, the Vercel Marketplace for organizations that installed Autonoma
from Vercel.

The distinction that matters most, and the one most often gotten wrong: the two rails are separate at
the **money** layer and identical at the **credit** layer. A Vercel organization's credits live in the
same column, move through the same deduction code, and are granted by the same function as a Stripe
organization's. Only the settlement differs.

## The ledger

`BillingCustomer.creditBalance` is the single authoritative total, one row per organization.
`CreditTransaction` is the append-only history behind it - one row per event, signed (negative for
consumption, positive for grants), each carrying the balance it produced.

`subscriptionCreditBalance` sits beside it and is **not a second pool**. It is a tag recording how
much of `creditBalance` came from the current plan cycle. "Top-up credits" in the UI is derived, not
stored: `creditBalance - subscriptionCreditBalance`.

### Idempotency

Nothing in this package asks "have I already processed this?". Instead every write derives a
**deterministic transaction id** from whatever it is charging for, and lets the primary key collide:

| Path | Transaction id |
|---|---|
| Test generation | `ctr_gen_${generationId}` |
| LLM proxy request | `ctr_llm_${requestId}` |
| AI cost batch | `ctr_ai_${firstAiCostRecordId}` |
| Preview runtime window | `ctr_preview_${usageWindowId}` |
| Previewkit build | `ctr_build_${appBuildId}` |

The insert is `ON CONFLICT (id) DO NOTHING`, and the balance `UPDATE` in the same statement is gated
on `EXISTS (SELECT 1 FROM inserted)` - so a retry cannot double-charge even though the two writes are
separate clauses. Stripe-anchored grants use unique foreign-key columns instead
(`stripePaymentIntentId`, `stripeInvoiceId`, `stripeRefundId`).

## Spending credits

Five paths consume credits. Three share one primitive; two predate it.

**`deductCreditsFloored`** is the shared primitive. It never refuses: it clamps the balance at the
organization's `creditFloor` (default `0`) instead of requiring sufficient funds, because work already
in flight must never be half-billed.

| Path | Priced by | Uses the primitive |
|---|---|---|
| AI cost (analysis activities) | credits-per-USD rate | yes |
| Preview runtime compute | `usdPerVcpuHourMicros` / `usdPerGbHourMicros` | yes |
| Previewkit build compute | same compute rates | yes |
| Test generation | per-architecture generation cost | no - hard sufficiency gate that throws |
| LLM proxy (planner CLI) | credits-per-USD rate | no - floors at literal `0` |

The bottom two rows are historical accidents rather than intent.

### AI cost attribution

AI-consuming activities never pass an organization id. `persistAiCosts` reads it from the **ambient
observability context**, bound by the Temporal activity interceptor from the activity's own input. A
new AI-consuming activity therefore gets correct attribution and billing with no call-site wiring.

The deduction is best-effort: a pricing or database failure logs and moves on, because a billing
side-effect must never sink an activity that already produced its real result.

### Compute metering

Running previews and build jobs are measured differently because they have to be. A live preview's
usage is read from Prometheus in fifteen-minute windows by the `preview-usage-meter` cronjob. Build
jobs cannot be read the same way - buildkit nodes are excluded from the scrape - so build usage is
derived from the build's duration times its node's known shape.

Both are priced with the same per-hour rates, and those rates are checked against **real AWS pricing**:
a weekly job derives what the underlying instances actually cost, blending on-demand and spot by
buildkit's genuine recent mix, and alerts when the reference drifts more than 10% from what was stored.
It only ever writes a reference table - a human decides whether to move any organization's live rate.

Both compute rates default to zero, so compute is metered but not charged until an admin sets them.

## Getting credits

- **Top-up purchases** - a credit package from the shared catalog, bought through Stripe Checkout or,
  on the Vercel rail, granted on the spot and invoiced on the installation.
- **Auto top-up** - optional per organization: when the balance falls below `autoTopUpThreshold`, buy
  the chosen package again automatically. It settles by the organization's own rail, so a Stripe
  organization is charged off-session and a Vercel one has the package invoiced. On the Stripe rail it
  cannot be enabled without a saved card, because there would be nothing to charge, and a card is only
  saved by completing a purchase.

  Where it runs differs by rail, and not arbitrarily. A Stripe charge can go from any host that holds
  the secret key, so it fires straight off the deduction. A Vercel recharge has to raise an invoice,
  which needs `VERCEL_ENCRYPTION_KEY` - and the workers doing the deducting do not hold it, so there
  it logs and skips rather than granting credits nothing can bill for. The `vercel-billing-invoicer`
  cronjob, which does hold the key, sweeps for those organizations instead. That sweep reads state
  rather than reacting to an event, so a recharge missed for any reason is picked up next run.

  A recharge that fails is recorded on the customer (`autoTopUpLastFailureReason`) and shown on the
  billing page, cleared by the next successful charge. That record exists because auto top-up fires
  from whichever host ran the deduction - a worker, the previewkit runner, a cronjob - and none of
  those can send email; only the API host also sends one.

  A deduction is not the only thing that should cause a recharge, so it is not the only thing that
  does. The `auto-topup-reconciler` cronjob sweeps every 15 minutes for organizations sitting below
  their threshold and recharges them, whatever did or did not happen to them. Without it, the
  recharge is edge-triggered and misses every case where one becomes possible without a deduction -
  most importantly a spend cap whose calendar month rolls over while the organization is out of
  credits: it is blocked at the credit gate, so nothing deducts, so nothing triggers, and the fresh
  headroom is never used. A card replaced after a decline and a package reactivated after being
  pulled have the same shape. The deduction hook stays as the fast path; the sweep is the floor
  under it. A recorded failure suppresses further attempts for six hours, so a card that will keep
  declining is not re-charged every tick.
- **Promo codes** - redeemable once per organization, with optional redemption limits and date windows.
- **Free start credits** - a one-time grant keyed on the **email address**, not the organization, so
  creating a second organization does not earn a second grant.
- **Refunds** - a refunded purchase revokes credits proportionally.

## Guardrails

**Credit floor** - how far below zero an organization's balance may go. Work already running keeps
going and is charged in full; the floor only blocks *new* work starting, via
`checkPreviewDeployCreditsGate` (preview deploys) and `checkAnalysisCreditsGate` (PR analysis runs).

A floor below zero is an extension of credit, so it applies only to an organization that has settled
a bill at least once - a Stripe top-up (net of refunds), an active Stripe subscription, or a Vercel
invoice Vercel reports paid and has not since refunded. A free-start organization that has never
paid is gated at `0` no matter what its floor says, and `updateCreditFloor` refuses to set a negative
one for it. The check runs on every gate rather than only at write time, so an organization that
pays, earns an overdraft and then refunds its way back to nothing loses the overdraft with the
payment that justified it.

**Grace period** - an unpaid invoice starts a countdown on either rail. Once it expires, the gates
begin refusing work.

Note that `autoTopUpThreshold` is a *floor* that triggers a purchase, not a ceiling on spending. It is
easy to mistake for one.

## The two rails

| | Stripe | Vercel Marketplace |
|---|---|---|
| Recurring credits | Subscription invoice | Plan allotment per cycle |
| Buy a package | Checkout redirect, granted on the webhook | Granted immediately, invoiced on the installation |
| Auto top-up | Yes, charges the saved card | Yes, buys the same package and invoices it |
| Spending ceiling | Monthly spend cap | Monthly spend cap, plus the per-cycle overage cap |
| Extra credits without buying | none | Overage minted internally, billed in arrears |

Both rails sell the same catalog at the same price, and both honour the same monthly spend cap. Only
the settlement differs, and it differs in one way worth knowing: **Stripe collects before it grants,
Vercel grants before it collects.** A card is charged and the webhook then grants; a Vercel purchase
is granted on the spot and an invoice raised on the installation for Vercel to collect. Reversed, a
failure between the two would bill a customer for credits they never received.

The exposure that ordering creates is bounded at **one unpaid purchase per organization**: until
Vercel reports the invoice paid, that organization cannot buy again. This is also why a plan carrying
no payment method is still sold to - Vercel owns collection, and an organization that never settles
walks away with a single package rather than an open tab.

Both rails call the same grant function when an invoice is paid, and the plan allotment for a Vercel
organization is copied into the same pricing column a Stripe subscription uses. On both rails that
grant is a **reset, not an addition** - each cycle overwrites the previous allotment and records the
unused remainder as forfeited, so plan credits do not roll over. A purchased package is not part of
that reset: it lands outside `subscriptionCreditBalance`, which is the portion the reset preserves.

On the Vercel rail, an unset overage cap means a **hard stop** at the plan allotment, not "unlimited".

## Self-hosting

Setting `STRIPE_ENABLED=false` swaps the whole package for an implementation where every gate returns
"allowed" and every deduction is a no-op. Self-hosted deployments are not metered.

## Known gaps

Documented because they are real, not because they are acceptable:

- Vercel invoice submission is not atomic across the network call, so a submitted-then-crashed run can
  invoice the same period twice.
- Refunding a Vercel *cycle* invoice does not claw back the plan allotment it granted. A refunded
  credit *purchase* does revoke its credits and reopen the cap headroom.
- An organization can hold more than one active Vercel installation; reads arbitrarily pick the newest.
- Overage is consulted only by the test-generation gate, so a Vercel organization with overage enabled
  is still blocked from preview deploys and analysis runs at its floor.
