# Goal-18 — Git ops + GitHub PR layer

> **Status:** Audit only. No code changes.
> **Source:** `context/emdash/src/shared/{git,git-utils,github,github-repository,pull-requests}.ts` + `src/shared/events/{git,github}Events.ts` + `src/main/core/{git,github,pull-requests}/**` + the renderer-side check-runs surface.
> **Motivation:** the v2 shell currently has a read-only changes view (unified diff text). To match the reference codebase's reviewer-grade flow we need (a) typed git ops with proper error channels, (b) a GitHub PR data model with sync engine, (c) CI/CD check-run surface. The reference implementation is already structured for the port — pure shared types, daemon-side services that already lean on `gh` CLI in places, a renderer surface that's mostly view code.

---

## §1 — Reference architecture

Three layers, mirroring Goal-17's editor port.

### 1.1 — Shared types (`src/shared/`, ~640 LOC across 5 files)

Pure TS, zero dependencies, zero IO. Ports verbatim.

**`git.ts` (282 LOC) — the addressing primitives.**

- `Branch` — discriminated `{ type: 'local'; branch } | { type: 'remote'; branch; remote }`.
- `Remote = { name; url }`.
- `DiffMode` — `{ kind: 'head' } | { kind: 'staged' }`. Maps to `git diff HEAD` / `git diff --cached`. **Not** a ref string — it's an intent.
- `GitObjectRef` — `{ kind: 'branch'; branch } | { kind: 'commit'; sha } | { kind: 'tag'; name }`. Always resolves to a real git object.
- `GitRef = DiffMode | GitObjectRef` — the full operand type for diff/log APIs.
- `MergeBaseRange = { base; head }` — `base...head` three-dot range; both sides must be `GitObjectRef` (modes not allowed).
- Helpers: `toRefString`, `gitRefToString`, `refsEqual`, `branchRef`, `localRef`, `remoteRef`, `commitRef`, `tagRef`, `toRangeString`, `mergeBaseRange`.
- Payloads: `LocalBranchesPayload`, `RemoteBranchesPayload`, `BranchStatus`, `Commit`, `CommitFile`, `GitChange`, `FullGitStatus`, `DiffResult`, `GitInfo`, `GitHeadState`.
- Error unions (this is the load-bearing bit): `FetchError`, `CommitError`, `SoftResetError`, `CreateBranchError`, `RenameBranchError`, `DeleteBranchError`, `PushError`, `PullError`, plus `FetchPrRefError`, `FetchPrForReviewError`. Each is a discriminated union with a `type:` literal — auth failure, network failure, conflict, rejected hook, diverged, etc. **These are the spine of the port.** They map directly onto Effect typed error channels.

**`git-utils.ts` (48 LOC) — three pure helpers.**

- `selectPreferredRemote(configured, remotes)` — pick the configured remote, fall back to `origin`, fall back to first.
- `bareRefName('origin/main')` → `'main'`.
- `computeDefaultBranch(configured, branches, remote, gitDefaultBranch)` — resolves the canonical default-branch name from user settings + live branch list + git heuristics. Pure; doesn't read git.

**`github.ts` (32 LOC).** Auth-related types only: `GitHubUser`, `GitHubTokenSource = 'secure_storage' | 'cli' | null`, plus the device-code flow envelope (`GitHubAuthResponse`, `GitHubConnectResponse`). The `'cli'` token source confirms the reference codebase already supports delegating auth to the `gh` CLI.

**`github-repository.ts` (72 LOC).** `parseGitHubRepository(input)` — handles `git@github.com:o/r.git`, `https://github.com/o/r`, `o/r`. Returns `{owner, repo, nameWithOwner, repositoryUrl}` or `null`. Also `parseGitHubRepositoryResult` (Result-wrapped) and `splitNameWithOwner`.

**`pull-requests.ts` (174 LOC) — the PR aggregate.**

