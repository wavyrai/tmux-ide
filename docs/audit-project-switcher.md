# Project switcher — design + gap analysis

Doc-only audit (no code changes). Companion to `docs/app-wiring-audit.md`.

The dashboard route shell `/v2/project/:name` works once you already
know the name, but there is no UI to **list, switch, add, or remove**
projects from inside the running app. This doc inventories what we
have, sketches the three surfaces we want, and sequences the
implementation in phases.

---

## 1. Inventory — what exists today

### 1.1 Daemon REST surfaces

All routes mounted in `packages/daemon/src/command-center/server.ts`.

| Route                                  | Method   | Returns                                                           | Notes                                                                                                                          |
| -------------------------------------- | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `/api/sessions`                        | GET      | `{ sessions: SessionOverview[] }`                                 | Live tmux session discovery (only running). `SessionOverview = { name, dir, mission, stats, goals[] }` (contracts/domain.ts).  |
| `/api/projects`                        | GET      | `{ projects: RegisteredProject[] }`                               | Registry-backed (persisted at `~/.tmux-ide/projects.json`). Fields: `name, dir, hasIdeYml, gitOrigin, gitBranch, registeredAt` |
| `/api/projects`                        | POST     | `{ project }`                                                     | Register an existing dir. 409 on duplicate.                                                                                    |
| `/api/projects/:name`                  | DELETE   | `{ ok: true }`                                                    | Unregister.                                                                                                                    |
| `/api/projects/:name/probe`            | POST     | `{ project }`                                                     | Re-read `hasIdeYml` + git state.                                                                                               |
| `/api/projects/templates`              | GET      | `{ templates }`                                                   | For onboarding.                                                                                                                |
| `/api/projects/init`                   | POST     | `{ jobId }` (202)                                                 | Background init; streams output over WS.                                                                                       |
| `/api/projects/onboard`                | POST     | `{ project }`                                                     | Generate ide.yml + register in one step. Used by `/v2/setup`.                                                                  |
| `/api/filesystem/browse`               | GET      | tree                                                              | Sandboxed dir browser (for picking a folder).                                                                                  |
| `/api/filesystem/inspect`              | POST     | `{ project }`                                                     | Probe a path without registering — used by setup wizard.                                                                       |
| `/api/workspaces` (GET/POST/DELETE)    | —        | `{ workspaces }` / `{ workspace }`                                | **Parallel registry.** Distinct from `/api/projects` — `Workspace` carries `sessionName + projectDir + ideConfigPath`.         |
| `/api/v2/action/project.launch`        | POST     | envelope                                                          | Action dispatcher used by `/v2/setup` to start a tmux session.                                                                 |

WebSocket `/ws/events` already broadcasts the frames we need to
keep the switcher fresh in real time:

- `projects.changed` — fired on register / unregister / probe (project-registry emitter).
- `sessions.changed` — fired when tmux sessions appear / disappear.
- `workspace.added` / `workspace.removed` — for the workspace registry.

### 1.2 Dashboard surfaces

`dashboard/src/main.tsx` mounts these routes:

| Path                  | Component                       | Purpose                                                                  |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `/`                   | `WidgetsRoute`                  | Widgets gallery (the de-facto home page).                                |
| `/v2`                 | `WidgetsRoute`                  | Alias.                                                                   |
| `/v2/widgets`         | `WidgetsRoute`                  | Same.                                                                    |
| `/v2/setup`           | `SetupRoute`                    | 4-step create-project wizard.                                            |
| `/v2/settings`        | `SettingsRoute`                 | Settings.                                                                |
| `/v2/project/:name`   | `ProjectV2Route`                | IDE shell (ActivityBar + Sidebar + Editor + Inspector + Bottom + Status).|
| `/v2/terminal/:id`    | `TerminalRoute`                 | Standalone terminal.                                                     |
| `/v2/widget/:name`    | `WidgetRoute`                   | Standalone widget host.                                                  |

Key observations:

- `App.tsx` is intentionally bare — no top bar, no global chrome. All
  chrome lives inside the route component.
- `StatusBar.tsx` shows the project name at the **bottom** (line 99,
  `data-testid="status-bar-session"`) but it is not clickable as a
  switcher and only exists inside `/v2/project/:name`.
- `dashboard/src/lib/api.ts` exposes `fetchSessions` only — no
  `fetchProjects`, `registerProject`, or `unregisterProject` wrappers.
- `dashboard/src/lib/chrome.ts:106` already owns a global keydown
  handler (`useChromeShortcuts`) that filters `INPUT/TEXTAREA/SELECT/
  contentEditable`. The Cmd+P installer should slot in next to the
  existing Cmd+B / Cmd+J / Cmd+I bindings.
- `dashboard/src/components/v2/SymbolPicker.tsx` is a working
  reference for the **centered palette overlay** pattern we need:
  Portal-based, owns its keydown, debounced query, `MAX_RESULT_ROWS`
  ceiling, Esc + click-outside to dismiss.
- There is no home / welcome route. `/` currently lands users in the
  widgets gallery, which is not "what project do you want to open?"

### 1.3 Two-registries problem

`/api/projects` and `/api/workspaces` are both registry-backed and
overlap in purpose. For the switcher we should commit to
**`/api/projects`** as the source of truth (it's what
`registerProject`, `unregisterProject`, `refreshProject`, and the
`projects.changed` WS frame are wired to). `/api/workspaces` should
stay scoped to the workspace-CRUD callers that already use it; we
should not also read it in the switcher.

This is a doc-only call-out — actual consolidation is out of scope
here, but worth tracking as a follow-up.

### 1.4 Reference apps

- `context/opencode/packages/app/src/pages/layout/sidebar-project.tsx`
  — Solid sidebar with project tiles, drag-reorder, hover preview,
  edit / close affordances. Project shape: `LocalProject { worktree,
  ... }`. Good source for tile layout and the
  `displayName / sortedRootSessions` helpers in
  `pages/layout/helpers.ts`.
- `context/emdash/src/renderer/features/projects/` — Mobx + React
  with a separate **`project-titlebar.tsx`** (top-bar entry, dropdown
  with remove + open-in actions), an **`add-project-modal/`**
  (welcome / first-run flow), and a **sidebar** project list at
  `features/sidebar/project-item.tsx`. Closer to the three-surface
  shape we want.

---

## 2. The three surfaces

### 2.1 Quick switcher overlay (Cmd+P)

Centered palette modal, opens from anywhere in the app, fuzzy search,
keyboard-driven. Same shell as `SymbolPicker` but populated from
`/api/projects` + recently-used metadata.

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│       ┌──────────────────────────────────────────┐       │
│       │ ⌕ Switch project…                        │       │
│       ├──────────────────────────────────────────┤       │
│       │ ● tmux-ide         ~/Developer/tmux-ide  │  ↩    │
│       │   emdash           ~/Developer/emdash    │       │
│       │   opencode-app     ~/code/oc/packages/.. │       │
│       │ ─ Recent ─────────────────────────────── │       │
│       │   chat-solid       ~/Developer/chat-…    │       │
│       │ ─ ─────────────────────────────────────  │       │
│       │ + Add project…              ↪ /v2/setup  │       │
│       └──────────────────────────────────────────┘       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Behaviour:

- Trigger: **Cmd+P** (Ctrl+P on non-Mac) anywhere in the app, plus a
  click target on the new top-bar surface (§2.3).
- Sort: last-used first, then `registeredAt` desc. The "last used"
  pointer is bumped whenever the dashboard navigates to
  `/v2/project/:name`.
- Running indicator: dot in front of the name if the project's name
  matches a running session (`/api/sessions`).
- Fuzzy match against `name + dir` (basename-weighted). Same
  `MAX_RESULT_ROWS = 60` ceiling as `SymbolPicker`.
