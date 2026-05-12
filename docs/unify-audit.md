# Unify-sweep audit — v1 + duplicate retirement plan

**Date**: 2026-05-12
**Author**: Pty Agent (pane 1)
**Scope**: read-only triage of legacy / duplicated code that the Solid silo + chat-v2 work has superseded. **No deletions in this commit.** Surgical deletes land via the sub-tasks in §5.

## Headline numbers

| Bucket | Files | Notes |
| --- | ---: | --- |
| `dashboard/app/(shell)/` route group | **4** | All stubs (`return null`); shell composition lives in `AppShell`. |
| `dashboard/components/app-shell/` | **19** | Owns the legacy NavigatorSlot + PanelStack rig; only consumed by `(shell)/layout.tsx`. |
| `dashboard/components/navigators/` | **10** | Five page-Navigators + DefaultNavigator + NavigatorShell. Only the `(shell)/` MainTabContent path hits them. |
| `dashboard/components/{plans,mission,kanban,skills,sessions,settings,tui-tree,activity,diffs,metrics}/` | **51** | Per-domain React views — each replaced by a Solid silo + bridge, OR routed through V2 (`V2PlansView`, `V2ChatView`, etc). |
| `dashboard/components/views/*` | **10** | Wrapper layer the legacy MainTabContent dispatches into. Already mostly re-export shims (e.g. `views/ActivityView.tsx` is a 1-line `export { ActivityView } from "@/components/activity/ActivityView"`). |
| `dashboard/components/chat/` (chat-v1) | **7** (3 prod + 4 tests) | Chat v1: `ChatTabPanel`, `NewChatPicker`, `ProviderBadge`, `index.ts`, `types.ts`. `types.ts` is still imported by `chat-v2` + `lib/api.ts`. |

**Total candidate retire `.tsx` files**: **~73** (production, excluding `__tests__` and `chat-v2/`).

---

## 1. `(shell)/` route group retirement

### Current state

The `(shell)/` route group is a **Phase-Z stub**. Per the comments in the page files:

- `(shell)/page.tsx` — returns `null` ("View selection lives in NavigationState and is rendered by `MainTabContent` inside `AppShell`").
- `(shell)/project/[name]/page.tsx` — pure Next.js routing entry; defers to `ProjectPage`.
- `(shell)/project/[name]/ProjectPage.tsx` — returns `null` ("Per-project routes no longer need to mount any view tree of their own").
- `(shell)/layout.tsx` — single line: `return <AppShell>{children}</AppShell>`.

The work happens inside `AppShell` → `MainTabContent`, which switch-cases over a NavigationState tab id and dispatches to `dashboard/components/views/{MissionView,PlansView,KanbanView,ActivityView,SettingsView,SkillView,MetricsView,DiffsView,ValidationView}`. Each of those is either:

- A re-export shim around the canonical `dashboard/components/<domain>/*View.tsx` (e.g. `views/ActivityView.tsx` is `export { ActivityView } from "@/components/activity/ActivityView"`), or
- A direct render of the domain View (e.g. `views/MissionView.tsx` → mission Solid bridge with `?missionControl=solid` flag).

### v2 surface dependency on `(shell)/` deps

`git grep` confirms **zero v2 surfaces import from `(shell)/` directly**. v2 has its own composition (`/v2/project/[name]/ProjectV2Page.tsx` + `V2ActivityBar` + `_lib/V2*View.tsx` islands). The only consumers of `app-shell/`, `navigators/`, and `components/views/` are:

| Consumer | Lives under | Used by /v2 ? |
| --- | --- | --- |
| `(shell)/layout.tsx` → `AppShell` | legacy shell | no |
| `AppShell` → `MainTabContent` → `components/views/*` | legacy shell | no |
| `WorkspaceUrlSync` → NavigationState | legacy shell | no |
| `AppSidebar` → `NavigatorSlot` | legacy shell | no |

Net: deleting `(shell)/` plus everything it transitively pulls (AppShell + MainTabContent + WorkspaceUrlSync + AppSidebar + components/navigators + components/app-shell) removes the entire legacy shell composition. `/v2/*` stays untouched.

