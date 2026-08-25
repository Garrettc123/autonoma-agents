# Previewkit Credits Watcher

Enforces the zero-tolerance credit policy against previewkit. An org with
`BillingCustomer.killJobsOnCreditExhaustion` set gets its in-flight builds and deploys killed once
its balance sits at-or-below its `creditFloor`, instead of letting the run finish and floor-clamp
like every other org does.

Previewkit has no in-process moment to detect this itself: build-cost deduction only fires after
every app in a deploy attempt has already finished building, so by the time any deduction lands
there is nothing left running to interrupt. Hence an external process.

## Why a long-running service and not a CronJob

Enforcement latency is the product requirement, and one minute is the finest a CronJob can be
scheduled. The loop here sweeps every 30s and could go finer, because the process, its connection
pool and its Kubernetes client stay warm between sweeps.

A per-minute CronJob would also spend a pod, an image pull and a fresh connection pool on every tick
to run one indexed query that is nearly always a no-op, and would carry the missed-schedule cliff: a
controller that falls 100 schedules behind stops scheduling entirely, silently disabling the kill
switch.

The trade is that a long-running process can wedge - a sweep that hangs on a query or a Kubernetes
call that never returns leaves the process up with enforcement stopped and nothing crashed to
notice. `/healthz` reports the time since a sweep last completed, and the Deployment's liveness
probe restarts the pod when that goes stale.

## Sweep

The sweep is level-triggered: it asks "who is below their floor right now" rather than reacting to
the deduction that put them there. A balance can cross the floor through a path that carries no
signal (an admin raising `creditFloor` or flipping `killJobsOnCreditExhaustion` on, an LLM-proxy
deduction), and an edge missed once is missed forever. Re-deriving the whole picture each pass
converges regardless of how the org got there.

Each pass runs two stages: every in-flight environment is written to a terminal state
(`@autonoma/billing`'s `killEnvironmentForCreditExhaustion`, plus the branch's `lastBlockedReason`)
before anything is SIGTERMed, and then every deploy-family Job belonging to the exhausted orgs' live
environments is deleted. The second stage is keyed on the orgs' environments rather than on what the
first stage wrote, so a delete that fails is retried next sweep instead of being stranded behind a
row that now reads `failed`.

## Running Locally

```bash
pnpm --filter @autonoma/job-previewkit-credits-watcher start
```

Runs until interrupted. `SIGINT`/`SIGTERM` cut the wait between sweeps short and shut down cleanly.

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (from `@autonoma/db`)
- `SENTRY_DSN` - Sentry DSN for error tracking (from `@autonoma/logger`)
- `SENTRY_ENV` / `NODE_ENV` - environment name and mode
- `NAMESPACE` - required by `@autonoma/k8s`'s shared env schema. The watcher never resolves a runner
  image (it only lists and deletes existing Jobs), so the value is otherwise inert.

## Deployment

`deployment/apps/previewkit-credits-watcher.yaml` - a single-replica Deployment with a `Recreate`
strategy, so a rollout never runs two sweepers that race to delete the same Jobs. In-cluster RBAC
(`batch` Jobs get/list/watch/delete in the `previewkit` namespace) comes from its ServiceAccount
being a subject of `previewkit-job-launcher-ephemeral`
(`deployment/apps/previewkit-job-launcher.yaml`).
