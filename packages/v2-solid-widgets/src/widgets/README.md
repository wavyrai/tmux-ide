# Solid DOM widgets

Reusable Solid dashboard widgets. Each `<Name>.tsx` here exports `mount(node, opts) → handle` per the convention in [ARCHITECTURE.md §6 — Solid widgets (DOM)](../../../../ARCHITECTURE.md#§6--conventions), and is wired into the dashboard via a thin `*-bridge.tsx` under `dashboard/src/components/`.

Boundary rules (from [ARCHITECTURE.md §3](../../../../ARCHITECTURE.md#§3--package-map)):

- Depends only on `@tmux-ide/contracts` + the Solid runtime.
- Never imports from `dashboard/` or `packages/daemon/`.
- Browser talks to the daemon via `/api/v2/action/:name` (HTTP) and `/ws/events` (WS); these widgets never speak to the daemon directly — the bridge passes data in.

For the full inventory + status per widget see the [Solid DOM widgets table in docs/widget-index.md](../../../../docs/widget-index.md#solid-dom-widgets-14). For the daemon-side TUI widget counterparts (distinct runtime, **not duplicates**), see the [Daemon TUI widgets section](../../../../docs/widget-index.md#daemon-tui-widgets-8).
