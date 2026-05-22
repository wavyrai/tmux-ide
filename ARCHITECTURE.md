# Architecture

`tmux-ide` is a CLI tool that turns any project into a tmux-powered terminal IDE plus a single-page web dashboard. It runs as a long-lived **daemon** (Node + Effect + Hono) with a **Solid SPA** dashboard and **TUI widgets** rendered inside tmux panes.

This document is the **single source of truth** for how the codebase is structured, which libraries we use for each concern, and where we deliberately diverge from the reference codebases under `context/`.

---

## §1 — North star: opencode (Solid + Effect), with emdash IDE patterns folded in

We anchor on **`context/opencode`** as the architectural model. Opencode is a working Solid + Effect monorepo IDE with the same shape we want: Solid UI packages on top of an Effect core, Vite everywhere, contracts package, sqlite via Effect SQL. We pull IDE features (Monaco, git, multi-terminal, three-way merge) from **`context/emdash`**, but we adopt them in the opencode style — Solid signals + Effect services, not MobX + Electron IPC.

### Reference codebases under `context/` (read-only)

| Reference                              | Stack                                                  | What we take                                                                                                                         | What we ignore                                                    |
| -------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **opencode** ⭐                        | Solid + Effect + Vite + Kobalte + Tailwind v4 + sqlite | Core architectural shape, monorepo layout, LSP-as-tool pattern, UI primitives via Kobalte, contracts split, atom/Effect state        | Their Slack/SST infra, marketing site                             |
| **emdash**                             | Electron + React + MobX + Drizzle                      | Monaco pool/lease/registry, git ops, multi-terminal registry, `@parcel/watcher` + `WATCH_IGNORED_NAMES`, three-way merge UI patterns | Electron main/renderer split, IPC, MobX class stores, React hooks |
| **t3code**                             | Vite + React 19 + TanStack Router + Effect             | Original chat semantics (now self-contained in `chat-solid`)                                                                         | React, TanStack Router, MobX-style data layer                     |
| dmux, pierre, smfs, supermemory, wterm | various                                                | Surgical pattern lookups only                                                                                                        | Whole architectures                                               |

**Rule:** when adding a new feature, check opencode first for the structural answer; check emdash for the IDE-specific behavior; only borrow from t3 chat semantics that we already have.

---

## §2 — Stack (locked in)

| Layer                | Choice                                                                              | Mirrors                                                                        |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Frontend framework   | **Solid.js** + **`@solidjs/router`** + **`@solidjs/meta`**                          | opencode `packages/app`                                                        |
| UI primitives        | **Kobalte** (planned migration; some Base UI today)                                 | opencode `packages/ui`                                                         |
| Build tool           | **Vite 6** + `vite-plugin-solid`                                                    | opencode + emdash                                                              |
| Styling              | **Tailwind v4** (`@tailwindcss/vite`)                                               | opencode + emdash                                                              |
| Async / DI / runtime | **Effect 3.x**                                                                      | opencode `packages/core` + t3                                                  |
| State (browser)      | **Solid signals + stores**; Effect for async services                               | opencode (mostly signals; Effect at boundaries)                                |
| HTTP server          | **Hono**                                                                            | own choice — small, fast, Effect-friendly                                      |
| WS server            | **`ws`**                                                                            | own choice                                                                     |
| Persistence          | **better-sqlite3** + **Drizzle**                                                    | emdash (Drizzle); opencode uses `@effect/sql-sqlite-bun` — we may revisit      |
| Validation           | **Zod**                                                                             | own choice (opencode uses Effect Schema in places — possible future migration) |
| FS watching          | **`@parcel/watcher`** + emdash's `WATCH_IGNORED_NAMES`                              | emdash                                                                         |
| Repo search          | **`@vscode/ripgrep`**                                                               | emdash                                                                         |
| LSP client           | **`vscode-jsonrpc` + `vscode-languageserver-protocol`** + opencode's launch pattern | opencode                                                                       |
| PTY                  | **`node-pty`** behind a `PtyAdapter`                                                | own design (informed by emdash terminals)                                      |
| Editor               | **Monaco** via pool + lease + model-registry                                        | emdash                                                                         |
| Terminal embed       | **xterm.js** + `addon-fit` + `addon-webgl`                                          | emdash + opencode                                                              |
| TUI rendering        | **OpenTUI / Solid-TUI**                                                             | own (no reference uses TUI alongside DOM)                                      |
| Tests                | **Vitest**                                                                          | opencode (vitest), emdash (vitest), t3 (vitest)                                |
| Lint / format        | **ESLint flat config** + **Prettier**                                               | own (opencode uses oxlint/oxfmt — possible future migration)                   |
| Package manager      | **pnpm** + workspaces                                                               | own (opencode uses pnpm too)                                                   |
| Runtime              | **Node 20+** for daemon and CLI; **Bun** only for OpenTUI widget entrypoints        | own (opencode is mostly Bun — we keep Node for npm distribution; G22-P0)       |
| CI                   | **GitHub Actions** — single `release.yml` + `smoke.yml`                             | own                                                                            |