- `PullRequest` — fully denormalised view used everywhere in the renderer: 25 fields including `url`, `baseRefName`/`Oid`, `headRefName`/`Oid`, `identifier` (stores `"#123"`), `title`/`description`, `status: 'open' | 'closed' | 'merged'`, `isDraft`, sums (additions/deletions/changedFiles/commitCount), `mergeableStatus: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'`, `mergeStateStatus: 'CLEAN' | 'DIRTY' | 'BEHIND' | 'BLOCKED' | 'HAS_HOOKS' | 'UNSTABLE' | 'UNKNOWN'`, `reviewDecision`, `author`, `labels`, `assignees`, `checks`.
- `PullRequestCheck` — per-check-run row: id, commitSha, name, status, conclusion, detailsUrl, startedAt/completedAt, workflowName, appName, appLogoUrl.
- `PrSyncProgress` — `{ remoteUrl, kind: 'full' | 'incremental' | 'single', status: 'running' | 'done' | 'error' | 'cancelled', synced?, total?, error? }`.
- `PullRequestError` — discriminated union over 11 failure modes (`invalid_repository`, `remote_not_ready`, `list_failed`, `sync_failed`, `create_failed`, `merge_failed`, etc).
- `ListPrOptions` / `PrFilters` / `PrSortField` / `PrFilterOptions` — query DSL.
- Helpers: `selectCurrentPr(prs)` (open beats most-recent), `isForkPr`, `getPrNumber`, `pullRequestErrorMessage`.

**Event channels (`src/shared/events/`).**

- `gitEvents.ts` — `gitRefChangedChannel` (project/workspace/kind: `local-refs | remote-refs | config`, optional `changedRefs[]`); `gitWorkspaceChangedChannel` (project/workspace/kind: `index | head`). Goal-17 already needs these.
- `githubEvents.ts` — device-code auth flow events: `device-code` → `polling` → `slow-down` / `success` / `error` / `cancelled`. Plus `user-updated`.

### 1.2 — Daemon-side services (`src/main/core/{git,github,pull-requests}/`)

**`git/impl/` — the imperative shell-out layer.**

- `git-service.ts` — every git op as a typed function: `status`, `diff`, `log`, `branchList`, `fetch`, `pull`, `push`, `commit`, `checkout`, `createBranch`, `renameBranch`, `deleteBranch`, `softReset`, …. Each returns `Result<T, SpecificError>` (the error unions from `git.ts`). Wraps `child_process.spawn('git', ...)` with stdout capture + exit-code → error mapping.
- `status-parser.ts` — parses `git status --porcelain=v2` output into `FullGitStatus`. Standalone, unit-testable.
- `cat-file-batch.ts` — opens one long-lived `git cat-file --batch` process, feeds it object refs on stdin, reads content on stdout. **This is the same primitive Goal-17's `git://…` model registry needs** for fast file-at-ref reads — landing it here unblocks both goals.
- `git-repo-utils.ts` + `git-utils.ts` — small repo-discovery and ref-validation helpers.

**`git/repository-service.ts` / `repository-git-provider.ts` / `workspace-git-provider.ts`.** Higher-level services keyed on `(projectId, workspaceId)`. Combine status + branches + remotes + ahead/behind into one cached snapshot. Coalesce concurrent refresh requests.

**`git/git-watcher-registry.ts`.** Watches `.git/refs/**`, `.git/HEAD`, `.git/index`, `.git/config` and emits `gitRefChangedChannel` / `gitWorkspaceChangedChannel`. The invalidation source for everything downstream (PR scheduler, model registry, status views).

**`git/git-fetch-service.ts`.** Wraps `git fetch` with a serialized queue per remote + retry on auth failure.

**`git/remote-helper.ts` + `git/controller.ts`.** The RPC surface — every renderer call goes through here. Standard `Result<T, E>` envelope.

**`github/` — the auth + API client layer.**

