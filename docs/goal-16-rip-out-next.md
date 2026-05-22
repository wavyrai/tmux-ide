# Goal-16 — Rip out Next, ship Solid-only dashboard

**Date**: 2026-05-13
**Author**: Pty Agent (pane 1)
**Status**: ✅ COMPLETE — G16-P0 (audit), P1 (dashboard-solid scaffold + `/v2/widgets`), P2 (IDE shell + view dispatch), P3 (`/v2/setup` + `/v2/settings` + `/v2/terminal/[id]` + `/v2/widget/[name]`), and P4 (cutover) all landed. The React tree is gone; `dashboard/` is now the Solid SPA.
**Decision context**: see `feedback_architecture_solid_first.md` (Lever B).

## Headline

We strip Next.js, React, ReactDOM, the entire bridge layer, and the
dual-build chain. We replace them with a single Vite + `@solidjs/router`
app under `dashboard-solid/`, running Effect throughout. The recommended
stack is **Vite + `@solidjs/router`** (not Solid Start) because we do
not need SSR — the daemon already serves the dashboard as a static
bundle from `dashboard/out/` — and Solid Start's server primitives
would re-introduce the SSR/hydration class of bugs we are explicitly
trying to delete.

Survival path is parallel: stand up `dashboard-solid/` next to
`dashboard/`, port one route at a time, cut over when the new app has
parity. The cutover renames `dashboard-solid → dashboard`, updates the
daemon's `serveDashboard()` resolver, retargets `pnpm build`, and
deletes the React tree in one commit.

| Bucket                          |   Count |
| ------------------------------- | ------: |
| Next route segments             |  **11** |
| `app/` `.tsx` + `.ts` files     |  **20** |
| `components/` `.tsx` files      |  **46** |
| `lib/` `.ts` files              |  **32** |
| `"use client"` directives       |  **74** |
| React → Solid bridges           |  **13** |
| Next dependencies               |   **3** |
| React-only dependencies         |   **9** |
| Vitest specs in `dashboard/`    |  **48** |
| Top-level `useEffect` callsites | **144** |

The bridge tax: 13 wrapper files, each 50–150 lines of "mount Solid into
a `div`, forward props with `setOptions`, fan callbacks back across the
boundary." Bridges are pure structural overhead — they exist because
the framework boundary exists. Goal-16 deletes the boundary.

---

## 1. Next-specific surface in use

| Next feature                | Callsites                     | Solid replacement                                |
| --------------------------- | ----------------------------- | ------------------------------------------------ |
| App Router (`app/**`)       | 11 segments                   | File-based routes via `@solidjs/router`          |
| `next/dynamic({ssr:false})` | 2 (V2ChatView, V2ActivityBar) | Solid `lazy()` + `clientOnly()` wrapper          |
| `next/link`                 | ~30 callsites                 | `<A>` from `@solidjs/router`                     |
| `next/navigation:useRouter` | 8 callsites                   | `useNavigate()` from `@solidjs/router`           |
| `useSearchParams`           | 7 callsites                   | `useSearchParams()` (same name, Solid signature) |
| `useParams`                 | 6 callsites                   | `useParams()` (same name, Solid signature)       |
| `usePathname`               | 2 callsites                   | `useLocation().pathname`                         |
| `redirect()` (RSC)          | 4 callsites                   | `Navigate` component / `navigate()` imperative   |
| `"use client"`              | 74 files                      | Removed. Single client-side runtime.             |
| Server Components (RSC)     | 6 files (mostly shells)       | Plain components. No server/client split.        |
| `generateStaticParams`      | 0                             | N/A                                              |
| `next/image`, `next/font`   | 0                             | N/A                                              |
| Turbopack                   | dev only                      | Vite dev server.                                 |

### What we don't use (and won't miss)

- No `getServerSideProps`, `loaders`, or async server-only components
- No `next/headers`, `next/cookies`, edge runtime
- No middleware, route handlers, API routes (the daemon owns those)
- No ISR / streaming SSR (we ship a static bundle)

### What "Server Components" are doing in `app/`