**Anti-stack** (do not reintroduce):

- React, React-DOM, Next.js, RSC bridges (deleted in G16-P4).
- MobX, Redux, or any class-based store.
- Electron — `app/` is a native Swift/SwiftUI app (in early dev); `app-electron/` is dead and pending deletion.
- Worktrees (user veto — `feedback_architecture_preferences.md`).
- Per-framework bridges (`*-bridge.tsx` for foreign frameworks). Everything UI is Solid.

---

## §3 — Package map

The repo is a pnpm workspace. The split mirrors opencode's `core` / `ui` / `app` / `contracts`.

| Our package          | opencode equivalent                         | Path                         | Role                                                                                                                                                                             |
| -------------------- | ------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **daemon**           | `@opencode-ai/core`                         | `packages/daemon/`           | Long-lived process. Hono HTTP + WS + Effect services + sqlite event store + project registry + chat orchestrator + git/search/LSP/PTY services + TUI widget entrypoints.         |
| **contracts**        | `@opencode-ai/sdk` (the contract layer)     | `packages/contracts/`        | Zod schemas for actions, WS frames, domain types. Only package both daemon and browser depend on.                                                                                |
| **chat-solid**       | `@opencode-ai/ui` (subset)                  | `packages/chat-solid/`       | Reusable Solid chat surface. `mount(node, opts) → handle`.                                                                                                                       |
| **v2-solid-widgets** | `@opencode-ai/ui` (subset)                  | `packages/v2-solid-widgets/` | Reusable Solid dashboard widgets (Activity, Costs, Diffs, Explorer, Inspector, Kanban, MissionControl, Plans, Skills, Tasks, CommandPalette). Same `mount(...)` shape.           |
| **dashboard**        | `@opencode-ai/app`                          | `dashboard/`                 | Vite + Solid SPA. Owns the route shell, the IDE chrome, and per-feature surfaces (FilesSurface, SearchView, DiffsView, TerminalSurface, …). Hosts chat-solid + v2-solid-widgets. |
| **tmux-bridge**      | (no equivalent)                             | `packages/tmux-bridge/`      | Pure functions over `tmux`. Used by daemon.                                                                                                                                      |
| **daemon-client**    | (no equivalent — opencode is single-binary) | `packages/daemon-client/`    | CLI helpers: ensure-running, lock, health probe.                                                                                                                                 |
| **bin**              | `apps/cli` analogue                         | `bin/cli.ts` → `bin/cli.js`  | The CLI entry point. esbuild-compiled.                                                                                                                                           |
| **src**              | (cleanup target)                            | `src/`                       | **Top-level CLI tests only**. The empty `src/server/` and `src/ui/web/` are pre-G16 scaffolding to delete (§7).                                                                  |