- `gh-cli-token.ts` — reads a token from the `gh` CLI's keychain (`gh auth token`). **Zero infra path.**
- `github-connection-service.ts` — combines `gh-cli-token` + a manually-saved token (secure storage); answers `getStatus()` with `{authenticated, user, tokenSource}`.
- `octokit-provider.ts` — `getOctokit(): Octokit` factory using whichever token is available.
- `pr-queries.ts` — GraphQL strings: `SYNC_PRS_QUERY`, `INCREMENTAL_SYNC_PRS_QUERY`, `GET_PR_BY_NUMBER_QUERY`, `GET_PR_CHECK_RUNS_BY_URL_QUERY`. PR data fetched via GraphQL (one round trip for the whole tree); mutations (create/merge/markReady) go via REST.
- `issue-service.ts` + `repo-service.ts` — issue + repo metadata fetches (out of immediate scope but the same pattern).

**`pull-requests/` — the sync engine.**

- `pr-sync-engine.ts` (1100 LOC, the heart). Public surface:
  - `forceFullSync(repositoryUrl)` — paginates `SYNC_PRS_QUERY`; upserts into `pull_requests` + related tables; emits `prSyncProgressChannel` rows.
  - `sync(repositoryUrl)` — incremental sync; uses `INCREMENTAL_SYNC_PRS_QUERY` with a `since` cursor stored in KV.
  - `syncSingle(repositoryUrl, prNumber)` — one PR; used after create/merge to refresh.
  - `syncChecks(pullRequestUrl, headRefOid)` — per-PR check-run sync via GraphQL.
  - `syncUsers(repositoryUrl)` — backfill user metadata.
  - `createPullRequest({repositoryUrl, head, base, title, body, draft})` — REST POST. Returns `{url, number}`.
  - `mergePullRequest(repositoryUrl, prNumber, {strategy, commitHeadOid})` — REST PUT. Returns `{sha, merged}`.
  - `markReadyForReview(repositoryUrl, prNumber)` — REST mutation.
  - `getPullRequestFiles(repositoryUrl, prNumber)` — REST list-files.
  - `cancel(repositoryUrl)` — abort in-flight sync.
- `pr-sync-scheduler.ts` (194 LOC). Lifecycle hooks: on `projectOpened` triggers full sync; light interval polling per project; on `task:provisioned` triggers single-PR refresh for the task's branch; on `git.ref.changed` (config) re-reads the remote list.
- `pr-query-service.ts` (255 LOC). DB-only reader. `listPullRequests(projectId, options)` (filters + sort + pagination + search), `getFilterOptions(projectId)`, `getTaskPullRequests(projectId, taskBranch, repositoryUrl)`, `getProjectRemoteInfo(projectId)` → `{status: 'ready' | 'no-github' | 'parse-error', repositoryUrl}`.
- `project-remotes-service.ts` (48 LOC). Diffs the live `git remote -v` output against the `project_remotes` SQLite table and upserts. Called on every task provision + `.git/config` change.
- `pr-utils.ts` (91 LOC). `assemblePullRequest(row, author, labels, assignees, checks)` — pure DB-row → `PullRequest` mapper.
- `controller.ts` (243 LOC). RPC surface: `listPullRequests`, `getFilterOptions`, `getPullRequestsForTask`, `forceFullSyncPullRequests`, `syncPullRequests`, `refreshPullRequest`, `syncChecks`, `cancelSync`, `createPullRequest`, `mergePullRequest`, `markReadyForReview`, `getPullRequestFiles`. Wraps every call in `Result<T, PullRequestError>`.

### 1.3 — Renderer surfaces

Mostly view code, two interesting pieces:

- **`state/use-check-runs.ts` (20 LOC)** — a tiny but load-bearing hook. Takes a `PullRequest`, returns `{checks, summary, allComplete, hasFailures}` (summary computed by `computeCheckRunsSummary`). **Fires `rpc.pullRequests.syncChecks(pr.url, pr.headRefOid)` on every mount.** That's how the renderer keeps check-runs fresh without per-row polling.
- **`pr-entry/checks-list.tsx` (104 LOC)** — bucket-sorted check list (`fail | pending | pass | skipping | cancel`). Each row: icon, name, app/workflow subtitle, duration, click → opens external URL. Uses `computeCheckBucket` and `formatCheckDuration` from `@renderer/utils/github`.
- **`use-branch-selection.test.ts`** — the unit-test that pins the `useBranchSelection` contract: takes a pre-resolved `Branch | undefined`, doesn't do string-to-Branch resolution itself. Resolution lives in `RepositoryStore.defaultBranch` (a computed getter). Worth keeping the same split when porting.

