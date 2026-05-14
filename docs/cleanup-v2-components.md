# Cleanup audit — `dashboard/src/components/v2/`

ARCHITECTURE.md §7.2 item 6 calls for an audit of the six files under
`dashboard/src/components/v2/`. For each: is it a route-shell that
legitimately lives in `dashboard/`, or does it wrap a
`v2-solid-widgets` widget and belong in the widget package per §3
boundary rules? This document records the recommendation per file.
No moves yet — this is the recommendation pass.

Boundary recap (§3):

- `v2-solid-widgets` depends only on `contracts` + Solid runtime.
- `dashboard` is the only package allowed to import from
  `v2-solid-widgets` and to talk to the daemon over HTTP/WS.
- "Wire-coverage" adapters (T1 pattern) belong on the dashboard side.

## `MissionStatementView.tsx` — **keep in dashboard**

A self-contained Solid view that consumes `createProjectDetail` from
`projectData.ts` and renders the mission/validation/milestones/goals
panels. Mounted directly by the route at
`dashboard/src/routes/v2/project/[name].tsx:240`. Does **not** wrap
any `mount*` factory from `v2-solid-widgets`; it is its own UI
surface. The route owns it and it talks to the dashboard's polled
data layer — moving it would force the widget package to take a
dependency on the dashboard's project-detail fetcher (or duplicate
it), which violates §3. Keep as a route-level view.

## `ProblemsTab.tsx` — **keep in dashboard**

Consumer of `@/lib/lsp/diagnostics-store` (the dashboard's LSP
diagnostics signal) and `@/lib/editorOpen` (dashboard navigation).
Both are dashboard-internal services tied to the Monaco buffer-store
and the dashboard's open-file flow. Moving this into
`v2-solid-widgets` would either drag those services into the widget
package (boundary violation) or require inverting the dependencies
through props — at which point the surface is no longer a tab body
but an abstract diagnostics list, which is not what's needed today.
Keep as a route-level component co-located with its data producers.

## `SymbolPicker.tsx` — **keep in dashboard**

Same shape as `ProblemsTab`: a route-level overlay that imports four
dashboard-internal modules (`@/lib/lsp/api`, `@/lib/editorOpen`,
`@/lib/lsp/session-dir`, `@/lib/lsp/workspace-edit`). It owns the
Cmd+T keybinding for the dashboard route and is mounted once by
`[name].tsx:102`. Moving it into the widget package would require
re-exposing the LSP API surface and the workspace-relative URI helper
through props or a context, which is more API surface than the single
call site warrants. Keep co-located with its data sources.

## `projectData.ts` — **keep in dashboard**

A small polled-fetcher module (`createProjectDetail`,
`createProjectEvents`, `createMetrics`, `fetchSkill`) that hits
`API_BASE` from `@/lib/api`. It is the wire-coverage layer between
the dashboard and the widget mount options — exactly the role §3
assigns to the dashboard. The widgets it feeds are intentionally
prop-driven so they stay portable; the data binding side belongs
here. Keep as the canonical polled adapter for the route's widgets.

## `views.tsx` — **keep in dashboard**

Each exported function in this file (`MissionControlView`,
`KanbanBoardView`, `TasksDashboardView`, `PlansSurfaceView`,
`SkillsSurfaceView`, `CostsView`, `InspectorPaneView`,
`BottomPanelView`) is a wire-coverage adapter: it takes dashboard
data via the polled fetchers and feeds a `mount*` factory from
`@tmux-ide/v2-solid-widgets`. §3 names the dashboard as the only
package allowed to import from `v2-solid-widgets`, so this is exactly
where these adapters belong. Moving any of them into the widget
package would force the package to fetch from `API_BASE` itself,
collapsing the prop-driven contract that keeps the widgets reusable.
Keep as the dashboard's binding layer.

## `widgetHost.tsx` — **move to `packages/v2-solid-widgets`**

The only file in this directory that is a candidate to move. It is a
49-line generic Solid component that takes any `mount(container,
opts) → { unmount, setOptions }` handle and reactively forwards
option updates plus tears down on cleanup. It depends only on
`solid-js` — no dashboard modules, no API surface, no LSP store.
Every widget in `@tmux-ide/v2-solid-widgets` exposes the
`mount(...) → handle` shape this host expects, so it is effectively
the canonical Solid host for the package. Promoting it to
`packages/v2-solid-widgets/src/lib/WidgetHost.tsx` and re-exporting
from the package's barrel would let any future Solid consumer (native
app webview, second dashboard, tests, embedded surfaces) host the
widgets without having to reinvent the wrapper. The `dashboard/`
import in `views.tsx` and `MissionStatementView.tsx` would change
from `./widgetHost` to `@tmux-ide/v2-solid-widgets`. Low risk: pure
Solid, single small file, no behavioural change. Defer the actual
move to a follow-up commit per §6's "no surprise refactors" rule.
