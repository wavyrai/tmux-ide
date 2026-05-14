# App wiring audit (non-chat surfaces)

Companion to `docs/chat-wiring-audit.md` (commit 4c1ad19). Same
methodology — for every interactive non-chat surface in the
dashboard, trace each UI handler from the Solid mount option →
React bridge → daemon endpoint, and flag where the chain breaks.

Read-only audit. No code changes. Findings drive the W-numbered
fix queue in §5 (fresh numbering — `WN1…` to avoid collision with
the chat audit's `W1…W8`).

## 1. Methodology

For each widget / surface:

1. List its handler-shaped props from the Solid mount options
   (`packages/v2-solid-widgets/src/types.ts`) or React component
   interface.
2. Open the React bridge / host file. Note which handler props are
   actually passed at mount.
3. Trace each wired handler to its daemon endpoint via
   `dashboard/lib/api.ts` → `packages/daemon/src/command-center/
server.ts`.
4. Classify (one row per handler):
   - ✅ **WORKS** — UI fires, bridge passes the call, daemon endpoint
     exists and returns real data.
   - ⚠️ **STUB** — Action fires but the daemon route returns mock /
     empty / not-implemented state.
   - ❌ **DEAD-AT-BRIDGE** — The widget exposes a handler prop but the
     bridge / host never passes one.
   - ❌❌ **DEAD-AT-DAEMON** — Bridge calls an endpoint that doesn't
     exist.
   - ❓ **UNKNOWN** — Could not be confirmed via static read; needs
     browser smoke.

Sources walked: every file under
`packages/v2-solid-widgets/src/widgets/`,
`dashboard/components/{*-bridge,V2*,StatusBar,BottomPanel,Project*}`,
`dashboard/app/v2/_lib/V2*Island.tsx`,
`dashboard/app/v2/_lib/V2ActivityBar.tsx`,
`dashboard/app/v2/project/[name]/ProjectV2Page.tsx`,
`dashboard/lib/{api,useChromeLayout,useChromeShortcuts}.ts`, and
`packages/daemon/src/command-center/server.ts`.

## 2. Per-surface audit

### 2.1 Solid widgets

#### `KanbanBoard` → `KanbanBoardBridge`

| Prop                           | Wired?                                                                                         | Endpoint                           | Status                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `onTaskClick(id)`              | ✅ pushes `?task=ID` URL param                                                                 | n/a (host-routed)                  | ✅ WORKS                                   |
| `onTaskStatusChange(id, next)` | ✅ → `updateTask(name, id, {status})`                                                          | POST `/api/project/:name/task/:id` | ✅ WORKS                                   |
| `onCreateTask()`               | ✅ opens `<CreateTaskDialog>`                                                                  | POST `/api/project/:name/task`     | ✅ WORKS                                   |
| Filters / group-by / search    | widget-internal                                                                                | n/a                                | ✅ WORKS                                   |
| Drag-to-move-status            | **not exposed** — the widget only ships click-to-cycle dot; DnD library wasn't ported to Solid | n/a                                | ❌ DEAD-AT-WIDGET (no handler prop exists) |

#### `TasksView` → `TasksViewBridge`

| Prop                                          | Wired?                                                                    | Endpoint                       | Status   |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------ | -------- |
| `onTaskClick(id)`                             | ✅ pushes `?task=ID` (Kanban detail)                                      | n/a                            | ✅ WORKS |
| `onCreateTask()`                              | ✅ via `onCreateTaskRef` to host modal                                    | POST `/api/project/:name/task` | ✅ WORKS |
| Filter chips (status/goal/milestone/priority) | widget-internal                                                           | n/a                            | ✅ WORKS |
| Status mutations (inline)                     | **not exposed** — the row is click-only; status changes go through Kanban | n/a                            | n/a      |

#### `Activity` (`mountActivity`)

| Prop     | Wired?                                                                                                                                                       | Endpoint | Status                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `events` | **no React mount site exists in the dashboard** — the export `mountActivity` is callable but nothing mounts it. Inspector internally embeds the same widget. | —        | ❌ DEAD-AT-MOUNT-SITE (the widget is alive but never visible standalone) |

#### `Costs` (`mountCosts`) → `V2CostsIsland`

| Prop                      | Wired?                                               | Endpoint                                | Status   |
| ------------------------- | ---------------------------------------------------- | --------------------------------------- | -------- |
| (no callbacks; read-only) | host passes `sessionName / apiBaseUrl / bearerToken` | GET `/api/project/:name/metrics` family | ✅ WORKS |

#### `CostsDashboard` (`mountCostsDashboard`)

| Prop       | Wired?                                               | Endpoint | Status                |
| ---------- | ---------------------------------------------------- | -------- | --------------------- |
| `snapshot` | **no React mount site** — exported but never mounted | —        | ❌ DEAD-AT-MOUNT-SITE |

#### `Explorer` (`mountExplorer`) → `V2ExplorerIsland`

| Prop                    | Wired?                                                      | Endpoint                                                      | Status                        |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------- |
| `onOpenFile(path)`      | ✅ → `setPreviewPath` in `ProjectV2Page` (Files-split view) | GET `/api/project/:name/preview/:file` (preview side fetches) | ✅ WORKS                      |
| Right-click context     | **not in mount-options surface**                            | n/a                                                           | ❌ DEAD-AT-WIDGET             |
| Persistent expand state | widget-internal Set<string>; not persisted across reloads   | n/a                                                           | ⚠️ STUB (session-scoped only) |

#### `ExplorerDashboard` (`mountExplorerDashboard`) → `ExplorerBridge`

| Prop                        | Wired?                                    | Endpoint                       | Status   |
| --------------------------- | ----------------------------------------- | ------------------------------ | -------- |
| `onSelect(path, isDir)`     | ✅ → forwards typed entry via `findEntry` | n/a                            | ✅ WORKS |
| `rootEntries` (prop-driven) | host-supplied tree                        | GET `/api/project/:name/files` | ✅ WORKS |

#### `MissionControl` (`mountMissionControl`) → `V2MissionControlIsland`

| Prop                                | Wired?                                 | Endpoint                                     | Status   |
| ----------------------------------- | -------------------------------------- | -------------------------------------------- | -------- |
| (polling-mode widget; no callbacks) | host passes `sessionName / apiBaseUrl` | GET `/api/project/:name/mission` + `/events` | ✅ WORKS |

#### `MissionControlDashboard` (`mountMissionControlDashboard`)

| Prop                   | Wired?                  | Endpoint | Status                |
| ---------------------- | ----------------------- | -------- | --------------------- |
| `snapshot`             | **no React mount site** | —        | ❌ DEAD-AT-MOUNT-SITE |
| `onTaskClick(id)`      | —                       | —        | ❌ DEAD-AT-MOUNT-SITE |
| `onAgentClick(paneId)` | —                       | —        | ❌ DEAD-AT-MOUNT-SITE |
| `onShowAllEvents()`    | —                       | —        | ❌ DEAD-AT-MOUNT-SITE |

#### `PlansRail` (`mountPlansRail`)

| Prop                 | Wired?                                                                                        | Endpoint                                         | Status                |
| -------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| `onSelect(filename)` | **no React bridge file ships PlansRail** — `V2PlansView` uses a different rail implementation | —                                                | ❌ DEAD-AT-MOUNT-SITE |
| `onCreate()`         | —                                                                                             | POST `/api/project/:name/plans/:filename` exists | ❌ DEAD-AT-MOUNT-SITE |

#### `PlansPanel` (`mountPlansPanel`) → `PlansPanelBridge` (used by `V2PlansView`)

| Prop                            | Wired?                                                                                                                    | Endpoint                                              | Status          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------- |
| `plan` / `planData` (data-only) | host-supplied                                                                                                             | GET `/api/project/:name/plans/:filename`              | ✅ WORKS        |
| `onEdit()`                      | **bridge accepts the prop** (line 38) but `V2PlansView` calls `<PlansPanelBridge plan={...} planData={...} />` without it | n/a                                                   | ❌ DEAD-AT-HOST |
| `onMarkDone()`                  | same — bridge accepts, host omits                                                                                         | POST `/api/project/:name/plans/:filename/done` exists | ❌ DEAD-AT-HOST |

#### `SkillsView` (`mountSkillsView`) → `SkillsViewBridge`

| Prop                   | Wired?                                            | Endpoint                    | Status                                    |
| ---------------------- | ------------------------------------------------- | --------------------------- | ----------------------------------------- |
| `onSelect(name)`       | ✅ pushes `?skill=NAME`                           | n/a                         | ✅ WORKS                                  |
| Create / edit / delete | **not exposed** in the Solid mount options at all | POST/PATCH/DELETE on skills | ❌❌ DEAD-AT-DAEMON (daemon only has GET) |

#### `Inspector` (`mountInspector`) → `InspectorBridge`

| Prop                     | Wired?                                                                                                                         | Endpoint                                 | Status                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------ |
| `events`                 | ✅ self-sources via `fetchEvents` + `subscribeSession` WS                                                                      | GET `/api/project/:name/events` + WS bus | ✅ WORKS                                                                 |
| `currentView`            | ✅ piped from `ProjectV2Page.view`                                                                                             | n/a                                      | ✅ WORKS                                                                 |
| `onToggleExpanded(next)` | ✅ accepted but **`InspectorBridge` is mounted by `ProjectV2Page` without passing it** — collapse state is widget-uncontrolled | n/a                                      | ❌ DEAD-AT-HOST (works as uncontrolled; intent is to allow host control) |

#### `CommandPalette` (`mountCommandPalette`) → `CommandPaletteBridge`

| Prop                     | Wired?                                                                      | Endpoint                                                                                     | Status                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `onSelect(category, id)` | ✅ routes per category (views, skills, tasks, threads, providers, commands) | various                                                                                      | ✅ WORKS for views/skills/tasks/threads/commands; ⚠️ STUB for providers (routes to costs view — no real per-provider config UI) |
| `onDismiss()`            | ✅ → `closeCommandPalette()`                                                | n/a                                                                                          | ✅ WORKS                                                                                                                        |
| Result population        | ✅ fetches providers/threads/skills/tasks on open                           | GET `/api/chat/providers`, `/api/threads`, `/api/project/:name/skills`, `/api/project/:name` | ✅ WORKS                                                                                                                        |

#### `DiffsViewer` (`mountDiffsViewer`) → `DiffsViewerBridge`

| Prop                                     | Wired?          | Endpoint                                      | Status   |
| ---------------------------------------- | --------------- | --------------------------------------------- | -------- |
| `sessionName / apiBaseUrl / bearerToken` | ✅              | GET `/api/project/:name/diff` + `/diff/:file` | ✅ WORKS |
| Hunk navigation / file selection         | widget-internal | n/a                                           | ✅ WORKS |
| `initialDiffStyle`                       | ✅ optional     | n/a                                           | ✅ WORKS |

#### `Changes` (`mountChanges`) → `V2ChangesIsland`

| Prop                                     | Wired?                            | Endpoint                      | Status   |
| ---------------------------------------- | --------------------------------- | ----------------------------- | -------- |
| `sessionName / apiBaseUrl / bearerToken` | ✅                                | GET `/api/project/:name/diff` | ✅ WORKS |
| Stat-label clicks                        | widget-internal (no handler prop) | n/a                           | n/a      |

### 2.2 Dashboard chrome / non-widget surfaces

#### `V2ActivityBar`

| Button                                                             | onClick?                                                      | Status                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------- |
| Files / Diffs / Plans / Tasks / Skills / Mission / Chat / Terminal | ✅ each calls `onView(id)` → `setView` in `ProjectV2Page`     | ✅ WORKS                                                      |
| Search                                                             | ✅ `openCommandPalette()`                                     | ✅ WORKS                                                      |
| Widgets                                                            | ✅ `window.location.assign("/v2/widgets")`                    | ✅ WORKS                                                      |
| Account                                                            | **no onClick** (line 147-152 of `V2ActivityBar.tsx`)          | ❌ DEAD-AT-BRIDGE                                             |
| Settings                                                           | **no onClick** (line 153-158)                                 | ❌ DEAD-AT-BRIDGE (also no `/v2/settings` route — see §3)     |
| URL persistence (`?view=`)                                         | **not persisted** — view state lives only in React `useState` | ⚠️ STUB (deep-links to `?view=files` ignored on first render) |

#### `BottomPanel`

| Tab / Action                    | Status                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Terminal tab → xterm + PTY WS   | ✅ WORKS                                                                                                             |
| Tab-switch (`onSelect`)         | widget-internal; preserves Terminal via CSS toggle                                                                   | ✅ WORKS                                                                                                                    |
| Problems list (`problems` prop) | **host (`ProjectV2Page`) mounts `<BottomPanel projectName={projectName} />` without `problems` or `outputChannels`** | ❌ DEAD-AT-HOST (Problems shows "No problems detected"; Output uses default 4 channels with no `streamUrl`)                 |
| Output channel `streamUrl`      | Default `DEFAULT_CHANNELS` ship without `streamUrl` → panel renders "not yet plumbed"                                | ⚠️ STUB (daemon `/api/logs/:channel` SSE endpoint EXISTS — see §4 — but the channel registry isn't pre-populated with URLs) |
| Pause / Clear                   | ✅ widget-internal state                                                                                             | ✅ WORKS                                                                                                                    |

#### `StatusBar`

| Control                                               | Wired?                                                                                         | Status                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Branch chip (left)                                    | ✅ fetches via `fetchProjects` → `RegisteredProject.gitBranch`                                 | ✅ WORKS (refreshes on focus)                                      |
| Session dot + name                                    | ✅ from `running` / `projectName` props                                                        | ✅ WORKS                                                           |
| Agents count                                          | ✅ from `agentCount` prop                                                                      | ✅ WORKS                                                           |
| Latest event chip                                     | ✅ from `events[events.length - 1]`                                                            | ✅ WORKS                                                           |
| Chrome toggles (PanelLeft / PanelBottom / PanelRight) | ✅ → `toggleLeftSidebar` / `toggleBottomPanel` / `toggleRightInspector` from `useChromeLayout` | ✅ WORKS                                                           |
| Branch click → palette                                | ✅ `openCommandPalette()` (placeholder — no actual branch switcher action registered)          | ⚠️ STUB                                                            |
| ThemeToggle                                           | ✅ existing component                                                                          | ✅ WORKS                                                           |
| `bottomPanelUnread` badge                             | host (`ProjectV2Page`) does not pass `bottomPanelUnread`                                       | ❌ DEAD-AT-HOST (prop optional, defaults to 0 → badge never shows) |

#### `useChromeLayout` + `useChromeShortcuts`

| Path                                                                       | Status                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `toggleLeftSidebar` / `toggleBottomPanel` / `toggleRightInspector` actions | ✅ flip booleans + persist to `localStorage["tmux-ide.v2.chrome.v1"]`               |
| `useChromeShortcuts` Cmd+B / Cmd+J / Cmd+Alt+B                             | ✅ window keydown listener, skip when inside `<input>`/`<textarea>`/contenteditable |
| `ProjectV2Page` panel `useEffect` → `panelRef.collapse()` / `.expand()`    | ✅ each region                                                                      |
| Drag-to-collapse syncs back via `onResize`                                 | ✅ both directions                                                                  |

#### `ProjectSidebar` (inline in `ProjectV2Page`)

| Item                                    | Status                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| Project chip (top)                      | ✅ shows `projectName`                                                                |
| VIEWS list → `onView(id)`               | ✅ WORKS                                                                              |
| Widgets links (Files / Mission Control) | ✅ `<Link>` to `/v2/widget/...` route                                                 |
| Milestones list → `onView("mission")`   | ⚠️ STUB (all milestones route to the same "mission" view; no per-milestone deep link) |

#### `ProjectSwitcher` (in legacy `TopBar`)

| Path                          | Status                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Component rendered?           | Imported by `dashboard/components/TopBar.tsx`, which is still mounted from `dashboard/app/layout.tsx` (the global header above /v2). Hydration mismatch warnings observed in console (see `chat-wiring-audit.md` §3) but the switcher itself works. | ✅ WORKS |
| Click → project picker dialog | ✅ existing dialog                                                                                                                                                                                                                                  | ✅ WORKS |

#### `V2ChatView` host wiring

| Prop fed to `<ChatV2Root>`                              | Status                                                                                                                                        |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `projectName`                                           | ✅                                                                                                                                            |
| `threads` from `chatThreadList()`                       | ✅                                                                                                                                            |
| `activeThreadId` (managed locally)                      | ✅                                                                                                                                            |
| `onPickThread / onNewThread / onDeleteThread`           | ✅                                                                                                                                            |
| `mentionCandidates` (files + threads + agents + skills) | ✅                                                                                                                                            |
| `onOpenFile`                                            | **not piped from `V2ChatView` to `<ChatV2Root>` — the `ChatV2RootProps` accepts it (per commit `20c5ebf`) but `V2ChatView` doesn't pass one** | ❌ DEAD-AT-HOST |

### 2.3 Settings surface

`/v2/settings` route **does not exist**. `dashboard/app/v2/` has
`_lib`, `layout.tsx`, `page.tsx`, `project/`, `setup/`, `terminal/`,
`widget/`, `widgets/` — no `settings/`. The `V2ActivityBar` "Settings"
button has no `onClick`, so the missing route doesn't surface as a
404 — it just does nothing.

The "Account" entry next to it is in the same state: no handler, no
route.

### 2.4 Daemon endpoints — present vs needed

Daemon routes the audit relies on (all confirmed in
`packages/daemon/src/command-center/server.ts`):

```
GET    /api/project/:name                         ✅
GET    /api/project/:name/files                   ✅
GET    /api/project/:name/preview/:file           ✅
GET    /api/project/:name/diff                    ✅
GET    /api/project/:name/diff/:file              ✅
POST   /api/project/:name/task                    ✅
POST   /api/project/:name/task/:id                ✅
DELETE /api/project/:name/task/:id                ✅
GET    /api/project/:name/mission                 ✅
GET    /api/project/:name/events                  ✅
GET    /api/project/:name/stream                  ✅ (SSE)
GET    /api/project/:name/plans                   ✅
POST   /api/project/:name/plans/:filename         ✅ (save)
POST   /api/project/:name/plans/:filename/done    ✅
POST   /api/project/:name/plans/:filename/status  ✅
DELETE /api/project/:name/plans/:filename         ✅
GET    /api/project/:name/metrics{,/agents,/timeline,/history} ✅
GET    /api/project/:name/skills                  ✅
GET    /api/project/:name/skills/:name            ✅
GET    /api/project/:name/config                  ✅
POST   /api/project/:name/config                  ✅
POST   /api/project/:name/restart                 ✅
POST   /api/project/:name/launch                  ✅
POST   /api/project/:name/stop                    ✅
GET    /api/threads, POST/DELETE                  ✅
GET    /api/chat/providers                        ✅
GET    /api/providers, POST/DELETE                ✅
GET    /api/logs/:channel                         ✅ (SSE)
```

Daemon routes the audit shows missing (or under-spec'd):

```
POST   /api/project/:name/skills                  ❌ — skill create
PATCH  /api/project/:name/skills/:name            ❌ — skill edit
DELETE /api/project/:name/skills/:name            ❌ — skill delete
POST   /api/project/:name/branch                  ❌ — switch git branch
                                                       (StatusBar branch click stubs at the palette)
```

## 3. Dead-end inventory grouped by depth

### Surface ships a button / chip / handler but the host never wires it ("dead-at-host")

| Surface                  | Detail                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `V2ActivityBar` Account  | no `onClick`                                                                                         |
| `V2ActivityBar` Settings | no `onClick` + no `/v2/settings` route                                                               |
| `PlansPanelBridge`       | bridge accepts `onEdit` + `onMarkDone`; `V2PlansView` passes neither                                 |
| `InspectorBridge`        | accepts `onToggleExpanded` from host; `ProjectV2Page` doesn't pass one (uncontrolled fallback works) |
| `BottomPanel` (Problems) | host omits `problems` prop                                                                           |
| `BottomPanel` (Output)   | host omits `outputChannels` → defaults ship without `streamUrl`                                      |
| `StatusBar` unread badge | host omits `bottomPanelUnread`                                                                       |
| `V2ChatView`             | doesn't pass `onOpenFile` through to `<ChatV2Root>`                                                  |

### Surface exposes no handler for the action ("dead-at-widget")

| Surface                             | Detail                                            |
| ----------------------------------- | ------------------------------------------------- |
| `KanbanBoard` drag-to-move          | not in Solid mount options (only click-cycle dot) |
| `Explorer` right-click context      | no `onContextMenu`-like prop                      |
| `SkillsView` create / edit / delete | no handlers exposed                               |

### Bridge would call a route that doesn't exist ("dead-at-daemon")

| Surface                   | Endpoint(s) needed                                          |
| ------------------------- | ----------------------------------------------------------- |
| Skills create/edit/delete | `POST` / `PATCH` / `DELETE /api/project/:name/skills/:name` |
| StatusBar branch switcher | `POST /api/project/:name/branch`                            |

### Widgets exported but mounted nowhere ("dead-at-mount-site")

| Widget                         | Notes                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `mountActivity`                | Inspector internally embeds the same data — standalone Activity export has no host |
| `mountCostsDashboard`          | snapshot-driven dashboard variant of Costs; no React mount                         |
| `mountMissionControlDashboard` | snapshot-driven MissionControl variant; no React mount                             |
| `mountPlansRail`               | `V2PlansView` uses a different rail implementation                                 |

### Stubs (action fires, the receiver is half-implemented)

| Surface                             | Detail                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| StatusBar branch click → palette    | opens palette but no "switch branch" action is registered                        |
| CommandPalette providers category   | routes to costs view; no per-provider config page                                |
| Sidebar milestone rows              | all link to "mission" view — no per-milestone detail                             |
| BottomPanel Output channels         | default channels carry no `streamUrl`; daemon SSE exists at `/api/logs/:channel` |
| Activity bar view-state persistence | view lives only in `useState`; `?view=` deep links ignored                       |

## 4. Cross-cutting issues

1. **Dead reducer branches in `useChatStore`.** Post-`20c5ebf`, the
   right pane mounts chat-solid. `activitiesByThread`,
   `turnsByThread`, `checkpointsByThread`, `plansByThread` are still
   written by `applyEvent` but no selector reads them. Wasted CPU on
   every chat WS frame; cleanup deferred but worth tracking.
2. **Two parallel API layers for the same data.** `lib/api.ts`
   exports `fetchTasks/fetchPlans/fetchSkills/...` AND
   `useSessionStream` ships a WS-driven snapshot carrying the same
   data. Host components hit both, sometimes for the same query.
3. **URL state is inconsistent.** Some views push URL params on
   selection (`SkillsViewBridge` → `?skill=NAME`), others don't
   (`view` itself isn't persisted). Deep-links on first load route
   only for some surfaces.
4. **Hydration mismatch warnings.** Base-UI tooltips inside the
   V2ActivityBar emit different React IDs server-side vs client-side
   (mitigated by `dynamic({ ssr: false })` per commit 4c1ad19), but
   `TopBar` + `ShellSidebarProvider` still leak a similar warning
   per chat audit §3. Not strictly dead wiring, but it's noise in
   the console that hides real bugs.
5. **No "view" registry.** The list of valid view ids lives in three
   places (`ViewId` union in `ProjectV2Page`, `VIEWS` array, the
   command palette's `PALETTE_VIEWS`). Adding/removing a view costs
   three edits and is easy to miss (the deleted Preview entry hung
   around until a manual sweep).

## 5. Prioritized fix plan

Numbering starts at `WN1` so it doesn't collide with the chat
audit's `W1…W8`.

### WN1 — Wire BottomPanel data (Problems + Output channels)

- **Surface:** `ProjectV2Page` mount of `<BottomPanel projectName=
... />`.
- **Why:** the Bottom Panel is the user's main "what's the system
  doing right now" surface. Both tabs ship empty/placeholder.
- **Scope:** thread `problems={...}` (sourced from a typecheck/lint
  poll the dashboard already runs for the StatusBar latest-event
  chip) and `outputChannels={[{id:"daemon-log", streamUrl:
resolveApiBase()+"/api/logs/daemon-log"}, …]}` (daemon endpoint
  already exists at `/api/logs/:channel`).
- **Effort:** S (1 file, ~20 lines).
- **Depends on:** nothing — daemon side is already there.

### WN2 — Wire `?view=` URL persistence

- **Surface:** `ProjectV2Page` `view` state + `V2ActivityBar`
  `onView`.
- **Why:** deep-links (palette → skill / task / thread) push URL
  params for some categories but the `view` itself isn't synced.
  Reload of `/v2/project/X?view=chat` lands on Kanban.
- **Scope:** `useEffect` on `view` to `replaceState` `?view=...`;
  initial state seeded from `searchParams.get("view")`.
- **Effort:** S.
- **Depends on:** nothing.

### WN3 — Plans actions (Edit + Mark done + Delete)

- **Surface:** `V2PlansView` → `<PlansPanelBridge>`.
- **Why:** the widget surfaces `[edit]` / `[mark done]` chips that
  do nothing. Daemon endpoints exist (`POST /plans/:f/done`,
  `DELETE /plans/:f`).
- **Scope:** plumb `onEdit` (opens the existing `MarkdownEditor`
  inline below the panel — or a toggle) and `onMarkDone` (fetch
  the done endpoint, then refetch the list).
- **Effort:** S.
- **Depends on:** nothing.

### WN4 — Settings route + ActivityBar Settings/Account onClick

- **Surface:** new `app/v2/settings/page.tsx`, plus onClick wiring
  on the bottom group of `V2ActivityBar`.
- **Why:** two buttons that do nothing. Settings should at least
  surface project config (ide.yml) — config endpoints exist on the
  daemon (`/api/project/:name/config` GET+POST + `/restart`).
- **Scope:** new page that re-renders the config form deleted in
  `d6155d6` against the working daemon endpoints. Plus
  `onClick: () => router.push("/v2/settings")` on the activity bar
  buttons.
- **Effort:** M (one new page, the form already exists in
  `d6155d6`'s deleted commit and can be cherry-picked).
- **Depends on:** nothing.

### WN5 — Inspector controlled-expanded + Cmd+I shortcut

- **Surface:** `InspectorBridge` + `ProjectV2Page` + `useChromeLayout`.
- **Why:** Inspector ships an `onToggleExpanded` handler; host
  ignores it. Result: when the user collapses the Inspector via
  Cmd+Alt+B (the chrome toggle), the widget's internal
  `expanded` signal stays true and tries to re-expand on the next
  prop update.
- **Scope:** pipe `chrome.rightInspectorOpen` → `expanded` prop;
  pipe `onToggleExpanded` → `setRightInspectorOpen`. One direction
  control, drop the uncontrolled fallback.
- **Effort:** S.
- **Depends on:** nothing.

### WN6 — Skills CRUD endpoints + UI

- **Surface:** Solid `SkillsView` (new mount options) + bridge +
  daemon routes.
- **Why:** users can browse skills but not create/edit/delete from
  the UI. CLI mutations work via `tmux-ide skill create`.
- **Scope (M):** add daemon endpoints (POST / PATCH / DELETE),
  add Solid handler props (`onCreate / onEdit / onDelete`), wire
  the bridge.
- **Effort:** M (daemon + widget + bridge + tests).
- **Depends on:** nothing.

### WN7 — Remove dead reducer branches in `useChatStore`

- **Surface:** `dashboard/components/chat-v2/useChatStore.ts`.
- **Why:** `activitiesByThread / turnsByThread / checkpointsByThread
/ plansByThread` are written on every WS chat frame but no selector
  reads them post-`20c5ebf`. Wasted memory + CPU.
- **Scope:** trim the store to `threads / activeThreadId /
unreadByThread / lastSeqByThread / activeRecovery` + simplify
  `applyEvent` to only bump `unreadByThread`.
- **Effort:** S–M (touches reducer + a handful of tests that still
  exercise the dead branches).
- **Depends on:** nothing.

### WN8 — Branch switcher daemon endpoint + palette action

- **Surface:** `POST /api/project/:name/branch` on daemon + a new
  "Switch branch" action registered into the palette.
- **Why:** StatusBar's branch chip currently opens the palette as
  a placeholder; nothing then actually switches.
- **Scope:** daemon side runs `git switch <name>` after a worktree
  / dirty-state safety check; palette action sources branches from
  `git branch --list`.
- **Effort:** M.
- **Depends on:** nothing.

### WN9 — Mount the snapshot-driven dashboard variants

- **Surface:** `MissionControlDashboard` + `CostsDashboard` widgets.
- **Why:** snapshot-driven variants exist but no React host. The
  polling variants currently used (`mountMissionControl`,
  `mountCosts`) hammer the daemon every 5s; the snapshot variants
  would consume the existing WS bus.
- **Scope:** replace `V2MissionControlIsland` / `V2CostsIsland`
  with bridges that pull from `useSessionStream` and push via
  `setOptions({ snapshot })`. Drop the polling fetches.
- **Effort:** M.
- **Depends on:** nothing.

### WN10 — Standalone Activity surface in the right rail (or retire export)

- **Surface:** `mountActivity` widget.
- **Why:** the widget exists and is exercised by tests, but the
  dashboard only uses Inspector (which subsumes it). Either retire
  `mountActivity` (saves bundle bytes) or build a dedicated route
  (`/v2/project/:name?view=activity`).
- **Scope:** decision + execution. If retiring: remove the export
  - the standalone widget + its tests; the Inspector widget keeps
    the same logic.
- **Effort:** S either way.
- **Depends on:** nothing.

### WN11 — Centralise the view registry

- **Surface:** `ViewId` union, `VIEWS` array, palette's `PALETTE_VIEWS`.
- **Why:** three places to add a view. Easy to drift.
- **Scope:** single `views.ts` module exporting the registry; types
  - arrays + palette items derived.
- **Effort:** S.
- **Depends on:** nothing.

## 6. Headline

Counts (in the per-surface table, §2):

- ✅ **WORKS**: 32 entries
- ⚠️ **STUB**: 6 entries (branch click, palette providers,
  milestone rows, Output channels, view-state URL persistence,
  Explorer expand persistence)
- ❌ **DEAD-AT-HOST**: 8 entries (Account/Settings buttons,
  PlansPanel onEdit + onMarkDone, Inspector onToggleExpanded,
  BottomPanel problems + outputChannels, StatusBar
  bottomPanelUnread, V2ChatView onOpenFile)
- ❌ **DEAD-AT-WIDGET** (no prop exposed): 3 entries (Kanban drag,
  Explorer context-menu, Skills CRUD)
- ❌❌ **DEAD-AT-DAEMON**: 2 entries (Skills POST/PATCH/DELETE,
  branch switcher)
- **DEAD-AT-MOUNT-SITE**: 4 widgets (Activity standalone, two
  dashboard variants, PlansRail)
- ❓ **UNKNOWN**: 0 (every entry traced from the source)

**Top-5 fixes by impact:**

1. **WN1** — wire BottomPanel data. Fixes "Problems / Output do
   nothing" — most visible empty surface in the IDE.
2. **WN4** — restore Settings route. Two activity-bar buttons that
   do nothing today; daemon endpoints already exist.
3. **WN3** — Plans actions (edit / mark done). The chips render
   but click does nothing; one of the few places real user
   workflows hit a dead button.
4. **WN2** — `?view=` URL persistence. Deep-links from palette /
   bookmarks land on Kanban regardless. Cheap.
5. **WN9** — switch dashboards to snapshot-driven. Removes two
   5-second polling loops, consolidates the data path.