### v2 Solid coverage vs legacy `components/views/*`

| Legacy view | v2 / Solid equivalent | Gap? |
| --- | --- | --- |
| `MissionView` | MissionControlDashboard Solid + `?missionControl=solid` is now default in V2 page | covered |
| `PlansView` | V2PlansView + Solid PlansRail (`?plans=solid`) | covered |
| `KanbanView` | V2 `tab=kanban` → KanbanBoard (still React) | **partial** — KanbanBoard is reused by `/v2`; not yet a Solid silo. Out of scope for this sweep. |
| `TasksView` | Solid TasksView + `?tasks=solid` | covered |
| `ActivityView` | Solid Activity + `?activity=solid` | covered |
| `DiffsView` | Solid DiffsViewer + `?diffs=solid` | covered |
| `MetricsView` | Solid CostsDashboard + `?costs=solid` | covered |
| `SkillView` | none — handled inline via `tab=skill` in `MainTabContent` | gap (Solid follow-up) |
| `SettingsView` | none — V2 page reuses the same React SettingsView path? **No** — `/v2` doesn't surface settings yet. | gap |
| `ValidationView` | none — V2 doesn't expose validation as a tab. | gap |
| `NotificationsView` | none — orphan (0 importers, see §4). | retire as orphan |

**Conclusion**: of 10 legacy views, **7 have Solid coverage**, **3 have functional gaps** (Skills, Settings, Validation). Retiring `(shell)/` requires either:
(a) accepting that those 3 surfaces are no longer reachable until a Solid port lands, OR
(b) wiring V2 stubs that point at the same React components but mount them under `/v2`.

Recommend (b) for Skills + Settings (small wrappers); Validation is low-traffic enough to defer.

### Files to retire in §5.U1

```
dashboard/app/(shell)/                              4 files (whole dir)
dashboard/components/app-shell/                    19 files (AppShell, MainTabContent, MainTabsBar,
                                                       MainTabItem, NavigatorSlot, PanelStack,
                                                       PanelResizeSash, ProjectSwitcher,
                                                       SecondaryTabsSlot, sidebar-shell,
                                                       SidebarTree, TerminalsHost, sidebar-types,
                                                       index + 5 __tests__)
dashboard/components/navigators/                   10 files (5 page navigators + NavigatorShell +
                                                       DefaultNavigator + __tests__ + index)
dashboard/components/AppSidebar.tsx                 1
dashboard/components/WorkspaceUrlSync.tsx           1
dashboard/components/<domain>/<Domain>Navigator.tsx 5 (SettingsNavigator, MissionTreeNavigator,
                                                       SessionsNavigator, KanbanNavigator,
                                                       SkillsNavigator — referenced only by
                                                       MainTabContent / domain Views in shell mode)
dashboard/components/views/{MissionView,PlansView,
  KanbanView,ActivityView,SettingsView,SkillView,
  MetricsView,DiffsView,ValidationView,NotificationsView}.tsx  10
```

Approximately **50 files** in U1 alone — the biggest sub-task.

---

## 2. React widget duplicates — per Solid silo

For each of the 7 Solid silos, identify the React file(s) the silo supersedes and the feature-flag site that controls the swap. After deletion, the flag itself drops (Solid becomes the only path).