Six files lack `"use client"`: `app/layout.tsx`, `app/page.tsx`,
`app/v2/layout.tsx`, `app/terminal/[id]/page.tsx`,
`app/v2/terminal/[id]/page.tsx`, `app/v2/project/[name]/page.tsx`.
They are all shells that delegate immediately to a `"use client"` child
(`ProjectV2Page`, `<TerminalPage>`, etc). None hits a database, file
system, or env-private API. They exist solely because Next defaulted
to RSC. They map 1:1 to a thin Solid route file.

---

## 2. React component inventory (46 in `components/` + 20 in `app/`)

### 2.1 By directory

| Path                     | Files | Disposition                                   |
| ------------------------ | ----: | --------------------------------------------- |
| `components/` (root)     |    27 | 11 PORT, 13 DELETE, 3 PORT-trivial            |
| `components/ui/`         |    13 | PORT — wrap Solid headless primitives (corvu) |
| `components/chat-v2/`    |     5 | DELETE — chat-solid takes over directly       |
| `components/kanban/`     |     1 | PORT — CreateTaskDialog → corvu Dialog        |
| `components/plans/`      |     1 | PORT — CodeMirror MarkdownEditor              |
| `components/validation/` |     1 | PORT                                          |
| `app/`                   |    20 | PORT — route shells + page bodies             |

### 2.2 Bridge files (DELETE on cutover)

All bridges exist to mount a Solid widget into a React tree. None
survive the rip-out.

```
components/command-palette-bridge.tsx
components/costs-dashboard-bridge.tsx
components/diffs-viewer-bridge.tsx
components/explorer-bridge.tsx
components/inspector-bridge.tsx
components/kanban-board-bridge.tsx
components/mission-control-dashboard-bridge.tsx
components/plans-panel-bridge.tsx
components/skills-view-bridge.tsx
components/tasks-view-bridge.tsx
components/chat-v2/chat-solid-bridge.tsx
app/v2/_lib/V2ChangesIsland.tsx
app/v2/_lib/V2ExplorerIsland.tsx
```

13 files, ~1,200 lines of glue. Replaced by `import { CostsDashboardView }
from '@tmux-ide/v2-solid-widgets'` and direct use as a Solid component.

### 2.3 PORT — components/ root

| File                       | Notes                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `AuthorshipBar.tsx`        | Stateless. Port direct.                                                                |
| `BottomPanel.tsx`          | xterm-host + tabs + SSE log streams. Medium effort.                                    |
| `CommandPalette.tsx`       | React wrapper over the Solid palette. Mostly DELETE — keep its slash-command keybinds. |
| `FileList.tsx`             | Stateless list. Port direct.                                                           |
| `KeybindRoot.tsx`          | Global keybind handler. Port — Solid effect equivalent.                                |
| `MainTabItem.tsx`          | dnd-kit sortable item. Needs `@thisbeyond/solid-dnd`.                                  |
| `MainTabsBar.tsx`          | dnd-kit sortable list. Same.                                                           |
| `MarkdownEditor.tsx`       | Stateless wrapper. Port.                                                               |
| `ProjectSwitcher.tsx`      | Dialog + dropdown. Port to corvu.                                                      |
| `Providers.tsx`            | Theme provider. Replace with Solid context.                                            |
| `ShellSidebarProvider.tsx` | Sidebar context. Solid context.                                                        |
| `StatusBar.tsx`            | Stateless. Port direct.                                                                |
| `Terminal.tsx`             | xterm wrapper — see §5.3.                                                              |
| `ThemeToggle.tsx`          | Replace `next-themes` with a Solid theme signal.                                       |
| `ToastStack.tsx`           | Animated stack. Port.                                                                  |
| `TopBar.tsx`               | Layout shell. Port.                                                                    |
| `v2-primitives.tsx`        | Local UI primitives. Port.                                                             |

### 2.4 REUSE — Solid silos consumed as-is

After cutover these become plain Solid imports, no bridge:

- `@tmux-ide/v2-solid-widgets` (Activity, CommandPalette, Costs*,
  Diffs*, Explorer*, Inspector, KanbanBoard, MissionControl*,
  PlansPanel, PlansRail, SkillsView, TasksView)
- `@tmux-ide/chat-solid` (transcript, composer, header, banners)

### 2.5 DELETE — chat-v2 React shell

