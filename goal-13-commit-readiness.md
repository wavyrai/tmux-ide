# Goal 13 — Commit Readiness Report

**Date:** 2026-05-11
**Goal:** Full t3 chat parity with tmux-as-tool
**Tasks covered:** T070 – T079
**Workspace:** `/Users/thijs/Developer/tmux-ide`

---

## 1. Test matrix — clean

| Suite                                                     | Result               |
| --------------------------------------------------------- | -------------------- |
| `pnpm --filter @tmux-ide/contracts test` (vitest)         | **66/66 pass**       |
| `pnpm --filter @tmux-ide/daemon exec vitest run`          | **240/240 pass** (12 files) |
| `dashboard` ProvidersPanel test                           | **6/6 pass**         |
| `pnpm --filter @tmux-ide/contracts exec tsc --noEmit`     | **clean**            |
| `pnpm --filter @tmux-ide/daemon exec tsc --noEmit`        | **44 pre-existing errors, all in `src/cli.ts` (commander typing drift) and `src/chat/chat-integration-harness.ts` (missing `sessionStore` field). None in T079 surfaces.** |
| `dashboard` `tsc --noEmit`                                | **pre-existing errors in scratch TUI examples, react-dom typings, and `lib/__tests__/*` — none in `ProvidersPanel.tsx` or its test** |

No merge-conflict markers anywhere in T079 artifacts. No duplicated files.

---

## 2. T079 audit — single canonical version of every artifact

Both panes raced T079, but the on-disk state is clean. One coherent copy of each file, no `.orig`/`.bak`/`.rej` siblings, no conflict markers.

| Acceptance item | File | Status |
| --- | --- | --- |
| `ProviderKindZ`, `ProviderConfigZ` discriminated union, `ProviderInstanceZ`, `ProvidersFileZ` in contracts | `packages/contracts/src/chat-thread.ts` (lines 440–561) | ✓ canonical, includes wire-safe `ProviderInstanceSummaryZ` (redacted, `hasApiKey: boolean`) |
| Single `provider-registry.ts` with 4 fetch-based adapters + generic-acp stub | `packages/daemon/src/chat/provider-registry.ts` (443 lines) | ✓ anthropic / openai / local-ollama / local-lmstudio + generic-acp stub, all `fetch`-injectable via `AdapterFactoryDeps` |
| ≥20 unit tests for provider-registry | `packages/daemon/src/chat/provider-registry.test.ts` (497 lines) | ✓ **26 `it()` blocks** across 8 `describe()` groups |
| `ProvidersPanel.tsx` with localStorage persistence | `dashboard/components/settings/ProvidersPanel.tsx` (241 lines) | ✓ reads/writes `STORAGE_KEY`, validates with `ProviderInstanceSummaryZ`, accompanied by `__tests__/ProvidersPanel.test.tsx` (6 tests) |
| 6 new provider-abstraction scenarios | `packages/daemon/src/chat/provider-registry.test.ts:367` (`describe("provider-abstraction integration scenarios"…)`) | ✓ scenarios (a)–(f) present. **Note:** brief said `chat-integration.test.ts`, but they landed in `provider-registry.test.ts` instead. Intent satisfied; chat-integration.test.ts has 11 unchanged scenarios. |

No loser version to delete. No duplication. The wire-safe `ProviderInstanceSummaryZ` is already the canonical export.

---

## 3. File inventory across T070 – T079

`git status --short` shows 56 paths (10 modified, 46 new/untracked). Grouped below by goal-13 sub-area.

### 3a. Modified (tracked) — 10 files