### Boundary rules

1. **`packages/contracts`** depends on nothing in this repo (only `zod`). Both daemon and browser import from it.
2. **`packages/daemon`** never imports from `chat-solid`, `v2-solid-widgets`, or `dashboard`. Browser code is opaque to it.
3. **`chat-solid` / `v2-solid-widgets`** depend only on `contracts` + Solid runtime. Never import from `dashboard`.
4. **`dashboard`** is the only package allowed to import from `chat-solid`, `v2-solid-widgets`, and to talk to the daemon over HTTP/WS.
5. **`bin/cli.ts`** orchestrates: spawn daemon, send actions, render TUI widgets. Never imports from `dashboard` or any Solid silo.

These mirror opencode's `core` ← `sdk` → `ui` → `app` dependency direction.

### Solid DOM widgets vs daemon TUI widgets — NOT duplicates

Two widget ecosystems coexist by design:

|            | Solid DOM widgets                                                                    | Daemon TUI widgets                                                                       |
| ---------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Path       | `packages/v2-solid-widgets/src/widgets/`                                             | `packages/daemon/src/widgets/`                                                           |
| Surface    | Browser at `localhost:3000`                                                          | Tmux pane (OpenTUI)                                                                      |
| Mount      | `mount(domNode, opts)`                                                               | `tmux-ide widget <name>` (spawns Bun)                                                    |
| Examples   | `KanbanBoard`, `MissionControlDashboard`, `DiffsViewer`                              | `mission-control`, `tasks`, `explorer`, `costs`, `config`, `setup`, `preview`, `changes` |
| Wired from | `dashboard/src/components/*-bridge.tsx`, `dashboard/src/routes/v2/widget/[name].tsx` | `bin/cli.ts` (`tmux-ide config`, `tmux-ide setup`) + `ide.yml` `type:` field             |

Don't merge them — same name, different runtime.

---

## §4 — Core abstractions

### 4.1 Action contract (HTTP)

All daemon writes flow through one endpoint, the same shape opencode's SDK uses:

```
POST /api/v2/action/:name
body:  <input>            (validated against contract.input)
200:   { ok: true,  result }   (validated against contract.output)
200:   { ok: false, error }    (typed app error)
4xx:   transport-level failure
```

Contracts live in [`packages/contracts/src/actions-contract.ts`](packages/contracts/src/actions-contract.ts) — a single map of `actionName → { input: ZodSchema, result: ZodSchema }`. Adding a new action: define schemas → write the handler in `packages/daemon/src/command-center/actions/handlers/` → register in `registry.ts`. The dispatcher ([`dispatcher.ts`](packages/daemon/src/command-center/actions/dispatcher.ts)) parses, validates, runs, broadcasts an `action.complete` WS frame.

There are also a handful of REST-shaped legacy endpoints (`/api/sessions`, `/api/project/:name/files`, `/api/chat/providers`, `/api/project/:name/lsp/*`, …) that serve large reads or stream files. New work goes through `/api/v2/action`.

### 4.2 WS bus