The chat-v2 React surface is a thin shell around `@tmux-ide/chat-solid`.
After Goal-16 the route renders `<ChatRoot />` from `chat-solid`
directly:

```
components/chat-v2/ChatV2Root.tsx           — replaced by chat-solid route shell
components/chat-v2/ThreadListRail.tsx       — port to Solid (small, ~120 lines)
components/chat-v2/chat-solid-bridge.tsx    — DELETE
components/chat-v2/useChatStore.ts          — DELETE (chat-solid owns its store)
components/chat-v2/useWsBridge.ts           — fold into chat-solid's bus client
components/chat-v2/threadStateToActivities.ts — DELETE (dead after WN7)
components/chat-v2/turnGrouping.ts          — DELETE (dead after WN7)
```

---

## 3. Stack pick — Vite + @solidjs/router (over Solid Start)

**Recommendation: Vite + `@solidjs/router`.**

### Why not Solid Start

Solid Start is Solid's answer to Next: full-stack framework, server
functions, SSR by default, file-system routing, build adapters. It is
useful when you need:

1. SSR (search-engine indexable HTML)
2. Server actions (form posts with no API layer)
3. Edge deployments (Vercel / Cloudflare)
4. Built-in data loaders running server-side

We need **none** of those. The dashboard is:

- A local single-page app served by the daemon's Hono middleware
- Talks to one backend (the daemon, on `127.0.0.1:6060`) via REST + WS
- Already shipped as a static export (`dashboard/out/`)
- Bundled inside the Electron/Tauri shell (`app-electron/`)

Solid Start adds:

- A second runtime context (SSR + client) → re-introduces hydration
  edge cases we are explicitly deleting
- A new mental model (`createAsync`, server functions) we don't need
- An adapter abstraction (`solid-start-static`, `solid-start-node`)
  that has to be configured for our daemon-served deployment shape
- More frequent churn — Start is younger than the underlying router

### Why Vite + Router

- Mature: Vite is the standard Solid bundler, `@solidjs/router` is the
  reference router for Solid.
- One runtime: every component runs client-side. No SSR. No "use
  client" tax.
- Same `vite.config.ts` Solid silos already use → consistent tooling.
- Static `npm run build` outputs an SPA bundle the daemon can serve
  with the existing `serveDashboard()` walker (point it at
  `dashboard/dist/` instead of `dashboard/out/`).
- Effect-friendly: Effect's client runtime composes cleanly with Solid
  signals (we use the same pattern in v2-solid-widgets already).

### What we lose

- No SSR-rendered HTML. The first paint shows a Solid app shell, then
  hydrates from the bundle. Same effective UX as today (Next renders
  the same "loading…" shells on first paint anyway, since most pages
  are `"use client"`).
- No file-system server routes. We never had any — all data goes
  through the daemon's REST API. Out of scope is in scope.

---

## 4. Proposed `dashboard-solid/` shape

```
dashboard-solid/
├── package.json              # @tmux-ide/dashboard-solid (workspace pkg)
├── vite.config.ts            # vite-plugin-solid + path alias
├── tsconfig.json             # solid jsxImportSource
├── index.html                # Single SPA shell
├── src/
│   ├── entry.tsx             # render(() => <App />, root)
│   ├── App.tsx               # <Router>; theme + global error boundary
│   ├── routes/               # File-based routes via @solidjs/router
│   │   ├── index.tsx                          # / → redirect to /v2
│   │   ├── v2/index.tsx                       # /v2 (overview)
│   │   ├── v2/widgets.tsx                     # /v2/widgets
│   │   ├── v2/setup.tsx                       # /v2/setup
│   │   ├── v2/settings.tsx                    # /v2/settings
│   │   ├── v2/project/[name].tsx              # /v2/project/:name
│   │   ├── v2/terminal/[id].tsx               # /v2/terminal/:id
│   │   └── v2/widget/[name].tsx               # /v2/widget/:name
│   ├── components/           # Solid components — direct, no bridge
│   │   ├── ActivityBar.tsx
│   │   ├── BottomPanel.tsx
│   │   ├── MainTabsBar.tsx
│   │   ├── StatusBar.tsx
│   │   ├── Terminal.tsx
│   │   ├── ProjectSwitcher.tsx
│   │   ├── TopBar.tsx
│   │   ├── ThemeToggle.tsx
│   │   ├── ToastStack.tsx
│   │   └── ui/               # corvu-based Button, Dialog, Tooltip, …
│   ├── lib/
│   │   ├── runtime/          # Effect Layers (ApiClient, WsBus, …)
│   │   ├── routes.ts         # central ViewId registry (WN11)
│   │   ├── api.ts            # REST client; Effect-wrapped
│   │   ├── wsBus.ts          # Single WS multiplexer
│   │   ├── useSessionStream.ts
│   │   ├── stores/           # createStore / createSignal modules
│   │   │   ├── settings.ts
│   │   │   ├── chrome.ts     # left/right/bottom panel toggles
│   │   │   ├── projects.ts
│   │   │   ├── notifications.ts
│   │   │   └── toasts.ts
│   │   ├── actions.ts        # actionClient → Solid signal wiring
│   │   ├── keybinds.ts
│   │   └── theme.ts
│   └── styles/
│       └── globals.css
└── __tests__/                # vitest + @solidjs/testing-library
```

