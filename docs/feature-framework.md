# Feature framework — a new feature in 7 predictable files

A synthesized recipe for adding a non-trivial feature to tmux-ide. Cribs the
**Effect-wrapped Service** pattern from opencode, the **per-feature folder +
shared contract** pattern from t3, and the **RPC controller per domain +
broadcast hook** pattern from emdash. Constrained to what actually fits this
repo so you can copy-paste.

The worked example at the end (`Notes` — a per-project markdown scratchpad)
follows all 7 steps end-to-end. It ships with this commit.

---

## 1. The 7-file checklist

For any feature `<feature>` (e.g. `notes`, `pins`, `bookmarks`), you create
seven files plus a small `attach…Routes` call wired into the daemon's
`createApp`. The names below are the canonical paths in this repo:

| #   | File                                                                     | Role                                                                      |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | `packages/contracts/src/<feature>-contract.ts`                           | Zod schemas. Wire shape shared by daemon + dashboard.                     |
| 2   | `packages/daemon/src/<feature>/service.ts`                               | Pure I/O. No HTTP. Trivial to unit-test.                                  |
| 3   | `packages/daemon/src/<feature>/handlers.ts`                              | Hono routes. Thin translation: validate → service → response.             |
| 4   | `packages/daemon/src/<feature>/service.test.ts`                          | bun:test, tmpdir-scoped.                                                  |
| 5   | `packages/v2-solid-widgets/src/widgets/<Feature>.tsx`                    | Prop-driven Solid widget. Owns local UI state; never fetches.             |
| 6   | `dashboard/src/lib/<feature>.ts`                                         | Effect-wrapped client (`fetch…`, `save…`). Imports contract types only.   |
| 7   | `dashboard/src/components/<Feature>Bridge.tsx`                           | Host wiring. Owns server state + saving/error; pushes into widget.        |

Plus two near-zero edits:

- **`packages/contracts/src/index.ts`** — one-line `export * from "./<feature>-contract.ts"`.
- **`packages/daemon/src/command-center/server.ts`** — one-line `attach…Routes(app, deps)` call before `serveDashboard()`.

Mount the widget from the new `Bridge` component anywhere in the dashboard
(activity bar view, inspector tab, standalone route — your call).

> **Why this slicing?** Each file has exactly one reason to change. Contract
> drift can only happen in (1). Storage shape only in (2). Wire-protocol
> errors only in (3). UI presentation only in (5). Bridge wiring only in (7).
> When a regression lands, the diff narrows the blast radius for you.

---

## 2. What each file looks like (templates)

### 2.1 Contract (`packages/contracts/src/<feature>-contract.ts`)

```ts
import { z } from "zod";

export const <Feature>SchemaZ = z.object({
  sessionName: z.string(),
  /* …feature fields… */
});
export type <Feature> = z.infer<typeof <Feature>SchemaZ>;

export const <Feature>ResponseSchemaZ = z.object({ <feature>: <Feature>SchemaZ });
export const Update<Feature>RequestSchemaZ = z.object({
  /* …only the fields the client can set… */
});
```

Rules:

- One file per feature. No cross-feature imports here.
- Use `z.string().max(N)` / `.min(N)` for any user-facing input; the daemon
  validates with the same schema via `zValidator`.
- Export both schema (`…SchemaZ`) and inferred type (`<Feature>`) so the
  dashboard can rely on compile-time types without bundling Zod.

### 2.2 Service (`packages/daemon/src/<feature>/service.ts`)

```ts
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const REL_PATH = ".tmux-ide/<feature>.<ext>";

export interface <Feature>Record { /* …read/write shape… */ }

export function read<Feature>(sessionDir: string): <Feature>Record { /* … */ }
export function write<Feature>(sessionDir: string, input: …): <Feature>Record { /* atomic temp+rename */ }
```

Rules:

- Take `sessionDir: string` — never a `name` (handlers resolve name→dir).
- Atomic writes via temp + rename so concurrent reads never see a torn write.
- No Hono / WS / Zod imports — keep this layer trivially mockable.

### 2.3 Handlers (`packages/daemon/src/<feature>/handlers.ts`)

```ts
import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { Update<Feature>RequestSchemaZ, type <Feature> } from "@tmux-ide/contracts";
import { read<Feature>, write<Feature> } from "./service.ts";

export interface <Feature>HandlerDeps {
  resolveSession(name: string): { name: string; dir: string } | null;
  onChanged?(sessionName: string): void;  // optional WS broadcast hook
}

export function attach<Feature>Routes(app: Hono, deps: <Feature>HandlerDeps): void {
  app.get("/api/project/:name/<feature>", (c) => { /* read → respond */ });
  app.put(
    "/api/project/:name/<feature>",
    zValidator("json", Update<Feature>RequestSchemaZ),
    (c) => { /* validate → write → broadcast → respond */ },
  );
}
```

Rules:

- One exported `attach…Routes(app, deps)` function. Wire from `createApp`.
- Resolve session via `deps.resolveSession` injection — never call
  `discoverSessions()` here. Lets the test stub session existence.
- Fire `deps.onChanged?.(sessionName)` after any mutation. The daemon's
  WS layer translates it into a `<feature>.changed` broadcast.

### 2.4 Service test (`packages/daemon/src/<feature>/service.test.ts`)

```ts
import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read<Feature>, write<Feature> } from "./service.ts";

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-<feature>-test-")); });
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("read<Feature>", () => { /* empty-state, happy-path */ });
describe("write<Feature>", () => { /* mkdir, idempotency, atomic */ });
```

Rules:

- Test the service, not the handlers. Handlers are 8-line translations.
- One tmpdir per test, never share state.

### 2.5 Widget (`packages/v2-solid-widgets/src/widgets/<Feature>.tsx`)

```tsx
import { createEffect, createSignal, Show } from "solid-js";
import type { <Feature>MountOptions } from "../types";

interface <Feature>ViewProps { options: () => <Feature>MountOptions; }

export function <Feature>View(props: <Feature>ViewProps) {
  /* local UI state — draft buffers, filter chips, expanded rows */
  /* createEffect reconciles options().content with local draft */
  /* user interactions call props.options().onSave?.(…) etc. */
  return ( /* JSX with data-testid="<feature>-view" / "<feature>-…" */ );
}
```

Plus the mount in `packages/v2-solid-widgets/src/index.tsx`:

```tsx
export function mount<Feature>(container: HTMLElement, opts: <Feature>MountOptions): <Feature>MountHandle {
  const [options, setOpts] = createSignal(opts);
  container.classList.add("v2-solid-widget");
  const dispose = render(() => <<Feature>View options={options} />, container);
  return {
    unmount() { dispose(); container.classList.remove("v2-solid-widget"); },
    setOptions(next) { setOpts((cur) => ({ ...cur, ...next })); },
  };
}
```

Rules:

- **Widget never fetches.** Only the host (Bridge) does.
- All inputs come via `props.options()`; all outputs leave via callbacks
  on those options (`onSave`, `onSelect`, `onDelete`, …).
- Tag every interactive element with `data-testid="<feature>-…"` so the
  dashboard's `@solidjs/testing-library` suite can target it.
- If the host pushes a fresher server snapshot while the user is editing,
  the widget should *keep the user's draft* and surface a divergence
  indicator — never silently clobber.

### 2.6 Client (`dashboard/src/lib/<feature>.ts`)

```ts
import { Effect, Data } from "effect";
import type { <Feature> } from "@tmux-ide/contracts";
import { API_BASE } from "@/lib/api";

export class <Feature>ApiError extends Data.TaggedError("<Feature>ApiError")<{
  readonly status: number; readonly message: string;
}> {}

export function fetch<Feature>(sessionName: string): Effect.Effect<<Feature>, <Feature>ApiError> { /* GET */ }
export function save<Feature>(sessionName: string, …): Effect.Effect<<Feature>, <Feature>ApiError> { /* PUT */ }
```

