# Goal 14 — Architecture Parity With t3 (No Worktrees)

> **Status**: roadmap / plan only. **No code changes** land from this document.
> Every section ends with a concrete next-step or `OPEN QUESTION FOR USER`.

> **Headline win**: engineering rigor — typed event sourcing, Effect-style
> structured concurrency in the daemon, reactor layers that decouple events
> from side effects, branded IDs that catch entire classes of bugs at the
> type level, and a framework-silo rule that ends "mixed-and-matched" UI
> code. We are not chasing features; goal 13 already shipped chat parity.
> Goal 14 buys us the *foundations* that made t3code's chat parity look
> easy — and that we noticed the hard way during T070-T083 (cross-package
> dependencies, divergent serialization, accidental coupling across the
> React/Solid line).

> **Scope ceiling**: `ThreadEnvMode = "worktree"` is **explicitly out of
> scope**. Any task that would touch worktree-per-thread is rejected. See
> §4 for the full out-of-scope list and rationale.

---

## 0. Reading order

This document is long. If you only have ten minutes, read in this order:

1. **§1.1** — the one-paragraph architectural rule (`RSC-shell + siloed blocks`).
2. **§3** — the task table (P1/P2/P3, S/M/L, dependency graph).
3. **§6** — open questions that block sequencing.

If you have an hour, also read **§2** (the t3-vs-us audit) and **§5**
(silo audit of current files).

If you are about to *implement* a task, the appendix §A maps every
t3 source path quoted in this document to a corresponding tmux-ide
file, so you can do the per-task source-of-truth lookup without
re-deriving it.

> **Sources consulted to write this document**:
> - `context/t3code/apps/server/src/{persistence,orchestration,provider}/` — t3 server architecture
> - `context/t3code/packages/contracts/src/{baseSchemas,orchestration,settings,providerRuntime}.ts` — t3 schemas
> - `context/t3code/apps/desktop/` — t3's Electron shell (analogue of our `app/`)
> - `context/t3code/apps/web/` — t3's Vite + React UI (analogue of our `dashboard/`)
> - `.tmux-ide/library/research-findings.md` (T050) — the prior signal-library audit and t3 structural audit
> - `ARCHITECTURE.md` (repo root) — current import-direction rules
> - `packages/daemon/src/chat/` — current chat orchestration (after goal-13 work)
> - `packages/contracts/src/chat-thread.ts` — current chat-thread schemas (after T078)

---

# Deliverable 1 — Architectural Rule (RSC-shell + Siloed Blocks)

## 1.1 The rule, in one paragraph

> **The Next.js dashboard is rendered as React Server Components by
> default. Interactive surfaces drop to React client components only
> where state, refs, or browser APIs demand it. UI built in a foreign
> framework (Solid, Lit, Preact, …) lives in a named *silo* package
> (`@tmux-ide/<silo-name>`) and is mounted from React through a single
> *bridge component* per silo. Bridge components are the only place
> in the codebase that knows how to translate between React's
> component model and a non-React DOM-mounting API. The data contract
> between a silo and its bridge is a single `mount(el, props)` call
> that returns a handle exposing `unmount()` plus typed prop-update
> methods — props never flow as live React state, only as imperative
> calls on the handle.**

This sentence is load-bearing. Everything in §1.2–§1.5 enforces it.

## 1.2 Decision matrix — when to RSC vs Client vs Silo vs other

| Surface | Choose | Reason | Examples (current code) |
| --- | --- | --- | --- |
| Static page chrome, project/thread index lists, anything that fetches once and renders | **RSC** | No interactive state; render-on-server is cheaper and avoids a hydration round-trip. | `app/(shell)/*` *should be* RSC (today most are `"use client"`; see §5). |
| Form widgets, sortable tables, inline editing, command palette, anything driven by zustand or React state | **React Client** (`"use client"`) | Needs `useState`/`useEffect`/refs/browser APIs. | `dashboard/components/projects/AddProjectDialog.tsx`, `KeybindRoot.tsx`, `CommandPalette.tsx`. |
| Anything that runs in a non-React framework — Solid DOM islands today, Lit/Preact/Vue tomorrow | **Silo package** mounted via bridge | Foreign framework owns its DOM subtree; React must not reach inside. | `@tmux-ide/chat-solid` mounted via `ChatTabPanel.tsx`; `@tmux-ide/v2-solid-widgets` mounted via `V2*Island.tsx`. |
| Long-lived browser process attached to a backend stream (PTY, ANSI mirror) | **React Client + silo-shaped wrapper** | Treat the stream owner as a silo even though it's still React, so the rendering subtree is replaceable. | `Terminal*` xterm wrappers under `dashboard/components/terminals/`. |
| Sub-window with its own runtime (Electron BrowserWindow, native Swift view via `app/`) | **Out-of-tree silo** | Different process entirely. Bridge is the IPC layer, not a React component. | `app/TmuxIde/` (Swift) and `app-electron/` (Electron). |

**Tie-breaker for borderline cases**:
- If you can answer the question "*does this component own a `useRef` to a DOM node?*" with **yes**, it is a Client component or a silo, not RSC.
- If you can answer "*does this component need to pass live React state to a non-React UI?*" with **yes**, it is a silo with a bridge — never inline `dangerouslySetInnerHTML` or `useEffect`-glue inside an otherwise RSC tree.

**Next step**: turn the table above into an ADR
(`docs/adr/0001-rsc-shell-and-siloed-blocks.md`) so it's referenced by
PR descriptions, not buried inside the goal-14 roadmap.

## 1.3 Bridge component template — React → Solid (canonical example)

Every silo bridge follows the same five-part shape. The pattern is
already correct in `dashboard/components/chat/ChatTabPanel.tsx`; we
codify it here so future silos copy it instead of reinventing.

```tsx
// dashboard/components/<silo>/<Silo>BridgePanel.tsx
//
// CANONICAL BRIDGE-COMPONENT TEMPLATE (RSC-shell + siloed-blocks rule §1.3)
//
// What this file owns:
//   - Host <div> ref
//   - Dynamic import of the silo's mount module (`@tmux-ide/<silo>`)
//   - One mount() per component instance
//   - Prop-update calls on the returned handle (NEVER re-mount on prop change)
//   - One unmount() in cleanup
//
// What this file does NOT do:
//   - It does NOT render any framework-specific markup inside the host <div>.
//   - It does NOT subscribe to silo-internal state from React.
//   - It does NOT inspect the DOM the silo produced.
//
// Anything that violates the above belongs inside the silo, behind the
// `mount()` API contract.

"use client";

import { useEffect, useRef } from "react";

interface BridgeProps {
  sessionName: string;
  threadId: string;
  // …other props the silo wants
}

interface MountHandle {
  unmount(): void;
  setThreadId(id: string): void;
  setSessionName(name: string): void;
}

export function ChatSiloBridge(props: BridgeProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<MountHandle | null>(null);

  // (1) Mount once on hostRef availability. NEVER include `props.threadId`
  //     in this dependency array — that would force a re-mount on every
  //     prop change and lose the silo's internal state. Prop changes are
  //     dispatched via setter methods below.
  useEffect(() => {
    let cancelled = false;
    const el = hostRef.current;
    if (!el) return;
    void (async () => {
      const mod = await import("@tmux-ide/chat-solid");
      if (cancelled || !hostRef.current) return;
      handleRef.current = mod.mount(el, {
        sessionName: props.sessionName,
        threadId: props.threadId,
      });
    })();
    return () => {
      cancelled = true;
      handleRef.current?.unmount();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (2) Dispatch prop updates to the live handle. One useEffect per
  //     setter so we don't fire on unrelated prop changes.
  useEffect(() => {
    handleRef.current?.setThreadId(props.threadId);
  }, [props.threadId]);

  useEffect(() => {
    handleRef.current?.setSessionName(props.sessionName);
  }, [props.sessionName]);

  // (3) Host element only. No children, no className that the silo
  //     might fight with. The silo controls its DOM subtree.
  return <div ref={hostRef} style={{ height: "100%", width: "100%" }} />;
}
```

### Why the dependency array is `[]`, not `[props.threadId]`

A naïve developer reads "the host needs to switch to a new thread" and
makes the mount effect depend on `threadId`. That causes a full
unmount → re-mount on every thread switch, which:

- Destroys the silo's internal state (composer draft, scroll
  position, focus).
- Recreates DOM nodes — a perceptible flash.
- Sometimes leaks event listeners if the silo's `unmount()` is
  imperfect.

Driving prop changes through *handle setters* keeps the silo alive
across prop changes. The silo decides what to do with the new value
(e.g. re-fetch the thread, swap content) without re-running its
bootstrap.

### Mount-handle contract (every silo implements)

```ts
// packages/<silo>/src/index.ts
export interface SiloMountHandle {
  /** Tear down the silo and release every DOM/event/network resource it owns. */
  unmount(): void;

  /** One typed setter per prop the bridge needs to update.
   *  Setters MUST be idempotent — calling with the current value is a no-op. */
  // setX(value: T): void;
}

export function mount(el: HTMLElement, initial: InitialProps): SiloMountHandle;
```

The setter convention (`setThreadId`, `setSessionName`, …) is part of
the *silo public API*, not a free-form prop. Adding a new prop is a
visible API change in the silo package — that is the entire point of
the boundary.

**Next step**: add this template (and the `mount()` API contract) to
`packages/chat-solid/README.md` and `packages/v2-solid-widgets/README.md`
so the rule lives next to the silos that implement it.

## 1.4 Enforcement — lint + CI hooks

There are five rules the ESLint config should catch. None of them
exist today; all are additive.

### Rule 1 — No deep imports across silo boundaries

| Rule | Plugin | Config sketch |
| --- | --- | --- |
| Dashboard may not import silo internals | `eslint-plugin-boundaries` | `elements: [{ type: "silo", pattern: "packages/{chat-solid,v2-solid-widgets}/src/**" }]` + a rule that the dashboard may only import the silo's package entry point (`@tmux-ide/<silo>`), not `@tmux-ide/<silo>/src/...`. |

Today nothing enforces this — a careless `import {...} from
"@tmux-ide/chat-solid/src/components/MessageList"` would silently break
the silo. Lock it down.

```js
// eslint.config.js (sketch)
{
  rules: {
    "boundaries/element-types": [
      "error",
      {
        default: "disallow",
        rules: [
          { from: "dashboard", allow: ["silo-public", "contracts", "daemon-client"] },
          { from: "daemon", allow: ["contracts", "shared"] },
          { from: "silo-public", allow: ["contracts"] },
        ],
      },
    ],
  },
}
```

### Rule 2 — RSC files do not import React client utilities

Add `eslint-plugin-rsc` (or our own boundaries rule keyed on the
`"use client"` directive) that rejects:

- Importing `useState` / `useEffect` / `useRef` / `zustand` / `jotai`
  in a file without the `"use client"` directive.
- Importing a `"use client"` file from a Server Component without an
  explicit `// eslint-disable-line` (forces a comment trail).

### Rule 3 — Silo bridges may not import from other silos

A `ChatSiloBridge` may not `import "@tmux-ide/v2-solid-widgets"` and
vice-versa. Silos are independent; cross-silo coordination happens at
the **React layer above the bridges**.

### Rule 4 — No raw `mount()` calls outside `*Bridge.tsx`

A CI grep is sufficient:

```bash
# scripts/check-silo-mounts.sh
fail=0
for f in $(grep -rln 'mod\.mount(' dashboard); do
  if [[ "$f" != *Bridge*.tsx && "$f" != *Island*.tsx ]]; then
    echo "ERROR: silo mount() called outside a Bridge/Island file: $f"
    fail=1
  fi
done
exit "$fail"
```

Pair with a `pre-commit` hook. Acceptance: a developer who copy-pastes
the mount snippet into a random component gets blocked.

### Rule 5 — Server actions and route handlers may not import silo packages

A silo's runtime is browser-only; importing it server-side either
crashes (no `window`) or bundles framework runtime into Node. ESLint
`no-restricted-imports`:

```js
{
  files: ["dashboard/app/**/{route,actions}.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: ["@tmux-ide/chat-solid*", "@tmux-ide/v2-solid-widgets*"],
    }],
  },
}
```

### Combined eslint snippet (sketch — drop into `eslint.config.js`)

```js
// eslint.config.js (additive sketch — not literal final form)
import boundaries from "eslint-plugin-boundaries";

export default [
  // …existing config…
  {
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "rsc-page",      pattern: "dashboard/app/**/page.tsx" },
        { type: "client-comp",   pattern: "dashboard/components/**/*.tsx" },
        { type: "silo-bridge",   pattern: "dashboard/**/*SiloBridge.tsx" },
        { type: "silo-public",   pattern: "packages/{chat-solid,v2-solid-widgets}" },
        { type: "silo-internal", pattern: "packages/{chat-solid,v2-solid-widgets}/src/**" },
        { type: "contracts",     pattern: "packages/contracts/src/**" },
        { type: "daemon",        pattern: "packages/daemon/src/**" },
        { type: "daemon-client", pattern: "packages/daemon-client/src/**" },
      ],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            // RSC pages can import client components and contracts but not silos or daemon.
            { from: "rsc-page", allow: ["client-comp", "silo-bridge", "contracts", "daemon-client"] },
            // Client components can import other client components, bridges, contracts, daemon-client.
            { from: "client-comp", allow: ["client-comp", "silo-bridge", "contracts", "daemon-client"] },
            // Bridges import the silo's public surface and contracts only.
            { from: "silo-bridge", allow: ["silo-public", "contracts"] },
            // No-one imports a silo's internals.
            { from: ["rsc-page", "client-comp", "silo-bridge"], disallow: ["silo-internal", "daemon"] },
            // Daemon imports contracts only (existing rule, reasserted).
            { from: "daemon", allow: ["contracts"] },
          ],
        },
      ],
      "no-restricted-imports": ["error", {
        patterns: [
          // Server actions / route handlers may not import silo runtime.
          {
            group: ["@tmux-ide/chat-solid*", "@tmux-ide/v2-solid-widgets*"],
            message: "Server actions cannot import silo runtimes — silos are browser-only.",
          },
        ],
      }],
    },
  },
];
```

