# ADR-0001 — RSC shell + siloed blocks

- **Status**: Accepted
- **Date**: 2026-05-12
- **Decision drivers**: cross-framework correctness, state preservation
  across thread switches, no DOM thrash on prop change, single source of
  truth for the dashboard ↔ silo boundary.
- **Supersedes**: none
- **Superseded by**: none
- **References**: `docs/goal-14-architecture-parity.md` §1.1–§1.5,
  `dashboard/components/chat/ChatTabPanel.tsx` (canonical bridge),
  `packages/chat-solid/` and `packages/v2-solid-widgets/` (canonical
  silos).

## Context

The dashboard renders UI in three different frameworks today:

- Next.js / React (RSC + client) — the shell, navigation, forms, dialogs.
- Solid — the chat surface (`@tmux-ide/chat-solid`) and the v2 widget
  panels (`@tmux-ide/v2-solid-widgets`).
- xterm.js — terminal mirrors driven by raw ANSI bytes from the daemon.

Without a written rule, every new surface gets a fresh debate: do we
write this in React or Solid? Do we mount it inline or behind a
component? How do we pass props into the Solid tree? The result has
historically been re-mounting Solid roots on every React state change,
which destroys composer drafts, scroll position, focus, and (when the
silo's `unmount()` is imperfect) leaks listeners.

We want one rule that ends the debate and one template that ends the
re-mount class of bugs.

## Decision

**The Next.js dashboard is rendered as React Server Components by
default. Interactive surfaces drop to React client components only
where state, refs, or browser APIs demand it. UI built in a foreign
framework (Solid, Lit, Preact, …) lives in a named _silo_ package
(`@tmux-ide/<silo-name>`) and is mounted from React through a single
_bridge component_ per silo. Bridge components are the only place in
the codebase that knows how to translate between React's component
model and a non-React DOM-mounting API. The data contract between a
silo and its bridge is a single `mount(el, props)` call that returns a
handle exposing `unmount()` plus typed prop-update methods — props
never flow as live React state, only as imperative calls on the
handle.**

### Decision matrix

| Surface                                                                                                   | Choose                                 | Reason                                                                                                  | Examples (current code)                                                                                          |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Static page chrome, project/thread index lists, anything that fetches once and renders                    | **RSC**                                | No interactive state; render-on-server is cheaper and avoids a hydration round-trip.                    | `app/(shell)/*` _should be_ RSC (today most are `"use client"`; tracked in goal-14 §5).                          |
| Form widgets, sortable tables, inline editing, command palette, anything driven by zustand or React state | **React Client** (`"use client"`)      | Needs `useState` / `useEffect` / refs / browser APIs.                                                   | `dashboard/components/projects/AddProjectDialog.tsx`, `KeybindRoot.tsx`, `CommandPalette.tsx`.                   |
| Anything that runs in a non-React framework — Solid DOM islands today, Lit / Preact / Vue tomorrow        | **Silo package** mounted via bridge    | Foreign framework owns its DOM subtree; React must not reach inside.                                    | `@tmux-ide/chat-solid` mounted via `ChatTabPanel.tsx`; `@tmux-ide/v2-solid-widgets` mounted via `V2*Island.tsx`. |
| Long-lived browser process attached to a backend stream (PTY, ANSI mirror)                                | **React Client + silo-shaped wrapper** | Treat the stream owner as a silo even though it's still React, so the rendering subtree is replaceable. | `Terminal*` xterm wrappers under `dashboard/components/terminals/`.                                              |
| Sub-window with its own runtime (Electron BrowserWindow, native Swift view via `app/`)                    | **Out-of-tree silo**                   | Different process entirely. Bridge is the IPC layer, not a React component.                             | `app/TmuxIde/` (Swift) and `app-electron/` (Electron).                                                           |

### Tie-breakers for borderline cases

- If you can answer the question _"does this component own a `useRef`
  to a DOM node?"_ with **yes**, it is a Client component or a silo,
  not RSC.
- If you can answer _"does this component need to pass live React
  state to a non-React UI?"_ with **yes**, it is a silo with a bridge
  — never inline `dangerouslySetInnerHTML` or `useEffect`-glue inside
  an otherwise RSC tree.

### Bridge component template (canonical)

Every silo bridge has the same five-part shape. Copy this template
verbatim when adding a new silo:

```tsx
// dashboard/components/<silo>/<Silo>BridgePanel.tsx
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

  // (1) Mount once on hostRef availability. NEVER include props.threadId
  //     (or any other prop) in this dependency array — that would force
  //     a re-mount on every prop change and lose the silo's internal
  //     state. Prop changes are dispatched via setter methods below.
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

  // (3) Host element only. No children, no className the silo might
  //     fight with. The silo controls its DOM subtree.
  return <div ref={hostRef} style={{ height: "100%", width: "100%" }} />;
}
```

The five rules a bridge must honour:

1. **Mount once on `hostRef` availability with `[]` deps** — never
   re-mount on prop change.
2. **Dispatch prop updates via handle setter methods** — one
   `useEffect` per setter so unrelated prop changes do not refire.
3. **Host element only** — no children, no className the silo might
   fight with.
4. **Dynamic import the silo** (`await import("@tmux-ide/<silo>")`) so
   it stays out of the initial RSC bundle and only loads when the
   bridge actually mounts.
5. **Cleanup with `handleRef.current?.unmount()`** in the effect's
   teardown so the silo releases every DOM / event / network resource
   it owns.

### Why the dependency array is `[]`, not `[props.threadId]`

A naïve developer reads "the host needs to switch to a new thread" and
makes the mount effect depend on `threadId`. That causes a full
unmount → re-mount on every thread switch, which:

- Destroys the silo's internal state (composer draft, scroll
  position, focus).