Rules:

- Always Effect-wrapped so failures land in a tagged error, not a raw
  rejection. Consumers `Effect.runPromise` (or `runPromiseExit`).
- Import only **types** from `@tmux-ide/contracts` — never schemas at
  runtime. Keeps the dashboard bundle Zod-free.

### 2.7 Bridge (`dashboard/src/components/<Feature>Bridge.tsx`)

```tsx
import { createMemo, createResource, createSignal, type JSX } from "solid-js";
import { Effect } from "effect";
import { mount<Feature>, WidgetHost, type <Feature>MountOptions } from "@tmux-ide/v2-solid-widgets";
import { API_BASE } from "@/lib/api";
import { fetch<Feature>, save<Feature> } from "@/lib/<feature>";

export function <Feature>Bridge(props: { projectName: string }): JSX.Element {
  const [bumpTick, setBumpTick] = createSignal(0);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [data] = createResource(
    () => ({ projectName: props.projectName, tick: bumpTick() }),
    async ({ projectName }) => Effect.runPromise(fetch<Feature>(projectName)).catch(() => null),
  );

  async function onSave(…) { /* runPromise(save<Feature>); setBumpTick(t => t + 1); */ }

  const options = createMemo<<Feature>MountOptions>(() => ({
    sessionName: props.projectName,
    apiBaseUrl: API_BASE,
    bearerToken: null,
    /* …data-derived fields, saving, error, onSave… */
  }));

  return <WidgetHost mount={mount<Feature>} options={options} class="h-full w-full" />;
}
```

Rules:

- The bridge is the *only* place the dashboard talks to the daemon for
  this feature. Owns: resource fetch, optimistic toggles, save state,
  error surfacing, WS-tick subscription.
- Pass a stable `createMemo` to `WidgetHost`, not an inline object — the
  host short-circuits remounts on identical option references.

---

## 3. Request / response / event flow

```
                  ┌─────────────────────────────┐
                  │ dashboard route mounts      │
                  │ <Feature>Bridge.tsx (7)     │
                  └─────────────┬───────────────┘
                                │ createResource → Effect.runPromise
                                ▼
                  ┌─────────────────────────────┐
   GET / PUT      │ dashboard/src/lib/         │
                  │ <feature>.ts (6)            │
                  └─────────────┬───────────────┘
                                │ fetch  /api/project/:name/<feature>
                                ▼
                  ┌─────────────────────────────┐
                  │ packages/daemon/src/        │
                  │ <feature>/handlers.ts (3)   │  ← zValidator, deps.resolveSession
                  └─────────────┬───────────────┘
                                │ read… / write… / deps.onChanged
                                ▼
                  ┌─────────────────────────────┐
                  │ packages/daemon/src/        │
                  │ <feature>/service.ts (2)    │  ← node:fs, atomic temp+rename
                  └─────────────────────────────┘

On mutation, deps.onChanged(name) fires a `<feature>.changed` WS frame on
/ws/events. Bridge's projectsBus-style subscription bumps a tick → the
createResource source memo refetches → setOptions pushes fresh data into
the widget → widget reconciles vs. the user's local draft.
```

---

## 4. When to deviate