This is a *sketch* — production wiring will require tweaking
boundaries-plugin patterns and validating the path globs against
actual workspace layout. Reviewers should expect ~30 min of glob
tuning during G14-T03.

**Next step**: a single task in the breakdown (`G14-T03 — Silo
boundary lint`) wires all five rules. Effort S; depends on G14-T01
(ADR landing) so the lint can reference the rule by its number.

## 1.5 Cross-reference with `ARCHITECTURE.md`

`ARCHITECTURE.md` at the repo root is a thin
overview from before the daemon/dashboard split. It does not mention
RSC, silos, or even the dashboard. The two are not in conflict — they
operate at different scopes:

- `ARCHITECTURE.md` covers the **CLI/runtime/tmux boundary** — `bin/cli.js`,
  `src/launch.js`, the tmux child-process wrapper. Stable; no changes
  needed for goal 14.
- `docs/goal-14-architecture-parity.md` (this file) and the planned
  ADR in §1.2 cover the **dashboard ↔ daemon ↔ silo boundary**.

**Action**: append a one-paragraph "Dashboard architecture" stub to
`ARCHITECTURE.md` that says "the dashboard follows the RSC-shell +
siloed-blocks rule documented in `docs/adr/0001-rsc-shell-and-siloed-blocks.md`",
so a reader who lands on `ARCHITECTURE.md` can find the dashboard rule.

**Next step**: do that append as part of G14-T01.

---

# Deliverable 2 — Audit Table: Current State vs t3 (Excluding Worktrees)

Each row of the audit walks one t3 architectural feature, maps it to
the equivalent tmux-ide surface, and identifies the delta. The
proposals below feed directly into the task breakdown in §3.

## 2.1 Persistence — sqlite + event sourcing + projections + receipts

### t3 today

| Layer | File | Shape |
| --- | --- | --- |
| Event store | `apps/server/src/persistence/Services/OrchestrationEventStore.ts` + `Layers/OrchestrationEventStore.ts` | `append(event)` → assigns monotonic `sequence`; `readFromSequence(seqExclusive, limit)` → `Stream<OrchestrationEvent>`; `readAll()` → `Stream<…>`. Backed by sqlite table `orchestration_events` with columns `(sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json)`. |
| Command receipts | `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` | A separate sqlite table that records every accepted *command* (the input that *produces* an event) — independent of events because a single command may produce many events, and a rejected command produces zero events but should still be auditable. |
| Projection pipeline | `apps/server/src/orchestration/Services/ProjectionPipeline.ts` + `Layers/ProjectionPipeline.ts` | `bootstrap` → replays events into projection tables from each projector's stored cursor; `projectEvent(event)` → updates all projection tables for one event. |
| Projection tables | `apps/server/src/persistence/Layers/Projection*.ts` (12 files: Projects, Threads, Turns, ThreadMessages, ThreadActivities, ThreadSessions, ThreadProposedPlans, Checkpoints, PendingApprovals, Repositories, ProjectionState, …) | One sqlite table per read model; each owns its own cursor in `projection_state`. |
| Projection snapshot query | `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` | Read-side composition of the per-projection tables into denormalized snapshots that the UI consumes (e.g. the full `Thread` aggregate). |
| Migrations | `apps/server/src/persistence/Migrations/` (28 numbered migrations) | Each migration is an `Effect.gen` returning `sql\`CREATE TABLE …\`` statements. Run via `effect/unstable/sql/Migrator`. |

### tmux-ide today

| Layer | File | Shape |
| --- | --- | --- |
| Threads | `packages/daemon/src/chat/thread-store.ts` | JSON: one `<threadId>.json` per thread + an `index.json`. Atomic temp-rename writes; debounced. |
| Turns | `packages/daemon/src/chat/turn-store.ts` | Pure in-memory. No durability — turn state lives only in the running daemon. |
| Activities | `packages/daemon/src/chat/activity-log.ts` | Pure in-memory. Sequence assigned per-thread; no replay window. |
| Plans | `packages/daemon/src/chat/plan-store.ts` | JSON-backed via thread-store. |
| Checkpoints | `packages/daemon/src/chat/checkpoint-store.ts` | Pure in-memory keyed by `(threadId, turnId)`. Persistence is provided by git refs (the actual checkpoint), but the metadata is volatile. |
| Sessions (T078) | `packages/daemon/src/chat/session-store.ts` | Pure in-memory. |
| Tasks/missions/goals/events | `.tasks/*.json` + `_events.jsonl` | Append-only JSONL event log; JSON-file projections. Closest thing we have to event sourcing today, but no replay, no read-model bootstrap, no per-projection cursors. |

### Delta + cost

| Aspect | t3 | tmux-ide | Cost to adopt |
| --- | --- | --- | --- |
| Durability across daemon restart | All chat state durable | Threads/plans yes; turns/activities/checkpoints/sessions **no** | Whole rebuild on restart — accepted today but stops being acceptable once chat threads start running multi-hour validator runs (goal 13+ usage). |
| Replay from any seq | Yes via `readFromSequence(seq)` | No — `_events.jsonl` is read on boot and never again | Cannot rebuild a projection after a bug fix without daemon restart + manual file edit. |
| Multi-projection from one event stream | Yes — projector cursors live in `projection_state` table | No — each store has its own ad-hoc persistence | New consumers of chat events (metrics, audit dashboard, billing) require copy-paste subscription code. |
| Command receipts | Yes — separate audit table | No — accepted commands and their events are not distinguishable from each other | Debugging "why didn't this command produce an event?" is hard. |
| Migrations | sqlite + `effect/sql/Migrator` | None — JSON schema versioned manually via `version: 1` keys | When the schema needs to change, every install rewrites a JSON file. No down-migration story. |

### Proposed adoption — phased

**Phase 1 — Event log (sqlite, no projections)**.
- New sqlite database at `${TMUX_IDE_DATA_DIR}/daemon.sqlite` (or under
  per-project lock dir from goal-12). Schema: one table
  `chat_events` with columns mirroring t3's `orchestration_events`
  (sequence, event_id, stream_id, stream_version, event_type,
  occurred_at, command_id, causation_event_id, correlation_id,
  actor_kind, payload_json, metadata_json).
- Existing `ChatThreadEvent` shapes from `packages/contracts/src/chat-thread.ts`
  serialize directly into `payload_json`. Schema check on read.
- One new module `packages/daemon/src/persistence/chat-event-store.ts`
  exposing `append(event)` / `readFromSequence(seq, limit?)` /
  `readAll()`. Test with bun's better-sqlite3 driver (we ship it).

**Phase 2 — Projections from the event log**.
- Re-implement turn-store / activity-log / checkpoint-store as
  *projections* — they keep their current Map-based read API but their
  state is rebuilt by replaying events from sqlite at startup, then
  updated incrementally by subscribing to `append`.
- Add a `projection_state` table that stores `(projection_name,
  last_applied_sequence)`. Each projection refuses to advance past a
  gap.
- Bootstrap on daemon start: load `last_applied_sequence` for each
  projection, replay events `> last`, mark them caught up.

**Phase 3 — Command receipts**.
- Add a `chat_commands` table mirroring t3's
  `orchestration_command_receipts`. Every action handler (`chat.session.send`,
  `chat.thread.create`, `chat.permission.respond`, …) writes a receipt
  *before* dispatching downstream side effects, so a rejected command
  is still auditable.

**Phase 4 — Tasks/missions/goals on the same substrate**.
- Migrate `.tasks/*.json` + `_events.jsonl` to the same sqlite
  database (a second event stream alongside `chat_events`, or a single
  unified stream keyed by `aggregate_kind`). At that point the
  daemon ships exactly one persistence boundary, matching t3 exactly.

### Acceptance per phase

| Phase | Test |
| --- | --- |
| P1 | `append` + `readFromSequence` round-trip 1000 events under 100 ms (sqlite + better-sqlite3). Schema-validated on read. |
| P2 | Daemon restart with `chat_events` populated → projections rebuild deterministically and the dashboard reads the same state it saw before restart. |
| P3 | `chat.session.send` produces a row in `chat_commands` even when the receiving permission flow rejects the prompt. |
| P4 | One unified sqlite file holds chat + tasks; JSON files under `.tasks/` are removed. |

### Concrete sqlite DDL — our subset

Day-1 schema for G14-T05 (Phase 1). Five tables, no projections yet —
those land in G14-T06. We start narrow and add migrations as needed,
matching how t3 grew theirs.

```sql
-- Migration 001: chat event store
CREATE TABLE IF NOT EXISTS chat_events (
  sequence            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,             -- ulid / uuid
  aggregate_kind      TEXT NOT NULL,                    -- "thread" | "turn" | "session" | "checkpoint" | "plan"
  stream_id           TEXT NOT NULL,                    -- threadId for thread-scoped events
  stream_version      INTEGER NOT NULL,                 -- per-stream monotonic
  event_type          TEXT NOT NULL,                    -- e.g. "chat.activity.appended"
  occurred_at         TEXT NOT NULL,                    -- ISO8601
  command_id          TEXT,                             -- nullable; ties back to chat_commands
  causation_event_id  TEXT,                             -- the event that caused this one (reactor chains)
  correlation_id      TEXT,                             -- end-to-end trace id
  actor_kind          TEXT NOT NULL,                    -- "user" | "provider" | "system"
  session_id          TEXT,                             -- denormalized for multi-agent queries (T078)
  payload_json        TEXT NOT NULL,
  metadata_json       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_events_stream_version
  ON chat_events(aggregate_kind, stream_id, stream_version);

CREATE INDEX IF NOT EXISTS idx_chat_events_stream_seq
  ON chat_events(aggregate_kind, stream_id, sequence);

CREATE INDEX IF NOT EXISTS idx_chat_events_correlation
  ON chat_events(correlation_id);

CREATE INDEX IF NOT EXISTS idx_chat_events_session
  ON chat_events(session_id);

-- Migration 002: command receipts (Phase 3, but DDL is cheap to land early)
CREATE TABLE IF NOT EXISTS chat_commands (
  command_id      TEXT PRIMARY KEY,                -- ulid
  command_type    TEXT NOT NULL,                   -- e.g. "chat.session.send"
  received_at     TEXT NOT NULL,
  decided_at      TEXT NOT NULL,
  outcome         TEXT NOT NULL,                   -- "accepted" | "rejected"
  rejection_code  TEXT,                            -- nullable; only set when outcome = rejected
  input_json      TEXT NOT NULL,
  actor_kind      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_commands_received
  ON chat_commands(received_at);

-- Migration 003: projection cursors (Phase 2)
CREATE TABLE IF NOT EXISTS projection_state (
  projection_name           TEXT PRIMARY KEY,      -- e.g. "turn", "activity", "checkpoint", "session"
  last_applied_sequence     INTEGER NOT NULL,
  updated_at                TEXT NOT NULL
);

-- Migration 004: turn projection
CREATE TABLE IF NOT EXISTS projection_turns (
  turn_id                TEXT PRIMARY KEY,
  thread_id              TEXT NOT NULL,
  session_id             TEXT,                     -- nullable for single-session compat
  state                  TEXT NOT NULL,            -- "running" | "completed" | "interrupted" | "error"
  requested_at           TEXT NOT NULL,
  started_at             TEXT,
  completed_at           TEXT,
  assistant_message_id   TEXT,
  source_plan_id         TEXT,                     -- cross-session plan adoption
  source_plan_thread_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_proj_turns_thread ON projection_turns(thread_id);

-- Migration 005: activity projection
CREATE TABLE IF NOT EXISTS projection_activities (
  activity_id     TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,
  turn_id         TEXT,
  session_id      TEXT,
  sequence        INTEGER NOT NULL,
  tone            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proj_act_thread_seq
  ON projection_activities(thread_id, sequence);
CREATE INDEX IF NOT EXISTS idx_proj_act_thread_turn
  ON projection_activities(thread_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_proj_act_thread_session
  ON projection_activities(thread_id, session_id);

-- Migration 006: checkpoint projection
CREATE TABLE IF NOT EXISTS projection_checkpoints (
  thread_id              TEXT NOT NULL,
  turn_id                TEXT NOT NULL,
  checkpoint_ref         TEXT NOT NULL,
  status                 TEXT NOT NULL,
  files_json             TEXT NOT NULL,
  assistant_message_id   TEXT,
  completed_at           TEXT NOT NULL,
  checkpoint_turn_count  INTEGER NOT NULL,
  PRIMARY KEY (thread_id, turn_id)
);

-- Migration 007: session projection (T078)
CREATE TABLE IF NOT EXISTS projection_sessions (
  session_id              TEXT NOT NULL,
  thread_id               TEXT NOT NULL,
  status                  TEXT NOT NULL,
  provider_name           TEXT,
  provider_instance_id    TEXT,
  role                    TEXT,
  display_name            TEXT,
  runtime_mode            TEXT NOT NULL,
  active_turn_id          TEXT,
  last_error              TEXT,
  updated_at              TEXT NOT NULL,
  PRIMARY KEY (thread_id, session_id)
);
```

Note the *denormalized* `session_id` column on `chat_events` and
`projection_activities`. Multi-agent threads (T078) query
"activities for session X" frequently, and an index on a denormalized
column beats a JSON extraction every time.

### Concrete event-store interface

