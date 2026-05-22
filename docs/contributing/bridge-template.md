# Bridge component template — React → Solid mount pattern

If you are wrapping a non-React UI (a Solid silo today, a Lit / Preact /
Vue silo tomorrow) for the Next.js dashboard, **copy this file**.
Adapt the prop names; do not change the five-part shape.

The rule this template enforces is ADR-0001 (`docs/adr/0001-rsc-shell-and-siloed-blocks.md`).
The five rules to follow:

1. **Mount once** on `hostRef` availability with `[]` deps — never
   re-mount on prop change.
2. **Dispatch prop updates** via handle setter methods — one
   `useEffect` per setter.
3. **Host element only** — no children, no className the silo might
   fight with.
4. **Dynamic import** the silo so it stays out of the initial RSC
   bundle.
5. **Cleanup with `handleRef.current?.unmount()`** in the effect's
   teardown.

## Copy-pasteable template

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

  // (1) Mount once.
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

  // (2) Dispatch prop updates — one useEffect per setter.
  useEffect(() => {
    handleRef.current?.setThreadId(props.threadId);
  }, [props.threadId]);

  useEffect(() => {
    handleRef.current?.setSessionName(props.sessionName);
  }, [props.sessionName]);

  // (3) Host element only — no children, no className.
  return <div ref={hostRef} style={{ height: "100%", width: "100%" }} />;
}
```

## Mount-handle contract (every silo implements)

```ts
// packages/<silo>/src/index.ts
export interface SiloMountHandle {
  unmount(): void;
  // setX(value: T): void;  // one typed, idempotent setter per prop the bridge updates
}

export function mount(el: HTMLElement, initial: InitialProps): SiloMountHandle;
```

The setter convention (`setThreadId`, `setSessionName`, …) is part of
the _silo public API_. Adding a new prop is a visible API change in
the silo package — that is the entire point of the boundary.

## Why the dependency array is `[]`, not `[props.threadId]`

A naïve developer reads "the host needs to switch to a new thread" and
makes the mount effect depend on `threadId`. That causes a full
unmount → re-mount on every thread switch, which:

- Destroys the silo's internal state (composer draft, scroll position,
  focus).
- Recreates DOM nodes — a perceptible flash.
- Sometimes leaks event listeners if the silo's `unmount()` is
  imperfect.

Driving prop changes through _handle setters_ keeps the silo alive
across prop changes. The silo decides what to do with the new value
(e.g. re-fetch the thread, swap content) without re-running its
bootstrap.

## Common mistakes (do not do)

- ❌ `useEffect(..., [props.threadId])` for the mount effect — re-mounts
  on every prop change.
- ❌ Returning children inside the host `<div>` — the silo controls its
  subtree; siblings confuse it.
- ❌ Calling `mount()` from outside a `*Bridge.tsx` / `*Island.tsx` file
  — blocked by the CI grep under G14-T03 once it lands.
- ❌ Reading silo-internal state from React via a global / observable —
  cross the boundary via setters on the handle, not by reaching in.
- ❌ Importing `@tmux-ide/<silo>/src/...` — silos publish a single
  entry point; deep imports break the boundary.

## Reference implementation

`dashboard/components/chat/ChatTabPanel.tsx` is the canonical bridge.
When in doubt, diff against it.