| Situation                                                         | Where the file lives instead                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chat-adjacent UI** (composer chips, message rendering, picker)  | `packages/chat-solid/src/components/<Feature>.tsx` — chat-solid is a separate silo with its own design tokens, runtime, and event bus. Keep generic widgets in `v2-solid-widgets`. |
| **Read-only widget with no daemon persistence** (file preview, git status pane) | Skip steps 1–4. Add the dashboard-side client + widget; the "service" is whichever existing daemon endpoint already exposes the data.            |
| **Feature is dashboard-only** (URL state, layout settings)        | Skip steps 1–4 + 6. Just widget + bridge, with localStorage in the bridge.                                                                       |
| **Feature has agent-side behavior** (touches orchestrator state)  | Add a step 2b: `packages/daemon/src/<feature>/runtime.ts` for the dispatch/tick loop. Keep it separate from `service.ts`.                        |
| **TUI surface** (renders in a tmux pane via OpenTUI)              | `src/widgets/<feature>/` at the repo root, not `packages/v2-solid-widgets/`. Different runtime.                                                  |
| **Cross-project / global feature** (mission templates, presets)   | Use `~/.tmux-ide/<feature>.json` in the service, not `<sessionDir>/.tmux-ide/…`.                                                                 |

If the feature *truly* doesn't fit the 7-file mold — typically because it's
a refactor of existing infra rather than a new domain — say so in the PR
description rather than smuggling it through. The framework is a starting
point, not a straitjacket.

---

## 5. Risky-areas pattern (cribbed from emdash)

Some surfaces in this repo carry implicit constraints that bite when ignored.
Before touching them, scan the call sites and ask "what invariant is the
current implementation defending?" Don't refactor blind.