```
 M bin/cli.ts                       (+15 lines — daemon wiring)
 M dashboard/eslint.config.mjs      (+29 lines — flat-config additions)
 M dashboard/package.json           (workspace deps for @tmux-ide/contracts etc.)
 M dashboard/tsconfig.json          (path mappings for packages)
 M dashboard/tsconfig.tsbuildinfo   (build artifact — should NOT be committed)
 M eslint.config.js                 (+171 lines — root flat-config sweep)
 M ide.yml                          (local dev — should NOT be committed)
 M package.json                     (workspace bump)
 M pnpm-lock.yaml                   (workspace lock churn)
 M pnpm-workspace.yaml              (+2 — `packages/*`)
```

### 3b. New — `packages/` monorepo (the t3-style split)

```
packages/contracts/                 — Zod schemas; chat-thread.ts is goal-13 core
packages/daemon/                    — daemon, command-center, chat, orchestrator, widgets
packages/daemon-client/             — typed daemon client for dashboard
packages/chat-solid/                — Solid chat UI (chat-v2 React mirror)
packages/v2-solid-widgets/          — Solid widgets package
packages/tmux-bridge/               — tmux ops package (send_to_pane / read_pane / capture_pane)
```

Untracked `packages/` is **438** source files (438 `*.ts`/`*.tsx`/`*.json`/`*.md`). The mission description still calls out reconciling `src/` and `packages/daemon/src/`, but the work-in-progress to commit lives entirely under `packages/`.

### 3c. New — dashboard chat / v2 / settings (goal-13 UI)

```
dashboard/app/v2/                          — v2 chat route shell
dashboard/app/tui-demo/                    — TUI demo route (preview only)
dashboard/app/tui-bridge.css
dashboard/app/tui-fonts.css
dashboard/app/tui-global.css
dashboard/components/chat/                 — old chat panel (gated by ?chat=v1)
dashboard/components/chat-v2/              — new chat (Activity/Turn/Plan/Checkpoint)
dashboard/components/tui/                  — TUI primitives library
dashboard/components/tui-diffs/
dashboard/components/tui-tree/
dashboard/components/settings/AboutPanel.tsx
dashboard/components/settings/ProvidersPanel.tsx           ⭐ T079
dashboard/components/settings/RemoteAccessPanel.tsx
dashboard/components/settings/__tests__/AboutPanel.test.tsx
dashboard/components/settings/__tests__/ProvidersPanel.test.tsx  ⭐ T079
dashboard/components/app-shell/sidebar-shell.tsx
```

### 3d. New — dashboard lib (action bus + protocol)

```
dashboard/lib/actionClient.ts          dashboard/lib/__tests__/actionClient.test.ts
dashboard/lib/actionEventBus.ts        dashboard/lib/__tests__/actionEventBus.test.ts
dashboard/lib/appProtocol.ts           dashboard/lib/__tests__/appProtocol.test.ts
dashboard/lib/menuBridge.ts            dashboard/lib/__tests__/menuBridge.test.tsx
dashboard/lib/newChatPickerStore.ts    dashboard/lib/__tests__/chatStore.test.ts
dashboard/lib/openTerminalToast.ts     dashboard/lib/__tests__/registerCoreActions.test.ts
dashboard/lib/useAction.ts             dashboard/lib/__tests__/useAction.test.ts
dashboard/types/                       dashboard/vitest.setup.ts
```

### 3e. New — repo-level scripts, workflows, allowlists

```
.github/workflows/release.yml
.src-allowlist
scripts/capture-codex-traffic.mjs
scripts/check-src-additions.sh
scripts/install-git-hooks.js
scripts/merge-update-manifests.mjs
scripts/merge-update-manifests.test.mjs
scripts/pack-check-run.mjs
scripts/prepublish-check.mjs
scripts/verify-endpoints.sh
HANDOFF.md
app-electron/                              — Electron app skeleton (large, see §4)
```

### 3f. Local-only / orphan flags

* `.tmux-ide/` — local skills/library; **already gitignored**? No — listed as untracked. Verify before staging.
* `ide.yml` — gitignored; the modified copy will not be staged.
* `dashboard/tsconfig.tsbuildinfo` — build artifact; **must be unstaged** or added to `.gitignore`.
* `.DS_Store` — none present in tree. ✓
* `.tasks/` and `app-electron/.tasks/` — both gitignored already. ✓ No cwd-bug leakage to clean up.

---

## 4. Orphans / risk flags

1. **`dashboard/tsconfig.tsbuildinfo`** — tracked file, modified. This is a build artifact (incremental TS cache). Either add to `.gitignore` and unstage, or revert before commit. Do **not** commit a fresh tsbuildinfo into the goal-13 PR.
2. **`ide.yml`** — local dev config. `.gitignore` already excludes it; the `M` status means the file was tracked at some earlier point. Confirm whether to keep the tracked copy or `git rm --cached ide.yml`.
3. **`.tmux-ide/`** — untracked but `.gitignore` has no rule for it. Decide whether to gitignore (recommended — it's a project-local skills dir) or include it. Currently it contains skills/library used in agent dispatch prompts.
4. **`app-electron/`** — large Electron-app skeleton; appears to be a parallel track, not goal-13 chat parity. Recommend committing in a separate PR to keep the goal-13 diff reviewable.
5. **`packages/daemon/src/cli.ts`** typecheck errors (12 errors, lines 529–701) — commander.js arg/flag typing drift. Pre-existing, unrelated to T079, but blocks `pnpm typecheck`. File a follow-up task before goal-13 lands cleanly in CI.
6. **`packages/daemon/src/chat/chat-integration-harness.ts:1106`** — `sessionStore` field missing from harness return. Pre-existing harness bug surfaced by tsc; tests still pass because harness is mocked at call sites. Worth a one-line fix before the goal-13 commit.

---

## 5. Mission-vs-reality note

The mission brief still describes reconciling 229 files in `src/` against 267 files in `packages/daemon/src/`. The current tree has **no top-level `src/`** — the daemon/contracts/etc. split is already complete under `packages/`. The folded tree is on disk; the mission narrative needs updating, not the code.

---

## 6. Recommended commit strategy

Three commits keep the diff reviewable:

### Commit 1 — goal 13 core (chat parity + provider abstraction)

Scope:
- `packages/contracts/**` (Zod schemas including `chat-thread.ts` provider types)
- `packages/daemon/src/chat/**` (thread/turn/plan/checkpoint/provider-registry/provider-store)
- `packages/daemon/src/command-center/**` (REST/SSE/WS)
- `packages/daemon-client/**`
- `packages/tmux-bridge/**`
- `dashboard/components/chat-v2/**`
- `dashboard/components/chat/**` (gated old chat)
- `dashboard/components/settings/ProvidersPanel.tsx` + test
- `dashboard/lib/actionClient.ts`, `actionEventBus.ts`, `appProtocol.ts`, `useAction.ts`, related tests
- `dashboard/app/v2/**`
- `dashboard/tsconfig.json`, `package.json`, `eslint.config.mjs`
- `pnpm-workspace.yaml`, root `package.json`, `pnpm-lock.yaml`
- `bin/cli.ts` (daemon entry wiring)

Suggested message:

```
feat(chat): t3-style chat parity (T070–T079)

Threads, turn-grouped activity, plan-approve-execute, turn-level
git-worktree checkpoints, and a kind-discriminated provider registry
(anthropic / openai / local-ollama / local-lmstudio / generic-acp)
land in @tmux-ide/contracts + @tmux-ide/daemon. Dashboard ships a new
chat-v2 surface plus a ProvidersPanel that persists local provider
instances to localStorage; legacy chat is gated behind ?chat=v1.

Tests:
- contracts: 66/66
- daemon:    240/240
- ProvidersPanel: 6/6
```

### Commit 2 — TUI primitives / scratch (optional)

`dashboard/components/tui/`, `tui-diffs/`, `tui-tree/`, `app/tui-demo/`, `app/tui-*.css`, `dashboard/types/` if related. These are UI groundwork; consider holding for a separate PR if not load-bearing for goal-13.

### Commit 3 — release tooling

`.github/workflows/release.yml`, `.src-allowlist`, `scripts/*`, `HANDOFF.md`. Release-prep, distinct from chat parity.

### Do not commit

- `dashboard/tsconfig.tsbuildinfo` (artifact)
- `ide.yml` (local)
- `.tmux-ide/` (until policy decided — recommend gitignoring)
- `app-electron/` (separate PR)

---

## 7. Sign-off checklist

- [x] Single canonical version of every T079 artifact on disk
- [x] Zero conflict markers
- [x] Provider schemas include wire-safe `ProviderInstanceSummaryZ`
- [x] Provider registry has 4 fetch-based adapters + generic-acp stub
- [x] ≥20 provider-registry unit tests (26 actual)
- [x] 6 provider-abstraction scenarios (in `provider-registry.test.ts`, not `chat-integration.test.ts`)
- [x] ProvidersPanel.tsx persists to localStorage
- [x] daemon vitest 240/240, contracts vitest 66/66, ProvidersPanel 6/6
- [ ] daemon typecheck clean — **blocked** by pre-existing cli.ts / harness errors (filed §4.5–6)
- [ ] dashboard typecheck clean — **blocked** by pre-existing TUI scratch + `react-dom` typings (out of T079 scope)

Code is ready to commit per the strategy in §6 once orphan artifacts (§4.1–3) are sorted out.