Other renderer pieces (out of scope for the P0 audit but listed for completeness): `stores/git-store.ts` (workspace-scoped MobX store with `fileChanges`, `stagedFileChanges`, `unstagedFileChanges`, ahead/behind, `stageFiles`, `unstageFiles`, `discardFiles`, optimistic updates); `changes-panel/*` (changed-files tree, staged/unstaged sections); `pr-entry/*` (PR header, commits list, files list, merge footer, create-PR modal).

---

## §2 — Solid + Effect port targets

| Reference                                                | Port target                                                | Notes                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/git.ts`                                      | `packages/contracts/src/git.ts` (new)                      | Types port verbatim. Error unions become Effect taggable errors so they fit `Effect.Effect<T, GitError>`.                                                                                                                                                                                                                          |
| `src/shared/git-utils.ts`                                | `packages/contracts/src/git-utils.ts`                      | Pure helpers — copy.                                                                                                                                                                                                                                                                                                               |
| `src/shared/github.ts`                                   | `packages/contracts/src/github.ts`                         | Copy minus the device-code envelope if we skip that auth path (see §5).                                                                                                                                                                                                                                                            |
| `src/shared/github-repository.ts`                        | `packages/contracts/src/github-repository.ts`              | Pure URL parser — copy.                                                                                                                                                                                                                                                                                                            |
| `src/shared/pull-requests.ts`                            | `packages/contracts/src/pull-requests.ts`                  | Copy. Error union becomes a tagged-error class hierarchy for Effect.                                                                                                                                                                                                                                                               |
| `src/shared/events/gitEvents.ts`                         | New WS frame types in the daemon's bus                     | Map `gitRefChangedChannel` → `git.ref.changed` frame on `/ws/events`; `gitWorkspaceChangedChannel` → `git.workspace.changed`. Goal-17 already specs these.                                                                                                                                                                         |
| `src/shared/events/githubEvents.ts`                      | Skip for MVP                                               | Device-code auth is a P3 polish item; the `gh` CLI delegation path covers P1/P2.                                                                                                                                                                                                                                                   |
| `src/main/core/git/impl/git-service.ts`                  | `packages/daemon/src/git/git-service.ts` (new)             | Same shape — child_process spawn wrapper. Replace `Result<T, E>` plumbing with Effect's `Effect.Effect<T, GitError>`.                                                                                                                                                                                                              |
| `src/main/core/git/impl/status-parser.ts`                | `packages/daemon/src/git/status-parser.ts`                 | Pure parser — port verbatim with tests.                                                                                                                                                                                                                                                                                            |
| `src/main/core/git/impl/cat-file-batch.ts`               | `packages/daemon/src/git/cat-file-batch.ts`                | **Land first** — Goal-17's model registry needs this for `git://` URI fetches.                                                                                                                                                                                                                                                     |
| `src/main/core/git/git-watcher-registry.ts`              | `packages/daemon/src/git/watcher.ts`                       | Use the daemon's existing `@parcel/watcher` instead of `chokidar`. Same FS-path set (`.git/refs/**`, `HEAD`, `index`, `config`). Emits via the existing `broadcastChatEvent`-style WS bus (extend with a `git.*` frame channel).                                                                                                   |
| `src/main/core/git/git-fetch-service.ts`                 | `packages/daemon/src/git/fetch-service.ts`                 | Per-remote serialized queue — direct port.                                                                                                                                                                                                                                                                                         |
| `src/main/core/git/repository-service.ts` + providers    | `packages/daemon/src/git/repository-service.ts`            | Collapse the per-workspace + per-project providers into one service indexed by `(sessionName, dir)` — tmux-ide doesn't have the worktree concept, just sessions.                                                                                                                                                                   |
| `src/main/core/github/gh-cli-token.ts`                   | `packages/daemon/src/github/gh-cli-token.ts`               | **The recommended P1 auth path.** Shells out to `gh auth token`.                                                                                                                                                                                                                                                                   |
| `src/main/core/github/octokit-provider.ts`               | `packages/daemon/src/github/octokit-provider.ts`           | Same — needs `@octokit/rest` + `@octokit/graphql`.                                                                                                                                                                                                                                                                                 |
| `src/main/core/github/pr-queries.ts`                     | `packages/daemon/src/github/pr-queries.ts`                 | GraphQL strings — copy verbatim.                                                                                                                                                                                                                                                                                                   |
| `src/main/core/pull-requests/pr-sync-engine.ts`          | `packages/daemon/src/pull-requests/sync-engine.ts`         | Big port. Replace Drizzle with the daemon's filesystem-first cache OR adopt `better-sqlite3` (already in deps) for the PR cache specifically. Recommend SQLite — the join shapes (PR + author + labels + assignees + checks) don't fit a JSON file model cleanly.                                                                  |
| `src/main/core/pull-requests/pr-sync-scheduler.ts`       | `packages/daemon/src/pull-requests/scheduler.ts`           | Maps onto tmux-ide events: session-mounted → full sync; periodic interval; `git.ref.changed (config)` → remote refresh. No `task:provisioned` hook needed (tmux-ide has no equivalent today).                                                                                                                                      |
| `src/main/core/pull-requests/pr-query-service.ts`        | `packages/daemon/src/pull-requests/query-service.ts`       | Direct port with SQLite.                                                                                                                                                                                                                                                                                                           |
| `src/main/core/pull-requests/project-remotes-service.ts` | `packages/daemon/src/pull-requests/remotes-service.ts`     | Direct port.                                                                                                                                                                                                                                                                                                                       |
| `src/main/core/pull-requests/pr-utils.ts`                | `packages/daemon/src/pull-requests/utils.ts`               | DB-row mapper — direct port.                                                                                                                                                                                                                                                                                                       |
| `src/main/core/pull-requests/controller.ts`              | New actions registered on `/api/v2/action/pr.*`            | Each method becomes a daemon action with a Zod-validated contract in `packages/contracts/src/actions-contract.ts`. The `Result<T, E>` envelope already matches the daemon's `{ok, result}` / `{ok:false, error}` shape — drop-in.                                                                                                  |
| **Renderer side**                                        | `dashboard/src/lib/git/` + `dashboard/src/components/git/` | Solid stores wrap an Effect.Service per the Goal-17 pattern. `git-store.ts` becomes a per-session createStore with the same getters (`fileChanges`, `stagedFileChanges`, ahead/behind). `use-check-runs.ts` becomes a Solid `createResource` keyed on `(pr.url, pr.headRefOid)` that triggers `rpc.pr.syncChecks` on first access. |