```ts
// packages/daemon/src/persistence/chat-event-store.ts (sketch)

import type Database from "better-sqlite3";
import type { ChatThreadEvent } from "@tmux-ide/contracts";

export interface PersistedChatEvent extends ChatThreadEvent {
  sequence: number;
  eventId: string;
  occurredAt: string;
  streamVersion: number;
  correlationId?: string;
  causationEventId?: string;
}

export interface ChatEventStore {
  append(input: {
    event: ChatThreadEvent;
    actorKind: "user" | "provider" | "system";
    correlationId?: string;
    causationEventId?: string;
    commandId?: string;
  }): PersistedChatEvent;

  readFromSequence(seqExclusive: number, limit?: number): PersistedChatEvent[];

  readByStream(streamId: string, sinceVersion?: number): PersistedChatEvent[];

  /** Used by the projection bootstrap. */
  readAll(): Generator<PersistedChatEvent>;
}

export function makeChatEventStore(db: Database.Database): ChatEventStore {
  const appendStmt = db.prepare<[ /* … */ ]>(`
    INSERT INTO chat_events (
      event_id, aggregate_kind, stream_id, stream_version,
      event_type, occurred_at, command_id, causation_event_id,
      correlation_id, actor_kind, session_id, payload_json, metadata_json
    ) VALUES (?, ?, ?,
      (SELECT COALESCE(MAX(stream_version), 0) + 1
       FROM chat_events WHERE aggregate_kind = ? AND stream_id = ?),
      ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING sequence, stream_version
  `);
  // …implementation…
  return { append, readFromSequence, readByStream, readAll };
}
```

The `stream_version` is assigned inside the `INSERT` using a
correlated subquery — guarantees monotonic per-stream ordering even
under concurrent appenders (sqlite serializes writes; the subquery
sees the latest version atomically).

**Next step**: G14-T05 (P1) and G14-T06 (P2) in the task breakdown.

## 2.2 Effect runtime

### t3 today

- **Schema**: every wire schema in `context/t3code/packages/contracts/src/`
  uses `Schema.Struct` / `Schema.Literals` / `Schema.brand` from
  `effect`. The runtime decoder is `Schema.decodeUnknownEffect`,
  returning an `Effect` with typed error channel.
- **Server orchestration**: every server service uses `Effect.gen` +
  `Context.Service` + `Layer` for dependency injection. The bootstrap
  is `effect.unstable.platform.bun` plus `Effect.runFork`.
- **Concurrency**: `Stream` for event/event-replay flows; `Fiber` for
  workers; `Scope` for resource lifetimes; `Cause` for typed
  error tracking.
- **SQL**: `@effect/sql-sqlite-bun` provides a `SqlClient` whose query
  values are typed via Schema.

### tmux-ide today

- **Schema**: Zod (`zod@^4`). Schemas live in
  `packages/contracts/src/`. Runtime decode is `Z.parse` / `Z.safeParse`.
  No typed error channel — exceptions or `safeParse().success`.
- **Server orchestration**: hand-rolled — `Promise`/`async` + a
  `Hono` app. Dependency injection via constructor functions that
  take options objects (e.g. `makeThreadManager({ store, busEmit, … })`).
- **Concurrency**: native promises + `AbortController`. Stream emulation
  via `EventEmitter`/`Map<id, Listener>` patterns (the WS bus is
  hand-rolled).
- **SQL**: not used today (we use JSON).

### Delta

| Aspect | t3 | tmux-ide | Cost to adopt | Win |
| --- | --- | --- | --- | --- |
| Type-safe error channels | `Effect<R, E, A>` | Throw + try/catch | Re-typing every handler signature | Compiler enforces that "this handler may throw `ThreadNotFoundError`" — today it's documented in comments. |
| Structured concurrency | `Scope` + `Fiber` + `Stream` | Manual `AbortController`/cleanup | High — invasive | Resource leaks become *type errors*, not runtime regressions. |
| Dependency injection | `Layer` + `Context.Service` | Closures over options objects | Medium — every store factory becomes a `Layer` | Test wiring becomes declarative: swap `Layer.succeed(Store, fake)` instead of plumbing fakes through 12 constructor args. |
| Schema | `Schema` from `effect` | `Zod` | Re-derive every schema | Brand support is first-class (see §2.8); transforms (legacy-shape decoding) are more expressive than Zod's `.transform()`. |
| Bundle size | Already includes Effect runtime (~50 KB gzip), `@effect/atom-react`, etc. | Zero Effect today; Zod is small | **~50 KB gzip added to dashboard if Effect lands there**; daemon-side cost is negligible (no shipping cost). | Daemon: just engineering rigor. Dashboard: Atom + Stream-friendly server-state. |

### Recommendation — phased, daemon-first, schema-edge

This is the user's stated framing ("phased — adopt Effect Schema for
new contracts first, then Effect.gen in daemon orchestration, last in
dashboard"). We agree, with one nuance: the **schema migration cannot
be partial** within a single contract file — `chat-thread.ts` has to
be either entirely Zod or entirely Effect Schema, because the
discriminated union and the test fixtures assume one decoder. So:

**Phase A — Effect Schema for new contracts only**.
- New contract files under `packages/contracts/src/<new-aggregate>.ts`
  may use `Schema` from `effect`. Existing files (especially
  `chat-thread.ts`) stay Zod for now.
- Add `effect` and `@effect/schema` to the workspace.
- Acceptance: one new contract file lands using Effect Schema; tsc +
  vitest green; bundle-size measurement of dashboard before/after is
  noted in the PR description.

**Phase B — Daemon services on `Effect.gen` + `Context.Service`**.
- Pick the smallest service to migrate first — `provider-registry.ts`
  is a good first target because it has clear ports (read providers,
  write providers, watch for changes) and no live network.
- Wrap the existing factory in a `Context.Service` and offer both
  imperative (`async/await`) and Effect (`Effect.gen`) entry points
  for one release while consumers migrate.
- Acceptance: `ProviderRegistry.Service` exists alongside `makeProviderRegistry()`.
  Both are exercised by tests. No regression in command-center handlers.

**Phase C — Daemon-wide `ManagedRuntime`**.
- Replace the daemon's `Promise<void>` boot path with `Effect.runFork`
  on a `ManagedRuntime` that composes every service Layer.
- Acceptance: `bin/cli.ts` no longer reaches into a fan of imperative
  setup functions; instead it pulls one `Layer` and runs it.

**Phase D — Dashboard adoption (optional, deferred)**.
- Adopt `@effect/atom-react` *only if* we also adopt Effect on the
  dashboard's server-state path. See §6 open question.
- Until then, keep zustand + (TanStack Query or hand-rolled WS hooks).
  The T050 research is unambiguous about the bundle cost.

### Open question — Schema-everywhere vs Schema-at-edge

**Strong-form**: rewrite *every* contract in Effect Schema, port every
runtime handler to `Effect.gen`. Cost: large, multi-week. Win: every
service in the codebase composes through the same DI system.

**Weak-form** (what we recommend): Effect Schema only at the
contract boundary, Effect runtime only in the daemon, dashboard stays
Zod/zustand. The trade-off is duplicated decoder shapes (`Schema` in
contracts, `Zod` in dashboard) **for one release** until the dashboard
either follows or stays put forever.

**OPEN QUESTION FOR USER**: Pick weak-form (recommended) or strong-form.
The weak-form is reversible; the strong-form is a generational change
to dashboard development.

**Next step**: G14-T07 (P2, Effect Schema for new contracts) + G14-T08
(P2, daemon-side Effect.gen) + G14-T09 (P3, ManagedRuntime bootstrap).

## 2.3 Reactor layers

### t3 today

t3 separates *event emission* from *side effects* via reactor
services:

| Reactor | Source file | What it reacts to | What it does |
| --- | --- | --- | --- |
| `CheckpointReactor` | `apps/server/src/orchestration/Services/CheckpointReactor.ts` | Orchestration + provider-runtime events related to turn lifecycle | Captures baseline diffs, finalizes per-turn diffs, snapshots git refs |
| `OrchestrationReactor` | `apps/server/src/orchestration/Services/OrchestrationReactor.ts` | Orchestration events | Updates aggregated read-model state, fans out to providers |
| `ProviderCommandReactor` | `apps/server/src/orchestration/Services/ProviderCommandReactor.ts` | Provider-side events (tool calls, agent updates) | Translates provider output to orchestration commands |
| `ProviderRuntimeIngestion` | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` | Raw provider stream | Normalizes provider events into the canonical event shape |
| `ThreadDeletionReactor` | `apps/server/src/orchestration/Services/ThreadDeletionReactor.ts` | `thread.deleted` events | Tears down provider sessions, removes checkpoint refs, GCs |

Each reactor:
- Owns a `Scope` for its workers.
- Subscribes to an internal queue (`Queue.unbounded<…>`) that's fed by
  the event bus.
- Has a typed `drain` effect that resolves when the queue is idle —
  used by integration tests to replace `setTimeout`/polling.

### tmux-ide today

The closest thing we have is `thread-manager.ts` itself — it does
*everything*: spawning ACP/Codex clients, handling permission flow,
emitting events, recording usage. The result is a 425-line module
that's hard to refactor (we already split it into `message-pipe.ts` +
`permission-coordinator.ts` + `codex-event-handler.ts` during goal-13
work, but those are extracted *helpers*, not first-class reactors).

The orchestrator (`packages/daemon/src/lib/orchestrator.ts`) does
have a tick-based dispatcher with side effects, but it pulls from the
task store, not from an event stream.

### Delta

| Aspect | t3 | tmux-ide |
| --- | --- | --- |
| Side effects keyed off events | Yes — every reactor `consumer` for a queue | No — side effects fire inline from stores |
| Drain-for-tests | First-class | Hand-rolled `waitFor(() => …)` in test helpers |
| Bounded concurrency per reactor | Built into `Effect.Stream` | Manual |
| Failure isolation | Reactor failures don't take down the daemon | Today an unhandled rejection in a chat handler can crash the daemon process |

### Proposed adoption

Introduce three reactors that match t3's shape *but speak our existing
event union*:

1. `ChatCheckpointReactor` — consumes `chat.turn.completed`,
   `chat.thread.reverted`; calls `checkpoint-engine.snapshot` /
   `revert`. Today this lives inline in `checkpoint-engine.ts`'s
   callers.

2. `ChatProviderRuntimeIngestion` — consumes raw ACP / Codex client
   events; produces `chat.activity.appended`, `chat.turn.*` events
   on the bus. Today this lives in `message-pipe.ts` +
   `codex-event-handler.ts`.

3. `ChatPermissionReactor` — consumes `chat.permission.request`;
   manages the timeout/cancel/reply cycle. Today this is
   `permission-coordinator.ts`.

The three modules already exist as helpers. The migration is a *shape*
change: each becomes a service with `start()`/`drain` and consumes a
real queue, rather than being driven by direct method calls from
`thread-manager.ts`.

**Note**: this is a structural refactor with no user-visible change —
the win is that integration tests in
`packages/daemon/src/chat/chat-integration.test.ts` can swap from
`waitFor` polling to `reactor.drain` deterministically, dropping
flaky-on-CI failure modes.

### Reactor module shape

```ts
// packages/daemon/src/chat/reactors/checkpoint-reactor.ts (sketch)

import type { ChatThreadEvent } from "@tmux-ide/contracts";
import type { CheckpointEngine } from "../checkpoint-engine.ts";
import type { CheckpointStore } from "../checkpoint-store.ts";
import type { ChatEventStore } from "../../persistence/chat-event-store.ts";

export interface CheckpointReactor {
  /** Start the reactor; returns a disposer that drains then halts. */
  start(): Promise<() => Promise<void>>;
  /** Resolves when the input queue is idle. Test-only affordance. */
  drain(): Promise<void>;
}

export interface MakeCheckpointReactorOptions {
  eventStore: ChatEventStore;
  checkpointEngine: CheckpointEngine;
  checkpointStore: CheckpointStore;
  workspaceDirFor: (threadId: string) => string;
  logger?: (event: { level: "info" | "warn" | "error"; msg: string }) => void;
}

export function makeCheckpointReactor(
  opts: MakeCheckpointReactorOptions,
): CheckpointReactor {
  const queue: ChatThreadEvent[] = [];
  let running = false;
  let drainResolvers: Array<() => void> = [];

  function notifyIdle() {
    if (queue.length === 0 && !running) {
      const pending = drainResolvers.splice(0);
      for (const r of pending) r();
    }
  }

  async function process(event: ChatThreadEvent) {
    switch (event.type) {
      case "chat.turn.completed":
        await snapshotForTurn(event.threadId, event.turnId);
        break;
      case "chat.thread.reverted":
        await revertToCheckpoint(event.threadId, event.toCheckpointRef);
        break;
      // …other event types reactor doesn't care about: noop…
    }
  }

  async function snapshotForTurn(threadId: string, turnId: string): Promise<void> {
    const summary = await opts.checkpointEngine.snapshot({
      threadId,
      turnId,
      workspaceDir: opts.workspaceDirFor(threadId),
    });
    opts.checkpointStore.upsert(threadId, /* … */ summary as any);
    // Emit a downstream event with causationEventId set to the trigger
    opts.eventStore.append({
      event: { type: "chat.checkpoint.created", threadId, checkpoint: /* … */ summary as any },
      actorKind: "system",
    });
  }

  async function loop() {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift()!;
        try {
          await process(next);
        } catch (err) {
          opts.logger?.({ level: "error", msg: `reactor failed: ${(err as Error).message}` });
        }
      }
    } finally {
      running = false;
      notifyIdle();
    }
  }

  return {
    async start() {
      const unsub = opts.eventStore /* hypothetical subscribe API */
        // For Phase 2: we subscribe to a Node EventEmitter that the
        // event-store fires after every append. Implementation detail
        // omitted here for brevity.
        ? () => undefined
        : () => undefined;
      return async () => {
        unsub();
        await this.drain();
      };
    },
    drain() {
      if (queue.length === 0 && !running) return Promise.resolve();
      return new Promise((resolve) => drainResolvers.push(resolve));
    },
  };
}
```

The three reactors share the same skeleton (queue + process loop +
`drain()`); only the `process()` body differs. The shape mirrors t3's
`CheckpointReactor.start` + `CheckpointReactor.drain` API in the
`Services/CheckpointReactor.ts` contract — we replace `Effect.gen` +
`Queue.unbounded` with an `Array`-backed queue because we are not yet
on Effect. When G14-T08/T09 land, the same module rewrites in
`Effect.gen` with no shape change to callers.

### Acceptance

- A new directory `packages/daemon/src/chat/reactors/` holds
  three reactor files plus tests.
- `thread-manager.ts` shrinks because its responsibility is now
  *boot the reactors and route the public action API*; the live event
  flow happens in reactors.
- The integration suite uses `.drain()` calls and stops importing
  `setTimeout`.

### Failure isolation

Each reactor catches errors from its `process()` body and logs them.
A failing reactor does *not* take down the daemon — it logs, records
the failure as a synthetic event (`chat.reactor.failure`) for audit,
and continues consuming. This matches t3's design where a single bad
event doesn't poison the whole queue.

**Next step**: G14-T10 (P2, M, depends on G14-T05 event log).

## 2.4 TurnDiff projection

### t3 today

t3 splits the *checkpoint* from the *per-turn diff*:

- **CheckpointSummary** (in `chat-thread.ts` analogue) describes a git
  ref + file change list, used by the "revert this turn" affordance.
- **TurnDiff** (`packages/contracts/src/orchestration.ts:1126`) is a
  separate read API exposed via `orchestration.getTurnDiff` that
  returns the diff for a *range* of turn-counts (start, end). It's
  used by the diff viewer in `apps/web` for the "what changed in this
  turn" pane, and by the dashboard's "show me the diff between turn 3
  and turn 5" UX.

The split exists because:
- CheckpointSummary is a snapshot *summary* — file paths + add/del
  counts; lightweight, embedded in every thread snapshot.
- TurnDiff is a full *patch payload* — heavy, fetched on demand.
- TurnDiff supports a range (`getTurnDiff({ from: 3, to: 5 })`) which
  the lightweight summary cannot.

### tmux-ide today

We fold both shapes into `CheckpointSummary.files` (`packages/contracts/src/chat-thread.ts:177`).
Each file has `path` / `kind` / `additions` / `deletions`, but no
actual patch text. The diff viewer in `dashboard/components/diffs/`
fetches diffs separately via `/api/...` endpoints — but those
endpoints are not contract-typed, so there's no end-to-end type-safe
shape for "diff between turn N and turn M".

### Delta

| Aspect | t3 | tmux-ide |
| --- | --- | --- |
| Per-turn diff schema | Yes (`ThreadTurnDiff`) | Folded into `CheckpointSummary.files` (just summary, no patch text) |
| Range query | Yes (`getTurnDiff({ from, to })`) | No |
| Type-safe diff API | Yes via `OrchestrationGetTurnDiffResult` | No — `dashboard/lib/api.ts` returns untyped JSON |

### Proposed adoption

Split into two contracts in `packages/contracts/src/chat-thread.ts`:

```ts
// Lightweight — what the thread snapshot carries today.
export const CheckpointSummaryZ = z.object({
  turnId: TurnIdZ,
  checkpointRef: CheckpointRefZ,
  status: CheckpointStatusZ,
  fileCount: NonNegativeIntZ,           // <- replaces the per-file array
  additions: NonNegativeIntZ,           // <- aggregate
  deletions: NonNegativeIntZ,           // <- aggregate
  // … existing fields …
});