| Area                                  | Risk                                                                                                                                  | What to do                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **PTY / tmux pane lifecycle**         | Killing or restarting a pane closes its `pane_id` and renumbers siblings, dropping orchestrator state for the renumbered panes.        | Always *split* a new pane, never recycle. See `feedback_tmux_panes` memory; live by the tmux-ide `lib/tmux.ts` helpers.  |
| **SQLite event log**                  | Schema migrations must be backwards-compatible across daemon restarts. A breaking change to `event-log-sqlite.ts` corrupts old DBs.    | Bump schema version, write a migration in `event-log-sqlite.ts`'s `applyMigrations`, never edit existing migration steps. |
| **LSP client / server lifecycle**     | The Monaco buffer-store assumes documents are owned by a single LSP session; double-`didOpen` poisons references.                      | Read `dashboard/src/lib/lsp/` before adding new model URIs. Stay out unless you're pane 2 (or have explicit handoff).    |
| **Daemon watchdog**                   | The watchdog respawns the daemon on crash with exponential backoff. Calling `process.exit(0)` from business code defeats the loop.     | Only `daemon-watchdog.ts` and `daemon.ts` may exit. Surface errors to the watchdog via `process.exit(1)` if you must.    |
| **`.tasks/` JSON store**              | Sibling agents may stage `.tasks/` files between your `git add` and `git commit`, snapping unrelated state into your commit.            | Per `feedback_multi_agent_git_hygiene`: reset index, add explicit paths, verify `--cached` diff, commit immediately.    |
| **`chokidar` under `context/`**       | Walking the `context/` reference trees blows out file-descriptor limits on macOS.                                                     | Use `@parcel/watcher` with `WATCH_IGNORED_NAMES` (emdash's pattern). See `feedback_emdash_patterns` memory.              |
| **`packages/contracts/src/index.ts`** | A single name collision in a re-exported schema breaks every consumer. The dashboard, daemon, and CLI all import via this file.       | Append-only when adding features. Don't rename or move existing exports; bump a major if you must.                      |
| **`packages/v2-solid-widgets/src/index.tsx`** | A `mount…` export is part of the package API. Removing one breaks the dashboard bridges that call it.                            | Append, never remove. If a widget is retiring, gate the mount behind a deprecation comment for one release.              |

When in doubt: scan recent commits to the file you're about to touch
(`git log -p -- <file>`) and read the most recent rationale.

---

## 6. Worked example: the `Notes` feature

Per-project markdown scratchpad stored at `<sessionDir>/.tmux-ide/notes.md`.
Ships in this commit; copy the seven files for your next feature.

| File                                                       | Lines | Purpose                                              |
| ---------------------------------------------------------- | ----: | ---------------------------------------------------- |
| `packages/contracts/src/notes-contract.ts`                 |   ~32 | `NoteSchemaZ`, `UpdateNoteRequestSchemaZ`            |
| `packages/daemon/src/notes/service.ts`                     |   ~45 | `readNote`, `writeNote` (atomic temp+rename)         |
| `packages/daemon/src/notes/handlers.ts`                    |   ~55 | `attachNotesRoutes(app, deps)`                       |
| `packages/daemon/src/notes/service.test.ts`                |   ~45 | bun:test, tmpdir-scoped                              |
| `packages/v2-solid-widgets/src/widgets/Notes.tsx`          |  ~115 | Prop-driven editor, draft reconciliation, Cmd/Ctrl+S |
| `dashboard/src/lib/notes.ts`                               |   ~85 | `fetchNote`, `saveNote` (Effect)                     |
| `dashboard/src/components/NotesBridge.tsx`                 |   ~70 | `createResource` + `WidgetHost`                      |

Plus the two near-zero edits:

```diff
--- packages/contracts/src/index.ts
+export * from "./notes-contract.ts";

--- packages/daemon/src/command-center/server.ts
+import { attachNotesRoutes } from "../notes/handlers.ts";
   …inside createApp(), before serveDashboard():
+  attachNotesRoutes(app, {
+    resolveSession(name) {
+      return discoverSessions().find((s) => s.name === name) ?? null;
+    },
+  });
```

### How to mount it

The bridge is route-agnostic. Drop `<NotesBridge projectName={projectName()} />`
into any view in `dashboard/src/components/v2/views.tsx`, give it an
activity-bar slot, or render it inside the right inspector — whichever fits
your UX. The widget owns its own layout (`flex h-full w-full min-h-0`).

### Verifying the loop end-to-end

```bash
# 1. Service-level tests
pnpm -F @tmux-ide/daemon test src/notes/service.test.ts

# 2. Wire HTTP smoke test
curl -s http://127.0.0.1:6060/api/project/<name>/notes | jq .
curl -s -X PUT http://127.0.0.1:6060/api/project/<name>/notes \
  -H "Content-Type: application/json" -d '{"content":"hello"}' | jq .

# 3. Inspect the on-disk artifact
cat <sessionDir>/.tmux-ide/notes.md
```

### What this example deliberately does *not* show

- **WS broadcast.** `attachNotesRoutes` accepts an optional `onChanged`
  hook; wiring it to the `/ws/events` projector is one bus-side change
  best done with the other WS subscriptions, not per-feature.
- **Optimistic concurrency.** A real notes feature would carry an
  `If-Match` etag (the `updatedAt` ISO) and reject conflicting writes.
  Skipped here because the focus is the 7-file shape, not collision UX.
- **Markdown rendering.** The widget surfaces a raw textarea. A future
  iteration could split-pane a `marked` preview — that change touches only
  file (5), proving the slicing pays off.

---

## 7. Quick checklist before opening the PR

- [ ] Contract file added and re-exported from `contracts/src/index.ts`
- [ ] Service has at least 3 unit tests (empty state, happy path, idempotency)
- [ ] Handler resolves session via injection, fires `onChanged` after writes
- [ ] Widget has `data-testid="<feature>-…"` hooks on every interactive element
- [ ] Bridge passes a `createMemo`-stable options object to `WidgetHost`
- [ ] One-line `attach…Routes` call wired into `createApp`
- [ ] No imports of `chat-solid` from `v2-solid-widgets` (or vice versa)
- [ ] No `Zod` imports in the dashboard bundle (types-only from contracts)
- [ ] Read the risky-areas table above for anything you touched

If you check all seven boxes, the diff should land in 7 files plus the two
one-liners. If it doesn't, either you found a real edge case the framework
missed (write it up at the bottom of this doc) or you're carrying a refactor
that wants to be its own PR.