- Keys: ↑/↓ to move, Enter to navigate, Esc to dismiss, Cmd+Backspace
  on a row to unregister (with a confirm step), `+` or Tab+Enter on
  "Add project…" to push `/v2/setup`.
- Live refresh: subscribe to the `projects.changed` / `sessions.changed`
  WS frames so an in-flight init job updates the list without manual
  refetch.
- A11y: dialog role with focused `<input>`, results in a listbox,
  hidden description for screen readers.

### 2.2 Welcome route (`/`)

Replaces the current "drop the user in the widgets gallery" default.
Two-column layout: recently active on the left, full registered list
on the right, top-aligned "create / open" actions.

```
┌──────────────────────────────────────────────────────────────────┐
│ tmux-ide                                          ⌘P    Settings │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Recently active                       All projects             │
│   ┌─────────────────────────┐           ┌─────────────────────┐  │
│   │ ● tmux-ide              │           │ tmux-ide       open │  │
│   │   ~/Developer/tmux-ide  │           │ emdash         open │  │
│   │   feat/v2.5.0 · dirty   │           │ opencode-app   open │  │
│   ├─────────────────────────┤           │ chat-solid     open │  │
│   │   emdash                │           │ …                   │  │
│   │   ~/Developer/emdash    │           └─────────────────────┘  │
│   └─────────────────────────┘                                    │
│                                          [+ Create]  [↪ Open]    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Behaviour:

- Tiles show `name`, `dir` (collapsed via `~`), branch, and a green
  dot if running.
- Per-row menu (Kobalte dropdown — already in tree, see
  `packages/chat-solid/src/components/PermissionDialog.tsx`):
  *Open*, *Reveal in Finder*, *Probe* (POST
  `/api/projects/:name/probe`), *Remove*. Remove triggers a confirm
  dialog (kobalte) and calls DELETE.
- "Create" → `/v2/setup`. "Open" → file picker (uses
  `/api/filesystem/browse` + `/api/projects` POST to register).
- The widgets gallery moves to `/v2/widgets` only (the alias on `/`
  drops).

### 2.3 Always-visible top-bar entry

A new lightweight `TopBar` mounted by `App.tsx` so the project name
is always visible — the StatusBar at the bottom is too far away to
serve as the primary switcher affordance.

```
┌──────────────────────────────────────────────────────────────────┐
│ ▾ tmux-ide  ·  feat/v2.5.0                  Mission  Settings  ⌘ │
├──────────────────────────────────────────────────────────────────┤
│ (ActivityBar | Sidebar | Editor | Inspector | BottomPanel)       │
├──────────────────────────────────────────────────────────────────┤
│ StatusBar (24px)                                                 │
└──────────────────────────────────────────────────────────────────┘
```

Behaviour:

- Click the project name (or the chevron) → opens the Cmd+P quick
  switcher (§2.1).
- Branch + dirty marker mirror `StatusBar` data so users always see
  state, even when the StatusBar is off-screen on small viewports.
- Hidden on `/` (the welcome route doesn't need it) and on
  `/v2/setup`. Visible on `/v2/project/:name`, `/v2/widgets`,
  `/v2/widget/:name`, `/v2/terminal/:id`, `/v2/settings`.
- 28px tall, sits above the existing route content (no grid
  surgery required — `App.tsx` already wraps `{props.children}` in
  a `flex-col`).

---

## 3. Implementation phases

### Phase 0 — Daemon API gaps

1. **Last-used tracking.** `RegisteredProject` (`packages/daemon/src/
   schemas/registry.ts`) has no `lastOpenedAt`. Two viable shapes:

   - **(a) daemon-side:** add `lastOpenedAt: z.string().nullable()`
     to `RegisteredProjectSchemaZ`, expose `POST /api/projects/:name/
     touch` (or fold into `probe`), broadcast `projects.changed`.
     Pros: shared across browser sessions / multiple dashboards.
     Cons: requires a schema bump + new endpoint + test.
   - **(b) client-side:** persist `{ name → ISO timestamp }` in
     `localStorage` under a `tmux-ide:last-used` key. Pros: zero
     daemon work. Cons: per-browser, doesn't survive a reinstall.

   Recommendation: ship **(b)** in phase 1 to unblock the surfaces,
   add **(a)** as a follow-up if the daemon-side persistence
   actually matters.

2. **Combined snapshot.** The switcher needs *both* registry and
   live-session data. Two cheap fetches today (`/api/projects` +
   `/api/sessions`). Optionally add `/api/projects?include=running`
   to fold them server-side. Not blocking — start with two fetches +
   client-side merge.

3. **`/` alias cleanup.** `/api/sessions` and `/api/projects` already
   exist. No daemon changes strictly required for phase 1.

### Phase 1 — API client + state primitives

Files: `dashboard/src/lib/api.ts`, new `dashboard/src/lib/projects.ts`.

1. Add to `dashboard/src/lib/api.ts`:

   - `fetchProjects(): Effect.Effect<readonly RegisteredProject[], ApiError>`
   - `registerProject({ dir, name? }): Effect.Effect<RegisteredProject, ApiError>`
   - `unregisterProject(name): Effect.Effect<void, ApiError>`
   - `probeProject(name): Effect.Effect<RegisteredProject, ApiError>`

   Type imports from `@tmux-ide/contracts` once we re-export
   `RegisteredProject` from there (currently lives in
   `packages/daemon/src/schemas/registry.ts`).

2. New `dashboard/src/lib/projects.ts` — a Solid `createResource`
   over the two fetches, merged into a `ProjectListItem`:

   ```ts
   interface ProjectListItem {
     name: string;
     dir: string;
     gitBranch: string | null;
     hasIdeYml: boolean;
     running: boolean;       // joined from /api/sessions
     lastOpenedAt: string | null;  // from localStorage (phase 0b)
     registeredAt: string;
   }
   ```

   Plus a `recordOpened(name)` helper called from `ProjectV2Route`'s
   `onMount`, and a WS subscription that refetches on
   `projects.changed` / `sessions.changed`.

### Phase 2 — Quick switcher overlay

Files: `dashboard/src/components/QuickSwitcher.tsx`, mount in `App.tsx`.

1. Copy `SymbolPicker.tsx`'s shell: Portal + centered card + input +
   listbox + Esc/Enter/↑/↓ keys.
2. Replace the symbol query with `projects` from
   `dashboard/src/lib/projects.ts`, plus a small client-side fuzzy
   matcher (no new dep — `name.includes(query) || dir.includes(query)`
   weighted by basename match is fine for ≤ 100 projects).
3. Add `Cmd+P` keybind to `dashboard/src/lib/chrome.ts` next to
   `Cmd+B` / `Cmd+J` / `Cmd+I`. Reuse `isEditableTarget` so it
   doesn't fire inside chat / editor / terminal inputs.
4. Render `<QuickSwitcher>` inside `App.tsx` so it's reachable from
   every route.

### Phase 3 — Welcome route

Files: `dashboard/src/routes/v2/welcome.tsx`, update `main.tsx`
routing.

1. New `WelcomeRoute` mounted at `/`. Move the widgets gallery off
   the `/` alias — it stays at `/v2/widgets`.
2. Two-column grid (recent / all). Per-tile dropdown via
   `@kobalte/core` (already adopted in `PermissionDialog`).
3. "Create" → `useNavigate("/v2/setup")`. "Open" → opens a folder
   picker modal that wraps `/api/filesystem/browse` (similar to the
   detect step of `setup.tsx`).
4. Use `@solidjs/router`'s preload on tile hover to warm
   `/v2/project/:name` for the lazy chunk.

### Phase 4 — Top-bar surface

Files: `dashboard/src/components/TopBar.tsx`, mount in `App.tsx`,
hide-on-route logic.

1. 28px row above `{props.children}` in `App.tsx`.
2. Reads `useParams<{ name: string }>()` *via a useLocation
   wrapper* — `App` is above all `<Route>` children, so use
   `useLocation` + a regex on `pathname` to pull the current project
   name (or expose it via a `createContext` set by `ProjectV2Route`'s
   `onMount`).
3. Click → opens the same `<QuickSwitcher>` signal that Cmd+P
   toggles.
4. Hide via a small `useShowTopBar()` derived from `useLocation()`:
   hidden on `/`, `/v2/setup`. Visible elsewhere.

### Phase 5 — Wire-coverage tests

Test runner: `vitest` + `@solidjs/testing-library` (same stack as
`dashboard/__tests__/project-route.test.tsx` and `settings.test.tsx`).
Patterns to follow:

- Module-mock `dashboard/src/lib/api.ts` so tests never hit a
  daemon — return canned `RegisteredProject[]` / `SessionOverview[]`
  arrays.
- Use `MemoryRouter` + `createMemoryHistory` (already used in
  `project-route.test.tsx`).
- Use `data-testid` attributes consistent with existing audits
  (`quick-switcher-input`, `quick-switcher-row-{name}`,
  `top-bar-project-name`, `welcome-tile-{name}`).

Suites:

1. `quick-switcher.test.tsx`
   - Cmd+P opens overlay; Esc closes.
   - Typing filters list (fuzzy on `name + dir`).
   - ↑/↓/Enter navigate then push `/v2/project/:name`.
   - Cmd+Backspace prompts then calls DELETE.
   - "Add project…" pushes `/v2/setup`.
   - Editable-target guard: typing in a focused `<input>` does *not*
     open the overlay.

2. `welcome-route.test.tsx`
   - Renders recent + all groups from mock fixtures.
   - Tile click → push `/v2/project/:name`.
   - Per-row menu → DELETE confirm flow.
   - "Create" → `/v2/setup`.

3. `top-bar.test.tsx`
   - Hidden on `/` and `/v2/setup`.
   - Visible on `/v2/project/:name` and reflects the current project
     name + branch.
   - Click → opens the same overlay that Cmd+P opens.

4. `projects-store.test.ts`
   - Merge logic: `running` flag joined correctly when names match.
   - `recordOpened` bumps localStorage and re-sorts.
   - WS frame `projects.changed` triggers refetch.

E2E (Playwright, `dashboard/e2e/`): one smoke spec that boots a
fake daemon (existing `e2e/sse.ts` helper) with two registered
projects, presses Cmd+P, picks one, asserts the URL changed to
`/v2/project/:name`.

---

## 4. Out of scope (deliberate)

- Consolidating `/api/projects` and `/api/workspaces`. Track as a
  follow-up — the switcher will use `/api/projects` only.
- Multi-window switching (opening two projects side-by-side).
- Drag-reorder of the welcome tiles (opencode does this; we can defer).
- Project tags / colour labels (emdash has these — nice-to-have, not
  blocking the three surfaces).

## 5. Risks

- **Cmd+P collisions.** Many editors map Cmd+P to "go to file". If
  Monaco binds Cmd+P inside the editor surface, our installer is
  bypassed (`isEditableTarget` filters textareas/inputs, but Monaco
  is neither). Plan: check `event.target.closest("[data-monaco-editor]")`
  in `chrome.ts` and let Monaco win when it has focus.
- **Two registries diverging.** If a workspace was added via
  `/api/workspaces` but never registered via `/api/projects`, the
  switcher won't see it. Phase 0 commits to `/api/projects` only;
  call this out in the welcome empty state ("Don't see your project?
  Run `tmux-ide` once in the directory to register it.").
- **`App.tsx` becomes load-bearing.** Right now it's intentionally
  bare. Phase 2 + 4 add a `<QuickSwitcher>` + `<TopBar>` plus a
  small `createContext` for the current project name. Keep both
  components lazy-mounted (already the pattern for `ProjectV2Route`)
  so the welcome route stays light.