- Recreates DOM nodes — a perceptible flash.
- Sometimes leaks event listeners if the silo's `unmount()` is
  imperfect.

Driving prop changes through _handle setters_ keeps the silo alive
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
the _silo public API_, not a free-form prop. Adding a new prop is a
visible API change in the silo package — that is the entire point of
the boundary.

## Consequences

### Positive

- PR descriptions cite ADR-0001 instead of restating the rule.
- Bridge bugs reduce to template deviations the reviewer can flag by
  citing rule number 1–5 above.
- State preservation across thread switches becomes a property of the
  pattern, not a bug-fix-per-component.
- Silo packages become independently versionable: dashboard depends on
  the silo's public surface (`mount` + `MountHandle`), not its
  internals.

### Negative

- Cross-framework debug sessions are slightly harder — a stack trace
  that crosses the bridge points at the silo's mount fn, not the React
  component that requested the mount. Tooling can help (a `data-silo`
  attribute on the host `<div>` is a cheap improvement).
- Adding a new prop to a silo costs a bump in the silo's public API
  (new `setX` on the handle). That cost is intentional — it forces a
  conversation about whether the prop belongs in the silo or above it.

### Enforcement (planned)

Five lint / CI hooks land under goal-14 G14-T03, all keyed off this
ADR:

1. **No deep imports across silo boundaries** — dashboard may only
   import `@tmux-ide/<silo>`, never `@tmux-ide/<silo>/src/...`
   (`eslint-plugin-boundaries`).
2. **RSC files do not import React client utilities** —
   `useState`/`useEffect`/`useRef`/zustand/jotai only inside files with
   the `"use client"` directive.
3. **Silo bridges may not import from other silos** — cross-silo
   coordination happens at the React layer above the bridges.
4. **No raw `mount()` calls outside `*Bridge.tsx` / `*Island.tsx`** —
   CI grep + `pre-commit` hook.
5. **Server actions and route handlers may not import silo packages**
   — silos are browser-only; importing them server-side either crashes
   (no `window`) or bundles a foreign framework runtime into Node
   (`no-restricted-imports`).

A combined ESLint sketch lives in
`docs/goal-14-architecture-parity.md` §1.4; the production wiring
lands under G14-T03 once the patterns are validated against the actual
workspace layout.

## Related

- `docs/goal-14-architecture-parity.md` §1.1–§1.5 — long-form rationale,
  audit table, enforcement sketch.
- `docs/contributing/bridge-template.md` — the copy-pasteable template
  plus the _why `[]`-deps_ explainer, for engineers writing a new silo.
- `ARCHITECTURE.md` — root architecture doc; the "Dashboard
  architecture" stub points here.
- `dashboard/components/chat/ChatTabPanel.tsx` — canonical
  implementation; reference when in doubt.
