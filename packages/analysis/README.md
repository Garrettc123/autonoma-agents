# @autonoma/analysis

The analysis module: the data-access layer for the merged analysis pipeline's own tables. Its aggregate is a
branch's **issue ledger**, with one **analysis** (one pass of the pipeline over one snapshot, 1:1 with it) as a
scope inside it - `AnalysisIssue` is branch-scoped but its only writer is always an analysis, so the durable thing
the module owns is the ledger and an analysis is an episode that appends findings and reconciles it.

It writes `analysis_job`, `analysis_finding`, `analysis_classification`, `analysis_issue`, `analysis_issue_version`
and `analysis_report`, and never touches an assignment (the suite is `@autonoma/test-suite`'s aggregate; the two
write sets are disjoint).

It also owns the **analysis inbox** (`analysis_event`): the transactional queue producers enqueue occurrences into
and a run drains. `AnalysisEventStore` is its sole reader and writer - see the interface below. Event kinds:
`commits_pushed` (a real push, carrying the head/base to analyze) and `user_prompt` (a one-shot natural-language
instruction for the claiming run, carrying `{ text, author }`).

## Interface

```ts
const store = new AnalysisStore(db);

// The lifecycle row, composed into the suite store's snapshot-open transaction:
await suiteStore.openSnapshot({
    ...,
    onOpened: (tx, identity) =>
        store.open({ snapshotId: identity.snapshotId, organizationId: identity.organizationId }, tx),
});

// One analysis (addressed by snapshot id, never "whatever is pending"):
const analysis = store.forAnalysis(snapshotId);
await analysis.recordClassification({ testCaseId, number, generationId, category, headline, report });
await analysis.recordContainment({ testCaseId, failure: { kind: "investigator_crashed", message } });
const findings = await analysis.findings();   // incl. each finding's attributed branch issue
const report = await analysis.report();       // the settled header (verdict, counts, summary, coverage)
const ledger = await analysis.branch();       // the ledger of the branch this analysis runs on
const result = await analysis.settleReport({ content, issues }); // atomic; discards when superseded
const won = await analysis.close(outcome);                       // the AnalysisJob's compare-and-swap

// The branch's ledger (the one place its branch-scoped facts are read):
const ledger = store.forBranch(branchId);
await ledger.openIssues({ kind: "bug" });
await ledger.openBugCount();
await ledger.coveredTestsForOpenIssues();
await ledger.priorReports({ excludeSnapshotId, limit: PRIOR_REPORTS_LIMIT }); // limit is the exported shared bound
await ledger.removedInvalidTests(); // tests prior runs removed as invalid_test - the Impact Analysis selector's history

// A test's verdict history across the application's analyses (the classifier's baseline evidence):
await store.priorRuns({ applicationId, testSlug, currentSnapshotId });

// One finding with its full classification history (the checkpoint drawer's read; addressed by finding
// id because the caller starts from a URL param and learns the snapshot from the row):
await store.findingDetail(findingId, { organizationId });

// The analysis inbox - producers enqueue, a run claims, in-transaction with opening its snapshot:
const events = new AnalysisEventStore(db);
await events.enqueue({ branchId, organizationId, source: "webhook", event: { type: "commits_pushed", payload: { headSha } } });
await events.hasPending(branchId);                          // is there a reason to run - the already-analyzed skip predicate
await events.claimPending(tx, branchId, snapshotId);        // steals from superseded/cancelled/failed claims
await events.listForSnapshot(snapshotId);                   // what this run analyzed

// The read-side interpreter over the inbox - what consumers (the impact agent, the Reporter) see:
const resolver = new AnalysisEventResolver(events);
const resolved = await resolver.resolveForSnapshot(snapshotId);   // every claimed event (impact agent's directives + movement)
recordedEventShas(resolved, [headSha, baseSha]);            // the recorded heads a checkout should fetch best-effort
await resolver.resolveClaimedUserPrompts(snapshotId);      // just the messages, WITH their event ids, for the Reporter to address

// The one deriving site for the already-analyzed skip (API triggers + the run's open step): skip only when the
// head is already analyzed AND the inbox is empty - a pending event un-suppresses it.
const { resolved: source, skip } = await new AnalysisRunGate(db).shouldSkipAlreadyAnalyzed({ branchId, headSha });
```

## Invariants the module holds

- **A finding is an investigation**: at most two runs, each with exactly one classification
  (`AnalysisClassification.generationId` is required). An investigation that crashed without judging a run records
  a structured `failure` on the finding and has **no** classification - "contained" is derived from that emptiness,
  never stored as a fake classification, so `number` has no sentinel slots and no gaps.
- **Issue content is append-only**: `AnalysisIssue` holds only identity + lifecycle (`resolvedAt`); every authored
  restatement (title, severity, expected/actual behavior, narrative, evidence, primary screenshot/test, suspected
  cause) is an immutable `AnalysisIssueVersion`, with `currentVersion` pointing at the newest - the same shape as
  `AnalysisFinding` → `AnalysisClassification`. An `open`/`carry_forward` mints a version and re-points; a `resolve`
  mints none. So a carry-forward **appends** a restatement rather than overwriting the prior narrative/severity/cause
  in place, and "what did this issue say last week" stays answerable. Readers resolve content through `currentVersion`.
- **`settleReport` is atomic**: the issue reconciliations, the finding attributions and the report row commit
  together, so a run's verdict and its issues can never disagree.
- **Branch-scoped writes assert liveness inside the transaction that writes**: `settleReport` takes an exclusive
  lock on the snapshot row and discards (rather than throws) when the snapshot is no longer `processing` - a Reporter
  that finishes after a newer push superseded its run must not resolve or open issues on evidence from a head the
  PR no longer contains. Per-snapshot findings are inert after settlement and deliberately not gated.
- **`settleReport` is idempotent**: the report row is born exactly once and its existence proves a prior
  settlement committed, so a retry reports `already_settled` instead of duplicating every opened issue.
- **A resolve keeps its justification**: the resolving finding and the Reporter's note are persisted
  (`resolvedByFindingId`, `resolutionNote`), so which passing test closed an issue stays auditable.
- **Every queued test is covered**: settlement refuses to write a report while a test that queued a run has
  neither a verdict nor a recorded containment.
- **The inbox has no status column**: whether an `analysis_event` is handled is derived - unclaimed, or claimed by
  a snapshot whose run was thrown away (`superseded`/`cancelled`/`failed`), is pending; claimed by a live
  (`processing`/`active`) snapshot is handled. That predicate lives in exactly one place (`AnalysisEventStore`), so a
  terminated run's stranded claim is stolen by its successor with no release step and no second source of truth to
  keep in sync.

## Testing

Integration tests with Testcontainers (one shared Postgres, per-harness database). `pnpm test --filter
@autonoma/analysis`.