| Endpoint                      | Purpose                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/ws/events`                  | Broadcast bus for everything (`action.complete`, `chat.activity.appended`, `file.changed`, orchestrator events). |
| `/ws/mirror/:session/:paneId` | Raw ANSI mirror of a tmux pane.                                                                                  |
| `/ws/pty/:id`                 | Interactive PTY (xterm bidirectional).                                                                           |

Frame envelope is `{ type: string, ...payload }` — typed under `packages/daemon/src/schemas/ws-events.ts`.

### 4.3 Event store + projections (Goal-14)

Sqlite-backed append-only event log. Projections (`packages/daemon/src/persistence/projections/`) materialize current state. A reactor drives projection updates and broadcasts events. Consumers (chat thread manager, costs, turn-diff) read from projections, never from the raw log. This mirrors opencode's storage layer (they use `@effect/sql-sqlite-bun`; we use better-sqlite3 + Drizzle for now).

### 4.4 Effect runtime

Daemon services are Effect-typed (`Service<…>` + `Layer.merge(…)`). Service instantiation happens at daemon boot in `packages/daemon/src/runtime/`. Browser code uses Effect for the api client (`dashboard/src/lib/api.ts`) but stays light on it elsewhere — Solid signals are the dashboard's primary reactive primitive (matches opencode's app — Effect at the edges, signals in components).

### 4.5 Reactivity choices

| Where                   | Primitive                                                           | Why                                      |
| ----------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| Browser components      | Solid `createSignal`, `createStore`, `createMemo`, `createResource` | Fine-grained, no virtual DOM.            |
| Cross-component data    | Module-singleton stores (e.g. `bufferState`)                        | Avoid prop drilling.                     |
| Async fetches (browser) | `createResource` (default), `Effect.runPromise` for one-shots       | Resources retry+invalidate cleanly.      |
| Daemon state            | Effect `Ref` / `SubscriptionRef`; sqlite for durable                | All shared state behind Effect services. |
| Daemon event fanout     | Plain emitter + WS broadcast                                        | Each service exposes a typed channel.    |

### 4.6 Daemon attach contract

There is **exactly one canonical daemon per machine**. Its discovery
handle is `~/.tmux-ide/daemon.json`, written atomically on startup
(`packages/daemon/src/lib/canonical-daemon.ts`) with
`{ pid, port, version, startedAt, bindHostname, authToken }`.

Any external frontend — desktop app, editor extension, a second CLI —
**MUST**:

1. Read `~/.tmux-ide/daemon.json`.
2. Health-check the port (`GET /health`, plus a `pid` liveness check).
3. Attach as a REST/SSE/WS **client** of that daemon.

A client **MUST NOT** embed or spawn its own daemon. If the file is
absent, or present but the daemon is dead, the client should prompt the
user to launch `tmux-ide` — never silently start a competing daemon
(that splits session/registry state and races the info file).

On attach, a client compares its compiled-in expected daemon version
against `daemon.json.version` and warns on skew
(`warnOnDaemonVersionSkew`) — a mismatch means the action/WS contract
may have drifted and the canonical daemon should be restarted.

---

## §5 — Per-concern reference + divergence

For each concern: which reference informs us, what we adopt, where we deliberately diverge.

| Concern                              | Primary ref               | What we take                                                                                  | Where we diverge                                                                                                       |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **App shape** (entry, router, theme) | opencode `packages/app`   | `entry.tsx` + `app.tsx` + `pages/` layout, theme provider, `@solidjs/router`, `@solidjs/meta` | Our pages live under `dashboard/src/routes/v2/`. We don't (yet) use `@effect/atom` for state — Solid signals only.     |
| **UI primitives**                    | opencode `packages/ui`    | Kobalte for primitives, Tailwind v4, single `styles/index.css`                                | We're partway through migrating to Kobalte — some Base UI remains. Cleanup item §7.                                    |
| **FS watching**                      | emdash                    | `@parcel/watcher` + `WATCH_IGNORED_NAMES` baseline                                            | We add `.tmux-ide`, `.tasks`, `context` to the ignore list. Single recursive subscription per session.                 |
| **Code editor**                      | emdash                    | Monaco pool + lease + model-registry + per-filetype renderer dispatch                         | Lease consumed via Solid signals (no React hooks).                                                                     |
| **Diff editor**                      | emdash                    | StickyDiffEditor + hunk-by-hunk accept/reject                                                 | Hunks call our buffer-store, not emdash's MobX store.                                                                  |
| **Git ops**                          | emdash                    | git-utils + GitHub auth + branch picker + checks rail                                         | Hosted in the daemon (Hono + Effect), not in an Electron main.                                                         |
| **Multi-terminal**                   | emdash                    | terminals registry + xterm runtime + tab strip + Cmd+T/W/1..9 keybinds                        | Backend is `node-pty` behind `PtyAdapter`, served over WS instead of Electron IPC.                                     |
| **Repo search**                      | (emdash uses ripgrep too) | `@vscode/ripgrep` JSON streaming + result grouping                                            | Solid surface; replace flow uses our save endpoint.                                                                    |
| **LSP**                              | opencode                  | client.ts + per-language launch + JSON-RPC over stdio + tools-as-RPC                          | Exposed both as HTTP endpoints (dashboard) AND as agent tools (chat).                                                  |
| **Chat semantics**                   | t3code (historical)       | Flat MessagesTimeline, provider switcher, plan/permission semantics, tool-call cards          | 100% in `chat-solid` now; t3code is no longer load-bearing. Don't borrow new things from t3 without explicit approval. |
| **Native macOS app**                 | own design                | —                                                                                             | `app/` is in early dev. `app-electron/` is dead (delete in §7).                                                        |

---

## §6 — Conventions

**TypeScript.** Strict mode. No `any` without `// FIXME(reason)`. Imports use `@/` inside `dashboard/`, relative paths inside `chat-solid` / `v2-solid-widgets`, and bare workspace names across packages.