// Full — fetched on demand.
export const TurnDiffZ = z.object({
  threadId: ThreadIdZ,
  turnCountFromInclusive: NonNegativeIntZ,
  turnCountToInclusive: NonNegativeIntZ,
  files: z.array(z.object({
    path: TrimmedNonEmptyStringZ,
    kind: TrimmedNonEmptyStringZ,
    additions: NonNegativeIntZ,
    deletions: NonNegativeIntZ,
    patch: z.string(),                  // full unified diff
  })),
});
```

Add a new action `chat.turn.getDiff` with input `{ threadId, from?,
to? }` (default both = latest turn). Handler reads from
checkpoint-engine + projection.

**Cost**: medium. Two contract additions, one new action, one new
handler, one new dashboard hook. Existing diff UI keeps working
because `CheckpointSummary.files` becomes optional during transition.

**Win**: the diff UI can answer "what changed since the start of this
mission" with a single typed call, instead of N round-trips.

**Next step**: G14-T11 (P2, M).

## 2.5 ProviderApprovalPolicy

### t3 today

`context/t3code/packages/contracts/src/orchestration.ts:29-35`:

```ts
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
```

Paired with a `ProviderSandboxMode` enum:

```ts
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
```

Together these let a user say:
- "Codex: always ask, danger-full-access" (curious user).
- "Claude Code: never ask on read-only tools, ask only on
  workspace-write tools" (production).
- "Local Ollama: untrusted everything" (just spawned, no policy yet).

The policy is consulted by the permission coordinator before *every*
tool call, not just inline tools.

### tmux-ide today

Our permission flow is binary: `RuntimeModeZ = ["approval-required",
"auto-accept-edits", "full-access"]` (in `chat-thread.ts`). At the
session/thread level, not at the per-tool level.

T078 hinted at per-tool policy (multi-agent integration test (h)
shows role-keyed `needsApproval`), but the rule lives in test code,
not a contract.

### Delta

| Aspect | t3 | tmux-ide |
| --- | --- | --- |
| Per-tool policy | Yes | No (per-thread `RuntimeMode` only) |
| Per-tool-kind defaults (read-only vs workspace-write vs danger) | Yes (`ProviderSandboxMode`) | No |
| User-configurable defaults at the provider-instance level | Yes (stored on `ProviderInstance`) | No |

### Proposed adoption

```ts
// packages/contracts/src/chat-thread.ts (proposal — Zod for now, Schema later)

export const ToolKindZ = z.enum([
  "read",            // read_pane, capture_pane, file reads
  "send",            // send_to_pane (writes to a tmux pane)
  "workspace-write", // edits to project files
  "shell",           // arbitrary shell commands
  "network",         // outbound network requests
  "danger",          // anything else (catch-all)
]);

export const ApprovalPolicyZ = z.enum([
  "untrusted",       // always ask, do not remember
  "on-failure",      // run; if the tool errors, ask before retry
  "on-request",      // run silently; ask only when explicitly required
  "never",           // never ask — pure trust
]);

export const ProviderApprovalPolicyZ = z.object({
  // Default applied to any tool kind not in the per-kind map below.
  default: ApprovalPolicyZ.default("untrusted"),
  perKind: z.record(ToolKindZ, ApprovalPolicyZ).default({}),
});
```

Attach to `ProviderInstance` (so policies are per-configured-provider)
and overrideable on a `Session` (so a single multi-agent thread can
have a validator on `untrusted` and a lead on `on-request`).

Permission coordinator becomes:
```ts
const policy = resolvePolicy(session, providerInstance);
const decision = policy.perKind[toolKind] ?? policy.default;
if (decision === "never" || decision === "on-request") {
  // proceed without asking; only surface if the tool itself raises a flag
} else if (decision === "on-failure") {
  // proceed; capture stderr; ask only if it errored
} else {
  // "untrusted" → existing approval flow
}
```

**Cost**: schema additions + plumb through permission coordinator.
Small for the schema, medium for the runtime (every tool now carries
a `kind`).

**Next step**: G14-T12 (P2, S contract / M runtime). The schema can
land in this round even though we said "no new schemas in this
document" — the *plan* includes the schema; the *implementation*
follows in the task.

## 2.6 Provider adapter depth

### t3 today

`context/t3code/apps/server/src/provider/` is broken into:

```
provider/
  acp/                              # ACP-protocol bindings
  Drivers/                          # ClaudeDriver, CodexDriver, CursorDriver, OpenCodeDriver
  Layers/                           # All the Effect Layers
    ProviderAdapterRegistry.ts        - registers per-driver adapters
    ProviderInstanceRegistryLive.ts   - per-instance lifecycle
    ProviderService.ts                - top-level facade
    ProviderRegistry.ts               - read-side registry of configured providers
    ProviderSessionDirectory.ts       - per-session lookup
    ProviderSessionReaper.ts          - GC for orphaned provider sessions
    ProviderEventLoggers.ts           - NDJSON event logging
    ClaudeAdapter.ts                  - Claude-specific runtime adapter
    CodexAdapter.ts                   - Codex-specific runtime adapter
    CursorAdapter.ts                  - Cursor-specific runtime adapter
    OpenCodeAdapter.ts                - OpenCode-specific runtime adapter
    CodexSessionRuntime.ts            - Codex per-session runtime details
  Services/                         # Effect Context.Service tags
  testUtils/
```

Each Layer is small (50-200 lines) and has a single responsibility:
register, hydrate, reap, log. Drivers are even smaller — pure data
about how to spawn a provider.

### tmux-ide today

We have:
```
packages/daemon/src/chat/
  provider-discovery.ts        # one-shot scan for installed providers
  provider-registry.ts         # in-memory map of provider kind → adapter functions
  provider-store.ts            # disk-persisted ProviderInstance records
  acp/                         # ACP protocol bindings
  codex/                       # Codex protocol bindings
  message-pipe.ts              # bridges agent events to our event bus
  codex-event-handler.ts       # codex-specific event handling
  codex-helpers.ts             # codex helpers
```

The "depth" t3 has — separate registry / instance-registry / session
directory / event loggers / reaper — collapses in our codebase to two
modules: `provider-registry.ts` (lazy adapter functions) and
`provider-store.ts` (persisted instances).

We don't have:
- A *session directory* — a map of `(threadId, sessionId) → live
  provider session` lookup that's the source of truth for "who owns
  this session?"
- A *session reaper* — a worker that scans for orphan provider
  sessions and tears them down.
- *Event loggers* — t3 logs every provider event to NDJSON on disk for
  post-hoc analysis; we drop them.

### Delta

| Aspect | t3 | tmux-ide |
| --- | --- | --- |
| Adapter registry as separate layer | Yes | Conflated with provider-registry.ts |
| Session directory | Yes — first-class | No — every consumer maintains its own map |
| Session reaper | Yes — bounded scope | No — relies on daemon-shutdown to clean up |
| Event NDJSON logs | Yes | No |
| Per-driver Layer composition | Yes — `ClaudeAdapter`, `CodexAdapter`, … | One `provider-registry.ts` with `if (kind === "codex") …` |

### Proposed adoption

A new `packages/daemon/src/provider/` directory:

```
packages/daemon/src/provider/
  Drivers/
    ClaudeCodeDriver.ts           # static metadata: how to spawn, what schema, what default policy
    CodexDriver.ts
    OllamaDriver.ts               # future: local-ollama
    LmStudioDriver.ts             # future: local-lmstudio
    GenericAcpDriver.ts           # future: any ACP-speaking binary
  Layers/
    AdapterRegistry.ts            # driver kind → factory function
    InstanceRegistry.ts           # persisted ProviderInstance records (replaces provider-store.ts)
    SessionDirectory.ts           # (threadId, sessionId) → live runtime
    SessionReaper.ts              # periodic GC + on-thread-deletion teardown
    EventLoggers.ts               # NDJSON output to ${dataDir}/provider-events/${date}.ndjson
    ProviderService.ts            # public facade: spawn, list, resolve, shutdown
  acp/                            # moved from chat/ — protocol-level, not chat-specific
  codex/                          # moved from chat/
```

The current `chat/` keeps only the *chat-aggregate* logic (turns,
threads, sessions, plans, checkpoints, activities). Provider concerns
live next door, providing the facade `ProviderService` that chat
consumes.

**Cost**: medium. Mostly moves + thin facades. The hard part is the
session reaper (new logic), but it's well-understood.

**Win**: when a new provider lands (Mistral via Generic-ACP,
LM Studio, …), it's a new file under `Drivers/` and a register call —
not a `if (kind === …)` arm added across five modules.

**Next step**: G14-T13 (P2, M, depends on G14-T08 Effect.gen daemon
services so the new layers can be Effect Layers from the start).

## 2.7 Mobile/desktop apps

### t3 today

```
apps/
  server                # the daemon
  web                   # Vite + React UI (browser)
  desktop               # Electron shell that hosts apps/web and spawns apps/server as a child process
  marketing             # Astro site