The structure mirrors `dashboard/` segment-for-segment so the migration
PRs are local in scope. One route at a time, no big-bang.

---

## 5. Five hardest things to port

Ranked by structural risk × migration cost.

### 5.1 `react-resizable-panels` — the 3-region IDE shell

**Where**: `app/v2/project/[name]/ProjectV2Page.tsx` (the VSCode-style
shell: ActivityBar | LeftSidebar | Editor | RightInspector + BottomPanel)
and `app/v2/page.tsx`, `app/v2/_lib/V2ChatView.tsx`. 9 distinct callsites
across the dashboard. Uses `Panel`, `Group`, `Separator`, `Layout`, and
`PanelImperativeHandle` for collapse/expand from the Cmd+B shortcut.

**The hard part**: the imperative collapse API + persisted layout per
key (`useStoredLayout`) + collapsedSize-driven onResize callbacks +
nested Groups. We rely on this for the entire app frame.

**Solid candidates**:

1. **corvu** (`@corvu/resizable`) — Solid-native, Base-UI-style headless.
   Closest API match. Supports controlled state and collapse.
2. **solid-resizable-panels** — Community port of the React lib. API
   compatibility but smaller user base.
3. **Hand-roll** — ~150 lines of Pointer-event resize math + ARIA
   semantics. Buys us perfect control over imperative collapse.