**Tests.** Vitest in every package. Test files live alongside source in `__tests__/` directories (matches contracts, dashboard, packages); daemon mostly uses sibling `*.test.ts`. E2E specs in `dashboard/__tests__/e2e/` (Playwright). One contract test per action handler. One wire-coverage test per Solid bridge (T1 pattern).

**Commits.** Conventional-commit prefixes (`feat`, `fix`, `chore`, `docs`, `refactor`, `build`, `style`, `test`). Don't mention reference codebases by name in commit messages (`feedback_design_reference.md`). Multi-agent: reset → add specific paths → diff --cached → commit immediately, in one chain (`feedback_multi_agent_git_hygiene.md`).

**Action handlers.** One file per concern under `packages/daemon/src/command-center/actions/handlers/`. Schemas in `contracts/`. Tests next to handler. Errors should be `ActionError` (typed code).

**Solid widgets (DOM).** Mount API: `mount(node, opts) → handle`. Handle exposes `{ unmount, update? }`. Owns its own Solid root. Test via `@solidjs/testing-library`.

**Daemon TUI widgets (OpenTUI).** Entry at `packages/daemon/src/widgets/<name>/index.tsx`. Spawned by `bin/cli.ts` via Bun. Reads `--session` + `--dir` from argv.

**Settings.** Browser side: localStorage (`dashboard/src/lib/settings.ts`). Daemon side: `.tmux-ide/` per-project.

**Shell-out.** All `execFileSync` to `tmux` / `git` / `gh` / `rg` MUST use `stdio: ["ignore", "pipe", "pipe"]` (defensive against bad inherited fds when the daemon launches detached). Treat EBADF / EAGAIN / EMFILE / ENFILE from a tmux probe as transient — never as "session is gone."

---

## §7 — Cleanup backlog

The consolidation pass following this doc. Ranked by impact / risk.

### 7.1 — High value / low risk

1. **Drop `chokidar` from `packages/daemon/src/lib/task-store.ts`** — switch the task-store watcher to `@parcel/watcher`. Remove `chokidar` from `packages/daemon/package.json`. The fs-watch.ts already migrated; this is the last hold-out. (~30 min)
2. **Delete `src/server/` and `src/ui/web/`** — empty pre-G16 scaffolding, no callers. Keep `src/cli.test.ts` and `src/integration.test.ts` (top-level CLI tests). (~5 min)
3. **Delete `app-electron/`** — `app/` (Swift/SwiftUI native macOS app) is the live native client; `app-electron/` is pre-`app/` scaffolding. Confirm no references in CI / publish workflow first. (~15 min)
4. **Drop stale `dev:bun:*` scripts in root `package.json`** — bun isn't on the user-facing surface anymore (G22-P0). (~5 min)
5. **Patch malformed task `.tasks/tasks/098-…json`** to add the missing `proof.tests.total` field. Cosmetic, but spams the daemon log on every boot. (~5 min)