```

`apps/desktop` is the "ship it as a native-feeling app" surface: it
wraps the web UI in Electron, manages the server child-process
lifecycle, ships native auto-update (`electron-updater`), and exposes
a tray + dock icon.

### tmux-ide today

```
app/                  # Swift / SwiftUI gateway (in development)
app-electron/         # Electron shell (in development)
dashboard/            # Next.js dashboard
docs/                 # Next.js docs site
bin/cli.ts            # CLI
packages/daemon/      # daemon (akin to t3's apps/server)
```

So we already have *two* desktop shells: a Swift one (`app/`) and an
Electron one (`app-electron/`). t3 has only Electron. The Swift one is
the equivalent of t3's `apps/desktop` plus more: it embeds Ghostty
(native terminal) and presents an infinite-canvas UI on macOS.

The Electron one is partially built and mirrors t3's `apps/desktop`
shape (Electron host, web inside).

### Delta

| Aspect | t3 | tmux-ide |
| --- | --- | --- |
| Electron shell | First-class (`apps/desktop`) | In progress (`app-electron/`) |
| Native macOS shell | None | `app/` (Swift, in development) |
| Auto-update | Yes (`electron-updater`) | Partial in `app-electron/`; native auto-update story for `app/` is TBD |
| Mobile | No | No |

### Proposed adoption

**Pick one**: finish *either* the Electron shell *or* the Swift shell
as the canonical desktop surface, not both. The Swift one is the more
distinctive (native, embedded terminal) — strong argument to finish
that one and treat `app-electron/` as a fallback for non-macOS.

User direction in the task description: "tmux-ide's existing `app/`
Swift gateway is the equivalent of t3 `apps/desktop` — finish that
surface; defer `apps/mobile`."

So:
- `app/` (Swift) is the t3-`apps/desktop` analogue. Polish it.
- `app-electron/` continues as the cross-platform fallback (Linux,
  Windows). Keep it in maintenance mode.
- Mobile is out of scope (§4).

**Next step**: G14-T14 (P2, L — finish Swift gateway feature set).
Detailed scope of "finish" is **OPEN QUESTION FOR USER** because the
Swift app's current feature gap is not enumerated in this document.

## 2.8 Branded IDs

### t3 today

`context/t3code/packages/contracts/src/baseSchemas.ts`:

```ts
const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
// …and TurnId, CheckpointRef, EventId, MessageId, ProjectId, etc.
```

The branding gives every ID a nominal type. A function that takes
`(threadId: ThreadId, turnId: TurnId)` cannot be called with the
arguments swapped — even though both are strings at runtime.

### tmux-ide today

`packages/contracts/src/chat-thread.ts`:

```ts
export const ThreadIdZ = z.string();
export type ThreadId = z.infer<typeof ThreadIdZ>;
// ThreadId === string; no brand.
```

`(threadId: ThreadId, turnId: TurnId)` can be called with arguments
swapped. The bug compiles cleanly.

### Delta

| Aspect | t3 | tmux-ide |
| --- | --- | --- |
| Branded IDs | Yes — five+ branded types | No — every ID is `string` |
| Compile-time prevention of ID mix-up | Yes | No |
| Refactor safety when renaming an ID type | Type system catches it | Manual grep |

### Proposed adoption — two options

**Option A — Zod branded strings (no Effect dependency)**.

Zod supports brands:

```ts
export const ThreadIdZ = z.string().brand<"ThreadId">();
export type ThreadId = z.infer<typeof ThreadIdZ>; // string & z.BRAND<"ThreadId">
```

Pros: zero runtime cost, zero new dependencies, immediate adoption,
fits today's stack.

Cons: less ergonomic than Effect Schema. Calling code has to do
`"thr_01" as ThreadId` or `ThreadIdZ.parse("thr_01")` to construct;
TypeScript won't accept a plain string literal anywhere a `ThreadId`
is expected.

**Option B — Migrate IDs to Effect Schema**.

Becomes free *if* §2.2 phase A lands and we have Effect Schema in the
contracts package. Better ergonomics inside Effect-using code.

Cons: forces dashboard (which never sees Effect) to add a runtime
cost just to construct IDs.

### Recommendation

**Adopt Option A now** — zero cost, blocks an entire class of bugs.
Revisit Option B only if we go strong-form Effect in §2.2.

**Migration plan**:
1. Mechanical edit: replace `z.string()` with `z.string().brand<"X">()`
   for the five IDs in `packages/contracts/src/chat-thread.ts`.
2. tsc will surface every cast / constructor / cross-id-passing site.
3. Wrap them all in the appropriate `XIdZ.parse(...)` or `... as XId`
   construct.

**Cost**: small for the schema, medium for the fanout (tsc will yell
across the whole daemon).

**Next step**: G14-T15 (P2, S contract / M fanout).

---

# Deliverable 3 — Task Breakdown (Sequenced)

> All tasks are **P1/P2/P3** by priority (1 = land first) and
> **S/M/L** by effort (S ≤ 2 days, M ≤ 1 week, L > 1 week). Sequence
> follows the dependency arrows; the table below is sorted by
> dependency-aware order.

| # | Title | P | Effort | Engineering rationale | Acceptance | Depends on |
| --- | --- | --- | --- | --- | --- | --- |
| **G14-T01** | **Architectural Rule ADR + ARCHITECTURE.md stub** | P1 | S | Codifies §1 of this document as a referenceable ADR so PR descriptions can cite `ADR-0001` instead of restating the rule. Cheapest possible reduction of mixed-and-matched code review noise. | `docs/adr/0001-rsc-shell-and-siloed-blocks.md` exists; `ARCHITECTURE.md` has a one-paragraph stub linking to it; `CONTRIBUTING.md` (if present) cross-links. | — |
| **G14-T02** | **Silo audit cleanup (table-driven sweep)** | P1 | S | Walk every row of §5's silo audit; for each "needs cleanup" row, file a sub-task or fix inline. Closes out goal-13 cross-framework debt before goal-14 builds on top. | Every row in §5 is either ✅ clean or has a linked tracking task; no row left at "needs cleanup" with no owner. | G14-T01 |
| **G14-T03** | **Silo boundary lint** | P1 | S | Adds the five ESLint rules from §1.4 + the CI grep for stray `mount()` calls. Prevents future "mixed-and-matched" regressions automatically. | `pnpm lint` enforces rules 1-5; deliberate violation reproduces a CI failure; `pnpm lint -- --fix` does not silently bypass the rules. | G14-T01 |
| **G14-T04** | **Branded chat IDs (Zod brand)** | P1 | M | Catches whole bug class (`(threadId, turnId)` swap) at compile time. Cheap mechanically; high signal-to-noise. See §2.8 Option A. | `ThreadId`, `TurnId`, `CheckpointRef`, `EventId`, `MessageId`, `SessionId` all branded; tsc green; tests pass. | — |
| **G14-T05** | **Sqlite event log (chat aggregate)** | P1 | M | Foundation for §2.1, §2.3 (reactors will consume from it), §2.4 (TurnDiff lives here). Replaces ephemeral turn/activity/checkpoint state with durable, replayable storage. | `packages/daemon/src/persistence/chat-event-store.ts` exports `append` + `readFromSequence` + `readAll`; sqlite migration runs idempotently; 1000-event round-trip < 100 ms. | G14-T04 (so events ship branded ids) |
| **G14-T06** | **Projections from event log (turn/activity/checkpoint/session)** | P1 | L | Re-implements the four ephemeral stores as projections that rebuild from the event log on daemon start. Closes the "daemon restart drops chat state" gap. | Daemon restart with a populated event log produces the same projection state. Each projection writes its cursor to `projection_state`. Resume from a gap is rejected. | G14-T05 |
| **G14-T07** | **Effect Schema for new contracts (opt-in path)** | P2 | M | Adopt Effect Schema for *new* contract files only. Avoid touching `chat-thread.ts`. Establishes the dependency in the workspace so future contracts can opt in. See §2.2 Phase A. | `effect` + `@effect/schema` added; one new contract (e.g. `provider-driver.ts`) uses `Schema.Struct`; bundle-size impact on dashboard measured & documented in PR. | — |
| **G14-T08** | **Daemon services on Effect.gen (`ProviderRegistry` first)** | P2 | M | First Effect.gen migration target. Pure read/write registry; no live network. Establishes the pattern; subsequent migrations copy it. See §2.2 Phase B. | `ProviderRegistry.Service` exists alongside `makeProviderRegistry()`; `Layer.succeed(ProviderRegistry, fake)` swappable in tests; no regression in command-center handlers. | G14-T07 |
| **G14-T09** | **Daemon `ManagedRuntime` bootstrap** | P2 | L | The actual bootstrap path becomes one `Layer.merge(...)` + `Effect.runFork`. Removes the fan of imperative `make*` factories from `packages/daemon/src/bin.ts`. See §2.2 Phase C. | `packages/daemon/src/bin.ts` pulls one Layer and runs it; existing CLI commands still work; daemon boot time within ±10% of pre-migration. | G14-T08 |
| **G14-T10** | **Chat reactors (Checkpoint / ProviderRuntimeIngestion / Permission)** | P2 | M | Refactors the three side-effect-heavy chat modules into first-class reactors with `start()` + `drain`. Removes flaky `waitFor(() => …)` polling from integration tests. See §2.3. T087 already landed the analogous `PtyAdapter` (terminal layer) — same shape (`spawnSync`/`spawn` contract + Mock test double), so G14-T10 should re-use that pattern rather than reinvent it. | `packages/daemon/src/chat/reactors/` exists with three reactors + tests; `thread-manager.ts` shrinks by ≥30% LOC; integration tests use `.drain` not `setTimeout`; reactors consume `PtyAdapter`-style injected services where they need terminal output. | G14-T05, G14-T06, T087 (pattern reuse) |
| **G14-T11** | **TurnDiff projection + `chat.turn.getDiff` action** | P2 | M | Splits `CheckpointSummary.files` into "summary on every snapshot" + "TurnDiff on demand". See §2.4. | New `TurnDiffZ` schema; new `chat.turn.getDiff` action; range query (`from`, `to`) works; existing diff UI continues to function during transition. | G14-T05, G14-T06 |
| **G14-T12** | **ProviderApprovalPolicy schema + per-tool resolver** | P2 | M | Per-tool/per-kind approval policy. See §2.5. | `ProviderApprovalPolicyZ` + `ToolKindZ` in contracts; permission coordinator consults policy before raising approval; default for unconfigured tools is `untrusted`; integration test for each policy literal. | G14-T04 (branded ids), G14-T10 (permission reactor) |
| **G14-T13** | **Provider package depth (Drivers / Registry / Directory / Reaper / Loggers)** | P2 | M | §2.6 layer split: `packages/daemon/src/provider/{Drivers,Layers}/...`. | New directory layout; old `provider-{registry,store,discovery}.ts` become thin shims that re-export; session reaper GCs orphaned runtimes; per-driver tests pass. | G14-T08 (Effect.gen) |
| **G14-T14** | **Polish `app/` Swift gateway as the canonical desktop shell** | P2 | L | §2.7. Treat `app/` as the t3-`apps/desktop` analogue. Scope of "polish" is OPEN QUESTION FOR USER (which features are missing today?). | TBD pending OQ resolution. Suggested minimum: persistent project list, multi-thread switching, native auto-update channel, daemon-restart on crash. | — (independent track) |
| **G14-T15** | **Tasks/missions/goals on the same sqlite substrate** | P3 | L | Migrate `.tasks/*.json` + `_events.jsonl` to sqlite. The daemon ships exactly one persistence boundary. See §2.1 Phase 4. | One sqlite file holds chat + task data; `.tasks/*.json` writes are removed; existing CLI commands unaffected; migration is one-way and idempotent. | G14-T06 (we have working projections) |
| **G14-T16** | **Goal-14 retrospective + ARCHITECTURE.md refresh** | P3 | S | Capture lessons; refresh `ARCHITECTURE.md` with the new layout (event store, reactors, provider depth, branded IDs, RSC + silo rule). Closes the loop on every previous task. | `ARCHITECTURE.md` is the single source of truth a new contributor reads; goal-14 retrospective lives in `.tmux-ide/library/learnings.md`. | G14-T05 through G14-T15 |

### Dependency graph (ASCII)

```
G14-T01 (ADR)
    │
    ├──> G14-T02 (silo cleanup)
    └──> G14-T03 (silo lint)

G14-T04 (branded ids)
    │
    └──> G14-T05 (event log)
              │
              ├──> G14-T06 (projections)
              │         │
              │         ├──> G14-T10 (reactors)  ──> G14-T12 (approval policy)
              │         ├──> G14-T11 (TurnDiff)
              │         └──> G14-T15 (tasks-on-sqlite)
              │
              └──> (already foundation)

G14-T07 (Effect Schema) ──> G14-T08 (Effect.gen daemon) ──> G14-T09 (ManagedRuntime)
                                          │
                                          └──> G14-T13 (provider depth)

G14-T14 (Swift app polish)  — independent track

G14-T16 (retrospective)  — gates on everything else
```

### Sequence with checkpoints

| Phase | Tasks | Outcome / checkpoint |
| --- | --- | --- |
| 1 — Codify | G14-T01 + G14-T02 + G14-T03 + G14-T04 | Rule is documented, silos are clean, IDs are branded. **Checkpoint**: code review noise drops, type errors catch ID swaps. |
| 2 — Persistence | G14-T05 + G14-T06 | Chat is durable. **Checkpoint**: `tmux-ide` daemon can be killed mid-turn and resume without losing activity stream. |
| 3 — Effect adoption (gated by OQ §2.2) | G14-T07 + G14-T08 + G14-T09 | Daemon runs on `ManagedRuntime`. **Checkpoint**: a new service is one `Layer`, not one factory + manual wire-up. |
| 4 — Reactors + payloads | G14-T10 + G14-T11 + G14-T12 + G14-T13 | All side effects keyed off the event log via reactors; diff API split; approval policies + provider depth align with t3. **Checkpoint**: test flakiness from `setTimeout`-driven assertions drops to zero. |
| 5 — Unified persistence (optional) | G14-T15 | One sqlite file. **Checkpoint**: rollback is a single file restore. |
| 6 — Native shell + retrospective | G14-T14 + G14-T16 | `app/` is the canonical desktop. Goal 14 is documented. |

**Next step**: Lead picks Phase 1 to start; remaining phases sequence
themselves once Phase 1 lands.

## 3.1 PR-shape sketches per task

Each task lands as one PR. The shape below is the reviewer's
checklist — what to expect in the diff, what tests must accompany,
what *not* to include.

### PR for G14-T01 (ADR + ARCHITECTURE.md stub)

**Diff size**: ~200 lines, all in `docs/`.

```
new:   docs/adr/0001-rsc-shell-and-siloed-blocks.md      ( ~150 lines)
new:   docs/adr/README.md                                ( ~30 lines)  — ADR index
mod:   ARCHITECTURE.md                                   ( ~15 lines)  — append "Dashboard architecture" stub
mod:   CONTRIBUTING.md or .github/PR template            ( ~5 lines)   — link the ADR
```

Tests: none — pure docs.

Risk: zero — pure docs.

Reviewer checks: the ADR is *normative* (RFC-2119 MUST/SHOULD
language); not aspirational prose.

### PR for G14-T03 (silo boundary lint)

**Diff size**: ~150 lines.

```
mod:   eslint.config.js                                  ( ~100 lines)  — add the rule blocks from §1.4
new:   scripts/check-silo-mounts.sh                      ( ~20 lines)
mod:   package.json                                      ( ~3 lines)    — add eslint-plugin-boundaries dep
mod:   .github/workflows/ci.yml                          ( ~10 lines)   — run the grep script
new:   tests/silo-boundary.violation.fixture.tsx         ( ~15 lines)   — deliberate violation; CI runs eslint --no-eslintrc against it and asserts failure
```

Tests: a fixture file containing an intentional `mod.mount()` outside
a Bridge file. CI script runs `eslint` on it and asserts a non-zero
exit code — guarantees the rule is *active*, not just configured.

### PR for G14-T04 (branded IDs)

**Diff size**: ~50 LOC for the contract change, ~150-400 LOC for the
fanout depending on how many call sites need explicit cast/parse.

```
mod:   packages/contracts/src/chat-thread.ts            ( ~6 lines)   — five .brand<>() additions
mod:   packages/contracts/src/chat-thread.test.ts       ( ~20 lines)  — round-trip brand tests
mod:   packages/daemon/src/chat/**/*.ts                 ( ~80 lines)  — fanout: cast at every literal
mod:   packages/daemon/src/command-center/**/*.ts       ( ~30 lines)
mod:   dashboard/lib/**/*.ts                            ( ~40 lines)
```

Tests: existing tests pass with branded types (most fixtures use
template strings, which Zod's `.brand()` accepts via `parse`); a new
test asserts that `ThreadIdZ.parse("thr_01")` returns a value that's
assignable to `ThreadId` but a plain `"thr_01"` is *not*.

### PR for G14-T05 (sqlite event log)

**Diff size**: ~500 lines.

```
new:   packages/daemon/src/persistence/chat-event-store.ts        ( ~200 lines)
new:   packages/daemon/src/persistence/migrations/001_chat_events.ts
new:   packages/daemon/src/persistence/migrations/002_chat_commands.ts
new:   packages/daemon/src/persistence/migrations/003_projection_state.ts
new:   packages/daemon/src/persistence/migrator.ts                ( ~80 lines)
new:   packages/daemon/src/persistence/chat-event-store.test.ts   ( ~150 lines)
mod:   packages/daemon/package.json                                ( better-sqlite3 already a dep — no change )
```

Tests:
- `append` + `readFromSequence` round-trip.
- Concurrent appends from the same stream serialize correctly (the
  correlated subquery test).
- 1000-event round-trip < 100 ms.
- Schema-validation rejects malformed event types on read.
- Re-open after process restart preserves data.

### PR for G14-T06 (projections)

**Diff size**: ~600 lines (new) + ~300 lines (delete from
turn-store/activity-log/checkpoint-store/session-store as they become
thin facades over projections).

```
new:   packages/daemon/src/persistence/projections/turn.ts             ( ~120 lines)
new:   packages/daemon/src/persistence/projections/activity.ts         ( ~120 lines)
new:   packages/daemon/src/persistence/projections/checkpoint.ts       ( ~120 lines)
new:   packages/daemon/src/persistence/projections/session.ts          ( ~120 lines)
new:   packages/daemon/src/persistence/projections/pipeline.ts         ( ~80 lines)
new:   packages/daemon/src/persistence/migrations/004_006_007.ts       (DDL)
mod:   packages/daemon/src/chat/turn-store.ts                          ( ~-150 / +60 lines: become facade)
mod:   packages/daemon/src/chat/activity-log.ts                        ( ~-100 / +50 lines)
mod:   packages/daemon/src/chat/checkpoint-store.ts                    ( ~-80 / +40 lines)
mod:   packages/daemon/src/chat/session-store.ts                       ( ~-100 / +50 lines)
mod:   packages/daemon/src/chat/*.test.ts                              (a few test updates for new persistence)
```

Tests:
- Each projection: replay 100 events → projection state matches an
  imperative reduce.
- Daemon restart: stop, restart, projections are at the same
  `last_applied_sequence` as before.
- Gap detection: insert event N+2 with N+1 missing → projection
  refuses to advance, raises a typed error.

### PR for G14-T07 (Effect Schema for new contracts)

**Diff size**: ~100 lines for the new contract + ~30 for workspace.

```
new:   packages/contracts/src/provider-driver.ts          ( ~80 lines — uses Schema.Struct)
new:   packages/contracts/src/provider-driver.test.ts     ( ~50 lines)
mod:   packages/contracts/package.json                    ( + effect dep )
mod:   packages/contracts/src/index.ts                    ( re-export )
mod:   pnpm-lock.yaml                                     ( lockfile diff )
```

The first Effect-Schema contract should be small and isolated —
`provider-driver.ts` (a tiny set of driver metadata records) is
ideal. Do *not* migrate `chat-thread.ts` in this PR.

### PR for G14-T08 (ProviderRegistry on Effect.gen)

**Diff size**: ~250 lines, mostly the dual-API facade.

```
new:   packages/daemon/src/chat/provider-registry.effect.ts   ( ~150 lines — Effect.gen service)
mod:   packages/daemon/src/chat/provider-registry.ts          ( ~+50 lines — re-export the Effect service alongside the existing factory)
new:   packages/daemon/src/chat/provider-registry.effect.test.ts   ( ~80 lines — uses it.layer pattern from effect/vitest)
```

The existing `makeProviderRegistry()` stays as a test-fixture
constructor; the production path imports
`ProviderRegistry.Service` from the new file.

### PR for G14-T10 (chat reactors)

**Diff size**: ~700 lines (~300 new, ~250 deleted from
thread-manager.ts, ~150 test updates).

```
new:   packages/daemon/src/chat/reactors/checkpoint-reactor.ts     ( ~150 lines)
new:   packages/daemon/src/chat/reactors/runtime-ingestion.ts      ( ~120 lines)
new:   packages/daemon/src/chat/reactors/permission-reactor.ts     ( ~130 lines)
new:   packages/daemon/src/chat/reactors/*.test.ts                 ( ~3x80 lines)
mod:   packages/daemon/src/chat/thread-manager.ts                  ( ~-200 / +80 lines)
mod:   packages/daemon/src/chat/permission-coordinator.ts          ( deleted or merged into permission-reactor)
mod:   packages/daemon/src/chat/message-pipe.ts                    ( becomes internal helper for runtime-ingestion)
mod:   packages/daemon/src/chat/codex-event-handler.ts             ( becomes internal helper)
mod:   packages/daemon/src/chat/chat-integration.test.ts           ( swap waitFor → reactor.drain)
```

Tests:
- Order preservation: a scripted run that produces `activity.appended
  ×5, turn.completed` events fires reactors in the right order — the
  CheckpointReactor sees `turn.completed` *after* the 5 activities.
- Failure isolation: a CheckpointReactor that throws still lets the
  PermissionReactor process subsequent permission requests.
- `drain` semantics: a test sets a 100ms-blocked snapshot, calls
  `drain`, asserts the test does not return until the snapshot
  completes.

### PR for G14-T11 (TurnDiff)

**Diff size**: ~400 lines.

```
mod:   packages/contracts/src/chat-thread.ts                       ( ~+30 lines — TurnDiffZ schema)
mod:   packages/contracts/src/actions-contract.ts                  ( ~+10 lines — chat.turn.getDiff action)
new:   packages/daemon/src/command-center/actions/handlers/chat-turn-get-diff.ts   ( ~120 lines)
new:   packages/daemon/src/persistence/projections/turn-diff.ts    ( ~80 lines)
mod:   packages/daemon/src/persistence/migrations/008_turn_diff.ts ( ~30 lines — patch_text BLOB table)
new:   tests for the above                                          ( ~150 lines)
mod:   dashboard/lib/api.ts                                        ( ~+15 lines — chatTurnGetDiff client)
mod:   dashboard/components/diffs/*                                ( ~+30 lines — use new endpoint)
```

Tests: range query (`from: 1, to: 3`) returns the same diff as the
union of single-turn diffs `1`, `2`, `3`. Bulk diff for an empty
range is the empty diff (not an error).

### PR for G14-T12 (ProviderApprovalPolicy)

**Diff size**: ~300 lines.

```
mod:   packages/contracts/src/chat-thread.ts                       ( ~+50 lines — ApprovalPolicy + ToolKind)
mod:   packages/daemon/src/chat/tool-registry.ts                   ( ~+15 lines — tool kind on each tool definition)
mod:   packages/daemon/src/chat/reactors/permission-reactor.ts     ( ~+40 lines — policy resolution)
new:   packages/daemon/src/chat/policy-resolver.ts                 ( ~80 lines — pure: session+provider → effective policy)
new:   packages/daemon/src/chat/policy-resolver.test.ts            ( ~60 lines)
mod:   packages/daemon/src/chat/chat-integration.test.ts           ( ~+40 lines — one scenario per policy literal)
```

Tests: matrix of `(toolKind, policy)` × expected behaviour. 6 tool
kinds × 4 policies = 24 cases; assert the resolver picks the right
action for each cell.

### PR for G14-T13 (provider package depth)

**Diff size**: ~800 lines (mostly file moves).

```
new:   packages/daemon/src/provider/                               (mostly moved from chat/)
move:  packages/daemon/src/chat/provider-{registry,store,discovery}.ts
       → packages/daemon/src/provider/Layers/{InstanceRegistry,AdapterRegistry,Discovery}.ts
move:  packages/daemon/src/chat/{acp,codex}/
       → packages/daemon/src/provider/{acp,codex}/
new:   packages/daemon/src/provider/Drivers/{ClaudeCode,Codex}Driver.ts  ( ~60 lines each — pure metadata)
new:   packages/daemon/src/provider/Layers/SessionDirectory.ts          ( ~120 lines)
new:   packages/daemon/src/provider/Layers/SessionReaper.ts             ( ~150 lines)
new:   packages/daemon/src/provider/Layers/EventLoggers.ts              ( ~100 lines — NDJSON output)
new:   packages/daemon/src/provider/index.ts                            ( re-export the public surface)
mod:   imports across packages/daemon/src/                              ( ~80 files updated)
```

Tests: existing provider-registry/store/discovery tests pass without
modification (paths only). New test for SessionReaper that asserts
orphan teardown on thread delete.

### PR for G14-T15 (tasks-on-sqlite)

**Diff size**: ~700 lines + a one-way migration script.

```
new:   packages/daemon/src/persistence/migrations/00X_tasks.ts
new:   packages/daemon/src/persistence/projections/task.ts
new:   packages/daemon/src/persistence/projections/mission.ts
new:   packages/daemon/src/persistence/projections/goal.ts
new:   scripts/migrate-tasks-to-sqlite.mjs               ( reads .tasks/*.json + _events.jsonl, writes to sqlite, archives the originals to .tasks-legacy/)
mod:   packages/daemon/src/lib/task-store.ts             ( reduce to facade over the projection)
mod:   packages/daemon/src/lib/event-log.ts              ( reduce to facade over chat-event-store with aggregate_kind = "task")
```

Tests: idempotency of the migration script (running twice is a no-op,
not a duplicate). Restore-from-legacy path documented.

**Next step**: each task's PR is reviewed against this sketch before
implementation begins — sketch becomes the AC.

---

# Deliverable 4 — Out of Scope (Explicit)

| Item | Why out of scope |
| --- | --- |
| **`ThreadEnvMode = "worktree"`** (per-thread git worktrees) | **User direction**: explicit "we don't want this" in the task description. Worktree management adds disk I/O, filesystem-state ambiguity, and a costly thread-lifecycle hook that we do not need. Threads share the project's working directory; per-turn isolation is provided by the checkpoint snapshot, not by worktree separation. |
| **Realtime audio (TTS / STT in chat)** | t3 doesn't ship it either; no user demand on our side; would invite a whole "voice provider" axis. |
| **Full `packages/ssh` package** | t3 has SSH command/config/tunnel/auth helpers as a workspace package because t3 exposes a hosted-remote story (remote-attach to a hosted daemon). We have `packages/daemon/src/lib/tunnels/` for ngrok/cloudflare — that's our equivalent. No need to lift it into a separate package until we have a second consumer. |
| **`packages/tailscale`** | Tailscale isn't on the roadmap; pairing-via-ngrok is good enough for the personal-daemon use case. |
| **`apps/mobile` (iOS / Android)** | Confirmed deferred in user direction. The Swift native gateway (§2.7) is desktop-only. Mobile would need its own contract surface for "view threads, approve permissions" — defer until there's a real ask. |
| **Astro marketing site** | We have `docs/` (Next.js). No second marketing surface needed. |
| **Full Effect adoption in the dashboard** | T050 research recommends zustand. Adopting `@effect/atom-react` in the dashboard means ~50 KB gzip + multi-day rewrite of the WS layer to fit Effect's primitives. Out of scope unless OQ §2.2 flips. |
| **Rewriting goal-13 in Effect Schema** | `packages/contracts/src/chat-thread.ts` stays Zod for goal 14. A Schema migration would force the whole dashboard to follow and is not the marginal-engineering-rigor win Phase A claims. |
| **Replacing zustand on the dashboard** | T050 recommends zustand; the dashboard's current zustand patterns (`projectStore`, `chatStore`, …) match t3's *own* zustand usage in `apps/web`. No change needed. |
| **GraphQL / tRPC / RPC layer overhaul** | We have the action protocol (`packages/contracts/src/actions-contract.ts`) + Hono REST. t3 also has its own bespoke RPC (`packages/contracts/src/rpc.ts`); they didn't pick GraphQL either. Our layer is sufficient. |
| **Multiple databases per workspace** | We use one daemon-level data dir; tasks land in `.tasks/` per project, chat data lands in `${dataDir}` globally. Multi-database is over-engineering for the single-user/personal-daemon target. |

**Out-of-scope marker for review**: if a future PR proposes any of
the above, reviewer should reject with a link to this section.

**Next step**: nothing to do — this section is normative. Add a one-line
reference in `.github/PULL_REQUEST_TEMPLATE.md` (if present) pointing
reviewers to this list.

---

# Deliverable 5 — Silo Audit (Cross-Framework Boundaries Today)

Each row is one file/package that currently spans a framework boundary
(React, Solid, Swift, Electron, …) or has cross-framework imports.
"Status" is one of:
- ✅ **Clean** — already follows the rule from §1.
- ⚠️ **Needs cleanup** — works today, but breaks the rule.
- 🟡 **Borderline** — depends on OQ; revisit.

| # | File / Package | Current shape | Owning silo | Status | Notes / required cleanup |
| --- | --- | --- | --- | --- | --- |
| 1 | `dashboard/components/chat/ChatTabPanel.tsx` | React Client; dynamic-imports `@tmux-ide/chat-solid` and calls `mod.mount(el, props)`; manages `handleRef`; calls `setSessionName` / `setThreadId` on prop change. | chat-solid | ✅ Clean | Matches the §1.3 template almost verbatim. **Action**: rename to `ChatSiloBridge.tsx` for consistency with the future bridge naming convention. |
| 2 | `dashboard/app/v2/_lib/V2MissionControlIsland.tsx` | React Client; dynamic-imports `@tmux-ide/v2-solid-widgets`; calls `mountMissionControl`. | v2-solid-widgets | ✅ Clean | Conforms to the pattern. **Action**: same rename → `MissionControlSiloBridge.tsx`. |
| 3 | `dashboard/app/v2/_lib/V2ExplorerIsland.tsx` | Same pattern, `mountExplorer`. | v2-solid-widgets | ✅ Clean | Rename. |
| 4 | `dashboard/app/v2/_lib/V2CostsIsland.tsx` | Same pattern, `mountCosts`. | v2-solid-widgets | ✅ Clean | Rename. |
| 5 | `dashboard/app/v2/_lib/V2ChangesIsland.tsx` | Same pattern. | v2-solid-widgets | 🟡 Borderline | Uses `import type { ... } from "@tmux-ide/v2-solid-widgets"` for the handle type — that's fine. tsc currently flags it as "Cannot find module" pending workspace install; check if it's just a transient. |
| 6 | `dashboard/components/chat/NewChatPicker.tsx` | Pure React Client. No silo. | dashboard | ✅ Clean | — |
| 7 | `dashboard/components/chat-v2/PlanCardStub.tsx` | React Client; receives a typed plan from `@tmux-ide/contracts`; no silo crossing. | dashboard | ✅ Clean | — |
| 8 | `dashboard/lib/actionClient.ts` | Imports `@tmux-ide/contracts` types only. | dashboard | ✅ Clean | — |
| 9 | `dashboard/components/settings/ProvidersPanel.tsx` | React Client; imports `@tmux-ide/contracts` for `ProviderInstance`. | dashboard | ✅ Clean | — |
| 10 | `packages/chat-solid/` | Solid SPA mounted via `mount()`. Exports `mount`, `unmount`, `setThreadId`, `setSessionName`. | chat-solid (self) | ✅ Clean | Add a `README.md` describing the `mount()` API contract + setter convention. |
| 11 | `packages/v2-solid-widgets/` | Solid SPA with multiple `mount*` functions (one per widget). | v2-solid-widgets (self) | ✅ Clean | Same README ask. |
| 12 | `dashboard/components/chat/types.ts` | Re-exports types from `@tmux-ide/contracts` for local use. | dashboard | ✅ Clean | — |
| 13 | `app-electron/src/main.ts` | Electron host. Loads `dashboard` via dev server URL or built bundle. | desktop (Electron) | 🟡 Borderline | If `app-electron/` reaches into `packages/daemon/src/...` directly that breaks the silo rule. **Action**: audit `app-electron/src/`; it should only consume `@tmux-ide/daemon`'s package entry point. |
| 14 | `app/TmuxIde/` (Swift) | Native macOS app. Communicates with daemon over command-center REST/SSE/WebSocket. | desktop (Swift) | ✅ Clean | The HTTP boundary *is* the silo boundary; no shared types except via OpenAPI / hand-written Swift Codable types. **Action**: track the type drift between Swift Codable and Zod schemas (today: manual). Consider OpenAPI export from contracts as a follow-up. |
| 15 | `dashboard/lib/menuBridge.ts` | React Client; bridges Tauri-like menu events into the dashboard. | dashboard | ✅ Clean | Name "bridge" overloads with §1.3 silo bridge — rename to `menuTransport.ts` to avoid confusion. |
| 16 | `dashboard/app/v2/_lib/V2ChatView.tsx` | React Client; tsc currently flags missing exports from `@/lib/api`. | dashboard | ⚠️ Needs cleanup | Pre-existing tsc errors against `@/lib/api` — looks like a stale dashboard during the goal-13 transition. **Action**: file as goal-13 cleanup before goal-14 starts. |
| 17 | `dashboard/lib/appProtocol.ts` | React Client utility for cross-tab postMessage. | dashboard | ✅ Clean | — |
| 18 | `dashboard/components/tui/` | Subdir with `common/queries.ts` (50 tsc errors), `common/position.ts` (19), `common/utilities.ts` (14). | dashboard | ⚠️ Needs cleanup | Heavy tsc error count suggests an in-progress migration. Either complete or delete before goal-14 work compounds. **Action**: triage tracking task. |
| 19 | `packages/daemon/src/cli.ts` | Daemon's own CLI entrypoint (untracked file, 43 tsc errors). | daemon | ⚠️ Needs cleanup | Untracked, pre-existing tsc errors. Either land or revert; either way clean before goal-14. |
| 20 | `app-electron/` workspace | Standalone Electron host. | desktop (Electron) | 🟡 Borderline | If we commit to `app/` (Swift) as canonical (§2.7), `app-electron/` becomes a fallback. Decide its status (maintained / archived / deleted) before goal-14 retrospective. |

### Summary

- **Clean rows (15)**: existing silos are correctly boundaried.
- **Borderline rows (3)**: pending OQ resolution.
- **Needs-cleanup rows (3)**: tsc errors / partially-migrated dirs;
  must close before goal-14 work compounds.

**Next step**: G14-T02 sweeps the four `⚠️/🟡` rows. Track in a single
sub-task that closes the audit.

---

# Deliverable 6 — Risks + Open Questions

## 6.1 Risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R1 | Effect bundle cost lands in the dashboard accidentally (via a contract that pulls in `effect`). | M | H — adds ~50 KB gzip. | Keep Effect Schema in *new* contract files only (Phase A). Add a CI check that fails if `effect` resolves transitively into `dashboard/.next/static/chunks/*`. |
| R2 | RSC-only rendering breaks client hydration when a silo mounts. | L | M — flash of empty host element before silo bootstraps. | Bridges already render an empty host `<div>` and dynamic-import the silo inside `useEffect`. Verify with a Lighthouse pass before/after R1 lands. |
| R3 | sqlite migration on existing installs corrupts state. | L | H — user loses chat history. | Migrations are pure SQL DDL (no data migration in Phase 1); JSON backup written to `${dataDir}/legacy/` before migration runs; documented rollback path: delete `daemon.sqlite`, fall back to `legacy/`. |
| R4 | Branded IDs cause cascading tsc breakage across consumers we didn't track. | M | M — 50+ files might need fixes. | tsc fanout will be visible in CI before the PR merges. Acceptable cost: every file that handles IDs is now type-checked for the swap-bug. |
| R5 | Reactor refactor (G14-T10) accidentally changes event timing / order. | M | H — chat tests pass but live chat misbehaves. | Reactors process events through a single `Queue` per reactor; sequence is preserved by sqlite event store. Add a regression test that asserts the order of `chat.activity.appended` events for a known scripted turn. |
| R6 | Provider depth refactor (G14-T13) leaves orphaned provider sessions. | L | M — daemon RAM grows over time. | New `SessionReaper` is the entire point of the refactor; ship with a test that creates 10 sessions, removes 5 threads, and asserts the reaper tears down exactly those 5 runtimes. |
| R7 | Swift app (`app/`) and dashboard (Next.js) drift on contract shape. | H — already happening | H — silent runtime breakage. | Generate OpenAPI from contracts as a follow-up; Swift Codable types decoded from OpenAPI rather than hand-written. Track in G14-T14. |
| R8 | "Mixed-and-matched" antipattern re-emerges in PRs because the lint rules from §1.4 are not in place yet. | H | M — silo boundaries quietly erode. | G14-T03 is in Phase 1 to prevent this. Until then, every PR review explicitly checks against ADR-0001. |
| R9 | Effect adoption (Phase B/C) is partial and we end up with two coexisting service-construction patterns. | M | M — bus factor on understanding the daemon doubles. | Make G14-T09 (ManagedRuntime bootstrap) a hard gate — when it lands, *all* services route through one Layer; the `make*` factories become test fixtures only. |
| R10 | TurnDiff API gets used naively (full project diff every keystroke) and balloons sqlite. | L | M — disk fills. | Diff payloads land lazily; default range is `latestTurn..latestTurn`; the cache-bust key is the turn id so re-querying the same range hits the projection cache. |

## 6.2 Open questions (need user input before committing)

### OQ-1 — Effect adoption breadth (§2.2)

We recommend **weak-form**: Effect Schema in new contracts only,
Effect.gen in the daemon, dashboard stays Zod/zustand. Strong-form is
a generational change for the dashboard.

**OPEN QUESTION FOR USER**: weak-form or strong-form? Answering this
gates G14-T07/T08/T09's scope.

### OQ-2 — Swift app scope (§2.7, G14-T14)

We propose "polish `app/` as the canonical desktop shell". But the
feature gap of today's `app/` is not enumerated in this document.

**OPEN QUESTION FOR USER**: what's the minimum set of features the
Swift app needs to ship in goal 14? Suggested baseline:
- Persistent project list (synced via daemon API).
- Multi-thread switching with PTY mirroring.
- Native auto-update channel.
- Daemon-restart-on-crash supervised by the app process.
- Tray + dock badge.

Confirm or adjust this list.

### OQ-3 — `app-electron/` future (§2.7, §5 row 20)

We propose keeping `app-electron/` as a fallback for non-macOS
platforms but in maintenance mode (no new features).

**OPEN QUESTION FOR USER**: maintain, archive, or delete?

### OQ-4 — Persistence rollout per project vs daemon-wide (§2.1)

Phase 1 puts the sqlite at `${TMUX_IDE_DATA_DIR}/daemon.sqlite`
(daemon-wide). Alternative: one sqlite per project (`<project>/.tmux-ide/chat.sqlite`).

Pros of daemon-wide: one file, one migration story, one cursor table.
Pros of per-project: keeps project data co-located with the project;
no shared lock contention; rolling back a project = `rm -rf .tmux-ide/`.

**OPEN QUESTION FOR USER**: daemon-wide or per-project? Default
recommendation is daemon-wide for consistency with t3.

### OQ-5 — sqlite driver — better-sqlite3 vs `bun:sqlite` vs `@effect/sql-sqlite-bun`

t3 uses `@effect/sql-sqlite-bun` because they run on Bun. We have a
mixed Node/Bun story (`bin/cli.ts` shebangs `bun`; daemon ships as a
node module). better-sqlite3 is in `package.json` already.

**OPEN QUESTION FOR USER**: stay on better-sqlite3 (works in both
node and bun) or move to `@effect/sql-sqlite-bun` (forces bun)?

### OQ-6 — Goal 14 timeline

The 16 tasks at ~M effort each could land in 4-6 weeks of focused
work. Some are independent (G14-T14 Swift app); others gate hard
(G14-T05 → G14-T06 → G14-T10).

**OPEN QUESTION FOR USER**: target completion date? Phase 1 + Phase
2 (codify + persistence) is the natural MVP; Phases 3-6 are
extensions.

### OQ-7 — Naming: silo bridges

We propose renaming `ChatTabPanel.tsx` → `ChatSiloBridge.tsx`,
`V2*Island.tsx` → `*SiloBridge.tsx` for consistency with §1.3.

The current names (`Panel`, `Island`) carry historical meaning. Cost
of rename: small (mechanical). Benefit: when you grep for `Bridge`,
you find every silo crossing.

**OPEN QUESTION FOR USER**: rename now (in G14-T02) or leave today's
names and adopt the new convention going forward?

### OQ-8 — Branded IDs cast site

When G14-T04 lands, places that construct an ID from a string literal
(`"thr_01"`) will tsc-error. We can either:

(a) Force callers to use `ThreadIdZ.parse("thr_01")` — runtime cost
    but always validated.
(b) Provide an unsafe `asThreadId(s: string): ThreadId` helper —
    zero-cost but bypasses validation.
(c) Both — `.parse` for untrusted input, `.unsafe` for known-good
    test fixtures.

**OPEN QUESTION FOR USER**: pick a convention.

---

# Appendix A — Cross-references

## A.1 t3 sources cited in this document

| Topic | t3 path |
| --- | --- |
| Branded IDs | `context/t3code/packages/contracts/src/baseSchemas.ts` |
| Approval policy / sandbox mode | `context/t3code/packages/contracts/src/orchestration.ts:29-41` |
| TurnDiff schema | `context/t3code/packages/contracts/src/orchestration.ts:1126-1183` |
| Worktree mode (explicitly out of scope) | `context/t3code/packages/contracts/src/settings.ts:85-86` |
| Event store service | `context/t3code/apps/server/src/persistence/Services/OrchestrationEventStore.ts` |
| Event store live layer | `context/t3code/apps/server/src/persistence/Layers/OrchestrationEventStore.ts` |
| Command receipts | `context/t3code/apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` |
| Projection pipeline | `context/t3code/apps/server/src/orchestration/Services/ProjectionPipeline.ts` |
| Projection state cursors | `context/t3code/apps/server/src/persistence/Layers/ProjectionState.ts` |
| Migrations | `context/t3code/apps/server/src/persistence/Migrations/001_OrchestrationEvents.ts` |
| CheckpointReactor | `context/t3code/apps/server/src/orchestration/Services/CheckpointReactor.ts` |
| OrchestrationReactor | `context/t3code/apps/server/src/orchestration/Services/OrchestrationReactor.ts` |
| ProviderCommandReactor | `context/t3code/apps/server/src/orchestration/Services/ProviderCommandReactor.ts` |
| ProviderRuntimeIngestion | `context/t3code/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` |
| RuntimeReceiptBus | `context/t3code/apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` |
| Provider service composition | `context/t3code/apps/server/src/provider/Layers/ProviderService.ts` |
| Per-driver layers | `context/t3code/apps/server/src/provider/Layers/{Claude,Codex,Cursor,OpenCode}Adapter.ts` |
| Driver definitions | `context/t3code/apps/server/src/provider/Drivers/{Claude,Codex,Cursor,OpenCode}Driver.ts` |
| Session directory | `context/t3code/apps/server/src/provider/Layers/ProviderSessionDirectory.ts` (and Services) |
| Session reaper | `context/t3code/apps/server/src/provider/Layers/ProviderSessionReaper.ts` |
| Event NDJSON loggers | `context/t3code/apps/server/src/provider/Layers/EventNdjsonLogger.ts` + `ProviderEventLoggers.ts` |
| Desktop shell (Electron) | `context/t3code/apps/desktop/` |

## A.2 tmux-ide sources cited in this document

| Topic | tmux-ide path |
| --- | --- |
| Chat-thread contracts | `packages/contracts/src/chat-thread.ts` |
| Thread store | `packages/daemon/src/chat/thread-store.ts` |
| Thread manager | `packages/daemon/src/chat/thread-manager.ts` |
| Turn store | `packages/daemon/src/chat/turn-store.ts` |
| Activity log | `packages/daemon/src/chat/activity-log.ts` |
| Plan store | `packages/daemon/src/chat/plan-store.ts` |
| Checkpoint store | `packages/daemon/src/chat/checkpoint-store.ts` |
| Session store (T078) | `packages/daemon/src/chat/session-store.ts` |
| Permission coordinator | `packages/daemon/src/chat/permission-coordinator.ts` |
| Message pipe | `packages/daemon/src/chat/message-pipe.ts` |
| Codex event handler | `packages/daemon/src/chat/codex-event-handler.ts` |
| Provider discovery | `packages/daemon/src/chat/provider-discovery.ts` |
| Provider registry | `packages/daemon/src/chat/provider-registry.ts` |
| Provider store | `packages/daemon/src/chat/provider-store.ts` |
| ACP protocol bindings | `packages/daemon/src/chat/acp/` |
| Codex protocol bindings | `packages/daemon/src/chat/codex/` |
| Command-center server | `packages/daemon/src/command-center/server.ts` |
| Chat action handlers | `packages/daemon/src/command-center/actions/handlers/chat-actions.ts` |
| Tasks event log | `.tasks/_events.jsonl` |
| Tasks index | `.tasks/tasks/*.json` |
| Goals | `.tasks/goals/*.json` |
| Mission | `.tasks/mission.json` |
| Dashboard chat bridge | `dashboard/components/chat/ChatTabPanel.tsx` |
| Dashboard mission island | `dashboard/app/v2/_lib/V2MissionControlIsland.tsx` |
| Dashboard explorer island | `dashboard/app/v2/_lib/V2ExplorerIsland.tsx` |
| Dashboard costs island | `dashboard/app/v2/_lib/V2CostsIsland.tsx` |
| Dashboard changes island | `dashboard/app/v2/_lib/V2ChangesIsland.tsx` |
| chat-solid silo | `packages/chat-solid/src/index.tsx` |
| v2-solid-widgets silo | `packages/v2-solid-widgets/src/index.tsx` |
| Electron host | `app-electron/src/main.ts` |
| Swift app | `app/TmuxIde/` |
| Architecture overview | `ARCHITECTURE.md` |
| Research findings (T050) | `.tmux-ide/library/research-findings.md` |

---

# Appendix B — Glossary

| Term | Meaning |
| --- | --- |
| **Silo** | A self-contained DOM-mounting subtree implemented in a non-React framework (Solid today; Lit/Preact/Vue possible tomorrow). Mounted from React via a *bridge*. |
| **Bridge** | A React component that mounts a silo, owns its host element, and dispatches prop changes to the silo via the silo's `MountHandle` setters. |
| **RSC** | React Server Component. Rendered on the Next.js server; no client-side bundle for this component (only HTML); cannot use `useState` / `useRef` / browser APIs. |
| **Reactor** | A long-lived service that consumes domain events from a queue and applies side effects. Has `start()` (scoped) and `drain` (test affordance). |
| **Projection** | A read model derived from the event log. Owns its own table + cursor in `projection_state`. |
| **Event store** | Append-only durable store of domain events. Single source of truth for replay. |
| **Layer** | Effect-runtime dependency injection unit. Composes services. |
| **Brand** | Nominal type tag attached to a structural type so `ThreadId !== TurnId` at the type level, even though both are strings at runtime. |
| **ManagedRuntime** | Effect's "compose all layers into one runtime, run effects on it" abstraction. |
| **OQ** | Open Question (see §6.2). |

---

# Appendix C — What we are *not* claiming

Lest this roadmap sound like t3-worship:

- **t3 has 28 sqlite migrations** because it grew that schema in
  production. We do *not* need 28 migrations on day 1 of G14-T05;
  start with 4-5 (events, threads, turns, activities, checkpoints).
- **t3 ships Effect everywhere** because they made an early bet. We
  did not. Retroactive adoption is *slow* and partial adoption is the
  pragmatic path.
- **t3's reactor split is not magic** — it's structurally what the
  code becomes once you decouple "I emit an event" from "I do a side
  effect". Our `message-pipe.ts` + `permission-coordinator.ts`
  already moved 60% of the way there during goal 13.
- **t3's per-driver depth is t3's complexity, not virtue** — they
  support Claude + Codex + Cursor + OpenCode (four providers). We
  support Claude Code + Codex (two). The depth-to-benefit ratio is
  thinner for us; if §2.6 lands smaller (one Driver file + one
  Adapter Layer for now), that's fine.

The point of goal 14 is to *acquire the architectural levers t3
already has* — not to mirror their code one-to-one. Where the lever
is smaller for us, the implementation is smaller too.

---

---

# Appendix D — Suggested ADR-0001 skeleton

A reviewable starting point for G14-T01. The roadmap is intentionally
verbose; the ADR should be terse.

```markdown
# ADR-0001 — RSC-shell + Siloed Blocks

## Status
Accepted (2026-05-11). Supersedes nothing.

## Context
The dashboard composed React, Solid (`@tmux-ide/chat-solid`,
`@tmux-ide/v2-solid-widgets`), an Electron host (`app-electron`),
and a native macOS shell (`app/`). Goal-13 integration pain came
from components composed across framework boundaries without a clear
rule. We need one rule that prevents recurrence.

## Decision
- React Server Components render the outer page chrome.
- Interactive React surfaces are React Client components (`"use client"`).
- Non-React UI lives in a *silo* — a workspace package
  (`@tmux-ide/<silo>`) that exposes a single `mount(el, props): handle`
  function.
- React communicates with a silo only via a *bridge* — a React Client
  component that owns one host `<div>`, calls `mount()` once on
  effect, dispatches prop updates via handle setters, and unmounts on
  cleanup.
- Bridges live in `dashboard/**/*SiloBridge.tsx`. Mount calls outside
  bridges are CI-rejected.
- Silos may not import from other silos. Bridges may not import silo
  internals (only the silo's public package entry point).

## Consequences
- One named bridge per silo per page → ~5 bridges at any given
  time. Trivial to audit by `grep '*SiloBridge.tsx'`.
- Adding a new silo (Lit / Preact / Vue) is one new package + one new
  bridge file. No code change in `dashboard/components/`.
- ESLint enforces this automatically; PRs that violate fail CI.

## Alternatives considered
- *Single-framework rewrite (everything React)*. Rejected: the chat
  silo's editor (TipTap-on-Solid) and the cost widget's reactive
  primitives are easier in Solid; rewriting them as React would
  cost weeks for no user-visible gain.
- *Module federation*. Rejected as overkill — federation solves a
  cross-team problem we do not have.
- *iframes per silo*. Rejected — defeats fast prop updates,
  break focus management.

## References
- `docs/goal-14-architecture-parity.md` §1 (this rule's full motivation)
- `dashboard/components/chat/ChatTabPanel.tsx` (canonical bridge)
- `packages/chat-solid/src/index.tsx` (canonical silo mount API)
```