**Mitigation**: P1 prototype with corvu against a single nested layout
(`/v2/widgets` doesn't need it; `/v2/project/[name]` does). Cut to
hand-rolled if corvu's collapse API doesn't fit. Persistence stays
identical (`localStorage` keys preserved across runtime swap).

### 5.2 `@base-ui/react` primitives → Solid headless lib

**Where**: `components/ui/{button,dialog,popover,separator,tooltip}.tsx`
and a handful of direct consumers (ThemeToggle's TooltipProvider,
ProjectSwitcher's Dialog). 5 distinct primitives, ~20 callsites.

**The hard part**: corvu (`@corvu/dialog`, `@corvu/popover`,
`@corvu/tooltip`) covers most surface, but the API shape is different
enough that the wrapper components need a rewrite, not a port. Base UI
exposes `Render`, `RootProps`, `useRender` slot patterns that don't
translate 1:1.

**Mitigation**: re-implement `components/ui/*` against corvu — same
prop names where reasonable, but accept that the internal composition
changes. Audit the 20 callsites for prop-name drift before the rewrite.
Kobalte is the fallback for `Dialog` (more battle-tested than corvu's).

### 5.3 `Terminal.tsx` — xterm-WebGL host with shared lifecycle

**Where**: `components/Terminal.tsx`, mounted by `/v2/terminal/[id]`,
`/v2/project/[name]` (Terminal tab), `BottomPanel` (always-mounted),
`/v2/widget/[name]` (PTY mirror). One file, four mount points.

**The hard part**: xterm itself is framework-agnostic, but the host
component carries non-trivial lifecycle:

- One xterm instance per `id`, reused across remounts (always-mounted
  host pattern)
- `FitAddon` + `WebglAddon` lifecycle (web-gl context loss handling)
- WebSocket attach/detach with reconnect
- IME composition support
- Theme variable observation (`MutationObserver` on `<html>`)

**Mitigation**: port verbatim. Solid's `onMount` / `onCleanup` map
cleanly to React's `useEffect` cleanup. Keep the always-mounted host
pattern (Solid's `Show` keeps DOM stable when `keep="dom"`-ish — use a
visibility class swap instead). Run the existing xterm e2e suite
against the Solid version before cutover.

### 5.4 Zustand stores → Solid stores

**Where**: `lib/projectStore.ts`, `lib/useSettings.ts`,
`lib/threadPrefetch.ts`, `lib/addProjectDialogStore.ts`. Plus the
chat-v2 store (dies anyway). 31 `useSettings(...)` callsites and 9
`projectStore` callsites — both very wide.

**The hard part**: Zustand's selector-based reactivity collapses to
"compute selector, shallow-compare result." Solid's reactivity is
fine-grained at the signal level. Naive ports replace `useSettings((s)
=> s.theme)` with `settings.theme` (a getter on a `createStore`
proxy) — semantically equivalent, but every callsite needs to be
audited because the diff is shaped like a React → Solid migration
rather than a refactor (no compile error if you forget to make
something reactive).

**Mitigation**: keep the same exported names (`useSettings`,
`projectStore`) but rewrite the implementation. Add a vitest suite per
store that locks in the public surface — port runs green if every
selector returns the same value before and after the swap.

### 5.5 `lib/wsBus.ts` + `useSessionStream.ts` — shared WS multiplexer

**Where**: every live view in the app. The bus owns one WebSocket per
origin, with refcounted per-session subscriptions, idle-close timers,
exponential reconnect, and dedup. `useSessionStream` is the React-flavored
consumer; ~25 callsites.

**The hard part**: the bus is framework-agnostic (pure TS) — that part
ports verbatim. The hook layer needs a Solid rewrite. The trick is
making sure the shared-channel ref-counting still works when the
consumer is a `createResource` or a long-lived `createSignal` instead
of a React hook with mount/unmount.

**Mitigation**: keep `lib/wsBus.ts` byte-identical (or move into a
shared workspace package). Rewrite `useSessionStream` as
`createSessionStream` returning an accessor + reconnect signal.
Existing wsBus unit tests cover the wire protocol; new Solid tests
cover the consumer hook.

### Bonus risks (not top-5 but worth flagging)

- **`next/dynamic({ssr:false})`** → Solid `clientOnly()` wrapper. Used
  for chat (Solid's `delegateEvents` global) and ActivityBar (Base UI
  tooltip ID drift). Both go away naturally — chat-solid is the only
  Solid runtime, so there's nothing to dynamically load to avoid.
- **`next-themes`** → small custom theme signal + CSS class on `<html>`.
- **`react-markdown`** (1 callsite) → `solid-markdown` or marked +
  manual sanitization. Marked is already in the lockfile via
  `@tmux-ide/v2-solid-widgets`.
- **`@dnd-kit/sortable`** (MainTabsBar) → `@thisbeyond/solid-dnd`.
  Smaller community; the tabs surface is small enough to hand-roll if
  needed.
- **`@codemirror/*`** (plans MarkdownEditor) — framework-agnostic;
  port the React wrapper, not the editor.

---

## 6. Migration phases

Each phase is independently shippable. The live app keeps running on
React until G16-P4.

### G16-P1 — Stand up `dashboard-solid/`, port `/v2/widgets`

**Goal**: Prove the toolchain end-to-end against the smallest route.

**Files in scope**:

- New: `dashboard-solid/{package.json, vite.config.ts, tsconfig.json, index.html}`
- New: `dashboard-solid/src/{entry.tsx, App.tsx}`
- New: `dashboard-solid/src/routes/v2/widgets.tsx`
- New: `dashboard-solid/src/lib/api.ts` (the slice needed for widgets:
  `fetchWidgetCatalog`)
- New: `dashboard-solid/src/components/ui/` (minimal — what
  `/v2/widgets` actually renders)
- Workspace: `pnpm-workspace.yaml` already covers `dashboard-solid/`
  via the `packages/*` glob — verify; otherwise add an explicit entry.
- Daemon: add `serveDashboardSolid()` middleware variant (or extend
  the resolver) under a feature-flag env var. Don't replace the
  existing `serveDashboard()` yet.

**Deps added**: `solid-js`, `@solidjs/router`, `vite`,
`vite-plugin-solid`, `@solidjs/testing-library`, `corvu`, `vitest`.

**Test gate**:

- `pnpm --filter @tmux-ide/dashboard-solid build` succeeds
- `pnpm --filter @tmux-ide/dashboard-solid test` runs (≥1 spec)
- Manual: visit `/v2/widgets` against the Solid build, parity with
  React widgets gallery

**Risks**:

- Vite + workspace path resolution for `@tmux-ide/v2-solid-widgets`
  may need explicit dedupe (single `solid-js` instance).
- corvu's API may not cover the gallery's tooltip primitives — fall
  back to hand-rolled tooltips for P1.

### G16-P2 — Port `/v2/project/[name]` (the big one)

**Goal**: The IDE shell, which is 70% of the surface area.

**Files in scope**:

- Port `ProjectV2Page.tsx` → `dashboard-solid/src/routes/v2/project/[name].tsx`
  - supporting components in `dashboard-solid/src/components/`
- Port the 3-region resizable layout (§5.1)
- Port `BottomPanel`, `StatusBar`, `MainTabsBar`, `ActivityBar`,
  `InspectorBridge` → direct Inspector mount, `KanbanBoardBridge`
  → direct KanbanBoard mount, etc. (all bridges go away)
- Port `useChromeLayout`, `useChromeShortcuts`, `useStoredLayout`,
  `useViewParam` to Solid signals
- Port `Terminal.tsx` (§5.3)
- Port the chat-v2 surface: replace `ChatV2Root` + bridge with
  `chat-solid`'s exported `ChatRoot` component directly

**Deps added**: `xterm` (already in lockfile), `@thisbeyond/solid-dnd`
(tabs sort), `solid-markdown` (or migrate the one callsite to marked).

**Test gate**:

- Smoke spec from T3 (`e2e/smoke.spec.ts`) passes against `dashboard-solid`
- Manual: open `/v2/project/<name>`, exercise every `?view=...`
  variant (kanban / tasks / plans / chat / files / diffs / metrics /
  costs / mission / mission-control / terminal / changes), every
  Cmd+B / Cmd+J keybind, theme toggle
- xterm reconnect survives a daemon restart

**Risks**:

- Resizable panels collapse API — see §5.1
- xterm always-mounted host pattern in Solid — see §5.3
- Cross-cutting hooks (`useChromeLayout` reaches 14 callsites) — see
  §5.4

### G16-P3 — Port remaining routes

**Goal**: Reach surface parity.

**Files in scope**:

- `/v2` overview (`app/v2/page.tsx`)
- `/v2/setup` (`app/v2/setup/page.tsx`)
- `/v2/settings` (`app/v2/settings/page.tsx`)
- `/v2/terminal/[id]`, `/v2/widget/[name]`, `/` (redirect),
  `/terminal/[id]`
- All remaining `components/` files (ProjectSwitcher, command palette,
  command-line action client wiring, notifications)
- `lib/actions.ts` + `lib/actionClient.ts` ported as Solid signals

**Test gate**:

- Full smoke spec (T3) + the entire `e2e/` suite passes on Solid
- Visual regression: side-by-side screenshots of every route across
  both builds (manual signoff)
- Dashboard's 314 vitest specs replicated 1:1 (vitest works equally
  with `@solidjs/testing-library`)

**Risks**:

- The action client has implicit React-flavored re-render semantics
  that the Solid version must replicate carefully
- Setup wizard has deeper interaction state — make sure
  `localStorage` keys are preserved across the runtime swap

### G16-P4 — Cutover

**Goal**: Delete React.

**Files in scope** (one PR, single commit):

- `git mv dashboard dashboard-react-removed && git rm -r dashboard-react-removed`
  (or straight `git rm -rf dashboard/`)
- `git mv dashboard-solid dashboard`
- Update `pnpm-workspace.yaml` if needed
- Update `package.json` `files` entry, `scripts.docs:build`, `scripts.dev`
- Update `packages/daemon/src/command-center/static.ts`:
  - Resolver looks for `dashboard/dist/` instead of `dashboard/out/`
  - Drop the `_next/static` cache-control special case
- Update `.github/workflows/{ci,smoke}.yml`:
  - `cd dashboard && pnpm build` swaps from `next build` to `vite build`
  - Drop `next` from cache keys
- Update `playwright.smoke.config.ts` / `playwright.config.ts` if any
  Next-specific paths are baked in
- Update `app-electron/` to load `dashboard/dist/index.html`

**Test gate**:

- `pnpm check` (lint, format, typecheck, tests, pack:check) green
- `e2e/smoke.spec.ts` green
- Daemon `command-center` serves the new `dist/` correctly (the
  `static.test.ts` test fixtures need new sample paths)
- Manual: full app walkthrough on the production binary

**Risks**:

- The `dashboard/out/` path is hard-coded in several places — audit
  before cutover
- `app-electron/` build flow may assume Next-specific assets
- npm pack — `package.json#files` may include dashboard/out
- Tailscale / remote-access docs reference `/v2/*` paths; URLs
  unchanged so this is cosmetic only

---

## 7. Centralisation we get for free

These are downstream of removing the framework boundary, not specific
deliverables, but they fall out of P1/P2:

- **One `ViewId` registry**: `dashboard-solid/src/lib/routes.ts`. App
  Router → solid router collapses the three-place definition the
  WN11 audit calls out.
- **One store flavour**: Solid stores everywhere. No Zustand drift.
- **One reactive primitive**: `createSignal` / `createMemo` / `createStore`.
  No React `useState` vs Solid signal mental switch.
- **One build**: `vite build`. No Next + Vite + tsdown choreography,
  no chat-solid dist freshness race (the chat-solid silo gets
  consumed via the workspace alias rather than its compiled dist —
  Vite resolves the source `.tsx` directly).
- **One `tsconfig`**: shared between widgets, chat-solid, and
  dashboard. Today there are 3.
- **One Effect runtime**: Solid + Effect uses the same
  `Effect.runFork` / `Layer.provide` story client-side as Goal-14
  established server-side.

---

## 8. Decision log + open questions

### Decisions baked in

- **Stack**: Vite + `@solidjs/router` (§3)
- **Migration shape**: Parallel `dashboard-solid/`, one-route-at-a-time
- **Solid headless lib**: corvu first, kobalte fallback
- **Resizable**: corvu `Resizable` first, hand-rolled fallback
- **dnd**: `@thisbeyond/solid-dnd`
- **xterm**: existing package, manual Solid wrapper

### Open questions to resolve in P1

1. Does `@tmux-ide/v2-solid-widgets` consumed via workspace alias
   (source) cause `solid-js` instance duplication? Likely yes —
   `dedupe: ['solid-js']` in `vite.config.ts` should fix it.
2. Single `<App />` with a router, or per-route entries (HTML
   per-route, hash-routed)? Recommend single SPA; daemon already
   does the `index.html` fallback for unknown paths.
3. Where does Effect runtime live? `dashboard-solid/src/lib/runtime/`
   with one `MainLayer` provided at `<App>` root — same shape as
   Goal-14's daemon `MainLayer`.
4. Tailwind v4 — Vite plugin or PostCSS? Solid-widgets is already on
   Vite; align.
5. Do we want `vite-plugin-solid-router` (file-based routes) or
   manual `<Routes>` config? File-based for parity with current Next
   layout; less migration churn.

### Non-questions

- SSR — no.
- Streaming — no.
- Server functions — no.
- A second framework boundary — no.

---

## 9. What this audit does not cover

- Visual design parity. UI work continues against `dashboard-solid/`
  during P2/P3 — `next-themes` → custom signal swap is in scope, but
  re-skinning is not Goal-16's concern.
- Performance regression analysis. Solid is ~10× smaller bundle and
  ~3× faster reconciliation in published benchmarks; we'll measure
  end-to-end at P3 against the React baseline.
- The native macOS app (`app-electron/`). The cutover step updates its
  asset path, nothing else.
- The docs site (`docs/`). Stays on Fumadocs / Next — orthogonal.

The deliverable of this P0 is the document and the decision. Code
arrives in G16-P1.
