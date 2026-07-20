/**
 * The unified app (M17.2) — tmux as the engine, tmux-ide as the screen.
 *
 * Sidebar (live fleet, click to switch session) · window tab strip · pane
 * canvas at exact tmux geometry with full color/attribute fidelity, local
 * scrollback (wheel; ↑n/depth badge; any key snaps live), real SGR mouse
 * forwarding into panes whose app enabled mouse mode, 60fps-paced (8ms state tick + targetFps 60 paint)
 * rendering, ^o pane focus cycle, ^t window cycle, ^q quits (session
 * untouched) — except HOSTED (M23.2): launched by `tmux-ide app --detachable`
 * inside the internal `_tmux-ide-app` session (TMUX_IDE_HOSTED=1), ^q puts the
 * cockpit away and the app keeps running (switch-client -l back to where the
 * client came from, else detach); the palette's "Quit" verb remains the real
 * exit (ending the pane command ends the host session).
 *
 * SELECT MODE (M22.9): forwarding normally wins on app-mouse panes, so those
 * panes (exactly the agent panes users copy from) could never drag-select.
 * Right-click → "Select text…" (or the palette's "Select text in pane")
 * pauses forwarding for THAT pane — a ⧉ select badge joins the top-right
 * badge family, drags run the normal selection machine, the wheel scrolls the
 * LOCAL scrollback — until Escape, a completed copy, or focus leaving the
 * pane. A SHIFT-modified press selects without the mode where the terminal
 * passes shift through to us (SGR button+4; many terminals keep shift+drag
 * for native selection — measured: see the card notes).
 *
 * DRAG SELECTS ON AGENT PANES (M24.2): the implicit default now follows the
 * pane. Where the fleet's agent join (agentByPane) matches, a plain left
 * press is DEFERRED (`pendingPress`): motion off the press cell starts a
 * normal selection (the app sees NOTHING — no stray down), a release in
 * place forwards the owed SGR press/release pair (agents are click-driven).
 * Other app-mouse panes (vim/htop) forward as before. SHIFT inverts a pane's
 * default (so shift+drag on an agent pane forwards; on vim it selects, as in
 * M22.9); the right-click pane menu carries a per-pane session override; the
 * `app.dragSelect` policy ("agents"|"always"|"never", app-config) is read
 * once at boot. Wheel routing is UNTOUCHED (agent panes still forward the
 * wheel outside select mode); pure logic in selection.ts (paneDragDefault /
 * routePanePress).
 *
 * SELECTION SURVIVES SCROLLING (M25.6): mirror selections anchor in ABSOLUTE
 * xterm buffer lines (absLine = scrollbackDepth − scrollOffset + viewportRow),
 * not viewport cells — so scrolling mid-drag keeps the highlight on its text
 * and a selection can span many screens. While a drag is live the wheel over
 * the pane always scrolls the LOCAL scrollback (never forwarded, never cancels
 * — even on app-mouse panes), and holding the pointer at the pane's top/bottom
 * content row auto-scrolls ~1 row per 8ms state tick (clamped at the
 * scrollback top / the live bottom). The release copy extracts the FULL
 * absolute span straight from the pane's buffer (SessionMirror.extractText,
 * built capped so a runaway span never materializes unbounded — the 1 MB
 * clipboard cap still refuses over-limit selections). Buffer rotation at the
 * scrollback cap mid-drag is compensated via PaneMirror.lineTrim (the anchor
 * follows its content); both plain drags and M22.9/M24.2 select-mode /
 * shift / deferred-press entries share this machinery.
 *
 * SURFACE VIEWS (M18.4, configured in C05): a persistent top row makes the app a
 * real IDE. `.tmux-ide/workspace.yml` `app.views` supplies configured view IDs,
 * order, titles, and panel kinds; absent/broken config falls back to Home,
 * Terminals, Files, Diff, Missions. F1..F4 then F6..F13 switch by configured
 * position (F5 remains the palette; later views remain mouse/palette selectable); the tab bar is also
 * clickable with fixed x-span math from the same rendered labels. The active
 * hosted view ID is the source of truth; `mode()` is derived from its panel kind
 * (home|mirror|editor|diff|missions). CRITICAL for the IDE feel: switching AWAY
 * from Terminal does NOT
 * dispose the SessionMirror — it keeps streaming in the background (dirty flags
 * accumulate; a back-switch is instant); the editor buffer and diff selection
 * likewise survive tab round trips. One WORKSPACE CONTEXT per session
 * (`openWorkspace`): choosing a session on Home/sidebar/palette points the
 * terminal target AND the files/diff dir at it; the header shows the context
 * name. A command PALETTE (F5 / ^p, or clicking the tab bar's palette chip)
 * opens a centered overlay of fuzzy-filtered actions (switch tab / attach
 * session / open file / save / refresh diff / quit) — keyboard as before, and
 * (M21.9) mouse-complete: motion moves the selection, click runs the row, the
 * wheel scrolls the list, a press outside dismisses (geometry is pure math in
 * palette.ts, shared render/router). App state — { lastTab, contextSession,
 * openFile, diffFile } — persists to `~/.tmux-ide/app-state.json`
 * (TMUX_IDE_HOME override), debounced, restored on launch.
 *
 * PALETTE V2 (M24.4): the overlay renders ROWS (palette.ts's PaletteRow) —
 * an empty query groups "recent" (persisted usage in app-state's paletteUsage,
 * keyed by paletteActionKey so relabels keep history) · "suggested" (surface
 * verbs; BLOCKED agents' jumps first) · "commands"; a typed query is one flat
 * list ranked by the label-start-weighted fuzzy score with a frequency/recency
 * tie-break. Headers are inert rows: keyboard (stepPaletteRow) and the router
 * both skip them. Action rows right-align their app keycap (settings-model's
 * PALETTE_KEYCAPS — the keybind viewer's single source). ⌘K is a third opener
 * beside F5/^p, delivered ONLY under the kitty keyboard protocol: the renderer
 * requests it (useKittyKeyboard, app.kittyKeys config, default on), the stdin
 * parser maps CSI-u keys to the SAME names as legacy so pane re-encoding is
 * untouched, and ALL super-modified keys are consumed at the top of the key
 * handler (never typed into a query/prompt/editor, never forwarded — pane
 * forwarding of modifier-rich keys is card #83's scope).
 *
 * SETTINGS (M22.4): no settings screen — every setting is a palette COMMAND
 * ("Settings…" is the categorized umbrella) executed via three DIALOG
 * primitives on ONE global stack (dialog-stack.ts; pure model in
 * dialog-model.ts; the item lists/patches in settings-model.ts). One overlay
 * mount renders the stack top; the keyboard handler and `route` both check the
 * stack FIRST, so keys/clicks never leak beneath an open dialog; Escape and a
 * click outside pop ONE level. Persistence is the typed app-config layer
 * (atomic raw-merge writes, TMUX_IDE_CONFIG honored); the theme picker
 * live-previews the dialog chrome accent on cursor move (the app's other
 * surface colors are const RGBAs; chrome + widgets re-read config on their
 * next build — each dialog's footer says where a change lands).
 *
 * The main area is the HOME panel (fleet rows, then — M21.9 — the project
 * REGISTRY: registered-but-not-running projects as launchable rows; a row click
 * or enter spins up a detached session in the project dir and opens it; the
 * footer gains [n new session] and every row a right-aligned verb chip), a
 * session MIRROR (the
 * SessionMirror canvas), the built-in FILES tab (M18.2 editor + a one-level file
 * list; tmux stays the engine running servers/agents while files are edited
 * natively by us), or the git DIFF panel (M18.3 — the working-tree diff of the
 * workspace dir). `route` branches on `mode()` so a tab-bar click, a home-row
 * click, a pane click, a file-list/editor click, and a diff file-row click share
 * one entry point. A real `--target` starts on Terminal; bare restores the
 * persisted tab; `--edit <file>` opens Files; `--diff <dir>` opens Diff. On home,
 * `o` opens a path prompt, `d` opens the Diff tab for the selected session's dir.
 *
 * DIFF (M18.3; v2 M24.5): a two-column panel — left is the changed-file list
 * GROUPED into Staged / Unstaged / Untracked sections (counted headers are
 * non-selectable rows; an `MM` file appears in BOTH stage groups, each side
 * diffing its own half of the index), right is the unified diff of the selected
 * row (add/del/hunk/context colored, add/del lines carry background fills).
 * Git runs via ASYNC execFile ONLY (the landmine: no sync execs near the render
 * loop; the one exception is reading a single untracked file to show it as
 * additions). `git status --porcelain` + both `--numstat`s (per-file ± counts,
 * header totals) refresh on a 3s timer while mode=diff and on manual `r`.
 * j/k move the file selection (headers skipped — the row/selection math is the
 * shared buildDiffRows pass, the AGENTS_GAP_ROWS lesson); s/u stage/unstage the
 * selected file and S/U everything (reversible, so no confirms — each verb
 * notes what it did and follows the file into its new group); the footer verbs
 * and a selected/hovered row's [s stage]/[u unstage] chip are their span-routed
 * mouse twins; `/` filters the list live (escape clears — diff surface only,
 * Terminal's `/` scrollback search is untouched); ]/[ jump the diff view
 * between hunks; the wheel scrolls the diff (or the file list when over the
 * left column); a left-column click selects a file row; `^e` opens the selected
 * file in the EDITOR at the first changed line of the top-visible hunk (pure
 * hunk math from the `@@ -a,b +c,d` header). Pure parsing + grouping +
 * classification live in diff-model.ts (unit-tested).
 *
 * EDITOR (M18.2): the editing ENGINE is a native `EditBuffer` (bun:ffi —
 * insert/delete/cursor/undo, grapheme-aware). We do NOT mount OpenTUI's
 * `<textarea>` renderable: it owns its own mouse dispatch, which would hijack
 * events the app routes centrally and trip the late-mount landmine below. So we
 * render the viewport OURSELVES (gutter + text runs, cursor as an inverse span)
 * and drive the buffer from the central `useKeyboard`/`route` — same discipline
 * as the mirror. A `editorRev()` signal bumps after each mutation to re-derive
 * the line array (EditBuffer mutations are invisible to Solid). Pure math
 * (binary sniff, read-only class, gutter, viewport, click→cursor) is unit-tested
 * in editor-buffer.ts. `^s` saves atomically (temp+rename); files ≥1 MB or with
 * a NUL byte open read-only with a banner. Syntax highlighting is SKIPPED:
 * tree-sitter needs grammar wasm loaded + highlight→run mapping into our
 * hand-rolled render — far more than "one flag away".
 *
 * MOUSE ARCHITECTURE (hard-won): ALL pointer events are received by the two
 * top-level REGION CONTAINERS (sidebar box / main column box) and routed by
 * coordinate math (routeMouse) against geometry we render ourselves.
 * This design was DICTATED by three OpenTUI landmines measured on 0.1.x
 * (M17.2/M19.1). ALL THREE were re-measured on @opentui 0.4.3 (M21.2) with a
 * throwaway SGR-injection probe (late-mounted <For> boxes/text with and without
 * inline-arrow vs bare-ref onMouse handlers) and NONE still reproduce:
 *  1. `onMouse` on LATE-MOUNTED <For> nodes (children created AFTER initial
 *     render). 0.1.x: dispatch broke for hits on those nodes entirely, so
 *     handlers lived ONLY on always-present containers. 0.4.3: the late-node
 *     handler FIRES and the hit also bubbles to the ancestor (probe: clicking a
 *     late <For> box logged both `A0 down` AND `ROOT down`). FIXED.
 *  2. Event-prop values had to be INLINE ARROWS — a bare function reference was
 *     invoked as a reactive getter during prop wiring. 0.4.3: a bare `onMouse`
 *     ref is NOT called at wiring (no phantom event logged at mount) and fires
 *     correctly with a real event on click. FIXED.
 *  3. (M19.1 corollary) late-mounted <For> BOXES swallowed even handler-less
 *     hits while late <For> TEXT runs bubbled. 0.4.3: handler-less late boxes
 *     BUBBLE to the ancestor too (probe: clicking a late no-handler box logged
 *     `ROOT down`), matching text. FIXED.
 * We KEEP the central-routing architecture as-is: it is proven, correct, and
 * still the cheapest hit-test path (one coordinate math pass vs. per-node
 * dispatch); the upgrade only REMOVES the constraint that forced it. Retiring it
 * — moving handlers onto per-node <For> children, dropping the bare-ref rule —
 * is a real refactor, deferred to its own card, NOT part of the 0.4.3 bump.
 * Until then keep new handlers on the containers and prefer inline arrows.
 * Dynamic clickable strips still render as bare styled text runs hit-tested by
 * x-span math (`spans`) — the per-window strip is one text-run row, so segment
 * clicks land (^t still cycles). HOVER feedback rides the same path — every
 * region resolves a {region,index} on motion ("over"/"move", cleared on "out")
 * and tints the hovered row/segment with HOVER_BG.
 *
 * Fleet data arrives via an async `tmux-ide team --json` subprocess: the
 * in-process data layer is a synchronous exec chain that blocks the event
 * loop and eats input. Seeds are capped at 300 history lines for the same
 * reason (deeper seeds froze input for ~15s per attach).
 *
 * Run (repo-root bunfig preload):
 *   bun packages/daemon/src/tui/mirror/app.tsx              # home panel
 *   bun packages/daemon/src/tui/mirror/app.tsx --target <session>
 */
import { parseArgs } from "node:util";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { RGBA, EditBuffer, createCliRenderer, decodePasteBytes } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { SessionMirror, type LivePane } from "./session-mirror.ts";
import { registerPaneSurface, type PaneSearchHighlight } from "./pane-surface.tsx";
import { tapInputSent, tapInputTick } from "./perf-tap.ts";
import { installHostAutowrapGuard, type HostAutowrapGuard } from "./host-terminal.ts";
import { execFile, spawn } from "node:child_process";
import type { AgentStatus } from "../detect/classify.ts";
import { Sidebar } from "./sidebar.tsx";
import {
  ACCENT,
  BADGE_BG,
  DEFAULT_BG,
  DEFAULT_FG,
  HOVER_BG,
  MUTED,
  SIDEBAR_BG,
  TAB_ACTIVE_BG,
  createSemanticThemeStore,
} from "./theme.ts";
import { homeFooterHints, type FleetRollup } from "../team/home.ts";
import {
  isBinary,
  classifyFile,
  readOnlyBanner,
  sanitizeForDisplay,
  gutterWidth,
  formatGutter,
  clampTop,
  scrollToCursor,
  clickToCursor,
  type ReadOnlyReason,
} from "./editor-buffer.ts";
import {
  classifyDiff,
  untrackedDiffText,
  clampSel,
  parseStatusGroups,
  parseStatusPorcelain,
  // Both diff-model and file-tree export a `filterEntries`; alias the diff one
  // (merge of M24.5 + M24.6 — the two surfaces grew them independently).
  filterEntries as filterDiffEntries,
  buildDiffRows,
  rowIndexOfFile,
  parseNumstat,
  untrackedLineCount,
  applyCounts,
  totalCounts,
  nextHunkTop,
  hunkEditTarget,
  type DiffEntry,
  type DiffGroup,
  type DiffLineKind,
  type StatusEntry,
} from "./diff-model.ts";
import {
  loadAppState,
  saveAppState,
  addRecentFolder,
  addCustomCommand,
  recordPaletteUse,
  clampSidebarWidth,
  isTab,
  rememberSpawn,
  spawnMemoryKey,
  type AppState,
  type PaletteUsageEntry,
  type Tab,
} from "./app-state.ts";
import {
  expandUserPath,
  filterDirs,
  isPickerRoot,
  pathKindHint,
  pickerBreadcrumb,
  pickerDirName,
  pickerParent,
  pickerRows,
  PICKER_HIDDEN_ID,
  PICKER_OPEN_ID,
  PICKER_TYPE_ID,
  PICKER_UP_ID,
  type PathKind,
} from "./folder-picker.ts";
import { registerProject, ProjectAlreadyRegisteredError } from "../../lib/project-registry.ts";
import { resolveProjectConfigContext } from "../../lib/config-context.ts";
import { createProjectRuntimeRepository } from "../../lib/project-runtime-repository.ts";
import { separatorAt, resizedSize, resizeCommand, type Separator } from "./resize-model.ts";
import {
  effectiveWindowSize,
  detectSizeMismatchWithRepin,
  letterboxOffset,
  formatSizeHint,
  type RepinState,
  type Size,
} from "./size-truth.ts";
import {
  paletteRows,
  paletteActionKey,
  parseBufferList,
  palettePos,
  paletteRowAt,
  paletteContains,
  clampPaletteTop,
  type PaletteAction,
  type PaletteGeom,
  type TmuxBuffer,
} from "./palette.ts";
import {
  adaptPaletteRowsToCommands,
  appendPalettePaste,
  dispatchPaletteCommand,
  ensurePaletteSelectionVisible,
  firstEnabledPaletteCommandId,
  PaletteBufferLoadGate,
  restorePaletteActionLevelFromBuffers,
  stepEnabledPaletteCommandId,
} from "./palette-surface-adapter.ts";
import {
  PanelHostLoadGeneration,
  findHostedViewById,
  hostedActivationEffects,
  initialHostedSelection,
  isHostedPanelInert,
  legacyTabFromPanelKind,
  panelKindFromLegacyTab,
  panelMode,
  planHostedInitialActivation,
  planHostedReconciledActivation,
  planHostedViewActivation,
  viewsFromResolvedConfig,
  type HostedPanelKind,
  type HostedPanelView,
} from "./panel-host.ts";
import { ShellTabBar } from "./shell-chrome.tsx";
import { shellChromeLayout, shellSidebarHint, shellSurfaceTabSpans } from "./shell-chrome.ts";
import {
  projectWorkbenchShell,
  moveWorkbenchDockTab,
  workbenchShellHitTest,
  type WorkbenchDockMode,
  type WorkbenchDockTabId,
  type WorkbenchFocusZone,
} from "./workspace/workbench-shell.ts";
import { WorkbenchShell } from "./workspace/workbench-shell.tsx";
import {
  agentTerminalCanvasPointerPolicy,
  agentTerminalCanvasRouteX,
  projectAgentTerminalCanvas,
} from "./workspace/agent-terminal-canvas.ts";
import { AgentTerminalCanvas } from "./workspace/agent-terminal-canvas-view.tsx";
import {
  commandPaletteHitTest,
  projectCommandPalette,
} from "./workspace/command-palette-surface.ts";
import { CommandPaletteSurface } from "./workspace/command-palette-surface.tsx";
import {
  dispatchTerminalPaneChromePointerIntent,
  projectTerminalPaneChrome,
  reconcileTerminalPaneChromeActionTarget,
  terminalPaneChromeMotionState,
  terminalPaneChromePointerIntent,
  type TerminalPaneChromeActionTarget,
  type TerminalPaneChromeHoverTarget,
  type TerminalPaneChromeMetadata,
} from "./workspace/terminal-pane-chrome.ts";
import { TerminalPaneChromeLayer } from "./workspace/terminal-pane-chrome-view.tsx";
import {
  resolveWorkbenchPasteTarget,
  workbenchCanvasPanelForShortcut,
  workbenchCanvasShortcutForPanel,
  workbenchDockTabForShortcut,
} from "./workspace/workbench-controller.ts";
import {
  MissionWorkspaceLoader,
  clipTerminal,
  defaultMissionWorkspaceModel,
  invalidatedMissionWorkspaceLoadState,
  missionModelFromWorkspaceState,
  missionSelectionFromWorkspaceState,
  missionTmuxPanePreflightMatches,
  missionTmuxPreflightCommands,
  readMissionWorkspace,
  reconcileMissionWorkspaceModel,
  resolveMissionDeepLink,
  workspaceStateWithMissionModel,
  workspaceStateWithMissionSelection,
  type MissionDeepLinkKind,
  type MissionDeepLinkResolution,
  type MissionWorkspaceLoadState,
  type MissionWorkspaceModel,
  type MissionWorkspaceSnapshot,
} from "./missions-workspace.ts";
import {
  missionDashboardHitTest,
  missionDashboardMainSize,
  missionDashboardProjection,
} from "./missions-dashboard.ts";
import { MissionsSurface, missionSurfaceLayout } from "./missions-surface.tsx";
import { HomeSurface, homeActionAtProjection } from "./home-surface.tsx";
import {
  homeItemIndexAtProjection,
  projectHomeSurface,
  type HomeActionId,
} from "./home-surface.ts";
import { FilesSurface } from "./files-surface.tsx";
import { filesHitTest, filesListWidth, projectFilesSurface } from "./files-surface.ts";
import { ChangesSurface } from "./changes-surface.tsx";
import {
  changesBodyRows,
  changesHitTest,
  changesListWidth,
  projectChangesSurface,
  type ChangesActionId,
} from "./changes-surface.ts";
import type { FilesActionId } from "./files-surface.ts";
import {
  activityOrderSequence,
  activityRowHitTest,
  orderActivityRows,
  projectActivitySurface,
  type ActivityRowDto,
} from "./activity-surface.ts";
import { ActivitySurface } from "./activity-surface.tsx";
import {
  handleMissionSurfaceKey,
  handleMissionSurfacePointerDown,
  handleMissionSurfaceScroll,
} from "./missions-surface-controller.ts";
import {
  TuiCleanupRegistry,
  createTuiLifecycleExecutor,
  executeCtrlCCommand,
  resolveCtrlCCommand,
  resolveInputLayer,
  resolveQuitLifecycleCommand,
} from "./input-lifecycle.ts";
import {
  RENDERER_COMMAND_IDS,
  createRendererCommandExecutor,
  rendererCommandInvocation,
  rendererInvocationForCanvas,
  rendererInvocationForDock,
  rendererInvocationForGlobal,
  rendererInvocationForLifecycle,
  rendererInvocationForView,
} from "./renderer-commands.ts";
import {
  WorkspaceUiStateController,
  absoluteProjectPath,
  chooseInitialWorkspaceView,
  defaultWorkspaceUiState,
  loadWorkspaceUiState,
  relativeProjectPath,
  serializeWorkspaceUiState,
  setWorkspaceDockState,
  setWorkspaceSurfaceState,
  shouldHydrateWorkspaceView,
  viewStateFor,
  type WorkspaceUiStateV2,
  type WorkspaceSurfaceStates,
} from "./workspace-ui-state.ts";
import {
  DIALOG_ROWS,
  dialogPos,
  dialogHeaderRows,
  dialogRowAt,
  dialogContains,
  dialogInnerW,
  dialogMarker,
  dialogRowText,
  selectFooter,
  promptFooter,
  confirmFooter,
  confirmOptions,
  wrapText,
  type DialogGeom,
  type DialogSelectSpec,
  type DialogPromptSpec,
  type DialogConfirmSpec,
} from "./dialog-model.ts";
import {
  dialogStack,
  dialogKey,
  DialogSelect,
  DialogPrompt,
  DialogConfirm,
} from "./dialog-stack.ts";
import {
  HINT_CHROME_RESTART,
  HINT_LIVE,
  HINT_READOPT,
  delaySecondsPatch,
  keybindingItems,
  notificationItems,
  notificationTogglePatch,
  presetRgb,
  quietHoursItems,
  quietHoursOffPatch,
  quietHoursPatch,
  resetSettingsPatch,
  soundItems,
  soundPatch,
  validateDelaySeconds,
  restoreItems,
  restorePatch,
  settingsRootItems,
  snapshotEveryPatch,
  themeItems,
  themePatch,
  tickMsPatch,
  updatesCheckPatch,
  updatesItems,
  validateQuietTime,
  validateSnapshotEvery,
  validateTickMs,
  PALETTE_KEYCAPS,
  type NotificationToggleId,
  type SettingsCommandId,
} from "./settings-model.ts";
import { loadAppConfig, loadRawAppConfig, updateAppConfig } from "../../lib/app-config.ts";
import {
  APP_FOCUS_OPTION,
  APP_JUMP_OPTION,
  buildAppFocusValue,
  parseNotificationPrefs,
} from "../chrome/notify.ts";
import { adoptMarkArgv, updaterProbeArgv, updaterSpawnArgv } from "../chrome/front-door.ts";
import { APP_HOST_SESSION } from "./hosted.ts";
import {
  ATTENTION_FLASH_MS,
  attentionNoteLine,
  diffAttention,
  noteworthyTransitions,
  type AttentionAgent,
} from "./attention.ts";
import {
  buildHomeItems,
  clampSelectable,
  firstRunTip,
  stepSelectable,
  sessionNameFor,
  isValidSessionName,
  type HomeItem,
} from "./home-model.ts";
import {
  sortAgentRows,
  agentRowLabel,
  agentsHeaderLabel,
  agentAgeLabel,
  agentDisplayKind,
  sidebarHit,
  AGENTS_ADD_CHIP,
  AGENTS_EMPTY_LINE,
  AGENTS_GAP_ROWS,
  type AgentRowInput,
} from "./agent-rows.ts";
import {
  findMatches,
  visitOrder,
  stepMatch,
  offsetForMatch,
  type SearchMatch,
} from "./search-model.ts";
import {
  ALWAYS_IGNORE,
  ancestorDirs,
  buildNodes,
  changedFileWalk,
  filterEntries,
  filterView,
  indexOfPath,
  insertChildrenAt,
  nextChangedPath,
  rebuildTree,
  relPath,
  removeSubtreeAt,
  statusMapFromEntries,
  type FileNode,
  type RawEntry,
} from "./file-tree.ts";
import ignore, { type Ignore } from "ignore";
import { watchDirectory } from "../../widgets/lib/watcher.ts";
import { spans, spanHit, spansFromRight, type Span } from "./spans.ts";
import {
  AGAIN_ID,
  CUSTOM_KIND_ID,
  INTERRUPT_TAP_GAP_MS,
  RESTART_GRACE_MS,
  TEAM_ACTIONS,
  TEAM_NEW_ID,
  clearAuthorityArgs,
  compatiblePlacement,
  customRecentIndex,
  defaultSpawnPlacement,
  interruptArgs,
  labelPaneArgs,
  labelWindowArgs,
  lastSpawnName,
  launchCommandFor,
  newAgentItems,
  paneHostsShell,
  placementActions,
  placementLabel,
  relaunchArgs,
  resolvePlacement,
  respawnArgs,
  spawnAgentArgs,
  spawnLabelFor,
  spawnSessionArgs,
  stampLaunchArgs,
  teamAgentIndex,
  teamItems,
  type LastSpawn,
  type SpawnPlacement,
  type SpawnWhere,
} from "./agent-lifecycle.ts";
import { getManifests } from "../detect/manifest-loader.ts";
import { agentsByPane } from "./agent-chip.ts";
import { scrollThumb, trackZone, pageTop, dragTop } from "./scrollbar-model.ts";
import {
  MENU_ITEMS,
  paneMenuItems,
  CONFIRM_SUFFIX,
  SUBMENU_CARET,
  menuDims,
  clampMenuPos,
  menuItemAt,
  pointInMenu,
  submenuPos,
  type MenuRegion,
  type MenuItem,
  type MenuGeom,
} from "./menu-model.ts";
import {
  orderCells,
  rowSelectionRange,
  extractSelection,
  trimAdjustCell,
  wordRangeAt,
  lineRangeAt,
  clickCount,
  tintRunsInverse,
  tintRunsBg,
  osc52Sequence,
  paneDragDefault,
  routePanePress,
  wheelScrollsLocal,
  selectBadgeLabel,
  ATTR_INVERSE,
  type Cell,
  type PaneDragDefault,
  type Selection,
} from "./selection.ts";

const { values } = parseArgs({
  options: {
    target: { type: "string" },
    edit: { type: "string" },
    diff: { type: "string" },
  },
});
const target = values.target ?? "";
// Bare launch (no `--target`, or the explicit `home` pseudo-target) opens the
// HOME panel instead of a session mirror; a real target boots straight to the
// mirror exactly as before. `--diff <dir>` boots straight into the diff panel
// (for testing / direct entry).
const startDiff = values.diff !== undefined;
const bareHome = target === "" || target === "home";

/** The `tmux-ide team --json` fleet shape this app reads (projects → sessions →
 *  windows). Declared locally so the app never imports the data-layer modules
 *  (listTeamProjects/listTeamSessions run a synchronous exec chain that blocks
 *  the render loop — the async subprocess is the whole point). */
interface FleetSession {
  name: string;
  status: AgentStatus;
  panes: number;
  attached: boolean;
  windows: Array<{ index: number; name: string; active: boolean }>;
  /** Per-pane agent detail (M22.1) — optional so older payloads still parse.
   *  The sidebar AGENTS section (M22.2) flattens these across the fleet and the
   *  Terminal surface's pane chips (M22.3) join them by paneId. AgentRowInput is
   *  a structural superset of the chip module's ChipAgent, so one type serves
   *  both consumers; extra report fields ride along unused. */
  agents?: AgentRowInput[];
}
interface FleetProject {
  name: string;
  dir: string | null;
  registered: boolean;
  running: boolean;
  status: AgentStatus;
  sessions: FleetSession[];
}
const zzlog = (m: string) => {
  if (!process.env.TMUX_IDE_ZZ_LOG) return;
  try {
    appendFileSync("/tmp/zz-route.log", m + "\n");
  } catch {}
};

// Focused-pane gutter hairline (M22.7): the ACCENT family, drawn as │/─ glyphs
// so the gutter stays visually thin (a filled bar read as extra padding — user
// feedback). Doesn't compete with the blocked chip's red — focus is an accent
// signal, agent state is a status signal, never the same hue.
// A single subtle pointer-hover tint, one lift above both DEFAULT_BG (16,16,22)
// and SIDEBAR_BG (22,22,30) and below TAB_ACTIVE_BG — the active/selected state
// always wins over hover. Used on every hoverable row/segment (see `hover`).
const KEYMAP: Record<string, string> = {
  return: "Enter",
  backspace: "BSpace",
  tab: "Tab",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  delete: "DC",
  space: "Space",
};
const SCROLL_STEP = 3;
// Selection & clipboard (M19.4). Copies above 1 MB refuse; double/triple clicks
// resolve within CLICK_MS at the same cell. A paste forwarded into a pane is
// chunked by the INPUT COALESCER under tmux's per-command cap (M21.5 — see
// SEND_KEYS_CHUNK_BYTES in input-coalescer.ts; the old app-level
// PASTE_CHUNK_BYTES=1024 pre-chunking is retired).
const MAX_CLIP_BYTES = 1_000_000;
const CLICK_MS = 400;
const sgrMouse = (button: number, col: number, row: number, release: boolean): string =>
  `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
interface WindowTab {
  index: number;
  name: string;
  active: boolean;
  /** The window's `synchronize-panes` option — drives the `[SYNC]` chip. */
  sync: boolean;
}
/** The hoverable surfaces — each names a row/segment set the router can resolve
 *  by coordinate math and each render tints with HOVER_BG (chips lift to
 *  BUTTON_HOVER_BG). M21.9 adds: `tabbtn` (the tab bar's right-aligned context/
 *  palette chips), `homechip` (a home row's right-aligned verb chip, index =
 *  row), and `sidebtn` (the sidebar footer's clickable "F5 palette" segment). */
type HoverRegion =
  | "sidebar"
  | "sidebaragent"
  | "home"
  | "surfacetab"
  | "windowtab"
  | "files"
  | "diff"
  // Changes view file/action rows.
  | "diffverb"
  | "button"
  | "tabbtn"
  | "homechip"
  | "homeagentchip"
  | "welcomeopen"
  | "sidebtn"
  | "missionmode"
  | "missioncard"
  | "missionhistory"
  | "missionbutton"
  // M24.1: the AGENTS header row (click → Team dialog) and its right-aligned
  // [+ agent] chip (index 0 = header row, 1 = the empty-state row's twin).
  | "agentshdr"
  | "agentschip";

/** The one pointer-event shape the central `route` reads. `button` distinguishes
 *  left (0) / right (2) presses; `stopPropagation` (present on the real OpenTUI
 *  MouseEvent) halts the parent-chain walk so the FIRST handler in the bubble
 *  owns the event — a leaf container for normal clicks, the root box for the
 *  late-mounted menu overlay whose only ancestor handler is root. */
type RouteEvent = {
  type: string;
  button?: number;
  x: number;
  y: number;
  scroll?: { direction: string };
  /** Keyboard modifiers held on the pointer event (present on the real OpenTUI
   *  MouseEvent — SGR encodes shift as +4 on the button code). A shift-modified
   *  press on an app-mouse pane starts a LOCAL selection instead of being
   *  forwarded (M22.9) — where the terminal passes shift through at all. */
  modifiers?: { shift: boolean; alt: boolean; ctrl: boolean };
  stopPropagation?: () => void;
};

// Packed 0xRRGGBB twins of the defaults, for the framebuffer-blit path (M21.3):
// the blit writes packed channels straight into the buffer, no RGBA per cell.
const DEFAULT_FG_PACKED = 0xd4d4d8;
const DEFAULT_BG_PACKED = 0x101016;
// The <pane_surface> framebuffer blit is now the DEFAULT (M21.4); TMUX_IDE_FB_PANES=0
// is an opt-OUT kill switch (kept one release) that falls back to the StyledRun
// <For> path below. The kill switch's removal + the StyledRun deletion are the
// follow-up card.
const FB_PANES = process.env.TMUX_IDE_FB_PANES !== "0";
// The blocked pane-chip's attention background (M22.3) — a red-leaning lift of
// BADGE_BG so a blocked agent's chip pops without tinting any terminal cells.
const GUTTER_BG = RGBA.fromInts(38, 40, 52, 255);
const GUTTER_FG = RGBA.fromInts(96, 100, 120, 255);
const MODIFIED_FG = RGBA.fromInts(235, 200, 100, 255);
const BANNER_FG = RGBA.fromInts(240, 150, 90, 255);
const CURSOR_BG = RGBA.fromInts(130, 170, 255, 255);
const DIFF_ADD_FG = RGBA.fromInts(120, 200, 140, 255);
const DIFF_DEL_FG = RGBA.fromInts(240, 120, 120, 255);
const DIFF_META_FG = RGBA.fromInts(120, 120, 140, 255);
const DIFF_CONTEXT_FG = RGBA.fromInts(170, 170, 185, 255);
const DIFF_FG: Record<DiffLineKind, RGBA> = {
  add: DIFF_ADD_FG,
  del: DIFF_DEL_FG,
  hunk: ACCENT,
  meta: DIFF_META_FG,
  context: DIFF_CONTEXT_FG,
};
// Status-letter color for the changed-file list (worktree/index state).
const STATUS_LETTER_FG: Record<string, RGBA> = {
  M: MODIFIED_FG,
  A: DIFF_ADD_FG,
  D: DIFF_DEL_FG,
  R: ACCENT,
  C: ACCENT,
  "?": MUTED,
};
// Add/del BACKGROUND fills layered UNDER the DIFF_FG classes (M24.5). Values
// mirror the widget theme's diffAddedBg/diffRemovedBg (widgets/lib/theme.ts:27-34)
// — that theme is the future token source once the app's const surface colors
// move onto the theming pipeline.
const DIFF_ADD_BG = RGBA.fromInts(20, 60, 30, 255);
const DIFF_DEL_BG = RGBA.fromInts(60, 20, 20, 255);
const DIFF_LINE_BG: Partial<Record<DiffLineKind, RGBA>> = { add: DIFF_ADD_BG, del: DIFF_DEL_BG };
const HEADER_ROWS = 2;
// The persistent surface-tab row is one screen row at the very top (above the
// sidebar + main region). Its height offsets every region's global y, so the
// router subtracts it once (`gy = y - TABBAR_H`) before the per-mode math.
const TABBAR_H = 1;
const PALETTE_ROWS = 10;
// ── M24.4 kitty keyboard protocol ───────────────────────────────────────────
// One config read at boot (the dragSelect discipline): when on, the renderer
// requests kitty's disambiguated key encoding from the host terminal, which is
// what delivers ⌘-modified keys at all — ⌘K opens the palette. Hosts without
// the protocol ignore the request (legacy encoding, no behavior change);
// `app.kittyKeys: false` opts out entirely. The ⌘K hint only shows while the
// request is actually made.
const KITTY_KEYS = loadAppConfig().app.kittyKeys;
const TABBAR_PALETTE_LABEL = KITTY_KEYS ? "F5 ⌘K palette " : "F5 ⌘ palette ";
// The palette rows' right-aligned keycaps (M24.4) — the settings keybind
// viewer's enumeration, minus `quit` when HOSTED (^q detaches there; the
// palette's Quit is the real exit, so the keycap would lie).
const PALETTE_ROW_KEYCAPS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PALETTE_KEYCAPS).filter(
    ([key]) => !(key === "quit" && process.env.TMUX_IDE_HOSTED === "1"),
  ),
);
// ── M22.5 first-run welcome ─────────────────────────────────────────────────
// A centered greeting shown only on a truly empty fleet (no sessions, no
// registered projects). Geometry now lives in the Home surface projection so
// render and pointer routing consume the same model.
const WELCOME_LINE = "Welcome to tmux-ide — a cockpit for the tmux sessions you already have.";
const WELCOME_ACTION_LABEL = "▸ open a folder — press f";
// HOSTED mode (M23.2): the detachable-cockpit launcher stamps this marker on
// the app's pane command inside `_tmux-ide-app`. ^q then detaches the tmux
// client instead of exiting (the cockpit survives the terminal); every "^q
// quit" hint reads "detach" so the keycap tells the truth.
const HOSTED = process.env.TMUX_IDE_HOSTED === "1";
const QUIT_HINT = HOSTED ? "^q detach" : "^q quit";
// Scrollback-search highlight backgrounds (M20.3), packed 0xRRGGBB to sit in a
// run's `bg` (search paints a bg, distinct from selection's inverse video, so
// the two coexist). Every visible match gets the dim accent; the CURRENT match
// (the n/N cursor) gets the bright accent so it reads apart from the rest.
const SEARCH_HL = 0x3a4e7a; // dim accent-blue — all matches
const SEARCH_CUR = 0x82aaff; // bright accent (== ACCENT) — current match
const PALETTE_BG = RGBA.fromInts(28, 30, 42, 255);
const PALETTE_BORDER = RGBA.fromInts(70, 78, 110, 255);
const TABBAR_BG = RGBA.fromInts(18, 18, 26, 255);
const DIR_FG = RGBA.fromInts(150, 180, 250, 255);
// Scrollbar track/thumb (M19.5). The track is a faint tint over the pane bg;
// the thumb a brighter block. Both are drawn as single-cell bg fills in the
// always-present container's right column — never a late-mounted box.
const SCROLL_TRACK_BG = RGBA.fromInts(34, 36, 48, 255);
const SCROLL_THUMB_BG = RGBA.fromInts(90, 98, 130, 255);
const SCROLL_THUMB_HOVER_BG = RGBA.fromInts(120, 130, 170, 255);
// Header-row affordance buttons (M19.5) — coordinate-routed spans on mount-time
// rows, styled like a subtle chip; the hovered one lifts to the accent.
const BUTTON_FG = RGBA.fromInts(150, 160, 190, 255);
const BUTTON_BG = RGBA.fromInts(34, 38, 54, 255);
// A toggled-on chip (the zoom button while the focused pane's window is zoomed):
// the accent, tinted down so the button still reads as a chip, not a label.
const BUTTON_ACTIVE_BG = RGBA.fromInts(58, 78, 128, 255);
/** tmux command-lexer single-quoting for an interpolated argument (a renamed
 *  window name typed by the user): wrap in single quotes, and splice any embedded
 *  quote as `'\''` (close, escaped quote, reopen — tmux's lexer, like the shell,
 *  honours the backslash outside quotes). */
const tmuxQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
const rgbaCache = new Map<number, RGBA>();
const packedToRgba = (packed: number | null, fallback: RGBA): RGBA => {
  if (packed === null) return fallback;
  let c = rgbaCache.get(packed);
  if (!c) {
    c = RGBA.fromInts((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff, 255);
    rgbaCache.set(packed, c);
  }
  return c;
};

// Create the renderer explicitly so host-terminal mode ownership spans its
// exact lifetime. OpenTUI's terminal setup must finish BEFORE DECAWM is turned
// off; its onDestroy runs after native terminal teardown and restores it. The
// process-exit fallback covers any future direct process.exit path and uses a
// synchronous fd write because queued stdout is not reliable during `exit`.
let hostAutowrap: HostAutowrapGuard | null = null;
const appRenderer = await createCliRenderer({
  // Ctrl-C belongs to the focused terminal/editor. The app's explicit global
  // exit is Ctrl-Q; OpenTUI otherwise destroys the renderer before Ctrl-C can
  // reliably pass through to the mirrored pane.
  exitOnCtrlC: false,
  // targetFps stays EXPLICIT: @opentui 0.4.3 silently defaults it to 30
  // (maxFps already defaults to 60). Re-confirmed on the 0.4.3 bump (M21.2).
  targetFps: 60,
  maxFps: 60,
  // `{}` requests kitty's default disambiguation + alternate-key flags.
  useKittyKeyboard: KITTY_KEYS ? {} : null,
  // OpenTUI's error console is an in-app overlay; keep it development-only.
  consoleMode: process.env.TMUX_IDE_MIRROR_DEBUG ? "console-overlay" : "disabled",
  onDestroy: () => hostAutowrap?.restore(),
});
hostAutowrap = installHostAutowrapGuard((sequence) => writeSync(process.stdout.fd, sequence), {
  onExit: (listener) => process.once("exit", listener),
  offExit: (listener) => process.removeListener("exit", listener),
});

try {
  await render(() => {
    const cleanupRegistry = new TuiCleanupRegistry();
    onCleanup(() => cleanupRegistry.runAll());
    // Register <pane_surface> before any is created (M21.3). An explicit call —
    // a bare side-effect import of the module gets DCE'd by the transpiler.
    if (FB_PANES) registerPaneSurface();
    const dims = useTerminalDimensions();
    const semanticThemeStore = createSemanticThemeStore(loadAppConfig().theme, {
      rendererMode: appRenderer.themeMode,
    });
    const [semanticTheme, setSemanticTheme] = createSignal(semanticThemeStore.getSnapshot());
    const disposeSemanticThemeStore = semanticThemeStore.subscribe(() =>
      setSemanticTheme(semanticThemeStore.getSnapshot()),
    );
    const disposeRendererThemeMode = semanticThemeStore.followRendererThemeMode(appRenderer);
    onCleanup(() => {
      disposeRendererThemeMode();
      disposeSemanticThemeStore();
    });
    const shellLayout = () => shellChromeLayout(dims().width, dims().height, preferredSidebarW());
    const sidebarW = () => shellLayout().sidebar.width;
    const sidebarHint = () => shellSidebarHint(shellLayout().variant, QUIT_HINT, sidebarW());
    const paletteW = () => shellLayout().paletteWidth;
    const dialogW = () => shellLayout().dialogWidth;
    const dialogInnerWidth = () => dialogInnerW(dialogW());
    const mainColumnCols = () => Math.max(0, dims().width - sidebarW());

    // Persisted state (one-shot read at launch — NOT on the render loop). The tab
    // and context restore below; the open editor file / diff selection restore in
    // onMount (after the FFI buffer + fleet arrive).
    const persisted: AppState = loadAppState();
    // The bundled CLI — the async fleet poll and `detect --write` both shell out
    // to it (resolved once; `node <cliPath> …`). The CLI forwards its own
    // node-runnable path as TMUX_IDE_CLI; prefer it, because in the COMPILED TUI
    // binary `import.meta.url` is a virtual bunfs path so the relative fallback
    // resolves to a bogus cli.js — the subprocesses would silently fail and the
    // home would ALWAYS look empty. The fallback covers running the app directly
    // via bun (dev, no CLI hop) where import.meta.url is a real on-disk file.
    const cliPath =
      process.env.TMUX_IDE_CLI || new URL("../../../../../bin/cli.js", import.meta.url).pathname;
    // The user's REAL invocation directory. `tmux-ide app` runs bun from the
    // repo root (the bunfig preload lives there), so `process.cwd()` is the repo
    // root, NOT where the user typed the command — the CLI forwards the true dir
    // as TMUX_IDE_CWD. Every "here" the app defaults to (the folder picker's
    // start, a new session's dir, the diff/workspace root) reads THIS so cold
    // starting from any directory lands where the user actually is. Falls back
    // to process.cwd() when the app is spawned directly (dev, no CLI hop).
    const invokeCwd = process.env.TMUX_IDE_CWD || process.cwd();
    // ── SIDEBAR WIDTH (M19.3) ────────────────────────────────────────────────
    // Once a fixed constant, now a DRAGGABLE, persisted signal: every geometry
    // that used to read the constant (canvasCols, pane/editor/diff offsets, the
    // window-strip spans, the router's region math, the render widths) reads
    // `sidebarW()` so a boundary drag reflows the whole app. Restored from
    // app-state (clamped), re-clamped defensively, re-persisted on release.
    const [preferredSidebarW, setPreferredSidebarW] = createSignal(
      clampSidebarWidth(persisted.sidebarW),
    );
    // Recently-opened folders (M22.5) — restored from app-state, prepended-to on
    // every folder open, persisted with the rest of the app state. Home renders
    // them under a "recent" header (deduped against sessions + the registry).
    const [recentFolders, setRecentFolders] = createSignal<string[]>(persisted.recentFolders);
    // The "again" spawn memory + custom-command recents (M24.1) — restored from
    // app-state, updated on every spawn, persisted with the rest.
    const [lastSpawns, setLastSpawns] = createSignal<Record<string, LastSpawn>>(
      persisted.lastSpawns,
    );
    const [customCommands, setCustomCommands] = createSignal<string[]>(persisted.customCommands);
    // Palette usage history (M24.4) — restored from app-state, bumped on every
    // dispatched palette action, persisted with the rest. Drives the empty-query
    // "recent" group and the typed-query tie-break.
    const [paletteUsage, setPaletteUsage] = createSignal<Record<string, PaletteUsageEntry>>(
      persisted.paletteUsage,
    );
    // The first-run tip line — the user's ACTUAL keybindings, read once at launch
    // (loadAppConfig honors TMUX_IDE_CONFIG). Cheap + pure, computed once.
    const welcomeTip = firstRunTip(loadAppConfig().keys);
    // Hosted panel views are loaded through the resolved-config pipeline. C06
    // stores per-project active view + per-view surface memory in C04 runtime
    // state; legacy app-state remains as first-run fallback and global prefs.
    const requestedPanel: HostedPanelKind | null = startDiff
      ? "diff"
      : values.edit !== undefined
        ? "files"
        : !bareHome
          ? "terminals"
          : null;
    const persistedPanel = isTab(persisted.lastTab)
      ? panelKindFromLegacyTab(persisted.lastTab)
      : null;
    const [hostedViews, setHostedViews] = createSignal<HostedPanelView[]>(
      viewsFromResolvedConfig(null),
    );
    const fallbackHostedViews = viewsFromResolvedConfig(null);
    const nativeHostedViewForPanel = (
      views: readonly HostedPanelView[],
      panel: HostedPanelKind,
    ): HostedPanelView =>
      views.find((view) => !view.layout && view.panel === panel) ??
      fallbackHostedViews.find((view) => !view.layout && view.panel === panel)!;
    const canvasHostedViews = createMemo(() => {
      return (["home", "terminals"] as const).map((panel) => ({
        ...nativeHostedViewForPanel(hostedViews(), panel),
        // The top shell is a canonical product surface even when compatibility
        // app.views supplied different list-position shortcuts.
        shortcut: workbenchCanvasShortcutForPanel(panel),
      }));
    });
    const canvasViewForPanel = (
      views: readonly HostedPanelView[],
      panel: "home" | "terminals",
    ): HostedPanelView => nativeHostedViewForPanel(views, panel);
    const [workspaceUiState, setWorkspaceUiState] =
      createSignal<WorkspaceUiStateV2>(defaultWorkspaceUiState());
    const workspaceUiController = new WorkspaceUiStateController();
    const touchedWorkspaceViewIds = new Set<string>();
    const touchedWorkspaceSurfaceIds = new Set<keyof WorkspaceSurfaceStates>();
    const hydratedWorkspaceSurfaceIds = new Set<keyof WorkspaceSurfaceStates>();
    let touchedWorkspaceDock = false;
    let touchedWorkspaceActiveView = false;
    const missionWorkspaceLoader = new MissionWorkspaceLoader();
    let currentWorkspaceUiIdentity: string | null = null;
    let currentMissionsLoadIdentity: string | null = null;
    let workspaceUiSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let missionsRefreshTimer: ReturnType<typeof setInterval> | null = null;
    let flushWorkspaceUiState = () => {};
    let snapshotActiveWorkspaceView = () => {};
    let hydrateActiveWorkspaceView = (_options: { firstProjectLoad?: boolean } = {}) => {};
    let hydrateWorkspaceView = (
      _view: HostedPanelView,
      _options: { firstProjectLoad?: boolean } = {},
    ) => {};
    const initialView = initialHostedSelection(
      hostedViews(),
      requestedPanel,
      bareHome ? persistedPanel : null,
    )!;
    const initialCanvasPanel: "home" | "terminals" =
      bareHome && !persisted.contextSession && !requestedPanel ? "home" : "terminals";
    const initialCanvasView = canvasViewForPanel(hostedViews(), initialCanvasPanel);
    const [activeViewId, setActiveViewId] = createSignal(initialCanvasView.id);
    const activeView = createMemo(
      () =>
        findHostedViewById(canvasHostedViews(), activeViewId()) ??
        findHostedViewById(hostedViews(), activeViewId()) ??
        canvasHostedViews()[0]!,
    );
    const dockTabForPanel = (panel: HostedPanelKind): WorkbenchDockTabId | null => {
      if (panel === "files") return "files";
      if (panel === "diff") return "changes";
      if (panel === "missions") return "missions";
      return null;
    };
    const panelForDockTab = (dockTab: WorkbenchDockTabId): HostedPanelKind | "activity" => {
      if (dockTab === "files") return "files";
      if (dockTab === "changes") return "diff";
      if (dockTab === "missions") return "missions";
      return "activity";
    };
    const initialDockTab = dockTabForPanel(initialView.panel) ?? "files";
    // Card05 makes an active workspace canvas a process surface: tmux-backed
    // agent and shell terminals only. Native Home remains the empty/front-door
    // state for Card06 onboarding, but is never a composite/tile peer.
    const [canvasPanel, setCanvasPanel] = createSignal<"home" | "terminals">(initialCanvasPanel);
    const [activeDockTab, setActiveDockTab] = createSignal<WorkbenchDockTabId>(initialDockTab);
    const [dockMode, setDockMode] = createSignal<WorkbenchDockMode>("open");
    const [preferredDockHeight, setPreferredDockHeight] = createSignal<number | null>(null);
    const [workbenchFocusZone, setWorkbenchFocusZone] = createSignal<WorkbenchFocusZone>(
      dockTabForPanel(initialView.panel) ? "dock-body" : "canvas",
    );
    const [hoveredDockTab, setHoveredDockTab] = createSignal<WorkbenchDockTabId | null>(null);
    const [activitySelectedId, setActivitySelectedId] = createSignal<string | null>(null);
    const [activityScrollOffset, setActivityScrollOffset] = createSignal(0);
    const workbenchProjection = createMemo(() =>
      projectWorkbenchShell({
        width: mainColumnCols(),
        height: Math.max(0, dims().height - TABBAR_H),
        dockMode: dockMode(),
        persistedDockHeight: preferredDockHeight(),
        activeDockTab: activeDockTab(),
        focusZone: workbenchFocusZone(),
        hoveredDockTab: hoveredDockTab(),
        attentionDockTabs: new Set(),
        dockTabShortcuts: { files: "F3", changes: "F4", missions: "F6", activity: "F9" },
      }),
    );
    const dockSurfaceWidth = () => workbenchProjection().dockBodyContent.width;
    const dockSurfaceHeight = () => workbenchProjection().dockBodyContent.height;
    const focusedWorkbenchPanel = (): HostedPanelKind | "activity" => {
      if (workbenchProjection().focusZone === "canvas") {
        return canvasPanel();
      }
      return panelForDockTab(activeDockTab());
    };
    const activePanel = (): HostedPanelKind => {
      const panel = focusedWorkbenchPanel();
      return panel === "activity" ? "home" : panel;
    };
    const tab = (): Tab => legacyTabFromPanelKind(activePanel());
    const mode = (): "home" | "mirror" | "editor" | "diff" | "missions" => panelMode(activePanel());
    const surfaceSpans = createMemo(() =>
      shellSurfaceTabSpans(canvasHostedViews(), shellLayout().variant),
    );
    const [missionWorkspaceLoad, setMissionWorkspaceLoad] = createSignal<MissionWorkspaceLoadState>(
      {
        status: "loading",
        generation: 0,
        projectKey: null,
      },
    );
    const [missionWorkspaceSnapshot, setMissionWorkspaceSnapshot] =
      createSignal<MissionWorkspaceSnapshot | null>(null);
    const [missionWorkspaceModel, setMissionWorkspaceModel] = createSignal<MissionWorkspaceModel>(
      defaultMissionWorkspaceModel(),
    );

    // ── WORKSPACE CONTEXT ────────────────────────────────────────────────────
    // One context per session: choosing a session on Home (or via the palette)
    // sets the terminal target AND the files/diff directory. The header shows the
    // context name across every tab. `contextDir` starts from the persisted
    // guess and is reconciled against the fleet payload once it arrives.
    const [contextSession, setContextSession] = createSignal<string>(
      persisted.contextSession ?? "",
    );
    const [contextDir, setContextDir] = createSignal<string>("");

    const [curTarget, setCurTarget] = createSignal(
      bareHome ? (persisted.contextSession ?? "") : target,
    );
    const [panes, setPanes] = createSignal<LivePane[]>([]);
    // Size truth (M22.8): the actual tmux window size when a co-attached terminal
    // has shrunk it below our pinned canvas (else null). Set in the tick from the
    // RAW pane geometry (before the letterbox offset is baked into `panes()`), it
    // drives the honest hint badge and gates the palette's reclaim action.
    const [windowMismatch, setWindowMismatch] = createSignal<Size | null>(null);
    // ── FRAMEBUFFER-BLIT PLUMBING (M21.3/M21.4) ──────────────────────────────
    // Under FB_PANES the 8ms tick fetches geometry-only panes (no styled rows).
    // Each <pane_surface> reads its pane's PER-PANE version (`LivePane.version`)
    // as `contentVersion` and walks only when THAT changes — so a quiet pane in a
    // multi-pane window never re-reads while a sibling floods (M21.4).
    // The <For> that maps panes to surfaces keys on the id list (stable identity),
    // NOT the freshly-rebuilt panes() array — so a content tick REUSES each
    // pane_surface (and its framebuffer) instead of tearing it down and back up.
    const paneIds = createMemo(() => panes().map((p) => p.id), undefined, {
      equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
    });
    const panesById = createMemo(() => new Map(panes().map((p) => [p.id, p])));
    const [windowTabs, setWindowTabs] = createSignal<WindowTab[]>([]);
    const [projectsData, setProjectsData] = createSignal<FleetProject[]>([]);
    // The fleet payload's per-pane entries join directly to tmux's live %pane_id.
    // Drag policy and pane chrome consume this same authority-derived map.
    const agentByPane = createMemo(() => agentsByPane(projectsData()));
    // Pointer-hover feedback. One nullable signal names the hovered target as a
    // {region, index}; the same coordinate math that routes clicks resolves it on
    // motion events, and each hoverable render reads it for a subtle HOVER_BG. It
    // must never thrash: `setHoverIf` no-ops unless region+index actually change.
    const [hover, setHover] = createSignal<{ region: HoverRegion; index: number } | null>(null);
    const setHoverIf = (next: { region: HoverRegion; index: number } | null) => {
      const cur = hover();
      if (next === null) {
        if (cur !== null) setHover(null);
        return;
      }
      if (!cur || cur.region !== next.region || cur.index !== next.index) setHover(next);
    };
    const isHovered = (region: HoverRegion, index: number): boolean => {
      const h = hover();
      return h !== null && h.region === region && h.index === index;
    };
    const [sel, setSel] = createSignal(0);
    const [status, setStatus] = createSignal(bareHome ? "home" : "attaching…");

    // ── SELECTION & CLIPBOARD (M19.4; absolute-space M25.6) ──────────────────
    // The visible selection (drives inverse-tint on the mirror/editor render) and
    // the gesture state machine driving it. `selecting` marks a drag in progress
    // (null = none, discrete word/line selections leave it null); `selAnchor` is
    // where the drag began — for the MIRROR that's an ABSOLUTE buffer cell
    // (M25.6), fixed at press; `selTrimBase` records the pane's lineTrim() at
    // that moment so a buffer rotating past its scrollback cap mid-drag keeps
    // the anchor on its content (trimAdjustCell subtracts the drift at each
    // extend). `lastClick` tracks click-count for double/triple. A transient
    // `note` reuses the status channel for "copied/pasted N chars".
    const [selection, setSelection] = createSignal<Selection | null>(null);
    let selecting: { surface: "mirror"; paneId: string } | { surface: "editor" } | null = null;
    let selAnchor: Cell = { row: 0, col: 0 };
    let selTrimBase = 0;
    // Edge auto-scroll (M25.6): armed by extendSelection when the drag pointer
    // sits at/beyond the selecting pane's top/bottom content row; the 8ms state
    // tick then scrolls 1 row per tick and re-extends at the LAST pointer —
    // no new timers. Cleared on release/escape (clearSelection) and whenever
    // the pointer moves back inside the pane body.
    let dragAutoScroll: "up" | "down" | null = null;
    let lastDragPointer = { x: 0, y: 0 };
    let lastClick: { row: number; col: number; ts: number; count: number } | null = null;
    const [note, setNote] = createSignal("");
    let noteTimer: ReturnType<typeof setTimeout> | null = null;
    const setStatusNote = (m: string) => {
      setNote(m);
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = setTimeout(() => setNote(""), 3000);
    };
    const clearSelection = () => {
      selecting = null;
      dragAutoScroll = null;
      if (selection() !== null) setSelection(null);
    };
    const runActivationEffects = (effects: readonly string[]) => {
      for (const effect of effects) {
        if (effect === "load-files") loadFileList(workspaceDir());
        else if (effect === "catch-up-files") catchUpFilesIfStale();
        else if (effect === "enter-diff") prepareDiff(workspaceDir());
      }
    };
    const activationState = () => ({
      filesLoaded: fileNodes().length > 0,
      diffLoaded: diffEntries().length > 0,
    });
    const runPanelActivation = (panel: HostedPanelKind) => {
      runActivationEffects(hostedActivationEffects(panel, activationState()));
      if (panel === "missions") ensureMissionsLoaded();
    };
    const missionHostedView = () => nativeHostedViewForPanel(hostedViews(), "missions");
    const missionViewId = () => missionHostedView().id;
    const selectViewForPanel = (viewId: string, panel: HostedPanelKind) => {
      if (panel === "home" || panel === "terminals") {
        activateCanvasPanel(panel);
        return;
      }
      const dockTab = dockTabForPanel(panel);
      if (dockTab) activateDockTab(dockTab);
      else selectView(viewId);
    };
    const missionLayoutSize = () => {
      const size = missionDashboardMainSize(dockSurfaceWidth(), Math.max(1, dockSurfaceHeight()));
      return { width: size.mainWidth, height: size.height };
    };
    const persistMissionSelection = (missionId: string | null, taskId: string | null = null) => {
      const view = missionHostedView();
      if (activePanel() !== "missions") return;
      touchedWorkspaceViewIds.add(view.id);
      setWorkspaceUiState((state) =>
        workspaceStateWithMissionSelection(state, view.id, missionId, taskId),
      );
    };
    const persistMissionModel = (model: MissionWorkspaceModel) => {
      const view = missionHostedView();
      if (activePanel() !== "missions") return;
      touchedWorkspaceViewIds.add(view.id);
      setWorkspaceUiState((state) => workspaceStateWithMissionModel(state, view.id, model));
    };
    const updateMissionModel = (
      updater: (model: MissionWorkspaceModel) => MissionWorkspaceModel,
    ) => {
      setMissionWorkspaceModel((current) => {
        const updated = updater(current);
        const next =
          updated.mode !== "detail" && updated.selectedMissionId !== current.selectedMissionId
            ? { ...updated, selectedTaskId: null }
            : updated;
        if (next !== current) persistMissionModel(next);
        return next;
      });
    };
    const loadMissionsWorkspace = (reason: "activation" | "refresh" | "cadence" | "project") => {
      if (activeDockTab() !== "missions" && activeDockTab() !== "activity" && mode() !== "missions")
        return;
      const repository = workspaceUiController.snapshot().repository;
      if (!repository) {
        setMissionWorkspaceLoad({ status: "loading", generation: 0, projectKey: null });
        return;
      }
      const priorSnapshot =
        reason === "refresh" || reason === "cadence" ? missionWorkspaceSnapshot() : null;
      const start = missionWorkspaceLoader.begin(repository.metadata.identityKey, priorSnapshot);
      setMissionWorkspaceLoad(start);
      const projectKey = repository.metadata.identityKey;
      const persistedSelection = missionSelectionFromWorkspaceState(
        workspaceUiState(),
        missionViewId(),
      );
      const selectedForDetail =
        missionWorkspaceModel().mode === "detail"
          ? (missionWorkspaceModel().selectedMissionId ?? persistedSelection.selectedMissionId)
          : null;
      currentMissionsLoadIdentity = projectKey;
      void Promise.resolve()
        .then(() => readMissionWorkspace(repository, selectedForDetail))
        .then((snapshot) => {
          const accepted = missionWorkspaceLoader.accept(start.generation, projectKey, snapshot);
          if (!accepted) return;
          setMissionWorkspaceSnapshot(snapshot);
          updateMissionModel((current) =>
            reconcileMissionWorkspaceModel(
              missionModelFromWorkspaceState(workspaceUiState(), missionHostedView(), current),
              snapshot,
              {
                persistedMissionId: persistedSelection.selectedMissionId,
                persistedTaskId: persistedSelection.selectedTaskId,
                ...missionLayoutSize(),
              },
            ),
          );
          setMissionWorkspaceLoad(accepted);
          if (reason === "refresh") setStatusNote("missions refreshed");
        })
        .catch((error) => {
          const rejected = missionWorkspaceLoader.reject(start.generation, projectKey, error);
          if (!rejected) return;
          if (start.status === "refreshing") {
            setMissionWorkspaceSnapshot(start.snapshot);
            setMissionWorkspaceLoad({ ...rejected, snapshot: start.snapshot });
          } else {
            setMissionWorkspaceSnapshot(null);
            setMissionWorkspaceLoad(rejected);
          }
          if (reason === "refresh" && rejected.status === "error") setStatusNote(rejected.message);
        });
    };
    const ensureMissionsLoaded = () => {
      if (activeDockTab() !== "missions" && activeDockTab() !== "activity" && mode() !== "missions")
        return;
      loadMissionsWorkspace("activation");
    };
    const activateCanvasPanel = (panel: "home" | "terminals"): boolean => {
      clearSelection();
      snapshotActiveWorkspaceView();
      const view = canvasViewForPanel(hostedViews(), panel);
      setActiveViewId(view.id);
      setCanvasPanel(panel);
      if (dockMode() === "maximized") setDockMode("open");
      setWorkbenchFocusZone("canvas");
      touchedWorkspaceActiveView = true;
      touchedWorkspaceDock = true;
      hydrateWorkspaceView(view);
      refreshFocusRecord();
      return true;
    };
    const selectView = (viewId: string) => {
      const plan = planHostedViewActivation(hostedViews(), viewId, {
        filesLoaded: fileNodes().length > 0,
        diffLoaded: diffEntries().length > 0,
      });
      if (!plan.view || !plan.activeViewId) {
        setStatusNote(plan.note ?? "that view is no longer configured");
        return false;
      }
      const dockAlias = plan.view.layout ? null : dockTabForPanel(plan.view.panel);
      if (dockAlias) return activateDockTab(dockAlias);
      clearSelection();
      snapshotActiveWorkspaceView();
      const previousPanel = activePanel();
      if (previousPanel === "missions" && plan.view.panel !== "missions") {
        missionWorkspaceLoader.cancel();
        currentMissionsLoadIdentity = null;
      }
      runActivationEffects(plan.effects);
      const panel: "home" | "terminals" =
        plan.view.panel === "home" && !plan.view.layout ? "home" : "terminals";
      const canvasView = canvasViewForPanel(hostedViews(), panel);
      setActiveViewId(canvasView.id);
      touchedWorkspaceActiveView = true;
      setCanvasPanel(panel);
      if (dockMode() === "maximized") setDockMode("open");
      setWorkbenchFocusZone("canvas");
      touchedWorkspaceDock = true;
      hydrateWorkspaceView(canvasView);
      refreshFocusRecord();
      return true;
    };
    const activateDockTab = (tabId: WorkbenchDockTabId): boolean => {
      if (tabId === "activity") {
        // Activity is dock-only, so it does not travel through `selectView` (the
        // hosted-view activation path that normally snapshots the surface being
        // left). Capture it explicitly before the active-tab effect replaces a
        // pending debounced save with Activity's state.
        snapshotActiveWorkspaceView();
        setActiveDockTab("activity");
        setDockMode("open");
        setWorkbenchFocusZone("dock-body");
        touchedWorkspaceDock = true;
        loadMissionsWorkspace("activation");
        return true;
      }
      const panel: HostedPanelKind =
        tabId === "files" ? "files" : tabId === "changes" ? "diff" : "missions";
      const view = nativeHostedViewForPanel(hostedViews(), panel);
      snapshotActiveWorkspaceView();
      setActiveDockTab(tabId);
      setDockMode("open");
      setWorkbenchFocusZone("dock-body");
      touchedWorkspaceDock = true;
      runPanelActivation(panel);
      hydrateWorkspaceView(view);
      return true;
    };
    const selectPanel = (panel: HostedPanelKind) => {
      if (panel === "home" || panel === "terminals") return activateCanvasPanel(panel);
      const dockTab = dockTabForPanel(panel);
      return dockTab ? activateDockTab(dockTab) : false;
    };
    const setTab = (next: Tab) => {
      const panel = panelKindFromLegacyTab(next);
      if (panel) selectPanel(panel);
    };
    const panelGeneration = new PanelHostLoadGeneration();
    let panelHostResolved = false;
    const loadPanelHostForDir = (dir: string) => {
      const generation = panelGeneration.next();
      // Finish the old project's pending debounce against its still-live
      // repository before `beginLoad` invalidates that controller generation.
      flushWorkspaceUiState();
      if (workspaceUiSaveTimer) {
        clearTimeout(workspaceUiSaveTimer);
        workspaceUiSaveTimer = null;
      }
      touchedWorkspaceViewIds.clear();
      touchedWorkspaceSurfaceIds.clear();
      touchedWorkspaceDock = false;
      touchedWorkspaceActiveView = false;
      hydratedWorkspaceSurfaceIds.clear();
      const uiGeneration = workspaceUiController.beginLoad();
      missionWorkspaceLoader.cancel();
      currentMissionsLoadIdentity = null;
      setMissionWorkspaceSnapshot(null);
      setMissionWorkspaceLoad(invalidatedMissionWorkspaceLoadState());
      void resolveProjectConfigContext(dir)
        .then((context) => {
          if (!panelGeneration.isCurrent(generation)) return;
          const resolved = context.resolved;
          if (!resolved) return;
          const repository = createProjectRuntimeRepository(resolved.resolution);
          const loadedUi = loadWorkspaceUiState(repository);
          if (!workspaceUiController.completeLoad(uiGeneration, repository, loadedUi)) return;
          setWorkspaceUiState(loadedUi.state);
          const hasPersistedWorkspaceUi = !loadedUi.diagnostics.some((entry) =>
            ["MISSING", "READ_FAILED", "MALFORMED", "UNSUPPORTED_VERSION"].includes(entry.code),
          );
          const loadDiagnostic = loadedUi.diagnostics.find((entry) => entry.code !== "MISSING");
          if (loadDiagnostic) setStatusNote(loadDiagnostic.message);
          const previous = {
            id: activeViewId(),
            panel: activePanel(),
          };
          const nextViews = viewsFromResolvedConfig(resolved);
          const state = {
            filesLoaded: fileNodes().length > 0,
            diffLoaded: diffEntries().length > 0,
          };
          const identityChanged = currentWorkspaceUiIdentity !== repository.metadata.identityKey;
          currentWorkspaceUiIdentity = repository.metadata.identityKey;
          const firstProjectLoad = !panelHostResolved || identityChanged;
          const initialChoice = firstProjectLoad
            ? chooseInitialWorkspaceView(nextViews, {
                requestedPanel: !panelHostResolved ? requestedPanel : null,
                persisted: loadedUi.state,
                legacyLastTab: bareHome ? persisted.lastTab : null,
              })
            : null;
          const nextPlan = initialChoice
            ? {
                activeViewId: initialChoice.view?.id ?? null,
                view: initialChoice.view,
                effects:
                  initialChoice.view && previous.panel !== initialChoice.view.panel
                    ? hostedActivationEffects(initialChoice.view.panel, state)
                    : [],
                note: null,
              }
            : planHostedReconciledActivation(nextViews, previous, state);
          const nextCanvasPanel: "home" | "terminals" =
            curTarget() || requestedPanel
              ? "terminals"
              : nextPlan.view?.panel === "terminals" || nextPlan.view?.layout
                ? "terminals"
                : "home";
          const nextCanvasView = canvasViewForPanel(nextViews, nextCanvasPanel);
          setHostedViews(nextViews);
          runActivationEffects(nextPlan.effects);
          setActiveViewId(nextCanvasView.id);
          setCanvasPanel(nextCanvasPanel);
          const explicitDockTab = requestedPanel ? dockTabForPanel(requestedPanel) : null;
          const restoredDock = hasPersistedWorkspaceUi
            ? loadedUi.state.dock
            : {
                ...loadedUi.state.dock,
                activeTab: dockTabForPanel(nextPlan.view?.panel ?? "home") ?? "files",
                focusZone: dockTabForPanel(nextPlan.view?.panel ?? "home")
                  ? ("dock-body" as const)
                  : ("canvas" as const),
              };
          const restoredActiveDockTab = explicitDockTab ?? restoredDock.activeTab;
          setActiveDockTab(restoredActiveDockTab);
          setDockMode(explicitDockTab ? "open" : restoredDock.mode);
          setPreferredDockHeight(restoredDock.preferredHeight);
          setWorkbenchFocusZone(explicitDockTab ? "dock-body" : restoredDock.focusZone);
          setActivitySelectedId(loadedUi.state.surfaces.activity.selectedRowId);
          setActivityScrollOffset(loadedUi.state.surfaces.activity.scrollOffset);
          hydratedWorkspaceSurfaceIds.add("activity");
          hydrateActiveWorkspaceView({ firstProjectLoad });
          const restoredDockPanel = panelForDockTab(restoredActiveDockTab);
          if (restoredDockPanel !== "activity") {
            runPanelActivation(restoredDockPanel);
            const restoredDockView = nativeHostedViewForPanel(nextViews, restoredDockPanel);
            if (restoredDockView.id !== nextPlan.view?.id) {
              hydrateWorkspaceView(restoredDockView, { firstProjectLoad });
            }
          }
          if (
            restoredActiveDockTab === "missions" ||
            restoredActiveDockTab === "activity" ||
            nextPlan.view?.panel === "missions"
          ) {
            loadMissionsWorkspace("project");
          }
          panelHostResolved = true;
        })
        .catch((error) => {
          if (!panelGeneration.isCurrent(generation)) return;
          workspaceUiController.failLoad(uiGeneration);
          setWorkspaceUiState(defaultWorkspaceUiState());
          const nextViews = viewsFromResolvedConfig(null);
          const nextActive = canvasViewForPanel(nextViews, canvasPanel());
          setHostedViews(nextViews);
          setActiveViewId(nextActive.id);
          panelHostResolved = true;
          setStatusNote(`config views unavailable: ${(error as Error).message}`);
        });
    };
    createEffect(() => {
      loadPanelHostForDir(contextDir() || invokeCwd);
    });
    createEffect(() => {
      workspaceUiState();
      const repository = workspaceUiController.snapshot().repository;
      if (
        (activeDockTab() === "missions" ||
          activeDockTab() === "activity" ||
          mode() === "missions") &&
        repository &&
        repository.metadata.identityKey !== currentMissionsLoadIdentity
      ) {
        loadMissionsWorkspace("project");
      }
    });
    missionsRefreshTimer = setInterval(() => {
      if (
        activeDockTab() === "missions" ||
        activeDockTab() === "activity" ||
        mode() === "missions"
      ) {
        loadMissionsWorkspace("cadence");
      }
    }, 10_000);
    cleanupRegistry.set("missions-refresh-timer", () => {
      if (missionsRefreshTimer) clearInterval(missionsRefreshTimer);
    });

    // ── SELECT MODE on app-mouse panes (M22.9) ───────────────────────────────
    // Presses on a pane whose app enabled mouse reporting are FORWARDED, so a
    // drag can never start a selection there. `selectModePane` names the ONE
    // pane whose forwarding is paused (right-click → "Select text…", or the
    // palette twin); while set, presses/drags on that pane run the normal
    // selection machine and the wheel scrolls the LOCAL scrollback. The mode
    // ends on Escape, on a completed copy (commitMirrorCopy clears it), or when
    // focus leaves the pane. Shift-modified presses select WITHOUT the mode
    // when the terminal passes shift through (see RouteEvent.modifiers).
    const [selectModePane, setSelectModePane] = createSignal<string | null>(null);
    const enterSelectMode = (paneId: string) => {
      mirror?.focus(paneId);
      clearSelection();
      setSelectModePane(paneId);
      setStatusNote("select text: drag to copy · esc to exit");
    };
    const exitSelectMode = () => {
      if (selectModePane() === null) return;
      setSelectModePane(null);
      clearSelection();
    };
    // Focus leaving the pane clears the mode. The reactive panes() lags one
    // 8ms tick behind an enterSelectMode focus call, so only clear when the
    // mirror's SYNCHRONOUS focus agrees the pane lost focus (mirror.focus sets
    // it before the tick re-derives `active`). Window/session switches drop the
    // pane from panes() and move both focus answers — the mode clears then too.
    createEffect(() => {
      const sm = selectModePane();
      if (sm === null) return;
      const focused = panes().find((p) => p.active)?.id;
      if (focused && focused !== sm && mirror?.focusedPane() !== sm) exitSelectMode();
    });

    // ── IMPLICIT DRAG-SELECT DEFAULT (M24.2) ─────────────────────────────────
    // Select mode is the explicit escape hatch; the DEFAULT now follows the
    // pane. Where the fleet says an agent runs (the M22.3 agentByPane join), a
    // plain left drag SELECTS — the press is DEFERRED (`pendingPress`) so a
    // genuine click still reaches the app as one SGR press/release pair, and
    // NOTHING is forwarded once motion starts a selection. Other app-mouse
    // panes keep forwarding; shift inverts a pane's default (routePanePress);
    // the right-click toggle overrides per pane for the session (pruned when
    // the pane dies); `app.dragSelect` sets the policy, read once at boot like
    // the rest of the app config.
    const dragSelectPolicy = loadAppConfig().app.dragSelect;
    const dragOverrides = new Map<string, PaneDragDefault>();
    const paneDrag = (paneId: string): PaneDragDefault =>
      paneDragDefault(
        agentByPane().get(paneId),
        dragSelectPolicy,
        dragOverrides.get(paneId) ?? null,
      );
    /** Drop overrides for panes that no longer exist anywhere on the server
     *  (pane ids are server-global and never recycled, so a miss is a death,
     *  not a window switch). Piggybacks on the 3s fleet tick; one control-mode
     *  round-trip, only while overrides exist at all. */
    const pruneDragOverrides = () => {
      if (dragOverrides.size === 0 || !mirror) return;
      void mirror
        .command('list-panes -a -F "#{pane_id}"')
        .then((lines) => {
          const alive = new Set(lines.map((l) => l.trim()));
          for (const id of [...dragOverrides.keys()]) if (!alive.has(id)) dragOverrides.delete(id);
        })
        .catch(() => {});
    };

    // ── SCROLLBACK SEARCH (M20.3) ────────────────────────────────────────────
    // copy-mode's `/` finder, app-native. `search` is the live search SESSION: a
    // bottom-of-canvas input line owning the keyboard while open. `editing:true`
    // builds the query (Enter executes); `editing:false` is navigation (n/N cycle,
    // esc exits). Per-PANE results live in `paneSearches` keyed by pane id, so
    // switching focus keeps each pane's last query/matches/cursor until esc — the
    // render inverse/accent-tints a pane's matches straight from this map. Matches
    // are a snapshot of the pane's full buffer at Enter time (pure math in
    // search-model.ts); the jump converts the current match's buffer line to a
    // scrollOffset via `offsetForMatch`.
    interface PaneSearch {
      query: string;
      matches: SearchMatch[];
      current: number;
    }
    const [search, setSearch] = createSignal<{ query: string; editing: boolean } | null>(null);
    const [paneSearches, setPaneSearches] = createSignal<Map<string, PaneSearch>>(new Map());
    const terminalCanvasProjection = createMemo(() =>
      projectAgentTerminalCanvas({
        width: workbenchProjection().canvasBody.width,
        height: workbenchProjection().canvasBody.height,
        chromeRows: HEADER_ROWS,
        footerRows: search() ? 1 : 0,
      }),
    );
    const [hoveredTerminalPaneAction, setHoveredTerminalPaneAction] =
      createSignal<TerminalPaneChromeHoverTarget | null>(null);
    const [pressedTerminalPaneAction, setPressedTerminalPaneAction] =
      createSignal<TerminalPaneChromeActionTarget | null>(null);
    const clearTerminalPaneActionState = () => {
      if (hoveredTerminalPaneAction() !== null) setHoveredTerminalPaneAction(null);
      if (pressedTerminalPaneAction() !== null) setPressedTerminalPaneAction(null);
    };
    const terminalPaneChromeMetadata = createMemo(() => {
      const metadata = new Map<string, TerminalPaneChromeMetadata>();
      const appStatus = status();
      const appStatusTone: TerminalPaneChromeMetadata["statusTone"] = appStatus.startsWith("error")
        ? "blocked"
        : appStatus === "live"
          ? "done"
          : "working";
      for (const pane of panes()) {
        const agent = agentByPane().get(pane.id);
        metadata.set(pane.id, {
          // SessionMirror may add title/currentCommand descriptors later. Null
          // deliberately leaves that seam to the pure projection, which falls
          // back to the always-distinct live %pane_id today.
          title: agent?.displayName ?? agent?.kind ?? null,
          subtitle: agent
            ? `${agent.displayName ? `${agent.kind} · ` : ""}${curTarget()} · ${pane.id}`
            : `${curTarget()} · ${pane.id}`,
          status: agent?.statusText ?? agent?.state ?? appStatus,
          statusTone: agent?.state ?? appStatusTone,
          attention: agent?.state === "blocked" || (!agent && appStatusTone === "blocked"),
        });
      }
      return metadata;
    });
    const terminalPaneChromeLayout = createMemo(() =>
      projectTerminalPaneChrome({
        canvas: terminalCanvasProjection(),
        panes: panes(),
        metadataByPane: terminalPaneChromeMetadata(),
        hoveredAction: hoveredTerminalPaneAction(),
        pressedAction: pressedTerminalPaneAction(),
      }),
    );
    createEffect(() => {
      const paneIds = new Set(panes().map((pane) => pane.id));
      const terminalsActive = canvasPanel() === "terminals";
      const hovered = hoveredTerminalPaneAction();
      const pressed = pressedTerminalPaneAction();
      const nextHovered = reconcileTerminalPaneChromeActionTarget(
        hovered,
        paneIds,
        terminalsActive,
      );
      const nextPressed = reconcileTerminalPaneChromeActionTarget(
        pressed,
        paneIds,
        terminalsActive,
      );
      if (nextHovered !== hovered) setHoveredTerminalPaneAction(nextHovered);
      if (nextPressed !== pressed) setPressedTerminalPaneAction(nextPressed);
    });
    /** Exact tmux framebuffer dimensions, excluding shell tab chrome, focus rail,
     *  terminal chrome, and native workbench dock. Search overlays the last row. */
    const canvasCols = () => terminalCanvasProjection().framebuffer.width;
    const canvasRows = () => terminalCanvasProjection().framebuffer.height;

    // ── PASTE-BUFFER PICKER (M20.3) ──────────────────────────────────────────
    // The palette's second level: "Paste buffer…" swaps the action list for this
    // list of tmux paste buffers (null = normal palette, [] = loading/empty). Enter
    // shows the chosen buffer and routes its content through the normal paste path.
    const [paletteBuffers, setPaletteBuffers] = createSignal<TmuxBuffer[] | null>(null);

    // ── DRAG-RESIZE GESTURE (M19.3) ──────────────────────────────────────────
    // A separate gesture machine from text selection: a "down" on the sidebar/main
    // boundary starts a `sidebar` drag (updates `sidebarW`); a "down" on a pane
    // separator (a canvas gutter cell between two panes) starts a `border` drag
    // (emits absolute `resize-pane -x|-y` over the control client). Only ONE of
    // {selecting, dragging} is ever live — selection starts only from an IN-pane
    // down, a border drag only from a GUTTER down, so they never fight. `originCx/
    // originCy` are the canvas-local cell the border drag began at; `lastSize`
    // dedupes identical resize commands across drag ticks.
    // A scrollbar-thumb drag is the FOURTH drag-origin (after sidebar / border /
    // text-selection): a "down" on a thumb cell captures the surface + the
    // pointer's offset within the thumb, then each tick maps the pointer row to an
    // absolute scroll top via `dragTop`. `contentLen`/`viewH`/`col` are frozen at
    // press (stable for the drag); `top0` is the global y of the track's first row.
    type ScrollSurface =
      | { surface: "editor" }
      | { surface: "diff" }
      | { surface: "mirror"; paneId: string; scrollbackDepth: number };
    type DragState =
      | { kind: "sidebar" }
      | { kind: "border"; sep: Separator; originCx: number; originCy: number; lastSize: number }
      | {
          kind: "scrollbar";
          grabOffset: number;
          top0: number;
          contentLen: number;
          viewH: number;
          surface: ScrollSurface;
        };
    let dragging: DragState | null = null;

    // ── DEFERRED PRESS (M24.2) ───────────────────────────────────────────────
    // A left press on a select-default app-mouse pane is WITHHELD: if the
    // pointer leaves the press cell before release, the press becomes the
    // anchor of a normal selection (the app never sees any of it); if the
    // release lands in the same cell, the owed SGR press/release pair is
    // forwarded then — a click, which is how agents like claude are driven.
    // Coordinates are frozen at press so the forwarded pair is exactly the
    // cell the user pressed. `absCell`/`trimBase` freeze the press's ABSOLUTE
    // buffer cell (M25.6) so a selection born from the deferred press anchors
    // exactly where the button went down. Only one of {pendingPress, selecting,
    // dragging} is ever live.
    let pendingPress: {
      paneId: string;
      x: number;
      gy: number;
      cell: Cell;
      absCell: Cell;
      trimBase: number;
    } | null = null;
    // The pane whose app is OWED a release because its press was forwarded.
    // OpenTUI synthesizes SEVERAL release-type events per physical release
    // (drag-end, up, drop, up — measured live), so the release forward must be
    // debt-tracked: paid exactly ONCE, to the pane that got the down (wherever
    // the pointer is at release), and never for gestures we consumed locally.
    let forwardedDown: string | null = null;

    // ── RIGHT-CLICK CONTEXT MENU (M19.2) ─────────────────────────────────────
    // A small overlay opened at the pointer on a right-button press (SGR button
    // 2). Late-mounted inside <Show>, so — per the mouse landmine laws — it
    // carries NO per-item handlers; `route` checks `menu()` FIRST and maps clicks
    // to item rows by the same coordinate math the render lays out (menu-model).
    // Keyboard drives j/k+enter; destructive items rearm into a `menuConfirm`
    // (press y) state; input items (`rename`/`new file`) open an inline line via
    // `menuInput`. The concrete payload for the resolved region rides on the
    // state object; the side effects live in `runMenuAction`.
    interface MenuState {
      region: MenuRegion;
      title: string;
      items: MenuItem[];
      left: number;
      top: number;
      width: number;
      height: number;
      session?: string;
      sessionDir?: string | null;
      fileIndex?: number;
      filePath?: string;
      fileIsDir?: boolean;
      fileParent?: string;
      diffPath?: string;
      paneId?: string;
      windowIndex?: number;
      /** The sidebar agent row a menu targets (M23.1 lifecycle verbs). */
      agent?: AgentRowInput;
    }
    const [menu, setMenu] = createSignal<MenuState | null>(null);
    const [menuSel, setMenuSel] = createSignal(0);
    const [menuConfirm, setMenuConfirm] = createSignal<number | null>(null);
    const [menuInput, setMenuInput] = createSignal<string | null>(null);
    // The SUBMENU nesting level (M20.2): `menuSub` is the parent item index whose
    // `children` column is open (null = no submenu, keyboard drives the parent);
    // `menuSubSel` is the selection within that column. One level only.
    const [menuSub, setMenuSub] = createSignal<number | null>(null);
    const [menuSubSel, setMenuSubSel] = createSignal(0);
    // Assigned in onMount so a menu action (kill/rename session) can force an
    // early fleet re-poll instead of waiting out the 3s interval.
    let fleetRefresh: (() => void) | null = null;

    // Derived, io-free views over the one async fleet payload. `fleet` is the
    // sidebar's flat, deduped session list; `homeItems` is the HOME panel's row
    // list — live sessions first, then the registered-but-not-running projects
    // section (home-model.ts, pure); `rollup` is the header tally.
    const fleet = (): Array<{ name: string; status: AgentStatus }> =>
      projectsData()
        .flatMap((p) => p.sessions.map((s) => ({ name: s.name, status: s.status })))
        .filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
    // The sidebar AGENTS section (M22.2): every agent across the fleet, flattened
    // and sorted attention-first (blocked → working → done → idle). Deduped by
    // paneId in case a session surfaces under two projects (as `fleet` dedups by
    // name). Drives BOTH the sidebar rows and the palette's jump-agent actions,
    // so the two lists always agree on order. Pure logic lives in agent-rows.ts.
    const fleetAgents = createMemo<AgentRowInput[]>(() =>
      sortAgentRows(
        projectsData()
          .flatMap((p) => p.sessions.flatMap((s) => s.agents ?? []))
          .filter((a, i, arr) => arr.findIndex((b) => b.paneId === a.paneId) === i),
      ),
    );
    const activityRows = createMemo<ActivityRowDto[]>(() => {
      const agentRows: ActivityRowDto[] = fleetAgents().map((agent, index) => ({
        kind: "agent",
        id: `agent:${agent.paneId}`,
        sequence: activityOrderSequence(agent.since, index + 1),
        timestampText: agent.since
          ? (agentAgeLabel(agent.state, agent.since, Math.floor(Date.now() / 1000)) ?? "now")
          : "now",
        agent: agentDisplayKind(agent),
        message: agent.statusText ?? agent.state,
        detail: `${agent.session} · ${agent.paneId}`,
        status: agent.state,
        attention: agent.state === "blocked",
      }));
      const missionRows: ActivityRowDto[] = (missionWorkspaceSnapshot()?.history ?? [])
        .filter((entry) => entry.lastEvent !== null)
        .map((entry) => ({
          kind: "event" as const,
          id: `mission:${entry.mission.id}:${entry.lastEvent!.sequence}`,
          sequence: activityOrderSequence(entry.lastEvent!.timestamp, entry.lastEvent!.sequence),
          timestampText: entry.lastEvent!.timestamp.slice(11, 16),
          source: entry.mission.title,
          message: entry.lastEvent!.label,
          detail: entry.lastEvent!.reason,
          status:
            entry.outcome === "completed"
              ? ("done" as const)
              : entry.outcome === "failed"
                ? ("blocked" as const)
                : ("idle" as const),
          attention: entry.outcome === "failed",
        }));
      return [...agentRows, ...missionRows];
    });
    const activityProjection = createMemo(() => {
      const rows = activityRows();
      const load = missionWorkspaceLoad();
      return projectActivitySurface({
        width: dockSurfaceWidth(),
        height: dockSurfaceHeight(),
        state:
          rows.length > 0
            ? "ready"
            : load.status === "loading"
              ? "loading"
              : load.status === "error"
                ? "error"
                : "empty",
        rows,
        selectedRowId: activitySelectedId(),
        scrollOffset: activityScrollOffset(),
        message: load.status === "error" ? load.message : undefined,
      });
    });
    const moveActivitySelection = (delta: -1 | 1) => {
      const rows = orderActivityRows(activityRows());
      if (rows.length === 0) return;
      const current = rows.findIndex((row) => row.id === activitySelectedId());
      const nextIndex =
        current < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, current + delta));
      setActivitySelectedId(rows[nextIndex]!.id);
      hydratedWorkspaceSurfaceIds.add("activity");
      touchedWorkspaceSurfaceIds.add("activity");
    };

    // ── IN-APP ATTENTION (M25.1) ─────────────────────────────────────────────
    // The 3s fleet poll diffs the previous per-pane agent states against the
    // fresh payload (pure math in attention.ts); blocked/done flips for agents
    // NOT on the current screen (other workspace / other window / a non-
    // Terminal tab) surface as a status-strip note plus a brief flash on their
    // sidebar rows. First sight is graced — an app boot announces nothing.
    let attnPrev = new Map<string, AgentStatus>();
    const [attnFlash, setAttnFlash] = createSignal<ReadonlySet<string>>(new Set());
    let attnFlashTimer: ReturnType<typeof setTimeout> | null = null;
    const noteAttention = (projects: FleetProject[]) => {
      const agents: AttentionAgent[] = projects.flatMap((p) =>
        p.sessions.flatMap((s) =>
          (s.agents ?? []).map((a) => ({
            paneId: a.paneId,
            session: a.session,
            kind: a.kind,
            state: a.state,
          })),
        ),
      );
      const { transitions, next } = diffAttention(attnPrev, agents);
      attnPrev = next;
      const worthy = noteworthyTransitions(transitions, {
        tab: tab(),
        visiblePaneIds: tab() === "terminal" ? panes().map((p) => p.id) : [],
      });
      const line = attentionNoteLine(worthy);
      if (!line) return;
      setStatusNote(line);
      setAttnFlash(new Set(worthy.map((w) => w.paneId)));
      if (attnFlashTimer) clearTimeout(attnFlashTimer);
      attnFlashTimer = setTimeout(() => setAttnFlash(new Set()), ATTENTION_FLASH_MS);
    };

    // ── FOCUS HANDSHAKE (M25.1) ──────────────────────────────────────────────
    // The app publishes what it is showing — attached?, the mirrored session,
    // the on-screen pane ids — as a tmux SERVER option the chrome updater's
    // notify path reads (see notify.ts AppFocus for the option-vs-file
    // rationale). Refreshed on every fleet poll and on tab switches; the
    // record's `ts` plus the reader's staleness guard cover an app that died
    // without cleanup. Hosted attachment is probed (the cockpit keeps running
    // detached); a plain app IS the user's terminal, so it's attached while
    // it runs.
    const writeFocusRecord = (attached: boolean) => {
      const value = buildAppFocusValue({
        ts: Date.now(),
        attached,
        session: curTarget(),
        panes: tab() === "terminal" ? panes().map((p) => p.id) : [],
      });
      execFile("tmux", ["set-option", "-s", APP_FOCUS_OPTION, value], () => {});
    };
    const refreshFocusRecord = () => {
      if (!HOSTED) {
        writeFocusRecord(true);
        return;
      }
      execFile("tmux", ["list-clients", "-t", `=${APP_HOST_SESSION}`, "-F", "x"], (err, stdout) =>
        writeFocusRecord(!err && stdout.trim().length > 0),
      );
    };
    onCleanup(() => {
      if (attnFlashTimer) clearTimeout(attnFlashTimer);
      // Best-effort; the staleness guard is the real cleanup for a hard death.
      execFile("tmux", ["set-option", "-s", "-u", APP_FOCUS_OPTION], () => {});
    });

    // ── CLICK-TO-JUMP CONSUME (M25.1, hosted only) ───────────────────────────
    // A macOS banner click stamps @tmux_ide_app_jump on the host session (see
    // notify.ts notifierExecuteCommand) and switches the user's client to the
    // cockpit. The fleet poll consumes the stamp: unset it FIRST (never loop),
    // then open that session's workspace — which also serves the detached
    // case, where the switch-client had nobody to move but the next attach
    // should land on the session that needed input.
    const consumeJumpRequest = () => {
      if (!HOSTED) return;
      execFile(
        "tmux",
        ["show-option", "-t", APP_HOST_SESSION, "-qv", APP_JUMP_OPTION],
        (err, stdout) => {
          const target = err ? "" : stdout.trim();
          if (!target) return;
          execFile("tmux", ["set-option", "-t", APP_HOST_SESSION, "-u", APP_JUMP_OPTION], () => {
            openWorkspace(target, dirForSession(target));
          });
        },
      );
    };
    const homeItems = createMemo<HomeItem[]>(() => buildHomeItems(projectsData(), recentFolders()));
    /** Whether (gy, x) hits the welcome action row (only while first-run). */
    const welcomeActionHit = (gy: number, x: number): boolean => {
      return (
        homeActionAtProjection(homeSurfaceProjection(), x, gy, sidebarW(), 0)?.source === "welcome"
      );
    };
    /** The home item index under content-row gy (accounting for the welcome
     *  offset), or -1 when gy is above the first row / on the welcome block. */
    const homeItemIndexAt = (gy: number): number => {
      return homeItemIndexAtProjection(homeSurfaceProjection(), sidebarW(), gy, sidebarW(), 0);
    };
    const rollup = (): FleetRollup => {
      const r: FleetRollup = {
        blocked: 0,
        working: 0,
        done: 0,
        idle: 0,
        unknown: 0,
        sessions: 0,
        projects: projectsData().length,
      };
      for (const p of projectsData())
        for (const s of p.sessions) {
          r[s.status] += 1;
          r.sessions += 1;
        }
      return r;
    };
    const clampedSel = () => clampSelectable(homeItems(), sel());
    /** The selected home item (never a header — clampSelectable skips them). */
    const selectedHomeItem = (): HomeItem | undefined => homeItems()[clampedSel()];
    /** The selected item's project dir, for the diff/new-session verbs. */
    const selectedHomeDir = (): string | null => {
      const it = selectedHomeItem();
      return it && it.kind !== "header" ? it.dir : null;
    };
    const detailLine = (): string => {
      const r = selectedHomeItem();
      if (!r) return "no live sessions — press f to open a folder";
      if (r.kind === "project")
        return `${r.dir ?? "no dir"} · registered, not running — enter/click launches it`;
      if (r.kind === "recent") return `${r.dir} · recently opened — enter/click reopens it here`;
      if (r.kind === "header") return "";
      const w = `${r.windows} window${r.windows === 1 ? "" : "s"}`;
      return `${r.project}${r.dir ? ` · ${r.dir}` : ""} · ${w} · ${r.status}`;
    };
    const homeFooter = (): string =>
      homeFooterHints()
        .map((h) => `${h.keys} ${h.label}`)
        .join("   ");
    // A path-input line on HOME (`o` to open). null = not prompting.
    const [pathPrompt, setPathPrompt] = createSignal<string | null>(null);
    // A session-name input line on HOME (`n` / the [n new session] chip).
    const [sessionPrompt, setSessionPrompt] = createSignal<string | null>(null);
    const homeSurfaceProjection = createMemo(() =>
      projectHomeSurface({
        width: workbenchProjection().canvasBody.width,
        height: workbenchProjection().canvasBody.height,
        projects: projectsData(),
        items: homeItems(),
        selectedIndex: clampedSel(),
        hovered:
          hover()?.region === "home" ||
          hover()?.region === "homechip" ||
          hover()?.region === "homeagentchip" ||
          hover()?.region === "welcomeopen" ||
          hover()?.region === "button"
            ? (hover() as {
                region: "home" | "homechip" | "homeagentchip" | "welcomeopen" | "button";
                index: number;
              })
            : null,
        rollup: rollup(),
        detail: detailLine(),
        footerHint: homeFooter(),
        sessionPrompt: sessionPrompt(),
        pathPrompt: pathPrompt(),
        quitHint: QUIT_HINT,
        welcomeLine: WELCOME_LINE,
        welcomeActionLabel: WELCOME_ACTION_LABEL,
        welcomeTip,
      }),
    );
    const scrollOffsets = new Map<string, number>();
    let dirty = false;
    const markDirty = () => {
      dirty = true;
    };

    // ── EDITOR (M18.2) ──────────────────────────────────────────────────────
    // The native EditBuffer holds text + cursor; Solid can't see its mutations,
    // so `editorRev` is bumped after every edit to re-derive `editorLines`.
    let editBuffer: EditBuffer | null = null;
    let prevMode: "home" | "mirror" = "home";
    const [editorPath, setEditorPath] = createSignal<string | null>(null);
    const [editorRev, setEditorRev] = createSignal(0);
    const [editorTop, setEditorTop] = createSignal(0);
    const [editorModified, setEditorModified] = createSignal(false);
    const [editorReadOnly, setEditorReadOnly] = createSignal<ReadOnlyReason>(null);
    const [editorMsg, setEditorMsg] = createSignal("");

    // Visible text rows = full height minus tab bar (1) + header (1) + rule/banner
    // (1) + footer (1).
    const editorRows = () => Math.max(1, dockSurfaceHeight() - 3);
    const editorLines = createMemo<string[]>(() => {
      editorRev();
      if (!editBuffer) return [""];
      return editBuffer.getText().split("\n");
    });
    const editorCursor = createMemo<{ row: number; col: number }>(() => {
      editorRev();
      if (!editBuffer) return { row: 0, col: 0 };
      const c = editBuffer.getCursorPosition();
      return { row: c.row, col: c.col };
    });
    // The exact rows on screen, each tagged with its 1-based number and (for the
    // cursor line) the column where the inverse cursor cell is drawn.
    const editorVisible = createMemo<{ num: number; text: string; cursorCol: number | null }[]>(
      () => {
        const lines = editorLines();
        const rows = editorRows();
        const top = clampTop(editorTop(), lines.length, rows);
        const cur = editorCursor();
        const out: { num: number; text: string; cursorCol: number | null }[] = [];
        for (let i = top; i < Math.min(lines.length, top + rows); i++) {
          out.push({ num: i + 1, text: lines[i] ?? "", cursorCol: i === cur.row ? cur.col : null });
        }
        return out;
      },
    );

    const openEditor = (rawPath: string, line?: number) => {
      const path = rawPath.startsWith("~/")
        ? `${process.env.HOME ?? ""}${rawPath.slice(1)}`
        : rawPath;
      let bytes: Uint8Array;
      try {
        bytes = readFileSync(path);
      } catch (e) {
        setEditorMsg(`cannot open: ${(e as Error).message}`);
        return;
      }
      const reason = classifyFile(bytes.length, isBinary(bytes));
      const text =
        reason === "binary" ? sanitizeForDisplay(bytes) : Buffer.from(bytes).toString("utf8");
      editBuffer?.destroy();
      editBuffer = EditBuffer.create("wcwidth");
      editBuffer.setText(text);
      editBuffer.setCursor(0, 0);
      // Jump target (M24.5: ^e from a diff hunk): clamp into the buffer, put
      // the cursor there, and scroll it into view.
      let top = 0;
      if (line !== undefined) {
        const lineCount = text.split("\n").length;
        const target = Math.max(0, Math.min(line, lineCount - 1));
        editBuffer.setCursor(target, 0);
        top = scrollToCursor(target, 0, editorRows(), lineCount);
      }
      if (mode() !== "editor") prevMode = mode() === "mirror" ? "mirror" : "home";
      setEditorPath(path);
      setEditorReadOnly(reason);
      setEditorModified(false);
      setEditorTop(top);
      setEditorMsg("");
      setEditorRev((r) => r + 1);
      setFilesFocus("editor");
      if (activePanel() !== "files") setTab("files");
    };

    const toggleEditor = () => {
      if (!editBuffer) return; // nothing opened yet
      if (mode() === "editor") setTab(prevMode === "mirror" ? "terminal" : "home");
      else {
        prevMode = mode() === "mirror" ? "mirror" : "home";
        setTab("files");
      }
    };

    const saveEditor = () => {
      const path = editorPath();
      if (!editBuffer || !path || editorReadOnly()) return;
      try {
        const tmp = `${path}.zz-tmp-${process.pid}`;
        writeFileSync(tmp, editBuffer.getText());
        renameSync(tmp, path);
        setEditorModified(false);
        setEditorMsg("saved");
      } catch (e) {
        setEditorMsg(`save failed: ${(e as Error).message}`);
      }
    };

    const editorSyncScroll = () => {
      const c = editBuffer!.getCursorPosition();
      setEditorTop((t) => scrollToCursor(c.row, t, editorRows(), editorLines().length));
    };

    /** Feed one key to the editor buffer. Ctrl combos (^s/^e/^g/^q/^z/^y) are
     *  handled by the caller; this owns navigation + insertion. */
    const editorKey = (evt: { name: string; ctrl: boolean; meta: boolean; shift: boolean }) => {
      const eb = editBuffer;
      if (!eb) return;
      const ro = editorReadOnly() !== null;
      const rows = editorRows();
      const name = evt.name;
      if (name === "up") eb.moveCursorUp();
      else if (name === "down") eb.moveCursorDown();
      else if (name === "left") eb.moveCursorLeft();
      else if (name === "right") eb.moveCursorRight();
      else if (name === "home") {
        const c = eb.getCursorPosition();
        eb.setCursor(c.row, 0);
      } else if (name === "end") {
        eb.setCursorByOffset(eb.getEOL().offset);
      } else if (name === "pageup") {
        for (let i = 0; i < rows; i++) eb.moveCursorUp();
      } else if (name === "pagedown") {
        for (let i = 0; i < rows; i++) eb.moveCursorDown();
      } else if (!ro && name === "return") {
        eb.newLine();
        setEditorModified(true);
      } else if (!ro && name === "backspace") {
        eb.deleteCharBackward();
        setEditorModified(true);
      } else if (!ro && name === "delete") {
        eb.deleteChar();
        setEditorModified(true);
      } else if (!ro && name === "space" && !evt.ctrl && !evt.meta) {
        // OpenTUI names the key "space", not " " — without this branch the
        // editor could not insert spaces at all (found by the M24.6 battery;
        // same trap the dialog stack hit in M24.1).
        eb.insertText(" ");
        setEditorModified(true);
      } else if (!ro && name.length === 1 && !evt.ctrl && !evt.meta) {
        eb.insertText(evt.shift ? name.toUpperCase() : name);
        setEditorModified(true);
      } else {
        return; // unhandled key: no re-render, no scroll churn
      }
      editorSyncScroll();
      setEditorRev((r) => r + 1);
    };

    // ── DIFF (M18.3; grouped + stage-aware M24.5) ───────────────────────────
    // The working-tree diff of `diffDir`, rendered natively as a GROUPED list
    // (Staged / Unstaged / Untracked; an MM file appears in both stage groups,
    // each side diffing its own half of the index). Git runs via async execFile
    // (`runGit`); the only sync io is reading a single untracked file to show it
    // as additions. `diffText` holds the raw diff for the selected file;
    // `diffLoadToken` discards a slow diff whose selection has since moved on,
    // `diffStatusToken` a stale status/numstat merge (same race discipline).
    const [diffDir, setDiffDir] = createSignal(values.diff ?? invokeCwd);
    const [diffEntries, setDiffEntries] = createSignal<DiffEntry[]>([]);
    const [diffSel, setDiffSel] = createSignal(0);
    const [diffText, setDiffText] = createSignal("");
    const [diffTop, setDiffTop] = createSignal(0); // diff-pane scroll (right)
    const [diffFileTop, setDiffFileTop] = createSignal(0); // file-list scroll (left, in ROWS)
    const [diffMsg, setDiffMsg] = createSignal("");
    // The `/` filter over the grouped file list (diff surface only — Terminal's
    // `/` scrollback search is a different mode branch). null = off; while
    // non-null every printable key narrows live, escape/return clear + exit.
    const [diffFilter, setDiffFilter] = createSignal<string | null>(null);
    let diffLoadToken = 0;
    let diffStatusToken = 0;
    // A diff file to re-select once `git status` repopulates the list: the
    // persisted path on restore, or a verb's follow target — path + preferred
    // group, so a just-staged file is re-selected in its NEW section.
    let pendingDiffFile: string | null = null;
    let pendingDiffGroup: DiffGroup | null = null;

    // Body rows below header (1) + rule (1), above the footer (1) — shared by both
    // columns. The left column width is a capped fraction of the canvas.
    const diffBodyRows = () => Math.max(1, changesBodyRows(dockSurfaceHeight()));
    const diffListW = () => changesListWidth(dockSurfaceWidth());
    const diffLines = createMemo(() => classifyDiff(diffText()));
    // Grouped rows (section headers + files) and the flat selectable-file order,
    // both from ONE buildDiffRows pass over the filtered entries: the render,
    // the mouse router, and the selection all walk the SAME rows, so the hit
    // math cannot drift from what's drawn (the AGENTS_GAP_ROWS lesson).
    const diffRowsData = createMemo(() =>
      buildDiffRows(filterDiffEntries(diffEntries(), diffFilter() ?? "")),
    );
    const diffRows = () => diffRowsData().rows;
    const diffVisibleFiles = () => diffRowsData().files;
    const diffTotals = createMemo(() => totalCounts(diffVisibleFiles()));
    const diffVisible = createMemo(() => {
      const lines = diffLines();
      const rows = diffBodyRows();
      const top = clampTop(diffTop(), lines.length, rows);
      return lines.slice(top, top + rows);
    });
    const fileVisible = createMemo(() => {
      const rows = diffRows();
      const view = diffBodyRows();
      const top = clampTop(diffFileTop(), rows.length, view);
      return rows.slice(top, top + view).map((row, i) => ({ row, rowIndex: top + i }));
    });
    const changesSurfaceProjection = createMemo(() =>
      projectChangesSurface({
        width: dockSurfaceWidth(),
        height: dockSurfaceHeight(),
        dir: diffDir(),
        fileCount: diffVisibleFiles().length,
        totals: diffTotals(),
        filterQuery: diffFilter(),
        message: diffMsg(),
        listRows: fileVisible(),
        selectedFileIndex: diffSel(),
        diffLines: diffVisible(),
        hovered:
          hover()?.region === "diff" ||
          hover()?.region === "diffverb" ||
          hover()?.region === "button"
            ? (hover() as
                | { region: "diff"; index: number }
                | { region: "diffverb"; index: number }
                | { region: "button"; index: number })
            : null,
        footerHint: `]/[ hunk · ^e edit · / filter · r refresh · ^g home · ${QUIT_HINT}`,
      }),
    );

    const runGit = (args: string[], cb: (out: string) => void) => {
      execFile(
        "git",
        ["-C", diffDir(), "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", ...args],
        { timeout: 10_000, maxBuffer: 16_000_000 },
        (err, stdout) => cb(err ? "" : stdout),
      );
    };
    const runGitP = (args: string[]) => new Promise<string>((resolve) => runGit(args, resolve));

    /** Load the diff for one entry, by its GROUP: staged rows diff `--cached`,
     *  unstaged rows the worktree, and an untracked file's contents render as
     *  additions. Guarded by `diffLoadToken` against races. */
    const loadDiff = (entry: DiffEntry) => {
      const token = ++diffLoadToken;
      setDiffMsg("");
      if (entry.group === "untracked") {
        try {
          const bytes = readFileSync(join(diffDir(), entry.path));
          if (isBinary(bytes)) {
            setDiffText("");
            setDiffMsg("binary file");
          } else {
            setDiffText(untrackedDiffText(Buffer.from(bytes).toString("utf8")));
          }
        } catch (e) {
          setDiffText("");
          setDiffMsg(`cannot read: ${(e as Error).message}`);
        }
        return;
      }
      const args =
        entry.group === "staged"
          ? ["diff", "--no-color", "--cached", "--", entry.path]
          : ["diff", "--no-color", "--", entry.path];
      runGit(args, (out) => {
        if (token !== diffLoadToken) return;
        setDiffText((p) => (p === out ? p : out));
      });
    };

    /** Select FILE `i` (an index into the flat selectable order — section
     *  headers are not selectable): highlight it, reset the diff scroll, keep
     *  its ROW in view in the file list, and (re)load its diff. */
    const selectDiffFile = (i: number) => {
      const files = diffVisibleFiles();
      if (files.length === 0) return;
      const idx = clampSel(i, files.length);
      setDiffSel(idx);
      setDiffTop(0);
      const rows = diffRows();
      const rowIdx = rowIndexOfFile(rows, idx);
      if (rowIdx !== -1)
        setDiffFileTop((t) => scrollToCursor(rowIdx, t, diffBodyRows(), rows.length));
      loadDiff(files[idx]!);
    };
    const moveDiffSel = (delta: number) => selectDiffFile(diffSel() + delta);

    /** After a filter mutation: select the first match (reloading its diff), or
     *  clear the diff pane when nothing matches. */
    const diffFilterReselect = () => {
      if (diffVisibleFiles().length === 0) {
        setDiffSel(0);
        setDiffText("");
      } else {
        selectDiffFile(0);
      }
    };

    /** Re-run `git status --porcelain` + both `--numstat`s (and untracked line
     *  counts via async reads), merge counts into the grouped entries, reconcile
     *  the selection, and reload the selected file's diff (so an external edit
     *  is reflected). Fully async; one race token guards the whole merge. */
    const refreshStatus = () => {
      const token = ++diffStatusToken;
      const dir = diffDir();
      void (async () => {
        const [statusOut, unstagedOut, stagedOut] = await Promise.all([
          runGitP(["status", "--porcelain"]),
          runGitP(["diff", "--numstat"]),
          runGitP(["diff", "--numstat", "--cached"]),
        ]);
        if (token !== diffStatusToken) return;
        let entries = parseStatusGroups(statusOut);
        // Untracked ± = the file's line count (binaries skipped; the reads are
        // capped so a giant fresh tree can't fan out thousands of opens).
        const untrackedCounts = new Map<string, number>();
        await Promise.all(
          entries
            .filter((e) => e.group === "untracked")
            .slice(0, 200)
            .map(async (e) => {
              try {
                const bytes = await readFile(join(dir, e.path));
                if (!isBinary(bytes))
                  untrackedCounts.set(e.path, untrackedLineCount(bytes.toString("utf8")));
              } catch {
                /* unreadable: counts stay null */
              }
            }),
        );
        if (token !== diffStatusToken) return;
        entries = applyCounts(
          entries,
          parseNumstat(stagedOut),
          parseNumstat(unstagedOut),
          untrackedCounts,
        );
        setDiffEntries(entries);
        const files = diffVisibleFiles();
        if (files.length === 0) {
          setDiffText("");
          setDiffSel(0);
          if (entries.length === 0) setDiffMsg("working tree clean");
          return;
        }
        // Re-select a followed file: a verb's target in its NEW group (a staged
        // file moves to Staged), or the persisted path on restore.
        if (pendingDiffFile) {
          const path = pendingDiffFile;
          const group = pendingDiffGroup;
          pendingDiffFile = null;
          pendingDiffGroup = null;
          const exact = group ? files.findIndex((f) => f.path === path && f.group === group) : -1;
          const found = exact !== -1 ? exact : files.findIndex((f) => f.path === path);
          if (found !== -1) {
            selectDiffFile(found);
            return;
          }
        }
        const idx = clampSel(diffSel(), files.length);
        setDiffSel(idx);
        loadDiff(files[idx]!);
      })();
    };

    // ── Stage/unstage verbs (M24.5) ─────────────────────────────────────────
    // Reversible operations, so no confirms — each verb notes what it did,
    // follows the file into its new group, and refreshes (git is the truth).
    const stageEntry = (e: DiffEntry) => {
      if (e.group === "staged") {
        setStatusNote("already staged");
        return;
      }
      runGit(["add", "--", e.path], () => {
        pendingDiffFile = e.path;
        pendingDiffGroup = "staged";
        setStatusNote(`staged ${e.path}`);
        refreshStatus();
      });
    };
    const unstageEntry = (e: DiffEntry) => {
      if (e.group !== "staged") {
        setStatusNote("not staged");
        return;
      }
      runGit(["reset", "HEAD", "--", e.path], () => {
        pendingDiffFile = e.path;
        pendingDiffGroup = "unstaged";
        setStatusNote(`unstaged ${e.path}`);
        refreshStatus();
      });
    };
    const toggleStageEntry = (e: DiffEntry) =>
      e.group === "staged" ? unstageEntry(e) : stageEntry(e);
    const stageAll = () => {
      const cur = diffVisibleFiles()[diffSel()];
      runGit(["add", "-A"], () => {
        if (cur) {
          pendingDiffFile = cur.path;
          pendingDiffGroup = "staged";
        }
        setStatusNote("staged all changes");
        refreshStatus();
      });
    };
    const unstageAll = () => {
      const cur = diffVisibleFiles()[diffSel()];
      runGit(["reset", "HEAD"], () => {
        if (cur) {
          pendingDiffFile = cur.path;
          pendingDiffGroup = cur.group === "staged" ? "unstaged" : cur.group;
        }
        setStatusNote("unstaged all");
        refreshStatus();
      });
    };

    /** `]`/`[` — jump the diff view to the next/previous hunk header. */
    const jumpHunk = (dir: 1 | -1) => {
      const lines = diffLines();
      const cur = clampTop(diffTop(), lines.length, diffBodyRows());
      const next = nextHunkTop(lines, cur, dir);
      if (next !== null) setDiffTop(clampTop(next, lines.length, diffBodyRows()));
    };

    /** ^e from the diff panel: open the selected file in the editor AT the
     *  first changed line of the selected (top-visible) hunk — pure math in
     *  hunkEditTarget; diffs without hunks (binary/untracked) open at 0. */
    const openSelectedInEditor = () => {
      const entry = diffVisibleFiles()[diffSel()];
      if (!entry) return;
      const lines = diffLines();
      const target = hunkEditTarget(lines, clampTop(diffTop(), lines.length, diffBodyRows()));
      openEditor(join(diffDir(), entry.path), target ?? undefined);
    };

    /** Enter the diff panel for `dir` (from home `d`, the Diff tab, or `--diff`
     *  on boot). */
    const prepareDiff = (dir: string) => {
      setDiffDir(dir);
      setDiffSel(0);
      setDiffTop(0);
      setDiffFileTop(0);
      setDiffText("");
      setDiffMsg("");
      setDiffFilter(null);
      refreshStatus();
    };
    const enterDiff = (dir: string) => {
      prepareDiff(dir);
      setTab("diff");
    };

    const runChangesAction = (id: ChangesActionId, fileIndex = diffSel()) => {
      if (id === "refresh") refreshStatus();
      else if (id === "stage-all") stageAll();
      else if (id === "unstage-all") unstageAll();
      else {
        const entry = diffVisibleFiles()[fileIndex];
        if (!entry) return;
        if (id === "stage" || id === "row-stage") stageEntry(entry);
        else if (id === "unstage" || id === "row-unstage") unstageEntry(entry);
      }
    };
    let mirror: SessionMirror | null = null;
    // ── EVENT-DRIVEN RE-PIN (M23.5) ──────────────────────────────────────────
    // The native Workbench projection is the sole pin source. `lastPin` remains
    // null until a non-zero framebuffer exists; a hidden/maximized dock never
    // shrinks the real tmux window to a destructive synthetic 1x1 size.
    let lastPin: Size | null = terminalCanvasProjection().tmuxSize;
    let repinInFlight: RepinState | null = null;
    let pendingAttachTarget: string | null = null;
    const attach = (name: string) => {
      const pin = terminalCanvasProjection().tmuxSize ?? lastPin;
      if (!pin) {
        pendingAttachTarget = name;
        setStatus(`waiting for terminal canvas to attach ${name}…`);
        return;
      }
      pendingAttachTarget = null;
      mirror?.dispose();
      scrollOffsets.clear();
      setPanes([]);
      setStatus(`attaching ${name}…`);
      // A fresh mirror pins at the current canvas size — no re-pin in flight.
      lastPin = pin;
      repinInFlight = null;
      const m = new SessionMirror({
        target: name,
        cols: pin.cols,
        rows: pin.rows,
        onDirty: markDirty,
        onStatus: () => {
          markDirty();
          void m.windows().then(setWindowTabs);
        },
        onExit: () => setStatus("control client exited"),
      });
      mirror = m;
      void m
        .start()
        .then(() => {
          setStatus("live");
          void m.windows().then(setWindowTabs);
        })
        .catch((e) => setStatus(`error: ${(e as Error).message}`));
    };
    createEffect(() => {
      const next = terminalCanvasProjection().tmuxSize;
      // A maximized layout can hide the framebuffer entirely. Keep the live
      // tmux window at its last visible size until the canvas returns.
      if (!next) return;
      if (pendingAttachTarget && !mirror) {
        const targetName = pendingAttachTarget;
        lastPin = next;
        attach(targetName);
        return;
      }
      if (lastPin && next.cols === lastPin.cols && next.rows === lastPin.rows) return;
      if (lastPin) repinInFlight = { prev: lastPin, at: performance.now() };
      lastPin = next;
      void mirror?.resize(next.cols, next.rows);
    });
    /** Re-query the mirrored session's windows into `windowTabs` — used after a
     *  NON-structural change tmux won't notify us about (a `synchronize-panes`
     *  toggle) so the `[SYNC]` chip and the menu checkbox reflect it promptly. */
    const refreshWindows = () => void mirror?.windows().then(setWindowTabs);
    /** The active window's `synchronize-panes` state (the toggle's live value). */
    const syncOn = () => windowTabs().find((w) => w.active)?.sync ?? false;

    /** Switch the Terminal tab's target. CRITICAL for the IDE feel: attaching the
     *  SAME session we're already mirroring must NOT re-create the control client
     *  — that would drop scrollback and blink the pane. So a same-target switch is
     *  a pure tab flip; only a DIFFERENT session (re)attaches. */
    const switchTarget = (name: string) => {
      clearSelection();
      if (name === curTarget() && mirror) {
        selectPanel("terminals");
        refreshFocusRecord();
        return;
      }
      setCurTarget(name);
      selectPanel("terminals");
      attach(name);
      refreshFocusRecord();
    };
    /** ^g / F1 — show the HOME tab. The mirror is KEPT ALIVE (it keeps streaming
     *  in the background so a back-switch is instant); the session is untouched. */
    const goHome = () => {
      clearSelection();
      setTab("home");
      refreshFocusRecord();
    };

    // ── FILES TAB (M18.4, uplifted M24.6) ────────────────────────────────────
    // An expandable file list (left) beside the M18.2 editor (right), rooted at
    // the workspace dir. `fs.readdir` and every git call are ALWAYS async (the
    // render-loop landmine); ordering, ignore/hidden filtering, git-status
    // decoration, the changed-file walk, the `/` filter view and the expansion-
    // preserving rebuild are all pure in file-tree.ts. Ignore rules come from
    // the workspace's .gitignore via the `ignore` package (matching is pure;
    // only the file read is io). SELECTION indexes the VISIBLE (filtered) rows;
    // expansion math maps back to the underlying flat list via FilteredRow.index.
    const [fileNodes, setFileNodes] = createSignal<FileNode[]>([]);
    const [fileSel, setFileSel] = createSignal(0);
    const [fileTop, setFileTop] = createSignal(0);
    // The H / I visibility toggles — persisted in app-state (default: hidden).
    const [showHiddenFiles, setShowHiddenFiles] = createSignal(persisted.filesShowHidden);
    const [showIgnoredFiles, setShowIgnoredFiles] = createSignal(persisted.filesShowIgnored);
    // Git decoration: porcelain entries for the workspace repo + its toplevel
    // (status paths are REPO-relative — the workspace dir may sit deeper).
    const [fileStatusEntries, setFileStatusEntries] = createSignal<StatusEntry[]>([]);
    const [filesGitTop, setFilesGitTop] = createSignal<string | null>(null);
    // The `/` filter: null = off, "" = filter mode just opened. The selection
    // to restore when the filter is escaped lives beside it (not reactive).
    const [filesQuery, setFilesQuery] = createSignal<string | null>(null);
    let filesPreFilterPath: string | null = null;
    let pendingFilesSelectionPath: string | null = null;
    // Which half of the Files tab has the keyboard: the file LIST (j/k/enter) or
    // the EDITOR (typing). Opening a file hands focus to the editor; esc hands it
    // back to the list.
    const [filesFocus, setFilesFocus] = createSignal<"list" | "editor">("list");
    const filesListW = () => filesListWidth(dockSurfaceWidth());
    /** The workspace directory driving both the file list and the diff panel. */
    const workspaceDir = () => contextDir() || invokeCwd;
    const fileStatusMap = createMemo(() => statusMapFromEntries(fileStatusEntries()));
    const changedWalk = createMemo(() =>
      changedFileWalk(fileStatusEntries(), { showHidden: showHiddenFiles() }),
    );
    /** The rows the list actually shows: the flat tree through the `/` filter. */
    const visibleFiles = createMemo(() => filterView(fileNodes(), filesQuery()));
    const fileListVisible = createMemo(() => {
      const rows = visibleFiles();
      const view = editorRows();
      const top = clampTop(fileTop(), rows.length, view);
      return rows.slice(top, top + view).map((row, i) => ({ node: row.node, index: top + i }));
    });
    /** The status letter for a node (repo-relative lookup incl. propagated
     *  ancestor letters), or null outside a repo / for a clean path. */
    const fileStatusFor = (n: FileNode): string | null => {
      const top = filesGitTop();
      if (!top) return null;
      const rel = relPath(top, n.path);
      return rel ? (fileStatusMap().get(rel) ?? null) : null;
    };
    const filesSurfaceProjection = createMemo(() =>
      projectFilesSurface({
        width: dockSurfaceWidth(),
        height: dockSurfaceHeight(),
        workspaceDir: workspaceDir(),
        editorPath: editorPath(),
        editorModified: editorModified(),
        editorCursor: editorCursor(),
        editorLineCount: editorLines().length,
        editorMessage: editorMsg(),
        readOnly: editorReadOnly(),
        filterQuery: filesQuery(),
        focus: filesFocus(),
        showHidden: showHiddenFiles(),
        showIgnored: showIgnoredFiles(),
        visibleRows: fileListVisible(),
        totalRows: visibleFiles().length,
        fileSelection: fileSel(),
        fileTop: fileTop(),
        editorVisible: editorVisible(),
        editorTop: editorTop(),
        editorTotalLines: editorLines().length,
        hovered:
          hover()?.region === "files" || hover()?.region === "button"
            ? (hover() as { region: "files" | "button"; index: number })
            : null,
        statusFor: fileStatusFor,
        readOnlyBanner: readOnlyBanner(editorReadOnly()),
        footerBase: `j/k · enter open · [/] change · / filter · H dot:${
          showHiddenFiles() ? "on" : "off"
        } · I ign:${showIgnoredFiles() ? "on" : "off"} · ^s save · esc list · ^g home · ${QUIT_HINT}`,
      }),
    );

    // The gitignore matcher for the CURRENT workspace root (reloaded when the
    // root changes or the tree refreshes — cheap: one small file read).
    let filesIg: Ignore = ignore();
    let filesIgDir = "";
    const loadIgnoreRules = async (root: string): Promise<void> => {
      const ig = ignore();
      try {
        ig.add(await readFile(join(root, ".gitignore"), "utf8"));
      } catch {
        // no .gitignore — everything passes
      }
      filesIg = ig;
      filesIgDir = root;
    };
    /** Async list of `dir`, annotated with the gitignore verdict and filtered
     *  through the current H/I toggles (pure filterEntries). */
    const listDir = async (dir: string): Promise<RawEntry[]> => {
      const root = workspaceDir();
      if (filesIgDir !== root) await loadIgnoreRules(root);
      const ents = await readdir(dir, { withFileTypes: true });
      const raw: RawEntry[] = ents.map((e) => {
        const isDir = e.isDirectory();
        const rel = relPath(root, join(dir, e.name));
        let ignored = false;
        if (rel) {
          try {
            ignored = filesIg.ignores(isDir ? `${rel}/` : rel);
          } catch {
            // malformed path for the matcher — treat as not ignored
          }
        }
        return { name: e.name, isDir, ignored };
      });
      return filterEntries(raw, {
        showHidden: showHiddenFiles(),
        showIgnored: showIgnoredFiles(),
      });
    };

    /** Re-run `git status --porcelain` for the workspace (async; also resolves
     *  the repo toplevel the porcelain paths are relative to). */
    const runGitFiles = (args: string[], cb: (out: string) => void) => {
      execFile(
        "git",
        ["-C", workspaceDir(), "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", ...args],
        { timeout: 10_000, maxBuffer: 16_000_000 },
        (err, stdout) => cb(err ? "" : stdout),
      );
    };
    const refreshFileStatus = () => {
      runGitFiles(["rev-parse", "--show-toplevel"], (top) => {
        const t = top.trim();
        setFilesGitTop(t || null);
        if (!t) {
          setFileStatusEntries([]);
          return;
        }
        runGitFiles(["status", "--porcelain"], (out) =>
          setFileStatusEntries(parseStatusPorcelain(out)),
        );
      });
    };

    /** (Re)load the top-level listing for `dir` (async), reset the filter and
     *  selection, refresh the git decoration, and (re)arm the watcher. */
    const loadFileList = (dir: string) => {
      void loadIgnoreRules(workspaceDir()).then(() =>
        listDir(dir)
          .then((ents) => {
            setFileNodes(buildNodes(dir, ents, 0));
            setFileSel(0);
            setFileTop(0);
            setFilesQuery(null);
            const pending = pendingFilesSelectionPath;
            pendingFilesSelectionPath = null;
            if (pending) void revealPath(pending);
          })
          .catch(() => setFileNodes([])),
      );
      refreshFileStatus();
      ensureFilesWatch(workspaceDir());
    };

    /** Expansion-preserving refresh: re-read the root + every expanded dir with
     *  the CURRENT toggles, rebuild the flat tree (pure), keep the selection on
     *  the same path where it survived. Used by the watcher push, the H/I
     *  toggles, `r`, and the file-mutation menu verbs. */
    let treeRefreshBusy = false;
    const refreshTree = () => {
      if (treeRefreshBusy) return;
      treeRefreshBusy = true;
      const root = workspaceDir();
      const keepPath = visibleFiles()[fileSel()]?.node.path ?? null;
      const expanded = new Set(
        fileNodes()
          .filter((n) => n.isDir && n.expanded)
          .map((n) => n.path),
      );
      // Fresh rules first (the .gitignore itself may have changed), then every
      // still-relevant dir in parallel; failed reads (vanished dirs) drop out.
      void loadIgnoreRules(root)
        .then(() =>
          Promise.all(
            [root, ...expanded].map(async (d) => [d, await listDir(d).catch(() => null)] as const),
          ),
        )
        .then((pairs) => {
          if (root !== workspaceDir()) return; // workspace moved on mid-flight
          const listing = new Map<string, RawEntry[]>();
          for (const [d, ents] of pairs) if (ents) listing.set(d, ents);
          setFileNodes(rebuildTree(root, listing, expanded));
          const rows = visibleFiles();
          const idx = keepPath ? rows.findIndex((r) => r.node.path === keepPath) : -1;
          const sel = idx !== -1 ? idx : clampSel(fileSel(), Math.max(1, rows.length));
          setFileSel(sel);
          setFileTop((t) => scrollToCursor(sel, t, editorRows(), rows.length));
        })
        .finally(() => {
          treeRefreshBusy = false;
        });
      refreshFileStatus();
    };

    const toggleHiddenFiles = () => {
      setShowHiddenFiles((v) => !v);
      refreshTree();
    };
    const toggleIgnoredFiles = () => {
      setShowIgnoredFiles((v) => !v);
      refreshTree();
    };

    const moveFileSel = (delta: number) => {
      const rows = visibleFiles();
      if (rows.length === 0) return;
      const idx = clampSel(fileSel() + delta, rows.length);
      setFileSel(idx);
      setFileTop((t) => scrollToCursor(idx, t, editorRows(), rows.length));
    };
    /** Enter on a VISIBLE row: open a file in the editor, or toggle a directory
     *  (async readdir → splice children in, or prune the subtree). Expansion
     *  applies at the row's UNDERLYING index, re-resolved by path at apply time
     *  (a watcher refresh may have reshaped the list under a slow readdir). */
    const activateFile = (visIndex: number) => {
      const row = visibleFiles()[visIndex];
      if (!row) return;
      setFileSel(visIndex);
      const node = row.node;
      if (!node.isDir) {
        openEditor(node.path);
        return;
      }
      if (node.expanded) {
        setFileNodes((list) => removeSubtreeAt(list, indexOfPath(list, node.path)));
        return;
      }
      void listDir(node.path)
        .then((ents) => {
          const children = buildNodes(node.path, ents, node.depth + 1);
          setFileNodes((list) => insertChildrenAt(list, indexOfPath(list, node.path), children));
        })
        .catch(() => {});
    };

    /** Reveal `absPath` in the tree: expand each collapsed ancestor in turn
     *  (async readdirs), then select the row. Bails silently when a segment is
     *  filtered out of view (the changed walk pre-filters what it offers). */
    const revealPath = async (absPath: string): Promise<void> => {
      const root = workspaceDir();
      const rel = relPath(root, absPath);
      if (!rel) return;
      for (const anc of ancestorDirs(rel)) {
        const ancAbs = join(root, anc);
        const idx = indexOfPath(fileNodes(), ancAbs);
        const node = fileNodes()[idx];
        if (!node || !node.isDir) return;
        if (!node.expanded) {
          const ents = await listDir(ancAbs).catch(() => null);
          if (!ents) return;
          const children = buildNodes(ancAbs, ents, node.depth + 1);
          setFileNodes((list) => insertChildrenAt(list, indexOfPath(list, ancAbs), children));
        }
      }
      const idx = indexOfPath(fileNodes(), absPath);
      if (idx === -1) return;
      setFileSel(idx);
      setFileTop((t) => scrollToCursor(idx, t, editorRows(), visibleFiles().length));
    };

    /** `[` / `]` — hop the selection to the prev/next CHANGED file (tree display
     *  order, wrapping), auto-expanding collapsed ancestors. Clears the `/`
     *  filter first: the hop is defined on the whole tree. */
    const hopChanged = (dir: 1 | -1) => {
      const top = filesGitTop();
      const walk = changedWalk();
      if (!top || walk.length === 0) return;
      if (filesQuery() !== null) setFilesQuery(null);
      const cur = visibleFiles()[fileSel()]?.node ?? null;
      const curRel = cur ? relPath(top, cur.path) || null : null;
      const next = nextChangedPath(walk, curRel, dir);
      if (next) void revealPath(join(top, next));
    };

    const workspaceUiProjectRoot = (): string =>
      workspaceUiController.snapshot().repository?.metadata.projectRoot ?? workspaceDir();
    const stateWithCurrentWorkspaceView = (): WorkspaceUiStateV2 => {
      const view = activeView();
      const root = workspaceUiProjectRoot();
      let next = workspaceUiState();
      if (activeDockTab() === "files" && hydratedWorkspaceSurfaceIds.has("files")) {
        next = setWorkspaceSurfaceState(next, {
          panel: "files",
          openPath: relativeProjectPath(root, editorPath()),
          selectedPath: relativeProjectPath(root, visibleFiles()[fileSel()]?.node.path ?? null),
        });
      } else if (activeDockTab() === "changes" && hydratedWorkspaceSurfaceIds.has("diff")) {
        next = setWorkspaceSurfaceState(next, {
          panel: "diff",
          selectedPath: diffVisibleFiles()[diffSel()]?.path ?? null,
        });
      } else if (activeDockTab() === "missions" && hydratedWorkspaceSurfaceIds.has("missions")) {
        next = workspaceStateWithMissionModel(next, missionViewId(), missionWorkspaceModel());
      } else if (activeDockTab() === "activity" && hydratedWorkspaceSurfaceIds.has("activity")) {
        next = setWorkspaceSurfaceState(next, {
          panel: "activity",
          selectedRowId: activitySelectedId(),
          scrollOffset: activityScrollOffset(),
        });
      }
      next = setWorkspaceDockState(next, {
        activeTab: activeDockTab(),
        mode: dockMode(),
        preferredHeight: preferredDockHeight(),
        focusZone: workbenchProjection().focusZone,
      });
      return {
        ...next,
        active: { viewId: view.id, panel: canvasPanel() },
      };
    };
    const markWorkspaceUiDomainsTouched = (
      next: WorkspaceUiStateV2,
      current: WorkspaceUiStateV2,
    ) => {
      for (const surfaceId of ["files", "diff", "missions", "activity"] as const) {
        if (
          JSON.stringify(next.surfaces[surfaceId]) !== JSON.stringify(current.surfaces[surfaceId])
        ) {
          touchedWorkspaceSurfaceIds.add(surfaceId);
        }
      }
      if (JSON.stringify(next.dock) !== JSON.stringify(current.dock)) {
        touchedWorkspaceDock = true;
      }
      if (JSON.stringify(next.active) !== JSON.stringify(current.active)) {
        touchedWorkspaceActiveView = true;
      }
    };
    const commitWorkspaceUiState = (generation: number, next: WorkspaceUiStateV2) => {
      const result = workspaceUiController.save(
        generation,
        next,
        touchedWorkspaceViewIds,
        touchedWorkspaceSurfaceIds,
        touchedWorkspaceDock,
        touchedWorkspaceActiveView,
      );
      if (result.saved) {
        touchedWorkspaceViewIds.clear();
        touchedWorkspaceSurfaceIds.clear();
        touchedWorkspaceDock = false;
        touchedWorkspaceActiveView = false;
        setWorkspaceUiState(workspaceUiController.snapshot().state);
      } else if (!result.skipped) {
        const message = result.diagnostics.at(-1)?.message;
        if (message) setStatusNote(message);
      }
    };
    flushWorkspaceUiState = () => {
      const controllerSnapshot = workspaceUiController.snapshot();
      if (!controllerSnapshot.loaded || !controllerSnapshot.repository) return;
      if (workspaceUiSaveTimer) {
        clearTimeout(workspaceUiSaveTimer);
        workspaceUiSaveTimer = null;
      }
      const next = stateWithCurrentWorkspaceView();
      if (serializeWorkspaceUiState(next) === serializeWorkspaceUiState(controllerSnapshot.state)) {
        touchedWorkspaceViewIds.clear();
        touchedWorkspaceSurfaceIds.clear();
        touchedWorkspaceDock = false;
        touchedWorkspaceActiveView = false;
        return;
      }
      markWorkspaceUiDomainsTouched(next, controllerSnapshot.state);
      commitWorkspaceUiState(controllerSnapshot.generation, next);
    };
    snapshotActiveWorkspaceView = () => {
      const view = activeView();
      touchedWorkspaceViewIds.add(view.id);
      const next = stateWithCurrentWorkspaceView();
      setWorkspaceUiState(next);
    };
    hydrateWorkspaceView = (view, { firstProjectLoad = false } = {}) => {
      const entry = viewStateFor(workspaceUiState(), view);
      if (!entry) return;
      if (
        !shouldHydrateWorkspaceView({
          firstProjectLoad,
          explicitEditPath: values.edit ?? null,
          view: view.layout ? { panel: entry.panel } : view,
          entry,
        })
      ) {
        return;
      }
      const root = workspaceUiProjectRoot();
      if (entry.panel === "files") {
        hydratedWorkspaceSurfaceIds.add("files");
        const selectedPath = absoluteProjectPath(root, entry.selectedPath);
        pendingFilesSelectionPath = selectedPath;
        if (fileNodes().length > 0 && selectedPath) {
          pendingFilesSelectionPath = null;
          void revealPath(selectedPath);
        }
        const openPath = absoluteProjectPath(root, entry.openPath);
        if (openPath) openEditor(openPath);
      } else if (entry.panel === "diff") {
        hydratedWorkspaceSurfaceIds.add("diff");
        pendingDiffFile = entry.selectedPath;
        if (entry.selectedPath && diffVisibleFiles().length > 0) {
          const idx = diffVisibleFiles().findIndex((file) => file.path === entry.selectedPath);
          if (idx !== -1) {
            pendingDiffFile = null;
            selectDiffFile(idx);
            return;
          }
        }
        if (mode() === "diff") refreshStatus();
      } else if (entry.panel === "missions") {
        hydratedWorkspaceSurfaceIds.add("missions");
        setMissionWorkspaceModel((current) =>
          reconcileMissionWorkspaceModel(
            missionModelFromWorkspaceState(workspaceUiState(), view, current),
            missionWorkspaceSnapshot(),
            missionLayoutSize(),
          ),
        );
      }
    };
    hydrateActiveWorkspaceView = (options = {}) => hydrateWorkspaceView(activeView(), options);
    const missionSnapshotForModel = () => missionWorkspaceSnapshot();
    const missionDeepLink = (kind: MissionDeepLinkKind): MissionDeepLinkResolution =>
      resolveMissionDeepLink(
        kind,
        missionWorkspaceSnapshot()?.detail ?? null,
        missionWorkspaceModel(),
        {
          projectRoot: workspaceUiProjectRoot(),
          // Deep links target semantic native surfaces, which exist even when
          // compatibility app.views omitted them or only exposed a composite.
          views: (["terminals", "files", "diff"] as const).map((panel) =>
            nativeHostedViewForPanel(hostedViews(), panel),
          ),
          resolveProjectPath: absoluteProjectPath,
        },
      );
    const execFileChecked = (file: string, args: string[]): Promise<string> =>
      new Promise((resolvePromise, rejectPromise) => {
        execFile(file, args, (error, stdout) => {
          if (error) rejectPromise(error);
          else resolvePromise(stdout);
        });
      });
    const followMissionDeepLink = (kind: MissionDeepLinkKind) => {
      const resolved = missionDeepLink(kind);
      if (!resolved.available) {
        setStatusNote(resolved.reason);
        return;
      }
      const intent = resolved.intent;
      if (intent.kind === "terminal") {
        const preflight = missionTmuxPreflightCommands(intent);
        void execFileChecked(preflight[0]!.file, preflight[0]!.args)
          .then(async () => {
            const panePreflight = preflight.find((command) => command.kind === "pane");
            if (panePreflight && intent.paneId) {
              const output = await execFileChecked(panePreflight.file, panePreflight.args);
              if (!missionTmuxPanePreflightMatches(output, intent.session, intent.paneId)) {
                throw new Error("pane does not belong to target session");
              }
            }
          })
          .then(() => {
            snapshotActiveWorkspaceView();
            setCurTarget(intent.session);
            selectViewForPanel(intent.viewId, "terminals");
            attach(intent.session);
            if (intent.paneId) {
              execFile("tmux", ["select-pane", "-t", intent.paneId], (error) => {
                if (error) setStatusNote(`pane unavailable: ${intent.paneId}`);
              });
            }
          })
          .catch(() => {
            setStatusNote(
              intent.paneId
                ? `pane unavailable for session ${intent.session}: ${intent.paneId}`
                : `session unavailable: ${intent.session}`,
            );
          });
        return;
      }
      if (intent.kind === "files") {
        void stat(intent.path)
          .then((info) => {
            snapshotActiveWorkspaceView();
            selectViewForPanel(intent.viewId, "files");
            if (info.isFile() && intent.mode === "open") openEditor(intent.path);
            else void revealPath(intent.path);
          })
          .catch(() => setStatusNote(`file target unavailable: ${intent.path}`));
        return;
      }
      void stat(intent.path)
        .then((info) => {
          snapshotActiveWorkspaceView();
          selectViewForPanel(intent.viewId, "diff");
          prepareDiff(info.isDirectory() ? intent.path : dirname(intent.path));
        })
        .catch(() => setStatusNote(`diff target unavailable: ${intent.path}`));
    };
    const handleMissionsKey = (evt: {
      name: string;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
    }): boolean => {
      return handleMissionSurfaceKey(
        evt,
        {
          model: missionWorkspaceModel(),
          snapshot: missionSnapshotForModel(),
          layoutSize: missionLayoutSize(),
          persistedTaskId: missionSelectionFromWorkspaceState(workspaceUiState(), missionViewId())
            .selectedTaskId,
        },
        {
          updateModel: updateMissionModel,
          refresh: () => loadMissionsWorkspace("refresh"),
          followDeepLink: followMissionDeepLink,
          persistSelection: persistMissionSelection,
        },
      );
    };
    const missionLoadErrorMessage = (): string => {
      const state = missionWorkspaceLoad();
      return state.status === "error" ? state.message : "";
    };
    const missionProjectLabel = (): string =>
      workspaceUiController.snapshot().repository?.metadata.projectRoot ?? workspaceDir();
    const missionLayoutPresentation = () => ({
      loadStatus: missionWorkspaceLoad().status,
      projectLabel: missionProjectLabel(),
      errorMessage: missionLoadErrorMessage(),
      quitHint: QUIT_HINT,
    });
    const missionsLayout = createMemo(() =>
      missionSurfaceLayout(
        dockSurfaceWidth(),
        Math.max(1, dockSurfaceHeight()),
        missionWorkspaceModel(),
        missionWorkspaceSnapshot(),
        missionLayoutPresentation(),
      ),
    );
    const missionsDashboard = createMemo(() =>
      missionDashboardProjection(
        dockSurfaceWidth(),
        Math.max(1, dockSurfaceHeight()),
        missionWorkspaceModel(),
        missionWorkspaceSnapshot(),
        {
          ...missionLayoutPresentation(),
          agents: fleetAgents(),
        },
      ),
    );
    const missionHitAt = (x: number, y: number) => {
      const gy = y - TABBAR_H;
      return missionDashboardHitTest(missionsDashboard(), x - sidebarW(), gy);
    };

    // ── WATCHER PUSH REFRESH (M24.6) ─────────────────────────────────────────
    // widgets/lib/watcher.ts (@parcel/watcher; fs.watch fallback in the compiled
    // binary) — measured working under bun in this process (import + events).
    // Events refresh the visible tree expansion-preservingly; while the Files
    // tab is backgrounded they only mark it stale (refreshed on tab return).
    // The watcher ignores .git, so index-only changes (external staging) ride
    // the 3s status poll armed in onMount instead.
    let stopFilesWatch: (() => Promise<void>) | null = null;
    let filesWatchDir = "";
    let filesStale = false;
    const onFilesWatchEvent = () => {
      if (mode() === "editor") {
        refreshTree();
      } else {
        filesStale = true;
      }
    };
    const ensureFilesWatch = (root: string) => {
      if (filesWatchDir === root) return;
      filesWatchDir = root;
      const prev = stopFilesWatch;
      stopFilesWatch = null;
      void prev?.().catch(() => {});
      void watchDirectory(root, onFilesWatchEvent, { ignore: [...ALWAYS_IGNORE] })
        .then((stop) => {
          if (filesWatchDir !== root) {
            void stop().catch(() => {});
            return;
          }
          stopFilesWatch = stop;
        })
        .catch(() => {
          // watcher unavailable — the Files-tab status poll still runs, and
          // `r` / toggles / mutations refresh on demand.
        });
    };
    cleanupRegistry.set("files-watch", () => void stopFilesWatch?.().catch(() => {}));
    /** A tab switch back onto a stale Files surface catches up in one shot. */
    const catchUpFilesIfStale = () => {
      if (!filesStale) return;
      filesStale = false;
      refreshTree();
    };
    // Status letters must also follow index-only changes (external staging),
    // which the directory watcher never sees — a light poll while the Files
    // tab is active, mirroring the diff panel's 3s discipline.
    const filesStatusPoll = setInterval(() => {
      if (mode() === "editor" && fileNodes().length > 0) refreshFileStatus();
    }, 3000);
    cleanupRegistry.set("files-status-poll", () => clearInterval(filesStatusPoll));

    /** The project dir the fleet payload records for `session` (null if unknown). */
    const dirForSession = (name: string): string | null => {
      for (const p of projectsData()) if (p.sessions.some((s) => s.name === name)) return p.dir;
      return null;
    };

    /** Adopt a session as the workspace context: point the terminal target, the
     *  file list, and the diff panel at it, then show the Terminal tab. The dir is
     *  the project dir from the fleet payload (falling back to the cwd). */
    const openWorkspace = (session: string, dir: string | null) => {
      setContextSession(session);
      const wd = dir ?? invokeCwd;
      setContextDir(wd);
      setDiffDir(wd);
      loadFileList(wd);
      switchTarget(session);
    };

    /** Jump to a fleet agent (M22.2 — a sidebar row click or a palette
     *  jump-agent action): switch the workspace to its session, select its
     *  window, focus its exact pane. `openWorkspace` points the terminal at the
     *  session (attaching a fresh SessionMirror when it differs from the current
     *  one). The window/pane targeting goes through tmux DIRECTLY (async execFile,
     *  the render-loop law) rather than the live mirror: `select-window` /
     *  `select-pane` are exactly what `mirror.switchWindow`/`focus` run under the
     *  hood, but issuing them straight to tmux works BOTH for the already-attached
     *  session and for a just-requested attach whose control client hasn't started
     *  yet (its mirror only lists the active window's panes, so `mirror.focus`
     *  would no-op on a pane in another window). tmux becomes authoritative and
     *  the live control client converges via its own notification stream. */
    const jumpToAgent = (a: Pick<AgentRowInput, "session" | "windowIndex" | "paneId">) => {
      openWorkspace(a.session, dirForSession(a.session));
      execFile("tmux", ["select-window", "-t", `${a.session}:${a.windowIndex}`], () => {
        execFile("tmux", ["select-pane", "-t", a.paneId], () => {});
      });
    };

    /** FRONT DOOR (M25.1): a session the app itself creates is WATCHED — the
     *  adopted marker is stamped (inert re: chrome painting; none of adopt's
     *  status-row/border options are set — see ../chrome/front-door.ts) and
     *  the background updater is ensured up, probed the way adopt probes. So
     *  pure app users get blocked/done notifications without ever running
     *  `adopt`, with zero visible dock changes. Async execFile only (the
     *  render-loop law); everything best-effort. */
    const watchCreatedSession = (name: string) => {
      execFile("tmux", adoptMarkArgv(name), () => {
        execFile("tmux", updaterProbeArgv(), (probeErr) => {
          if (probeErr) execFile("tmux", updaterSpawnArgv(), () => {});
        });
      });
    };

    /** Create a detached session named `name` in `dir` and open it as the
     *  workspace (M21.9 — the home "launch project" / "new session" verbs).
     *  ASYNC execFile only (the render-loop law); an already-existing session
     *  simply opens. `TMUX_IDE=1` marks the session the way the cockpit's
     *  launcher does, so agents inside can detect tmux-ide. */
    const createSession = (name: string, dir: string | null) => {
      const wd = dir ?? invokeCwd;
      execFile("tmux", ["new-session", "-d", "-s", name, "-c", wd], (err) => {
        if (err && !/duplicate session/.test(err.message)) {
          setStatusNote(`launch failed: ${name}`);
          return;
        }
        if (!err) {
          execFile("tmux", ["set-environment", "-t", name, "TMUX_IDE", "1"], () => {});
          watchCreatedSession(name);
          setStatusNote(`launched ${name}`);
        }
        fleetRefresh?.();
        openWorkspace(name, dir);
      });
    };

    // ── AGENT LIFECYCLE (M23.1) — spawn / restart / stop / close ────────────
    // The verbs go to tmux DIRECTLY (async execFile — the render-loop law, and
    // the target agent may live in a session the mirror isn't attached to).
    // The kind list / launch commands / exact argv are pure in
    // agent-lifecycle.ts; only the dialog flows and the io live here.
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    /** One awaited tmux call; errors are swallowed (a dead pane target is a
     *  normal race — the fleet poll shows the truth moments later). */
    const tmuxRun = (args: string[]) =>
      new Promise<void>((resolve) => execFile("tmux", args, () => resolve()));

    /** Out-of-band stop hygiene: killing an agent ourselves fires NO lifecycle
     *  hook (a clean exit's SessionEnd stamps idle), so a working/blocked
     *  authority stamp would keep lying until the 10-minute staleness guard.
     *  Unset both pane options — the same "no authority" end state. */
    const clearAgentAuthority = async (paneId: string) => {
      for (const args of clearAuthorityArgs(paneId)) await tmuxRun(args);
    };

    /** ctrl-c TWICE: TUI agents (claude, codex) treat a single ^c as "clear
     *  input / cancel turn" and only a quick second one as exit; a plain
     *  process ignores the repeat. */
    const interruptAgent = async (paneId: string) => {
      await tmuxRun(interruptArgs(paneId));
      await sleep(INTERRUPT_TAP_GAP_MS);
      await tmuxRun(interruptArgs(paneId));
    };

    const stopAgentFlow = async (a: Pick<AgentRowInput, "paneId" | "kind">) => {
      const ok = await DialogConfirm.show({
        title: `Stop ${a.kind}?`,
        body: "Interrupts the agent (ctrl-c). The pane and its shell stay open.",
        yesLabel: "Stop it",
        noLabel: "Cancel",
        defaultNo: true,
      });
      if (!ok) return;
      await interruptAgent(a.paneId);
      await clearAgentAuthority(a.paneId);
      setStatusNote(`stopped ${a.kind}`);
      setTimeout(() => fleetRefresh?.(), 500);
    };

    /** The pane's `pane_start_command` (its ROOT: "" = default shell) +
     *  `pane_current_path` + our `@agent_launch` stamp (M24.1 — the exact argv
     *  our spawn verb ran, the preferred relaunch source), or null when the
     *  pane is gone. One async display call (tab-joined; the stamp rides LAST
     *  and re-joins, so a command containing tabs survives). NOT
     *  pane_current_command — that is the FOREGROUND process, so a user-typed
     *  `claude` under zsh would read as `claude` too and be indistinguishable
     *  from a pane-command agent (measured). */
    const paneStartAndPath = (paneId: string) =>
      new Promise<{ start: string; path: string; launch: string } | null>((resolve) =>
        execFile(
          "tmux",
          [
            "display",
            "-p",
            "-t",
            paneId,
            "#{pane_start_command}\t#{pane_current_path}\t#{@agent_launch}",
          ],
          (err, stdout) => {
            if (err) return resolve(null);
            const [start = "", path = "", ...rest] = stdout.trimEnd().split("\t");
            resolve({ start, path, launch: rest.join("\t") });
          },
        ),
      );

    /** Two restart strategies, picked by what the pane's ROOT process is:
     *  shell-hosted agents get ctrl-c + relaunch via send-keys (the shell
     *  survives to type into); when the agent IS the pane's own process (our
     *  spawn verb's panes), ctrl-c would end the pane — respawn it in place
     *  instead (same pane id, cwd pinned explicitly). Both paths clear the
     *  authority stamps. */
    const restartAgentFlow = async (a: Pick<AgentRowInput, "paneId" | "kind">) => {
      const manifests = getManifests();
      const live = await paneStartAndPath(a.paneId);
      if (!live) {
        setStatusNote("that pane is gone — refreshing");
        setTimeout(() => fleetRefresh?.(), 300);
        return;
      }
      // The @agent_launch stamp (our own spawn's exact argv — flags included)
      // beats the kind's generic launch command when present (M24.1).
      const command = live.launch || launchCommandFor(a.kind, manifests);
      const underShell = paneHostsShell(live.start, manifests);
      const ok = await DialogConfirm.show({
        title: `Restart ${a.kind}?`,
        body: underShell
          ? `Stops it with ctrl-c, waits a moment, then runs "${command}" again in the same pane.`
          : `The agent is this pane's own process, so the pane is relaunched in place running "${command}".`,
        yesLabel: "Restart it",
        noLabel: "Cancel",
        defaultNo: true,
      });
      if (!ok) return;
      if (underShell) {
        await interruptAgent(a.paneId);
        await clearAgentAuthority(a.paneId);
        await sleep(RESTART_GRACE_MS);
        for (const args of relaunchArgs(a.paneId, command)) await tmuxRun(args);
      } else {
        await clearAgentAuthority(a.paneId);
        await tmuxRun(respawnArgs(a.paneId, command, live.path || null));
      }
      setStatusNote(`restarted ${a.kind}`);
      setTimeout(() => fleetRefresh?.(), 1500);
    };

    /** The destructive twin of stop: kill the agent's pane. Confirmation is the
     *  caller's job (the menu's armed "confirm: y" state). The pane's options
     *  die with it, so no authority cleanup is needed. */
    const closeAgentPane = (a: Pick<AgentRowInput, "paneId" | "kind">) => {
      execFile("tmux", ["kill-pane", "-t", a.paneId], () =>
        setTimeout(() => fleetRefresh?.(), 300),
      );
      setStatusNote(`closed ${a.kind}'s pane`);
    };

    // ── THE SPAWN FLOW (M24.1 — one dialog, defaults everywhere) ─────────────
    // The flow never ASKS what it can default: ONE kind picker whose Enter
    // spawns at the context's default placement (split right of a focused
    // pane / a new window in the session / a fresh session for project rows);
    // placement ALTERNATIVES are footer ctrl-actions, never a second dialog.
    // The picker's TOP row repeats the last spawn remembered for this context
    // (per project/session-dir, app-state), custom commands keep a global
    // recents list, and DialogPrompt only ever appears for a brand-new custom
    // command. Detection needs no extra wiring: the spawned pane's command IS
    // the agent, so the next fleet poll classifies it.
    interface NewAgentContext {
      session?: string;
      dir: string | null;
      paneId?: string;
      /** Names the fresh session when there is no live one (project rows). */
      sessionName?: string;
    }
    /** The context's shape for the pure placement decisions. */
    const spawnShape = (ctx: NewAgentContext) => ({
      pane: ctx.paneId !== undefined,
      session: ctx.session !== undefined,
    });
    /** The context's "again"-memory key + remembered spawn (null when none). */
    const spawnMemoryFor = (
      ctx: NewAgentContext,
    ): { key: string | null; last: LastSpawn | null } => {
      const key = spawnMemoryKey(ctx.dir, ctx.session ?? ctx.sessionName);
      return { key, last: key ? (lastSpawns()[key] ?? null) : null };
    };
    /** ASYNC — a pane's `#{pane_current_path}`, or null when unreadable. */
    const paneCurrentPath = (paneId: string) =>
      new Promise<string | null>((resolve) =>
        execFile("tmux", ["display", "-p", "-t", paneId, "#{pane_current_path}"], (err, stdout) =>
          resolve(err ? null : stdout.trim() || null),
        ),
      );
    /** Run ONE spawn: resolve the cwd policy (Terminal-surface spawns inherit
     *  the FOCUSED pane's cwd under `app.newAgentCwd: "pane"`, the default),
     *  build the argv (`-P -F` returns the new pane id), then — in the same
     *  breath — auto-label the pane/window after the agent and stamp
     *  `@agent_launch` with the exact command, and remember the spawn for the
     *  again row / palette action / custom recents. */
    const runSpawn = async (
      ctx: NewAgentContext,
      choice: { kind: string; command: string; placement: SpawnWhere },
    ) => {
      const { kind, command, placement } = choice;
      let dir = ctx.dir;
      if (ctx.paneId && loadAppConfig().app.newAgentCwd === "pane") {
        dir = (await paneCurrentPath(ctx.paneId)) ?? ctx.dir;
      }
      const label = spawnLabelFor(kind, command);
      // Remember FIRST (fire-and-forget spawn callbacks shouldn't gate it):
      // the again memory is keyed per project/session-dir, custom argv joins
      // the global recents.
      const { key } = spawnMemoryFor(ctx);
      if (key) setLastSpawns((m) => rememberSpawn(m, key, { kind, command, placement }));
      if (kind === CUSTOM_KIND_ID) setCustomCommands((l) => addCustomCommand(l, command));
      /** Post-spawn follow-ups against the printed pane id: title the pane
       *  (or its window), stamp the launch argv. Best-effort, async. */
      const decorate = (stdout: string) => {
        const paneId = stdout.trim();
        if (!paneId.startsWith("%")) return;
        const labelArgs =
          placement === "window" ? labelWindowArgs(paneId, label) : labelPaneArgs(paneId, label);
        execFile("tmux", labelArgs, () => {});
        execFile("tmux", stampLaunchArgs(paneId, command), () => {});
      };
      if (placement === "session" || !ctx.session) {
        const base = ctx.sessionName ?? basename(ctx.dir ?? invokeCwd);
        const name = sessionNameFor(base || "agents");
        execFile("tmux", spawnSessionArgs(name, dir, command), (err, stdout) => {
          setStatusNote(err ? `couldn't start ${command}` : `started ${command} in ${name}`);
          if (!err) {
            execFile("tmux", ["set-environment", "-t", name, "TMUX_IDE", "1"], () => {});
            watchCreatedSession(name);
            decorate(stdout);
          }
          setTimeout(() => fleetRefresh?.(), 300);
        });
        return;
      }
      const target = { session: ctx.session, paneId: ctx.paneId };
      const args = spawnAgentArgs(placement as SpawnPlacement, target, dir, command);
      execFile("tmux", args, (err, stdout) => {
        setStatusNote(err ? `couldn't start ${command}` : `started ${command} in ${ctx.session}`);
        if (!err) {
          decorate(stdout);
          // The agent's session must be watched for its blocked/done pings to
          // exist — front-door sessions were stamped at create, but a spawn
          // can target a pre-existing, never-adopted session too.
          watchCreatedSession(target.session);
        }
        setTimeout(() => fleetRefresh?.(), 300);
      });
    };
    const newAgentFlow = async (ctx: NewAgentContext) => {
      setHoverIf(null); // the overlay owns the pointer, like the palette
      const manifests = getManifests();
      const shape = spawnShape(ctx);
      const fallback = defaultSpawnPlacement(shape);
      const { last } = spawnMemoryFor(ctx);
      // The again row replays its remembered placement where the context still
      // allows it (a remembered split needs a focused pane); else the default.
      const againPlacement =
        last && compatiblePlacement(last.placement, shape) ? last.placement : fallback;
      const res = await DialogSelect.show({
        title: "New agent",
        items: newAgentItems({ manifests, last, againPlacement, customRecents: customCommands() }),
        actions: placementActions(shape),
        footerHint: `enter: ${placementLabel(fallback)}`,
      });
      if (!res) return;
      let kind: string;
      let command: string;
      const recentIdx = customRecentIndex(res.item.id);
      if (res.item.id === AGAIN_ID && last) {
        kind = last.kind;
        command = last.command;
      } else if (recentIdx !== null) {
        kind = CUSTOM_KIND_ID;
        command = customCommands()[recentIdx] ?? "";
        if (!command) return;
      } else if (res.item.id === CUSTOM_KIND_ID) {
        const typed = await DialogPrompt.show({
          title: "Custom command",
          placeholder: "my-agent --flag",
          footerHint: "runs as the new pane's command",
          validate: (v) => (v.trim().length > 0 ? null : "Type a command, or press esc to go back"),
        });
        if (typed === null) return;
        kind = CUSTOM_KIND_ID;
        command = typed.trim();
      } else {
        kind = res.item.id;
        command = launchCommandFor(res.item.id, manifests);
      }
      // WHERE: Enter keeps the default (the again row: its remembered
      // placement); a footer ctrl-action (^w / ^d) overrides.
      const base = res.item.id === AGAIN_ID ? againPlacement : fallback;
      await runSpawn(ctx, { kind, command, placement: resolvePlacement(base, res.action) });
    };
    /** Repeat the current context's remembered spawn DIRECTLY — the palette's
     *  "New agent: <kind> (again)" action (no dialog). Falls through to the
     *  full flow when nothing is remembered (shouldn't happen — the action is
     *  only offered with memory). */
    const newAgentAgain = (ctx: NewAgentContext) => {
      const { last } = spawnMemoryFor(ctx);
      if (!last) {
        void newAgentFlow(ctx);
        return;
      }
      const shape = spawnShape(ctx);
      const placement = compatiblePlacement(last.placement, shape)
        ? last.placement
        : defaultSpawnPlacement(shape);
      void runSpawn(ctx, { kind: last.kind, command: last.command, placement });
    };

    /** "New agent…" for a home row (the [+ agent] chip, the `a` key, the home
     *  palette command): a session row spawns into that session, a project/
     *  recent row into a fresh session in its dir; with nothing useful selected
     *  fall back to the working directory. */
    const newAgentFromHome = (it: HomeItem | undefined) => {
      void newAgentFlow(homeAgentContext(it));
    };
    /** The spawn context a home row implies (shared by the row chips and the
     *  contextual resolver below). */
    const homeAgentContext = (it: HomeItem | undefined): NewAgentContext => {
      if (it?.kind === "session") return { session: it.session, dir: it.dir };
      if (it?.kind === "project") return { dir: it.dir, sessionName: it.name };
      if (it?.kind === "recent") return { dir: it.dir };
      return { dir: invokeCwd };
    };
    /** THE contextual spawn target — one resolver shared by the palette's
     *  new-agent actions, the sidebar's [+ agent] chip, and the Team dialog:
     *  the Terminal surface spawns beside its focused pane, home uses the
     *  selected row, anywhere else the workspace session, else a fresh one. */
    const currentNewAgentContext = (): NewAgentContext => {
      if (mode() === "mirror") {
        // The mirrored session's OWN dir first: contextDir can be a stale
        // persisted workspace when the app booted straight to --target.
        return {
          session: curTarget(),
          dir: dirForSession(curTarget()) ?? (contextDir() || null),
          paneId: mirror?.focusedPane() ?? undefined,
        };
      }
      if (mode() === "home") return homeAgentContext(selectedHomeItem());
      if (contextSession()) return { session: contextSession(), dir: contextDir() || null };
      return { dir: workspaceDir() };
    };
    /** What the current context's remembered spawn is called, or null — drives
     *  the palette's pinned "New agent: <name> (again)" action. */
    const currentAgainName = (): string | null => {
      const { last } = spawnMemoryFor(currentNewAgentContext());
      return last ? lastSpawnName(last) : null;
    };

    /** The TEAM dialog (M24.1): every fleet agent in one surface — Enter/click
     *  JUMPS to the agent, ^r restarts, ^s stops (both confirm via their own
     *  flows), and a pinned "+ new agent" row opens the one-dialog kind picker.
     *  Opened from the sidebar's agents-header click and the palette's
     *  "Manage team…". */
    const manageTeamFlow = async () => {
      setHoverIf(null); // the overlay owns the pointer, like the palette
      const agents = fleetAgents();
      const res = await DialogSelect.show({
        title: `Team — ${agents.length} agent${agents.length === 1 ? "" : "s"}`,
        items: teamItems(agents, Math.floor(Date.now() / 1000)),
        actions: TEAM_ACTIONS,
        footerHint: "enter jumps",
      });
      if (!res) return;
      if (res.item.id === TEAM_NEW_ID) {
        void newAgentFlow(currentNewAgentContext());
        return;
      }
      const idx = teamAgentIndex(res.item.id);
      const a = idx !== null ? agents[idx] : undefined;
      if (!a) return;
      if (res.action === "r") void restartAgentFlow(a);
      else if (res.action === "s") void stopAgentFlow(a);
      else jumpToAgent(a);
    };

    // ── OPEN A FOLDER (M22.5) — the non-technicals' front door ───────────────
    // A filesystem picker (a DialogSelect browse loop over ASYNC readdir) →
    // create-or-attach a session in the chosen dir → openWorkspace, then two
    // optional, skippable offers: remember the project, and (if no project config) set
    // up a layout. Everything is async fs (the header's async-only law); the row
    // math / breadcrumb / sorting is pure in folder-picker.ts.

    /** Push a folder to the recents list (dedupe + cap live in app-state). */
    const recordRecentFolder = (dir: string) => setRecentFolders((r) => addRecentFolder(r, dir));

    /** Create-or-attach a session in `dir` and open it, remembering it as a
     *  recent. The quick path shared by a recents-row reopen and the picker. */
    const openFolderAt = (dir: string) => {
      recordRecentFolder(dir);
      createSession(sessionNameFor(basename(dir) || dir), dir);
    };

    /** ASYNC — the subdirectory names of `dir` (dirs only; unreadable → []). */
    const listSubdirs = async (dir: string): Promise<string[]> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        return [];
      }
    };

    /** ASYNC — classify a path: a directory, a file, or missing/unreadable. */
    const pathKind = async (path: string): Promise<PathKind> => {
      try {
        return (await stat(path)).isDirectory() ? "dir" : "file";
      } catch {
        return "missing";
      }
    };

    /** ASYNC — whether `dir` already has a project config (skip the layout offer). */
    const hasProjectConfig = async (dir: string): Promise<boolean> => {
      const { resolveProjectConfigContext } = await import("../../lib/config-context.ts");
      return (await resolveProjectConfigContext(dir)).configKind !== "none";
    };

    /** The "type a path…" escape hatch: a prompt that async-validates the typed
     *  path is a real folder (sync validate can't touch fs), re-asking with a
     *  plain-language error until it is a dir or the user backs out. Returns the
     *  resolved dir, or null to fall back to browsing. */
    const runTypedPath = async (base: string): Promise<string | null> => {
      let initial = "";
      let footerHint = "type a folder path — ~ and relative paths are ok";
      for (;;) {
        const typed = await DialogPrompt.show({
          title: "Open a folder by path",
          placeholder: "~/code/my-project",
          initial,
          footerHint,
          validate: (v) => (v.trim().length > 0 ? null : "Type a path, or press esc to go back"),
        });
        if (typed === null) return null;
        const resolved = expandUserPath(typed, homedir(), base);
        const kind = await pathKind(resolved);
        if (kind === "dir") return resolved;
        initial = typed;
        footerHint = pathKindHint(kind);
      }
    };

    /** The browse loop: descend/ascend directories, toggle hidden folders with
     *  ^h, "open this folder" commits, "type a path…" hands off to the prompt.
     *  Returns the chosen dir, or null on cancel (esc at the browser). */
    const runFolderPicker = async (start: string): Promise<string | null> => {
      let dir = start;
      let showHidden = false;
      for (;;) {
        const subdirs = filterDirs(await listSubdirs(dir), showHidden);
        const choice = await DialogSelect.show({
          title: pickerBreadcrumb(dir, homedir()),
          items: pickerRows(dir, subdirs, showHidden),
        });
        if (!choice) return null;
        const id = choice.item.id;
        if (id === PICKER_OPEN_ID) return dir;
        if (id === PICKER_HIDDEN_ID) {
          showHidden = !showHidden;
          continue;
        }
        if (id === PICKER_UP_ID) {
          if (!isPickerRoot(dir)) dir = pickerParent(dir);
          continue;
        }
        if (id === PICKER_TYPE_ID) {
          const typed = await runTypedPath(dir);
          if (typed !== null) return typed;
          continue; // backed out of the prompt → keep browsing
        }
        const name = pickerDirName(id);
        if (name) dir = join(dir, name);
      }
    };

    /** Offer to remember a just-opened folder as a project (registry add —
     *  honoring TMUX_IDE_REGISTRY_DIR). Already-registered is a friendly no-op. */
    const rememberProject = async (dir: string) => {
      try {
        await registerProject({ dir });
        setStatusNote(`remembered ${basename(dir) || dir}`);
        fleetRefresh?.();
      } catch (e) {
        if (e instanceof ProjectAlreadyRegisteredError) setStatusNote("already in your projects");
        else setStatusNote("couldn't remember that project");
      }
    };

    /** Write a starter workspace config for `dir` via `tmux-ide detect --write` (async
     *  subprocess — the CLI resolves the layout from the project's stack). */
    const runDetectWrite = (dir: string) => {
      execFile("node", [cliPath, "detect", dir, "--write"], (err) => {
        setStatusNote(
          err ? "couldn't set up a layout" : `set up a layout in ${basename(dir) || dir}`,
        );
      });
    };

    /** The full picked-folder flow: open it, then the two skippable offers. */
    const openFolderPicked = async (dir: string) => {
      openFolderAt(dir);
      const remember = await DialogConfirm.show({
        title: "Remember this project?",
        body:
          "Add it to your projects so it's one click to reopen next time. " +
          "This opens your project in a terminal workspace either way.",
        yesLabel: "Remember it",
        noLabel: "Not now",
      });
      if (remember) await rememberProject(dir);
      if (!(await hasProjectConfig(dir))) {
        const setup = await DialogConfirm.show({
          title: "Set up a layout?",
          body:
            "Detect this project and write a starter layout so it opens with the " +
            "right panes next time. You can change it later.",
          yesLabel: "Set it up",
          noLabel: "Skip",
        });
        if (setup) runDetectWrite(dir);
      }
    };

    /** Entry point for every "open folder" affordance (home key `f`, the footer
     *  chip, the palette command, the welcome action): browse, then open. */
    const openFolderFlow = async () => {
      setHoverIf(null); // the overlay owns the pointer, like the palette
      // `||` (not `??`): contextDir is "" when unset, and a selected header/none
      // gives null — either falls through to the working directory.
      const start = selectedHomeDir() || contextDir() || invokeCwd;
      const dir = await runFolderPicker(start);
      if (dir) await openFolderPicked(dir);
    };

    /** A home row's PRIMARY verb: open a session as the workspace, or launch a
     *  registered project (its sanitized name becomes the session). Shared by
     *  the row click and the enter key. */
    const activateHomeItem = (index: number) => {
      const it = homeItems()[index];
      if (!it || it.kind === "header") return;
      setSel(index);
      if (it.kind === "session") openWorkspace(it.session, it.dir);
      else if (it.kind === "recent") openFolderAt(it.dir);
      else createSession(sessionNameFor(it.name), it.dir);
    };

    /** A home row's CHIP verb: sessions get [± diff] (adopt the row as context
     *  and open its diff — the `d` key's mouse twin); projects get [▸ launch]
     *  (same as the primary, spelled out for discoverability). */
    const runHomeChip = (index: number) => {
      const it = homeItems()[index];
      if (!it || it.kind === "header") return;
      setSel(index);
      if (it.kind === "session") {
        setContextSession(it.session);
        setContextDir(it.dir ?? invokeCwd);
        enterDiff(it.dir ?? invokeCwd);
      } else if (it.kind === "recent") {
        openFolderAt(it.dir);
      } else {
        createSession(sessionNameFor(it.name), it.dir);
      }
    };

    /** Submit the home new-session prompt: validate, create, open. */
    const submitSessionPrompt = () => {
      const raw = (sessionPrompt() ?? "").trim();
      setSessionPrompt(null);
      if (!raw) return;
      if (!isValidSessionName(raw)) {
        setStatusNote("session names cannot contain ':', '.' or spaces");
        return;
      }
      createSession(raw, selectedHomeDir());
    };

    // ── COMMAND PALETTE (native surface; root-owned input) ──────────────────
    // F5 / ^p / host-aware ⌘K opens the native CommandPaletteSurface. The
    // existing ranked PaletteAction catalog remains canonical; the pure adapter
    // adds semantic icons/details/availability and stable selection ids. The
    // component owns no handlers: this root routes keyboard, paste, projected
    // mouse hits, lifecycle, and execution through the existing action executor.
    const [paletteOpen, setPaletteOpen] = createSignal(false);
    const [paletteQuery, setPaletteQuery] = createSignal("");
    const paletteBufferLoadGate = new PaletteBufferLoadGate();
    onCleanup(() => paletteBufferLoadGate.invalidate());
    // "Go to file:" source (M24.6): the workspace's ignore-respecting file list,
    // repo-relative, capped, refreshed on each palette open (async — the rows
    // appear as soon as the list lands). `git ls-files -co --exclude-standard`
    // where the workspace is a repo; a capped, filtered async walk elsewhere.
    const REPO_FILES_CAP = 2000;
    const REPO_WALK_DEPTH = 8;
    const [repoFiles, setRepoFiles] = createSignal<string[]>([]);
    const walkRepoFiles = async (root: string): Promise<string[]> => {
      const out: string[] = [];
      let queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
      while (queue.length > 0 && out.length < REPO_FILES_CAP) {
        const next: typeof queue = [];
        for (const { dir, depth } of queue) {
          const ents = await listDir(dir).catch(() => []);
          for (const e of ents) {
            if (out.length >= REPO_FILES_CAP) break;
            const abs = join(dir, e.name);
            if (e.isDir) {
              if (depth + 1 < REPO_WALK_DEPTH) next.push({ dir: abs, depth: depth + 1 });
            } else {
              const rel = relPath(root, abs);
              if (rel) out.push(rel);
            }
          }
        }
        queue = next;
      }
      return out;
    };
    const loadRepoFiles = () => {
      const root = workspaceDir();
      runGitFiles(["ls-files", "-co", "--exclude-standard"], (out) => {
        if (root !== workspaceDir()) return;
        if (out) {
          setRepoFiles(out.split("\n").filter(Boolean).slice(0, REPO_FILES_CAP));
          return;
        }
        void walkRepoFiles(root)
          .then((files) => {
            if (root === workspaceDir()) setRepoFiles(files);
          })
          .catch(() => setRepoFiles([]));
      });
    };
    // Buffer selection remains a compact numeric second-level concern. The
    // command list uses stable semantic ids so re-ranking/query edits never
    // accidentally execute a different row at the same screen coordinate.
    const [paletteSel, setPaletteSel] = createSignal(0);
    const [paletteSelectedCommandId, setPaletteSelectedCommandId] = createSignal<string | null>(
      null,
    );
    // The wheel-scrolled window top of the result list (0 unless scrolled — the
    // keyboard never moves it, so keyboard-only sessions render exactly as
    // before). Reset wherever the list identity changes (query edits, level
    // swaps, reopen).
    const [paletteTop, setPaletteTop] = createSignal(0);
    // ROWS, not bare actions (M24.4): an empty query opens grouped — "recent"
    // (persisted usage), "suggested" (surface verbs; BLOCKED agents' jumps
    // first), then "commands" — a typed query is one flat ranked list. Headers
    // are real, non-selectable rows; the selection helpers below skip them.
    const paletteRowList = createMemo(() =>
      paletteRows(
        paletteQuery(),
        fleet().map((s) => s.name),
        {
          terminal: mode() === "mirror",
          surface: tab(),
          agents: fleetAgents(),
          sizeMismatch: windowMismatch() !== null,
          appMousePane: panes().find((p) => p.active)?.appMouse === true,
          // Pins "New agent: <name> (again)" FIRST when this context has spawn
          // memory (M24.1) — F5 → Enter repeats the last spawn.
          againName: currentAgainName(),
          usage: paletteUsage(),
          keycaps: PALETTE_ROW_KEYCAPS,
          views: canvasHostedViews(),
          // "Go to file:" rows (M24.6) — appended after everything.
          repoFiles: repoFiles(),
        },
      ),
    );
    const paletteEntries = createMemo(() => {
      // EditBuffer is an imperative native object, so subscribe to its explicit
      // revision before deriving availability for Save.
      editorRev();
      return adaptPaletteRowsToCommands(paletteRowList(), {
        currentTab: tab(),
        currentViewId: activeViewId(),
        currentSession: contextSession(),
        syncOn: syncOn(),
        saveState: {
          hasBuffer: Boolean(editBuffer),
          hasPath: Boolean(editorPath()),
          readOnlyReason: editorReadOnly(),
        },
        fallbackGroup: paletteQuery().trim() ? "Results" : "Commands",
      });
    });
    const paletteProjection = createMemo(() =>
      projectCommandPalette({
        width: dims().width,
        height: dims().height,
        query: paletteQuery(),
        commands: paletteEntries().map((entry) => entry.descriptor),
        selectedCommandId: paletteSelectedCommandId(),
        scrollTop: paletteTop(),
      }),
    );
    /** The legacy centered geometry is now exclusively the paste-buffer level. */
    const paletteGeom = (): PaletteGeom => {
      const { left, top } = palettePos(dims().width, dims().height, paletteW());
      const count = paletteBuffers()?.length ?? 0;
      return {
        left,
        top,
        width: paletteW(),
        visibleRows: Math.min(PALETTE_ROWS, Math.max(0, count - paletteTop())),
      };
    };
    const resetPaletteSelection = () => {
      setPaletteTop(0);
      setPaletteSelectedCommandId(firstEnabledPaletteCommandId(paletteEntries()));
    };
    const setPaletteQueryAndReset = (next: string) => {
      setPaletteQuery(next);
      resetPaletteSelection();
    };
    const selectPaletteCommand = (commandId: string | null) => {
      setPaletteSelectedCommandId(commandId);
      setPaletteTop(
        ensurePaletteSelectionVisible(paletteProjection(), paletteEntries(), commandId),
      );
    };
    const closePalette = () => {
      paletteBufferLoadGate.invalidate();
      setPaletteBuffers(null);
      setPaletteOpen(false);
    };
    const returnFromPaletteBuffers = () => {
      paletteBufferLoadGate.invalidate();
      const restore = restorePaletteActionLevelFromBuffers(paletteProjection(), paletteEntries());
      setPaletteBuffers(null);
      setPaletteSel(0);
      setPaletteSelectedCommandId(restore.selectedCommandId);
      setPaletteTop(restore.scrollTop);
    };
    const openPalette = () => {
      paletteBufferLoadGate.invalidate();
      setPaletteQuery("");
      setPaletteBuffers(null); // always open on the action list, never mid-picker
      resetPaletteSelection();
      setHoverIf(null); // the overlay owns the pointer; drop any underlying tint
      loadRepoFiles(); // refresh the "Go to file:" source (async, M24.6)
      setPaletteOpen(true);
    };
    const lifecycleExecutor = createTuiLifecycleExecutor({
      // Renderer destruction disposes the Solid root first, so the shared
      // onCleanup path owns mirrors/buffers and the host-mode guard restores
      // DECAWM after OpenTUI's native terminal teardown.
      destroyRenderer: () => appRenderer.destroy(),
      // HOSTED (M23.2): put the cockpit away and keep running. A client that
      // came here via switch-client bounces BACK to its last session; a plain
      // terminal attach has no last session, so switch-client -l fails and the
      // fallback detaches.
      switchClientBack: (callback) => execFile("tmux", ["switch-client", "-l"], callback),
      detachClient: () => execFile("tmux", ["detach-client"], () => {}),
    });
    const rendererCommandExecutor = createRendererCommandExecutor({
      context: () => ({
        // Composite workspace views no longer own runtime pixels/input in the
        // native workbench, so their legacy cycle command remains unavailable.
        compositeFocusAvailable: false,
        editorAvailable:
          Boolean(editBuffer) || (mode() === "diff" && Boolean(diffVisibleFiles()[diffSel()])),
      }),
      effects: {
        openPalette,
        runLifecycle: (command) => lifecycleExecutor.run(command),
        cycleCompositeFocus: () => {},
        activateShortcut: (key) => {
          const view = canvasHostedViews().find((candidate) => candidate.shortcut?.key === key);
          if (view) selectView(view.id);
        },
        activateView: (viewId) => selectView(viewId),
        activateCanvas: (panel) => activateCanvasPanel(panel),
        activateDock: (tabId) => activateDockTab(tabId),
        openHome: () => {
          if (mode() !== "home") goHome();
        },
        toggleEditor: () => {
          if (mode() === "diff") openSelectedInEditor();
          else toggleEditor();
        },
      },
    });
    const executeRendererCommand = rendererCommandExecutor.execute;
    const runPaletteAction = (a: PaletteAction) => {
      // Usage history (M24.4): every dispatched action bumps its stable key —
      // count + lastUsed feed the "recent" group and the ranking tie-break.
      setPaletteUsage((u) =>
        recordPaletteUse(u, paletteActionKey(a), Math.floor(Date.now() / 1e3)),
      );
      // "Paste buffer…" descends into the second-level picker instead of
      // dispatching — keep the palette open and load the buffer list.
      if (a.kind === "paste-buffer") {
        setPaletteSel(0);
        setPaletteTop(0);
        loadBuffers();
        return;
      }
      closePalette();
      switch (a.kind) {
        case "search-scrollback":
          // The live-prompt entry to scrollback search — `/` only works while
          // scrolled (it belongs to the pane's agent at the bottom).
          openSearch();
          break;
        case "tab":
          if (a.tab === "home" || a.tab === "terminal") {
            executeRendererCommand(
              rendererInvocationForCanvas(a.tab === "home" ? "home" : "terminals", {
                kind: "palette",
                surface: "palette",
              }),
            );
          } else {
            executeRendererCommand(
              rendererInvocationForDock(a.tab === "files" ? "files" : "changes", {
                kind: "palette",
                surface: "palette",
              }),
            );
          }
          break;
        case "view":
          executeRendererCommand(
            rendererInvocationForView(a.viewId, { kind: "palette", surface: "palette" }),
          );
          break;
        case "open-folder":
          void openFolderFlow();
          break;
        case "attach":
          openWorkspace(a.session, dirForSession(a.session));
          break;
        case "jump-agent":
          jumpToAgent(a);
          break;
        case "new-agent":
          // Contextual target (currentNewAgentContext): the Terminal surface
          // spawns beside its focused pane; home uses the selected row;
          // anywhere else the workspace session, else a fresh one.
          void newAgentFlow(currentNewAgentContext());
          break;
        case "new-agent-again":
          // Repeat the remembered spawn directly — no dialog (M24.1: the
          // pinned action makes F5 → Enter the whole repeat gesture).
          newAgentAgain(currentNewAgentContext());
          break;
        case "manage-team":
          void manageTeamFlow();
          break;
        case "restart-agent":
          void restartAgentFlow({ paneId: a.paneId, kind: a.agentKind });
          break;
        case "stop-agent":
          void stopAgentFlow({ paneId: a.paneId, kind: a.agentKind });
          break;
        case "open-file":
          openEditor(a.path);
          break;
        case "go-file":
          // A fuzzy-matched repo file (M24.6) — path is workspace-relative.
          openEditor(join(workspaceDir(), a.path));
          break;
        case "save":
          saveEditor();
          break;
        case "refresh-diff":
          if (mode() === "diff") refreshStatus();
          else enterDiff(workspaceDir());
          break;
        case "new-window":
          void mirror?.command(`new-window -t ${curTarget()}:`).catch(() => {});
          setStatusNote("new window");
          break;
        case "rename-window": {
          const idx = windowTabs().find((w) => w.active)?.index;
          if (idx !== undefined) {
            void mirror
              ?.command(`rename-window -t ${curTarget()}:${idx} ${tmuxQuote(a.name)}`)
              .catch(() => {});
            setStatusNote(`renamed window → ${a.name}`);
          }
          break;
        }
        case "kill-window": {
          const idx = windowTabs().find((w) => w.active)?.index;
          if (idx !== undefined) {
            void mirror?.command(`kill-window -t ${curTarget()}:${idx}`).catch(() => {});
            setStatusNote("killed window");
          }
          break;
        }
        case "zoom-pane": {
          const pid = mirror?.focusedPane();
          if (pid) void mirror?.command(`resize-pane -Z -t ${pid}`).catch(() => {});
          break;
        }
        case "swap-pane": {
          const pid = mirror?.focusedPane();
          if (pid) void mirror?.command(`swap-pane -D -t ${pid}`).catch(() => {});
          setStatusNote("swapped pane");
          break;
        }
        case "break-pane": {
          const pid = mirror?.focusedPane();
          // Explicit destination session — see the pane menu's break note.
          if (pid) void mirror?.command(`break-pane -s ${pid} -t ${curTarget()}:`).catch(() => {});
          setStatusNote("broke pane to window");
          break;
        }
        case "rotate-window": {
          const pid = mirror?.focusedPane();
          if (pid) void mirror?.command(`rotate-window -t ${pid}`).catch(() => {});
          setStatusNote("rotated panes");
          break;
        }
        case "select-layout": {
          const pid = mirror?.focusedPane();
          if (pid) void mirror?.command(`select-layout -t ${pid} ${a.layout}`).catch(() => {});
          setStatusNote(`layout: ${a.layout}`);
          break;
        }
        case "select-text": {
          // The pane menu verb's palette twin (M22.9) — same gate: the focused
          // pane must be app-mouse (otherwise drags already select directly).
          const pid = mirror?.focusedPane();
          const p = panes().find((x) => x.id === pid);
          if (pid && p?.appMouse) enterSelectMode(pid);
          break;
        }
        case "sync-toggle": {
          const pid = mirror?.focusedPane();
          if (pid) {
            const next = syncOn() ? "off" : "on";
            void mirror
              ?.command(`set-window-option -t ${pid} synchronize-panes ${next}`)
              .then(() => setTimeout(refreshWindows, 60))
              .catch(() => {});
            setStatusNote(`synchronize-panes ${next}`);
          }
          break;
        }
        case "resize-window": {
          // Reclaim the window at our canvas size (M22.8). The mirror flips to the
          // manual policy — the only mechanism that holds against a bigger real
          // client (measured) — and reverts it on detach.
          void mirror?.resizeToFit().catch(() => {});
          setStatusNote("resized window to fit");
          break;
        }
        case "settings":
          // The settings surface (M22.4): every setting is a command running on
          // the global dialog stack; flows live below with the stack wiring.
          void runSettingsCommand(a.id);
          break;
        case "quit":
          executeRendererCommand(
            rendererInvocationForLifecycle(
              resolveQuitLifecycleCommand({ hosted: HOSTED }, "palette"),
            ),
          );
          break;
      }
    };
    /** Feed one key to the palette overlay. Returns true when the key was consumed
     *  (so the global handler stops). */
    const paletteKey = (evt: {
      name: string;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
    }): void => {
      // Second level: the paste-buffer picker. esc backs out to the action list;
      // up/down move; enter pastes the chosen buffer. No typing filter here (the
      // list is short and buffer names aren't fuzzy-worthy).
      const bufs = paletteBuffers();
      if (bufs !== null) {
        if (evt.name === "escape") {
          returnFromPaletteBuffers();
        } else if (evt.name === "return") {
          const b = bufs[Math.min(paletteSel(), bufs.length - 1)];
          if (b) pasteBuffer(b.name);
        } else if (evt.name === "up") {
          setPaletteSel((s) => Math.max(0, s - 1));
        } else if (evt.name === "down") {
          setPaletteSel((s) => Math.min(Math.max(0, bufs.length - 1), s + 1));
        }
        return;
      }
      if (evt.name === "escape") {
        closePalette();
      } else if (evt.name === "return") {
        dispatchPaletteCommand(paletteEntries(), paletteSelectedCommandId(), runPaletteAction);
      } else if (evt.name === "up") {
        selectPaletteCommand(
          stepEnabledPaletteCommandId(paletteEntries(), paletteSelectedCommandId(), -1),
        );
      } else if (evt.name === "down") {
        selectPaletteCommand(
          stepEnabledPaletteCommandId(paletteEntries(), paletteSelectedCommandId(), 1),
        );
      } else if (evt.name === "backspace") {
        setPaletteQueryAndReset(paletteQuery().slice(0, -1));
      } else if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
        setPaletteQueryAndReset(paletteQuery() + (evt.shift ? evt.name.toUpperCase() : evt.name));
      }
    };

    // ── DIALOG STACK (M22.4) — the settings surface's primitives ────────────
    // ONE overlay mount renders whatever is on top of the global dialog stack
    // (dialog-stack.ts); flows are sequential awaits over the Promise one-shots
    // (DialogSelect/DialogPrompt/DialogConfirm.show). The stack is not reactive,
    // so a `dialogRev` signal bumps on every stack notification (the editorRev
    // idiom) and every derived accessor reads it first. INPUT SUPPRESSION: while
    // the stack is non-empty the keyboard handler and `route` both hand the
    // event to the dialog FIRST and return — nothing reaches panes/editor.
    const [dialogRev, setDialogRev] = createSignal(0);
    onCleanup(dialogStack.subscribe(() => setDialogRev((r) => r + 1)));
    const dialogTop = () => {
      dialogRev();
      return dialogStack.top();
    };
    // Live-preview accent (the theme picker's onMove) — tints the DIALOG chrome
    // only: the app's own surface colors are const RGBAs and the config theme
    // drives the tmux chrome + widgets, which re-read config on their next
    // build. The picker says so in its footer (scoped honestly, M22.4).
    const [previewAccent, setPreviewAccent] = createSignal<RGBA | null>(null);
    const dlgAccent = () => previewAccent() ?? ACCENT;
    const dlgSelect = () => {
      const e = dialogTop();
      return e && e.spec.kind === "select" ? e : null;
    };
    const dlgPrompt = () => {
      const e = dialogTop();
      return e && e.spec.kind === "prompt" ? e : null;
    };
    const dlgConfirm = () => {
      const e = dialogTop();
      return e && e.spec.kind === "confirm" ? e : null;
    };
    // Narrowed spec accessors for the render (each used only inside its <Show>).
    const dlgSelectSpec = () => dlgSelect()!.spec as DialogSelectSpec;
    const dlgPromptSpec = () => dlgPrompt()!.spec as DialogPromptSpec;
    const dlgConfirmSpec = () => dlgConfirm()!.spec as DialogConfirmSpec;

    /** The visible window of the top select's filtered rows (render + router). */
    const dlgVisibleItems = () => {
      dialogRev();
      const e = dialogStack.top();
      if (!e || e.spec.kind !== "select") return [];
      return dialogStack.filtered().slice(e.state.top, e.state.top + DIALOG_ROWS);
    };
    /** The top dialog's box geometry — the SAME math places the render and
     *  hit-tests the router (the palette's law). */
    const dialogGeomNow = (): DialogGeom => {
      const e = dialogStack.top()!;
      const { left, top } = dialogPos(dims().width, dims().height, dialogW());
      const visibleRows =
        e.spec.kind === "select"
          ? Math.min(DIALOG_ROWS, Math.max(0, dialogStack.filtered().length - e.state.top))
          : e.spec.kind === "confirm"
            ? 2
            : 1;
      return {
        left,
        top,
        width: dialogW(),
        headerRows: dialogHeaderRows(e.spec, dialogW()),
        visibleRows,
        footerRows: 1,
      };
    };

    // ── SETTINGS AS COMMANDS (M22.4) ─────────────────────────────────────────
    // No settings screen: each palette "Settings…" command runs one of these
    // flows. Reads are FRESH (loadAppConfig / raw prefs — never the process
    // cache) and writes go through the typed updateAppConfig (atomic, raw-merge,
    // TMUX_IDE_CONFIG honored). Leaf flows return true when they COMMITTED;
    // a cancelled leaf returns false so the umbrella loop reopens one level up.
    const freshCfg = () => loadAppConfig();
    const freshPrefs = () => parseNotificationPrefs(loadRawAppConfig());

    const runThemePicker = async (): Promise<boolean> => {
      const cfg = freshCfg();
      const before = cfg.theme.accent;
      const items = themeItems(cfg);
      const rgbOf = (accent: string) => {
        const rgb = presetRgb(accent);
        return rgb ? RGBA.fromInts(rgb[0], rgb[1], rgb[2], 255) : null;
      };
      setPreviewAccent(rgbOf(before)); // the dialog opens in the saved accent
      const choice = await DialogSelect.show({
        title: "Accent color",
        items,
        footerHint: "previews here · chrome + widgets: after re-adopt",
        onMove: (item) => setPreviewAccent(rgbOf(item.id)),
      });
      setPreviewAccent(null); // Escape reverts; a commit re-themes via config
      if (!choice) return false;
      if (choice.item.id !== before) {
        updateAppConfig(themePatch(choice.item.id));
        setStatusNote(`accent saved — ${HINT_READOPT}`);
      }
      return true;
    };

    const runQuietHours = async (): Promise<boolean> => {
      const prefs = freshPrefs();
      const choice = await DialogSelect.show({
        title: "Quiet hours",
        items: quietHoursItems(prefs),
        footerHint: "silences banners, sounds & bells during the window",
      });
      if (!choice) return false;
      if (choice.item.id === "off") {
        updateAppConfig(quietHoursOffPatch());
        setStatusNote(`quiet hours off — ${HINT_LIVE}`);
        return true;
      }
      const start = await DialogPrompt.show({
        title: "Quiet hours — start time",
        placeholder: "22:00",
        initial: prefs.quietHours?.start ?? "",
        validate: validateQuietTime,
        footerHint: "24-hour clock, HH:MM",
      });
      if (start === null) return false;
      const end = await DialogPrompt.show({
        title: "Quiet hours — end time",
        placeholder: "08:00",
        initial: prefs.quietHours?.end ?? "",
        validate: validateQuietTime,
        footerHint: "24-hour clock, HH:MM",
      });
      if (end === null) return false;
      updateAppConfig(quietHoursPatch(start, end));
      setStatusNote(`quiet hours ${start.trim()}–${end.trim()} — ${HINT_LIVE}`);
      return true;
    };

    const runNotificationToggles = async (): Promise<boolean> => {
      let sel: number | undefined;
      for (;;) {
        const prefs = freshPrefs();
        const items = notificationItems(prefs);
        const choice = await DialogSelect.show({
          title: "Notifications",
          items,
          initialSel: sel,
          footerHint: `enter toggles · ${HINT_LIVE}`,
        });
        if (!choice) return false; // esc — done toggling, back one level
        sel = items.findIndex((i) => i.id === choice.item.id);
        if (choice.item.id === "quietHours") {
          await runQuietHours();
          continue; // back to the list with fresh details either way
        }
        if (choice.item.id === "sound") {
          const picked = await DialogSelect.show({
            title: "Notification sound",
            items: soundItems(prefs),
            footerHint: HINT_LIVE,
          });
          if (picked) {
            updateAppConfig(soundPatch(picked.item.id));
            setStatusNote(`sound: ${picked.item.label} — ${HINT_LIVE}`);
          }
          continue;
        }
        if (choice.item.id === "delaySeconds") {
          const v = await DialogPrompt.show({
            title: "Alert delay (seconds)",
            initial: String(prefs.delaySeconds),
            validate: validateDelaySeconds,
            footerHint: `waits, then re-checks the agent still needs you · ${HINT_LIVE}`,
          });
          if (v !== null) {
            updateAppConfig(delaySecondsPatch(v));
            setStatusNote(`alert delay ${v.trim()} s — ${HINT_LIVE}`);
          }
          continue;
        }
        const id = choice.item.id as NotificationToggleId;
        updateAppConfig(notificationTogglePatch(id, prefs));
        setStatusNote(`${choice.item.label}: ${prefs[id] ? "off" : "on"} — ${HINT_LIVE}`);
      }
    };

    const runUpdatesSettings = async (): Promise<boolean> => {
      let sel: number | undefined;
      for (;;) {
        const cfg = freshCfg();
        const items = updatesItems(cfg);
        const choice = await DialogSelect.show({
          title: "Updates & background refresh",
          items,
          initialSel: sel,
          footerHint: HINT_CHROME_RESTART,
        });
        if (!choice) return false;
        sel = items.findIndex((i) => i.id === choice.item.id);
        if (choice.item.id === "check") {
          updateAppConfig(updatesCheckPatch(cfg));
          setStatusNote(
            `update checks ${cfg.updates.check ? "off" : "on"} — ${HINT_CHROME_RESTART}`,
          );
          continue;
        }
        if (choice.item.id === "tickMs") {
          const v = await DialogPrompt.show({
            title: "Background refresh interval (ms)",
            initial: String(cfg.updater.tickMs),
            validate: validateTickMs,
            footerHint: HINT_CHROME_RESTART,
          });
          if (v !== null) {
            updateAppConfig(tickMsPatch(v));
            setStatusNote(`refresh every ${v.trim()} ms — ${HINT_CHROME_RESTART}`);
          }
          continue;
        }
        if (choice.item.id === "snapshotEvery") {
          const v = await DialogPrompt.show({
            title: "Save a crash snapshot every … refreshes",
            initial: String(cfg.updater.snapshotEvery),
            validate: validateSnapshotEvery,
            footerHint: HINT_CHROME_RESTART,
          });
          if (v !== null) {
            updateAppConfig(snapshotEveryPatch(v));
            setStatusNote(`snapshot every ${v.trim()} refreshes — ${HINT_CHROME_RESTART}`);
          }
          continue;
        }
      }
    };

    const runRestoreSetting = async (): Promise<boolean> => {
      const choice = await DialogSelect.show({
        title: "Crash restore",
        items: restoreItems(freshCfg()),
        footerHint: "used by tmux-ide restore — takes effect next restore",
      });
      if (!choice) return false;
      updateAppConfig(restorePatch(choice.item.id));
      setStatusNote(
        choice.item.id === "on"
          ? "restore will revive agents — takes effect next restore"
          : "restore rebuilds sessions only — takes effect next restore",
      );
      return true;
    };

    const runKeybindViewer = async (): Promise<boolean> => {
      await DialogSelect.show({
        title: "Keyboard shortcuts",
        items: keybindingItems(freshCfg().keys, KITTY_KEYS),
        footerHint: "read-only — edit keys.* in ~/.tmux-ide/config.json",
      });
      return false; // viewing commits nothing; the umbrella reopens
    };

    const runSettingsReset = async (): Promise<boolean> => {
      const ok = await DialogConfirm.show({
        title: "Reset settings to defaults?",
        body:
          "Theme, notifications, updates and restore go back to their defaults. " +
          "Your key bindings and anything else in config.json stay as they are.",
        yesLabel: "Reset settings",
        noLabel: "Keep my settings",
        defaultNo: true,
      });
      if (!ok) return false;
      updateAppConfig(resetSettingsPatch());
      setStatusNote(`settings reset to defaults — ${HINT_READOPT}`);
      return true;
    };

    const runSettingsLeaf = (id: SettingsCommandId): Promise<boolean> => {
      switch (id) {
        case "settings-theme":
          return runThemePicker();
        case "settings-notifications":
          return runNotificationToggles();
        case "settings-quiet-hours":
          return runQuietHours();
        case "settings-updates":
          return runUpdatesSettings();
        case "settings-restore":
          return runRestoreSetting();
        case "settings-keys":
          return runKeybindViewer();
        case "settings-reset":
          return runSettingsReset();
        default:
          return Promise.resolve(true);
      }
    };

    const runSettingsCommand = async (id: SettingsCommandId): Promise<void> => {
      setHoverIf(null); // the overlay owns the pointer, like the palette
      if (id !== "settings") {
        await runSettingsLeaf(id);
        return;
      }
      // The umbrella: a categorized select over every command. A cancelled leaf
      // loops back here — Escape reads as "one level up" all the way out.
      for (;;) {
        const choice = await DialogSelect.show({
          title: "Settings",
          items: settingsRootItems(freshCfg(), freshPrefs()),
          footerHint: "type to filter",
        });
        if (!choice) return;
        if (await runSettingsLeaf(choice.item.id as SettingsCommandId)) return;
      }
    };

    // ── PERSISTENCE (M18.4) ──────────────────────────────────────────────────
    // Save { lastTab, contextSession, openFile, diffFile, sidebarW } debounced
    // whenever any of them changes; the write is async (off the render tick). A
    // sidebar drag bumps `sidebarW()` on each tick — the 400ms debounce coalesces
    // the burst so only the released width lands.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    createEffect(() => {
      const snapshot: AppState = {
        lastTab: tab(),
        contextSession: contextSession() || null,
        openFile: editorPath(),
        diffFile: diffVisibleFiles()[diffSel()]?.path ?? null,
        sidebarW: preferredSidebarW(),
        recentFolders: recentFolders(),
        lastSpawns: lastSpawns(),
        customCommands: customCommands(),
        paletteUsage: paletteUsage(),
        filesShowHidden: showHiddenFiles(),
        filesShowIgnored: showIgnoredFiles(),
      };
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveAppState(snapshot), 400);
    });
    createEffect(() => {
      activeViewId();
      activeDockTab();
      dockMode();
      preferredDockHeight();
      workbenchFocusZone();
      editorPath();
      visibleFiles()[fileSel()]?.node.path;
      diffVisibleFiles()[diffSel()]?.path;
      workspaceUiState();
      const controllerSnapshot = workspaceUiController.snapshot();
      if (!controllerSnapshot.loaded || !controllerSnapshot.repository) return;
      const next = stateWithCurrentWorkspaceView();
      if (serializeWorkspaceUiState(next) === serializeWorkspaceUiState(controllerSnapshot.state))
        return;
      markWorkspaceUiDomainsTouched(next, controllerSnapshot.state);
      const generation = controllerSnapshot.generation;
      if (workspaceUiSaveTimer) clearTimeout(workspaceUiSaveTimer);
      workspaceUiSaveTimer = setTimeout(() => {
        workspaceUiSaveTimer = null;
        commitWorkspaceUiState(generation, next);
      }, 400);
    });

    onMount(() => {
      // Copy relies on the surrounding tmux capturing our OSC52: turn on
      // set-clipboard (so the sequence lands in tmux's paste buffer AND is
      // forwarded to the real terminal — through ssh) and allow-passthrough,
      // best-effort, once at launch so the first copy already works.
      if (process.env.TMUX) {
        execFile("tmux", ["set-option", "-gq", "set-clipboard", "on"], () => {});
        execFile("tmux", ["set-option", "-gq", "allow-passthrough", "on"], () => {});
      }
      // `--edit <file>` boots straight into the editor; otherwise a persisted
      // openFile restores the buffer WITHOUT stealing the restored tab (post-render
      // so the native EditBuffer FFI is loaded).
      if (values.edit) openEditor(values.edit);
      if (mode() === "editor" && fileNodes().length === 0) loadFileList(workspaceDir());
      if (mode() === "diff") refreshStatus();
      // The mirror follows workspace identity, not which native surface owns
      // keyboard focus. Dock restore must not leave the terminal canvas blank.
      if (curTarget()) attach(curTarget());
      const t = setInterval(() => {
        // Edge auto-scroll (M25.6): while a mirror drag parks the pointer at
        // the pane's top/bottom content row, extend ~1 row per state tick —
        // the existing 8ms cadence, no new timers. The clamps stop it at the
        // scrollback top (up) / the live bottom (down); release or escape
        // clears the gesture (clearSelection / the release branch in `route`).
        if (mirror && dragAutoScroll && selecting?.surface === "mirror") {
          const paneId = selecting.paneId;
          const depth = mirror.scrollbackDepth(paneId);
          const cur = Math.min(scrollOffsets.get(paneId) ?? 0, depth);
          const next = dragAutoScroll === "up" ? Math.min(cur + 1, depth) : Math.max(cur - 1, 0);
          if (next !== cur) {
            scrollOffsets.set(paneId, next);
            extendSelection(lastDragPointer.x, lastDragPointer.y);
            dirty = true;
          }
        }
        if (!dirty || !mirror) return;
        dirty = false;
        const t0 = performance.now();
        // FB path: fetch geometry + cursor/offset + per-pane version only (no
        // styled-row rebuild) — the <pane_surface> reads cells via the blit and
        // gates its walk on the version, so unchanged panes cost nothing.
        const raw = mirror.panes(scrollOffsets, !FB_PANES);
        // Size truth (M22.8, event-driven M23.5): the effective window size is
        // the layout ROOT's WxH pushed by %layout-change (the pane bounding
        // box only seeds it before the first layout lands). When a co-attached
        // terminal sized the window away from our pinned canvas we surface the
        // honest hint AND center the grid — the offset is baked into
        // pane.left/top HERE (one place), so every render and pointer-routing
        // read (all expressed relative to pane.left/top or `inside(pane,…)`)
        // stays consistent for free without touching the mouse math. A re-pin
        // in flight suppresses the mismatch (D4b): between our refresh-client
        // -C and tmux's %layout-change the stale size is expected, and honest-
        // hinting it flashed "window sized by another terminal" + a letterbox
        // jump on every grow (measured).
        const pinned = lastPin;
        if (!pinned) {
          setPanes(raw);
          return;
        }
        const effective = mirror.windowSize() ?? effectiveWindowSize(raw);
        const mm = effective
          ? detectSizeMismatchWithRepin(pinned, effective, repinInFlight, performance.now())
          : null;
        // The transition completed (sizes agree) — retire the grace so a LATER
        // genuine co-attach shrink to exactly the old size still surfaces.
        if (effective && effective.cols === pinned.cols && effective.rows === pinned.rows) {
          repinInFlight = null;
        }
        setWindowMismatch(mm);
        const off = mm ? letterboxOffset(pinned, mm) : { x: 0, y: 0 };
        setPanes(
          off.x || off.y
            ? raw.map((p) => ({ ...p, left: p.left + off.x, top: p.top + off.y }))
            : raw,
        );
        // Under FB the real per-tick cost moved to the blit (tapped in the
        // renderable → same zz-perf.log); this tick is now geometry-only, so
        // don't pollute the "snapshot ms/tick" samples with its ~0ms.
        if (process.env.TMUX_IDE_ZZ_PERF && !FB_PANES) {
          try {
            appendFileSync("/tmp/zz-perf.log", `${(performance.now() - t0).toFixed(2)}\n`);
          } catch {
            /* perf tap only */
          }
        }
        tapInputTick(); // t2: this paint consumed the dirty flag — close open input samples
      }, 8);
      // Fleet via an ASYNC subprocess — the in-process data layer is a chain of
      // synchronous execs that blocks the event loop for seconds and swallows
      // input (mouse events die during the storm). The child does the work.
      let fleetInFlight = false;
      const refreshFleet = () => {
        pruneDragOverrides();
        // The M25.1 handshakes piggyback on the poll cadence: publish what the
        // app is showing, and consume any banner-click jump request.
        refreshFocusRecord();
        consumeJumpRequest();
        if (fleetInFlight) return;
        fleetInFlight = true;
        execFile("node", [cliPath, "team", "--json"], { timeout: 10_000 }, (err, stdout) => {
          fleetInFlight = false;
          if (err) return;
          try {
            const data = JSON.parse(stdout) as { projects?: FleetProject[] };
            setProjectsData(data.projects ?? []);
            noteAttention(data.projects ?? []);
            // Reconcile a RESTORED context session to its project dir once the
            // fleet lands (persistence carries the name, not the dir). One-shot:
            // only while contextDir is still unresolved.
            if (contextSession() && !contextDir()) {
              const dir = dirForSession(contextSession());
              if (dir) {
                setContextDir(dir);
                setDiffDir(dir);
                loadFileList(dir);
                if (mode() === "diff") refreshStatus();
              }
            }
          } catch {
            // keep the previous fleet on parse trouble
          }
        });
      };
      fleetRefresh = refreshFleet;
      refreshFleet();
      const fleetTimer = setInterval(refreshFleet, 3000);
      // While the diff panel is up, re-poll git so external edits surface.
      const diffTimer = setInterval(() => {
        if (mode() === "diff") refreshStatus();
      }, 3000);
      cleanupRegistry.set("state-and-fleet-timers", () => {
        clearInterval(t);
        clearInterval(fleetTimer);
        clearInterval(diffTimer);
        if (saveTimer) clearTimeout(saveTimer);
        if (workspaceUiSaveTimer) clearTimeout(workspaceUiSaveTimer);
        if (noteTimer) clearTimeout(noteTimer);
      });
      cleanupRegistry.set("terminal-and-editor", () => {
        mirror?.dispose();
        editBuffer?.destroy();
      });
    });

    const snapLive = (paneId: string) => {
      if (scrollOffsets.get(paneId)) {
        scrollOffsets.set(paneId, 0);
        markDirty();
      }
    };

    // ── SCROLLBACK SEARCH — session control (M20.3) ──────────────────────────
    /** Depth (scrollback budget) + height of a pane from the current snapshot —
     *  the geometry `offsetForMatch` needs to place a match line on screen. */
    const paneScrollGeometry = (paneId: string): { depth: number; viewH: number } => {
      const p = panes().find((x) => x.id === paneId);
      return { depth: p?.scrollbackDepth ?? 0, viewH: p?.height ?? 0 };
    };
    /** Scroll the pane so its CURRENT match sits mid-viewport, and re-render. */
    const jumpToCurrent = (paneId: string) => {
      const ps = paneSearches().get(paneId);
      if (!ps || ps.current < 0) return;
      const m = ps.matches[ps.current];
      if (!m) return;
      const { depth, viewH } = paneScrollGeometry(paneId);
      scrollOffsets.set(paneId, offsetForMatch(m.line, depth, viewH));
      markDirty();
    };
    /** `/` — open the search input on the focused pane (Terminal mode only). */
    const openSearch = () => {
      if (!mirror) return;
      setSearch({ query: "", editing: true });
    };
    /** esc — leave search entirely: drop every pane's matches (highlights gone),
     *  keep each pane's scroll position where the last jump left it. */
    const exitSearch = () => {
      setSearch(null);
      if (paneSearches().size > 0) setPaneSearches(new Map());
      markDirty();
    };
    /** Enter — run the query against the focused pane's FULL buffer, store the
     *  match set for that pane, jump to the nearest (bottom-most) match, and drop
     *  from editing into navigation. An empty/zero-match query stays visible with
     *  a "no matches" count so the user can retype. */
    const executeSearch = () => {
      const s = search();
      if (!s || !mirror) return;
      const query = s.query;
      setSearch({ query, editing: false });
      if (query.length === 0) return;
      const pid = mirror.focusedPane();
      if (!pid) return;
      // Store matches bottom-up (nearest the live viewport first) so the landed
      // match reads "1/N" and n walks upward — see visitOrder.
      const matches = visitOrder(findMatches(mirror.bufferLines(pid), query));
      const next = new Map(paneSearches());
      next.set(pid, { query, matches, current: 0 });
      setPaneSearches(next);
      if (matches.length > 0) jumpToCurrent(pid);
      markDirty();
    };
    /** n / N — cycle the focused pane's current match and re-scroll to it. */
    const jumpMatch = (dir: 1 | -1) => {
      const pid = mirror?.focusedPane();
      if (!pid) return;
      const ps = paneSearches().get(pid);
      if (!ps || ps.matches.length === 0) return;
      const next = new Map(paneSearches());
      next.set(pid, { ...ps, current: stepMatch(ps.current, dir, ps.matches.length) });
      setPaneSearches(next);
      jumpToCurrent(pid);
    };
    /** The "3/17 matches" tally for the focused pane's search (input-line status). */
    const searchStatus = (): string => {
      const pid = mirror?.focusedPane();
      const ps = pid ? paneSearches().get(pid) : undefined;
      if (!ps || search()?.editing) return "";
      if (ps.matches.length === 0) return "no matches";
      return `${ps.current + 1}/${ps.matches.length} matches`;
    };
    /** Feed one key to the open search session. In `editing` the query grows and
     *  Enter runs it; in navigation n/N cycle, `/` re-opens editing, esc exits.
     *  Search OWNS the keyboard while open, so no key leaks to the pane. */
    const searchKey = (evt: {
      name: string;
      ctrl: boolean;
      meta: boolean;
      shift: boolean;
    }): void => {
      const s = search();
      if (!s) return;
      if (s.editing) {
        if (evt.name === "escape") exitSearch();
        else if (evt.name === "return") executeSearch();
        else if (evt.name === "backspace")
          setSearch({ query: s.query.slice(0, -1), editing: true });
        else if (evt.name.length === 1 && !evt.ctrl && !evt.meta)
          setSearch({
            query: s.query + (evt.shift ? evt.name.toUpperCase() : evt.name),
            editing: true,
          });
        return;
      }
      if (evt.name === "escape") exitSearch();
      else if (evt.name === "n") jumpMatch(evt.shift ? -1 : 1);
      else if (evt.name === "return") jumpMatch(1);
      else if (evt.name === "/") setSearch({ query: "", editing: true });
    };

    // ── PASTE-BUFFER PICKER — io (M20.3) ─────────────────────────────────────
    /** Insert `text` into the focused surface: the editor buffer as ONE undo unit,
     *  else the focused pane wrapped in bracketed-paste markers (the coalescer
     *  chunks under tmux's send-keys cap). The shared paste path — bracketed-paste
     *  input and the buffer picker both funnel here. */
    const pasteIntoFocused = (text: string) => {
      if (!text) return;
      const target = resolveWorkbenchPasteTarget({
        focusZone: workbenchProjection().focusZone,
        focusedPanel: focusedWorkbenchPanel(),
        filesEditorFocused: filesFocus() === "editor",
        filesEditorWritable: Boolean(editBuffer && !editorReadOnly()),
        terminalAvailable: Boolean(mirror),
      });
      if (target === "consume") return;
      if (target === "files-editor" && editBuffer) {
        editBuffer.insertText(text); // single insertText call = one undo unit
        setEditorModified(true);
        editorSyncScroll();
        setEditorRev((r) => r + 1);
        setStatusNote(`pasted ${text.length} chars`);
        return;
      }
      if (target === "terminal" && mirror) {
        const pane = mirror.focusedPane();
        if (!pane) return;
        // Chunking under tmux's per-command cap happens in the input coalescer
        // (SEND_KEYS_CHUNK_BYTES, input-coalescer.ts) — one path for typing,
        // mouse and paste keeps the byte order a single-writer problem.
        mirror.sendTextTo(pane, "\x1b[200~");
        mirror.sendTextTo(pane, text);
        mirror.sendTextTo(pane, "\x1b[201~");
        setStatusNote(`pasted ${text.length} chars`);
      }
    };
    /** Load the tmux paste buffers into the picker (name + sanitized sample). Runs
     *  over the control client when a session is mirrored, else a plain execFile —
     *  buffers are global tmux state, so either reaches them. */
    const loadBuffers = () => {
      const generation = paletteBufferLoadGate.begin();
      setPaletteBuffers([]); // loading / empty placeholder
      const fmt = `#{buffer_name}\t#{buffer_sample}`;
      const done = (lines: string[]) => {
        paletteBufferLoadGate.commit(generation, () => {
          setPaletteBuffers(parseBufferList(lines));
          setPaletteSel(0);
          setPaletteTop(0);
        });
      };
      const failed = () => {
        paletteBufferLoadGate.commit(generation, () => setPaletteBuffers([]));
      };
      if (mirror) {
        void mirror
          .command(`list-buffers -F ${tmuxQuote(fmt)}`)
          .then(done)
          .catch(failed);
        return;
      }
      execFile("tmux", ["list-buffers", "-F", fmt], (err, stdout) => {
        if (err) return failed();
        done(stdout.split("\n").filter((l) => l.length > 0));
      });
    };
    /** Fetch one buffer's content and paste it. The control client reads replies as
     *  latin1 (byte-per-char) so multibyte glyphs must be re-encoded latin1→utf8
     *  (the same fix the pane seed uses) before hitting the paste path. */
    const pasteBuffer = (name: string) => {
      closePalette();
      setPaletteSel(0);
      setPaletteTop(0);
      if (mirror) {
        void mirror
          .command(`show-buffer -b ${tmuxQuote(name)}`)
          .then((lines) =>
            pasteIntoFocused(Buffer.from(lines.join("\n"), "latin1").toString("utf8")),
          )
          .catch(() => {});
        return;
      }
      execFile("tmux", ["show-buffer", "-b", name], (err, stdout) => {
        if (!err) pasteIntoFocused(stdout);
      });
    };

    // ── clipboard io (M19.4) ──────────────────────────────────────────────────
    // Copy rides OSC52 written to the app's OWN stdout: with `set-clipboard on`
    // (enabled best-effort at mount) the surrounding tmux captures it into its
    // paste buffer AND forwards it onward — through ssh — to the real terminal's
    // clipboard. pbcopy is a local-darwin belt-and-braces. Selections above the
    // cap refuse rather than blast a megabyte down the wire.
    const copyText = (text: string) => {
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes === 0) return;
      if (bytes > MAX_CLIP_BYTES) {
        setStatusNote(`selection too large (${bytes} bytes) — not copied`);
        return;
      }
      const b64 = Buffer.from(text, "utf8").toString("base64");
      // Write the sequence to /dev/tty DIRECTLY: the renderer owns process.stdout
      // with its own frame writer, and out-of-band writes there never reach the
      // terminal (measured — the raw mechanism works from a plain pane).
      try {
        const fd = openSync("/dev/tty", "w");
        writeSync(fd, osc52Sequence(b64));
        closeSync(fd);
      } catch {
        try {
          process.stdout.write(osc52Sequence(b64));
        } catch {
          // stdout gone — pbcopy below may still catch it
        }
      }
      const local = !process.env.SSH_TTY && !process.env.SSH_CONNECTION;
      if (process.platform === "darwin" && local) {
        try {
          const pb = spawn("pbcopy");
          pb.on("error", () => {});
          pb.stdin.end(text);
        } catch {
          // no pbcopy — OSC52 already sent
        }
      }
      setStatusNote(`copied ${text.length} chars`);
    };

    /** The focused-window pane's snapshot rows as plain strings (runs joined),
     *  reflecting exactly what's on screen incl. the current scrollback offset —
     *  the source of truth for a mirror copy (not capture-pane). */
    const paneRowTexts = (paneId: string): string[] => {
      const p = panes().find((x) => x.id === paneId);
      if (!p) return [];
      // FB path omits the styled rows (the blit reads cells directly), so read the
      // visible row text on demand from the mirror — same trim/collapse as the run
      // join, so extractSelection copies identically.
      if (p.snapshot.rows.length === 0) {
        return mirror?.visibleRowTexts(paneId, p.snapshot.scrollOffset) ?? [];
      }
      return p.snapshot.rows.map((runs) => runs.map((r) => r.text).join(""));
    };
    const commitMirrorCopy = (paneId: string, anchor: Cell, head: Cell) => {
      // Cells are ABSOLUTE buffer coordinates (M25.6); the extractor reads the
      // full span straight from the pane's buffer — scrollback included — with
      // the same trim/collapse as the old visible-rows path, built capped so a
      // runaway span never materializes unbounded (copyText still refuses over
      // MAX_CLIP_BYTES, with the honest over-limit byte count).
      const { start, end } = orderCells(anchor, head);
      const text = mirror?.extractText(paneId, start, end, MAX_CLIP_BYTES) ?? "";
      if (text.length > 0) {
        copyText(text);
        // A completed copy ends the pane's select mode (M22.9) — forwarding
        // resumes; the selection highlight stays until the next key/click.
        if (selectModePane() === paneId) setSelectModePane(null);
      }
    };
    /** Map a pointer inside the editor viewport to a buffer (line,col). */
    const editorCellAt = (x: number, gy: number): { line: number; col: number } =>
      clickToCursor({
        cx: x - sidebarW() - filesListW(),
        contentY: gy - HEADER_ROWS,
        gutterW: gutterWidth(editorLines().length),
        top: editorTop(),
        lines: editorLines(),
      });
    const editorCellAtDock = (localX: number, localY: number): { line: number; col: number } =>
      clickToCursor({
        cx: localX - filesListW(),
        contentY: localY - HEADER_ROWS,
        gutterW: gutterWidth(editorLines().length),
        top: editorTop(),
        lines: editorLines(),
      });
    /** The inclusive selected column interval on a mirror snapshot row (or editor
     *  buffer line), or null — used by both renders to inverse-tint the span. */
    const editorSelRange = (
      bufRow: number,
      lineLen: number,
    ): { from: number; to: number } | null => {
      const s = selection();
      if (!s || s.surface !== "editor") return null;
      const { start, end } = orderCells(s.anchor, s.head);
      return rowSelectionRange(bufRow, lineLen, start, end);
    };
    /** A mirror pane's rows with its search matches accent-tinted (all matches dim,
     *  the current one bright) and then the active selection inverse-tinted on top.
     *  Both are pure run-splits over the snapshot; either may be absent. Matches are
     *  keyed by ABSOLUTE buffer line, mapped to the visible row via the pane's
     *  depth − scrollOffset (see PaneMirror.bufferLines). */
    const paneSelRows = (pane: LivePane) => {
      let rows = pane.snapshot.rows;
      const ps = paneSearches().get(pane.id);
      if (ps && ps.matches.length > 0 && ps.query.length > 0) {
        const baseY = pane.scrollbackDepth - pane.snapshot.scrollOffset;
        const len = ps.query.length;
        rows = rows.map((runs, r) => {
          const line = baseY + r;
          let out = runs;
          ps.matches.forEach((m, idx) => {
            if (m.line !== line) return;
            out = tintRunsBg(
              out,
              m.col,
              m.col + len - 1,
              idx === ps.current ? SEARCH_CUR : SEARCH_HL,
            );
          });
          return out;
        });
      }
      const s = selection();
      if (s && s.surface === "mirror" && s.paneId === pane.id) {
        // Selection cells are ABSOLUTE buffer lines (M25.6) — map each visible
        // row through the same baseY the search pass uses above.
        const baseY = pane.scrollbackDepth - pane.snapshot.scrollOffset;
        const { start, end } = orderCells(s.anchor, s.head);
        rows = rows.map((runs, r) => {
          const rowLen = runs.reduce((n, run) => n + run.text.length, 0);
          const range = rowSelectionRange(baseY + r, rowLen, start, end);
          return range ? tintRunsInverse(runs, range.from, range.to) : runs;
        });
      }
      return rows;
    };

    // FB-path twins of the two paneSelRows passes, shaped as <pane_surface> props
    // (the renderable applies them over the blitted cells). Both are ABSOLUTE-
    // space inputs (M25.6): the selection range is absolute buffer cells and the
    // search matches absolute lines — the surface maps them to visible rows
    // per-frame against the pane's current baseY, so highlights ride the scroll.
    // Reading selection()/paneSearches() here subscribes the surface so the prop
    // re-sets — and the blit re-runs — only when they actually change.
    const mirrorSelForPane = (paneId: string): { start: Cell; end: Cell } | null => {
      const s = selection();
      if (!s || s.surface !== "mirror" || s.paneId !== paneId) return null;
      return orderCells(s.anchor, s.head);
    };
    const mirrorSearchForPane = (pane: LivePane): PaneSearchHighlight | null => {
      const ps = paneSearches().get(pane.id);
      if (!ps || ps.matches.length === 0 || ps.query.length === 0) return null;
      return {
        matches: ps.matches,
        current: ps.current,
        len: ps.query.length,
        baseY: pane.scrollbackDepth - pane.snapshot.scrollOffset,
      };
    };

    const paneCell = (pane: LivePane, gx: number, gy: number) => ({
      col: Math.max(0, Math.min(pane.width - 1, gx - sidebarW() - pane.left)),
      row: Math.max(0, Math.min(pane.height - 1, gy - HEADER_ROWS - pane.top)),
    });
    /** The view's current absolute top for a pane (M25.6): live scrollback
     *  depth − the clamped LOCAL offset, both read from the mirror/offset map
     *  at EVENT time — the LivePane snapshot lags one 8ms tick, and a wheel
     *  that just moved the offset must map the very next pointer cell right. */
    const paneBaseY = (paneId: string): number => {
      const depth = mirror?.scrollbackDepth(paneId) ?? 0;
      return depth - Math.max(0, Math.min(scrollOffsets.get(paneId) ?? 0, depth));
    };
    /** A pointer position as an ABSOLUTE buffer cell of `pane` (M25.6). */
    const paneAbsCell = (pane: LivePane, gx: number, gy: number): Cell => {
      const cell = paneCell(pane, gx, gy);
      return { row: paneBaseY(pane.id) + cell.row, col: cell.col };
    };

    // ── SCROLLBARS (M19.5) ────────────────────────────────────────────────────
    // The scroll geometry for one surface: the global column its 1-col track sits
    // in, the global y of the track's first row, the total content length, the
    // visible rows, and the current first-visible line. The RENDER draws the track
    // (`scrollbarCells`) and the ROUTER hit-tests / drags it (`scrollbarHitAt`,
    // `dragTop`, `pageTop`) from this ONE shape — the surface-bar discipline turned
    // vertical. `applyScrollTop` writes a new top back to the owning signal (mirror
    // scroll is an offset-from-live, so it converts top → offset).
    interface ScrollGeom {
      col: number; // global x of the track column
      top0: number; // global y of the track's first row
      contentLen: number;
      viewH: number;
      viewportTop: number; // first visible content line
      surface: ScrollSurface;
      visible: boolean;
    }
    const editorScrollGeom = (): ScrollGeom => {
      const contentLen = editorLines().length;
      const viewH = editorRows();
      return {
        col: dims().width - 1,
        top0: TABBAR_H + HEADER_ROWS,
        contentLen,
        viewH,
        viewportTop: clampTop(editorTop(), contentLen, viewH),
        surface: { surface: "editor" },
        visible: contentLen > viewH,
      };
    };
    const diffScrollGeom = (): ScrollGeom => {
      const contentLen = diffLines().length;
      const viewH = diffBodyRows();
      return {
        col: dims().width - 1,
        top0: TABBAR_H + HEADER_ROWS,
        contentLen,
        viewH,
        viewportTop: clampTop(diffTop(), contentLen, viewH),
        surface: { surface: "diff" },
        visible: contentLen > viewH,
      };
    };
    const mirrorScrollGeom = (pane: LivePane): ScrollGeom => {
      const depth = pane.scrollbackDepth;
      const viewH = pane.height;
      // The pane shows the last `viewH` rows of a (depth + viewH)-line buffer, so a
      // scroll offset of `n` lines up puts the first visible line at depth - n.
      return {
        col: sidebarW() + pane.left + pane.width - 1,
        top0: TABBAR_H + HEADER_ROWS + pane.top,
        contentLen: depth + viewH,
        viewH,
        viewportTop: depth - pane.snapshot.scrollOffset,
        surface: { surface: "mirror", paneId: pane.id, scrollbackDepth: depth },
        // Keep terminals clean: reveal only once the pane is actually scrolled up.
        visible: pane.snapshot.scrollOffset > 0 && depth > 0,
      };
    };
    /** The per-row thumb mask for a track (true = thumb cell), sized to `viewH`. */
    const scrollbarCells = (geom: ScrollGeom): boolean[] => {
      const t = scrollThumb(geom.viewportTop, geom.contentLen, geom.viewH);
      const out: boolean[] = [];
      for (let r = 0; r < geom.viewH; r++) out.push(r >= t.start && r < t.start + t.size);
      return out;
    };
    /** Write a new first-visible line to the surface owning `surface`. Editor/diff
     *  clamp to their content; the mirror converts top → offset-from-live and lets
     *  the 8ms pane tick re-render (same path as the wheel). */
    const applyScrollTop = (surface: ScrollSurface, top: number) => {
      if (surface.surface === "editor") {
        setEditorTop(clampTop(top, editorLines().length, editorRows()));
      } else if (surface.surface === "diff") {
        setDiffTop(clampTop(top, diffLines().length, diffBodyRows()));
      } else {
        const offset = Math.max(
          0,
          Math.min(surface.scrollbackDepth, surface.scrollbackDepth - top),
        );
        scrollOffsets.set(surface.paneId, offset);
        markDirty();
      }
    };
    /** Resolve a pointer to the scrollbar track cell under it, or null. Used in
     *  `route` on a left "down" BEFORE region routing so a thumb/track press wins
     *  over selection/click, and it only matches a VISIBLE track. */
    const scrollbarHitAt = (x: number, y: number): ScrollGeom | null => {
      const m = mode();
      let g: ScrollGeom | null = null;
      if (m === "editor") g = editorScrollGeom();
      else if (m === "diff") g = diffScrollGeom();
      else if (m === "mirror") {
        const cx = x - sidebarW();
        const cy = y - TABBAR_H - HEADER_ROWS;
        const pane = panes().find(
          (p) => cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height,
        );
        if (pane) g = mirrorScrollGeom(pane);
      }
      if (!g || !g.visible || x !== g.col) return null;
      const row = y - g.top0;
      if (row < 0 || row >= g.viewH) return null;
      return g;
    };
    const forwardPress = (pane: LivePane, gx: number, gy: number, release: boolean) => {
      const { col, row } = paneCell(pane, gx, gy);
      mirror?.sendTextTo(pane.id, sgrMouse(0, col, row, release)); // fire-and-forget
    };
    const wheel = (pane: LivePane, direction: "up" | "down", col: number, row: number) => {
      // Select mode reclaims the wheel for the LOCAL scrollback (M22.9) so
      // older output can be scrolled into view and selected.
      if (!wheelScrollsLocal(pane.appMouse, selectModePane() === pane.id)) {
        mirror?.sendTextTo(pane.id, sgrMouse(direction === "up" ? 64 : 65, col, row, false));
        return;
      }
      const cur = scrollOffsets.get(pane.id) ?? 0;
      const next =
        direction === "up"
          ? Math.min(cur + SCROLL_STEP, pane.scrollbackDepth)
          : Math.max(cur - SCROLL_STEP, 0);
      scrollOffsets.set(pane.id, next);
      markDirty();
    };

    /** Resolve the right-click target under (x,y) into a menu context — the SAME
     *  coordinate math the hover/click router uses. Returns null where a menu makes
     *  no sense (the tab bar, empty rows, the diff/editor body columns). */
    const resolveMenuTarget = (
      x: number,
      y: number,
    ): Omit<MenuState, "left" | "top" | "width" | "height"> | null => {
      if (y === 0) return null; // the surface tab bar owns row 0
      const gy = y - TABBAR_H;
      if (x < sidebarW()) {
        setHoveredDockTab(null);
        // SESSION rows carry the session menu; AGENT rows carry the lifecycle
        // menu (M23.1 — left-click still jumps). The gap, header, and
        // empty-state line have none. Route through the same sidebarHit the
        // click/hover resolvers use so the ranges never diverge.
        const hit = sidebarHit(gy, fleet().length, fleetAgents().length);
        if (hit?.kind === "agent") {
          const a = fleetAgents()[hit.index];
          if (!a) return null;
          return {
            region: "agent",
            title: `${a.kind} · ${a.session}`,
            items: MENU_ITEMS.agent,
            agent: a,
          };
        }
        if (hit?.kind !== "session") return null;
        const s = fleet()[hit.index];
        if (!s) return null;
        return {
          region: "session",
          title: s.name,
          items: MENU_ITEMS.session,
          session: s.name,
          sessionDir: dirForSession(s.name),
        };
      }
      const m = mode();
      if (m === "home") {
        // Only live-session rows carry the session menu; the registry / recents
        // rows have no context verbs (left-click launches / reopens).
        const r = homeItems()[homeItemIndexAt(gy)];
        if (!r || r.kind !== "session") return null;
        return {
          region: "session",
          title: r.session,
          items: MENU_ITEMS.session,
          session: r.session,
          sessionDir: r.dir,
        };
      }
      if (m === "editor") {
        const overList = x < sidebarW() + filesListW();
        const contentY = gy - HEADER_ROWS;
        if (!overList || contentY < 0) return null;
        const top = clampTop(fileTop(), visibleFiles().length, editorRows());
        const idx = top + contentY;
        const node = visibleFiles()[idx]?.node;
        if (!node) return null;
        return {
          region: "file",
          title: node.name,
          items: MENU_ITEMS.file,
          fileIndex: idx,
          filePath: node.path,
          fileIsDir: node.isDir,
          fileParent: node.isDir ? node.path : dirname(node.path),
        };
      }
      if (m === "diff") {
        const overList = x < sidebarW() + diffListW();
        const contentY = gy - HEADER_ROWS;
        if (!overList || contentY < 0) return null;
        const rows = diffRows();
        const top = clampTop(diffFileTop(), rows.length, diffBodyRows());
        const row = rows[top + contentY];
        if (!row || row.kind !== "file") return null;
        return {
          region: "difffile",
          title: basename(row.entry.path),
          items: MENU_ITEMS.difffile,
          diffPath: join(diffDir(), row.entry.path),
        };
      }
      // mirror: gy=0 is the WINDOW STRIP; gy=1 is per-pane native chrome —
      // a right-click there opens the window menu. The window under a label span is
      // the target; an empty-area / button right-click (span miss) falls back to the
      // ACTIVE window. This dual targeting means the menu still opens even if the
      // strip's known label-cell click swallow (see windowStripParts) eats the hit,
      // because the empty area to the right of the labels always routes.
      if (gy === 0) {
        const i = spanHit(windowSpans(), x);
        const tabs = windowTabs();
        const w = i >= 0 ? tabs[i] : tabs.find((t) => t.active);
        if (!w) return null;
        return {
          region: "window",
          title: w.name,
          items: MENU_ITEMS.window,
          windowIndex: w.index,
        };
      }
      // The pane canvas lives below the window strip (gy=0) + pane chrome (gy=1).
      if (gy < HEADER_ROWS) return null;
      const cx = x - sidebarW();
      const cy = gy - HEADER_ROWS;
      const pane = panes().find(
        (p) => cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height,
      );
      if (!pane) return null;
      return {
        region: "pane",
        title: pane.id,
        // App-mouse panes lead with "Select text…" / "Stop selecting" (M22.9)
        // and the per-pane drag-default toggle (M24.2).
        items: paneMenuItems(pane.appMouse, selectModePane() === pane.id, paneDrag(pane.id)),
        paneId: pane.id,
      };
    };

    const closeMenu = () => {
      clearTerminalPaneActionState();
      setMenuConfirm(null);
      setMenuInput(null);
      setMenuSub(null);
      setMenuSubSel(0);
      if (menu() !== null) setMenu(null);
    };

    /** The open submenu's items (the focused parent item's `children`), or null. */
    const submenuItems = (): MenuItem[] | null => {
      const m = menu();
      const si = menuSub();
      if (!m || si === null) return null;
      return m.items[si]?.children ?? null;
    };
    /** The open submenu column's placed geometry, or null — the same math the
     *  render lays out, so the click router hit-tests exactly what's drawn. */
    const submenuGeom = createMemo<MenuGeom | null>(() => {
      const m = menu();
      const si = menuSub();
      const kids = submenuItems();
      if (!m || si === null || !kids) return null;
      const { width, height } = menuDims(m.items[si]!.label, kids);
      const parent: MenuGeom = {
        left: m.left,
        top: m.top,
        width: m.width,
        height: m.height,
        itemCount: m.items.length,
      };
      const { left, top } = submenuPos(parent, si, width, height, dims().width, dims().height);
      return { left, top, width, height, itemCount: kids.length };
    });
    /** Open the submenu for the parent item at `index` (must have children). */
    const openSubmenu = (index: number) => {
      setMenuSel(index);
      setMenuConfirm(null);
      setMenuInput(null);
      setMenuSub(index);
      setMenuSubSel(0);
    };
    const closeSubmenu = () => {
      setMenuSub(null);
      setMenuSubSel(0);
    };

    /** Open the context menu at the pointer, clamped fully on-screen. */
    const openMenu = (
      targetX: number,
      y: number,
      screenX = targetX,
      explicitTarget?: Omit<MenuState, "left" | "top" | "width" | "height">,
    ) => {
      const t = explicitTarget ?? resolveMenuTarget(targetX, y);
      if (!t) {
        closeMenu();
        return;
      }
      const { width, height } = menuDims(t.title, t.items);
      const { left, top } = clampMenuPos(screenX, y, width, height, dims().width, dims().height);
      clearSelection();
      setMenuSel(0);
      setMenuConfirm(null);
      setMenuInput(null);
      setMenuSub(null);
      setMenuSubSel(0);
      setMenu({ ...t, left, top, width, height });
    };

    /** Run the menu item's side effect. Destructive io (kill/rename/delete) goes
     *  through ASYNC execFile/fs — never a sync exec near the render loop. */
    const runMenuAction = (id: string, input?: string) => {
      const m = menu();
      if (!m) return;
      const val = (input ?? "").trim();
      if (m.region === "agent") {
        // The sidebar agent row's lifecycle verbs (M23.1). restart/stop confirm
        // via DialogConfirm inside their flows; close fired through the menu's
        // armed "confirm: y" state (danger), so it runs immediately here.
        const a = m.agent!;
        closeMenu();
        if (id === "jump") jumpToAgent(a);
        else if (id === "restart") void restartAgentFlow(a);
        else if (id === "stop") void stopAgentFlow(a);
        else if (id === "close") closeAgentPane(a);
        return;
      }
      if (m.region === "session") {
        const name = m.session!;
        if (id === "attach") {
          closeMenu();
          openWorkspace(name, m.sessionDir ?? null);
          return;
        }
        if (id === "new-agent") {
          closeMenu();
          void newAgentFlow({ session: name, dir: m.sessionDir ?? null });
          return;
        }
        if (id === "kill") {
          execFile("tmux", ["kill-session", "-t", name], () =>
            setTimeout(() => fleetRefresh?.(), 200),
          );
          setStatusNote(`killed ${name}`);
          closeMenu();
          return;
        }
        if (id === "rename" && val) {
          execFile("tmux", ["rename-session", "-t", name, val], () =>
            setTimeout(() => fleetRefresh?.(), 200),
          );
          setStatusNote(`renamed ${name} → ${val}`);
        }
        closeMenu();
        return;
      }
      if (m.region === "file") {
        if (id === "open") {
          closeMenu();
          setFilesFocus("list");
          if (m.fileIndex !== undefined) activateFile(m.fileIndex);
          return;
        }
        if (id === "newfile" && val) {
          const p = join(m.fileParent ?? workspaceDir(), val);
          void writeFile(p, "", { flag: "wx" })
            .then(() => {
              setStatusNote(`created ${val}`);
              refreshTree(); // expansion-preserving (M24.6)
            })
            .catch((e) => setStatusNote(`create failed: ${(e as Error).message}`));
        } else if (id === "rename" && val && m.filePath) {
          const p = join(dirname(m.filePath), val);
          void rename(m.filePath, p)
            .then(() => {
              setStatusNote(`renamed → ${val}`);
              refreshTree();
            })
            .catch((e) => setStatusNote(`rename failed: ${(e as Error).message}`));
        } else if (id === "delete" && m.filePath) {
          void rm(m.filePath, { recursive: true, force: false })
            .then(() => {
              setStatusNote(`deleted ${basename(m.filePath!)}`);
              refreshTree();
            })
            .catch((e) => setStatusNote(`delete failed: ${(e as Error).message}`));
        }
        closeMenu();
        return;
      }
      if (m.region === "difffile") {
        if (id === "open" && m.diffPath) {
          closeMenu();
          openEditor(m.diffPath);
          return;
        }
        if (id === "copypath" && m.diffPath) copyText(m.diffPath);
        closeMenu();
        return;
      }
      if (m.region === "window") {
        const sess = curTarget();
        const idx = m.windowIndex;
        if (id === "new") {
          void mirror?.command(`new-window -t ${sess}:`).catch(() => {});
          setStatusNote("new window");
        } else if (id === "rename" && val && idx !== undefined) {
          void mirror?.command(`rename-window -t ${sess}:${idx} ${tmuxQuote(val)}`).catch(() => {});
          setStatusNote(`renamed window → ${val}`);
        } else if (id === "kill" && idx !== undefined) {
          void mirror?.command(`kill-window -t ${sess}:${idx}`).catch(() => {});
          setStatusNote("killed window");
        }
        closeMenu();
        return;
      }
      if (m.region === "pane") {
        const pid = m.paneId!;
        // Select mode (M22.9): pause forwarding for THIS pane so a drag selects
        // locally; exits on esc / a completed copy / focus leaving the pane.
        if (id === "select-text") {
          enterSelectMode(pid);
          closeMenu();
          return;
        }
        if (id === "select-text-off") {
          exitSelectMode();
          closeMenu();
          return;
        }
        // The drag-default toggle (M24.2): a session-scoped per-pane override
        // (pruned when the pane dies) flipping whether a plain drag selects
        // locally or forwards to the pane's app.
        if (id === "drag-select" || id === "drag-forward") {
          dragOverrides.set(pid, id === "drag-select" ? "select" : "forward");
          setStatusNote(
            id === "drag-select" ? "drag selects in this pane" : "drags forward to the app",
          );
          closeMenu();
          return;
        }
        // Synchronize-panes is a WINDOW option tmux won't notify us about, so we
        // flip it explicitly and re-query the strip. Keep the menu OPEN so the
        // ✓/✗ checkbox visibly flips (every other pane verb closes on fire).
        if (id === "sync-toggle") {
          const next = syncOn() ? "off" : "on";
          void mirror
            ?.command(`set-window-option -t ${pid} synchronize-panes ${next}`)
            .then(() => setTimeout(refreshWindows, 60))
            .catch(() => {});
          setStatusNote(`synchronize-panes ${next}`);
          return;
        }
        if (id.startsWith("layout:")) {
          const name = id.slice("layout:".length);
          void mirror?.command(`select-layout -t ${pid} ${name}`).catch(() => {});
          setStatusNote(`layout: ${name}`);
          closeMenu();
          return;
        }
        const cmd =
          id === "split-h"
            ? `split-window -h -t ${pid}`
            : id === "split-v"
              ? `split-window -v -t ${pid}`
              : id === "zoom"
                ? `resize-pane -Z -t ${pid}`
                : id === "swap-next"
                  ? `swap-pane -D -t ${pid}`
                  : id === "break"
                    ? // Pin the destination to THIS session — break-pane's default
                      // `-t` resolves to the globally-active client's session, which
                      // could fling the pane into an unrelated session.
                      `break-pane -s ${pid} -t ${curTarget()}:`
                    : id === "rotate"
                      ? `rotate-window -t ${pid}`
                      : id === "kill"
                        ? `kill-pane -t ${pid}`
                        : "";
        if (cmd) void mirror?.command(cmd).catch(() => {});
        closeMenu();
        return;
      }
    };

    /** Activate the item at `index`: input items open the inline line, danger items
     *  rearm to confirm (or fire when already armed), the rest run immediately. */
    const activateMenuItem = (index: number) => {
      const m = menu();
      if (!m) return;
      const item = m.items[index];
      if (!item) return;
      setMenuSel(index);
      if (item.children) {
        openSubmenu(index);
        return;
      }
      if (item.input !== undefined) {
        setMenuConfirm(null);
        setMenuInput(item.id === "rename" ? m.title : "");
        return;
      }
      if (item.danger) {
        if (menuConfirm() === index) runMenuAction(item.id);
        else setMenuConfirm(index);
        return;
      }
      runMenuAction(item.id);
    };

    /** Activate the submenu child at `childIndex` — the leaf verbs (layouts) run
     *  immediately and close the whole menu. */
    const activateSubItem = (childIndex: number) => {
      const kids = submenuItems();
      const child = kids?.[childIndex];
      if (!child) return;
      setMenuSubSel(childIndex);
      runMenuAction(child.id);
    };

    /** Feed one key to the open menu. */
    const menuKey = (evt: { name: string; ctrl: boolean; meta: boolean; shift: boolean }) => {
      const m = menu();
      if (!m) return;
      // Inline-input mode (rename / new file): type the value, enter confirms.
      if (menuInput() !== null) {
        if (evt.name === "escape") setMenuInput(null);
        else if (evt.name === "return")
          runMenuAction(m.items[menuSel()]?.id ?? "", menuInput() ?? "");
        else if (evt.name === "backspace") setMenuInput((s) => (s ?? "").slice(0, -1));
        else if (evt.name.length === 1 && !evt.ctrl && !evt.meta)
          setMenuInput((s) => (s ?? "") + (evt.shift ? evt.name.toUpperCase() : evt.name));
        return;
      }
      // SUBMENU level: the children column owns the keyboard until esc/left backs
      // out one level (the parent column stays open behind it).
      if (menuSub() !== null) {
        const kids = submenuItems() ?? [];
        if (evt.name === "escape" || evt.name === "left" || evt.name === "h") closeSubmenu();
        else if (evt.name === "j" || evt.name === "down")
          setMenuSubSel((s) => Math.min(kids.length - 1, s + 1));
        else if (evt.name === "k" || evt.name === "up") setMenuSubSel((s) => Math.max(0, s - 1));
        else if (evt.name === "return") activateSubItem(menuSubSel());
        return;
      }
      if (evt.name === "escape") {
        if (menuConfirm() !== null) setMenuConfirm(null);
        else closeMenu();
        return;
      }
      if (evt.name === "y" && menuConfirm() !== null) {
        runMenuAction(m.items[menuConfirm()!]?.id ?? "");
        return;
      }
      // right/l opens the submenu when the selected item has one (esc/left back out).
      if (evt.name === "right" || evt.name === "l") {
        if (m.items[menuSel()]?.children) openSubmenu(menuSel());
        return;
      }
      if (evt.name === "j" || evt.name === "down") {
        setMenuConfirm(null);
        setMenuSel((s) => Math.min(m.items.length - 1, s + 1));
      } else if (evt.name === "k" || evt.name === "up") {
        setMenuConfirm(null);
        setMenuSel((s) => Math.max(0, s - 1));
      } else if (evt.name === "return") {
        activateMenuItem(menuSel());
      }
    };

    useKeyboard((evt) => {
      const layer = resolveInputLayer(
        {
          dialogOpen: dialogStack.depth() > 0,
          menuOpen: Boolean(menu()),
          paletteOpen: paletteOpen(),
          searchOpen: Boolean(search()),
          mode: mode() === "mirror" ? "mirror" : mode(),
          activePanelInert: isHostedPanelInert(activePanel()),
          missionMode: missionWorkspaceModel().mode,
          editorFocus: filesFocus(),
          editorFilterOpen: filesQuery() !== null,
          diffFilterOpen: diffFilter() !== null,
          homePromptOpen: pathPrompt() !== null || sessionPrompt() !== null,
          configuredShortcutKeys: canvasHostedViews().flatMap((view) =>
            view.shortcut ? [view.shortcut.key] : [],
          ),
          compositeCycleAvailable: false,
        },
        evt,
        { hosted: HOSTED },
      );
      if (layer.kind === "lifecycle") {
        executeRendererCommand(rendererInvocationForLifecycle(layer.command));
        return;
      }
      if (layer.kind === "kitty-super-palette") {
        executeRendererCommand(
          rendererCommandInvocation(
            RENDERER_COMMAND_IDS.openPalette,
            {},
            { kind: "keyboard", surface: "workbench" },
          ),
        );
        return;
      }
      if (layer.kind === "kitty-super-suppressed") return;
      if (layer.kind === "dialog") {
        dialogKey(dialogStack, evt);
        return;
      }
      if (layer.kind === "menu") {
        menuKey(evt);
        return;
      }
      if (layer.kind === "palette") {
        paletteKey(evt);
        return;
      }
      if (layer.kind === "search") {
        searchKey(evt);
        return;
      }
      const canvasShortcut = workbenchCanvasPanelForShortcut(evt);
      if (canvasShortcut) {
        executeRendererCommand(
          rendererInvocationForCanvas(canvasShortcut, {
            kind: "keyboard",
            surface: "workbench",
          }),
        );
        return;
      }
      const dockShortcut = workbenchDockTabForShortcut(evt);
      if (dockShortcut) {
        executeRendererCommand(
          rendererInvocationForDock(dockShortcut, { kind: "keyboard", surface: "workbench" }),
        );
        return;
      }
      if (layer.kind === "global") {
        executeRendererCommand(rendererInvocationForGlobal(layer.command));
        return;
      }
      if (workbenchProjection().focusZone === "dock-tabs") {
        if (evt.name === "left" || evt.name === "h" || evt.name === "right" || evt.name === "l") {
          const next = moveWorkbenchDockTab(
            activeDockTab(),
            evt.name === "left" || evt.name === "h" ? "previous" : "next",
          );
          activateDockTab(next);
          setWorkbenchFocusZone("dock-tabs");
          return;
        }
        if (evt.name === "return" || evt.name === "enter" || evt.name === "down") {
          setDockMode("open");
          setWorkbenchFocusZone("dock-body");
          touchedWorkspaceDock = true;
          return;
        }
        if (evt.name === "escape" || evt.name === "up") {
          setWorkbenchFocusZone("canvas");
          touchedWorkspaceDock = true;
          return;
        }
        return;
      }
      if (workbenchProjection().focusZone === "dock-body" && activeDockTab() === "activity") {
        if (evt.name === "j" || evt.name === "down") moveActivitySelection(1);
        else if (evt.name === "k" || evt.name === "up") moveActivitySelection(-1);
        else if (evt.name === "escape") {
          setWorkbenchFocusZone("dock-tabs");
          touchedWorkspaceDock = true;
        }
        return;
      }
      if (layer.kind === "missions-detail" || layer.kind === "missions-board-history") {
        handleMissionsKey(evt);
        return;
      }
      if (layer.kind === "inert") return;
      if (
        layer.kind === "editor-filter" ||
        layer.kind === "editor-list" ||
        layer.kind === "editor-input"
      ) {
        // ^c with an active selection copies the buffer range (exact text — no
        // trailing trim); without a selection it falls through (no pane to reach
        // from the editor). Save / undo / redo work regardless of focused half.
        if (evt.ctrl && evt.name === "c") {
          const s = selection();
          const command = resolveCtrlCCommand({
            layer: "editor",
            hasEditorSelection: Boolean(s && s.surface === "editor"),
          });
          executeCtrlCCommand(command, {
            copyEditorSelection: () => {
              if (!s || s.surface !== "editor") return;
              const { start, end } = orderCells(s.anchor, s.head);
              copyText(extractSelection(editorLines(), start, end, false));
            },
            copyTerminalSelection: () => {},
            forwardTerminalCtrlC: () => {},
          });
          return;
        }
        if (evt.ctrl && evt.name === "s") {
          saveEditor();
          return;
        }
        if (evt.ctrl && evt.name === "z") {
          editBuffer?.undo();
          editorSyncScroll();
          setEditorRev((r) => r + 1);
          return;
        }
        if (evt.ctrl && evt.name === "y") {
          editBuffer?.redo();
          editorSyncScroll();
          setEditorRev((r) => r + 1);
          return;
        }
        // File LIST focus: j/k navigate, enter opens a file (→ editor focus) or
        // toggles a directory; `/` opens the live name filter, [ / ] hop the
        // changed files, H / I toggle hidden / gitignored visibility (M24.6).
        // Otherwise the EDITOR has focus and types; esc hands focus back to the
        // list.
        if (layer.kind === "editor-filter" || layer.kind === "editor-list") {
          const q = filesQuery();
          if (layer.kind === "editor-filter" && q !== null) {
            // Filter input active: printable chars narrow live; arrows move in
            // the FILTERED rows; enter activates the row (exiting the filter);
            // escape restores the full list and the pre-filter selection.
            if (evt.name === "escape") {
              setFilesQuery(null);
              const back = filesPreFilterPath ? indexOfPath(fileNodes(), filesPreFilterPath) : -1;
              const idx = back !== -1 ? back : 0;
              setFileSel(idx);
              setFileTop((t) => scrollToCursor(idx, t, editorRows(), visibleFiles().length));
            } else if (evt.name === "return") {
              const row = visibleFiles()[fileSel()];
              setFilesQuery(null);
              if (row) {
                const idx = indexOfPath(fileNodes(), row.node.path);
                if (idx !== -1) {
                  setFileSel(idx);
                  setFileTop((t) => scrollToCursor(idx, t, editorRows(), visibleFiles().length));
                  activateFile(idx);
                }
              }
            } else if (evt.name === "backspace") {
              setFilesQuery(q.slice(0, -1));
              setFileSel(0);
              setFileTop(0);
            } else if (evt.name === "down") {
              moveFileSel(1);
            } else if (evt.name === "up") {
              moveFileSel(-1);
            } else if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
              setFilesQuery(q + (evt.shift ? evt.name.toUpperCase() : evt.name));
              setFileSel(0);
              setFileTop(0);
            }
            return;
          }
          if (evt.name === "/") {
            filesPreFilterPath = visibleFiles()[fileSel()]?.node.path ?? null;
            setFilesQuery("");
            setFileSel(0);
            setFileTop(0);
          } else if (evt.name === "]") hopChanged(1);
          else if (evt.name === "[") hopChanged(-1);
          else if (evt.shift && evt.name === "h") toggleHiddenFiles();
          else if (evt.shift && evt.name === "i") toggleIgnoredFiles();
          else if (evt.name === "r") refreshTree();
          else if (evt.name === "j" || evt.name === "down") moveFileSel(1);
          else if (evt.name === "k" || evt.name === "up") moveFileSel(-1);
          else if (evt.name === "return") activateFile(fileSel());
          return;
        }
        if (evt.name === "escape") {
          setFilesFocus("list");
          return;
        }
        editorKey(evt);
        return;
      }
      if (layer.kind === "diff-filter" || layer.kind === "diff") {
        // The `/` filter owns the keyboard while active (M24.5): printable keys
        // narrow the grouped list live, escape/return clear + exit (widget
        // semantics), arrows still move the (filtered) selection.
        if (layer.kind === "diff-filter") {
          if (evt.name === "escape" || evt.name === "return") {
            setDiffFilter(null);
            diffFilterReselect();
          } else if (evt.name === "backspace") {
            setDiffFilter((q) => (q ?? "").slice(0, -1));
            diffFilterReselect();
          } else if (evt.name === "up") moveDiffSel(-1);
          else if (evt.name === "down") moveDiffSel(1);
          else if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
            setDiffFilter((q) => (q ?? "") + (evt.shift ? evt.name.toUpperCase() : evt.name));
            diffFilterReselect();
          }
          return;
        }
        // ^e / ^g / ^q are handled above; j/k move the file selection, s/u
        // stage/unstage the selected file (S/U everything), ]/[ jump between
        // hunks, `/` filters, and `r` forces a status+diff refresh.
        if (evt.name === "j" || evt.name === "down") moveDiffSel(1);
        else if (evt.name === "k" || evt.name === "up") moveDiffSel(-1);
        else if (evt.name === "s" && evt.shift) stageAll();
        else if (evt.name === "u" && evt.shift) unstageAll();
        else if (evt.name === "s") {
          const cur = diffVisibleFiles()[diffSel()];
          if (cur) stageEntry(cur);
        } else if (evt.name === "u") {
          const cur = diffVisibleFiles()[diffSel()];
          if (cur) unstageEntry(cur);
        } else if (evt.name === "]") jumpHunk(1);
        else if (evt.name === "[") jumpHunk(-1);
        else if (evt.name === "/" && !evt.ctrl && !evt.meta) setDiffFilter("");
        else if (evt.name === "r") refreshStatus();
        return;
      }
      if (layer.kind === "home-prompt" || layer.kind === "home") {
        // Path-input line (`o` to open); while prompting, every key feeds it.
        if (layer.kind === "home-prompt" && pathPrompt() !== null) {
          if (evt.name === "escape") setPathPrompt(null);
          else if (evt.name === "return") {
            const p = pathPrompt()!.trim();
            setPathPrompt(null);
            if (p) openEditor(p);
          } else if (evt.name === "backspace") setPathPrompt((s) => (s ?? "").slice(0, -1));
          else if (evt.name.length === 1 && !evt.ctrl && !evt.meta)
            setPathPrompt((s) => (s ?? "") + (evt.shift ? evt.name.toUpperCase() : evt.name));
          return;
        }
        // Session-name input line (`n` / the [n new session] chip) — same shape.
        if (layer.kind === "home-prompt" && sessionPrompt() !== null) {
          if (evt.name === "escape") setSessionPrompt(null);
          else if (evt.name === "return") submitSessionPrompt();
          else if (evt.name === "backspace") setSessionPrompt((s) => (s ?? "").slice(0, -1));
          else if (evt.name.length === 1 && !evt.ctrl && !evt.meta)
            setSessionPrompt((s) => (s ?? "") + (evt.shift ? evt.name.toUpperCase() : evt.name));
          return;
        }
        if (evt.name === "o") {
          runHomeAction("open-file");
          return;
        }
        // `f` — open a folder (M22.5): the [f open folder] chip / welcome action /
        // palette command's keyboard twin. Launches the filesystem picker.
        if (evt.name === "f") {
          runHomeAction("open-folder");
          return;
        }
        // `n` — the [n new session] chip's keyboard twin.
        if (evt.name === "n") {
          runHomeAction("new-session");
          return;
        }
        // `a` — the row [+ agent] chip's keyboard twin (M23.1): spawn an agent
        // for the selected row (or a fresh session when nothing is selected).
        if (evt.name === "a") {
          runHomeAction("new-agent");
          return;
        }
        // `d` — open the diff panel for the selected row's project dir (the
        // home item carries it via the team payload), adopting it as context.
        if (evt.name === "d") {
          runHomeAction("open-diff");
          return;
        }
        if (evt.name === "j" || evt.name === "down") {
          setSel(stepSelectable(homeItems(), clampedSel(), 1));
        } else if (evt.name === "k" || evt.name === "up") {
          setSel(stepSelectable(homeItems(), clampedSel(), -1));
        } else if (evt.name === "return") {
          activateHomeItem(clampedSel());
        }
        return;
      }
      if (evt.ctrl && evt.name === "t") {
        const tabs = windowTabs();
        if (tabs.length > 1 && mirror) {
          const cur = tabs.findIndex((w) => w.active);
          mirror.switchWindow(tabs[(cur + 1) % tabs.length]!.index);
        }
        return;
      }
      if (evt.ctrl && evt.name === "o") {
        const ps = panes();
        if (ps.length > 1 && mirror) {
          const cur = ps.findIndex((p) => p.id === mirror!.focusedPane());
          mirror.focus(ps[(cur + 1) % ps.length]!.id);
        }
        return;
      }
      if (!mirror) return;
      // Escape ends select mode (M22.9) — forwarding resumes; the key is
      // consumed here rather than sent to the pane's app.
      if (evt.name === "escape" && selectModePane() !== null) {
        exitSelectMode();
        setStatusNote("select mode off");
        return;
      }
      // `/` opens scrollback search ONLY when the focused pane is scrolled into
      // history — at the live prompt `/` belongs to the PANE (agents' slash
      // commands; user report 2026-07-11: "we cannot hijack that"). Scrolled up,
      // you're reading, not talking, so `/` means find. At the live bottom the
      // palette's "Search scrollback" action is the entry. Once search is open
      // it owns the keyboard as before.
      if (
        evt.name === "/" &&
        !evt.ctrl &&
        !evt.meta &&
        (scrollOffsets.get(mirror.focusedPane()) ?? 0) > 0
      ) {
        openSearch();
        return;
      }
      // ^c copies an active mirror selection; with no selection it passes through
      // to the pane (interrupt) exactly as before.
      if (evt.ctrl && evt.name === "c") {
        const s = selection();
        const command = resolveCtrlCCommand({
          layer: "terminal",
          mirrorAvailable: Boolean(mirror),
          hasTerminalSelection: Boolean(s && s.surface === "mirror"),
        });
        executeCtrlCCommand(command, {
          copyEditorSelection: () => {},
          copyTerminalSelection: () => {
            if (!s || s.surface !== "mirror") return;
            commitMirrorCopy(s.paneId, s.anchor, s.head);
          },
          forwardTerminalCtrlC: () => {
            const pane = mirror?.focusedPane();
            if (!pane || !mirror) return;
            clearSelection();
            snapLive(pane);
            tapInputSent(pane); // t0: keystroke dispatched to the pane
            mirror.sendKey("C-c");
          },
        });
        return;
      }
      // Any key that reaches the pane retires a stale selection highlight.
      clearSelection();
      snapLive(mirror.focusedPane());
      tapInputSent(mirror.focusedPane()); // t0: keystroke dispatched to the pane
      // The input fast path (M21.5): sendKey/sendText are fire-and-forget —
      // no reply Promise, literals coalesced (ordering preserved downstream).
      if (evt.ctrl && evt.name.length === 1) {
        mirror.sendKey(`C-${evt.name}`);
        return;
      }
      const named = KEYMAP[evt.name];
      if (named) {
        mirror.sendKey(named);
        return;
      }
      if (evt.name.length === 1 && !evt.meta) {
        mirror.sendText(evt.shift ? evt.name.toUpperCase() : evt.name);
      }
    });

    // Bracketed paste arrives as a discrete PasteEvent (OpenTUI detects the
    // \x1b[200~…\x1b[201~ markers on stdin). Route it to the focused surface: the
    // EDITOR inserts at the cursor as ONE undo unit; the TERMINAL forwards it to
    // the focused pane re-wrapped in bracketed markers (so apps see a paste, not
    // keystrokes); the input coalescer chunks it under tmux's per-command cap.
    usePaste((e) => {
      const text = decodePasteBytes(e.bytes);
      if (paletteOpen()) {
        // The root remains the only paste listener. An action-level paste edits
        // the query; the buffer picker consumes it. Neither can leak bytes into
        // a terminal hidden underneath the modal surface.
        if (paletteBuffers() === null) {
          setPaletteQueryAndReset(appendPalettePaste(paletteQuery(), text));
        }
        return;
      }
      pasteIntoFocused(text);
    });

    /** The per-window strip's x-spans — one segment per tmux window, laid out from
     *  the main column's first cell (SIDEBAR_W + paddingLeft 1) with a 1-cell gap,
     *  exactly matching the rendered `flexDirection="row" gap={1}` row. Shared by
     *  the router (click + hover hit test) and, cell-for-cell, by the render. The
     *  labels MUST equal the rendered segment strings for the math to hold. */
    const windowLabels = () => windowTabs().map((w) => ` ${w.index}:${w.name} `);
    const windowSpans = createMemo(() => spans(windowLabels(), sidebarW() + 1, 1));

    // ── HEADER-ROW AFFORDANCE BUTTONS (M19.5) ────────────────────────────────
    // Clickable chips on the always-present header rows, right-aligned so their
    // x-spans are pinned to the (fixed) container right edge regardless of the
    // variable-width title/status text to their left (see `spansFromRight`). Both
    // the render (a flexGrow spacer then the button texts) and the router read the
    // SAME memo, so a click lands exactly where it's drawn — the surface-bar
    // pattern, on mount-time rows only (no late-mounted <For> box wrappers). The
    // button SET is derived from live signals so render and route always agree.
    interface HeaderButton {
      id: string;
      label: string;
      /** Toggled-on chip (the zoom button while zoomed) — renders active-tinted. */
      active?: boolean;
    }
    // Every header row ends flush at the main column's right edge (no paddingRight
    // anywhere on the chain), which is the terminal width.
    const buttonRightEdge = () => dims().width;
    /** Buttons on the header row (gy=0): the editor's save/reload and the diff's
     *  refresh. Read-only or unopened files show only the actions that apply. */
    const headerButtons = createMemo<{ defs: HeaderButton[]; spans: Span[] }>(() => {
      const m = mode();
      const defs: HeaderButton[] = [];
      if (m === "editor" && editorPath()) {
        if (!editorReadOnly() && editorModified()) defs.push({ id: "save", label: "[● save]" });
        defs.push({ id: "reload", label: "[↻ reload]" });
      } else if (m === "diff") {
        defs.push({ id: "refresh", label: "[↻ refresh]" });
      }
      return {
        defs,
        spans: spansFromRight(
          defs.map((d) => d.label),
          buttonRightEdge(),
          1,
        ),
      };
    });
    // The focused pane and its window's zoom state, derived from the live geometry
    // (window_zoomed_flag is a window property, so every pane of the active window
    // reports the same value; reading the focused pane keeps the intent clear).
    const focusedLivePane = () => panes().find((p) => p.active);
    const isZoomed = () => focusedLivePane()?.zoomed ?? false;
    const runHomeAction = (id: HomeActionId, itemIndex = clampedSel()) => {
      if (id === "open-folder") void openFolderFlow();
      else if (id === "new-agent") newAgentFromHome(homeItems()[itemIndex] ?? selectedHomeItem());
      else if (id === "open-file") setPathPrompt("");
      else if (id === "new-session") setSessionPrompt("");
      else if (id === "primary") runHomeChip(itemIndex);
      else if (id === "open-diff") {
        const r = homeItems()[itemIndex] ?? selectedHomeItem();
        const dir = r && r.kind !== "header" ? (r.dir ?? invokeCwd) : invokeCwd;
        if (r && r.kind === "session") {
          setContextSession(r.session);
          setContextDir(dir);
        }
        enterDiff(dir);
      }
    };

    const runFilesAction = (id: FilesActionId) => {
      if (id === "save") saveEditor();
      else if (id === "reload") {
        const p = editorPath();
        if (p) openEditor(p);
      } else if (id === "filter") {
        filesPreFilterPath = visibleFiles()[fileSel()]?.node.path ?? null;
        setFilesQuery("");
        setFileSel(0);
        setFileTop(0);
      } else if (id === "toggle-hidden") toggleHiddenFiles();
      else if (id === "toggle-ignored") toggleIgnoredFiles();
      else if (id === "refresh") refreshTree();
    };

    /** The root pane-chrome dispatcher focuses before calling this command edge. */
    const runTerminalPaneAction = (paneId: string, id: string) => {
      if (id === "zoom") void mirror?.command(`resize-pane -Z -t ${paneId}`).catch(() => {});
    };

    /** The strip as THREE static texts (pre/active/post) whose STRINGS update.
     *  KNOWN UPSTREAM QUIRK: clicks landing exactly ON this row's label cells
     *  are swallowed before dispatch regardless of node structure (For-of-texts,
     *  static texts, handler-less — all tried; the surface bar with an identical
     *  pattern takes clicks fine). Non-label cells on the row route normally.
     *  ^t cycles windows; span routing handles whatever clicks arrive. */
    const windowStripParts = createMemo(() => {
      const tabs = windowTabs();
      const activeIdx = tabs.findIndex((w) => w.active);
      const label = (w: { index: number; name: string }) => ` ${w.index}:${w.name} `;
      return {
        pre: tabs.slice(0, Math.max(0, activeIdx)).map(label).join(" "),
        active: activeIdx >= 0 ? label(tabs[activeIdx]!) : "",
        post: tabs
          .slice(activeIdx + 1)
          .map(label)
          .join(" "),
      };
    });

    // ── M21.9 tab-bar / sidebar / home-row chips ─────────────────────────────
    /** The tab bar's right-aligned clickable chips: the workspace-context chip
     *  (when set — click shows its Terminal) and the palette hint (click opens
     *  the palette). Right-anchored so the variable note text to their left
     *  never shifts them — the render walks the SAME defs, so spans match. */
    const tabbarButtons = createMemo<{ defs: HeaderButton[]; spans: Span[] }>(() => {
      const defs: HeaderButton[] = [];
      if (contextSession()) defs.push({ id: "tab-context", label: `⧉ ${contextSession()} ` });
      defs.push({ id: "tab-palette", label: TABBAR_PALETTE_LABEL });
      return {
        defs,
        spans: spansFromRight(
          defs.map((d) => d.label),
          buttonRightEdge(),
          0,
        ),
      };
    });
    const runTabbarButton = (id: string) => {
      if (id === "tab-palette") {
        executeRendererCommand(
          rendererCommandInvocation(
            RENDERER_COMMAND_IDS.openPalette,
            {},
            { kind: "mouse", surface: "workbench" },
          ),
        );
      } else if (id === "tab-context" && contextSession()) switchTarget(contextSession());
    };
    /** Which chip (if any) column `x` hits on the row for `it`. */
    const homeChipAt = (
      it: HomeItem | undefined,
      x: number,
      itemIndex: number,
    ): "agent" | "primary" | null => {
      if (!it) return null;
      const localX = x - sidebarW();
      const row = homeSurfaceProjection().rows.find(
        (candidate) => candidate.itemIndex === itemIndex,
      );
      const action = row?.actionSpans.find(
        (span) => localX >= span.start && localX < span.start + span.width,
      );
      if (!action) return null;
      return action.id === "new-agent" ? "agent" : action.id === "primary" ? "primary" : null;
    };
    /** The `[+ agent]` chip's x-span on the sidebar's AGENTS header row and the
     *  empty-state row (M24.1) — right-anchored flush to the sidebar's edge; the
     *  render (label · flexGrow spacer · chip) lays out the same cells. */
    const agentsChipSpans = createMemo(() => spansFromRight([AGENTS_ADD_CHIP], sidebarW(), 0));

    /** Resolve the hovered {region, index} from pointer coords with the SAME
     *  geometry the click router uses, then update `hover` (no-op unless changed).
     *  Called on every motion event so the click branches below stay untouched;
     *  any position that isn't a hoverable row/segment clears the tint. */
    const resolveHover = (x: number, y: number) => {
      if (y === 0) {
        const bi = spanHit(tabbarButtons().spans, x);
        if (bi >= 0) {
          setHoverIf({ region: "tabbtn", index: bi });
          return;
        }
        const i = spanHit(surfaceSpans(), x);
        setHoverIf(i >= 0 ? { region: "surfacetab", index: i } : null);
        return;
      }
      const gy = y - TABBAR_H;
      if (x < sidebarW()) {
        // The sidebar footer's "F5 palette" segment is a chip (last screen row).
        if (y === dims().height - 1) {
          setHoverIf(
            spanHit([sidebarHint().buttonSpan], x) === 0 ? { region: "sidebtn", index: 0 } : null,
          );
          return;
        }
        const hit = sidebarHit(gy, fleet().length, fleetAgents().length);
        if (hit?.kind === "session") setHoverIf({ region: "sidebar", index: hit.index });
        else if (hit?.kind === "agent") setHoverIf({ region: "sidebaragent", index: hit.index });
        else if (hit?.kind === "agents-header") {
          // The [+ agent] chip lifts on its own; the rest of the header row
          // tints as the Team-dialog target (M24.1).
          setHoverIf(
            spanHit(agentsChipSpans(), x) === 0
              ? { region: "agentschip", index: 0 }
              : { region: "agentshdr", index: 0 },
          );
        } else if (hit?.kind === "agents-empty") {
          setHoverIf(
            spanHit(agentsChipSpans(), x) === 0 ? { region: "agentschip", index: 1 } : null,
          );
        } else setHoverIf(null);
        return;
      }
      const workbenchHit = workbenchShellHitTest(workbenchProjection(), x - sidebarW(), gy);
      if (workbenchHit?.kind === "canvas-rail" || workbenchHit?.kind === "dock-body-rail") {
        setHoveredDockTab(null);
        setHoverIf(null);
        return;
      }
      if (workbenchHit?.kind === "dock-tab") {
        setHoveredDockTab(workbenchHit.tabId);
        setHoverIf(null);
        return;
      }
      setHoveredDockTab(null);
      if (workbenchHit?.kind === "dock-action" || workbenchHit?.kind === "dock-tabs") {
        setHoverIf(null);
        return;
      }
      if (workbenchHit?.kind === "dock-body") {
        const localX = workbenchHit.localX;
        const localY = workbenchHit.localY;
        if (activeDockTab() === "files") {
          const hit = filesHitTest(filesSurfaceProjection(), localX, localY);
          if (hit?.area === "header" && hit.actionIndex !== undefined)
            setHoverIf({ region: "button", index: hit.actionIndex });
          else if (hit?.area === "list" && hit.rowIndex !== undefined)
            setHoverIf({ region: "files", index: hit.rowIndex });
          else setHoverIf(null);
        } else if (activeDockTab() === "changes") {
          const hit = changesHitTest(changesSurfaceProjection(), localX, localY);
          if (hit?.area === "header" && hit.actionIndex !== undefined)
            setHoverIf({ region: "button", index: hit.actionIndex });
          else if (hit?.area === "footer" && hit.actionIndex !== undefined)
            setHoverIf({ region: "diffverb", index: hit.actionIndex });
          else if (hit?.area === "list" && hit.rowIndex !== undefined)
            setHoverIf({ region: "diff", index: hit.rowIndex });
          else setHoverIf(null);
        } else if (activeDockTab() === "missions") {
          const hit = missionDashboardHitTest(missionsDashboard(), localX, localY);
          if (hit?.kind === "card") setHoverIf({ region: "missioncard", index: hit.hoverKey });
          else if (hit?.kind === "history" || hit?.kind === "detail-row")
            setHoverIf({ region: "missionhistory", index: hit.hoverKey });
          else setHoverIf(null);
        } else setHoverIf(null);
        return;
      }
      if (workbenchHit?.kind === "canvas") {
        // Canvas content begins after the shell's one-cell focus rail. The
        // legacy canvas hover routers expect body-local main-column x values.
        x = sidebarW() + workbenchHit.localX;
      }
      const m = mode();
      if (m === "home") {
        const action = homeActionAtProjection(homeSurfaceProjection(), x, gy, sidebarW(), 0);
        if (action?.source === "footer") {
          setHoverIf(
            action.actionIndex !== undefined
              ? { region: "button", index: action.actionIndex }
              : null,
          );
          return;
        }
        if (welcomeActionHit(gy, x)) {
          setHoverIf({ region: "welcomeopen", index: 0 });
          return;
        }
        const idx = homeItemIndexAt(gy);
        const it = homeItems()[idx];
        if (idx < 0 || !it || it.kind === "header") {
          setHoverIf(null);
          return;
        }
        const chip = homeChipAt(it, x, idx);
        setHoverIf({
          region: chip === "agent" ? "homeagentchip" : chip === "primary" ? "homechip" : "home",
          index: idx,
        });
        return;
      }
      if (m === "editor") {
        if (gy === 0) {
          const hit = filesHitTest(filesSurfaceProjection(), x - sidebarW(), gy);
          setHoverIf(
            hit?.area === "header" && hit.actionIndex !== undefined
              ? { region: "button", index: hit.actionIndex }
              : null,
          );
          return;
        }
        const contentY = gy - HEADER_ROWS;
        const overList = x < sidebarW() + filesListW();
        if (!overList || contentY < 0) {
          setHoverIf(null);
          return;
        }
        const top = clampTop(fileTop(), visibleFiles().length, editorRows());
        const idx = top + contentY;
        setHoverIf(
          idx >= 0 && idx < visibleFiles().length ? { region: "files", index: idx } : null,
        );
        return;
      }
      if (m === "diff") {
        const hit = changesHitTest(changesSurfaceProjection(), x - sidebarW(), gy);
        if (hit?.area === "header" && hit.actionIndex !== undefined)
          setHoverIf({ region: "button", index: hit.actionIndex });
        else if (hit?.area === "footer" && hit.actionIndex !== undefined)
          setHoverIf({ region: "diffverb", index: hit.actionIndex });
        else if (hit?.area === "list" && hit.fileIndex !== undefined && hit.rowIndex !== undefined)
          setHoverIf({ region: "diff", index: hit.rowIndex });
        else setHoverIf(null);
        return;
      }
      if (m === "missions") {
        const hit = missionHitAt(x, y);
        if (hit?.kind === "mode") {
          setHoverIf({ region: "missionmode", index: hit.mode === "board" ? 0 : 1 });
        } else if (
          hit?.kind === "refresh" ||
          hit?.kind === "density" ||
          hit?.kind === "horizontal" ||
          hit?.kind === "collapse" ||
          hit?.kind === "zoom"
        ) {
          setHoverIf({
            region: "missionbutton",
            index:
              hit.kind === "refresh"
                ? 0
                : hit.kind === "density"
                  ? 1
                  : hit.kind === "horizontal"
                    ? hit.direction < 0
                      ? 2
                      : 3
                    : hit.kind === "collapse"
                      ? 4
                      : 5,
          });
        } else if (hit?.kind === "card") {
          setHoverIf({ region: "missioncard", index: hit.hoverKey });
        } else if (hit?.kind === "history") {
          setHoverIf({ region: "missionhistory", index: hit.hoverKey });
        } else if (hit?.kind === "detail-section") {
          setHoverIf({
            region: "missionbutton",
            index:
              10 +
              (hit.section === "tasks"
                ? 0
                : hit.section === "timeline"
                  ? 1
                  : hit.section === "attempts"
                    ? 2
                    : 3),
          });
        } else if (hit?.kind === "deep-link") {
          setHoverIf({
            region: "missionbutton",
            index: hit.link === "terminal" ? 20 : hit.link === "files" ? 21 : 22,
          });
        } else if (hit?.kind === "detail-row") {
          setHoverIf({ region: "missionhistory", index: hit.hoverKey });
        } else {
          setHoverIf(null);
        }
        return;
      }
      // mirror mode: the per-window strip lives on gy=0. Pane actions occupy the
      // segmented native row immediately above each framebuffer on gy=1.
      if (gy === 0) {
        const i = spanHit(windowSpans(), x);
        setHoverIf(i >= 0 ? { region: "windowtab", index: i } : null);
        return;
      }
      setHoverIf(null);
    };

    const terminalRouteX = (screenX: number) =>
      agentTerminalCanvasRouteX(screenX, workbenchProjection().canvasBody.x);

    /** Finish a terminal gesture that crosses into app-native chrome. Selection
     *  is committed, deferred clicks are cancelled, and forwarded app-mouse
     *  presses receive exactly one rail-corrected release. */
    const settleTerminalGestureBoundary = (e: RouteEvent) => {
      const activeSelection = selection();
      if (activeSelection?.surface === "mirror" && selecting?.surface === "mirror") {
        commitMirrorCopy(activeSelection.paneId, activeSelection.anchor, activeSelection.head);
      }
      selecting = null;
      dragAutoScroll = null;
      pendingPress = null;
      if (!forwardedDown) return;
      const pane = panesById().get(forwardedDown);
      forwardedDown = null;
      if (pane && selectModePane() !== pane.id) {
        forwardPress(pane, terminalRouteX(e.x), e.y - TABBAR_H, true);
      }
    };

    /** Route the native workbench seam before any legacy surface or tmux pane
     *  routing. Dock coordinates are content-local (after the one-cell focus
     *  rail), and every dock event is consumed so wheel/right-click/drag can
     *  never leak into the terminal transport beneath it. */
    const routeWorkbenchPointer = (e: RouteEvent): boolean => {
      if (e.y < TABBAR_H || e.x < sidebarW()) {
        clearTerminalPaneActionState();
        return false;
      }
      const hit = workbenchShellHitTest(workbenchProjection(), e.x - sidebarW(), e.y - TABBAR_H);
      if (!hit) {
        clearTerminalPaneActionState();
        return false;
      }
      if (hit.kind !== "canvas") clearTerminalPaneActionState();
      const releaseAtBoundary =
        hit.kind !== "canvas" &&
        (e.type === "up" || e.type === "drag-end" || e.type === "drop" || e.type === "out");
      if (releaseAtBoundary) {
        setPressedTerminalPaneAction(null);
        settleTerminalGestureBoundary(e);
        return true;
      }
      if (hit.kind === "canvas") {
        if (e.type === "up" || e.type === "drag-end" || e.type === "drop" || e.type === "out") {
          setPressedTerminalPaneAction(null);
        }
        if (canvasPanel() === "terminals") {
          const paneChromeIntent = terminalPaneChromePointerIntent(
            terminalPaneChromeLayout(),
            hit.localX,
            hit.localY,
            e.type,
            e.button ?? 0,
          );
          if (e.type === "move" || e.type === "over" || e.type === "drag") {
            const motion = terminalPaneChromeMotionState(
              paneChromeIntent,
              pressedTerminalPaneAction(),
            );
            setHoveredTerminalPaneAction(motion.hovered);
            setPressedTerminalPaneAction(motion.pressed);
          }
          if (paneChromeIntent) {
            setWorkbenchFocusZone("canvas");
            touchedWorkspaceDock = true;
            const openPaneActions = (paneId: string) => {
              const pane = panesById().get(paneId);
              if (!pane) return;
              openMenu(hit.localX, e.y, e.x, {
                region: "pane",
                title: pane.id,
                items: paneMenuItems(
                  pane.appMouse,
                  selectModePane() === pane.id,
                  paneDrag(pane.id),
                ),
                paneId: pane.id,
              });
            };
            dispatchTerminalPaneChromePointerIntent(paneChromeIntent, {
              hover: setHoveredTerminalPaneAction,
              focus: (paneId) => mirror?.focus(paneId),
              action: (paneId, actionId, actionIndex) => {
                setPressedTerminalPaneAction({ paneId, actionIndex });
                if (actionId === "menu") openPaneActions(paneId);
                else runTerminalPaneAction(paneId, actionId);
              },
              menu: openPaneActions,
              settle: () => settleTerminalGestureBoundary(e),
            });
            return true;
          }
        } else {
          clearTerminalPaneActionState();
        }
        const terminalPolicy =
          canvasPanel() === "terminals"
            ? agentTerminalCanvasPointerPolicy(
                terminalCanvasProjection(),
                hit.localX,
                hit.localY,
                e.type,
              )
            : "route";
        if (terminalPolicy === "settle-boundary") {
          settleTerminalGestureBoundary(e);
          return true;
        }
        if (terminalPolicy === "consume") return true;
        if (e.type === "down" || terminalPolicy === "focus-route") {
          setWorkbenchFocusZone("canvas");
          touchedWorkspaceDock = true;
        }
        return false;
      }
      if (hit.kind === "canvas-rail") {
        setHoveredDockTab(null);
        setHoverIf(null);
        if (e.type === "down") {
          setWorkbenchFocusZone("canvas");
          touchedWorkspaceDock = true;
        }
        return true;
      }

      if (e.type === "move" || e.type === "over" || e.type === "drag") {
        if (!(e.type === "drag" && selecting?.surface === "editor")) {
          resolveHover(e.x, e.y);
          return true;
        }
      }
      if (hit.kind === "dock-tab") {
        if (e.type === "down" && e.button !== 2) {
          executeRendererCommand(
            rendererInvocationForDock(hit.tabId, { kind: "mouse", surface: "workbench" }),
          );
        }
        return true;
      }
      if (hit.kind === "dock-action") {
        if (e.type === "down" && e.button !== 2) {
          setDockMode(hit.nextMode);
          setWorkbenchFocusZone(hit.nextMode === "collapsed" ? "dock-tabs" : "dock-body");
          touchedWorkspaceDock = true;
        }
        return true;
      }
      if (hit.kind === "dock-tabs" || hit.kind === "dock-body-rail") {
        if (e.type === "down") {
          setWorkbenchFocusZone(hit.kind === "dock-tabs" ? "dock-tabs" : "dock-body");
          touchedWorkspaceDock = true;
        }
        return true;
      }
      if (hit.kind !== "dock-body") return true;

      if (e.type === "down" || e.type === "scroll") {
        setWorkbenchFocusZone("dock-body");
        touchedWorkspaceDock = true;
      }
      const { localX, localY } = hit;
      if (activeDockTab() === "files") {
        const surfaceHit = filesHitTest(filesSurfaceProjection(), localX, localY);
        if (e.type === "scroll") {
          const direction = e.scroll?.direction;
          if (direction === "up" || direction === "down") {
            const step = direction === "up" ? -SCROLL_STEP : SCROLL_STEP;
            if (surfaceHit?.area === "list") {
              setFileTop((top) => clampTop(top + step, visibleFiles().length, editorRows()));
            } else if (surfaceHit?.area === "editor") {
              setEditorTop((top) => clampTop(top + step, editorLines().length, editorRows()));
            }
          }
          return true;
        }
        if (e.type === "drag" && selecting?.surface === "editor" && editBuffer) {
          const cell = editorCellAtDock(localX, localY);
          setSelection({
            surface: "editor",
            anchor: selAnchor,
            head: { row: cell.line, col: cell.col },
          });
          editBuffer.setCursor(cell.line, cell.col);
          setEditorRev((revision) => revision + 1);
          return true;
        }
        if (e.type === "up" || e.type === "drag-end" || e.type === "drop") {
          if (selecting?.surface === "editor") selecting = null;
          return true;
        }
        if (e.type !== "down" || e.button === 2) return true;
        hydratedWorkspaceSurfaceIds.add("files");
        if (surfaceHit?.area === "header" && surfaceHit.actionId) {
          runFilesAction(surfaceHit.actionId);
          return true;
        }
        if (surfaceHit?.area === "list" && surfaceHit.rowIndex !== undefined) {
          clearSelection();
          setFilesFocus("list");
          activateFile(surfaceHit.rowIndex);
          return true;
        }
        if (surfaceHit?.area !== "editor" || !editBuffer) return true;
        const { line, col } = editorCellAtDock(localX, localY);
        setFilesFocus("editor");
        const now = Date.now();
        const count = clickCount(lastClick, { row: line, col }, now, CLICK_MS);
        lastClick = { row: line, col, ts: now, count };
        if (count >= 2) {
          const text = editorLines()[line] ?? "";
          const range = count === 2 ? wordRangeAt(text, col) : lineRangeAt(text);
          setSelection({
            surface: "editor",
            anchor: { row: line, col: range.from },
            head: { row: line, col: range.to },
          });
          editBuffer.setCursor(line, range.to);
          selecting = null;
        } else {
          editBuffer.setCursor(line, col);
          selAnchor = { row: line, col };
          selecting = { surface: "editor" };
          setSelection(null);
        }
        setEditorRev((revision) => revision + 1);
        return true;
      }

      if (activeDockTab() === "changes") {
        const surfaceHit = changesHitTest(changesSurfaceProjection(), localX, localY);
        if (e.type === "scroll") {
          const direction = e.scroll?.direction;
          if (direction === "up" || direction === "down") {
            const step = direction === "up" ? -SCROLL_STEP : SCROLL_STEP;
            if (surfaceHit?.area === "list") {
              setDiffFileTop((top) => clampTop(top + step, diffRows().length, diffBodyRows()));
            } else if (surfaceHit?.area === "diff") {
              setDiffTop((top) => clampTop(top + step, diffLines().length, diffBodyRows()));
            }
          }
          return true;
        }
        if (e.type !== "down" || e.button === 2) return true;
        hydratedWorkspaceSurfaceIds.add("diff");
        if (
          (surfaceHit?.area === "header" || surfaceHit?.area === "footer") &&
          surfaceHit.actionId
        ) {
          runChangesAction(surfaceHit.actionId);
          return true;
        }
        if (surfaceHit?.area === "list" && surfaceHit.fileIndex !== undefined) {
          if (surfaceHit.actionId) runChangesAction(surfaceHit.actionId, surfaceHit.fileIndex);
          else selectDiffFile(surfaceHit.fileIndex);
        }
        return true;
      }

      if (activeDockTab() === "missions") {
        const missionHit = missionDashboardHitTest(missionsDashboard(), localX, localY);
        if (e.type === "scroll") {
          const direction = e.scroll?.direction;
          if (direction === "up" || direction === "down") {
            handleMissionSurfaceScroll(
              missionHit,
              direction,
              {
                model: missionWorkspaceModel(),
                snapshot: missionWorkspaceSnapshot(),
                layoutSize: missionLayoutSize(),
                persistedTaskId: missionSelectionFromWorkspaceState(
                  workspaceUiState(),
                  missionViewId(),
                ).selectedTaskId,
              },
              { updateModel: updateMissionModel },
              SCROLL_STEP,
            );
          }
          return true;
        }
        if (e.type === "down" && e.button !== 2) {
          hydratedWorkspaceSurfaceIds.add("missions");
          handleMissionSurfacePointerDown(
            missionHit,
            {
              model: missionWorkspaceModel(),
              snapshot: missionWorkspaceSnapshot(),
              layoutSize: missionLayoutSize(),
              persistedTaskId: missionSelectionFromWorkspaceState(
                workspaceUiState(),
                missionViewId(),
              ).selectedTaskId,
            },
            {
              updateModel: updateMissionModel,
              refresh: () => loadMissionsWorkspace("refresh"),
              followDeepLink: followMissionDeepLink,
              persistSelection: persistMissionSelection,
            },
          );
        }
        return true;
      }

      if (e.type === "scroll") {
        const direction = e.scroll?.direction;
        if (direction === "up" || direction === "down") {
          const delta = direction === "up" ? -SCROLL_STEP : SCROLL_STEP;
          setActivityScrollOffset((offset) =>
            Math.max(0, Math.min(activityProjection().maximumScrollOffset, offset + delta)),
          );
          hydratedWorkspaceSurfaceIds.add("activity");
          touchedWorkspaceSurfaceIds.add("activity");
        }
        return true;
      }
      if (e.type === "down" && e.button !== 2) {
        const row = activityRowHitTest(activityProjection(), localX, localY);
        if (row) setActivitySelectedId(row.rowId);
        hydratedWorkspaceSurfaceIds.add("activity");
        touchedWorkspaceSurfaceIds.add("activity");
      }
      return true;
    };

    /** One router, fed by the three always-present region containers (tab bar,
     *  sidebar, main). Geometry is ours. The tab bar is the top screen row; every
     *  other region is offset below it, so we subtract TABBAR_H once (`gy`) and the
     *  per-mode math below is exactly as it was before the bar existed. */
    /** Extend a live selection's head to the pointer. Mirror cells are ABSOLUTE
     *  (M25.6): the head derives from the pointer + the pane's CURRENT view
     *  offset, the anchor is re-based over any scrollback-cap rotation since
     *  the press, and the pointer parking at/beyond the pane's top/bottom
     *  content row arms the edge auto-scroll the 8ms tick drives. */
    const extendSelection = (x: number, y: number) => {
      if (!selecting) return;
      const gy = y - TABBAR_H;
      if (selecting.surface === "mirror") {
        const paneId = selecting.paneId;
        const pane = panes().find((p) => p.id === paneId);
        if (!pane) return;
        lastDragPointer = { x, y };
        const rawRow = gy - HEADER_ROWS - pane.top;
        dragAutoScroll = rawRow <= 0 ? "up" : rawRow >= pane.height - 1 ? "down" : null;
        setSelection({
          surface: "mirror",
          paneId: pane.id,
          anchor: trimAdjustCell(selAnchor, (mirror?.lineTrim(paneId) ?? 0) - selTrimBase),
          head: paneAbsCell(pane, x, gy),
        });
      } else {
        const { line, col } = editorCellAt(x, gy);
        setSelection({ surface: "editor", anchor: selAnchor, head: { row: line, col } });
        editBuffer?.setCursor(line, col);
        setEditorRev((r) => r + 1);
      }
    };

    const route = (e: RouteEvent) => {
      const { type, y } = e;
      const screenX = e.x;
      let { x } = e;
      zzlog(`${type} ${x},${y}${e.button !== undefined ? ` b${e.button}` : ""}`);
      // The FIRST handler in the bubble chain owns the event — stop here so a click
      // on a leaf container isn't re-processed by the root catch-all (and the
      // late-mounted menu overlay, whose only ancestor handler is root, is handled
      // exactly once there). Idempotent on the real MouseEvent; a no-op in tests.
      e.stopPropagation?.();
      // While a DIALOG is open it OWNS pointer routing (M22.4) — topmost, so
      // checked before the menu and the palette, with the SAME pure geometry the
      // render places the box with (dialogGeomNow / dialogRowAt / dialogContains
      // — the central-routing law; the overlay carries NO per-node handlers).
      // Motion over a row moves the selection (firing a select's onMove preview
      // hook), the wheel scrolls the select window, a left press on a row
      // activates it (select rows arm-then-confirm when destructive; confirm
      // rows choose), a press inside-but-not-a-row is a no-op, and a press
      // OUTSIDE pops ONE stack level — exactly what Escape does.
      if (dialogStack.depth() > 0) {
        const entry = dialogStack.top()!;
        const g = dialogGeomNow();
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir === "up" || dir === "down") dialogStack.scrollBy(dir === "up" ? -1 : 1);
          return;
        }
        if (type === "move" || type === "over" || type === "drag") {
          const ri = dialogRowAt(g, x, y);
          if (ri >= 0) {
            if (entry.spec.kind === "select") dialogStack.setSel(entry.state.top + ri);
            else if (entry.spec.kind === "confirm") dialogStack.setSel(ri);
          }
          return;
        }
        if (type !== "down") return;
        const ri = dialogRowAt(g, x, y);
        if (ri >= 0) {
          if (e.button === 2) return; // right press on a row: no-op, stay open
          if (entry.spec.kind === "select") dialogStack.activate(entry.state.top + ri);
          else if (entry.spec.kind === "confirm") dialogStack.choose(ri);
          // prompt: the input row — a click is a no-op (typing has focus)
          return;
        }
        if (!dialogContains(g, x, y)) dialogStack.dismiss();
        return;
      }
      // While the context menu is open it OWNS pointer routing: a down on an item
      // runs it (a submenu row wins over the parent), a down elsewhere inside a box
      // is a no-op (stays open), a down OUTSIDE both closes it. Motion CASCADES the
      // submenu the way a native menu does — hovering a parent item with children
      // opens its column; hovering a submenu row moves its selection.
      const openMenuState = menu();
      if (openMenuState) {
        const parentGeom: MenuGeom = {
          left: openMenuState.left,
          top: openMenuState.top,
          width: openMenuState.width,
          height: openMenuState.height,
          itemCount: openMenuState.items.length,
        };
        const sub = submenuGeom();
        if (type === "move" || type === "over" || type === "drag") {
          if (sub) {
            const si = menuItemAt(sub, x, y);
            if (si >= 0) {
              setMenuSubSel(si);
              return;
            }
          }
          const pi = menuItemAt(parentGeom, x, y);
          if (pi >= 0) {
            setMenuSel(pi);
            if (openMenuState.items[pi]?.children) openSubmenu(pi);
            else closeSubmenu();
          }
          return;
        }
        if (type !== "down") return;
        if (sub) {
          const si = menuItemAt(sub, x, y);
          if (si >= 0) {
            activateSubItem(si);
            return;
          }
          if (pointInMenu(sub, x, y)) return; // inside the submenu frame, no-op
        }
        const idx = menuItemAt(parentGeom, x, y);
        if (idx >= 0) activateMenuItem(idx);
        else if (!pointInMenu(parentGeom, x, y)) closeMenu();
        return;
      }
      // While the PALETTE is open it owns pointer routing. Action-level hits use
      // the native surface projection; the retained paste-buffer second level
      // uses its smaller legacy geometry. Both stay handler-free and modal.
      if (paletteOpen()) {
        const bufs = paletteBuffers();
        if (bufs === null) {
          const projection = paletteProjection();
          if (type === "scroll") {
            const dir = e.scroll?.direction;
            if (dir === "up" || dir === "down") {
              const step = dir === "up" ? -1 : 1;
              setPaletteTop((top) =>
                Math.max(0, Math.min(top + step, Math.max(0, projection.contentRowCount - 1))),
              );
            }
            return;
          }
          const hit = commandPaletteHitTest(projection, x, y);
          if (type === "move" || type === "over" || type === "drag") {
            if (hit?.kind === "command" && !hit.disabled) {
              setPaletteSelectedCommandId(hit.commandId);
            }
            return;
          }
          if (type !== "down") return;
          if (hit?.kind === "command") {
            if (e.button === 2 || hit.disabled) return;
            setPaletteSelectedCommandId(hit.commandId);
            dispatchPaletteCommand(paletteEntries(), hit.commandId, runPaletteAction);
            return;
          }
          if (hit?.kind === "retry") {
            if (e.button !== 2) openPalette();
            return;
          }
          if (hit === null) closePalette();
          return;
        }

        const g = paletteGeom();
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir === "up" || dir === "down") {
            const step = dir === "up" ? -1 : 1;
            setPaletteTop((t) => clampPaletteTop(t + step, bufs.length, PALETTE_ROWS));
          }
          return;
        }
        if (type === "move" || type === "over" || type === "drag") {
          const ri = paletteRowAt(g, x, y);
          // A header row is not selectable (M24.4) — motion over it keeps the
          // selection where it was, like the box chrome.
          if (ri >= 0) {
            const abs = paletteTop() + ri;
            setPaletteSel(abs);
          }
          return;
        }
        if (type !== "down") return;
        const ri = paletteRowAt(g, x, y);
        if (ri >= 0) {
          if (e.button === 2) return; // right press on a row: no-op, stay open
          const abs = paletteTop() + ri;
          setPaletteSel(abs);
          const b = bufs[abs];
          if (b) pasteBuffer(b.name);
          return;
        }
        if (!paletteContains(g, x, y)) closePalette();
        return;
      }
      if (!dragging && routeWorkbenchPointer(e)) return;
      if (e.y >= TABBAR_H && e.x >= sidebarW()) {
        const shellHit = workbenchShellHitTest(
          workbenchProjection(),
          e.x - sidebarW(),
          e.y - TABBAR_H,
        );
        if (shellHit?.kind === "canvas") x = terminalRouteX(e.x);
      }
      if (isHostedPanelInert(activePanel())) {
        if (type === "out") {
          setHoverIf(null);
          return;
        }
        if (type === "move" || type === "over" || type === "drag") {
          resolveHover(e.x, y);
          return;
        }
        if (mode() === "missions" && type === "scroll") {
          const hit = missionHitAt(x, y);
          const direction = e.scroll?.direction;
          if (direction !== "up" && direction !== "down") return;
          handleMissionSurfaceScroll(
            hit,
            direction,
            {
              model: missionWorkspaceModel(),
              snapshot: missionWorkspaceSnapshot(),
              layoutSize: missionLayoutSize(),
              persistedTaskId: missionSelectionFromWorkspaceState(
                workspaceUiState(),
                missionViewId(),
              ).selectedTaskId,
            },
            { updateModel: updateMissionModel },
            SCROLL_STEP,
          );
          return;
        }
        if (type !== "down") return;
        if (y === 0) {
          const tb = tabbarButtons();
          const bi = spanHit(tb.spans, x);
          if (bi >= 0) {
            runTabbarButton(tb.defs[bi]!.id);
            return;
          }
          const i = spanHit(surfaceSpans(), x);
          const view = canvasHostedViews()[i];
          if (view?.panel === "home" || view?.panel === "terminals") {
            executeRendererCommand(
              rendererInvocationForCanvas(view.panel, { kind: "mouse", surface: "workbench" }),
            );
          }
          return;
        }
        const gy = y - TABBAR_H;
        if (x < sidebarW()) {
          if (y === dims().height - 1) {
            if (spanHit([sidebarHint().buttonSpan], x) === 0) {
              executeRendererCommand(
                rendererCommandInvocation(
                  RENDERER_COMMAND_IDS.openPalette,
                  {},
                  { kind: "mouse", surface: "sidebar" },
                ),
              );
            }
            return;
          }
          const hit = sidebarHit(gy, fleet().length, fleetAgents().length);
          if (hit?.kind === "session") {
            const s = fleet()[hit.index];
            if (s) openWorkspace(s.name, dirForSession(s.name));
          } else if (hit?.kind === "agent") {
            const a = fleetAgents()[hit.index];
            if (a) jumpToAgent(a);
          } else if (hit?.kind === "agents-header") {
            if (spanHit(agentsChipSpans(), x) === 0) void newAgentFlow(currentNewAgentContext());
            else void manageTeamFlow();
          } else if (hit?.kind === "agents-empty") {
            if (spanHit(agentsChipSpans(), x) === 0) void newAgentFlow(currentNewAgentContext());
          }
          return;
        }
        if (mode() === "missions") {
          const hit = missionHitAt(x, y);
          handleMissionSurfacePointerDown(
            hit,
            {
              model: missionWorkspaceModel(),
              snapshot: missionWorkspaceSnapshot(),
              layoutSize: missionLayoutSize(),
              persistedTaskId: missionSelectionFromWorkspaceState(
                workspaceUiState(),
                missionViewId(),
              ).selectedTaskId,
            },
            {
              updateModel: updateMissionModel,
              refresh: () => loadMissionsWorkspace("refresh"),
              followDeepLink: followMissionDeepLink,
              persistSelection: persistMissionSelection,
            },
          );
        }
        return;
      }
      // A right-button press (SGR button 2) opens the context menu at the pointer.
      // Left/middle presses fall through to the normal click routing below.
      if (type === "down" && e.button === 2) {
        openMenu(x, y, screenX);
        return;
      }
      // A left-button "down" may START a resize drag (M19.3) — checked BEFORE the
      // region routing below so it wins over sidebar-open / pane-selection. The
      // sidebar/main boundary (last sidebar col or first main col) starts a sidebar
      // drag; a pane SEPARATOR (a gutter cell between two panes, mirror only)
      // starts a border drag. Neither fights selection: selection begins only from
      // an in-pane down, never a boundary/gutter cell.
      if (type === "down" && e.button !== 2) {
        // The boundary only exists BELOW the tab bar (row 0 is the full-width
        // surface bar — a press there must reach the tab spans, found live:
        // the Files tab's left cells sat exactly on the boundary columns).
        if (y >= TABBAR_H && (x === sidebarW() - 1 || x === sidebarW())) {
          setHoverIf(null);
          dragging = { kind: "sidebar" };
          setStatusNote("resizing…");
          return;
        }
        if (mode() === "mirror" && x > sidebarW()) {
          const dgy = y - TABBAR_H;
          if (dgy >= HEADER_ROWS) {
            const cx = x - sidebarW();
            const cy = dgy - HEADER_ROWS;
            const sep = separatorAt(panes(), cx, cy);
            if (sep) {
              setHoverIf(null);
              dragging = { kind: "border", sep, originCx: cx, originCy: cy, lastSize: sep.aSize };
              setStatusNote("resizing…");
              return;
            }
          }
        }
        // A press on a VISIBLE scrollbar cell is the fourth drag-origin. On the
        // thumb it captures the grab offset and begins an absolute-scroll drag; on
        // the track above/below it pages one viewport toward the click. Checked
        // after the resize origins (a track column never coincides with a boundary
        // or separator) and before selection/click routing so it always wins.
        const sb = scrollbarHitAt(x, y);
        if (sb) {
          setHoverIf(null);
          const row = y - sb.top0;
          const thumb = scrollThumb(sb.viewportTop, sb.contentLen, sb.viewH);
          if (trackZone(row, thumb) === "thumb") {
            dragging = {
              kind: "scrollbar",
              grabOffset: row - thumb.start,
              top0: sb.top0,
              contentLen: sb.contentLen,
              viewH: sb.viewH,
              surface: sb.surface,
            };
          } else {
            applyScrollTop(sb.surface, pageTop(row, sb.viewportTop, sb.contentLen, sb.viewH));
          }
          return;
        }
      }
      // A drag while a resize gesture is live reflows the sidebar / resizes panes,
      // suppressing hover; a release ends it (and persists the sidebar width via
      // the debounced save effect that reads `sidebarW()`). The SAME apply runs on
      // the terminal "up" as on each "drag" tick: OpenTUI coalesces rapid motion
      // events, so honoring the release coordinate guarantees the final position
      // sticks even when intermediate drags were dropped.
      if (dragging) {
        const isDrag = type === "drag";
        const isEnd = type === "up" || type === "drag-end" || type === "drop" || type === "out";
        if (isDrag || isEnd) {
          if (dragging.kind === "sidebar") {
            setPreferredSidebarW(clampSidebarWidth(x));
          } else if (dragging.kind === "scrollbar") {
            // Absolute scroll: the pointer's row within the track maps to a top,
            // honoring the grab offset so the thumb tracks the cursor 1:1.
            const row = y - dragging.top0;
            const top = dragTop(row, dragging.grabOffset, dragging.contentLen, dragging.viewH);
            applyScrollTop(dragging.surface, top);
          } else {
            const cx = x - sidebarW();
            const cy = y - TABBAR_H - HEADER_ROWS;
            const delta =
              dragging.sep.axis === "x" ? cx - dragging.originCx : cy - dragging.originCy;
            const size = resizedSize(dragging.sep, delta);
            if (size !== dragging.lastSize) {
              dragging.lastSize = size;
              void mirror?.command(resizeCommand(dragging.sep, size)).catch(() => {});
            }
          }
          if (isEnd) {
            dragging = null;
            setNote("");
          }
          return;
        }
        // Any other event type mid-drag (move/over/out) is swallowed — hover stays
        // suppressed until the gesture ends.
        return;
      }
      // A DEFERRED press (M24.2) resolves on the next event: a drag that leaves
      // the press cell starts the selection the press was withheld for (nothing
      // is ever forwarded, no stray down); a release still in that cell forwards
      // the owed SGR press/release pair — the click the pane's app was due.
      // Everything else mid-press is swallowed, like the resize gestures above;
      // a second down without a release (never seen live) just drops the debt.
      if (pendingPress) {
        const pp = pendingPress;
        const pane = panesById().get(pp.paneId);
        if (type === "drag") {
          if (!pane) {
            pendingPress = null; // the pane died mid-press — nothing is owed
            return;
          }
          const cell = paneCell(pane, x, y - TABBAR_H);
          if (cell.row !== pp.cell.row || cell.col !== pp.cell.col) {
            pendingPress = null;
            // Anchor at the press's frozen ABSOLUTE cell (M25.6); the extend
            // derives the head from the pointer's current absolute cell.
            selAnchor = pp.absCell;
            selTrimBase = pp.trimBase;
            selecting = { surface: "mirror", paneId: pane.id };
            extendSelection(x, y);
          }
          return;
        }
        if (type === "up" || type === "drag-end" || type === "drop") {
          pendingPress = null;
          if (pane) {
            forwardPress(pane, pp.x, pp.gy, false);
            forwardPress(pane, pp.x, pp.gy, true);
          }
          return;
        }
        if (type === "down")
          pendingPress = null; // drop the debt, route the press
        else return;
      }
      // Motion (bubbled from child text runs) drives hover only; "out" clears it.
      // Handled first so every click branch below stays a pure down/up/scroll path.
      if (type === "out") {
        setHoverIf(null);
        return;
      }
      // A drag while a selection gesture is live extends the selection head rather
      // than driving hover.
      if (type === "drag" && selecting) {
        extendSelection(x, y);
        return;
      }
      // The wheel during a live MIRROR selection (M25.6): the drag owns it. It
      // adjusts the selecting pane's LOCAL offset — never forwarded to the
      // pane's app (even on app-mouse panes), never cancels the drag — and the
      // head re-derives at the pointer's new absolute cell, so the highlight
      // extends across the scroll. The scroll badge updates via the same tick.
      if (type === "scroll" && selecting && selecting.surface === "mirror") {
        const dir = e.scroll?.direction;
        if (dir === "up" || dir === "down") {
          const paneId = selecting.paneId;
          const depth = mirror?.scrollbackDepth(paneId) ?? 0;
          const cur = Math.min(scrollOffsets.get(paneId) ?? 0, depth);
          const next =
            dir === "up" ? Math.min(cur + SCROLL_STEP, depth) : Math.max(cur - SCROLL_STEP, 0);
          if (next !== cur) {
            scrollOffsets.set(paneId, next);
            markDirty();
          }
          extendSelection(x, y);
        }
        return;
      }
      if (type === "move" || type === "over" || type === "drag") {
        resolveHover(e.x, y);
        return;
      }
      // Release ends a live selection: the mirror copies what was dragged; the
      // editor keeps its selection for ^c. Discrete word/line selections leave
      // `selecting` null, so their trailing release passes straight through.
      if (type === "up" || type === "drag-end" || type === "drop") {
        if (selecting) {
          const s = selection();
          if (s && s.surface === "mirror" && selecting.surface === "mirror")
            commitMirrorCopy(s.paneId, s.anchor, s.head);
          selecting = null;
          dragAutoScroll = null;
          return;
        }
        // A FORWARDED press's release: pay the debt to the pane that got the
        // down — at the pointer's release cell, clamped into that pane — and
        // only once (the synthesized duplicates find no debt and stay local).
        if (forwardedDown) {
          const pane = panesById().get(forwardedDown);
          forwardedDown = null;
          if (pane && selectModePane() !== pane.id)
            forwardPress(pane, terminalRouteX(screenX), y - TABBAR_H, true);
          return;
        }
      }
      // Row 0 — the surface tab bar (full width, above the sidebar). Its right
      // side carries the context/palette chips (checked first; they never
      // overlap the left-anchored tab spans at sane widths).
      if (y === 0) {
        if (type !== "down") return;
        const tb = tabbarButtons();
        const bi = spanHit(tb.spans, x);
        if (bi >= 0) {
          runTabbarButton(tb.defs[bi]!.id);
          return;
        }
        const i = spanHit(surfaceSpans(), x);
        const view = canvasHostedViews()[i];
        if (view?.panel === "home" || view?.panel === "terminals") {
          executeRendererCommand(
            rendererInvocationForCanvas(view.panel, { kind: "mouse", surface: "workbench" }),
          );
        }
        return;
      }
      const gy = y - TABBAR_H;
      if (x < sidebarW()) {
        if (type !== "down") return;
        // The footer hint's "F5 palette" segment is a chip (last screen row).
        if (y === dims().height - 1) {
          if (spanHit([sidebarHint().buttonSpan], x) === 0) {
            executeRendererCommand(
              rendererCommandInvocation(
                RENDERER_COMMAND_IDS.openPalette,
                {},
                { kind: "mouse", surface: "sidebar" },
              ),
            );
          }
          return;
        }
        // Session rows switch the workspace; agent rows JUMP to their exact pane
        // (M22.2). The agents-header row opens the TEAM dialog — its [+ agent]
        // chip (also on the empty-state row) spawns via the one-dialog kind
        // picker (M24.1).
        const hit = sidebarHit(gy, fleet().length, fleetAgents().length);
        if (hit?.kind === "session") {
          const s = fleet()[hit.index];
          if (s) openWorkspace(s.name, dirForSession(s.name));
        } else if (hit?.kind === "agent") {
          const a = fleetAgents()[hit.index];
          if (a) jumpToAgent(a);
        } else if (hit?.kind === "agents-header") {
          if (spanHit(agentsChipSpans(), x) === 0) void newAgentFlow(currentNewAgentContext());
          else void manageTeamFlow();
        } else if (hit?.kind === "agents-empty") {
          if (spanHit(agentsChipSpans(), x) === 0) void newAgentFlow(currentNewAgentContext());
        }
        return;
      }
      // HOME mode: the main area is the fleet panel. Rows render below the header
      // (gy=0) + rule (gy=1), so a click at row gy hits home item `gy - 2`.
      if (mode() === "home") {
        if (type !== "down") return;
        const action = homeActionAtProjection(homeSurfaceProjection(), x, gy, sidebarW(), 0);
        if (action?.source === "footer" || action?.source === "welcome") {
          runHomeAction(action.id, action.itemIndex);
          return;
        }
        // A row click: the right-aligned verb chips win over the row body
        // ([+ agent] spawns — M23.1; the primary chip diffs/launches/reopens);
        // header rows are inert. Sessions open, projects launch, recents reopen.
        const idx = homeItemIndexAt(gy);
        const it = homeItems()[idx];
        if (!it || it.kind === "header") return;
        if (action?.source === "row") {
          setSel(idx);
          runHomeAction(action.id, idx);
          return;
        }
        activateHomeItem(idx);
        return;
      }
      // FILES (editor) mode: header (gy=0) + rule/banner (gy=1), then a two-column
      // body from gy=2 — the file LIST on the left [0,listW), the editor on the
      // right. Wheel scrolls whichever column the pointer is over; a left-column
      // click selects+activates a file row, a right-column click positions the
      // cursor (and takes editor focus).
      if (mode() === "editor") {
        const overList = x < sidebarW() + filesListW();
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir !== "up" && dir !== "down") return;
          const step = dir === "up" ? -SCROLL_STEP : SCROLL_STEP;
          if (overList) setFileTop((t) => clampTop(t + step, visibleFiles().length, editorRows()));
          else setEditorTop((t) => clampTop(t + step, editorLines().length, editorRows()));
          return;
        }
        if (type !== "down") return;
        // The header row (gy=0) carries the projected Files actions.
        if (gy === 0) {
          const hit = filesHitTest(filesSurfaceProjection(), x - sidebarW(), gy);
          if (hit?.area === "header" && hit.actionId) runFilesAction(hit.actionId);
          return;
        }
        const contentY = gy - HEADER_ROWS;
        if (contentY < 0 || contentY >= editorRows()) return;
        if (overList) {
          const top = clampTop(fileTop(), visibleFiles().length, editorRows());
          const idx = top + contentY;
          if (idx >= 0 && idx < visibleFiles().length) {
            clearSelection();
            setFilesFocus("list");
            activateFile(idx);
          }
          return;
        }
        if (!editBuffer) return;
        const { line, col } = editorCellAt(x, gy);
        setFilesFocus("editor");
        const now = Date.now();
        const count = clickCount(lastClick, { row: line, col }, now, CLICK_MS);
        lastClick = { row: line, col, ts: now, count };
        if (count >= 2) {
          // Double = word, triple = line — a discrete selection (kept for ^c).
          const text = editorLines()[line] ?? "";
          const r = count === 2 ? wordRangeAt(text, col) : lineRangeAt(text);
          setSelection({
            surface: "editor",
            anchor: { row: line, col: r.from },
            head: { row: line, col: r.to },
          });
          editBuffer.setCursor(line, r.to);
          selecting = null;
        } else {
          editBuffer.setCursor(line, col);
          selAnchor = { row: line, col };
          selecting = { surface: "editor" };
          setSelection(null);
        }
        setEditorRev((r) => r + 1);
        return;
      }
      // DIFF mode: header (gy=0) + rule (gy=1), body from gy=2, footer verbs on
      // the last screen row. Left column [0,listW) is the grouped file list, the
      // rest is the diff. Wheel scrolls whichever column the pointer is over; a
      // left-column click selects that file ROW (headers are inert), and the
      // row's right-anchored [s stage]/[u unstage] chip wins over selection.
      if (mode() === "diff") {
        const hit = changesHitTest(changesSurfaceProjection(), x - sidebarW(), gy);
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir !== "up" && dir !== "down") return;
          const step = dir === "up" ? -SCROLL_STEP : SCROLL_STEP;
          if (hit?.area === "list") {
            setDiffFileTop((t) => clampTop(t + step, diffRows().length, diffBodyRows()));
          } else {
            setDiffTop((t) => clampTop(t + step, diffLines().length, diffBodyRows()));
          }
          return;
        }
        if (type !== "down") return;
        if ((hit?.area === "header" || hit?.area === "footer") && hit.actionId) {
          runChangesAction(hit.actionId);
          return;
        }
        if (hit?.area !== "list" || hit.fileIndex === undefined) return;
        if (hit.actionId) {
          runChangesAction(hit.actionId, hit.fileIndex);
          return;
        }
        selectDiffFile(hit.fileIndex);
        return;
      }
      // The per-window strip (gy=0) — resolved by the SAME x-span math the render
      // lays out, so the formerly-swallowed segment clicks now land.
      if (gy === 0) {
        if (type !== "down") return;
        const i = spanHit(windowSpans(), x);
        const w = windowTabs()[i];
        if (w) mirror?.switchWindow(w.index);
        return;
      }
      const cx = x - sidebarW();
      const cy = gy - HEADER_ROWS;
      const pane = panes().find(
        (p) => cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height,
      );
      if (!pane) return;
      if (type === "down") {
        mirror?.focus(pane.id);
        // Where the press goes (M22.9 + M24.2): plain panes and select mode run
        // the selection machine below; app-mouse panes follow the pane's drag
        // default (agents select, others forward; shift inverts) — a select
        // default DEFERS the press so a genuine click still reaches the app
        // (see the pendingPress resolution above).
        const routing = routePanePress(
          pane.appMouse,
          selectModePane() === pane.id,
          e.modifiers?.shift === true,
          paneDrag(pane.id),
        );
        if (routing === "forward") {
          forwardedDown = pane.id;
          forwardPress(pane, x, gy, false);
          return;
        }
        if (routing === "defer") {
          pendingPress = {
            paneId: pane.id,
            x,
            gy,
            cell: paneCell(pane, x, gy),
            absCell: paneAbsCell(pane, x, gy),
            trimBase: mirror?.lineTrim(pane.id) ?? 0,
          };
          return;
        }
        // Begin a drag selection, or on a repeat click select
        // the word (double) / line (triple) and copy it immediately. Click
        // cadence tracks in VIEWPORT cells (the same physical spot); the
        // selection itself anchors in ABSOLUTE buffer cells (M25.6).
        const cell = paneCell(pane, x, gy);
        const now = Date.now();
        const count = clickCount(lastClick, cell, now, CLICK_MS);
        lastClick = { row: cell.row, col: cell.col, ts: now, count };
        if (count >= 2) {
          const rowText = paneRowTexts(pane.id)[cell.row] ?? "";
          const r = count === 2 ? wordRangeAt(rowText, cell.col) : lineRangeAt(rowText);
          const absRow = paneBaseY(pane.id) + cell.row;
          const anchor = { row: absRow, col: r.from };
          const head = { row: absRow, col: r.to };
          setSelection({ surface: "mirror", paneId: pane.id, anchor, head });
          selecting = null;
          commitMirrorCopy(pane.id, anchor, head);
        } else {
          selAnchor = paneAbsCell(pane, x, gy);
          selTrimBase = mirror?.lineTrim(pane.id) ?? 0;
          selecting = { surface: "mirror", paneId: pane.id };
          setSelection(null);
        }
      } else if (type === "scroll") {
        // (Releases never reach here: local gestures are consumed by the
        // selecting/pendingPress branches above and a forwarded press's
        // release is paid via the `forwardedDown` debt — never re-derived
        // from whichever pane happens to sit under the pointer.)
        const dir = e.scroll?.direction;
        if (dir === "up" || dir === "down") {
          const { col, row } = paneCell(pane, x, gy);
          wheel(pane, dir, col, row);
        }
      }
    };

    // A 1-col scrollbar drawn in an always-present container's right column: a
    // faint track with a brighter thumb, both single-cell bg fills. Each cell is a
    // TEXT run (not a box) so a click lands on text and bubbles to the router —
    // the late-mount landmine only swallows hits on late-mounted BOX area. The
    // geom accessor is read inside Show/For so the strip re-tracks scroll/resize.
    const scrollbarOverlay = (geomFn: () => ScrollGeom) => (
      <Show when={geomFn().visible}>
        <box position="absolute" right={0} top={0} width={1} flexDirection="column">
          <For each={scrollbarCells(geomFn())}>
            {(isThumb) => (
              <text bg={isThumb ? SCROLL_THUMB_BG : SCROLL_TRACK_BG} fg={SCROLL_TRACK_BG}>
                {" "}
              </text>
            )}
          </For>
        </box>
      </Show>
    );
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        backgroundColor={DEFAULT_BG}
        onMouse={(e: RouteEvent) => route(e)}
      >
        {/* Surface tab bar — the top screen row (gy=0), full width above the
          sidebar. The click x-spans are computed from the exact same hosted-view
          labels rendered here. F1..F4 then F6..F13 switch configured views; the active view carries the accent background, a hovered one a
          subtle tint. */}
        <box
          height={TABBAR_H}
          flexDirection="row"
          backgroundColor={TABBAR_BG}
          onMouse={(e: RouteEvent) => route(e)}
        >
          <ShellTabBar
            theme={semanticTheme()}
            width={dims().width}
            variant={shellLayout().variant}
            views={canvasHostedViews()}
            activeViewId={canvasViewForPanel(canvasHostedViews(), canvasPanel()).id}
            hoveredIndex={hover()?.region === "surfacetab" ? hover()!.index : null}
            note={note()}
            rightChips={tabbarButtons().defs.map((button, index) => ({
              id: button.id,
              label: button.label,
              hovered: isHovered("tabbtn", index),
              context: button.id === "tab-context",
            }))}
          />
        </box>
        <box flexDirection="row" flexGrow={1} backgroundColor={DEFAULT_BG} overflow="hidden">
          <Sidebar
            width={sidebarW()}
            sessions={fleet()}
            agents={fleetAgents()}
            current={curTarget()}
            nowSec={Math.floor(Date.now() / 1000)}
            isHovered={isHovered}
            flashed={(paneId: string) => attnFlash().has(paneId)}
            variant={shellLayout().variant}
            hint={sidebarHint()}
            onMouse={(e) => route(e as RouteEvent)}
          />
          <box
            position="relative"
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            onMouse={(e: RouteEvent) => route(e)}
          >
            <WorkbenchShell
              theme={semanticTheme()}
              projection={workbenchProjection()}
              canvas={
                <Show
                  when={canvasPanel() === "home"}
                  fallback={
                    <AgentTerminalCanvas
                      theme={semanticTheme()}
                      projection={terminalCanvasProjection()}
                      chrome={
                        <>
                          {/* The per-window strip (gy=0). Rendered as bare styled TEXT runs (no
                per-window <box> wrapper) so the late-mounted segments bubble
                clicks to the main-column router instead of swallowing them the
                way late-mounted boxes do; `route` hit-tests `windowSpans`, whose
                labels equal these run strings. Active = accent+tint, hover =
                subtle tint. */}
                          <box paddingLeft={1} flexDirection="row" gap={1}>
                            <text fg={MUTED}>{windowStripParts().pre}</text>
                            <text fg={ACCENT} bg={TAB_ACTIVE_BG}>
                              {windowStripParts().active}
                            </text>
                            <text fg={MUTED}>{windowStripParts().post}</text>
                            {/* Window-level indicators remain on row zero; pane-level
                  zoom/split controls now live in each pane's own chrome row. */}
                            <Show when={isZoomed()}>
                              <text fg={ACCENT} bg={TAB_ACTIVE_BG} attributes={1}>
                                {` ${focusedLivePane()?.id ?? ""} [Z] `}
                              </text>
                            </Show>
                            {/* Synchronize-panes indicator (M20.2): shown while the active
                  window's synchronize-panes option is on, left-aligned after the
                  labels like [Z]. */}
                            <Show when={syncOn()}>
                              <text fg={BUTTON_FG} bg={BUTTON_ACTIVE_BG} attributes={1}>
                                {" [SYNC] "}
                              </text>
                            </Show>
                          </box>
                          {/* Segmented pane chrome occupies gy=1, immediately above
                  the exact tmux framebuffer. The layer is passive; root routing
                  owns every action and lifecycle effect. */}
                          <TerminalPaneChromeLayer
                            theme={semanticTheme()}
                            layout={terminalPaneChromeLayout()}
                            layer="native"
                          />
                        </>
                      }
                      framebuffer={
                        <box
                          position="relative"
                          width={terminalCanvasProjection().framebuffer.width}
                          height={terminalCanvasProjection().framebuffer.height}
                          backgroundColor={GUTTER_BG}
                          overflow="hidden"
                        >
                          {/* M21.3 — framebuffer blit (flagged). ONE <pane_surface> per
                  pane blits the grid straight into packed buffers; the For keys
                  on the stable id list so a content tick reuses each surface (and
                  its framebuffer) instead of tearing it down. Chrome (badge +
                  scrollbar) stays Solid JSX layered over the surface. The old
                  StyledRun path is the fallback, unchanged, default for A/B. */}
                          <Show
                            when={FB_PANES}
                            fallback={
                              <For each={panes()}>
                                {(pane) => (
                                  <box
                                    position="absolute"
                                    left={pane.left}
                                    top={pane.top}
                                    width={pane.width}
                                    height={pane.height}
                                    flexDirection="column"
                                    backgroundColor={DEFAULT_BG}
                                    overflow="hidden"
                                  >
                                    <For each={paneSelRows(pane)}>
                                      {(runs) => (
                                        <box flexDirection="row" height={1}>
                                          <For each={runs}>
                                            {(run) => (
                                              <text
                                                fg={packedToRgba(run.fg, DEFAULT_FG)}
                                                bg={packedToRgba(run.bg, DEFAULT_BG)}
                                                attributes={run.attributes}
                                              >
                                                {run.text}
                                              </text>
                                            )}
                                          </For>
                                        </box>
                                      )}
                                    </For>
                                    {/* Top-right badge family: the select-mode chip (M22.9,
                            passive text runs — presses bubble to the router) then
                            the scroll badge. */}
                                    <box position="absolute" right={1} top={0} flexDirection="row">
                                      <Show
                                        when={
                                          selectModePane() === pane.id &&
                                          selectBadgeLabel(pane.width)
                                        }
                                      >
                                        <text fg={DEFAULT_FG} bg={BUTTON_ACTIVE_BG} attributes={1}>
                                          {selectBadgeLabel(pane.width)!}
                                        </text>
                                      </Show>
                                      <Show when={pane.snapshot.scrollOffset > 0}>
                                        <text fg={DEFAULT_FG} bg={BADGE_BG}>
                                          {` ↑${pane.snapshot.scrollOffset}/${pane.scrollbackDepth} `}
                                        </text>
                                      </Show>
                                    </box>
                                    {/* Right-edge scrollbar — only while scrolled up, so a live
                            terminal stays clean (mirrorScrollGeom gates on offset). */}
                                    {scrollbarOverlay(() => mirrorScrollGeom(pane))}
                                  </box>
                                )}
                              </For>
                            }
                          >
                            <For each={paneIds()}>
                              {(id) => {
                                const pane = () => panesById().get(id);
                                return (
                                  <Show when={pane()}>
                                    <box
                                      position="absolute"
                                      left={pane()!.left}
                                      top={pane()!.top}
                                      width={pane()!.width}
                                      height={pane()!.height}
                                      backgroundColor={DEFAULT_BG}
                                      overflow="hidden"
                                    >
                                      <pane_surface
                                        width={pane()!.width}
                                        height={pane()!.height}
                                        mirror={mirror!}
                                        paneId={id}
                                        defaultFg={DEFAULT_FG_PACKED}
                                        defaultBg={DEFAULT_BG_PACKED}
                                        searchHl={SEARCH_HL}
                                        searchCur={SEARCH_CUR}
                                        scrollOffset={pane()!.snapshot.scrollOffset}
                                        paneFocused={pane()!.active}
                                        contentVersion={pane()!.version}
                                        selRange={mirrorSelForPane(id)}
                                        search={mirrorSearchForPane(pane()!)}
                                      />
                                      {/* Top-right badge family: the select-mode chip
                              (M22.9, passive text runs — presses bubble to the
                              router) then the scroll badge. */}
                                      <box
                                        position="absolute"
                                        right={1}
                                        top={0}
                                        flexDirection="row"
                                      >
                                        <Show
                                          when={
                                            selectModePane() === id &&
                                            selectBadgeLabel(pane()!.width)
                                          }
                                        >
                                          <text
                                            fg={DEFAULT_FG}
                                            bg={BUTTON_ACTIVE_BG}
                                            attributes={1}
                                          >
                                            {selectBadgeLabel(pane()!.width)!}
                                          </text>
                                        </Show>
                                        <Show when={pane()!.snapshot.scrollOffset > 0}>
                                          <text fg={DEFAULT_FG} bg={BADGE_BG}>
                                            {` ↑${pane()!.snapshot.scrollOffset}/${pane()!.scrollbackDepth} `}
                                          </text>
                                        </Show>
                                      </box>
                                      {scrollbarOverlay(() => mirrorScrollGeom(pane()!))}
                                    </box>
                                  </Show>
                                );
                              }}
                            </For>
                          </Show>
                          {/* Lower-pane headers reuse only tmux's existing horizontal
                  separator cells. Focus belongs to this semantic pane chrome,
                  while the pure projection proves no emitted rectangle
                  intersects a pane framebuffer. */}
                          <TerminalPaneChromeLayer
                            theme={semanticTheme()}
                            layout={terminalPaneChromeLayout()}
                            layer="framebuffer"
                          />
                          {/* Size-truth hint (M22.8): quiet, dismiss-free, shown ONLY while
                  a co-attached terminal has sized the window away from our canvas
                  (the letterboxed grid is centered beneath it). It states the
                  honest actual size — the iTerm2-style answer — and disappears the
                  moment the sizes agree. A handler-less box in the top gutter, so
                  no pointer routing changes. */}
                          <Show when={windowMismatch()}>
                            <box position="absolute" left={1} top={0} backgroundColor={BADGE_BG}>
                              <text fg={MUTED}>{` ${formatSizeHint(windowMismatch()!)} `}</text>
                            </box>
                          </Show>
                        </box>
                      }
                      footer={
                        search() ? (
                          <box
                            width={terminalCanvasProjection().footer.width}
                            height={terminalCanvasProjection().footer.height}
                            flexDirection="row"
                            backgroundColor={PALETTE_BG}
                            paddingLeft={1}
                            paddingRight={1}
                          >
                            <text fg={ACCENT} attributes={1}>
                              {search()!.editing ? "/" : "search "}
                            </text>
                            <text
                              fg={DEFAULT_FG}
                            >{`${search()!.query}${search()!.editing ? "▏" : ""}`}</text>
                            <box flexGrow={1} />
                            <text fg={MUTED}>{searchStatus()}</text>
                          </box>
                        ) : undefined
                      }
                    />
                  }
                >
                  <HomeSurface
                    theme={semanticTheme()}
                    projection={homeSurfaceProjection()}
                    rollup={rollup()}
                  />
                </Show>
              }
              dockBody={
                <>
                  <Show when={activeDockTab() === "files"}>
                    <FilesSurface
                      theme={semanticTheme()}
                      projection={filesSurfaceProjection()}
                      colors={{
                        gutterBg: GUTTER_BG,
                        gutterFg: GUTTER_FG,
                        cursorBg: CURSOR_BG,
                        modifiedFg: MODIFIED_FG,
                        statusLetterFg: STATUS_LETTER_FG,
                      }}
                    />
                  </Show>
                  <Show when={activeDockTab() === "changes"}>
                    <ChangesSurface
                      theme={semanticTheme()}
                      projection={changesSurfaceProjection()}
                      colors={{
                        gutterBg: GUTTER_BG,
                        gutterFg: GUTTER_FG,
                        statusLetterFg: STATUS_LETTER_FG,
                        diffFg: DIFF_FG,
                        diffLineBg: DIFF_LINE_BG,
                      }}
                    />
                  </Show>
                  <Show when={activeDockTab() === "missions"}>
                    <MissionsSurface
                      width={dockSurfaceWidth()}
                      dashboard={missionsDashboard()}
                      model={missionWorkspaceModel()}
                      snapshot={missionWorkspaceSnapshot()}
                      loadState={missionWorkspaceLoad()}
                      errorMessage={missionLoadErrorMessage()}
                      resolveDeepLink={missionDeepLink}
                      isHovered={isHovered}
                      theme={{
                        bannerFg: BANNER_FG,
                        buttonFg: BUTTON_FG,
                        buttonBg: BUTTON_BG,
                        buttonActiveBg: BUTTON_ACTIVE_BG,
                      }}
                    />
                  </Show>
                  <Show when={activeDockTab() === "activity"}>
                    <ActivitySurface theme={semanticTheme()} projection={activityProjection()} />
                  </Show>
                </>
              }
            />
          </box>
        </box>
        {/* Native COMMAND PALETTE overlay. Presentation stays handler-free;
          the root uses the same projection for render and pointer hit-testing.
          The original tmux paste-buffer picker remains the second level. */}
        <Show when={paletteOpen()}>
          <Show
            when={paletteBuffers() !== null}
            fallback={
              <CommandPaletteSurface theme={semanticTheme()} projection={paletteProjection()} />
            }
          >
            <box
              position="absolute"
              left={palettePos(dims().width, dims().height, paletteW()).left}
              top={palettePos(dims().width, dims().height, paletteW()).top}
              width={paletteW()}
              flexDirection="column"
              backgroundColor={PALETTE_BG}
              border
              borderColor={PALETTE_BORDER}
              paddingLeft={1}
              paddingRight={1}
            >
              <box flexDirection="row">
                <text fg={ACCENT} attributes={1}>
                  {"⎘ Paste buffer"}
                </text>
                <box flexGrow={1} />
                <text fg={MUTED}>{"esc back"}</text>
              </box>
              <text fg={MUTED}>{"─".repeat(paletteW() - 4)}</text>
              <For each={paletteBuffers()!.slice(paletteTop(), paletteTop() + PALETTE_ROWS)}>
                {(b, i) => (
                  <box
                    height={1}
                    flexDirection="row"
                    backgroundColor={
                      paletteTop() + i() === paletteSel() ? TAB_ACTIVE_BG : PALETTE_BG
                    }
                  >
                    <text fg={paletteTop() + i() === paletteSel() ? DEFAULT_FG : MUTED}>
                      {`${paletteTop() + i() === paletteSel() ? "› " : "  "}${b.name}  `}
                    </text>
                    <text fg={MUTED}>{b.preview}</text>
                  </box>
                )}
              </For>
              <Show when={paletteBuffers()!.length === 0}>
                <text fg={MUTED}>{"  no buffers"}</text>
              </Show>
            </box>
          </Show>
        </Show>
        {/* RIGHT-CLICK CONTEXT MENU overlay (M19.2) — opened at the pointer,
          clamped on-screen. Late-mounted inside <Show>, so it carries NO mouse
          handler: clicks route via the root box's `route`, which checks `menu()`
          first and hit-tests item rows by `menuItemAt` (matching this layout —
          top border, one header row, then the item rows). Each item row is a
          FULL-WIDTH text run so a click anywhere on it lands on text and bubbles
          (bare box area on a late-mounted node is swallowed). j/k+enter navigate;
          danger items rearm to a red "confirm: y"; input items show an inline
          line. */}
        <Show when={menu()}>
          <box
            position="absolute"
            left={menu()!.left}
            top={menu()!.top}
            width={menu()!.width}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ACCENT} attributes={1}>
              {menu()!
                .title.slice(0, menu()!.width - 4)
                .padEnd(menu()!.width - 4)}
            </text>
            <For each={menu()!.items}>
              {(it, i) => {
                const innerW = () => menu()!.width - 4;
                const selected = () => menuSel() === i();
                const armed = () => menuConfirm() === i();
                const inputting = () => menuInput() !== null && menuSel() === i();
                const body = () => {
                  const w = innerW();
                  if (inputting()) return `${it.input}: ${menuInput()}▏`;
                  if (armed()) return `${it.label}${CONFIRM_SUFFIX}`;
                  // A checkbox item (Synchronize panes) shows its live ✓/✗ in place
                  // of the "› " prefix; a children item (Layouts) shows a flush-right
                  // caret so it reads as "opens a column".
                  if (it.checkbox) return `${syncOn() ? "✓ " : "✗ "}${it.label}`;
                  const base = `${selected() ? "› " : "  "}${it.label}`;
                  if (it.children)
                    return (
                      base.slice(0, w - SUBMENU_CARET.length).padEnd(w - SUBMENU_CARET.length) +
                      SUBMENU_CARET
                    );
                  return base;
                };
                const fg = () =>
                  armed() ? DIFF_DEL_FG : selected() || inputting() ? DEFAULT_FG : MUTED;
                const bg = () =>
                  selected() || armed() || inputting() ? TAB_ACTIVE_BG : PALETTE_BG;
                return (
                  <box height={1} backgroundColor={bg()}>
                    <text fg={fg()}>{body().slice(0, innerW()).padEnd(innerW())}</text>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
        {/* SUBMENU column (M20.2) — the open parent item's `children`, opened to the
          right and top-aligned with that item. Same late-mount discipline: NO
          per-item handler; `route` hit-tests `submenuGeom` before the parent so a
          click on a child lands. j/k move the column selection, esc/left back up. */}
        <Show when={submenuGeom()}>
          <box
            position="absolute"
            left={submenuGeom()!.left}
            top={submenuGeom()!.top}
            width={submenuGeom()!.width}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ACCENT} attributes={1}>
              {(menu()!.items[menuSub()!]?.label ?? "")
                .slice(0, submenuGeom()!.width - 4)
                .padEnd(submenuGeom()!.width - 4)}
            </text>
            <For each={submenuItems() ?? []}>
              {(it, i) => {
                const innerW = () => submenuGeom()!.width - 4;
                const selected = () => menuSubSel() === i();
                return (
                  <box height={1} backgroundColor={selected() ? TAB_ACTIVE_BG : PALETTE_BG}>
                    <text fg={selected() ? DEFAULT_FG : MUTED}>
                      {`${selected() ? "› " : "  "}${it.label}`.slice(0, innerW()).padEnd(innerW())}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
        {/* DIALOG overlay (M22.4) — the ONE mount for the global dialog stack;
          only the TOP entry renders (a nested push visually replaces until it
          pops). Rendered LAST so it sits above the palette and the menus. Same
          late-mount discipline: NO per-node handlers — `route` checks
          `dialogStack.depth()` FIRST and hit-tests rows with the same pure
          geometry placing this box (dialogPos/dialogHeaderRows). Layout per
          kind must match dialog-model's headerRows math EXACTLY: border ·
          title · [filter input] · rule · [confirm body] · rows · footer ·
          border. The border/title accents read `dlgAccent()` — the theme
          picker's live preview surface. */}
        <Show when={dlgSelect()}>
          <box
            position="absolute"
            left={dialogPos(dims().width, dims().height, dialogW()).left}
            top={dialogPos(dims().width, dims().height, dialogW()).top}
            width={dialogW()}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={previewAccent() ?? PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={dlgAccent()} attributes={1}>
              {dlgSelectSpec().title.slice(0, dialogInnerWidth()).padEnd(dialogInnerWidth())}
            </text>
            <Show when={dlgSelectSpec().filterable !== false}>
              <box flexDirection="row">
                <text fg={dlgAccent()} attributes={1}>
                  {"▸ "}
                </text>
                <text fg={DEFAULT_FG}>{`${dlgSelect()!.state.query}▏`}</text>
              </box>
            </Show>
            <text fg={MUTED}>{"─".repeat(dialogInnerWidth())}</text>
            <For each={dlgVisibleItems()}>
              {(item, i) => {
                const abs = () => dlgSelect()!.state.top + i();
                const selected = () => abs() === dlgSelect()!.state.sel;
                const armed = () => dlgSelect()!.state.armed === abs();
                // The marker renders as its own run (current ● in accent); a
                // swatch row adds a colored ● run, so its body is 2 cells
                // narrower — dialogRowText pads to exactly the remaining width.
                const body = () =>
                  dialogRowText(item, {
                    selected: selected(),
                    armed: armed(),
                    innerW: item.swatch ? dialogInnerWidth() - 2 : dialogInnerWidth(),
                  }).slice(2);
                const markerFg = () =>
                  item.current ? dlgAccent() : selected() ? DEFAULT_FG : MUTED;
                const bodyFg = () => (armed() ? DIFF_DEL_FG : selected() ? DEFAULT_FG : MUTED);
                return (
                  <box
                    height={1}
                    flexDirection="row"
                    backgroundColor={selected() || armed() ? TAB_ACTIVE_BG : PALETTE_BG}
                  >
                    <text fg={markerFg()}>{dialogMarker(item, selected())}</text>
                    <Show when={item.swatch}>
                      <text
                        fg={RGBA.fromInts(item.swatch![0], item.swatch![1], item.swatch![2], 255)}
                      >
                        {"● "}
                      </text>
                    </Show>
                    <text fg={bodyFg()}>{body()}</text>
                  </box>
                );
              }}
            </For>
            <Show when={dlgVisibleItems().length === 0}>
              <text fg={MUTED}>{"  no matches"}</text>
            </Show>
            <text fg={MUTED}>{selectFooter(dlgSelectSpec()).slice(0, dialogInnerWidth())}</text>
          </box>
        </Show>
        <Show when={dlgPrompt()}>
          <box
            position="absolute"
            left={dialogPos(dims().width, dims().height, dialogW()).left}
            top={dialogPos(dims().width, dims().height, dialogW()).top}
            width={dialogW()}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ACCENT} attributes={1}>
              {dlgPromptSpec().title.slice(0, dialogInnerWidth()).padEnd(dialogInnerWidth())}
            </text>
            <text fg={MUTED}>{"─".repeat(dialogInnerWidth())}</text>
            <box flexDirection="row">
              <text fg={ACCENT} attributes={1}>
                {"▸ "}
              </text>
              <Show
                when={dlgPrompt()!.state.input.length === 0 && dlgPromptSpec().placeholder}
                fallback={<text fg={DEFAULT_FG}>{`${dlgPrompt()!.state.input}▏`}</text>}
              >
                <text fg={DEFAULT_FG}>{"▏"}</text>
                <text fg={MUTED}>{` ${dlgPromptSpec().placeholder}`}</text>
              </Show>
            </box>
            <text
              fg={promptFooter(dlgPromptSpec(), dlgPrompt()!.state).error ? DIFF_DEL_FG : MUTED}
            >
              {promptFooter(dlgPromptSpec(), dlgPrompt()!.state).text.slice(0, dialogInnerWidth())}
            </text>
          </box>
        </Show>
        <Show when={dlgConfirm()}>
          <box
            position="absolute"
            left={dialogPos(dims().width, dims().height, dialogW()).left}
            top={dialogPos(dims().width, dims().height, dialogW()).top}
            width={dialogW()}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ACCENT} attributes={1}>
              {dlgConfirmSpec().title.slice(0, dialogInnerWidth()).padEnd(dialogInnerWidth())}
            </text>
            <text fg={MUTED}>{"─".repeat(dialogInnerWidth())}</text>
            <For
              each={
                dlgConfirmSpec().body ? wrapText(dlgConfirmSpec().body!, dialogInnerWidth()) : []
              }
            >
              {(line) => <text fg={MUTED}>{line || " "}</text>}
            </For>
            <For each={confirmOptions(dlgConfirmSpec())}>
              {(label, i) => {
                const selected = () => dlgConfirm()!.state.sel === i();
                return (
                  <box height={1} backgroundColor={selected() ? TAB_ACTIVE_BG : PALETTE_BG}>
                    <text fg={selected() ? DEFAULT_FG : MUTED}>
                      {`${selected() ? "› " : "  "}${label}`.slice(0, dialogInnerWidth())}
                    </text>
                  </box>
                );
              }}
            </For>
            <text fg={MUTED}>{confirmFooter()}</text>
          </box>
        </Show>
      </box>
    );
  }, appRenderer);
} catch (error) {
  appRenderer.destroy();
  throw error;
}