**Next step**: G14-T01 produces this file. Reviewer ensures the
RFC-2119 keywords (MUST, SHOULD, MAY) are present in the Decision
section.

---

# Appendix E — Testing strategy for the migration

Each phase has a distinct test-strategy pattern.

## Phase 1 (codify) — no runtime; lint + grep

Tests are CI assertions on documentation:
- ADR file exists at the canonical path.
- Eslint config contains the boundary rules.
- A negative-fixture file is rejected by `eslint --no-eslintrc`.

No runtime regression possible.

## Phase 2 (persistence) — store-level + integration

The integration suite at
`packages/daemon/src/chat/chat-integration.test.ts` is the gold
master. Pattern:

1. Add a new scenario per Phase-2 invariant (durability through
   restart, replay determinism, gap detection).
2. The scenario uses the harness factory `createHarness()` already in
   place after goal 13.
3. After G14-T06 lands, the harness's `serialize()` /
   `hydrateFrom()` methods are *replaced* with sqlite snapshot dump
   + restore — same shape, different backing.

Specifically, a Phase-2 acceptance test looks like:

```ts
it("restart-rebuild: replaying the event log produces the same projection state", async () => {
  await harness.runScriptedTurn({ threadId, prompt: "..." });
  const beforeSnapshot = harness.serialize();
  harness.dispose();  // simulates daemon shutdown

  const harness2 = await createHarness({ dataDir: harness.dataDir });
  // dataDir is shared so the sqlite file persists across instances
  const afterSnapshot = harness2.serialize();

  expect(afterSnapshot.turns).toEqual(beforeSnapshot.turns);
  expect(afterSnapshot.activities).toEqual(beforeSnapshot.activities);
});
```

