# @autonoma/github

GitHub App integration primitives shared across the platform: the App/installation clients, PR and check-run
operations, branch-protection rulesets, and pure helpers for reasoning about commits and contributors. Depends
only on `@autonoma/db`, `@autonoma/logger`, and Octokit - no HTTP or app-server concerns live here.

## Exports

| Export | Purpose |
| --- | --- |
| `OctokitGitHubApp` / `GitHubApp` | The App: verify webhooks, mint per-installation clients. |
| `OctokitGitHubInstallationClient` / `GitHubInstallationClient` | Per-installation client: repos, PRs, commits, comments, check runs, rulesets. |
| `Octokit` | The platform's Octokit - `@octokit/core`'s, composed with the throttling + retry plugins. Hosts that build their own `App` (previewkit's GitProvider) pass this so every GitHub caller honors rate-limit headers. Never import `@octokit/core` directly. |
| `FakeGitHubApp` / `FakeGitHubInstallationClient` | In-memory doubles for tests (build repos/PRs/commits, inspect comments + check runs). |
| `LocalDevGitHubApp` / `LocalDevGitHubInstallationClient` | Fixed-response doubles for `LOCAL_DEV`. |
| `parseRepoFullName` | Split `"owner/repo"`. |
| `UnreachableBaseShaError` / `isUnreachableRefError` | Signal + classifier for a clone whose base SHA the remote will not serve (`not our ref`), distinguished from a transient timeout, so a caller can recover to a reachable base rather than fail the run. |
| `GitCommandError` / `GitStep` / `GitFailureDetails` | A failed git step in the clone path, self-describing in its message (which step, timed out or not, exit code, elapsed) because that message is all `analysis_job.failure_reason` keeps. See [the clone path](#the-clone-path-srcgit-clone-stepts-srcclone-with-retryts). |
| `parseCoAuthoredByTrailers` | Parse `Co-authored-by: Name <email>` trailers out of a commit message. |
| `resolveContributorsFromCommits` / `contributorKey` | Collapse a PR's commits (+ opener) into a deduped `ResolvedContributor[]`. |

### The clone path (`src/git-clone-step.ts`, `src/clone-with-retry.ts`)

`cloneRepository` shells out to git step by step - clone, checkout, then the base/extra fetches a diff needs -
with `runGitStep` bounding each one and translating any failure into a redacted, self-describing
`GitCommandError`. The token travels as an `http.extraHeader` in the environment, never in argv or the stored
remote, so a failing command cannot leak it.

The `clone` step retries; the rest do not. It is the only step that fails in practice, and it fails one way:
killed by its own budget, at the buzzer. So a clone that times out or dies by a signal is tried again under a
larger budget (2, then 3, then 4 minutes), emptying the target directory first, because git refuses a non-empty
target and a clone killed mid-transfer leaves a partial tree. A remote that actually answered - a repo the App
cannot read, a ref that is gone - is not retried; that answer is the result. The whole ladder is sized to stay a
fraction of the 20-minute analysis activity that owns it, which still has to run the analysis afterwards.

### Contributor resolution (`src/contributors/`)

Pure, side-effect-free helpers for the per-developer stickiness signal. A PR has more than one author, so its
outcome must attribute to all of them:

- `parseCoAuthoredByTrailers(message)` returns the `{ name, email }` co-authors declared in a commit message.
  GitHub never puts a login in a trailer, so co-authors carry only name/email; mapping an email back to a login
  is best-effort and not done here (GitHub only exposes a login when the commit email is linked to an account).
- `resolveContributorsFromCommits(commits, { openerLogin })` returns a deduped `ResolvedContributor[]` -
  every commit author (with a login where resolvable), every co-author (name/email only, no login), and the
  opener (flagged `isOpener`). `commits` need only satisfy `CommitForContributors` (`{ message, authorLogin? }`),
  which both `PullRequestCommit` and `Commit` do. `contributorKey(c)` is the stable identity used both for the
  in-memory dedup and the `BranchContributor` unique index: `login ?? email ?? displayName`, lowercased.
  `isUnresolved(c)` asks whether GitHub could map the contributor to an account (i.e. `login` is absent) - so a
  single human can appear twice (once by `login`, once by co-author `email`); dedupe by `login` where present.

The API-side orchestration that fetches commits and persists `BranchContributor` rows lives in
`apps/api/src/github/branch-contributor.service.ts`.

## Commands

```bash
pnpm typecheck   # tsc --noEmit
pnpm lint        # oxlint --fix
pnpm test        # vitest
```