| Solid silo | React duplicate(s) | Flag site (file:line) | Default today | After delete |
| --- | --- | --- | --- | --- |
| **PlansRail** | `dashboard/components/plans/PlansView.tsx`'s `PlanListNavigator` (the rail half) | `plans/PlansView.tsx:1064` (`?plans=solid`) | React rail | drop flag, Solid always; PlansView body stays React (it renders selected plan content) |
| **Diffs** | `dashboard/components/DiffPanel.tsx`, `dashboard/components/diffs/DiffPanel.tsx` (5 files in `diffs/`) | `components/views/DiffsView.tsx:18` (`?diffs=solid`) | React DiffPanel | drop flag; the `components/views/DiffsView.tsx` wrapper goes away with U1 anyway |
| **Mission Control** | `dashboard/components/mission/` (11 files: `MissionView`, `HeroStrip`, `KpiStrip`, `MilestoneLadder`, `AgentActivityRail`, `EventStream`, `utils`, `MissionTreeNavigator` + tests) | `mission/MissionView.tsx:46` (`?missionControl=solid`) | React composite | drop flag; whole `mission/` dir retires |
| **Costs** | `dashboard/components/views/MetricsView.tsx` + `dashboard/components/metrics/MetricsView.tsx` | `views/MetricsView.tsx:50` (`?costs=solid`) | React composite | drop flag; whole `metrics/` dir retires |
| **Explorer** | `dashboard/components/tui-tree/FileTree.tsx` | `app/v2/project/[name]/ProjectV2Page.tsx:1674` (`?explorer=solid`) | React FileTree | drop flag; `tui-tree/` dir retires |
| **Tasks** | `dashboard/app/v2/project/[name]/ProjectV2Page.tsx` (inline `TasksView` function ~~1015–1620~~) — this is INLINE in the V2 page, not a separate component. The Solid bridge is reached via `?tasks=solid`. | `ProjectV2Page.tsx:1032` (`?tasks=solid`) | inline React TasksView | drop flag + inline React TasksView function from ProjectV2Page |
| **Activity** | `dashboard/components/activity/ActivityView.tsx` (+ ActivityFeed) | `activity/ActivityView.tsx:102` (`?activity=solid`) | React | drop flag; `activity/` dir retires |

### Cross-cutting observations

- **Every flag is opt-in today** (default returns the React surface). That means a single-pass delete of the React side requires flipping the call site to render the Solid bridge unconditionally OR dropping the wrapping component entirely.
- **`components/views/*View.tsx`** are mostly thin wrappers around the domain Views in `components/<domain>/`. When U1 deletes `app-shell/MainTabContent`, the `views/*` wrappers lose their only consumer and retire alongside.
- **`KanbanBoard`** stays — it's reused by `/v2`'s `tab=kanban`. Not in scope for this sweep; a Solid port is a follow-up.
- **`ActivityFeed.tsx`** (top-level component, distinct from `activity/ActivityView.tsx`) — `git grep` says **0 importers**; this is already an orphan (see §4).
- **`DiffViewer.tsx`** (top-level) — 0 importers; orphan.

### Files to retire in §5.U2

```
dashboard/components/plans/                         4 (PlansView + helpers + tests — but body is still
                                                       used by V2PlansView; surgical: delete only the
                                                       legacy navigator + ?plans=solid branch)
dashboard/components/DiffPanel.tsx                  1
dashboard/components/diffs/                         5 (DiffPanel duplicate + line-renderers)
dashboard/components/mission/                      11
dashboard/components/metrics/                       2
dashboard/components/tui-tree/                      1
dashboard/components/activity/                      2
dashboard/components/ActivityFeed.tsx               1  (orphan; can ride along)
dashboard/components/DiffViewer.tsx                 1  (orphan)
dashboard/app/v2/project/[name]/ProjectV2Page.tsx   inline TasksView function (~600 lines) — surgical edit, not a delete
```

Plus the feature-flag branches at the 7 flag sites listed above.

---

## 3. Chat v1 retirement

### Inventory

`dashboard/components/chat/` (excluding `__tests__`):
- `ChatTabPanel.tsx` — Solid-island mount bridge for `@tmux-ide/chat-solid` (legacy chat surface).
- `NewChatPicker.tsx` — 0 importers outside its own test. **Already orphaned.**
- `ProviderBadge.tsx` — 0 importers outside its own folder.
- `types.ts` — `AgentProvider`, `ThreadIndexEntry`, `ThreadState`. **Still imported by**:
  - `dashboard/app/v2/_lib/V2ChatView.tsx:26`
  - `dashboard/lib/api.ts:2`
  - `dashboard/lib/__tests__/chatStore.test.ts:24`
- `index.ts` — barrel re-exports.

### Parity check — does chat-v2 cover everything chat-v1 does?