## Phase 3 (Effect adoption) — type checks + parity

Effect.gen migrations are tested for *equivalence with the
factory-based implementation*. Concretely:

```ts
// packages/daemon/src/chat/provider-registry.equivalence.test.ts
it("Effect ProviderRegistry.Service matches makeProviderRegistry behaviour", async () => {
  const fixture = providerFixture();
  const factoryImpl = makeProviderRegistry(fixture);
  const effectImpl = ManagedRuntime.make(
    ProviderRegistry.Default.pipe(Layer.provide(testProviderLayer(fixture))),
  );

  // Apply the same operations to both and compare outputs.
  expect(await factoryImpl.list()).toEqual(
    await Effect.runPromise(effectImpl.runtime().pipe(/* … list */)),
  );
});
```

Once both implementations exist with a parity test, we can swap
consumers one at a time without behaviour drift.

## Phase 4 (reactors) — drain-based, no `setTimeout`

The reactor `drain()` semantics let integration tests assert
"everything has settled" without polling:

```ts
it("a turn completion triggers a checkpoint", async () => {
  await harness.runScriptedTurn({ threadId, prompt: "edit a file" });
  await harness.checkpointReactor.drain();  // <— replaces waitFor

  const snapshot = harness.checkpointStore.get(threadId, latestTurnId);
  expect(snapshot?.status).toBe("ready");
});
```