**Tagged errors are the key win.** The reference code threads `Result<T, GitError>` through every layer; Effect does the same thing with stronger composition. Mapping is mechanical:

```ts
// Reference:
// async push(...): Promise<Result<void, PushError>>;

// Port:
push(...): Effect.Effect<void, PushError, GitClient>;
```

`PushError`'s discriminated union (`'rejected' | 'auth_failed' | 'no_remote' | 'hook_rejected' | 'network_error' | 'error'`) becomes a set of tagged-error classes via `Data.TaggedError`. Consumers narrow with `Effect.catchTag('auth_failed', …)`.

---

## §3 — Daemon-side needs

What tmux-ide's daemon already has vs. what's new.

### Already present

- `child_process` shell-out infra (used by tmux + codex).
- `@parcel/watcher` (used by widget HMR and file-tree).
- WS bus over `/ws/events` with multi-frame typing.
- `better-sqlite3` in deps (used by daemon's persistence layer for chat).
- Action-dispatch surface with Zod-validated contracts (the `chat.thread.*` actions are the template).
- Existing `/api/project/:name/{files,diff,preview}` routes (read-side coverage for the simple cases).

### What we need to add

**Endpoints / actions:**

1. **`git.status.get`** action — returns `FullGitStatus`. Coalesced refresh: concurrent requests share one in-flight promise.
2. **`git.branches.list`** action — `LocalBranchesPayload` + `RemoteBranchesPayload`.
3. **`git.diff`** action — accepts `{ session, range?: MergeBaseRange, mode?: DiffMode, files? }`, returns `DiffResult`. Supersedes the existing string-based `/api/project/:name/diff/:file`.
4. **`git.commit`** / **`git.push`** / **`git.pull`** / **`git.fetch`** / **`git.checkout`** / **`git.create-branch`** / **`git.rename-branch`** / **`git.delete-branch`** / **`git.soft-reset`** — typed actions; each returns the matching error union from `git.ts` on failure.
5. **`git.stage`** / **`git.unstage`** / **`git.discard`** — file-path-list actions for the changes panel.
6. **`git.cat-file`** action OR REST `GET /api/project/:name/git/file?ref=<ref>&path=<file>` — Goal-17 needs this too. Backed by the long-lived `cat-file --batch` process for fast repeated reads.
7. **`pr.list`** action — `ListPrOptions` in, paginated PR list out.
8. **`pr.get-filter-options`** action — author/label/assignee unions for the filter UI.
9. **`pr.refresh`** action — single-PR re-sync.
10. **`pr.sync`** / **`pr.force-full-sync`** / **`pr.cancel`** — sync triggers.
11. **`pr.sync-checks`** action — per-check refresh (the hot path; called every time the user views a PR).
12. **`pr.create`** / **`pr.merge`** / **`pr.mark-ready`** — mutations.
13. **`pr.get-files`** action — list changed files for a PR.
14. **`github.status`** action — `{authenticated, user, tokenSource}`.
15. **`github.connect-with-cli`** action — read `gh auth token`, verify with `/user`.

**WS frames (new types on `/ws/events`):**

- `git.ref.changed` (project + workspace + kind + optional changedRefs).
- `git.workspace.changed` (project + workspace + kind: `index | head`).
- `pr.sync.progress` (`PrSyncProgress`).
- `pr.updated` (`{repositoryUrl, prNumber}`).

**Daemon storage:**

- One SQLite DB per session for the PR cache: `${session.dir}/.tmux-ide/pr-cache.sqlite`. Schema mirrors the reference codebase: `pull_requests`, `pull_request_users`, `pull_request_labels`, `pull_request_assignees`, `pull_request_checks`, `project_remotes`, plus a `kv` table for sync cursors. Use `better-sqlite3` (already in deps) — no Drizzle, just hand-rolled prepared statements; the join shapes are small.
- Project-scoped, so deleting `.tmux-ide/` resets the cache cleanly.

**External deps:**

- `@octokit/rest` + `@octokit/graphql` — new.
- `@octokit/request-error` — new (already used by the reference codebase for error classification).
- That's it. No new system deps; `gh` CLI is user-provided.

**Rate limiting + retry:**

- The reference codebase has `@main/lib/rate-limiter` + `@main/lib/retry`. Port both — they're small (~150 LOC together) and the PR sync engine relies on them.

### What we explicitly DON'T need

- Drizzle ORM — the schema is small and stable enough for prepared statements.
- A separate background process — the daemon already runs continuously per session.
- A migration framework — the cache is rebuildable from GitHub on demand; ship-with-version + drop-on-mismatch is enough.

---

## §4 — Phases

Three phases, scoped to deliver value incrementally. The Goal-17 editor port can run in parallel — they share the `cat-file-batch` primitive but otherwise don't interfere.

### G18-P1 — Git core (~3 days)

Scope: typed git ops + status + branches + commits + ahead/behind + watcher → WS broadcast.

Files (target paths):

- `packages/contracts/src/git.ts`, `git-utils.ts` — shared types + helpers (port verbatim).
- `packages/contracts/src/actions-contract.ts` — register `git.*` action contracts.
- `packages/daemon/src/git/{git-service,status-parser,cat-file-batch,fetch-service,repository-service,watcher}.ts` — daemon impl with Effect error channels.
- `packages/daemon/src/command-center/actions/handlers/git-actions.ts` — RPC handlers.
- `packages/daemon/src/command-center/server.ts` — extend WS bus to emit `git.ref.changed` + `git.workspace.changed`.
- `dashboard/src/lib/git/` — Solid stores wrapping the actions. Per-session `gitStore` with reactive `fileChanges` / `branches` / `ahead`/`behind` driven by the WS frames.
- `dashboard/src/components/git/ChangesPanel/` — port `changes-panel/*` to Solid (stage / unstage / discard / commit UI).

Acceptance:

- Status updates within ~50ms of an external `git add` / `git commit` in a terminal.
- All ten error unions surface to the UI with intent-specific messages (auth_failed shows "Sign in to GitHub", `rejected` shows the rejection text, etc).
- `cat-file-batch` ships and Goal-17 can use it.

**Effort:** ~24 hours.

### G18-P2 — GitHub auth + PR sync engine (~4 days)

Scope: `gh` CLI delegation auth + PR sync engine + query service + scheduler + RPC surface.

Files:

- `packages/contracts/src/pull-requests.ts`, `github.ts`, `github-repository.ts` — shared types.
- `packages/daemon/src/github/{gh-cli-token,octokit-provider,connection-service,pr-queries}.ts`.
- `packages/daemon/src/pull-requests/{sync-engine,scheduler,query-service,remotes-service,utils}.ts`.
- `packages/daemon/src/pull-requests/schema.sql` + SQLite migrations (drop-on-mismatch).
- `packages/daemon/src/command-center/actions/handlers/pr-actions.ts` — 12 actions.
- WS frames: `pr.sync.progress`, `pr.updated`.
- `dashboard/src/lib/pr/` — Solid stores; PR list + filter UI.
- `dashboard/src/components/pr/PrEntry/` — header, commits list, files list, merge footer, create-PR modal.

Auth path: only `gh` CLI delegation. If `gh auth token` returns a token, we're authenticated. If not, show a banner with "Run `gh auth login` to enable PR features". Defer device-code + secure-storage to P3.

Acceptance:

- Open a project with a GitHub remote → PR list populates within seconds.
- Create / merge / mark-ready works against a real repo.
- Per-row check status is fresh on PR open (the `syncChecks` mount hook is critical).
- Sync errors surface via the `PullRequestError` union (`remote_not_ready`, `auth_failed`, etc).

**Effort:** ~32 hours.

### G18-P3 — CI check-runs view + polish (~1 day)

Scope: the check-runs panel + the device-code auth fallback (for users without `gh` CLI).

- Port `state/use-check-runs.ts` → `dashboard/src/lib/pr/use-check-runs.ts` (Solid `createResource` triggering `pr.sync-checks`).
- Port `pr-entry/checks-list.tsx` → `ChecksList.tsx` (Solid).
- Port `@renderer/utils/github` — `computeCheckBucket`, `formatCheckDuration`, `computeCheckRunsSummary`. Small, pure.
- (Optional) `github/device-code-auth.ts` — fallback when `gh` CLI is absent. Drives the `githubAuth*` WS frame sequence.

Acceptance: clicking a PR shows its checks bucketed (fail → pending → pass → skipping → cancel) within 1 RTT; clicking a row opens the workflow URL.

**Effort:** ~8 hours (no device code) or ~16 hours (with device code).

### Totals

| Phase                         | Scope                        | Effort                     |
| ----------------------------- | ---------------------------- | -------------------------- |
| G18-P1                        | Git core                     | ~24 h                      |
| G18-P2                        | GitHub auth + PR sync engine | ~32 h                      |
| G18-P3                        | CI checks panel              | ~8 h                       |
| **Total (gh-CLI auth only)**  |                              | **~64 h (~8 person-days)** |
| **With device-code fallback** |                              | **~72 h (~9 person-days)** |

---

## §5 — Open questions

1. **Auth path.** Recommendation: **start with `gh` CLI delegation only.** Reasons:
   - Zero infra: no token storage, no device-code flow, no OAuth app registration.
   - Most users who'd use a Git/PR feature already have `gh` configured.
   - The reference codebase's `gh-cli-token.ts` is ~50 LOC and already supports this exact path — it ports verbatim.
   - Falling back to a PAT-in-settings is a 30-line addition if we need it later.
   - Device-code OAuth is the most user-friendly but takes 2–4 person-days to land safely. Defer to P3 as an optional polish.
2. **PR cache storage.** SQLite (`better-sqlite3`) for the cache vs. JSON files? Recommend SQLite: the relational joins (PR ↔ author ↔ labels ↔ assignees ↔ checks) don't fit JSON cleanly, and we already ship the dep. Scope the schema to one DB per session (`.tmux-ide/pr-cache.sqlite`); drop on version mismatch instead of running migrations.
3. **Sync cadence.** The reference scheduler does `full → light interval (60s) → single on event`. Recommend the same with a longer base interval (5 min) for tmux-ide — sessions are longer-lived and GitHub's secondary rate limit matters more here.
4. **Worktree concept.** The reference codebase models projects + worktrees; tmux-ide models sessions + dir. The port collapses `(projectId, workspaceId)` to `(sessionName, dir)` — single dimension. Confirm before P1 that the user doesn't want a future tmux-ide multi-worktree feature; if they do, leave the two-dimension shape.
5. **Optimistic UI for stage/unstage/discard.** The reference's `git-store._applyOptimistic` is load-bearing for UX. Solid's `createStore` + `produce` makes this easy but adds complexity to the test surface. Recommend landing P1 without optimistic updates (just refetch after the action resolves) and adding optimism as a P3 polish item if the watcher latency feels slow.
6. **GitHub Enterprise.** Out of scope. The reference codebase doesn't explicitly support GH Enterprise either; `Octokit({baseUrl})` would be a future addition.
7. **GitLab / Bitbucket.** Out of scope. The reference codebase has a `gitlab/` directory stub but the PR engine is GitHub-only. Same posture here.
8. **Comments / reviews.** Out of scope for G18. The reference codebase has a substantial review surface (`diff-view/comments/` with Monaco-embedded comment widgets) — that's its own goal, post-G18.
9. **Rate limit handling.** The reference codebase has a per-app rate limiter and `withRetry` wrapper. Port both. The PR sync engine fails closed (returns `sync_failed`) on 429 with exponential backoff retries — preserve this behavior.

---

## TL;DR

The reference codebase's git + PR layer is structurally ready for a Solid+Effect port: pure shared types in `src/shared/`, daemon-side services in `src/main/core/{git,github,pull-requests}/`, and a renderer surface that's mostly view code. **~8 person-days** total for the full port if we delegate auth to the user's `gh` CLI.

**Top three hardest things to port:**

1. **`pr-sync-engine.ts` (1100 LOC)** — GraphQL queries, paginated upserts into SQLite, rate-limited retries, three sync modes (full / incremental / single), mutations (create / merge / mark-ready), check-run sync, cancel support. Two solid days.
2. **The `gitWatcherRegistry` + WS-bus integration** — small file (~150 LOC) but the path patterns (`.git/refs/**`, `HEAD`, `index`, `config`) are subtle and the downstream consumers (PR scheduler, Goal-17 model registry) depend on it firing cleanly. Wrong → silent staleness.
3. **The 10+ git-op error unions** — `FetchError`, `PushError`, `PullError`, `CommitError`, `SoftResetError`, `CreateBranchError`, `RenameBranchError`, `DeleteBranchError`, `FetchPrRefError`, `FetchPrForReviewError`. Mechanical mapping to Effect tagged errors but every union has nuanced cases (e.g. `PushError.hook_rejected` carries the hook output text) that the UI surface needs to handle correctly. Easy to under-spec; budget time to walk each error path through the UI before shipping.

The single biggest leverage point: **landing `cat-file-batch` in G18-P1 unblocks Goal-17's `git://` model registry.** Goal-17 and Goal-18 share that primitive — sequencing G18-P1 first (or in parallel with G17-P1) saves a duplicate implementation.