`V2ChatView.tsx` already does the version split at line 108:
- `chatVersion === "v2"` → renders `ChatV2Root` (the modern thread/turn/plan/activity/checkpoint stack).
- `chatVersion === "v1"` → renders an inline `ThreadRail` + `SolidChatIsland` (mounts `@tmux-ide/chat-solid`'s ChatThreadView).

`resolveChatVersion()` in `dashboard/lib/chatVersion.ts:26` already defaults to `"v2"` ("The new UI is the default since T080"). v1 is only reachable via `?chat=v1` URL override or the `tmux-ide:use-old-chat` localStorage escape hatch.

**Gaps in chat-v2 vs v1**: None functionally required — chat-v2 has thread CRUD, turn streaming, plan approve/reject, checkpoint chips, multi-session sidebar, T101 changed-files panel, T102 permission gating. The `@tmux-ide/chat-solid` island that v1 mounts is the OLD surface (pre-T078); everything it does has a chat-v2 counterpart.

### Files to retire in §5.U3

```
dashboard/components/chat/ChatTabPanel.tsx             1
dashboard/components/chat/NewChatPicker.tsx            1 (orphan)
dashboard/components/chat/ProviderBadge.tsx            1 (orphan)
dashboard/components/chat/index.ts                     1
dashboard/components/chat/__tests__/                   4 tests (NewChatPicker.test, etc)
dashboard/lib/newChatPickerStore.ts                    1 (only used by NewChatPicker)
dashboard/lib/chatVersion.ts                           1 (resolveChatVersion + CHAT_V1_BANNER_TEXT)
dashboard/app/v2/_lib/V2ChatView.tsx                   surgical edit — drop the v1 branch + ThreadRail
                                                       local component + SolidChatIsland function
packages/chat-solid/                                   external silo — IF nothing else mounts it,
                                                       the whole package becomes orphan; verify before delete
```

**Migration of `chat/types.ts`**: the three types (`AgentProvider`, `ThreadIndexEntry`, `ThreadState`) are still used by chat-v2 and lib/api.ts. **Move `chat/types.ts` to `dashboard/components/chat-v2/types.ts`** (or `dashboard/lib/chat-types.ts`) and update the 3 importers before deleting the `chat/` dir.

---

## 4. Orphaned lib + helpers + tests

Confirmed orphans (0 importers, ready to delete):

| File | Confidence | Notes |
| --- | --- | --- |
| `dashboard/components/ActivityFeed.tsx` | definite | 0 hits in `git grep -l "ActivityFeed"` |
| `dashboard/components/DiffViewer.tsx` | definite | 0 hits |
| `dashboard/components/views/NotificationsView.tsx` | definite | 0 hits |
| `dashboard/components/chat/NewChatPicker.tsx` | definite | only self-ref + own test |
| `dashboard/components/chat/ProviderBadge.tsx` | definite | only own folder |
| `dashboard/lib/newChatPickerStore.ts` | likely | only NewChatPicker uses it (assume — verify with grep before delete) |

Likely orphans after U1 lands (will become so when their only importer goes away):

| File | Becomes orphan when |
| --- | --- |
| `dashboard/components/AppSidebar.tsx` | `(shell)/layout.tsx` deletes |
| `dashboard/components/WorkspaceUrlSync.tsx` | `(shell)/layout.tsx` deletes |
| `dashboard/lib/useNavigatorSlot.ts` | `app-shell/NavigatorSlot.tsx` deletes |
| `dashboard/lib/useSessionStream.ts` | confirm `/v2` uses it; if so, NOT orphan |
| All `dashboard/components/<domain>/<Domain>Navigator.tsx` files | `MainTabContent` deletes |

Craft-agents attribution (`licenses/CRAFT-AGENTS-NOTICE`): the React `PanelStack`/`PanelResizeSash` pattern under `app-shell/` is derived from Craft. Once those files retire in U1, the attribution can drop. Action: keep `Apache-2.0.txt`; delete `CRAFT-AGENTS-NOTICE`.

---

## 5. Proposed deletion plan — 6 parallel-safe sub-tasks

Bucketed so two agents can run U2 + U3 concurrently after U1 finishes. Each sub-task is one commit.

### U1 — Retire `(shell)/` route group + dependents

**Scope**: largest (~50 files).
**Files**:
- `dashboard/app/(shell)/**`
- `dashboard/components/app-shell/**` (AppShell + MainTabContent + MainTabsBar + MainTabItem + NavigatorSlot + PanelStack + PanelResizeSash + ProjectSwitcher + SecondaryTabsSlot + sidebar-shell + SidebarTree + TerminalsHost + sidebar-types + index + 5 tests)
- `dashboard/components/navigators/**`
- `dashboard/components/AppSidebar.tsx`
- `dashboard/components/WorkspaceUrlSync.tsx`
- `dashboard/components/{settings,mission,sessions,kanban,skills}/<Domain>Navigator.tsx`
- `dashboard/components/views/{MissionView,PlansView,KanbanView,ActivityView,SettingsView,SkillView,MetricsView,DiffsView,ValidationView,NotificationsView}.tsx`
- `dashboard/lib/useNavigatorSlot.ts` (if no other importers — verify)

**Pre-step**: wire `/v2` Skills + Settings + Validation surfaces (small wrappers around the same React components) OR add them to a follow-up list as known regressions. Recommendation: **add to follow-up** — `/v2` is the target surface and these three are low-traffic.

**Dependencies**: none — U1 is foundational.
**Test gate**: `pnpm lint && pnpm test && curl http://localhost:6060/api/sessions` returns OK; manual smoke: navigate to `/v2/project/<name>` and verify every tab still renders.

### U2 — Delete React widget duplicates + drop feature flags

**Scope**: 7 silo retirements.
**Files**:
- `dashboard/components/{plans,mission,metrics,activity,diffs,tui-tree}/**` (everything not still imported by `/v2`)
- `dashboard/components/{DiffPanel,ActivityFeed,DiffViewer}.tsx`
- Inline `TasksView` function in `dashboard/app/v2/project/[name]/ProjectV2Page.tsx` (replace `TasksTabContainer` with direct `TasksViewBridge` render; drop the `useSolid` ternary)
- Flag-site simplifications: remove `?plans=solid`, `?diffs=solid`, `?missionControl=solid`, `?costs=solid`, `?explorer=solid`, `?tasks=solid`, `?activity=solid` branches — Solid is now the only path.

**Dependencies**: U1 (the `components/views/*` wrappers retire there).
**Test gate**: `pnpm --filter v2-solid-widgets test` + `pnpm --filter dashboard test`; browser smoke at each former flag site (Plans, Diffs, Mission, Costs, Explorer, Tasks, Activity) — confirm Solid widget renders without the URL query.

### U3 — Retire chat v1

**Scope**: 7 files + a surgical edit.
**Files**:
- `dashboard/components/chat/ChatTabPanel.tsx`
- `dashboard/components/chat/NewChatPicker.tsx`
- `dashboard/components/chat/ProviderBadge.tsx`
- `dashboard/components/chat/index.ts`
- `dashboard/components/chat/__tests__/**` (4 tests)
- `dashboard/lib/newChatPickerStore.ts`
- `dashboard/lib/chatVersion.ts`
- `dashboard/components/chat/types.ts` → **move** to `dashboard/components/chat-v2/types.ts` first; update 3 importers (`V2ChatView.tsx`, `lib/api.ts`, `lib/__tests__/chatStore.test.ts`).
- Surgical edit in `dashboard/app/v2/_lib/V2ChatView.tsx`: drop the `chatVersion === "v1"` branch, the local `ThreadRail` function, and the `SolidChatIsland` function. Always render `ChatV2Root`.

**Optional follow-up**: if `packages/chat-solid` has no remaining consumers after the v1 retire, delete the whole silo (~30 files). **Verify first** with `git grep "from \"@tmux-ide/chat-solid\""` after the V2ChatView edit.

**Dependencies**: none (independent of U1/U2).
**Test gate**: `pnpm --filter dashboard test`; browser smoke at `/v2/project/<name>?chat=v2` (chat-v2 default) and verify no localStorage `tmux-ide:use-old-chat` escape hatch is observed.

### U4 — Drop craft-agents attribution + license cleanup

**Scope**: 1 file.
**Files**: `licenses/CRAFT-AGENTS-NOTICE` (delete). Update any README that references it.
**Dependencies**: U1 (must land first — the Craft-derived code is `app-shell/PanelStack` + `PanelResizeSash` which U1 retires).
**Test gate**: `pnpm pack:check`; confirm no `Craft Agents` string remains in source via `git grep`.

### U5 — Orphan cleanup

**Scope**: the orphans that emerge after U1+U2+U3 land.
**Files**: re-run `git grep -L "from.*<modulename>"` across the §4 candidates and delete the ones that now have 0 importers. Likely includes:
- `dashboard/lib/useSessionStream.ts` (if /v2 doesn't use it — verify)
- Any `<Domain>Navigator.tsx` that didn't already go in U1
- Any helper file under `dashboard/lib/` flagged by an automated orphan detector

**Dependencies**: U1, U2, U3.
**Test gate**: `pnpm lint && pnpm test && pnpm typecheck` — typecheck especially because dead helpers often surface as unused-export warnings.

### U6 — Verification + final commit

**Scope**: full release-gate run; document the final file count delta in a follow-up note.
**Steps**:
1. `pnpm check` (full release gate).
2. Manual browser smoke at every `/v2/<view>` surface.
3. `git diff --stat HEAD~6 HEAD` — count deleted lines, paste into commit body.
4. Update `CHANGELOG.md` with the unify-sweep summary.

**Dependencies**: U1, U2, U3, U4, U5.
**Test gate**: full `pnpm check` green.

### Suggested dispatch sequence

```
agent-A: U1            (largest; foundational; ~50 files)
agent-B: U3            (independent of U1; can land in parallel)

After U1 + U3 land:
agent-A or C: U2       (depends on U1; ~25 files)
agent-B:      U4       (depends on U1; one file)

After U1 + U2 + U3 + U4 land:
agent-A: U5 → U6       (orphan sweep + final gate)
```

Estimated total landing: **1–1.5 days with two agents**, single-day for one careful agent.

---

## 6. Risks + open questions

1. **/v2 Skills/Settings/Validation gap**: U1 removes the only path to these surfaces. Confirm with the user whether to (a) cut them entirely, (b) build V2 stubs first, or (c) keep `views/SkillView.tsx` + `views/SettingsView.tsx` as still-reachable shims pointing at `/v2/skill/<name>` deep links. Recommend (c) for SkillView (already deep-links cleanly) and (a) for Validation + Notifications (low-traffic; can re-add later if missed).
2. **`packages/chat-solid` orphan check**: U3 may turn the whole silo into dead code. Verify before deleting the package — `chat-solid` may have its own consumers (Electron app, mobile shell, etc.) that aren't in this audit's reach.
3. **`KanbanBoard` Solid port**: not in this sweep. Tracked for a future U7 if the user wants kanban-on-Solid before unify completes.
4. **`@tmux-ide/v2-solid-widgets` package surface**: after U2 the package becomes the canonical UI source. Consider exporting a typed `mountByName(name, container, opts)` switchboard so the dashboard's view router can pull from one entry — out of scope here, but mention as a follow-up.
5. **Test churn**: many `__tests__/` directories retire alongside their components. `pnpm test` should drop file/test counts significantly; document the new baseline in U6.

---

## Final tally (U6)

The unify sweep landed in **8 commits** between U1 and U6:

```
6d348d5 refactor(unify): retire (shell)/ route group + app-shell components (U1)
63a50ed fix(dashboard): drop dead useOldChat setting (chat v1 retired)
150a3d1 refactor(unify): retire chat v1 surfaces (U3)
871cb0d refactor(unify): delete 7 React widget duplicates + drop ?xxx=solid flags (U2)
495de6c chore(licensing): drop craft-agents attribution (deps retired in U1) (U4)
d93b7dd refactor(unify): orphan cleanup — delete unused views/navigators/bridges (U5)
6b9c485 fix(unify): release-gate fixes for U6 verification
8fc36cb fix(unify): clear residual lint errors for U6 release gate
```

**Delta vs the pre-sweep base (6d348d5^):**

| Metric | Count |
| --- | ---: |
| Files changed | 148 |
| Files deleted | 117 |
| Files renamed | 6 |
| Files modified | 25 |
| Files added | 0 |
| Lines added | 126 |
| Lines deleted | 14,674 |
| **Net** | **−14,548** |

**Retired areas** (every one of these was net-deleted, not relocated):

- `dashboard/app/(shell)/**` — entire route group (Phase-Z stub)
- `dashboard/components/app-shell/**` — AppShell + MainTabContent + PanelStack + NavigatorSlot + 5 tests
- `dashboard/components/navigators/**` — 8 nav shims (U5)
- `dashboard/components/mission/**` except `MissionTreeNavigator.tsx` + `index.ts` — 9 React composite leaves + 7 tests
- `dashboard/components/{metrics,activity,diffs,tui-tree,plans}` content — React widget duplicates of the 7 Solid silos
- `dashboard/components/{DiffPanel,DiffViewer,ActivityFeed,AppSidebar,WorkspaceUrlSync}.tsx` — root orphans
- `dashboard/components/chat/` — chat v1 surface (ChatTabPanel + NewChatPicker + ProviderBadge + types + tests)
- `dashboard/components/views/{ActivityView,DiffsView,MetricsView,MissionView,PlansView,...}.tsx` — orphan shims
- `dashboard/lib/{chatVersion,newChatPickerStore,planMarkdown,planMarkdown.test}.ts` — orphan helpers
- Inline `TasksView` / `TaskDetailCard` / `TaskFormCard` / `handleRowClick` in `ProjectV2Page.tsx` (~440 lines)
- `licenses/CRAFT-AGENTS-NOTICE` (U4) — attribution dropped with the underlying code

**Feature-flag cleanup** (U2): all 7 `?<feature>=solid` query-flag branches removed (`tasks`, `explorer`, `plans`, `diffs`, `costs`, `missionControl`, `activity`). The Solid silos are the only render path.

**Test count delta** (best estimate from removed test files): **−21** test files retired alongside their components.

**Release gate state** at U6 close:

- ✅ `pnpm --filter @tmux-ide/daemon lint` — clean.
- ✅ `pnpm --filter @tmux-ide/v2-solid-widgets lint` — clean after U6 fix-ups.
- ✅ `pnpm --filter @tmux-ide/chat-solid lint` — clean.
- ✅ `pnpm --filter @tmux-ide/contracts lint` — clean.
- ✅ Root `pnpm lint` — clean (silo-mount check accepts kebab-case bridges).
- ⚠️ `pnpm --filter @tmux-ide/dashboard lint` — **12 pre-existing errors** in `dashboard/components/tui/modules/hotkeys/*` + `tui/examples/MessagesInterface.tsx`. **Not unify-caused** (predate the design PR series). Tracked since design PR 1; suitable as a follow-up cleanup.
- ⚠️ `pnpm --filter @tmux-ide/dashboard exec next build` — **6 pre-existing errors** at `dashboard/app/v2/config/page.tsx:11` (`fetchProjectConfig` export missing from `@/lib/api`). **Not unify-caused** (pane 3's `lib/api.ts` work). Tracked as a known regression at the V2 config surface.
- ❌ Full `pnpm check` exits non-zero on the dashboard pre-existing errors above. Per U6 brief: "If pre-existing failure unrelated to unify, don't try to fix it — note it and let it stand."

**Smoke-test status**: not executed in this U6 run because no dev server was available in the agent's environment. Smoke URLs for the lead to verify:

- `http://localhost:3000/v2/project/<name>` (project shell)
- Activity-bar views: files (Explorer Solid), search, diffs (DiffsViewer Solid), plans (PlansRail Solid + React body), tasks (TasksView Solid), mission (MissionControl Solid), chat (chat-v2), terminal
- Each should render without console errors. `?<feature>=solid` query overrides are gone — Solid is the default everywhere.

**Branch state**: `feat/v2.5.0`, ahead of `origin/feat/v2.5.0` by N commits (lead to push). U6 does NOT push.