`drain()` is a hard contract: it MUST resolve only when the
reactor's queue is empty *and* the current task (if any) has
completed. Implementations that resolve early are bugs.

## Phase 5 (tasks-on-sqlite) — one-way migration test

The migration script in G14-T15 has the strongest test:

```bash
# scripts/test-migrate-tasks.sh
set -e
ORIG_TASKS=$(mktemp -d)
NEW_DAEMON_DATA=$(mktemp -d)
# Seed with a known-good .tasks/ fixture
cp -R tests/fixtures/tasks-fixture/ "$ORIG_TASKS/.tasks"
TMUX_IDE_PROJECT="$ORIG_TASKS" node scripts/migrate-tasks-to-sqlite.mjs \
  --data-dir "$NEW_DAEMON_DATA"
# Read from sqlite, dump as JSON, compare to original via a deterministic
# canonicalizer (sort keys, normalize timestamps, drop sequence numbers).
node scripts/dump-tasks-from-sqlite.mjs --data-dir "$NEW_DAEMON_DATA" \
  > "$NEW_DAEMON_DATA/dump.json"
diff <(jq -S . "$ORIG_TASKS/.tasks/tasks/*.json" | sort) \
     <(jq -S '.tasks[]' "$NEW_DAEMON_DATA/dump.json" | sort)
```

The diff exits 0 → migration is faithful. Exit 1 → block the merge.

**Next step**: every task PR adds its phase-appropriate tests above
existing coverage. No phase ships without its tests.

---

# Appendix F — Bundle-size measurement procedure

For every PR that adds a dependency to `dashboard/`, measure:

```bash
# Before:
pnpm --filter dashboard build
du -sh dashboard/.next/static/chunks/ > .bundle-before.txt
find dashboard/.next/static/chunks -name "*.js" -exec wc -c {} \; \
  | sort -rn | head -20 >> .bundle-before.txt

# After applying the PR:
pnpm --filter dashboard build
du -sh dashboard/.next/static/chunks/ > .bundle-after.txt
find dashboard/.next/static/chunks -name "*.js" -exec wc -c {} \; \
  | sort -rn | head -20 >> .bundle-after.txt

# Diff:
diff .bundle-before.txt .bundle-after.txt
```

Acceptable delta per PR: ≤ 5 KB gzipped on the main client bundle, ≤
15 KB on dynamic chunks. PRs over that threshold must be approved by
Lead before merge.

Effect-runtime concern: if any PR causes `effect` to appear in
`dashboard/.next/static/chunks/*`, fail the build. The dashboard is
not opted-in to Effect (per OQ-1 weak-form recommendation).

**Next step**: G14-T07 establishes this measurement procedure as a
CI gate.

---

# Appendix G — Where this roadmap could be wrong

Honest list of "if X is true, this roadmap is wrong":

1. **If Effect adoption is mandated everywhere** (strong-form OQ-1),
   the whole "phased weak-form" recommendation collapses. The
   reactor refactor (G14-T10) would land directly in `Effect.gen`
   instead of the queue-based shape sketched above, and the
   dashboard would need a parallel migration.

2. **If sqlite migration on existing installs is unsafe** (R3
   materializes), Phase 2 needs an "opt-in for new installs only"
   variant. Existing users keep JSON for a release.

3. **If the Swift app feature gap is large** (OQ-2 reveals "no
   active sessions yet"), G14-T14 is L→XL and should be split into
   ~3 tasks.

4. **If t3's reactor pattern is misunderstood here** (we read 5
   reactor files; t3 has 9), the refactor in G14-T10 may need
   additional reactors. Verify by re-reading
   `context/t3code/apps/server/src/orchestration/Services/` once
   before starting G14-T10.

5. **If users actually do want worktrees** despite the explicit
   "no", the whole roadmap stays the same but a future G14-T17 adds
   the worktree shape. The audit in §2 doesn't preclude that
   addition.

6. **If `app-electron/` becomes the canonical desktop** (OQ-2/OQ-3
   resolve toward Electron, not Swift), G14-T14 retargets to
   Electron. Tasks remain the same in shape.

**Next step**: revisit this section after Phase 1 lands; some
guesses will be falsified by the codify pass.

---

> **End of roadmap.** Implementation begins after Lead reviews and
> resolves the eight open questions in §6.2. This document is meant
> to be referenced by every goal-14 PR; updates land here as PRs ship
> and learnings emerge.