### 7.2 — Medium value / medium risk

6. **Audit `dashboard/src/components/v2/`** — six files (`MissionStatementView`, `ProblemsTab`, `SymbolPicker`, `projectData`, `views`, `widgetHost`). Some may be route shells that legitimately live in `dashboard/`; some may wrap `v2-solid-widgets` widgets and should move into the widget package. Inspect each against §3 boundary rules. (~1-2 h)
7. **Document the daemon TUI widget vs Solid DOM widget split in `docs/widget-index.md`** — already exists; update to match this doc's §3 framing and link from each widget's README. (~30 min)
8. **Audit and remove dead `/api/threads/...` REST shims** — they predate the action contract; chat-solid only uses `chat.thread.*` actions now. (~30 min, needs verification)
9. **Migrate to Kobalte** — replace any remaining `@base-ui/*` usage with `@kobalte/core` to match opencode. (~2-3 h)

### 7.3 — Low value / nice to have

10. **Revisit Effect SQL** — opencode uses `@effect/sql-sqlite-bun`. We use `better-sqlite3` + `drizzle-orm` and that's working. Possible future swap; not urgent.
11. **Revisit Effect Schema** — opencode mixes Zod + Effect Schema. We're all-Zod. Possible future swap; not urgent.
12. **Look at opencode's `addons/` pattern** — they have a plugin extension point. We don't have one yet but might want it for user-defined widgets / commands.

### 7.4 — Out of scope here

- New feature work beyond Goal-22 (this is consolidation, not new features).
- Native `app/` development (separate workstream — driven by `app/project.yml`).
- Replacing Hono with Effect HTTP — possible long-term but not urgent.

---

## §8 — How a feature lands

The general flow for adding a new feature (use `git diff viewer` as the worked example — Goal-18-P1):

1. **Audit doc** — `docs/goal-NN-<name>.md` mapping which reference informs us + which files to touch + a phase plan.
2. **Schemas first** — add to `packages/contracts/src/actions-contract.ts`. Run typecheck: daemon + dashboard now both fail to compile until handlers exist.
3. **Daemon handler** — `packages/daemon/src/command-center/actions/handlers/<name>.ts` + register in `registry.ts` + sibling `<name>.test.ts`.
4. **Browser API** — call via `postAction(name, input)` from `dashboard/src/lib/api.ts` or `chat-solid/src/api.ts`.
5. **UI surface** — Solid component in `dashboard/src/components/` OR (if reusable) in `v2-solid-widgets/src/widgets/` or `chat-solid/src/components/`.
6. **Wire-coverage test** — assert the UI calls the right action with the right input on the right user gesture (T1 pattern).
7. **Browser verify** — boot daemon + dashboard, click through manually, capture network in DevTools.
8. **Commit** — single small commit per phase. Push.

---

## §9 — Where to ask questions

- **This doc is canonical.** PRs that change the stack (§2) or boundary rules (§3) MUST update it in the same commit.
- Per-concern audit docs (`docs/goal-NN-<name>.md`) are the source for _why we picked this library_ — keep them around as historical context.
- The `ROADMAP.md` is the current state of the world (what's shipped, what's in flight). This doc is the rules; the roadmap is the work.
- When in doubt about a structural choice: **check opencode first** (`context/opencode/packages/{core,ui,app,sdk}/`).
- When in doubt about an IDE feature behavior: **check emdash first** (`context/emdash/src/{main,renderer}/`).

---

_Last updated: post Goal-22 (release-readiness for v2.5.0). Revise this section when the stack or §3 boundaries change._
