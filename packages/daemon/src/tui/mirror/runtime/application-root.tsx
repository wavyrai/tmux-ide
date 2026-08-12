/**
 * The unified app (M17.2) — tmux as the engine, tmux-ide as the screen.
 *
 * Sidebar (live fleet, click to switch session) · window tab strip · pane
 * canvas at exact tmux geometry with full color/attribute fidelity, local
 * scrollback (wheel; ↑n/depth badge; any key snaps live), real SGR mouse
 * forwarding into panes whose app enabled mouse mode, request-driven up to 60fps
 * (8ms coalesced state publication + 30fps renderer target / 60fps burst ceiling)
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
 * SELECTION SURVIVES SCROLLING (M25.6): semanticView selections anchor in ABSOLUTE
 * xterm buffer lines (absLine = scrollbackDepth − scrollOffset + viewportRow),
 * not viewport cells — so scrolling mid-drag keeps the highlight on its text
 * and a selection can span many screens. While a drag is live the wheel over
 * the pane always scrolls the LOCAL scrollback (never forwarded, never cancels
 * — even on app-mouse panes), and holding the pointer at the pane's top/bottom
 * content row auto-scrolls ~1 row per 8ms state tick (clamped at the
 * scrollback top / the live bottom). The release copy extracts the FULL
 * absolute span straight from the pane's buffer (SemanticSessionView.extractText,
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
 * (home|semanticView|editor|diff|missions). CRITICAL for the IDE feel: switching AWAY
 * from Terminal does NOT
 * dispose the SemanticSessionView — it keeps streaming in the background (dirty flags
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
 * SemanticSessionView canvas), the built-in FILES tab (M18.2 editor + a one-level file
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
 * as the semanticView. A `editorRev()` signal bumps after each mutation to re-derive
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
 * Fleet and native tool data arrive through one demand-driven daemon resource
 * session. The OpenTUI process owns no catalog poll or observation subprocess;
 * seeds remain capped at 300 history lines so initial terminal attach stays
 * responsive.
 *
 * Run (repo-root bunfig preload):
 *   bun packages/daemon/src/tui/semanticView/app.tsx              # home panel
 *   bun packages/daemon/src/tui/semanticView/app.tsx --target <session>
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, openSync, writeSync, closeSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { Dynamic, render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { RGBA, SyntaxStyle, createCliRenderer, decodePasteBytes } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import {
  createRuntimeConnectionSupervisor,
  type RuntimeConnection,
  type RuntimeConnectionSupervisor,
} from "@tmux-ide/daemon-client/connection-supervisor";
import type { ApplicationShellSessionState } from "@tmux-ide/daemon-client/application-shell-session";
// Relative on purpose: npm installations can run the shipped TUI source before
// a compiled TUI binary is available. Keeping the shared core source in the
// root tarball avoids requiring a separately-installed workspace package.
import {
  INTERACTION_PRESENCE_MS,
  initialInteractionFeedState,
  interactionPresenceIsFresh,
  interactionReceiptLabel,
  interactionReceiptTargetLabel,
  paneInteractionPresence,
  paneInteractionRelationshipLabel,
  projectApplicationShellSession,
  reduceInteractionReceipt,
  reconcileWorkspaceSelection,
  type InteractionFeedState,
} from "../../../../../core/src/index.ts";
import { SemanticSessionView, type LivePane } from "../semantic-session-view.ts";
import type { RichPlacementProjection } from "../rich-placement-projection.ts";
import { FrameCoalescer } from "../frame-coalescer.ts";
import {
  activeLivePaneId,
  livePaneRuntime,
  projectPaneChromeState,
  sameLivePaneRuntime,
  sameLivePaneStructure,
  withLivePaneFocus,
} from "../pane-frame-state.ts";
import { registerPaneSurface, type PaneSearchHighlight } from "../pane-surface.tsx";
import { readWidgetAsset } from "../../../lib/widget-asset-store.ts";
import { resolveTuiWidgetSurface, type TuiWidgetSurface } from "../widget-surface-model.ts";
import { TuiRichWidgetSurface } from "../widget-surface.tsx";
import { tapInputSent, tapInputTick } from "../perf-tap.ts";
import { installHostAutowrapGuard, type HostAutowrapGuard } from "../host-terminal.ts";
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import type { AgentStatus } from "../../detect/classify.ts";
import { Sidebar } from "../sidebar.tsx";
import {
  type CommandSource,
  type FleetCatalogResourceV1,
  type SemanticFocusTarget,
  type WorkspaceChangesCatalogEnvelopeV1,
  type WorkspaceFilesCatalogEnvelopeV1,
  type WorkspaceMissionsEnvelopeV1,
} from "@tmux-ide/contracts";
import {
  ACCENT,
  DEFAULT_BG,
  DEFAULT_FG,
  MUTED,
  createSemanticThemeStore,
  createTerminalPaletteProjection,
} from "../theme.ts";
import { homeFooterHints, type FleetRollup } from "../../team/home.ts";
import { gutterWidth, formatGutter, clampTop, clickToCursor } from "./editor-primitives.ts";
import type {
  EditorOpenOrigin,
  FilesActionId,
  FilesSurfaceProjection,
  ReadOnlyReason,
  FilesFeatureSession,
} from "../features/files/feature.tsx";
import type { ChangesFeatureSession, ChangesHoverTarget } from "../features/changes/feature.tsx";
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
  startupContextSession,
  type AppState,
  type PaletteUsageEntry,
  type Tab,
} from "../app-state.ts";
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
} from "../folder-picker.ts";
import { registerProject, ProjectAlreadyRegisteredError } from "../../../lib/project-registry.ts";
import { resolveProjectConfigContext } from "../../../lib/config-context.ts";
import { createProjectRuntimeRepository } from "../../../lib/project-runtime-repository.ts";
import {
  separatorAtCanvas,
  resizedSize,
  resizeGuideRect,
  type Separator,
} from "../resize-model.ts";
import {
  ResizeTransactionController,
  type ResizeTransactionObservation,
  type ResizeTransactionState,
} from "../resize-transaction.ts";
import {
  effectiveWindowSize,
  detectSizeMismatchWithRepin,
  letterboxOffset,
  formatSizeHint,
  type RepinState,
  type Size,
} from "../size-truth.ts";
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
} from "../palette.ts";
import {
  executeTuiMultiplexerAction,
  type TuiMultiplexerAction,
} from "../multiplexer-action-executor.ts";
import {
  adaptPaletteRowsToCommands,
  appendPalettePaste,
  dispatchPaletteCommand,
  ensurePaletteSelectionVisible,
  firstEnabledPaletteCommandId,
  PaletteBufferLoadGate,
  restorePaletteActionLevelFromBuffers,
  stepEnabledPaletteCommandId,
} from "../palette-surface-adapter.ts";
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
} from "../panel-host.ts";
import { trackPanelHostDirectory } from "../panel-host-reactive.ts";
import {
  cycleWorkbenchFocusZone,
  projectWorkbenchShell,
  workbenchDockNavigationTarget,
  workbenchShellHitTest,
  type WorkbenchDockMode,
  type WorkbenchDockTabId,
  type WorkbenchFocusZone,
} from "../workspace/workbench-shell.ts";
import { WorkbenchShell } from "../workspace/workbench-shell.tsx";
import {
  applicationShellHitTest,
  projectApplicationShell,
} from "../workspace/application-shell.ts";
import { ApplicationShell } from "../workspace/application-shell.tsx";
import {
  applicationShellReplayState,
  openTuiApplicationShellAuthorityInput,
  openTuiRuntimePaneId,
  openTuiSemanticPaneIdForRuntime,
  projectOpenTuiApplicationShell,
  sameOpenTuiApplicationShellInput,
  type OpenTuiApplicationShellInput,
  type OpenTuiApplicationShellEffect,
} from "../workspace/application-shell-controller.ts";
import {
  connectOpenTuiApplicationShellAuthority,
  type OpenTuiApplicationShellAuthority,
} from "../application-shell-daemon-session.ts";
import {
  connectOpenTuiSessionRuntime,
  type OpenTuiSessionRuntimeLane,
} from "../application-shell-daemon-runtime.ts";
import {
  createApplicationRootController,
  routeApplicationSidebarResizePointer,
} from "../workspace/application-root-controller.ts";
import {
  agentTerminalCanvasPointerPolicy,
  agentTerminalCanvasRouteX,
  projectAgentTerminalCanvas,
} from "../workspace/agent-terminal-canvas.ts";
import { AgentTerminalCanvas } from "../workspace/agent-terminal-canvas-view.tsx";
import {
  commandPaletteHitTest,
  projectCommandPalette,
} from "../workspace/command-palette-surface.ts";
import { CommandPaletteSurface } from "../workspace/command-palette-surface.tsx";
import {
  dispatchTerminalPaneChromePointerIntent,
  projectTerminalPaneChrome,
  reconcileTerminalPaneChromeActionTarget,
  terminalPaneChromeMotionState,
  terminalPaneChromePointerIntent,
  type TerminalPaneChromeActionTarget,
  type TerminalPaneChromeHoverTarget,
  type TerminalPaneChromeMetadata,
} from "../workspace/terminal-pane-chrome.ts";
import {
  SharedTerminalPaneChromeLayer,
  TerminalPaneCommunicationLayer,
} from "../workspace/terminal-pane-chrome-view.tsx";
import {
  workbenchCanvasPanelForShortcut,
  workbenchCanvasShortcutForPanel,
  workbenchDockTabForShortcut,
} from "../workspace/workbench-controller.ts";
import { clipTerminal } from "../terminal-text.ts";
import { HomeSurface, homeActionAtProjection } from "../home-surface.tsx";
import {
  homeItemIndexAtProjection,
  projectHomeSurface,
  type HomeActionId,
} from "../home-surface.ts";
import type {
  MissionDeepLinkIntent,
  MissionsActivityFeatureSession,
  MissionsActivityHoverTarget,
} from "../features/missions-activity/feature.tsx";
import { TuiCleanupRegistry, resolveInputLayer } from "../input-lifecycle.ts";
import {
  TuiApplicationLifecycle,
  createApplicationLifecycleInputExecutor,
} from "./application-lifecycle.ts";
import { startTuiApplication } from "./application-bootstrap.ts";
import { OpenTuiLocalViewController } from "./local-view-controller.ts";
import { tuiEscapeFocusTarget, tuiInteractionPresentation } from "../interaction-flow.ts";
import {
  createRendererCommandExecutor,
  rendererInvocationForGlobal,
  rendererInvocationForView,
} from "../renderer-commands.ts";
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
} from "../workspace-ui-state.ts";
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
} from "../dialog-model.ts";
import {
  dialogStack,
  dialogKey,
  DialogSelect,
  DialogPrompt,
  DialogConfirm,
} from "../dialog-stack.ts";
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
} from "../settings-model.ts";
import { loadAppConfig, loadRawAppConfig, updateAppConfig } from "../../../lib/app-config.ts";
import {
  APP_FOCUS_OPTION,
  APP_JUMP_OPTION,
  buildAppFocusValue,
  parseNotificationPrefs,
} from "../../chrome/notify.ts";
import { adoptMarkArgv, updaterProbeArgv, updaterSpawnArgv } from "../../chrome/front-door.ts";
import { APP_HOST_SESSION } from "../hosted.ts";
import { publishTuiInputReady } from "../../readiness.ts";
import {
  ATTENTION_FLASH_MS,
  attentionNoteLine,
  diffAttention,
  noteworthyTransitions,
  type AttentionAgent,
} from "../attention.ts";
import {
  buildHomeItems,
  clampSelectable,
  firstRunTip,
  stepSelectable,
  sessionNameFor,
  isValidSessionName,
  type HomeItem,
} from "../home-model.ts";
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
} from "../agent-rows.ts";
import { visitOrder, stepMatch, offsetForMatch, type SearchMatch } from "../search-model.ts";
import { spans, spanHit, spansFromRight, type Span } from "../spans.ts";
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
} from "../agent-lifecycle.ts";
import { executeTuiAgentProvisioning } from "../agent-provisioning-executor.ts";
import { getManifests } from "../../detect/manifest-loader.ts";
import { agentsByPane } from "../agent-chip.ts";
import { scrollThumb, trackZone, pageTop, dragTop } from "../scrollbar-model.ts";
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
} from "../menu-model.ts";
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
} from "../selection.ts";
import { readCanonicalDaemonInfo } from "../../../lib/canonical-daemon.ts";
import {
  parseSessionPaneDescriptors,
  SESSION_PANE_DESCRIPTOR_FORMAT,
} from "../../../terminal/protocol/session-descriptor-discovery.ts";
import {
  createTuiToolResourceAdapter,
  createTuiToolResourceController,
  type TuiDockResourceKey,
  type TuiToolResource,
} from "./tool-resource-controller.ts";
import {
  projectAuthoritativeAgentRows,
  projectTuiFleetResources,
  type ApplicationShellAgentRowSource,
} from "./tool-resource-projection.ts";
import { TerminalToolReadinessGate } from "./terminal-tool-readiness.ts";
import { OpenTuiTerminalWorkspaceAdapter } from "./terminal-workspace-adapter.ts";
import { LatestIntentFence } from "./latest-intent-fence.ts";
import { changesIdentityKey, resolveDeferredChangesIdentity } from "./changes-deferred-identity.ts";
import { GenerationBoundSlot } from "./generation-bound-slot.ts";
import {
  createApplicationOptionalFeatureRegistry,
  type ApplicationOptionalFeatures,
} from "./application-optional-features.ts";

type TuiAppArgs = { target?: string; edit?: string; diff?: string };
let values!: TuiAppArgs;
let target!: string;
// Bare launch (no `--target`, or the explicit `home` pseudo-target) opens the
// HOME panel instead of a session semanticView; a real target boots straight to the
// semanticView exactly as before. `--diff <dir>` boots straight into the diff panel
// (for testing / direct entry).
let startDiff!: boolean;
let bareHome!: boolean;

/** UI projection assembled from action-authoritative daemon sessions/projects
 * plus display-only FleetCatalog decoration. */
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

const TUI_PERF_LOG = process.env.TMUX_IDE_TUI_PERF_LOG;
const TUI_LAUNCH_EPOCH_MS = Number(process.env.TMUX_IDE_TUI_LAUNCH_EPOCH_MS ?? Date.now());
const tuiPerfMark = (phase: string, details?: Readonly<Record<string, unknown>>) => {
  if (!TUI_PERF_LOG) return;
  try {
    appendFileSync(
      TUI_PERF_LOG,
      `${JSON.stringify({ phase, elapsedMs: Date.now() - TUI_LAUNCH_EPOCH_MS, at: new Date().toISOString(), ...details })}\n`,
    );
  } catch {
    // Profiling is opt-in diagnostics and must never affect the TUI lifecycle.
  }
};
tuiPerfMark("module-loaded");

// Focused-pane gutter hairline (M22.7): the ACCENT family, drawn as │/─ glyphs
// so the gutter stays visually thin (a filled bar read as extra padding — user
// feedback). Doesn't compete with the blocked chip's red — focus is an accent
// signal, agent state is a status signal, never the same hue.
// A single subtle pointer-hover tint, between the background and selected state.
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
 *  semantic button-hover token). M21.9 adds: `tabbtn` (the tab bar's right-aligned context/
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
type DiffLineTone = "add" | "del" | "hunk" | "meta" | "context";
const DIFF_FG: Record<DiffLineTone, RGBA> = {
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
// semanticView the widget theme's diffAddedBg/diffRemovedBg (widgets/lib/theme.ts:27-34)
// — that theme is the future token source once the app's const surface colors
// move onto the theming pipeline.
const DIFF_ADD_BG = RGBA.fromInts(20, 60, 30, 255);
const DIFF_DEL_BG = RGBA.fromInts(60, 20, 20, 255);
const DIFF_LINE_BG: Partial<Record<DiffLineTone, RGBA>> = { add: DIFF_ADD_BG, del: DIFF_DEL_BG };
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
let STARTUP_CONFIG!: ReturnType<typeof loadAppConfig>;
let KITTY_KEYS!: boolean;
let TABBAR_PALETTE_LABEL!: string;
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
const cleanupRegistry = new TuiCleanupRegistry();
let appRenderer!: Awaited<ReturnType<typeof createCliRenderer>>;
let applicationLifecycle!: TuiApplicationLifecycle;
let resolveInputReady!: () => void;
const inputReady = new Promise<void>((resolve) => {
  resolveInputReady = resolve;
});
let publishToolReadiness = (): void => undefined;

const parseTuiAppArgs = (argv: readonly string[]): TuiAppArgs => {
  values = parseArgs({
    args: [...argv],
    options: {
      target: { type: "string" },
      edit: { type: "string" },
      diff: { type: "string" },
    },
  }).values;
  target = values.target ?? "";
  startDiff = values.diff !== undefined;
  bareHome = target === "" || target === "home";
  return values;
};

const loadTuiAppConfig = () => {
  STARTUP_CONFIG = loadAppConfig();
  KITTY_KEYS = STARTUP_CONFIG.app.kittyKeys;
  TABBAR_PALETTE_LABEL = KITTY_KEYS ? "F5 ⌘K palette " : "F5 ⌘ palette ";
  return STARTUP_CONFIG;
};

const createTuiRenderer = async () => {
  appRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    maxFps: 60,
    autoFocus: false,
    useKittyKeyboard: KITTY_KEYS ? {} : null,
    consoleMode: process.env.TMUX_IDE_MIRROR_DEBUG ? "console-overlay" : "disabled",
    openConsoleOnError: !!process.env.TMUX_IDE_MIRROR_DEBUG,
    onDestroy: () => hostAutowrap?.restore(),
  });
  tuiPerfMark("renderer-created");
  if (TUI_PERF_LOG) {
    const firstFrame = async () => {
      tuiPerfMark("first-frame");
      appRenderer.removeFrameCallback(firstFrame);
    };
    appRenderer.setFrameCallback(firstFrame);
  }
  if (STARTUP_CONFIG.theme.mode === "system") {
    void appRenderer.getPalette({ size: 16 }).catch(() => undefined);
  }
  hostAutowrap = installHostAutowrapGuard((sequence) => writeSync(process.stdout.fd, sequence), {
    onExit: (listener) => process.once("exit", listener),
    offExit: (listener) => process.removeListener("exit", listener),
  });
  return appRenderer;
};

const createTuiLifecycle = (renderer: Awaited<ReturnType<typeof createCliRenderer>>) => {
  applicationLifecycle = new TuiApplicationLifecycle({
    cleanupRegistry,
    destroyRenderer: () => renderer.destroy(),
  });
  return applicationLifecycle;
};

const mountTuiRoot = () => {
  const root = render(() => {
    // Register <pane_surface> before any is created (M21.3). An explicit call —
    // a bare side-effect import of the module gets DCE'd by the transpiler.
    if (FB_PANES) registerPaneSurface();
    const dims = useTerminalDimensions();
    const semanticThemeStore = createSemanticThemeStore(STARTUP_CONFIG.theme, {
      rendererMode: appRenderer.themeMode,
    });
    const [semanticTheme, setSemanticTheme] = createSignal(semanticThemeStore.getSnapshot());
    const terminalPalette = createMemo(() => createTerminalPaletteProjection(semanticTheme()));
    const createMarkdownSyntaxStyle = () => {
      const theme = semanticTheme();
      return SyntaxStyle.fromStyles({
        default: { fg: theme.roles.text.primary },
        "markup.heading": { fg: theme.colors.accent, bold: true },
        "markup.strong": { fg: theme.roles.text.primary, bold: true },
        "markup.italic": { fg: theme.roles.text.secondary, italic: true },
        "markup.raw": {
          fg: theme.roles.text.primary,
          bg: theme.roles.surfaces.headerActive,
        },
        "markup.raw.block": {
          fg: theme.roles.text.primary,
          bg: theme.roles.surfaces.headerActive,
        },
        "markup.link": { fg: theme.colors.accent, underline: true },
        "markup.link.label": { fg: theme.colors.accent, underline: true },
        "markup.link.url": { fg: theme.roles.text.secondary, underline: true },
        "markup.quote": { fg: theme.roles.text.secondary, italic: true },
        "markup.list": { fg: theme.colors.accent },
      });
    };
    let ownedMarkdownSyntaxStyle = createMarkdownSyntaxStyle();
    const [markdownSyntaxStyle, setMarkdownSyntaxStyle] = createSignal(ownedMarkdownSyntaxStyle);
    createEffect(() => {
      // Rebuild only when the semantic theme changes. The terminal grid and
      // rich Markdown then share one palette authority.
      semanticTheme();
      const next = createMarkdownSyntaxStyle();
      const previous = ownedMarkdownSyntaxStyle;
      ownedMarkdownSyntaxStyle = next;
      setMarkdownSyntaxStyle(next);
      previous.destroy();
    });
    // Keep the native clear/background color synchronized with the semantic
    // canvas. This removes transparent/default-color flashes during resize and
    // makes every painted and unpainted cell obey the same theme authority.
    createEffect(() => appRenderer.setBackgroundColor(semanticTheme().roles.surfaces.canvas));
    const disposeSemanticThemeStore = semanticThemeStore.subscribe(() =>
      setSemanticTheme(semanticThemeStore.getSnapshot()),
    );
    const disposeRendererThemeMode = semanticThemeStore.followRendererThemeMode(appRenderer);
    onCleanup(() => {
      ownedMarkdownSyntaxStyle.destroy();
      disposeRendererThemeMode();
      disposeSemanticThemeStore();
    });
    const shellLayout = () => applicationShellProjection().layout;
    const sidebarW = () => shellLayout().sidebar.width;
    const sidebarHint = () => applicationShellProjection().sidebarHint;
    const paletteW = () => shellLayout().paletteWidth;
    const dialogW = () => shellLayout().dialogWidth;
    const dialogInnerWidth = () => dialogInnerW(dialogW());

    // Persisted state (one-shot read at launch — NOT on the render loop). The tab
    // and context restore below; the open editor file / diff selection restore in
    // onMount (after the FFI buffer + fleet arrive).
    const persisted: AppState = loadAppState();
    // A bare launch cannot trust a persisted session until the live fleet has
    // confirmed it. Keep the renderer unattached during that short discovery
    // window; an explicit CLI target remains authoritative immediately.
    const initialContextSession = bareHome
      ? ""
      : startupContextSession(target, false, persisted.contextSession);
    let startupWorkspaceReconciled = !bareHome;
    const [contextSession, setContextSession] = createSignal<string>(initialContextSession);
    const [contextDir, setContextDir] = createSignal<string>("");
    const editorOpenIntent = new LatestIntentFence<string>();
    const changesPrepareIntent = new LatestIntentFence<string>();
    const changesHydrationIntent = new LatestIntentFence<string>();
    const missionsHydrationIntent = new LatestIntentFence<string>();
    const activityHydrationIntent = new LatestIntentFence<string>();
    const editorOpenScope = () => `${contextSession()}\u0000${contextDir() || invokeCwd}`;
    onCleanup(() => {
      editorOpenIntent.retire();
      changesPrepareIntent.retire();
      changesHydrationIntent.retire();
      missionsHydrationIntent.retire();
      activityHydrationIntent.retire();
    });
    const [projectsData, setProjectsData] = createSignal<FleetProject[]>([]);
    const optionalFeatures = createApplicationOptionalFeatureRegistry();
    const [filesFeature, setFilesFeature] = createSignal<ApplicationOptionalFeatures["files"]>();
    const [filesSession, setFilesSession] = createSignal<FilesFeatureSession>();
    const [changesFeature, setChangesFeature] =
      createSignal<ApplicationOptionalFeatures["changes"]>();
    const [changesSession, setChangesSession] = createSignal<ChangesFeatureSession>();
    const [missionsActivityFeature, setMissionsActivityFeature] =
      createSignal<ApplicationOptionalFeatures["missionsActivity"]>();
    const [missionsActivitySession, setMissionsActivitySession] =
      createSignal<MissionsActivityFeatureSession>();
    let toolResourceGeneration = -1;
    const pendingFilesCatalog = new GenerationBoundSlot<WorkspaceFilesCatalogEnvelopeV1>();
    const pendingChangesCatalog = new GenerationBoundSlot<WorkspaceChangesCatalogEnvelopeV1>();
    const pendingMissionsCatalog = new GenerationBoundSlot<WorkspaceMissionsEnvelopeV1>();
    let executeMissionDeepLinkIntent = (_intent: MissionDeepLinkIntent): void => undefined;
    let persistMissionsFeatureState = (_state: {
      panel: "missions";
      selectedMissionId: string | null;
      selectedTaskId: string | null;
      navigation?: import("../workspace-ui-state.ts").WorkspaceMissionsNavigationState;
    }): void => undefined;
    let persistActivityFeatureState = (_state: {
      selectedRowId: string | null;
      scrollOffset: number;
    }): void => undefined;
    let pendingFilesSelectionPath: string | null = null;
    const [filesFeatureLoadState, setFilesFeatureLoadState] = createSignal<
      "idle" | "loading" | "ready" | "failed"
    >("idle");
    let filesFeatureRequest: Promise<ApplicationOptionalFeatures["files"] | undefined> | null =
      null;
    const ensureFilesFeature = (): Promise<ApplicationOptionalFeatures["files"] | undefined> => {
      const loaded = filesFeature();
      if (loaded) return Promise.resolve(loaded);
      if (filesFeatureRequest) return filesFeatureRequest;
      setFilesFeatureLoadState("loading");
      const request = optionalFeatures.request("files");
      filesFeatureRequest = request;
      void request.then(
        (feature) => {
          if (filesFeatureRequest !== request) return;
          if (!feature) {
            setFilesFeatureLoadState("failed");
            filesFeatureRequest = null;
            return;
          }
          setFilesFeature(() => feature);
          const session = feature.createFilesFeatureSession({
            workspaceDir: () => contextDir() || invokeCwd,
            workspaceName: contextSession,
            width: () => dockSurfaceWidth(),
            height: () => dockSurfaceHeight(),
            hover,
            activePanel,
            mode,
            activateFiles: () => setTab("files"),
            leaveFiles: (previous) => setTab(previous === "mirror" ? "terminal" : "home"),
            refresh: () => toolResources.session.refresh("files"),
            note: setStatusNote,
            initialShowHidden: persisted.filesShowHidden,
            initialShowIgnored: persisted.filesShowIgnored,
            quitHint: QUIT_HINT,
          });
          setFilesSession(() => session);
          session.pendingSelectionPath = pendingFilesSelectionPath;
          pendingFilesSelectionPath = null;
          const retainedCatalog = pendingFilesCatalog.take(toolResourceGeneration);
          if (retainedCatalog) session.applyCatalog(retainedCatalog);
          setFilesFeatureLoadState("ready");
          filesFeatureRequest = null;
        },
        () => {
          if (filesFeatureRequest !== request) return;
          setFilesFeatureLoadState("failed");
          filesFeatureRequest = null;
        },
      );
      return request;
    };
    const [changesFeatureLoadState, setChangesFeatureLoadState] = createSignal<
      "idle" | "loading" | "ready" | "failed"
    >("idle");
    let changesFeatureRequest: Promise<ApplicationOptionalFeatures["changes"] | undefined> | null =
      null;
    const startupChangesIdentity = values.diff
      ? { workspaceName: initialContextSession || target, directory: values.diff }
      : null;
    const changesIdentity = () =>
      resolveDeferredChangesIdentity({
        workspaceName: contextSession() || target,
        directory: contextDir(),
        fallbackDirectory: invokeCwd,
        startup: startupChangesIdentity,
      });
    const changesIdentityScope = () => changesIdentityKey(changesIdentity());
    const changesHover = (): ChangesHoverTarget | null => {
      const current = hover();
      if (!current) return null;
      if (current.region === "button") return { kind: "header-action", index: current.index };
      if (current.region === "diffverb") return { kind: "footer-action", index: current.index };
      if (current.region === "diff") return { kind: "list-row", index: current.index };
      return null;
    };
    const ensureChangesFeature = (): Promise<
      ApplicationOptionalFeatures["changes"] | undefined
    > => {
      const loaded = changesFeature();
      if (loaded) return Promise.resolve(loaded);
      if (changesFeatureRequest) return changesFeatureRequest;
      setChangesFeatureLoadState("loading");
      const request = optionalFeatures.request("changes");
      changesFeatureRequest = request;
      void request.then(
        (feature) => {
          if (changesFeatureRequest !== request) return;
          if (!feature) {
            setChangesFeatureLoadState("failed");
            changesFeatureRequest = null;
            return;
          }
          setChangesFeature(() => feature);
          const session = feature.createChangesFeatureController(
            {
              width: () => dockSurfaceWidth(),
              height: () => dockSurfaceHeight(),
              hover: changesHover,
              refreshResource: () => toolResources.session.refresh("changes"),
              setStatusNote,
              openEditor: (path, line) => openEditor(path, line),
              runGit: (directory, args, callback) => {
                execFile(
                  "git",
                  [
                    "-C",
                    directory,
                    "-c",
                    "core.quotepath=false",
                    "-c",
                    "core.fsmonitor=false",
                    ...args,
                  ],
                  { timeout: 10_000, maxBuffer: 16_000_000 },
                  (error, stdout) => callback(error ? "" : stdout),
                );
              },
              readFile: (path) => readFileSync(path),
            },
            changesIdentity(),
          );
          setChangesSession(() => session);
          const retainedCatalog = pendingChangesCatalog.take(toolResourceGeneration);
          if (retainedCatalog) session.applyCatalog(retainedCatalog);
          setChangesFeatureLoadState("ready");
          changesFeatureRequest = null;
        },
        () => {
          if (changesFeatureRequest !== request) return;
          setChangesFeatureLoadState("failed");
          changesFeatureRequest = null;
        },
      );
      return request;
    };
    const [missionsActivityLoadState, setMissionsActivityLoadState] = createSignal<
      "idle" | "loading" | "ready" | "failed"
    >("idle");
    let missionsActivityRequest: Promise<
      ApplicationOptionalFeatures["missionsActivity"] | undefined
    > | null = null;
    const missionsActivityIdentity = () => {
      const directory = contextDir() || invokeCwd;
      const workspaceName = contextSession() || target;
      const repository = workspaceUiController?.snapshot().repository;
      return {
        workspaceName,
        directory,
        projectRoot: repository?.metadata.projectRoot ?? directory,
        identityKey: repository?.metadata.identityKey ?? `${workspaceName}\u0000${directory}`,
      };
    };
    const missionsActivityIdentityScope = () => {
      const identity = missionsActivityIdentity();
      return `${identity.workspaceName}\u0000${identity.directory}\u0000${identity.identityKey}`;
    };
    const missionsActivityHover = (): MissionsActivityHoverTarget | null => {
      const current = hover();
      if (!current) return null;
      if (current.region === "missionmode") return { kind: "mission-mode", index: current.index };
      if (current.region === "missionbutton")
        return { kind: "mission-button", index: current.index };
      if (current.region === "missioncard") return { kind: "mission-card", index: current.index };
      if (current.region === "missionhistory")
        return { kind: "mission-history", index: current.index };
      return null;
    };
    const ensureMissionsActivityFeature = (): Promise<
      ApplicationOptionalFeatures["missionsActivity"] | undefined
    > => {
      const loaded = missionsActivityFeature();
      if (loaded) return Promise.resolve(loaded);
      if (missionsActivityRequest) return missionsActivityRequest;
      setMissionsActivityLoadState("loading");
      const request = optionalFeatures.request("missionsActivity");
      missionsActivityRequest = request;
      void request.then(
        (feature) => {
          if (missionsActivityRequest !== request) return;
          if (!feature) {
            setMissionsActivityLoadState("failed");
            missionsActivityRequest = null;
            return;
          }
          setMissionsActivityFeature(() => feature);
          const session = feature.createMissionsActivityFeatureSession(
            {
              width: () => dockSurfaceWidth(),
              height: () => dockSurfaceHeight(),
              hover: missionsActivityHover,
              agents: fleetAgents,
              interactions: () =>
                interactionFeed().activity.map((receipt) => ({
                  operationId: receipt.operationId,
                  sequence: receipt.sequence,
                  at: receipt.at,
                  source: interactionReceiptTargetLabel(receipt, interactionPaneLabel),
                  message: interactionReceiptLabel(receipt),
                  detail: `${receipt.workspaceName} · ${receipt.origin}`,
                  phase: receipt.phase,
                })),
              refresh: () => toolResources.session.refresh("missions"),
              setStatusNote,
              persistMissions: (state) => persistMissionsFeatureState(state),
              persistActivity: (state) => persistActivityFeatureState(state),
              deepLinkContext: () => ({
                projectRoot: missionsActivityIdentity().projectRoot,
                views: (["terminals", "files", "diff"] as const).map((panel) =>
                  nativeHostedViewForPanel(hostedViews(), panel),
                ),
                resolveProjectPath: absoluteProjectPath,
              }),
              executeDeepLink: (intent) => executeMissionDeepLinkIntent(intent),
            },
            missionsActivityIdentity(),
            toolResourceGeneration,
          );
          setMissionsActivitySession(() => session);
          const retainedCatalog = pendingMissionsCatalog.take(toolResourceGeneration);
          if (retainedCatalog) session.applyCatalog(toolResourceGeneration, retainedCatalog);
          setMissionsActivityLoadState("ready");
          missionsActivityRequest = null;
        },
        () => {
          if (missionsActivityRequest !== request) return;
          setMissionsActivityLoadState("failed");
          missionsActivityRequest = null;
        },
      );
      return request;
    };
    applicationLifecycle.registerCloser("optional-features", () => {
      filesFeatureRequest = null;
      changesFeatureRequest = null;
      missionsActivityRequest = null;
      filesSession()?.dispose();
      changesSession()?.dispose();
      missionsActivitySession()?.dispose();
      setFilesSession(undefined);
      setChangesSession(undefined);
      setMissionsActivitySession(undefined);
      optionalFeatures.dispose();
      tuiPerfMark("optional-feature-metrics", { ...optionalFeatures.getMetrics() });
    });
    const toolResources = createTuiToolResourceController(createTuiToolResourceAdapter());
    applicationLifecycle.registerCloser("tool-resources", () => {
      tuiPerfMark("application-shell-metrics", { ...toolResources.getMetrics() });
      toolResources.dispose();
    });
    const execFile = ((...args: unknown[]) => {
      toolResources.noteSubprocessLaunch();
      return (nodeExecFile as unknown as (...values: unknown[]) => unknown)(...args);
    }) as typeof nodeExecFile;
    const spawn = ((...args: unknown[]) => {
      toolResources.noteSubprocessLaunch();
      return (nodeSpawn as unknown as (...values: unknown[]) => unknown)(...args);
    }) as typeof nodeSpawn;
    let terminalToolReadiness!: TerminalToolReadinessGate;
    let reconcileFleetResources = (): void => undefined;
    let latestAuthoritativeAgents: AgentRowInput[] = [];
    let latestApplicationShellAgents: readonly ApplicationShellAgentRowSource[] = [];
    let latestApplicationShellWorkspaceName = "";
    let reconcileAuthoritativeAgents = (): void => undefined;
    const fleet = (): Array<{ name: string; status: AgentStatus }> =>
      projectsData()
        .flatMap((project) =>
          project.sessions.map((session) => ({ name: session.name, status: session.status })),
        )
        .filter(
          (session, index, all) =>
            all.findIndex((candidate) => candidate.name === session.name) === index,
        );
    const fleetAgents = createMemo<AgentRowInput[]>(() =>
      sortAgentRows(
        projectsData()
          .flatMap((project) => project.sessions.flatMap((session) => session.agents ?? []))
          .filter(
            (agent, index, all) =>
              all.findIndex((candidate) => candidate.paneId === agent.paneId) === index,
          ),
      ),
    );
    const [status, setStatus] = createSignal(bareHome ? "home" : "attaching…");
    const [paletteOpen, setPaletteOpen] = createSignal(false);
    const [paletteFocusReturnTarget, setPaletteFocusReturnTarget] =
      createSignal<SemanticFocusTarget | null>(null);
    const [hover, setHover] = createSignal<{ region: HoverRegion; index: number } | null>(null);
    // Terminal pixels and shell structure have different invalidation domains.
    // Content output publishes only the compact version map; geometry/chrome
    // consumers remain asleep unless tmux actually changes pane structure.
    const [panes, setPanes] = createSignal<LivePane[]>([], {
      equals: FB_PANES ? sameLivePaneStructure : false,
    });
    // Focus is a synchronous control-plane signal. It must not wait behind the
    // coalesced geometry/framebuffer publication path before chrome reacts.
    const [focusedPaneId, setFocusedPaneId] = createSignal<string | null>(null);
    const activeTerminalPaneId = createMemo(() => activeLivePaneId(panes(), focusedPaneId()));
    const focusedPanes = createMemo(() => withLivePaneFocus(panes(), focusedPaneId()));
    const paneIsFocused = (paneId: string): boolean => activeTerminalPaneId() === paneId;
    const [paneRuntime, setPaneRuntime] = createSignal<ReturnType<typeof livePaneRuntime>>(
      new Map(),
      { equals: sameLivePaneRuntime },
    );
    const paneRuntimeFor = (paneId: string) => paneRuntime().get(paneId);
    const paneScrollbackDepth = (pane: LivePane): number =>
      FB_PANES
        ? (paneRuntimeFor(pane.id)?.scrollbackDepth ?? pane.scrollbackDepth)
        : pane.scrollbackDepth;
    let semanticView: SemanticSessionView | null = null;
    reconcileAuthoritativeAgents = () => {
      latestAuthoritativeAgents = projectAuthoritativeAgentRows({
        workspaceName: latestApplicationShellWorkspaceName,
        agents: latestApplicationShellAgents,
        paneDescriptors: semanticView?.paneDescriptors() ?? [],
      });
      reconcileFleetResources();
    };
    let localDescriptorRequest = 0;
    let localDescriptorSignature: string | null = null;
    let localDescriptorAuthorityGeneration: string | null = null;
    const refreshLocalRuntimeDescriptors = (
      sessionName: string,
      candidate: SemanticSessionView,
      authorityGeneration: string,
    ): void => {
      const semanticIds = candidate
        .paneDescriptors()
        .map(({ semanticPaneId }) => semanticPaneId)
        .filter((paneId): paneId is string => paneId !== null)
        .sort();
      const signature = `${authorityGeneration}\0${sessionName}\0${semanticIds.join("\0")}`;
      if (semanticIds.length === 0 || signature === localDescriptorSignature) return;
      localDescriptorSignature = signature;
      const request = ++localDescriptorRequest;
      execFile(
        "tmux",
        ["list-panes", "-s", "-t", `=${sessionName}`, "-F", SESSION_PANE_DESCRIPTOR_FORMAT],
        { encoding: "utf8" },
        (error, stdout) => {
          if (
            request !== localDescriptorRequest ||
            semanticView !== candidate ||
            localDescriptorAuthorityGeneration !== authorityGeneration ||
            localDescriptorSignature !== signature
          )
            return;
          if (error) {
            localDescriptorSignature = null;
            setStatusNote("local tmux identity discovery unavailable");
            return;
          }
          candidate.setRuntimeDescriptors(
            authorityGeneration,
            parseSessionPaneDescriptors(stdout.trimEnd().split("\n")),
          );
          reconcileAuthoritativeAgents();
        },
      );
    };
    let terminalWorkspaceAdapter: OpenTuiTerminalWorkspaceAdapter | null = null;
    applicationLifecycle.registerCloser("terminal-workspace", () => {
      terminalWorkspaceAdapter?.dispose();
      terminalWorkspaceAdapter = null;
    });
    const [sessionRuntimeLane, setSessionRuntimeLane] =
      createSignal<OpenTuiSessionRuntimeLane | null>(null);
    const terminalRenderSourceEpoch = (): number => {
      sessionRuntimeLane();
      return terminalWorkspaceAdapter?.renderEpoch ?? 0;
    };
    const [semanticPaneVersions, setSemanticPaneVersions] = createSignal<
      ReadonlyMap<string, number>
    >(new Map(), { equals: false });
    let sessionRuntimeLaneKey: string | null = null;
    let sessionRuntimeLaneRequest = 0;
    let runtimeLaneFitKey: string | null = null;
    let pendingSemanticFocus: { session: string; paneId: string } | null = null;
    const semanticWindowOrder: string[] = [];
    const semanticWindowActivePane = new Map<string, string>();
    const semanticPaneCanonicalSize = new Map<string, { cols: number; rows: number }>();
    let observePendingResizeLayout: () => void = () => {};
    const semanticPaneIdForRuntime = (runtimePaneId: string): string =>
      openTuiSemanticPaneIdForRuntime(runtimePaneId, semanticView?.paneDescriptors() ?? []);
    const runtimePaneIdForSemantic = (semanticPaneId: string): string =>
      semanticView
        ?.paneDescriptors()
        .find((descriptor) => descriptor.semanticPaneId === semanticPaneId)?.runtimePaneId ??
      semanticPaneId;
    const semanticReplicaForRuntime = (runtimePaneId: string) => {
      const lane = sessionRuntimeLane();
      const adapter = terminalWorkspaceAdapter;
      if (!lane || !adapter) return null;
      // SemanticSessionView panes are already keyed by durable ids; sidebar
      // actions may still arrive with raw runtime ids. Resolve both without
      // synthesizing a second `pane.*` identity around an already-semantic id.
      const semanticPaneId = lane.source.replica(runtimePaneId)
        ? runtimePaneId
        : semanticPaneIdForRuntime(runtimePaneId);
      return { adapter, lane, semanticPaneId };
    };
    const retireSessionRuntimeLane = () => {
      sessionRuntimeLaneRequest += 1;
      localDescriptorRequest += 1;
      localDescriptorSignature = null;
      localDescriptorAuthorityGeneration = null;
      semanticView?.retireRuntimeAuthority();
      sessionRuntimeLaneKey = null;
      sessionRuntimeLane()?.close();
      setSessionRuntimeLane(null);
      runtimeLaneFitKey = null;
      semanticWindowOrder.length = 0;
      semanticWindowActivePane.clear();
      semanticPaneCanonicalSize.clear();
      setSemanticPaneVersions(new Map());
    };
    const reconcileSessionRuntimeLane = async (
      sessionName: string,
      candidate: SemanticSessionView,
    ): Promise<void> => {
      const semanticPaneIds = candidate
        .paneDescriptors()
        .map((descriptor) => descriptor.semanticPaneId)
        .filter((paneId): paneId is string => paneId !== null)
        .sort();
      if (semanticPaneIds.length === 0) {
        if (sessionRuntimeLaneKey !== null || sessionRuntimeLane()) retireSessionRuntimeLane();
        else candidate.retireRuntimeAuthority();
        return;
      }
      const key = `${sessionName}\0${semanticPaneIds.join("\0")}`;
      if (sessionRuntimeLaneKey === key) return;
      const request = ++sessionRuntimeLaneRequest;
      const authorityGeneration = `${sessionName}\0runtime:${request}`;
      sessionRuntimeLaneKey = key;
      localDescriptorRequest += 1;
      localDescriptorSignature = null;
      localDescriptorAuthorityGeneration = null;
      candidate.retireRuntimeAuthority();
      sessionRuntimeLane()?.close();
      setSessionRuntimeLane(null);
      runtimeLaneFitKey = null;
      setSemanticPaneVersions(new Map());
      try {
        const connectRuntime = () =>
          connectOpenTuiSessionRuntime({
            sessionName,
            semanticPaneIds,
            onPaneChange: (paneId, change) => {
              if (request !== sessionRuntimeLaneRequest) return;
              setSemanticPaneVersions((current) => {
                const next = new Map(current);
                next.set(paneId, change.version);
                return next;
              });
              markDirty();
            },
            onLayout: (frame) => {
              if (request !== sessionRuntimeLaneRequest || semanticView !== candidate) return;
              const windowKey =
                frame.semanticWindowId ?? `unverified:${frame.windowName ?? "window"}`;
              if (!semanticWindowOrder.includes(windowKey)) semanticWindowOrder.push(windowKey);
              const activePane =
                frame.panes.find((pane) => pane.active)?.pane ?? frame.panes[0]?.pane;
              if (activePane) semanticWindowActivePane.set(windowKey, activePane);
              for (const pane of frame.panes) {
                if (pane.pane)
                  semanticPaneCanonicalSize.set(pane.pane, {
                    cols: pane.width,
                    rows: pane.height,
                  });
              }
              candidate.acceptLayout(frame);
              terminalToolReadiness.observeGeometry();
              reconcileAuthoritativeAgents();
              observePendingResizeLayout();
              void candidate.windows().then(setWindowTabs);
              markDirty();
            },
            onFault: () => {
              if (request !== sessionRuntimeLaneRequest) return;
              localDescriptorRequest += 1;
              localDescriptorSignature = null;
              localDescriptorAuthorityGeneration = null;
              candidate.retireRuntimeAuthority();
              sessionRuntimeLaneKey = null;
              sessionRuntimeLane()?.close();
              setSessionRuntimeLane(null);
              runtimeLaneFitKey = null;
              setSemanticPaneVersions(new Map());
              markDirty();
              const retry = setTimeout(() => {
                if (request === sessionRuntimeLaneRequest && semanticView === candidate) {
                  void reconcileSessionRuntimeLane(sessionName, candidate);
                }
              }, 1_000);
              retry.unref?.();
            },
          });
        const lane =
          terminalWorkspaceAdapter?.view === candidate
            ? await terminalWorkspaceAdapter.connect(
                `${key}\0generation:${request}`,
                connectRuntime,
              )
            : await connectRuntime();
        if (request !== sessionRuntimeLaneRequest) {
          lane?.close();
          return;
        }
        if (!lane) return;
        localDescriptorAuthorityGeneration = authorityGeneration;
        candidate.setRuntimeAuthorityGeneration(authorityGeneration);
        refreshLocalRuntimeDescriptors(sessionName, candidate, authorityGeneration);
        candidate.setSource(lane.source);
        setSessionRuntimeLane(lane);
        reconcileAuthoritativeAgents();
        if (!lane.ownsGeometry) terminalToolReadiness.observeGeometry();
        if (
          pendingSemanticFocus?.session === sessionName &&
          submitSemanticPaneFocus(pendingSemanticFocus.paneId) === "submitted"
        ) {
          pendingSemanticFocus = null;
        }
      } catch {
        if (request === sessionRuntimeLaneRequest) {
          localDescriptorRequest += 1;
          localDescriptorSignature = null;
          localDescriptorAuthorityGeneration = null;
          candidate.retireRuntimeAuthority();
          sessionRuntimeLaneKey = null;
        }
      }
    };
    const [daemonApplicationShellState, setDaemonApplicationShellState] =
      createSignal<ApplicationShellSessionState | null>(null);
    const [interactionFeed, setInteractionFeed] = createSignal<InteractionFeedState>(
      initialInteractionFeedState(),
      { equals: false },
    );
    const [activeInteractionSequences, setActiveInteractionSequences] = createSignal<
      ReadonlySet<number>
    >(new Set(), { equals: false });
    const interactionPresenceTimers = new Map<number, ReturnType<typeof setTimeout>>();
    const clearInteractionPresence = () => {
      for (const timer of interactionPresenceTimers.values()) clearTimeout(timer);
      interactionPresenceTimers.clear();
      setActiveInteractionSequences(new Set());
    };
    const markInteractionPresence = (sequence: number) => {
      // Presence is a user-facing acknowledgement, so its readable lifetime
      // starts when this client receives the event. Replay/transport latency
      // must not silently consume the whole highlight before it can paint.
      setActiveInteractionSequences((current) => new Set([...current, sequence]));
      const previous = interactionPresenceTimers.get(sequence);
      if (previous) clearTimeout(previous);
      interactionPresenceTimers.set(
        sequence,
        setTimeout(() => {
          interactionPresenceTimers.delete(sequence);
          setActiveInteractionSequences((current) => {
            const next = new Set(current);
            next.delete(sequence);
            return next;
          });
        }, INTERACTION_PRESENCE_MS),
      );
    };
    let daemonApplicationShellAuthority: OpenTuiApplicationShellAuthority | null = null;
    let disposeDaemonApplicationShellSubscription: (() => void) | null = null;
    let daemonApplicationShellRequest = 0;
    const retireDaemonApplicationShell = () => {
      disposeDaemonApplicationShellSubscription?.();
      disposeDaemonApplicationShellSubscription = null;
      daemonApplicationShellAuthority?.session.dispose();
      daemonApplicationShellAuthority = null;
      toolResources.setTarget(null);
      setDaemonApplicationShellState(null);
      latestApplicationShellAgents = [];
      latestApplicationShellWorkspaceName = "";
      reconcileAuthoritativeAgents();
      setInteractionFeed(initialInteractionFeedState());
      clearInteractionPresence();
    };
    const connectDaemonApplicationShell = async (sessionName: string) => {
      const request = ++daemonApplicationShellRequest;
      retireDaemonApplicationShell();
      try {
        const authority = await connectOpenTuiApplicationShellAuthority(sessionName, {
          onInteractionReceipt: (receipt) => {
            setInteractionFeed((current) => reduceInteractionReceipt(current, receipt));
            if (interactionPresenceIsFresh(receipt)) markInteractionPresence(receipt.sequence);
          },
        });
        if (request !== daemonApplicationShellRequest) {
          authority?.session.dispose();
          return;
        }
        if (!authority) return;
        daemonApplicationShellAuthority = authority;
        const daemon = readCanonicalDaemonInfo();
        if (daemon?.instanceId === authority.target.daemon.instanceId) {
          toolResources.setTarget({ daemon, workspaceName: authority.workspaceName });
        }
        const applyDaemonShellState = (state: ApplicationShellSessionState) => {
          setDaemonApplicationShellState(state);
          const inventory = state.data?.terminalInventory;
          if (inventory && semanticView) {
            semanticView.setInventory(inventory);
            if (localDescriptorAuthorityGeneration) {
              refreshLocalRuntimeDescriptors(
                sessionName,
                semanticView,
                localDescriptorAuthorityGeneration,
              );
            }
            reconcileAuthoritativeAgents();
            void reconcileSessionRuntimeLane(sessionName, semanticView);
          }
          latestApplicationShellWorkspaceName = authority.workspaceName;
          latestApplicationShellAgents = state.data?.workspace.sidebar.agents ?? [];
          reconcileAuthoritativeAgents();
        };
        applyDaemonShellState(authority.session.getState());
        disposeDaemonApplicationShellSubscription =
          authority.session.subscribe(applyDaemonShellState);
      } catch {
        // Standalone OpenTUI remains a supported fallback when no daemon owns
        // this tmux session. The local semantic projection stays authoritative.
        if (request === daemonApplicationShellRequest) setDaemonApplicationShellState(null);
      }
    };
    onCleanup(() => {
      daemonApplicationShellRequest += 1;
      retireDaemonApplicationShell();
      retireSessionRuntimeLane();
    });
    // The bundled CLI — only the explicit `detect --write` setup action shells
    // out to it (resolved once; `node <cliPath> …`). The CLI forwards its own
    // node-runnable path as TMUX_IDE_CLI; prefer it, because in the COMPILED TUI
    // binary `import.meta.url` is a virtual bunfs path so the relative fallback
    // resolves to a bogus cli.js — the subprocesses would silently fail and the
    // home would ALWAYS look empty. The fallback covers running the app directly
    // via bun (dev, no CLI hop) where import.meta.url is a real on-disk file.
    const cliPath =
      process.env.TMUX_IDE_CLI || new URL("../../../../../../bin/cli.js", import.meta.url).pathname;
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
    let currentWorkspaceUiIdentity: string | null = null;
    let workspaceUiSaveTimer: ReturnType<typeof setTimeout> | null = null;
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
    createEffect(() => {
      if (dockMode() !== "collapsed" && activeDockTab() === "files") void ensureFilesFeature();
    });
    createEffect(() => {
      if (dockMode() !== "collapsed" && activeDockTab() === "changes") void ensureChangesFeature();
    });
    createEffect(() => {
      const dock = activeDockTab();
      if (dockMode() !== "collapsed" && (dock === "missions" || dock === "activity"))
        void ensureMissionsActivityFeature();
    });
    createEffect(() => {
      if (dockMode() === "collapsed") {
        toolResources.setOpenDock(null);
        return;
      }
      const dock = activeDockTab();
      const resource: TuiDockResourceKey = dock === "activity" ? "missions" : dock;
      toolResources.setOpenDock(resource);
    });
    const semanticApplicationShellInput = createMemo<OpenTuiApplicationShellInput>(
      () => ({
        projectName: basename(contextDir() || invokeCwd) || "tmux-ide",
        rootLabel: contextDir() || invokeCwd,
        workspaceName: contextSession() || target || "tmux-ide",
        activeMode: canvasPanel(),
        dockMode: dockMode(),
        activeDockTool: activeDockTab(),
        focusZone:
          workbenchFocusZone() === "canvas"
            ? canvasPanel() === "terminals" && activeTerminalPaneId() !== null
              ? "terminal"
              : "canvas"
            : workbenchFocusZone() === "dock-tabs"
              ? "dock-tabs"
              : "dock-body",
        focusedPaneId: activeTerminalPaneId(),
        terminalInputPaneId:
          canvasPanel() === "terminals" && workbenchFocusZone() === "canvas"
            ? activeTerminalPaneId()
            : null,
        paneIdentities: semanticView?.paneDescriptors() ?? [],
        paletteOpen: paletteOpen(),
        paletteFocusReturnTarget: paletteFocusReturnTarget(),
        sessions: fleet(),
        activeSession: contextSession() || target || "tmux-ide",
        agents: fleetAgents().map((agent) => ({
          paneId: agent.paneId,
          name: agentDisplayKind(agent),
          kind: agent.kind,
          status: agent.state,
        })),
        fileCount: 0,
        changeCount: 0,
        missionTitle: "Workspace missions",
        activityCount: fleetAgents().length,
        notification: status(),
        connectionState: status() === "live" || status() === "home" ? "connected" : "reconnecting",
      }),
      undefined,
      { equals: sameOpenTuiApplicationShellInput },
    );
    const standaloneApplicationShell = createMemo(() =>
      projectOpenTuiApplicationShell(semanticApplicationShellInput()),
    );
    const semanticApplicationShell = createMemo(() => {
      const localInput = semanticApplicationShellInput();
      const authorityInput =
        daemonApplicationShellState()?.data ?? openTuiApplicationShellAuthorityInput(localInput);
      return projectApplicationShellSession(
        authorityInput,
        applicationShellReplayState(standaloneApplicationShell()),
      );
    });
    const applicationShellProjection = createMemo(() =>
      projectApplicationShell({
        width: dims().width,
        height: dims().height,
        preferredSidebarWidth: preferredSidebarW(),
        shell: semanticApplicationShell(),
        hoveredTabIndex: hover()?.region === "surfacetab" ? hover()!.index : null,
        quitHint: QUIT_HINT,
      }),
    );
    const workbenchProjection = createMemo(() =>
      projectWorkbenchShell({
        width: applicationShellProjection().content.width,
        height: applicationShellProjection().content.height,
        dockMode: dockMode(),
        persistedDockHeight: preferredDockHeight(),
        activeDockTab: activeDockTab(),
        focusZone: workbenchFocusZone(),
        hoveredDockTab: hoveredDockTab(),
        attentionDockTabs: new Set(),
        dockTools: semanticApplicationShell().bottomDock.tools,
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
    const surfaceSpans = createMemo(() => applicationShellProjection().tabs.map((tab) => tab.span));
    const [curTarget, setCurTarget] = createSignal(initialContextSession);
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
    const richWidgetCache = new Map<
      string,
      {
        marker: RichPlacementProjection["marker"];
        surface: TuiWidgetSurface;
      }
    >();
    const richWidgetFor = (placement: RichPlacementProjection): TuiWidgetSurface | null => {
      const cached = richWidgetCache.get(placement.renderableId);
      const marker = placement.marker;
      if (cached?.marker === marker) return cached.surface;
      const surface = resolveTuiWidgetSurface(marker, readWidgetAsset);
      if (!surface) {
        richWidgetCache.delete(placement.renderableId);
        return null;
      }
      richWidgetCache.set(placement.renderableId, { marker, surface });
      return surface;
    };
    const richPlacementsFor = (paneId: string): readonly RichPlacementProjection[] => {
      paneRuntimeFor(paneId)?.version;
      const pane = panesById().get(paneId);
      if (!pane || pane.snapshot.scrollOffset > 0) return [];
      return (
        semanticView
          ?.richPlacements(paneId, {
            row: 0,
            column: 0,
            rows: pane.height,
            columns: pane.width,
          })
          .filter((placement) => placement.visible && placement.hostRect !== null) ?? []
      );
    };
    const [windowTabs, setWindowTabs] = createSignal<WindowTab[]>([]);
    // The fleet payload's per-pane entries join directly to tmux's live %pane_id.
    // Drag policy and pane chrome consume this same authority-derived map.
    const agentByPane = createMemo(() => agentsByPane(projectsData()));
    // Pointer-hover feedback. One nullable signal names the hovered target as a
    // {region, index}; the same coordinate math that routes clicks resolves it on
    // motion events, and each hoverable render reads it for a subtle HOVER_BG. It
    // must never thrash: `setHoverIf` no-ops unless region+index actually change.
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

    // ── SELECTION & CLIPBOARD (M19.4; absolute-space M25.6) ──────────────────
    // The visible selection (drives inverse-tint on the semanticView/editor render) and
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
    terminalToolReadiness = new TerminalToolReadinessGate(
      () => {
        toolResources.markTerminalReady();
        optionalFeatures.admit();
      },
      (state) => {
        if (state.phase === "degraded") setStatusNote(`terminal fit degraded: ${state.reason}`);
      },
    );
    let terminalFramePublicationPending = false;
    const acknowledgeTerminalFramePublication = () => {
      toolResources.noteNativeRenderPass();
      if (!terminalFramePublicationPending) return;
      terminalFramePublicationPending = false;
      terminalToolReadiness.observeTerminalFrameCommitted();
    };
    appRenderer.on("frame", acknowledgeTerminalFramePublication);
    onCleanup(() => appRenderer.off("frame", acknowledgeTerminalFramePublication));
    const clearSelection = () => {
      selecting = null;
      dragAutoScroll = null;
      if (selection() !== null) setSelection(null);
    };
    const runActivationEffects = (effects: readonly string[]) => {
      for (const effect of effects) {
        if (effect === "load-files") toolResources.session.refresh("files");
        else if (effect === "catch-up-files") catchUpFilesIfStale();
        else if (effect === "enter-diff") toolResources.session.refresh("changes");
      }
    };
    const activationState = () => ({
      filesLoaded: fileNodes().length > 0,
      diffLoaded: diffLoaded(),
    });
    const runPanelActivation = (panel: HostedPanelKind) => {
      runActivationEffects(hostedActivationEffects(panel, activationState()));
      if (panel === "missions") ensureMissionsLoaded();
    };
    const missionHostedView = () => nativeHostedViewForPanel(hostedViews(), "missions");
    const selectViewForPanel = (viewId: string, panel: HostedPanelKind) => {
      if (panel === "home" || panel === "terminals") {
        activateCanvasPanel(panel);
        return;
      }
      const dockTab = dockTabForPanel(panel);
      if (dockTab) activateDockTab(dockTab);
      else selectView(viewId);
    };
    persistMissionsFeatureState = (state) => {
      if (activePanel() !== "missions") return;
      touchedWorkspaceViewIds.add(missionHostedView().id);
      touchedWorkspaceSurfaceIds.add("missions");
      setWorkspaceUiState((current) => setWorkspaceSurfaceState(current, state));
    };
    persistActivityFeatureState = (state) => {
      touchedWorkspaceSurfaceIds.add("activity");
      setWorkspaceUiState((current) =>
        setWorkspaceSurfaceState(current, { panel: "activity", ...state }),
      );
    };
    const loadMissionsWorkspace = (reason: "activation" | "refresh" | "project") => {
      if (activeDockTab() !== "missions" && activeDockTab() !== "activity" && mode() !== "missions")
        return;
      void ensureMissionsActivityFeature();
      toolResources.session.refresh("missions");
      if (reason === "refresh") setStatusNote("refreshing missions…");
    };
    const ensureMissionsLoaded = () => {
      if (activeDockTab() !== "missions" && activeDockTab() !== "activity" && mode() !== "missions")
        return;
      loadMissionsWorkspace("activation");
    };
    const activateCanvasPanelContent = (panel: "home" | "terminals"): boolean => {
      editorOpenIntent.retire();
      changesPrepareIntent.retire();
      clearSelection();
      snapshotActiveWorkspaceView();
      const view = canvasViewForPanel(hostedViews(), panel);
      setActiveViewId(view.id);
      setCanvasPanel(panel);
      touchedWorkspaceActiveView = true;
      hydrateWorkspaceView(view);
      refreshFocusRecord();
      return true;
    };
    const activateCanvasPanel = (panel: "home" | "terminals"): boolean => {
      activateCanvasPanelContent(panel);
      if (dockMode() === "maximized") setDockMode("open");
      setWorkbenchFocusZone("canvas");
      touchedWorkspaceDock = true;
      return true;
    };
    const selectView = (viewId: string) => {
      const plan = planHostedViewActivation(hostedViews(), viewId, {
        filesLoaded: fileNodes().length > 0,
        diffLoaded: diffLoaded(),
      });
      if (!plan.view || !plan.activeViewId) {
        setStatusNote(plan.note ?? "that view is no longer configured");
        return false;
      }
      const dockAlias = plan.view.layout ? null : dockTabForPanel(plan.view.panel);
      if (dockAlias) return activateDockTab(dockAlias);
      clearSelection();
      snapshotActiveWorkspaceView();
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
    const activateDockTabContent = (tabId: WorkbenchDockTabId): boolean => {
      if (tabId !== "files") editorOpenIntent.retire();
      if (tabId !== "changes") changesPrepareIntent.retire();
      if (tabId === "files") void ensureFilesFeature();
      if (tabId === "activity") {
        // Activity is dock-only, so it does not travel through `selectView` (the
        // hosted-view activation path that normally snapshots the surface being
        // left). Capture it explicitly before the active-tab effect replaces a
        // pending debounced save with Activity's state.
        snapshotActiveWorkspaceView();
        setActiveDockTab("activity");
        loadMissionsWorkspace("activation");
        return true;
      }
      const panel: HostedPanelKind =
        tabId === "files" ? "files" : tabId === "changes" ? "diff" : "missions";
      const view = nativeHostedViewForPanel(hostedViews(), panel);
      snapshotActiveWorkspaceView();
      setActiveDockTab(tabId);
      runPanelActivation(panel);
      hydrateWorkspaceView(view);
      return true;
    };
    const activateDockTab = (tabId: WorkbenchDockTabId): boolean => {
      activateDockTabContent(tabId);
      setDockMode("open");
      setWorkbenchFocusZone("dock-body");
      touchedWorkspaceDock = true;
      return true;
    };
    // Renderer-local navigation is owned independently from canonical daemon
    // snapshots. The bridge keeps the mature signal surface compatible while
    // the controller reconciles only identities that disappeared upstream.
    const localView = new OpenTuiLocalViewController({
      workspaceId: contextSession() || null,
      focusedPaneId: activeTerminalPaneId(),
      surface: canvasPanel(),
      focusZone: workbenchFocusZone(),
      dockMode: dockMode(),
      paletteOpen: paletteOpen(),
    });
    let applyingLocalView = false;
    const disposeLocalViewSubscription = localView.subscribe((next) => {
      applyingLocalView = true;
      try {
        if (next.workspaceId && next.workspaceId !== contextSession()) {
          openWorkspace(next.workspaceId, dirForSession(next.workspaceId));
        }
        if (next.focusedPaneId && next.focusedPaneId !== activeTerminalPaneId()) {
          semanticView?.focus(next.focusedPaneId);
          setFocusedPaneId(next.focusedPaneId);
        }
        if (next.surface === "home" || next.surface === "terminals") {
          if (canvasPanel() !== next.surface || workbenchFocusZone() !== "canvas")
            activateCanvasPanelContent(next.surface);
        } else {
          const dock = next.surface === "changes" ? "changes" : next.surface;
          if (activeDockTab() !== dock) activateDockTabContent(dock);
        }
        if (next.focusZone !== "sidebar" && next.focusZone !== workbenchFocusZone())
          setWorkbenchFocusZone(next.focusZone);
        if (next.dockMode !== dockMode()) setDockMode(next.dockMode);
        if (next.paletteOpen !== paletteOpen()) setPaletteOpen(next.paletteOpen);
      } finally {
        applyingLocalView = false;
      }
    });
    applicationLifecycle.registerCloser("local-view", () => {
      disposeLocalViewSubscription();
      localView.dispose();
    });
    createEffect(() => {
      const surface =
        workbenchFocusZone() === "canvas"
          ? canvasPanel()
          : (activeDockTab() as "files" | "changes" | "missions" | "activity");
      const patch = {
        workspaceId: contextSession() || null,
        focusedPaneId: activeTerminalPaneId(),
        surface,
        focusZone: workbenchFocusZone(),
        dockMode: dockMode(),
        paletteOpen: paletteOpen(),
      } as const;
      if (!applyingLocalView) localView.update(patch);
    });
    createEffect(() => {
      const activeWorkspaceId = contextSession() || null;
      if (!activeWorkspaceId) return;
      localView.reconcile({
        workspaceIds: fleet().map((session) => session.name),
        paneIds: panes().map((pane) => pane.id),
        activeWorkspaceId,
        activePaneId: activeTerminalPaneId(),
      });
    });
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
      let loadStage = "resolve project config";
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
      missionsActivitySession()?.reset(toolResourceGeneration);
      void resolveProjectConfigContext(dir)
        .then((context) => {
          if (!panelGeneration.isCurrent(generation)) return;
          const resolved = context.resolved;
          if (!resolved) return;
          loadStage = "open workspace state";
          const repository = createProjectRuntimeRepository(resolved.resolution);
          const loadedUi = loadWorkspaceUiState(repository);
          if (!workspaceUiController.completeLoad(uiGeneration, repository, loadedUi)) return;
          loadStage = "publish workspace state";
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
          loadStage = "project configured views";
          const nextViews = viewsFromResolvedConfig(resolved);
          const state = {
            filesLoaded: fileNodes().length > 0,
            diffLoaded: diffLoaded(),
          };
          const identityChanged = currentWorkspaceUiIdentity !== repository.metadata.identityKey;
          currentWorkspaceUiIdentity = repository.metadata.identityKey;
          missionsActivitySession()?.setWorkspaceIdentity(missionsActivityIdentity());
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
          loadStage = "publish configured views";
          setHostedViews(nextViews);
          loadStage = "run initial activation";
          runActivationEffects(nextPlan.effects);
          loadStage = "restore active view";
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
          loadStage = "restore dock";
          setActiveDockTab(restoredActiveDockTab);
          setDockMode(explicitDockTab ? "open" : restoredDock.mode);
          setPreferredDockHeight(restoredDock.preferredHeight);
          setWorkbenchFocusZone(explicitDockTab ? "dock-body" : restoredDock.focusZone);
          const activityScope = missionsActivityIdentityScope();
          const activityIntent = activityHydrationIntent.issue(activityScope);
          const hydrateActivity = () => {
            if (
              activityHydrationIntent.isCurrent(activityIntent, missionsActivityIdentityScope())
            ) {
              missionsActivitySession()?.hydrateActivity(loadedUi.state.surfaces.activity);
            }
          };
          if (missionsActivitySession()) hydrateActivity();
          else void ensureMissionsActivityFeature().then(hydrateActivity, () => undefined);
          hydratedWorkspaceSurfaceIds.add("activity");
          loadStage = "hydrate active view";
          hydrateActiveWorkspaceView({ firstProjectLoad });
          const restoredDockPanel = panelForDockTab(restoredActiveDockTab);
          if (restoredDockPanel !== "activity") {
            loadStage = "activate restored dock panel";
            runPanelActivation(restoredDockPanel);
            const restoredDockView = nativeHostedViewForPanel(nextViews, restoredDockPanel);
            if (restoredDockView.id !== nextPlan.view?.id) {
              loadStage = "hydrate restored dock panel";
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
          setStatusNote(`config views unavailable (${loadStage}): ${(error as Error).message}`);
        });
    };
    trackPanelHostDirectory(() => contextDir() || invokeCwd, loadPanelHostForDir);

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
      if (submitSemanticPaneFocus(paneId) !== "submitted") return;
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
    // semanticView's SYNCHRONOUS focus agrees the pane lost focus (semanticView.focus sets
    // it before the tick re-derives `active`). Window/session switches drop the
    // pane from panes() and move both focus answers — the mode clears then too.
    createEffect(() => {
      const sm = selectModePane();
      if (sm === null) return;
      const focused = activeTerminalPaneId();
      if (focused && focused !== sm && semanticView?.focusedPane() !== sm) exitSelectMode();
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
        agentByPane().get(runtimePaneIdForSemantic(paneId)),
        dragSelectPolicy,
        dragOverrides.get(paneId) ?? null,
      );
    /** Drop overrides for panes that no longer exist anywhere on the server
     *  (pane ids are server-global and never recycled, so a miss is a death,
     *  not a window switch). Piggybacks on the 3s fleet tick; one control-mode
     *  round-trip, only while overrides exist at all. */
    const pruneDragOverrides = () => {
      if (dragOverrides.size === 0 || !semanticView) return;
      const alive = new Set(
        semanticView.paneDescriptors().map(({ runtimePaneId }) => runtimePaneId),
      );
      for (const id of [...dragOverrides.keys()]) if (!alive.has(id)) dragOverrides.delete(id);
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
      matches: Array<SearchMatch & { columns?: number }>;
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
    const interactionPaneLabel = (semanticPaneId: string): string => {
      const descriptor = semanticView
        ?.paneDescriptors()
        .find((candidate) => candidate.semanticPaneId === semanticPaneId);
      if (!descriptor) return semanticPaneId;
      const agent = agentByPane().get(descriptor.runtimePaneId);
      return (
        agent?.displayName ??
        agent?.kind ??
        descriptor.title ??
        descriptor.currentCommand ??
        semanticPaneId
      );
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
        const agent = agentByPane().get(runtimePaneIdForSemantic(pane.id));
        const semanticPaneId = semanticView
          ?.paneDescriptors()
          .find((descriptor) => descriptor.runtimePaneId === pane.id)?.semanticPaneId;
        const interaction = semanticPaneId ? interactionFeed().panes[semanticPaneId] : undefined;
        const visibleInteraction =
          interaction && activeInteractionSequences().has(interaction.sequence)
            ? interaction
            : undefined;
        const interactionPresence = visibleInteraction
          ? paneInteractionPresence(visibleInteraction)
          : null;
        const attentionKind =
          visibleInteraction?.phase === "rejected" || visibleInteraction?.phase === "timed-out"
            ? "warning"
            : agent?.state === "blocked" || (!agent && appStatusTone === "blocked")
              ? "requested"
              : "none";
        metadata.set(pane.id, {
          // SemanticSessionView may add title/currentCommand descriptors later. Null
          // deliberately leaves that seam to the pure projection, which falls
          // back to the always-distinct live %pane_id today.
          title: agent?.displayName ?? agent?.kind ?? null,
          subtitle: agent
            ? `${agent.displayName ? `${agent.kind} · ` : ""}${curTarget()} · ${pane.id}`
            : `${curTarget()} · ${pane.id}`,
          status: interactionPresence
            ? interactionPresence.badge
            : (agent?.statusText ?? agent?.state ?? appStatus),
          statusTone: interactionPresence
            ? interactionPresence.tone === "danger"
              ? "blocked"
              : interactionPresence.tone === "info"
                ? "working"
                : "done"
            : (agent?.state ?? appStatusTone),
          attention:
            visibleInteraction?.phase === "rejected" ||
            visibleInteraction?.phase === "timed-out" ||
            agent?.state === "blocked" ||
            (!agent && appStatusTone === "blocked"),
          attentionKind,
          chromeState: projectPaneChromeState({
            keyboardFocused: paneIsFocused(pane.id),
            inputOwned: sessionRuntimeLane()?.ownsInput === true,
            attention: attentionKind,
            interaction: visibleInteraction ?? null,
            paneLabel: interactionPaneLabel,
          }),
          communication:
            visibleInteraction && interactionPresence
              ? {
                  role: interactionPresence.role,
                  label: paneInteractionRelationshipLabel(visibleInteraction, interactionPaneLabel),
                }
              : null,
        });
      }
      return metadata;
    });
    const terminalPaneChromeLayout = createMemo(() =>
      projectTerminalPaneChrome({
        canvas: terminalCanvasProjection(),
        panes: focusedPanes(),
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
    // (emits absolute resize intents through the shared daemon authority). Only ONE of
    // {selecting, dragging} is ever live — selection starts only from an IN-pane
    // down, a border drag only from a GUTTER down, so they never fight. Border
    // deltas stay in SCREEN space after the projected framebuffer has resolved
    // the press; this keeps pointer capture stable while tmux reflows underneath.
    // `lastSize` dedupes identical resize intents across drag ticks.
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
      | { kind: "border"; sep: Separator; originPointer: number; lastSize: number }
      | {
          kind: "scrollbar";
          grabOffset: number;
          top0: number;
          contentLen: number;
          viewH: number;
          surface: ScrollSurface;
        };
    let dragging: DragState | null = null;
    const [hoveredPaneSeparator, setHoveredPaneSeparator] = createSignal<Separator | null>(null, {
      equals: (a, b) =>
        a === b ||
        (a !== null &&
          b !== null &&
          a.axis === b.axis &&
          a.position === b.position &&
          a.start === b.start &&
          a.end === b.end &&
          a.aId === b.aId &&
          a.bId === b.bId),
    });
    const [activePaneResize, setActivePaneResize] = createSignal<{
      sep: Separator;
      delta: number;
    } | null>(null);
    const [resizeTransactionState, setResizeTransactionState] =
      createSignal<ResizeTransactionState>({
        phase: "idle",
        canonicalCells: null,
        outcome: null,
      });
    let acceptedResize: ResizeTransactionObservation | null = null;
    const resizeTransaction = new ResizeTransactionController({
      timeoutMs: 10_000,
      operationId: randomUUID,
      now: () => performance.now(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      },
      submit: ({ operationId, intent }) => {
        const lane = sessionRuntimeLane();
        const adapter = terminalWorkspaceAdapter;
        if (!lane?.ownsGeometry || lane.workspaceName !== intent.workspaceName || !adapter) {
          throw new Error("No semantic geometry authority is available");
        }
        const submission = adapter.submit(intent, operationId);
        if (!submission) throw new Error("No semantic geometry authority is available");
        void submission.then(
          (result) => {
            if (result?.verb !== "workspace.pane.resize") {
              resizeTransaction.reject({
                operationId,
                code: "invalid-result",
                message: "Daemon returned no observed pane size",
              });
              return;
            }
            acceptedResize = {
              operationId,
              workspaceName: intent.workspaceName,
              semanticPaneId: intent.semanticPaneId,
              axis: intent.axis,
              cells: result.cells,
            };
            observePendingResizeLayout();
          },
          (error: unknown) => {
            resizeTransaction.reject({
              operationId,
              code:
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : "submit-failed",
              message: error instanceof Error ? error.message : String(error),
            });
          },
        );
      },
      onState: (state) => {
        if (state.phase === "idle") acceptedResize = null;
        setResizeTransactionState(state);
        if (state.phase === "dragging" || state.phase === "pending") {
          const active = activePaneResize();
          if (active) {
            setActivePaneResize({
              sep: active.sep,
              delta: state.previewCells - state.canonicalCells,
            });
          }
          if (state.phase === "pending") setStatusNote("applying pane resize…");
          return;
        }
        setActivePaneResize(null);
        const outcome = state.outcome;
        if (outcome?.kind === "settled") {
          setStatusNote(`pane resized to ${outcome.cells} cells`);
        } else if (outcome?.kind === "reverted") {
          setStatusNote(
            outcome.reason.kind === "timed-out" ? "pane resize timed out" : outcome.reason.message,
          );
        }
      },
    });
    observePendingResizeLayout = () => {
      const state = resizeTransaction.state();
      const accepted = acceptedResize;
      if (state.phase !== "pending" || !accepted || accepted.operationId !== state.operationId)
        return;
      const size = semanticPaneCanonicalSize.get(accepted.semanticPaneId);
      if (!size) return;
      const observedCells = accepted.axis === "cols" ? size.cols : size.rows;
      if (observedCells !== accepted.cells) return;
      resizeTransaction.observeLayout({ ...accepted, cells: observedCells });
    };
    onCleanup(() => resizeTransaction.dispose());
    const paneResizeGuide = createMemo(() => {
      const active = activePaneResize();
      const sep = active?.sep ?? hoveredPaneSeparator();
      if (!sep) return null;
      return {
        rect: resizeGuideRect(sep, active?.delta ?? 0),
        active: active !== null,
      };
    });

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
    const moveActivitySelection = (delta: -1 | 1) =>
      missionsActivitySession()?.handleActivityKey({
        name: delta > 0 ? "down" : "up",
        ctrl: false,
        meta: false,
        shift: false,
      });

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
    let paneFrameCoalescer: FrameCoalescer | null = null;
    const markDirty = () => {
      dirty = true;
      paneFrameCoalescer?.request();
    };
    // The framebuffer surfaces react directly to this identity change; the
    // fallback StyledRun path needs one fresh snapshot as well. Source xterm
    // buffers stay untouched in both cases.
    createEffect(() => {
      terminalPalette();
      markDirty();
    });

    // Files owns its editor/tree/IO authority inside the deferred feature
    // session. These stable adapters keep global routing and persistence thin.
    const editorPath = () => filesSession()?.editorPath() ?? null;
    const editorRev = () => filesSession()?.editorRevision() ?? 0;
    const editorTop = () => filesSession()?.editorTop() ?? 0;
    const editorModified = () => filesSession()?.editorModified() ?? false;
    const editorReadOnly = (): ReadOnlyReason => filesSession()?.editorReadOnly() ?? null;
    const editorLines = () => filesSession()?.editorLines() ?? [""];
    const editorRows = () => filesSession()?.editorRows() ?? Math.max(1, dockSurfaceHeight() - 3);
    const editorCursor = () => filesSession()?.editorCursor() ?? { row: 0, col: 0 };
    const setEditorTop = (value: number | ((current: number) => number)) =>
      filesSession()?.setEditorTop(value);
    const openEditor = (
      rawPath: string,
      line?: number,
      origin: EditorOpenOrigin = "user",
      intent = editorOpenIntent.issue(editorOpenScope()),
    ) => {
      if (!editorOpenIntent.isCurrent(intent, editorOpenScope())) return;
      const feature = filesFeature();
      if (!feature) {
        void ensureFilesFeature().then(
          (loaded) => {
            if (loaded && editorOpenIntent.isCurrent(intent, editorOpenScope())) {
              openEditor(rawPath, line, origin, intent);
            }
          },
          () => undefined,
        );
        return;
      }
      filesSession()?.openEditor(rawPath, line, origin);
    };
    const toggleEditor = () => filesSession()?.toggleEditor();
    const saveEditor = () => filesSession()?.save();
    const editorKey = (event: { name: string; ctrl: boolean; meta: boolean; shift: boolean }) =>
      filesSession()?.key(event);

    // Changes owns its model, selected-file reads, mutations, and interaction
    // math inside the deferred feature. These accessors are the complete eager
    // shell contract and remain inert until explicit Changes demand resolves.
    const changesSurfaceProjection = () => changesSession()?.projection() ?? null;
    const diffLoaded = () => changesSession()?.hasEntries() ?? false;
    const diffSelectedPath = () => changesSession()?.selectedPath() ?? null;
    const diffFilterOpen = () => changesSession()?.filterOpen() ?? false;
    const setChangesHoverTarget = (target: ChangesHoverTarget | null) => {
      if (target?.kind === "header-action") setHoverIf({ region: "button", index: target.index });
      else if (target?.kind === "footer-action")
        setHoverIf({ region: "diffverb", index: target.index });
      else if (target?.kind === "list-row") setHoverIf({ region: "diff", index: target.index });
      else setHoverIf(null);
    };
    const prepareDiff = (directory: string) => {
      const identity = { workspaceName: contextSession() || target, directory };
      const scope = changesIdentityKey(identity);
      const intent = changesPrepareIntent.issue(scope);
      const session = changesSession();
      if (session) session.prepare(identity);
      else {
        void ensureChangesFeature().then(
          (feature) => {
            if (feature && changesPrepareIntent.isCurrent(intent, scope)) {
              changesSession()?.prepare(identity);
            }
          },
          () => undefined,
        );
      }
    };
    const enterDiff = (directory: string) => {
      prepareDiff(directory);
      setTab("diff");
    };

    // ── EVENT-DRIVEN RE-PIN (M23.5) ──────────────────────────────────────────
    // The native Workbench projection is the sole pin source. `lastPin` remains
    // null until a non-zero framebuffer exists; a hidden/maximized dock never
    // shrinks the real tmux window to a destructive synthetic 1x1 size.
    let lastPin: Size | null = terminalCanvasProjection().tmuxSize;
    let repinInFlight: RepinState | null = null;
    let pendingAttachTarget: string | null = null;
    let mirrorSupervisor: RuntimeConnectionSupervisor<SemanticSessionView> | null = null;
    let tuiGeometryReadyMarked = false;
    const attach = (name: string) => {
      const pin = terminalCanvasProjection().tmuxSize ?? lastPin;
      if (!pin) {
        pendingAttachTarget = name;
        setStatus(`waiting for terminal canvas to attach ${name}…`);
        return;
      }
      pendingAttachTarget = null;
      const previousSupervisor = mirrorSupervisor;
      mirrorSupervisor = null;
      retireSessionRuntimeLane();
      semanticView = null;
      void previousSupervisor?.stop();
      terminalWorkspaceAdapter?.dispose();
      terminalWorkspaceAdapter = null;
      scrollOffsets.clear();
      richWidgetCache.clear();
      setFocusedPaneId(null);
      setPanes([]);
      setStatus(`attaching ${name}…`);
      void connectDaemonApplicationShell(name);
      // A fresh semanticView pins at the current canvas size — no re-pin in flight.
      lastPin = pin;
      repinInFlight = null;
      const workspaceAdapter = new OpenTuiTerminalWorkspaceAdapter({
        target: name,
        lifecycle: applicationLifecycle,
        onDirty: markDirty,
        onFocusChanged: (paneId) => setFocusedPaneId(paneId),
        onStatus: () => {
          if (!tuiGeometryReadyMarked) {
            tuiGeometryReadyMarked = true;
            tuiPerfMark("tmux-geometry-ready");
          }
          markDirty();
          void workspaceAdapter.view.windows().then(setWindowTabs);
          void reconcileSessionRuntimeLane(name, workspaceAdapter.view);
        },
      });
      terminalWorkspaceAdapter = workspaceAdapter;
      const supervisor = createRuntimeConnectionSupervisor<SemanticSessionView>({
        connect: async ({ signal }): Promise<RuntimeConnection<SemanticSessionView>> => {
          const reconnectPin = terminalCanvasProjection().tmuxSize ?? lastPin ?? pin;
          lastPin = reconnectPin;
          let close!: (reason: unknown) => void;
          const closed = new Promise<unknown>((resolve) => {
            close = resolve;
          });
          const candidate = workspaceAdapter.view;
          let retired = false;
          const dispose = () => {
            if (retired) return;
            retired = true;
            signal.removeEventListener("abort", dispose);
          };
          signal.addEventListener("abort", dispose, { once: true });
          try {
            await candidate.start();
            return { value: candidate, closed, dispose };
          } catch (error) {
            dispose();
            throw error;
          }
        },
      });
      mirrorSupervisor = supervisor;
      supervisor.subscribe((state) => {
        if (mirrorSupervisor !== supervisor) return;
        if (state.phase === "live" && state.value) {
          semanticView = state.value;
          const inventory = daemonApplicationShellState()?.data?.terminalInventory;
          if (inventory) {
            semanticView.setInventory(inventory);
            if (localDescriptorAuthorityGeneration) {
              refreshLocalRuntimeDescriptors(
                name,
                semanticView,
                localDescriptorAuthorityGeneration,
              );
            }
            reconcileAuthoritativeAgents();
          }
          setStatus("live");
          void state.value.windows().then(setWindowTabs);
          void reconcileSessionRuntimeLane(name, state.value);
          markDirty();
        } else if (state.phase === "reconnecting") {
          retireSessionRuntimeLane();
          semanticView = null;
          setStatus(`reconnecting ${name} (attempt ${state.attempt})…`);
        } else if (state.phase === "failed") {
          retireSessionRuntimeLane();
          semanticView = null;
          setStatus("tmux connection failed");
        }
      });
      supervisor.start();
    };
    createEffect(() => {
      const next = terminalCanvasProjection().tmuxSize;
      const runtimeLane = sessionRuntimeLane();
      // A maximized layout can hide the framebuffer entirely. Keep the live
      // tmux window at its last visible size until the canvas returns.
      if (!next) return;
      if (pendingAttachTarget && !semanticView) {
        const targetName = pendingAttachTarget;
        lastPin = next;
        attach(targetName);
        return;
      }
      const fitKey = runtimeLane
        ? `${runtimeLane.connectionIdentity}:${next.cols}x${next.rows}`
        : null;
      if (
        lastPin &&
        next.cols === lastPin.cols &&
        next.rows === lastPin.rows &&
        (!runtimeLane || runtimeLaneFitKey === fitKey)
      )
        return;
      if (lastPin) repinInFlight = { prev: lastPin, at: performance.now() };
      lastPin = next;
      if (runtimeLane?.ownsGeometry && fitKey) {
        const fit = terminalWorkspaceAdapter?.fitViewport(next.cols, next.rows);
        if (!fit) return;
        void fit.then(
          () => {
            if (sessionRuntimeLane() === runtimeLane) {
              runtimeLaneFitKey = fitKey;
              terminalToolReadiness.observeFitSuccess();
            }
          },
          (error: unknown) => {
            if (sessionRuntimeLane() === runtimeLane) {
              runtimeLaneFitKey = null;
              terminalToolReadiness.observeFitFailure(
                error instanceof Error ? error.message : "viewport fit rejected",
              );
            }
          },
        );
      }
    });
    /** Re-query the mirrored session's windows into `windowTabs` — used after a
     *  NON-structural change tmux won't notify us about (a `synchronize-panes`
     *  toggle) so the `[SYNC]` chip and the menu checkbox reflect it promptly. */
    const refreshWindows = () => void semanticView?.windows().then(setWindowTabs);
    /** The active window's `synchronize-panes` state (the toggle's live value). */
    const syncOn = () => windowTabs().find((w) => w.active)?.sync ?? false;

    /** Switch the Terminal tab's target. CRITICAL for the IDE feel: attaching the
     *  SAME session we're already mirroring must NOT re-create the control client
     *  — that would drop scrollback and blink the pane. So a same-target switch is
     *  a pure tab flip; only a DIFFERENT session (re)attaches. */
    const switchTarget = (name: string) => {
      clearSelection();
      if (name === curTarget() && semanticView) {
        selectPanel("terminals");
        refreshFocusRecord();
        return;
      }
      setCurTarget(name);
      selectPanel("terminals");
      attach(name);
      refreshFocusRecord();
    };
    /** ^g / F1 — show the HOME tab. The semanticView is KEPT ALIVE (it keeps streaming
     *  in the background so a back-switch is instant); the session is untouched. */
    const goHome = () => {
      clearSelection();
      setTab("home");
      refreshFocusRecord();
    };

    // Deferred FilesFeatureSession is the sole Files state/IO/projection owner.
    // Root keeps only stable adapters needed by global routing and persistence.
    const workspaceDir = () => contextDir() || invokeCwd;
    const fileNodes = () => filesSession()?.fileNodes() ?? [];
    const fileSel = () => filesSession()?.fileSelection() ?? 0;
    const fileTop = () => filesSession()?.fileTop() ?? 0;
    const visibleFiles = () => filesSession()?.visibleFiles() ?? [];
    const filesQuery = () => filesSession()?.query() ?? null;
    const filesFocus = () => filesSession()?.focus() ?? "list";
    const showHiddenFiles = () => filesSession()?.showHidden() ?? persisted.filesShowHidden;
    const showIgnoredFiles = () => filesSession()?.showIgnored() ?? persisted.filesShowIgnored;
    const setFileSel = (value: number | ((current: number) => number)) =>
      filesSession()?.setFileSelection(value);
    const setFileTop = (value: number | ((current: number) => number)) =>
      filesSession()?.setFileTop(value);
    const setFilesQuery = (value: string | null) => filesSession()?.setQuery(value);
    const setFilesFocus = (value: "list" | "editor") => filesSession()?.setFocus(value);
    const filesListW = () => filesSession()?.listWidth() ?? 0;
    const filesSurfaceProjection = (): FilesSurfaceProjection | null =>
      filesSession()?.projection() ?? null;
    const listDir = (dir: string) => filesSession()?.listDir(dir) ?? Promise.resolve([]);
    const moveFileSel = (delta: number) => filesSession()?.moveSelection(delta);
    const activateFile = (index: number) => filesSession()?.activate(index);
    const revealPath = (path: string) => filesSession()?.reveal(path) ?? Promise.resolve();
    const hopChanged = (direction: 1 | -1) => filesSession()?.hopChanged(direction);
    const toggleHiddenFiles = () => filesSession()?.toggleHidden();
    const toggleIgnoredFiles = () => filesSession()?.toggleIgnored();

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
          selectedPath: diffSelectedPath(),
        });
      } else if (activeDockTab() === "missions" && hydratedWorkspaceSurfaceIds.has("missions")) {
        const state = missionsActivitySession()?.missionsState();
        if (state) next = setWorkspaceSurfaceState(next, state);
      } else if (activeDockTab() === "activity" && hydratedWorkspaceSurfaceIds.has("activity")) {
        const state = missionsActivitySession()?.activityState();
        if (state) next = setWorkspaceSurfaceState(next, { panel: "activity", ...state });
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
        const session = filesSession();
        if (session) session.pendingSelectionPath = selectedPath;
        else pendingFilesSelectionPath = selectedPath;
        if (fileNodes().length > 0 && selectedPath) {
          if (session) session.pendingSelectionPath = null;
          void revealPath(selectedPath);
        }
        const openPath = absoluteProjectPath(root, entry.openPath);
        if (openPath) openEditor(openPath, undefined, "workspace-hydration");
      } else if (entry.panel === "diff") {
        hydratedWorkspaceSurfaceIds.add("diff");
        if (changesSession()) changesSession()?.restoreSelectedPath(entry.selectedPath);
        else {
          const scope = changesIdentityScope();
          const intent = changesHydrationIntent.issue(scope);
          void ensureChangesFeature().then(
            (feature) => {
              if (feature && changesHydrationIntent.isCurrent(intent, changesIdentityScope())) {
                changesSession()?.restoreSelectedPath(entry.selectedPath);
              }
            },
            () => undefined,
          );
        }
        if (mode() === "diff") toolResources.session.refresh("changes");
      } else if (entry.panel === "missions") {
        hydratedWorkspaceSurfaceIds.add("missions");
        const scope = missionsActivityIdentityScope();
        const intent = missionsHydrationIntent.issue(scope);
        const hydrate = () => {
          if (missionsHydrationIntent.isCurrent(intent, missionsActivityIdentityScope())) {
            missionsActivitySession()?.hydrateMissions(entry);
          }
        };
        if (missionsActivitySession()) hydrate();
        else void ensureMissionsActivityFeature().then(hydrate, () => undefined);
      }
    };
    hydrateActiveWorkspaceView = (options = {}) => hydrateWorkspaceView(activeView(), options);
    const execFileChecked = (file: string, args: string[]): Promise<string> =>
      new Promise((resolvePromise, rejectPromise) => {
        execFile(file, args, (error, stdout) => {
          if (error) rejectPromise(error);
          else resolvePromise(stdout);
        });
      });
    executeMissionDeepLinkIntent = (intent) => {
      if (intent.kind === "terminal") {
        void execFileChecked("tmux", ["has-session", "-t", `=${intent.session}`])
          .then(async () => {
            if (intent.paneId) {
              const output = await execFileChecked("tmux", [
                "display-message",
                "-p",
                "-t",
                intent.paneId,
                "#{session_name}\t#{pane_id}",
              ]);
              if (output.trimEnd() !== `${intent.session}\t${intent.paneId}`) {
                throw new Error("pane does not belong to target session");
              }
            }
          })
          .then(() => {
            snapshotActiveWorkspaceView();
            setCurTarget(intent.session);
            selectViewForPanel(intent.viewId, "terminals");
            if (intent.paneId)
              pendingSemanticFocus = { session: intent.session, paneId: intent.paneId };
            attach(intent.session);
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
      return missionsActivitySession()?.handleMissionKey(evt) ?? false;
    };
    const missionHitAt = (x: number, y: number) => {
      const gy = y - TABBAR_H;
      return missionsActivitySession()?.missionHoverAt(x - sidebarW(), gy) ?? null;
    };

    // The daemon owns filesystem/git observation. Returning to Files asks the
    // generation-pinned resource session for a fresh snapshot; no local watcher
    // or maintenance poll exists in the renderer.
    const catchUpFilesIfStale = () => {
      toolResources.session.refresh("files");
    };

    /** The project dir the fleet payload records for `session` (null if unknown). */
    const dirForSession = (name: string): string | null => {
      for (const p of projectsData()) if (p.sessions.some((s) => s.name === name)) return p.dir;
      return null;
    };

    /** Adopt a session as the workspace context: point the terminal target, the
     *  file list, and the diff panel at it, then show the Terminal tab. The dir is
     *  the project dir from the fleet payload (falling back to the cwd). */
    const openWorkspace = (session: string, dir: string | null) => {
      editorOpenIntent.retire();
      changesPrepareIntent.retire();
      changesHydrationIntent.retire();
      missionsHydrationIntent.retire();
      activityHydrationIntent.retire();
      setContextSession(session);
      const wd = dir ?? invokeCwd;
      setContextDir(wd);
      changesSession()?.setWorkspaceIdentity({ workspaceName: session, directory: wd });
      missionsActivitySession()?.setWorkspaceIdentity({
        workspaceName: session,
        directory: wd,
        projectRoot: wd,
        identityKey: `${session}\u0000${wd}`,
      });
      toolResources.session.refresh("files");
      switchTarget(session);
    };

    /** Jump to a fleet agent after the target session's semantic lane is live. */
    const jumpToAgent = (a: Pick<AgentRowInput, "session" | "windowIndex" | "paneId">) => {
      pendingSemanticFocus = { session: a.session, paneId: a.paneId };
      openWorkspace(a.session, dirForSession(a.session));
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
        toolResources.session.refresh("fleet");
        openWorkspace(name, dir);
      });
    };

    // ── AGENT LIFECYCLE (M23.1) — spawn / restart / stop / close ────────────
    // The verbs go to tmux DIRECTLY (async execFile — the render-loop law, and
    // the target agent may live in a session the semanticView isn't attached to).
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
      toolResources.session.refresh("fleet");
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
        toolResources.session.refresh("fleet");
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
      toolResources.session.refresh("fleet");
    };

    /** The destructive twin of stop: kill the agent's pane. Confirmation is the
     *  caller's job (the menu's armed "confirm: y" state). The pane's options
     *  die with it, so no authority cleanup is needed. */
    const closeAgentPane = (a: Pick<AgentRowInput, "paneId" | "kind">) => {
      execFile("tmux", ["kill-pane", "-t", a.paneId], () => toolResources.session.refresh("fleet"));
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

      // Registered workspace + built-in harness + new window is now the same
      // semantic, daemon-owned mutation used by the GUI. A live daemon failure
      // fails closed in the executor, so we cannot duplicate an ambiguously
      // completed creation by falling through to raw tmux.
      const sharedCreation = await executeTuiAgentProvisioning({
        sessionName: ctx.session ?? null,
        kind,
        command,
        displayTitle: label,
        placement,
        targetSemanticPaneId:
          ctx.paneId === undefined
            ? null
            : (semanticView
                ?.paneDescriptors()
                .find((descriptor) => descriptor.runtimePaneId === ctx.paneId)?.semanticPaneId ??
              null),
      });
      if (sharedCreation.status === "daemon") {
        setStatusNote(sharedCreation.message);
        watchCreatedSession(ctx.session!);
        toolResources.session.refresh("fleet");
        return;
      }
      if (sharedCreation.status === "error") {
        setStatusNote(sharedCreation.message);
        toolResources.session.refresh("fleet");
        return;
      }

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
          toolResources.session.refresh("fleet");
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
        toolResources.session.refresh("fleet");
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
        items: newAgentItems({
          manifests,
          last,
          againPlacement,
          customRecents: customCommands(),
        }),
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
          paneId: semanticView?.focusedPane() ?? undefined,
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
      const { resolveProjectConfigContext } = await import("../../../lib/config-context.ts");
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
        toolResources.session.refresh("fleet");
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
      const feature = filesFeature() ?? (await ensureFilesFeature().catch(() => undefined));
      if (!feature) return [];
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
              const rel = feature.relPath(root, abs);
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
          panes: panes().map((pane) => {
            const descriptor = semanticView
              ?.paneDescriptors()
              .find(({ runtimePaneId }) => runtimePaneId === pane.id);
            return {
              paneId: pane.id,
              session: contextSession(),
              active: paneIsFocused(pane.id),
              title: descriptor?.title ?? descriptor?.role ?? descriptor?.currentCommand ?? pane.id,
            };
          }),
          sizeMismatch: windowMismatch() !== null,
          appMousePane: panes().find((p) => paneIsFocused(p.id))?.appMouse === true,
          // Pins "New agent: <name> (again)" FIRST when this context has spawn
          // memory (M24.1) — F5 → Enter repeats the last spawn.
          againName: currentAgainName(),
          usage: paletteUsage(),
          keycaps: PALETTE_ROW_KEYCAPS,
          views: hostedViews(),
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
        currentSurface: workbenchFocusZone() === "canvas" ? canvasPanel() : activeDockTab(),
        currentTab: tab(),
        currentViewId: activeViewId(),
        currentSession: contextSession(),
        syncOn: syncOn(),
        saveState: {
          hasBuffer: filesSession()?.hasBuffer ?? false,
          hasPath: Boolean(editorPath()),
          readOnlyReason: editorReadOnly(),
        },
        multiplexerFacts: {
          workspaceConnected: mode() === "mirror" && semanticView !== null,
          sessionWindowCount: windowTabs().length,
          windowPaneCount: panes().length,
          windowZoomed: panes().some((pane) => pane.zoomed),
          targetIsActivePane: true,
          targetIsDockedStackMember: false,
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
        title: "Navigator",
        queryPlaceholder: "Search · @workspaces @agents @panes @commands",
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
    const lifecycleExecutor = createApplicationLifecycleInputExecutor(applicationLifecycle, {
      // Renderer destruction disposes the Solid root first, so the shared
      // onCleanup path owns mirrors/buffers and the host-mode guard restores
      // DECAWM after OpenTUI's native terminal teardown.
      // HOSTED (M23.2): put the cockpit away and keep running. A client that
      // came here via switch-client bounces BACK to its last session; a plain
      // terminal attach has no last session, so switch-client -l fails and the
      // fallback detaches.
      switchClientBack: (callback) => execFile("tmux", ["switch-client", "-l"], callback),
      detachClient: () => execFile("tmux", ["detach-client"], () => {}),
    });
    const rendererCommandExecutor = createRendererCommandExecutor({
      context: () => ({
        // Ctrl-Tab now walks the native workbench's semantic focus ring. The
        // command name remains wire-compatible with the earlier composite host.
        compositeFocusAvailable: true,
        editorAvailable:
          (filesSession()?.hasBuffer ?? false) ||
          (mode() === "diff" && (changesSession()?.hasSelection() ?? false)),
      }),
      effects: {
        openPalette,
        runLifecycle: (command) => lifecycleExecutor.run(command),
        cycleCompositeFocus: () => {
          setWorkbenchFocusZone(
            cycleWorkbenchFocusZone(
              workbenchProjection().focusZone,
              workbenchProjection().dockMode,
            ),
          );
          touchedWorkspaceDock = true;
        },
        activateShortcut: (key) => {
          const view = canvasHostedViews().find((candidate) => candidate.shortcut?.key === key);
          if (view) selectView(view.id);
        },
        activateView: (viewId) => selectView(viewId),
        activateCanvas: (panel) => activateCanvasPanelContent(panel),
        activateDock: (tabId) => activateDockTabContent(tabId),
        openHome: () => {
          if (mode() !== "home") goHome();
        },
        toggleEditor: () => {
          if (mode() === "diff")
            changesSession()?.handleKey(
              { name: "e", ctrl: true, meta: false, shift: false },
              "surface",
            );
          else toggleEditor();
        },
      },
    });
    const executeRendererCommand = rendererCommandExecutor.execute;
    const sendSemanticTerminalText = (runtimePaneId: string, text: string): boolean => {
      const replica = semanticReplicaForRuntime(runtimePaneId);
      if (text.length === 0) return false;
      if (!replica) {
        if (!semanticView) return false;
        setStatusNote("terminal runtime is reconnecting");
        return true;
      }
      if (!replica.lane.ownsInput) {
        setStatusNote("view only · another client owns terminal input");
        return true;
      }
      return replica.adapter.sendText(replica.semanticPaneId, text);
    };
    const sendSemanticTerminalKey = (runtimePaneId: string, key: string): boolean => {
      const replica = semanticReplicaForRuntime(runtimePaneId);
      if (!replica) {
        if (!semanticView) return false;
        setStatusNote("terminal runtime is reconnecting");
        return true;
      }
      if (!replica.lane.ownsInput) {
        setStatusNote("view only · another client owns terminal input");
        return true;
      }
      return replica.adapter.sendKey(replica.semanticPaneId, key);
    };
    const semanticViewportAcknowledged = (): boolean => {
      const lane = sessionRuntimeLane();
      const size = terminalCanvasProjection().tmuxSize;
      return Boolean(
        lane?.ownsInput &&
        size &&
        runtimeLaneFitKey === `${lane.connectionIdentity}:${size.cols}x${size.rows}`,
      );
    };
    const submitSemanticPaneFocus = (
      runtimePaneId: string,
    ): "submitted" | "passive" | "unavailable" => {
      const replica = semanticReplicaForRuntime(runtimePaneId);
      if (!replica) {
        setStatusNote("terminal runtime is reconnecting");
        return "unavailable";
      }
      if (!replica.lane.ownsInput) {
        setStatusNote("view only · another client owns terminal input");
        return "passive";
      }
      // Optimistic local chrome is renderer state only; the daemon remains the
      // sole tmux mutation authority and the following layout reconciles it.
      setFocusedPaneId(runtimePaneId);
      void replica.adapter
        .submit({
          verb: "workspace.pane.select",
          workspaceName: replica.lane.workspaceName,
          semanticPaneId: replica.semanticPaneId,
        })!
        .catch((error: unknown) => {
          setFocusedPaneId(semanticView?.focusedPane() || null);
          setStatusNote(error instanceof Error ? error.message : "pane focus rejected");
        });
      return "submitted";
    };
    const activateSemanticWindow = (windowIndex: number): boolean => {
      const key = semanticWindowOrder[windowIndex];
      const semanticPaneId = key ? semanticWindowActivePane.get(key) : undefined;
      if (!semanticPaneId) {
        setStatusNote("window is not yet available in the semantic runtime");
        return false;
      }
      return submitSemanticPaneFocus(semanticPaneId) === "submitted";
    };
    const applyApplicationShellFocus = (target: SemanticFocusTarget) => {
      if (target.kind === "dock-tool") {
        setActiveDockTab(target.tool);
        setWorkbenchFocusZone("dock-tabs");
      } else if (target.kind === "zone") {
        if (target.zone === "dock-tabs") setWorkbenchFocusZone("dock-tabs");
        else if (target.zone === "dock-body") setWorkbenchFocusZone("dock-body");
        else setWorkbenchFocusZone("canvas");
      } else if (target.kind === "pane") {
        setWorkbenchFocusZone("canvas");
        const runtimePaneId = openTuiRuntimePaneId(
          target.paneId,
          panes().map((pane) => pane.id),
          semanticView?.paneDescriptors() ?? [],
        );
        if (runtimePaneId) submitSemanticPaneFocus(runtimePaneId);
      } else if (target.zone === "dock-tabs") {
        setWorkbenchFocusZone("dock-tabs");
      } else if (target.zone === "dock-body") {
        setWorkbenchFocusZone("dock-body");
      } else {
        setWorkbenchFocusZone("canvas");
      }
      touchedWorkspaceDock = true;
    };
    const executeApplicationShellEffect = (effect: OpenTuiApplicationShellEffect) => {
      switch (effect.kind) {
        case "renderer-command":
          executeRendererCommand(effect.invocation);
          break;
        case "dock-mode":
          setDockMode(effect.mode);
          touchedWorkspaceDock = true;
          break;
        case "focus":
          applyApplicationShellFocus(effect.target);
          break;
        case "palette-close":
          closePalette();
          applyApplicationShellFocus(effect.restore);
          break;
        case "resource-select":
          // Resource selection remains owned by each native dock surface.
          break;
      }
    };
    const applicationRootController = createApplicationRootController({
      projection: semanticApplicationShell,
      applyEffect: executeApplicationShellEffect,
      capturePaletteFocusReturn: setPaletteFocusReturnTarget,
      pasteFilesEditor: (text) => {
        if (!filesSession()?.insertText(text)) return;
        setStatusNote(`pasted ${text.length} chars`);
      },
      pasteTerminal: (text) => {
        const pane = semanticView?.focusedPane();
        if (!pane || !semanticView) return;
        if (!sendSemanticTerminalText(pane, `\x1b[200~${text}\x1b[201~`)) {
          setStatusNote("terminal runtime is reconnecting");
          return;
        }
        setStatusNote(`pasted ${text.length} chars`);
      },
      ctrlC: {
        copyEditorSelection: () => {
          const current = selection();
          if (!current || current.surface !== "editor") return;
          const { start, end } = orderCells(current.anchor, current.head);
          copyText(extractSelection(editorLines(), start, end, false));
        },
        copyTerminalSelection: () => {
          const current = selection();
          if (!current || current.surface !== "mirror") return;
          commitMirrorCopy(current.paneId, current.anchor, current.head);
        },
        forwardTerminalCtrlC: () => {
          const pane = semanticView?.focusedPane();
          if (!pane || !semanticView) return;
          clearSelection();
          snapLive(pane);
          tapInputSent(pane);
          if (!sendSemanticTerminalKey(pane, "C-c"))
            setStatusNote("terminal runtime is reconnecting");
        },
      },
      runLifecycle: (command) => lifecycleExecutor.run(command),
      cleanupRegistry,
    });
    onCleanup(() => applicationRootController.dispose());
    const executeSurfaceCommand = (
      surface: "home" | "terminals" | WorkbenchDockTabId,
      source: CommandSource,
    ) => applicationRootController.openSurface(surface, source);
    const executePaletteCommand = (open: boolean, source: CommandSource) =>
      open
        ? applicationRootController.openPalette(source)
        : applicationRootController.closePalette(source);
    const executeDockModeCommand = (nextMode: WorkbenchDockMode, source: CommandSource) =>
      applicationRootController.setDockMode(nextMode, source);
    const executeFocusCommand = (target: SemanticFocusTarget, source: CommandSource) =>
      applicationRootController.moveFocus(target, source);
    const executeSharedMultiplexerAction = async (
      action: TuiMultiplexerAction,
      target: { sessionName?: string; runtimePaneId?: string | null } = {},
      options: { announce?: boolean } = {},
    ) => {
      const activeMirror = semanticView;
      if (!activeMirror) {
        if (options.announce !== false) setStatusNote("no active tmux workspace");
        return { status: "error", message: "no active tmux workspace" } as const;
      }
      const windowsBefore =
        action.kind === "new-window" ? new Set(windowTabs().map((window) => window.index)) : null;
      const result = await executeTuiMultiplexerAction(
        action,
        {
          sessionName: target.sessionName ?? curTarget(),
          focusedRuntimePaneId:
            target.runtimePaneId === undefined
              ? activeMirror.focusedPane() || null
              : target.runtimePaneId,
          paneDescriptors: activeMirror.paneDescriptors(),
          viewportSize: terminalCanvasProjection().tmuxSize,
        },
        async () => {
          throw new Error("Raw tmux fallback is disabled; reconnect the canonical daemon");
        },
      );
      if (action.kind === "new-window" && result.status !== "error") {
        // Daemon creation is intentionally detached for idempotent authority.
        // Selecting is client UX: reconcile the server-confirmed window list,
        // then activate exactly the newly-created real tmux window. Every
        // attached GUI/TUI consequently observes the same tmux current-window.
        const nextWindows = await activeMirror.windows();
        setWindowTabs(nextWindows);
        const created = nextWindows.find((window) => !windowsBefore?.has(window.index));
        if (created && !created.active) activateSemanticWindow(created.index);
      }
      if (options.announce !== false) setStatusNote(result.message);
      return result;
    };
    /** Motion is renderer-local: the one-cell guide follows at frame rate while
     * terminal bodies remain stable. Release emits exactly one semantic resize,
     * and the next daemon layout is the only settled geometry authority. */
    const commitPaneResize = () => resizeTransaction.release();
    const runPaletteAction = async (a: PaletteAction) => {
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
      executePaletteCommand(false, { kind: "palette", surface: "command-palette" });
      switch (a.kind) {
        case "search-scrollback":
          // The live-prompt entry to scrollback search — `/` only works while
          // scrolled (it belongs to the pane's agent at the bottom).
          openSearch();
          break;
        case "surface":
          executeSurfaceCommand(a.surface, {
            kind: "palette",
            surface: "command-palette",
          });
          break;
        case "tab":
          if (a.tab === "home" || a.tab === "terminal") {
            executeSurfaceCommand(a.tab === "home" ? "home" : "terminals", {
              kind: "palette",
              surface: "command-palette",
            });
          } else {
            executeSurfaceCommand(a.tab === "files" ? "files" : "changes", {
              kind: "palette",
              surface: "command-palette",
            });
          }
          break;
        case "view":
          executeRendererCommand(
            rendererInvocationForView(a.viewId, {
              kind: "palette",
              surface: "command-palette",
            }),
          );
          break;
        case "open-folder":
          void openFolderFlow();
          break;
        case "attach":
          openWorkspace(a.session, dirForSession(a.session));
          break;
        case "jump-pane":
          selectPanel("terminals");
          if (a.session !== contextSession()) openWorkspace(a.session, dirForSession(a.session));
          else submitSemanticPaneFocus(a.paneId);
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
          if (mode() === "diff") toolResources.session.refresh("changes");
          else enterDiff(workspaceDir());
          break;
        case "new-window":
          await executeSharedMultiplexerAction(a);
          break;
        case "rename-window":
          await executeSharedMultiplexerAction(a);
          break;
        case "kill-window": {
          const ok = await DialogConfirm.show({
            title: "Close this window?",
            body: "Closes every pane and process in the active tmux window.",
            yesLabel: "Close window",
            noLabel: "Keep window",
            defaultNo: true,
          });
          if (!ok) break;
          await executeSharedMultiplexerAction(a);
          break;
        }
        case "zoom-pane":
          await executeSharedMultiplexerAction(a);
          break;
        case "swap-pane":
          await executeSharedMultiplexerAction(a);
          break;
        case "split-pane-right":
          await executeSharedMultiplexerAction(a);
          break;
        case "split-pane-down":
          await executeSharedMultiplexerAction(a);
          break;
        case "kill-pane": {
          const ok = await DialogConfirm.show({
            title: "Close this pane?",
            body: "Closes the active tmux pane and the process running inside it.",
            yesLabel: "Close pane",
            noLabel: "Keep pane",
            defaultNo: true,
          });
          if (!ok) break;
          await executeSharedMultiplexerAction(a);
          break;
        }
        case "break-pane": {
          setStatusNote("break pane is unavailable until its semantic daemon verb lands");
          break;
        }
        case "rotate-window": {
          setStatusNote("rotate panes is unavailable until its semantic daemon verb lands");
          break;
        }
        case "select-layout": {
          setStatusNote("layout presets are unavailable until their semantic daemon verb lands");
          break;
        }
        case "select-text": {
          // The pane menu verb's palette twin (M22.9) — same gate: the focused
          // pane must be app-mouse (otherwise drags already select directly).
          const pid = semanticView?.focusedPane();
          const p = panes().find((x) => x.id === pid);
          if (pid && p?.appMouse) enterSelectMode(pid);
          break;
        }
        case "sync-toggle": {
          setStatusNote("synchronized input is unavailable until its semantic daemon verb lands");
          break;
        }
        case "resize-window": {
          const lane = sessionRuntimeLane();
          const size = terminalCanvasProjection().tmuxSize;
          if (lane?.ownsGeometry && size) {
            void terminalWorkspaceAdapter?.fitViewport(size.cols, size.rows)?.then(
              () => setStatusNote("resized window to fit"),
              (error: unknown) =>
                setStatusNote(error instanceof Error ? error.message : "viewport fit rejected"),
            );
          }
          break;
        }
        case "settings":
          // The settings surface (M22.4): every setting is a command running on
          // the global dialog stack; flows live below with the stack wiring.
          void runSettingsCommand(a.id);
          break;
        case "quit":
          applicationRootController.quit({ hosted: HOSTED }, "palette");
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
        executePaletteCommand(false, { kind: "keyboard", surface: "command-palette" });
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
    // Live-preview accent for the picker. The semantic store is the authority
    // for chrome AND terminal-cell projection, so moving through choices can
    // preview the complete cockpit without mutating tmux or its PTYs.
    const [previewAccent, setPreviewAccent] = createSignal<RGBA | null>(null);
    const dlgAccent = () => previewAccent() ?? semanticTheme().roles.text.link;
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
        footerHint: "live preview · updates chrome + terminal palette",
        onMove: (item) => {
          setPreviewAccent(rgbOf(item.id));
          semanticThemeStore.configure({ ...cfg.theme, accent: item.id });
        },
      });
      setPreviewAccent(null);
      if (!choice) {
        semanticThemeStore.configure(cfg.theme);
        return false;
      }
      if (choice.item.id !== before) {
        updateAppConfig(themePatch(choice.item.id));
        semanticThemeStore.configure({ ...cfg.theme, accent: choice.item.id });
        setStatusNote("accent saved — chrome and terminals updated");
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
      // Do not erase a remembered workspace while a bare launch is still
      // waiting for the first live fleet snapshot that can validate it.
      if (!startupWorkspaceReconciled) return;
      const snapshot: AppState = {
        lastTab: tab(),
        contextSession: contextSession() || null,
        openFile: editorPath(),
        diffFile: diffSelectedPath(),
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
      diffSelectedPath();
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

    let latestFleetCatalog: FleetCatalogResourceV1 | null = null;
    let latestSessionCatalog: Extract<TuiToolResource, { kind: "sessions" }>["value"] | null = null;
    let latestProjectCatalog: Extract<TuiToolResource, { kind: "projects" }>["value"] | null = null;
    reconcileFleetResources = () => {
      if (!latestFleetCatalog || !latestSessionCatalog || !latestProjectCatalog) return;
      const projects = projectTuiFleetResources({
        fleet: latestFleetCatalog,
        sessions: latestSessionCatalog,
        projects: latestProjectCatalog,
        authoritativeAgents: latestAuthoritativeAgents,
      });
      setProjectsData(projects);
      noteAttention(projects);
      if (startupWorkspaceReconciled) return;
      const liveSessions = projects.flatMap((project) =>
        project.sessions.map((session) => session.name),
      );
      if (liveSessions.length === 0) return;
      startupWorkspaceReconciled = true;
      const selection = reconcileWorkspaceSelection({
        liveWorkspaceIds: liveSessions,
        persistedWorkspaceId: persisted.contextSession,
        fallback: "first-live",
      });
      const restoredSession = selection.workspaceId;
      if (!restoredSession) return;
      const restoredDir = dirForSession(restoredSession) ?? invokeCwd;
      setContextSession(restoredSession);
      setContextDir(restoredDir);
      changesSession()?.setWorkspaceIdentity({
        workspaceName: restoredSession,
        directory: restoredDir,
      });
      setCurTarget(restoredSession);
      attach(restoredSession);
      if (persisted.lastTab === "terminal") selectPanel("terminals");
      if (selection.rejectedSource === "persisted") {
        setStatusNote(`restored live workspace ${restoredSession}`);
      }
    };
    const applyFleetCatalog = (catalog: FleetCatalogResourceV1) => {
      latestFleetCatalog = catalog;
      reconcileFleetResources();
    };

    const applyFilesCatalog = (envelope: WorkspaceFilesCatalogEnvelopeV1) => {
      const session = filesSession();
      if (session) session.applyCatalog(envelope);
      else pendingFilesCatalog.retain(toolResourceGeneration, envelope);
    };

    const applyChangesCatalog = (envelope: WorkspaceChangesCatalogEnvelopeV1) => {
      const session = changesSession();
      if (session) session.applyCatalog(envelope);
      else pendingChangesCatalog.retain(toolResourceGeneration, envelope);
    };

    const applyMissionsCatalog = (envelope: WorkspaceMissionsEnvelopeV1) => {
      const session = missionsActivitySession();
      if (session) session.applyCatalog(toolResourceGeneration, envelope);
      else pendingMissionsCatalog.retain(toolResourceGeneration, envelope);
    };

    const applyToolResource = (resource: TuiToolResource): void => {
      if (resource.kind === "fleet") applyFleetCatalog(resource.value);
      else if (resource.kind === "sessions") {
        latestSessionCatalog = resource.value;
        reconcileFleetResources();
      } else if (resource.kind === "projects") {
        latestProjectCatalog = resource.value;
        reconcileFleetResources();
      } else if (resource.kind === "files") applyFilesCatalog(resource.value);
      else if (resource.kind === "changes") applyChangesCatalog(resource.value);
      else applyMissionsCatalog(resource.value);
    };

    onMount(() => {
      // Resource identity, rather than a wall-clock timestamp, is the honest
      // de-duplication key. Two daemon updates may complete within one
      // millisecond and must both reach the projection.
      const appliedToolSnapshots = new Map<TuiToolResource["kind"], TuiToolResource>();
      const disposeTools = toolResources.subscribe((state) => {
        if (state.generation !== toolResourceGeneration) {
          toolResourceGeneration = state.generation;
          pendingFilesCatalog.advance(state.generation);
          pendingChangesCatalog.advance(state.generation);
          pendingMissionsCatalog.advance(state.generation);
          appliedToolSnapshots.clear();
          latestFleetCatalog = null;
          latestSessionCatalog = null;
          latestProjectCatalog = null;
          latestAuthoritativeAgents = [];
          latestApplicationShellAgents = [];
          latestApplicationShellWorkspaceName = "";
          setProjectsData([]);
          filesSession()?.resetCatalog();
          changesSession()?.reset();
          missionsActivitySession()?.reset(state.generation);
        }
        for (const slot of state.slots.values()) {
          if (
            slot.status === "loaded" &&
            !slot.refreshing &&
            appliedToolSnapshots.get(slot.resource.kind) !== slot.resource
          ) {
            appliedToolSnapshots.set(slot.resource.kind, slot.resource);
            applyToolResource(slot.resource);
          }
        }
      });
      applicationLifecycle.registerCloser("tool-resource-subscription", disposeTools);
      tuiPerfMark("solid-mounted");
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
      // The semanticView follows workspace identity, not which native surface owns
      // keyboard focus. Dock restore must not leave the terminal canvas blank.
      if (curTarget()) attach(curTarget());
      const flushMirrorFrame = () => {
        let continueAutoScroll = false;
        // Edge auto-scroll (M25.6): while a semanticView drag parks the pointer at
        // the pane's top/bottom content row, extend ~1 row per state tick —
        // one row per renderer frame. The clamps stop it at the
        // scrollback top (up) / the live bottom (down); release or escape
        // clears the gesture (clearSelection / the release branch in `route`).
        if (semanticView && dragAutoScroll && selecting?.surface === "mirror") {
          const paneId = selecting.paneId;
          const depth = semanticView.scrollbackDepth(paneId);
          const cur = Math.min(scrollOffsets.get(paneId) ?? 0, depth);
          const next = dragAutoScroll === "up" ? Math.min(cur + 1, depth) : Math.max(cur - 1, 0);
          if (next !== cur) {
            scrollOffsets.set(paneId, next);
            extendSelection(lastDragPointer.x, lastDragPointer.y);
            dirty = true;
            continueAutoScroll = true;
          }
        }
        if (!dirty || !semanticView) return;
        dirty = false;
        const t0 = performance.now();
        // FB path: fetch geometry + cursor/offset + per-pane version only (no
        // styled-row rebuild) — the <pane_surface> reads cells via the blit and
        // gates its walk on the version, so unchanged panes cost nothing.
        const raw = semanticView.panes(scrollOffsets, !FB_PANES, terminalPalette());
        if (raw.length > 0) terminalFramePublicationPending = true;
        if (FB_PANES) setPaneRuntime(livePaneRuntime(raw));
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
          tapInputTick();
          if (continueAutoScroll) markDirty();
          return;
        }
        const effective = semanticView.windowSize() ?? effectiveWindowSize(raw);
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
        if (continueAutoScroll) markDirty();
      };
      // Event-driven state publication: the first event after idle is flushed
      // immediately and sustained output is capped to the renderer's 60 Hz
      // budget. This replaces the unconditional 125 Hz wake-up loop.
      paneFrameCoalescer = new FrameCoalescer(flushMirrorFrame, 1000 / 60, undefined, () =>
        toolResources.noteScheduledWakeup(),
      );
      if (dirty) paneFrameCoalescer.request();
      cleanupRegistry.set("state-and-presentation-timers", () => {
        paneFrameCoalescer?.dispose();
        paneFrameCoalescer = null;
        if (saveTimer) clearTimeout(saveTimer);
        if (workspaceUiSaveTimer) clearTimeout(workspaceUiSaveTimer);
        if (noteTimer) clearTimeout(noteTimer);
      });
      applicationLifecycle.registerCloser("terminal-and-editor", async () => {
        await mirrorSupervisor?.stop();
        mirrorSupervisor = null;
        semanticView = null;
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
      return { depth: p ? paneScrollbackDepth(p) : 0, viewH: p?.height ?? 0 };
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
      if (!semanticView) return;
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
      if (!s || !semanticView) return;
      const query = s.query;
      setSearch({ query, editing: false });
      if (query.length === 0) return;
      const pid = semanticView.focusedPane();
      if (!pid) return;
      // Store matches bottom-up (nearest the live viewport first) so the landed
      // match reads "1/N" and n walks upward — see visitOrder.
      const matches = visitOrder(semanticView.findTextMatches(pid, query));
      const next = new Map(paneSearches());
      next.set(pid, { query, matches, current: 0 });
      setPaneSearches(next);
      if (matches.length > 0) jumpToCurrent(pid);
      markDirty();
    };
    /** n / N — cycle the focused pane's current match and re-scroll to it. */
    const jumpMatch = (dir: 1 | -1) => {
      const pid = semanticView?.focusedPane();
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
      const pid = semanticView?.focusedPane();
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
      applicationRootController.paste(text, {
        focusZone: workbenchProjection().focusZone,
        focusedPanel: focusedWorkbenchPanel(),
        filesEditorFocused: filesFocus() === "editor",
        filesEditorWritable: filesSession()?.editorWritable() ?? false,
        terminalAvailable: Boolean(semanticView),
      });
    };
    /** Paste-buffer reads need a typed daemon query; keep the dormant flow
     * capability-honest until that contract exists. */
    const loadBuffers = () => {
      setPaletteBuffers([]);
      setStatusNote("tmux paste buffers are unavailable until their semantic query lands");
    };
    /** Fetch one buffer's content and paste it. The control client reads replies as
     *  latin1 (byte-per-char) so multibyte glyphs must be re-encoded latin1→utf8
     *  (the same fix the pane seed uses) before hitting the paste path. */
    const pasteBuffer = (name: string) => {
      executePaletteCommand(false, { kind: "palette", surface: "paste-buffer" });
      setPaletteSel(0);
      setPaletteTop(0);
      setStatusNote(`tmux paste buffer ${name} is unavailable in the semantic runtime`);
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
     *  the source of truth for a semanticView copy (not capture-pane). */
    const paneRowTexts = (paneId: string): string[] => {
      const p = panes().find((x) => x.id === paneId);
      if (!p) return [];
      // FB path omits the styled rows (the blit reads cells directly), so read the
      // visible row text on demand from the semanticView — same trim/collapse as the run
      // join, so extractSelection copies identically.
      if (p.snapshot.rows.length === 0) {
        return semanticView?.visibleRowTexts(paneId, p.snapshot.scrollOffset) ?? [];
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
      const text = semanticView?.extractText(paneId, start, end, MAX_CLIP_BYTES) ?? "";
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
    /** The inclusive selected column interval on a semanticView snapshot row (or editor
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
    /** A semanticView pane's rows with its search matches accent-tinted (all matches dim,
     *  the current one bright) and then the active selection inverse-tinted on top.
     *  Both are pure run-splits over the snapshot; either may be absent. Matches are
     *  keyed by ABSOLUTE buffer line, mapped to the visible row via the pane's
     *  depth − scrollOffset (see PaneMirror.bufferLines). */
    const paneSelRows = (pane: LivePane) => {
      let rows = pane.snapshot.rows;
      const ps = paneSearches().get(pane.id);
      if (ps && ps.matches.length > 0 && ps.query.length > 0) {
        const baseY = pane.scrollbackDepth - pane.snapshot.scrollOffset;
        const len = ps.matches[0]?.columns ?? ps.query.length;
        rows = rows.map((runs, r) => {
          const line = baseY + r;
          let out = runs;
          ps.matches.forEach((m, idx) => {
            if (m.line !== line) return;
            out = tintRunsBg(
              out,
              m.col,
              m.col + len - 1,
              idx === ps.current
                ? terminalPalette().searchCurrent
                : terminalPalette().searchHighlight,
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
        len: ps.matches[0]?.columns ?? ps.query.length,
        baseY: paneScrollbackDepth(pane) - pane.snapshot.scrollOffset,
      };
    };

    const paneCell = (pane: LivePane, gx: number, gy: number) => ({
      col: Math.max(0, Math.min(pane.width - 1, gx - sidebarW() - pane.left)),
      row: Math.max(0, Math.min(pane.height - 1, gy - HEADER_ROWS - pane.top)),
    });
    /** The view's current absolute top for a pane (M25.6): live scrollback
     *  depth − the clamped LOCAL offset, both read from the semanticView/offset map
     *  at EVENT time — the LivePane snapshot lags one 8ms tick, and a wheel
     *  that just moved the offset must map the very next pointer cell right. */
    const paneBaseY = (paneId: string): number => {
      const depth = semanticView?.scrollbackDepth(paneId) ?? 0;
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
    // vertical. `applyScrollTop` writes a new top back to the owning signal (semanticView
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
      const scroll = changesSession()?.scrollState() ?? {
        contentLength: 0,
        viewportRows: 1,
        top: 0,
      };
      return {
        col: dims().width - 1,
        top0: TABBAR_H + HEADER_ROWS,
        contentLen: scroll.contentLength,
        viewH: scroll.viewportRows,
        viewportTop: scroll.top,
        surface: { surface: "diff" },
        visible: scroll.contentLength > scroll.viewportRows,
      };
    };
    const mirrorScrollGeom = (pane: LivePane): ScrollGeom => {
      const depth = paneScrollbackDepth(pane);
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
     *  clamp to their content; the semanticView converts top → offset-from-live and lets
     *  the 8ms pane tick re-render (same path as the wheel). */
    const applyScrollTop = (surface: ScrollSurface, top: number) => {
      if (surface.surface === "editor") {
        setEditorTop(clampTop(top, editorLines().length, editorRows()));
      } else if (surface.surface === "diff") {
        changesSession()?.setScrollTop(top);
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
      // Mouse coordinates are meaningful only for the exact viewport the
      // daemon has acknowledged for this connection generation. Drop (rather
      // than replay) stale clicks/wheel events across reconnects and resizes.
      if (!semanticViewportAcknowledged()) return;
      const { col, row } = paneCell(pane, gx, gy);
      const encoded = sgrMouse(0, col, row, release);
      if (!sendSemanticTerminalText(pane.id, encoded))
        setStatusNote("terminal runtime is reconnecting");
    };
    const wheel = (pane: LivePane, direction: "up" | "down", col: number, row: number) => {
      // Select mode reclaims the wheel for the LOCAL scrollback (M22.9) so
      // older output can be scrolled into view and selected.
      if (!wheelScrollsLocal(pane.appMouse, selectModePane() === pane.id)) {
        if (!semanticViewportAcknowledged()) return;
        const encoded = sgrMouse(direction === "up" ? 64 : 65, col, row, false);
        if (!sendSemanticTerminalText(pane.id, encoded))
          setStatusNote("terminal runtime is reconnecting");
        return;
      }
      const cur = scrollOffsets.get(pane.id) ?? 0;
      const next =
        direction === "up"
          ? Math.min(cur + SCROLL_STEP, paneScrollbackDepth(pane))
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
        const target = changesSession()?.contextTargetAt(x - sidebarW(), gy);
        if (!target) return null;
        return {
          region: "difffile",
          title: target.title,
          items: MENU_ITEMS.difffile,
          diffPath: target.path,
        };
      }
      // semanticView: gy=0 is the WINDOW STRIP; gy=1 is per-pane native chrome —
      // a right-click there opens the window menu. The window under a label span is
      // the target; an empty-area / button right-click (span miss) falls back to the
      // ACTIVE window. This dual targeting means the menu still opens even if the
      // strip's known label-cell click swallow (see windowStripParts) eats the hit,
      // because the empty area to the right of the labels always routes.
      if (gy === 0) {
        const i = spanHit(windowSpans(), x);
        const tabs = windowTabs();
        const w = i >= 0 && i < tabs.length ? tabs[i] : tabs.find((t) => t.active);
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
          closeMenu();
          void executeSharedMultiplexerAction(
            { kind: "kill-session" },
            { sessionName: name, runtimePaneId: null },
          ).then(() => toolResources.session.refresh("fleet"));
          return;
        }
        if (id === "rename" && val) {
          void executeSharedMultiplexerAction(
            { kind: "rename-session", name: val },
            { sessionName: name, runtimePaneId: null },
          ).then(() => toolResources.session.refresh("fleet"));
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
          void filesSession()
            ?.create(m.fileParent ?? workspaceDir(), val)
            .catch((e) => setStatusNote(`create failed: ${(e as Error).message}`));
        } else if (id === "rename" && val && m.filePath) {
          void filesSession()
            ?.rename(m.filePath, val)
            .catch((e) => setStatusNote(`rename failed: ${(e as Error).message}`));
        } else if (id === "delete" && m.filePath) {
          void filesSession()
            ?.delete(m.filePath)
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
        const idx = m.windowIndex;
        if (id === "new") {
          void executeSharedMultiplexerAction({ kind: "new-window" });
        } else if (id === "rename" && val && idx !== undefined) {
          if (windowTabs().find((window) => window.index === idx)?.active) {
            void executeSharedMultiplexerAction({ kind: "rename-window", name: val });
          } else {
            setStatusNote("open that window before renaming it");
          }
        } else if (id === "kill" && idx !== undefined) {
          if (windowTabs().find((window) => window.index === idx)?.active) {
            void executeSharedMultiplexerAction({ kind: "kill-window" });
          } else {
            setStatusNote("open that window before closing it");
          }
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
        const sharedAction: TuiMultiplexerAction | null =
          id === "split-h"
            ? { kind: "split-pane-right" }
            : id === "split-v"
              ? { kind: "split-pane-down" }
              : id === "zoom"
                ? { kind: "zoom-pane" }
                : id === "swap-next"
                  ? { kind: "swap-pane" }
                  : id === "kill"
                    ? { kind: "kill-pane" }
                    : null;
        if (sharedAction) {
          closeMenu();
          void executeSharedMultiplexerAction(sharedAction, { runtimePaneId: pid });
          return;
        }
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
          missionMode: missionsActivitySession()?.missionMode() ?? "board",
          editorFocus: filesFocus(),
          editorFilterOpen: filesQuery() !== null,
          diffFilterOpen: diffFilterOpen(),
          homePromptOpen: pathPrompt() !== null || sessionPrompt() !== null,
          configuredShortcutKeys: canvasHostedViews().flatMap((view) =>
            view.shortcut ? [view.shortcut.key] : [],
          ),
          compositeCycleAvailable: true,
        },
        evt,
        { hosted: HOSTED },
      );
      if (layer.kind === "lifecycle") {
        applicationRootController.runLifecycle(layer.command);
        return;
      }
      if (layer.kind === "kitty-super-palette") {
        executePaletteCommand(true, { kind: "keyboard", surface: "workbench" });
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
        executeSurfaceCommand(canvasShortcut, { kind: "keyboard", surface: "workbench" });
        return;
      }
      const dockShortcut = workbenchDockTabForShortcut(evt);
      if (dockShortcut) {
        executeSurfaceCommand(dockShortcut, { kind: "keyboard", surface: "workbench" });
        return;
      }
      if (layer.kind === "global") {
        if (layer.command.kind === "open-palette") {
          executePaletteCommand(true, { kind: "keyboard", surface: "workbench" });
        } else {
          executeRendererCommand(rendererInvocationForGlobal(layer.command));
        }
        return;
      }
      const escapeTarget =
        evt.name === "escape"
          ? tuiEscapeFocusTarget({
              focusZone: workbenchProjection().focusZone,
              layer: layer.kind,
            })
          : null;
      if (escapeTarget) {
        executeFocusCommand(
          { kind: "zone", zone: escapeTarget },
          { kind: "keyboard", surface: "workbench" },
        );
        return;
      }
      if (workbenchProjection().focusZone === "dock-tabs") {
        const keyboardTarget = workbenchDockNavigationTarget(
          workbenchProjection().tabs,
          activeDockTab(),
          evt,
        );
        if (keyboardTarget) {
          executeSurfaceCommand(keyboardTarget, { kind: "keyboard", surface: "workbench" });
          executeFocusCommand(
            { kind: "zone", zone: "dock-tabs" },
            { kind: "keyboard", surface: "workbench" },
          );
          return;
        }
        if (evt.name === "return" || evt.name === "enter" || evt.name === "down") {
          executeDockModeCommand("open", { kind: "keyboard", surface: "bottom-dock" });
          executeFocusCommand(
            { kind: "zone", zone: "dock-body" },
            { kind: "keyboard", surface: "bottom-dock" },
          );
          return;
        }
        if (evt.name === "escape" || evt.name === "up") {
          executeFocusCommand(
            { kind: "zone", zone: "canvas" },
            { kind: "keyboard", surface: "bottom-dock" },
          );
          return;
        }
        return;
      }
      if (workbenchProjection().focusZone === "dock-body" && activeDockTab() === "activity") {
        if (evt.name === "j" || evt.name === "down") moveActivitySelection(1);
        else if (evt.name === "k" || evt.name === "up") moveActivitySelection(-1);
        else if (evt.name === "escape") {
          executeFocusCommand(
            { kind: "zone", zone: "dock-tabs" },
            { kind: "keyboard", surface: "activity" },
          );
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
          applicationRootController.handleCtrlC({
            layer: "editor",
            hasEditorSelection: Boolean(s && s.surface === "editor"),
          });
          return;
        }
        if (evt.ctrl && evt.name === "s") {
          saveEditor();
          return;
        }
        if (evt.ctrl && evt.name === "z") {
          filesSession()?.undo();
          return;
        }
        if (evt.ctrl && evt.name === "y") {
          filesSession()?.redo();
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
              filesSession()?.cancelFilter();
            } else if (evt.name === "return") {
              filesSession()?.confirmFilter();
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
            filesSession()?.beginFilter();
          } else if (evt.name === "]") hopChanged(1);
          else if (evt.name === "[") hopChanged(-1);
          else if (evt.shift && evt.name === "h") toggleHiddenFiles();
          else if (evt.shift && evt.name === "i") toggleIgnoredFiles();
          else if (evt.name === "r") toolResources.session.refresh("files");
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
        changesSession()?.handleKey(evt, layer.kind === "diff-filter" ? "filter" : "surface");
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
        if (tabs.length > 1 && semanticView) {
          const cur = tabs.findIndex((w) => w.active);
          activateSemanticWindow(tabs[(cur + 1) % tabs.length]!.index);
        }
        return;
      }
      if (evt.ctrl && evt.name === "o") {
        const ps = panes();
        if (ps.length > 1 && semanticView) {
          const cur = ps.findIndex((p) => p.id === semanticView!.focusedPane());
          const nextPaneId = ps[(cur + 1) % ps.length]!.id;
          submitSemanticPaneFocus(nextPaneId);
        }
        return;
      }
      if (!semanticView) return;
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
        (scrollOffsets.get(semanticView.focusedPane()) ?? 0) > 0
      ) {
        openSearch();
        return;
      }
      // ^c copies an active semanticView selection; with no selection it passes through
      // to the pane (interrupt) exactly as before.
      if (evt.ctrl && evt.name === "c") {
        const s = selection();
        applicationRootController.handleCtrlC({
          layer: "terminal",
          mirrorAvailable: Boolean(semanticView),
          hasTerminalSelection: Boolean(s && s.surface === "mirror"),
        });
        return;
      }
      // Any key that reaches the pane retires a stale selection highlight.
      clearSelection();
      snapLive(semanticView.focusedPane());
      tapInputSent(semanticView.focusedPane()); // t0: keystroke dispatched to the pane
      // The input fast path (M21.5): sendKey/sendText are fire-and-forget —
      // no reply Promise, literals coalesced (ordering preserved downstream).
      if (evt.ctrl && evt.name.length === 1) {
        if (!sendSemanticTerminalKey(semanticView.focusedPane(), `C-${evt.name}`))
          setStatusNote("terminal runtime is reconnecting");
        return;
      }
      const named = KEYMAP[evt.name];
      if (named) {
        if (!sendSemanticTerminalKey(semanticView.focusedPane(), named))
          setStatusNote("terminal runtime is reconnecting");
        return;
      }
      if (evt.name.length === 1 && !evt.meta) {
        const text = evt.shift ? evt.name.toUpperCase() : evt.name;
        if (!sendSemanticTerminalText(semanticView.focusedPane(), text))
          setStatusNote("terminal runtime is reconnecting");
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

    // OpenTUI's Solid hooks install their input owners from onMount. Register
    // this barrier after both root hooks so an automation/host that observes it
    // can send lifecycle input without racing a merely-painted first frame.
    onMount(() => {
      // A targeted launch admits tool demand only after semantic geometry and
      // the following native frame commit. Configless Home has no terminal
      // target; its fleet catalog is the bootstrap mechanism used to choose one.
      publishToolReadiness = () => {
        if (!bareHome) return;
        const daemon = readCanonicalDaemonInfo();
        if (!daemon) return;
        toolResources.setTarget({ daemon, workspaceName: "__catalog__" });
        toolResources.markCatalogReady();
        optionalFeatures.admit();
      };
      resolveInputReady();
    });

    /** The per-window strip's x-spans — one segment per tmux window, laid out from
     *  the main column's first cell (SIDEBAR_W + paddingLeft 1) with a 1-cell gap,
     *  exactly matching the rendered `flexDirection="row" gap={1}` row. Shared by
     *  the router (click + hover hit test) and, cell-for-cell, by the render. The
     *  labels MUST equal the rendered segment strings for the math to hold. */
    const WINDOW_ADD_LABEL = " + ";
    const windowLabels = () => windowTabs().map((w) => ` ${w.index}:${w.name} `);
    // The final span is the visible new-window button. Keeping it in the same
    // geometry model as the tabs prevents render/hover/click cell drift.
    const windowSpans = createMemo(() =>
      spans([...windowLabels(), WINDOW_ADD_LABEL], sidebarW() + 1, 1),
    );
    const activateWindowStripAt = (screenX: number) => {
      const i = spanHit(windowSpans(), screenX);
      const tabs = windowTabs();
      if (i === tabs.length) {
        void executeSharedMultiplexerAction({ kind: "new-window" });
        return;
      }
      const window = tabs[i];
      if (window) activateSemanticWindow(window.index);
    };

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
    const focusedLivePane = () => panes().find((p) => paneIsFocused(p.id));
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
      filesSession()?.action(id);
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
      const pre = tabs.slice(0, Math.max(0, activeIdx)).map(label);
      const post = tabs.slice(activeIdx + 1).map(label);
      return {
        // Inter-label gaps live in the strings, not flexbox. Empty text nodes
        // otherwise still consumed gap cells and made the visible + button
        // drift away from the shared hit-test spans.
        pre: pre.length > 0 ? `${pre.join(" ")} ` : "",
        active: activeIdx >= 0 ? label(tabs[activeIdx]!) : "",
        post: post.length > 0 ? ` ${post.join(" ")}` : "",
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
        executePaletteCommand(true, { kind: "mouse", surface: "application-bar" });
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
          const projection = filesSurfaceProjection();
          const hit = projection ? filesSession()?.hitTest(localX, localY) : null;
          if (hit?.area === "header" && hit.actionIndex !== undefined)
            setHoverIf({ region: "button", index: hit.actionIndex });
          else if (hit?.area === "list" && hit.rowIndex !== undefined)
            setHoverIf({ region: "files", index: hit.rowIndex });
          else setHoverIf(null);
        } else if (activeDockTab() === "changes") {
          setChangesHoverTarget(changesSession()?.hoverTargetAt(localX, localY) ?? null);
        } else if (activeDockTab() === "missions") {
          const hit = missionsActivitySession()?.missionHoverAt(localX, localY);
          if (hit?.kind === "mission-card") setHoverIf({ region: "missioncard", index: hit.index });
          else if (hit?.kind === "mission-history")
            setHoverIf({ region: "missionhistory", index: hit.index });
          else if (hit?.kind === "mission-mode")
            setHoverIf({ region: "missionmode", index: hit.index });
          else if (hit?.kind === "mission-button")
            setHoverIf({ region: "missionbutton", index: hit.index });
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
          const projection = filesSurfaceProjection();
          const hit = projection ? filesSession()?.hitTest(x - sidebarW(), gy) : null;
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
        setChangesHoverTarget(changesSession()?.hoverTargetAt(x - sidebarW(), gy) ?? null);
        return;
      }
      if (m === "missions") {
        const hit = missionHitAt(x, y);
        if (hit?.kind === "mission-mode") setHoverIf({ region: "missionmode", index: hit.index });
        else if (hit?.kind === "mission-button")
          setHoverIf({ region: "missionbutton", index: hit.index });
        else if (hit?.kind === "mission-card")
          setHoverIf({ region: "missioncard", index: hit.index });
        else if (hit?.kind === "mission-history")
          setHoverIf({ region: "missionhistory", index: hit.index });
        else setHoverIf(null);
        return;
      }
      // semanticView mode: the per-window strip lives on gy=0. Pane actions occupy the
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

    /** Screen pointer → app-terminal-canvas coordinates. The Workbench owns the
     * focus rail, so this is the only valid entrance to tmux framebuffer math. */
    const terminalCanvasPoint = (e: RouteEvent): { x: number; y: number } | null => {
      if (canvasPanel() !== "terminals" || e.y < TABBAR_H || e.x < sidebarW()) return null;
      const hit = workbenchShellHitTest(workbenchProjection(), e.x - sidebarW(), e.y - TABBAR_H);
      return hit?.kind === "canvas" ? { x: hit.localX, y: hit.localY } : null;
    };

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
      const applicationHit = applicationShellHitTest(applicationShellProjection(), e.x, e.y);
      if (applicationHit?.kind === "status-strip") {
        clearTerminalPaneActionState();
        setHoveredPaneSeparator(null);
        return true;
      }
      if (e.y < TABBAR_H || e.x < sidebarW()) {
        clearTerminalPaneActionState();
        setHoveredPaneSeparator(null);
        return false;
      }
      const hit = workbenchShellHitTest(workbenchProjection(), e.x - sidebarW(), e.y - TABBAR_H);
      if (!hit) {
        clearTerminalPaneActionState();
        setHoveredPaneSeparator(null);
        return false;
      }
      if (hit.kind !== "canvas") {
        clearTerminalPaneActionState();
        setHoveredPaneSeparator(null);
      }
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
          if (e.type === "move" || e.type === "over") {
            setHoveredPaneSeparator(
              separatorAtCanvas(
                panes(),
                terminalCanvasProjection().framebuffer,
                hit.localX,
                hit.localY,
              ),
            );
          }
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
            executeFocusCommand(
              { kind: "zone", zone: "canvas" },
              { kind: "mouse", surface: "terminal-pane-chrome" },
            );
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
              focus: (paneId) => {
                submitSemanticPaneFocus(paneId);
              },
              action: (paneId, _actionId, actionIndex, semanticIntent) => {
                setPressedTerminalPaneAction({ paneId, actionIndex });
                if (semanticIntent.commandId === "workspace.pane.menu.open") {
                  openPaneActions(paneId);
                } else if (semanticIntent.commandId === "workspace.windowMode.maximize.toggle") {
                  const replica = semanticReplicaForRuntime(paneId);
                  if (!replica) {
                    setStatusNote("terminal runtime is reconnecting");
                  } else if (!replica.lane.ownsInput) {
                    setStatusNote("view only · another client owns terminal input");
                  } else {
                    void replica.adapter
                      .submit({
                        verb: "workspace.pane.zoom.toggle",
                        workspaceName: replica.lane.workspaceName,
                        semanticPaneId: replica.semanticPaneId,
                        desired: "toggle",
                      })!
                      .catch((error: unknown) =>
                        setStatusNote(
                          error instanceof Error ? error.message : "pane zoom rejected",
                        ),
                      );
                  }
                }
              },
              menu: openPaneActions,
              settle: () => settleTerminalGestureBoundary(e),
            });
            return true;
          }
        } else {
          clearTerminalPaneActionState();
          setHoveredPaneSeparator(null);
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
          executeFocusCommand(
            { kind: "zone", zone: "canvas" },
            { kind: "mouse", surface: "workspace-canvas" },
          );
        }
        return false;
      }
      if (hit.kind === "canvas-rail") {
        setHoveredDockTab(null);
        setHoverIf(null);
        if (e.type === "down") {
          executeFocusCommand(
            { kind: "zone", zone: "canvas" },
            { kind: "mouse", surface: "workspace-canvas" },
          );
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
          executeSurfaceCommand(hit.tabId, { kind: "mouse", surface: "bottom-dock" });
        }
        return true;
      }
      if (hit.kind === "dock-action") {
        if (e.type === "down" && e.button !== 2) {
          executeDockModeCommand(hit.nextMode, { kind: "mouse", surface: "bottom-dock" });
          executeFocusCommand(
            {
              kind: "zone",
              zone: hit.nextMode === "collapsed" ? "dock-tabs" : "dock-body",
            },
            { kind: "mouse", surface: "bottom-dock" },
          );
        }
        return true;
      }
      if (hit.kind === "dock-tabs" || hit.kind === "dock-body-rail") {
        if (e.type === "down") {
          executeFocusCommand(
            { kind: "zone", zone: hit.kind === "dock-tabs" ? "dock-tabs" : "dock-body" },
            { kind: "mouse", surface: "bottom-dock" },
          );
        }
        return true;
      }
      if (hit.kind !== "dock-body") return true;

      if (e.type === "down" || e.type === "scroll") {
        executeFocusCommand(
          { kind: "zone", zone: "dock-body" },
          { kind: e.type === "scroll" ? "wheel" : "mouse", surface: "bottom-dock" },
        );
      }
      const { localX, localY } = hit;
      if (activeDockTab() === "files") {
        const projection = filesSurfaceProjection();
        const surfaceHit = projection ? filesSession()?.hitTest(localX, localY) : null;
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
        if (e.type === "drag" && selecting?.surface === "editor" && filesSession()?.hasBuffer) {
          const cell = editorCellAtDock(localX, localY);
          setSelection({
            surface: "editor",
            anchor: selAnchor,
            head: { row: cell.line, col: cell.col },
          });
          filesSession()?.setCursor(cell.line, cell.col);
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
        if (surfaceHit?.area !== "editor" || !filesSession()?.hasBuffer) return true;
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
          filesSession()?.setCursor(line, range.to);
          selecting = null;
        } else {
          filesSession()?.setCursor(line, col);
          selAnchor = { row: line, col };
          selecting = { surface: "editor" };
          setSelection(null);
        }
        return true;
      }

      if (activeDockTab() === "changes") {
        if (e.type === "scroll") {
          const direction = e.scroll?.direction;
          if (direction === "up" || direction === "down") {
            changesSession()?.handlePointer({
              type: "scroll",
              x: localX,
              y: localY,
              direction,
              scrollStep: SCROLL_STEP,
              outsideBody: "ignore",
            });
          }
          return true;
        }
        if (e.type !== "down" || e.button === 2) return true;
        hydratedWorkspaceSurfaceIds.add("diff");
        changesSession()?.handlePointer({
          type: "down",
          x: localX,
          y: localY,
          button: e.button,
        });
        return true;
      }

      if (activeDockTab() === "missions") {
        if (e.type === "scroll") {
          const direction = e.scroll?.direction;
          if (direction === "up" || direction === "down") {
            missionsActivitySession()?.handleMissionScroll(localX, localY, direction, SCROLL_STEP);
          }
          return true;
        }
        if (e.type === "down" && e.button !== 2) {
          hydratedWorkspaceSurfaceIds.add("missions");
          missionsActivitySession()?.handleMissionPointer(localX, localY);
        }
        return true;
      }

      if (e.type === "scroll") {
        const direction = e.scroll?.direction;
        if (direction === "up" || direction === "down") {
          missionsActivitySession()?.handleActivityScroll(direction, SCROLL_STEP);
          hydratedWorkspaceSurfaceIds.add("activity");
          touchedWorkspaceSurfaceIds.add("activity");
        }
        return true;
      }
      if (e.type === "down" && e.button !== 2) {
        missionsActivitySession()?.handleActivityPointer(localX, localY);
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
        if (dragAutoScroll) markDirty();
        setSelection({
          surface: "mirror",
          paneId: pane.id,
          anchor: trimAdjustCell(selAnchor, (semanticView?.lineTrim(paneId) ?? 0) - selTrimBase),
          head: paneAbsCell(pane, x, gy),
        });
      } else {
        const { line, col } = editorCellAt(x, gy);
        setSelection({ surface: "editor", anchor: selAnchor, head: { row: line, col } });
        filesSession()?.setCursor(line, col);
      }
    };

    const routeSidebarResizePointer = (e: RouteEvent, active: boolean): boolean =>
      routeApplicationSidebarResizePointer(
        {
          type: e.type,
          active,
          x: e.x,
          y: e.y,
          button: e.button,
          sidebarWidth: sidebarW(),
          tabbarHeight: TABBAR_H,
        },
        {
          start: () => {
            setHoverIf(null);
            dragging = { kind: "sidebar" };
            setStatusNote("resizing…");
          },
          resize: (pointerX) => setPreferredSidebarW(clampSidebarWidth(pointerX)),
          end: () => {
            dragging = null;
            setNote("");
          },
        },
      );

    /** Active non-sidebar gestures own the pointer until release, even when the
     * pointer crosses a modal, status strip, dock, or terminal pane. */
    const routeCapturedDragPointer = (e: RouteEvent): boolean => {
      if (!dragging || dragging.kind === "sidebar") return false;
      const isDrag = e.type === "drag";
      const isEnd = e.type === "up" || e.type === "drag-end" || e.type === "drop";
      if (isDrag || isEnd) {
        if (dragging.kind === "scrollbar") {
          const row = e.y - dragging.top0;
          const top = dragTop(row, dragging.grabOffset, dragging.contentLen, dragging.viewH);
          applyScrollTop(dragging.surface, top);
        } else {
          const pointer = dragging.sep.axis === "x" ? e.x : e.y;
          const size = resizedSize(dragging.sep, pointer - dragging.originPointer);
          if (size !== dragging.lastSize) {
            dragging.lastSize = size;
            resizeTransaction.move(size);
          }
        }
        if (isEnd) {
          if (dragging.kind === "border" && dragging.lastSize !== dragging.sep.aSize) {
            commitPaneResize();
          } else if (dragging.kind === "border") {
            resizeTransaction.cancelDrag();
          }
          dragging = null;
          setHoveredPaneSeparator(null);
          if (resizeTransactionState().phase !== "pending") setNote("");
        }
        return true;
      }
      // Motion variants that do not carry a drag phase are still captured so
      // hover/click routing cannot steal the gesture.
      return true;
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
      // A gesture that already owns the pointer must see every event before
      // dialogs, menus, palettes, or the status strip can consume its release.
      // New seam presses retain their normal lower priority below.
      if (dragging?.kind === "sidebar" && routeSidebarResizePointer(e, true)) return;
      if (routeCapturedDragPointer(e)) return;
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
          if (hit === null) {
            executePaletteCommand(false, { kind: "mouse", surface: "command-palette" });
          }
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
        if (!paletteContains(g, x, y)) {
          executePaletteCommand(false, { kind: "mouse", surface: "paste-buffer" });
        }
        return;
      }
      const applicationChromeHit = applicationShellHitTest(applicationShellProjection(), e.x, e.y);
      if (applicationChromeHit?.kind === "status-strip") {
        if (type === "up" || type === "drag-end" || type === "drop" || type === "out") {
          settleTerminalGestureBoundary(e);
        }
        return;
      }
      // Both cells of the sidebar seam own the pointer before the workbench's
      // canvas rail can see them. This prevents a resize press/drag/release from
      // leaking into an agent terminal at any responsive width.
      if (routeSidebarResizePointer(e, false)) return;
      // The window strip is app chrome above the workbench canvas. Route it
      // before the workbench focus rail; otherwise that full-canvas owner
      // consumes tab and + presses before the strip's span model can see them.
      if (mode() === "mirror" && e.y === TABBAR_H && e.x >= sidebarW()) {
        zzlog(
          `window-strip x=${e.x} sidebar=${sidebarW()} spans=${windowSpans()
            .map((span) => `${span.start}+${span.width}`)
            .join(",")}`,
        );
        if (type === "move" || type === "over" || type === "drag") {
          resolveHover(e.x, e.y);
          return;
        }
        if (type === "down" && e.button === 2) {
          openMenu(e.x, e.y, screenX);
          return;
        }
        if (type === "down") activateWindowStripAt(e.x);
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
          const direction = e.scroll?.direction;
          if (direction !== "up" && direction !== "down") return;
          missionsActivitySession()?.handleMissionScroll(
            x - sidebarW(),
            y - TABBAR_H,
            direction,
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
          const surface = semanticApplicationShell().primaryNavigation.items[i];
          if (surface)
            executeSurfaceCommand(surface.id, { kind: "mouse", surface: "application-bar" });
          return;
        }
        const gy = y - TABBAR_H;
        if (x < sidebarW()) {
          if (y === dims().height - 1) {
            if (spanHit([sidebarHint().buttonSpan], x) === 0) {
              executePaletteCommand(true, { kind: "mouse", surface: "sidebar" });
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
          missionsActivitySession()?.handleMissionPointer(x - sidebarW(), y - TABBAR_H);
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
      // drag; a pane SEPARATOR (a gutter cell between two panes, semanticView only)
      // starts a border drag. Neither fights selection: selection begins only from
      // an in-pane down, never a boundary/gutter cell.
      if (type === "down" && e.button !== 2) {
        const canvasPoint = terminalCanvasPoint(e);
        const sep = canvasPoint
          ? separatorAtCanvas(
              panes(),
              terminalCanvasProjection().framebuffer,
              canvasPoint.x,
              canvasPoint.y,
            )
          : null;
        if (sep) {
          if (resizeTransaction.state().phase !== "idle") {
            setStatusNote("finish the current pane resize first");
            return;
          }
          const lane = sessionRuntimeLane();
          const semanticPaneId = semanticPaneIdForRuntime(sep.aId);
          if (!lane?.ownsGeometry || !semanticPaneId) {
            setStatusNote("view only · another client owns pane geometry");
            return;
          }
          setHoverIf(null);
          setHoveredPaneSeparator(null);
          setActivePaneResize({ sep, delta: 0 });
          const beganResize = resizeTransaction.begin({
            workspaceName: lane.workspaceName,
            semanticPaneId,
            axis: sep.axis === "x" ? "cols" : "rows",
            canonicalCells: sep.aSize,
          });
          if (!beganResize) return;
          dragging = {
            kind: "border",
            sep,
            originPointer: sep.axis === "x" ? screenX : y,
            lastSize: sep.aSize,
          };
          setStatusNote("resizing pane…");
          return;
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
          const depth = semanticView?.scrollbackDepth(paneId) ?? 0;
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
      // Release ends a live selection: the semanticView copies what was dragged; the
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
        const surface = semanticApplicationShell().primaryNavigation.items[i];
        if (surface)
          executeSurfaceCommand(surface.id, { kind: "mouse", surface: "application-bar" });
        return;
      }
      const gy = y - TABBAR_H;
      if (x < sidebarW()) {
        if (type !== "down") return;
        // The footer hint's "F5 palette" segment is a chip (last screen row).
        if (y === dims().height - 1) {
          if (spanHit([sidebarHint().buttonSpan], x) === 0) {
            executePaletteCommand(true, { kind: "mouse", surface: "sidebar" });
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
          const projection = filesSurfaceProjection();
          const hit = projection ? filesSession()?.hitTest(x - sidebarW(), gy) : null;
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
        if (!filesSession()?.hasBuffer) return;
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
          filesSession()?.setCursor(line, r.to);
          selecting = null;
        } else {
          filesSession()?.setCursor(line, col);
          selAnchor = { row: line, col };
          selecting = { surface: "editor" };
          setSelection(null);
        }
        return;
      }
      // DIFF mode: header (gy=0) + rule (gy=1), body from gy=2, footer verbs on
      // the last screen row. Left column [0,listW) is the grouped file list, the
      // rest is the diff. Wheel scrolls whichever column the pointer is over; a
      // left-column click selects that file ROW (headers are inert), and the
      // row's right-anchored [s stage]/[u unstage] chip wins over selection.
      if (mode() === "diff") {
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir !== "up" && dir !== "down") return;
          changesSession()?.handlePointer({
            type: "scroll",
            x: x - sidebarW(),
            y: gy,
            direction: dir,
            scrollStep: SCROLL_STEP,
            outsideBody: "diff",
          });
          return;
        }
        if (type !== "down") return;
        changesSession()?.handlePointer({
          type: "down",
          x: x - sidebarW(),
          y: gy,
          button: e.button,
        });
        return;
      }
      // The per-window strip (gy=0) — resolved by the SAME x-span math the render
      // lays out, so the formerly-swallowed segment clicks now land.
      if (gy === 0) {
        if (type !== "down") return;
        activateWindowStripAt(x);
        return;
      }
      const cx = x - sidebarW();
      const cy = gy - HEADER_ROWS;
      const pane = panes().find(
        (p) => cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height,
      );
      if (!pane) return;
      if (type === "down") {
        if (submitSemanticPaneFocus(pane.id) !== "submitted") return;
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
            trimBase: semanticView?.lineTrim(pane.id) ?? 0,
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
          selTrimBase = semanticView?.lineTrim(pane.id) ?? 0;
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
    const richWidgetOverlay = (paneId: string) => (
      <For each={richPlacementsFor(paneId)}>
        {(placement) => {
          const rect = placement.hostRect!;
          return (
            <Show when={richWidgetFor(placement)}>
              {(surface) => (
                <box
                  id={placement.renderableId}
                  position="absolute"
                  left={rect.left}
                  top={rect.top}
                  width={rect.width}
                  height={rect.height}
                  overflow="hidden"
                >
                  <TuiRichWidgetSurface
                    surface={surface()}
                    theme={semanticTheme()}
                    syntaxStyle={markdownSyntaxStyle()}
                    width={rect.width}
                    height={rect.height}
                  />
                </box>
              )}
            </Show>
          );
        }}
      </For>
    );
    const interaction = createMemo(() => {
      dialogRev();
      return tuiInteractionPresentation({
        dialogOpen: dialogStack.depth() > 0,
        menuOpen: Boolean(menu()),
        paletteOpen: paletteOpen(),
        searchOpen: Boolean(search()),
        surface: mode() === "mirror" ? "mirror" : mode(),
        focusZone: workbenchProjection().focusZone,
        dockMode: workbenchProjection().dockMode,
        activeDockTab: activeDockTab(),
        missionMode: missionsActivitySession()?.missionMode() ?? "board",
        editorFocus: filesFocus(),
        editorFilterOpen: filesQuery() !== null,
        diffFilterOpen: diffFilterOpen(),
        homePromptOpen: pathPrompt() !== null || sessionPrompt() !== null,
        hosted: HOSTED,
      });
    });
    return (
      <box
        flexDirection="column"
        flexGrow={1}
        backgroundColor={semanticTheme().roles.surfaces.canvas}
        onMouse={(e: RouteEvent) => route(e)}
      >
        <ApplicationShell
          theme={semanticTheme()}
          projection={applicationShellProjection()}
          help={interaction().help}
          interactionMode={interaction().mode}
          focusLabel={interaction().focus}
          note={note()}
          rightChips={tabbarButtons().defs.map((button, index) => ({
            id: button.id,
            label: button.label,
            hovered: isHovered("tabbtn", index),
            context: button.id === "tab-context",
          }))}
          sidebar={
            <Sidebar
              theme={semanticTheme()}
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
          }
        >
          <WorkbenchShell
            theme={semanticTheme()}
            projection={workbenchProjection()}
            onDockTabActivate={(tabId, source) =>
              executeSurfaceCommand(tabId, { kind: source, surface: "bottom-dock" })
            }
            onDockActionActivate={(_actionId, nextMode, source) => {
              executeDockModeCommand(nextMode, { kind: source, surface: "bottom-dock" });
              executeFocusCommand(
                {
                  kind: "zone",
                  zone: nextMode === "collapsed" ? "dock-tabs" : "dock-body",
                },
                { kind: source, surface: "bottom-dock" },
              );
            }}
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
                        <box paddingLeft={1} flexDirection="row">
                          <text fg={semanticTheme().roles.text.secondary}>
                            {windowStripParts().pre}
                          </text>
                          <text
                            fg={semanticTheme().roles.selection.selectionText}
                            bg={semanticTheme().roles.selection.selection}
                          >
                            {windowStripParts().active}
                          </text>
                          <text fg={semanticTheme().roles.text.secondary}>
                            {windowStripParts().post}
                          </text>
                          <text fg={semanticTheme().roles.text.secondary}> </text>
                          <text
                            fg={semanticTheme().roles.text.primary}
                            bg={
                              isHovered("windowtab", windowTabs().length)
                                ? semanticTheme().colors.buttonHover
                                : semanticTheme().roles.surfaces.header
                            }
                            attributes={1}
                          >
                            {WINDOW_ADD_LABEL}
                          </text>
                          {/* Window-level indicators remain on row zero; pane-level
                  zoom/split controls now live in each pane's own chrome row. */}
                          <Show when={isZoomed()}>
                            <text
                              fg={semanticTheme().roles.selection.selectionText}
                              bg={semanticTheme().roles.selection.selection}
                              attributes={1}
                            >
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
                        <SharedTerminalPaneChromeLayer
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
                        backgroundColor={semanticTheme().roles.surfaces.terminal}
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
                                  backgroundColor={semanticTheme().roles.surfaces.terminal}
                                  overflow="hidden"
                                >
                                  <For each={paneSelRows(pane)}>
                                    {(runs) => (
                                      <box flexDirection="row" height={1}>
                                        <For each={runs}>
                                          {(run) => (
                                            <text
                                              fg={packedToRgba(
                                                run.fg,
                                                semanticTheme().roles.text.primary,
                                              )}
                                              bg={packedToRgba(
                                                run.bg,
                                                semanticTheme().roles.surfaces.terminal,
                                              )}
                                              attributes={run.attributes}
                                            >
                                              {run.text}
                                            </text>
                                          )}
                                        </For>
                                      </box>
                                    )}
                                  </For>
                                  {richWidgetOverlay(pane.id)}
                                  {/* Top-right badge family: the select-mode chip (M22.9,
                            passive text runs — presses bubble to the router) then
                            the scroll badge. */}
                                  <box position="absolute" right={1} top={0} flexDirection="row">
                                    <Show
                                      when={
                                        selectModePane() === pane.id && selectBadgeLabel(pane.width)
                                      }
                                    >
                                      <text
                                        fg={semanticTheme().roles.text.primary}
                                        bg={BUTTON_ACTIVE_BG}
                                        attributes={1}
                                      >
                                        {selectBadgeLabel(pane.width)!}
                                      </text>
                                    </Show>
                                    <Show when={pane.snapshot.scrollOffset > 0}>
                                      <text
                                        fg={semanticTheme().roles.text.primary}
                                        bg={semanticTheme().roles.surfaces.headerActive}
                                      >
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
                              const semanticReplica = () => semanticReplicaForRuntime(id);
                              return (
                                <Show when={pane() && semanticReplica()}>
                                  <box
                                    position="absolute"
                                    left={pane()!.left}
                                    top={pane()!.top}
                                    width={pane()!.width}
                                    height={pane()!.height}
                                    backgroundColor={semanticTheme().roles.surfaces.terminal}
                                    overflow="hidden"
                                  >
                                    <pane_surface
                                      width={pane()!.width}
                                      height={pane()!.height}
                                      mirror={semanticReplica()!.adapter.renderSource}
                                      paneId={semanticReplica()?.semanticPaneId ?? id}
                                      defaultFg={terminalPalette().foreground}
                                      defaultBg={terminalPalette().background}
                                      terminalPalette={terminalPalette()}
                                      searchHl={terminalPalette().searchHighlight}
                                      searchCur={terminalPalette().searchCurrent}
                                      scrollOffset={pane()!.snapshot.scrollOffset}
                                      paneFocused={paneIsFocused(id)}
                                      contentVersion={
                                        semanticPaneVersions().get(
                                          semanticReplica()?.semanticPaneId ?? "",
                                        ) ??
                                        paneRuntimeFor(id)?.version ??
                                        0
                                      }
                                      sourceEpoch={terminalRenderSourceEpoch()}
                                      selRange={mirrorSelForPane(id)}
                                      search={mirrorSearchForPane(pane()!)}
                                    />
                                    {richWidgetOverlay(id)}
                                    {/* Top-right badge family: the select-mode chip
                              (M22.9, passive text runs — presses bubble to the
                              router) then the scroll badge. */}
                                    <box position="absolute" right={1} top={0} flexDirection="row">
                                      <Show
                                        when={
                                          selectModePane() === id && selectBadgeLabel(pane()!.width)
                                        }
                                      >
                                        <text
                                          fg={semanticTheme().roles.text.primary}
                                          bg={BUTTON_ACTIVE_BG}
                                          attributes={1}
                                        >
                                          {selectBadgeLabel(pane()!.width)!}
                                        </text>
                                      </Show>
                                      <Show when={pane()!.snapshot.scrollOffset > 0}>
                                        <text
                                          fg={semanticTheme().roles.text.primary}
                                          bg={semanticTheme().roles.surfaces.headerActive}
                                        >
                                          {` ↑${pane()!.snapshot.scrollOffset}/${paneScrollbackDepth(pane()!)} `}
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
                        <TerminalPaneCommunicationLayer
                          theme={semanticTheme()}
                          layout={terminalPaneChromeLayout()}
                        />
                        {/* Lower-pane headers reuse only tmux's existing horizontal
                  separator cells. Focus belongs to this semantic pane chrome,
                  while the pure projection proves no emitted rectangle
                  intersects a pane framebuffer. */}
                        <SharedTerminalPaneChromeLayer
                          theme={semanticTheme()}
                          layout={terminalPaneChromeLayout()}
                          layer="framebuffer"
                        />
                        {/* Pointer affordance for tmux-native pane dividers. The
                  quiet guide appears on hover; the saturated guide follows the
                  clamped preview position during capture. It is an overlay only
                  and never changes framebuffer/tmux size calculations. */}
                        <Show when={paneResizeGuide()}>
                          {(guide) => (
                            <box
                              position="absolute"
                              left={guide().rect.x}
                              top={guide().rect.y}
                              width={guide().rect.width}
                              height={guide().rect.height}
                              backgroundColor={
                                guide().active
                                  ? semanticTheme().colors.accent
                                  : semanticTheme().colors.accentMuted
                              }
                            />
                          )}
                        </Show>
                        {/* Size-truth hint (M22.8): quiet, dismiss-free, shown ONLY while
                  a co-attached terminal has sized the window away from our canvas
                  (the letterboxed grid is centered beneath it). It states the
                  honest actual size — the iTerm2-style answer — and disappears the
                  moment the sizes agree. A handler-less box in the top gutter, so
                  no pointer routing changes. */}
                        <Show when={windowMismatch()}>
                          <box
                            position="absolute"
                            left={1}
                            top={0}
                            backgroundColor={semanticTheme().roles.surfaces.headerActive}
                          >
                            <text
                              fg={semanticTheme().roles.text.secondary}
                            >{` ${formatSizeHint(windowMismatch()!)} `}</text>
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
                          backgroundColor={semanticTheme().roles.surfaces.command}
                          paddingLeft={1}
                          paddingRight={1}
                        >
                          <text fg={semanticTheme().roles.text.link} attributes={1}>
                            {search()!.editing ? "/" : "search "}
                          </text>
                          <text
                            fg={semanticTheme().roles.text.primary}
                          >{`${search()!.query}${search()!.editing ? "▏" : ""}`}</text>
                          <box flexGrow={1} />
                          <text fg={semanticTheme().roles.text.muted}>{searchStatus()}</text>
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
                  <Show
                    when={filesFeature()}
                    fallback={
                      <box
                        width="100%"
                        height="100%"
                        flexDirection="column"
                        justifyContent="center"
                        alignItems="center"
                        backgroundColor={semanticTheme().roles.surfaces.panel}
                      >
                        <text fg={semanticTheme().roles.text.secondary}>
                          {filesFeatureLoadState() === "failed"
                            ? "Files unavailable · reopen to retry"
                            : "Loading Files…"}
                        </text>
                      </box>
                    }
                  >
                    {(feature) => (
                      <Show when={filesSurfaceProjection()}>
                        {(projection) => (
                          <Dynamic
                            component={feature().FilesSurface}
                            theme={semanticTheme()}
                            projection={projection()}
                            colors={{
                              gutterBg: GUTTER_BG,
                              gutterFg: GUTTER_FG,
                              cursorBg: CURSOR_BG,
                              modifiedFg: MODIFIED_FG,
                              statusLetterFg: STATUS_LETTER_FG,
                            }}
                          />
                        )}
                      </Show>
                    )}
                  </Show>
                </Show>
                <Show when={activeDockTab() === "changes"}>
                  <Show
                    when={changesFeature()}
                    fallback={
                      <box
                        width="100%"
                        height="100%"
                        flexDirection="column"
                        justifyContent="center"
                        alignItems="center"
                        backgroundColor={semanticTheme().roles.surfaces.panel}
                      >
                        <text fg={semanticTheme().roles.text.secondary}>
                          {changesFeatureLoadState() === "failed"
                            ? "Changes unavailable · reopen to retry"
                            : "Loading Changes…"}
                        </text>
                      </box>
                    }
                  >
                    {(feature) => (
                      <Show when={changesSurfaceProjection()}>
                        {(projection) => (
                          <Dynamic
                            component={feature().ChangesSurface}
                            theme={semanticTheme()}
                            projection={projection()}
                            colors={{
                              gutterBg: GUTTER_BG,
                              gutterFg: GUTTER_FG,
                              statusLetterFg: STATUS_LETTER_FG,
                              diffFg: DIFF_FG,
                              diffLineBg: DIFF_LINE_BG,
                            }}
                          />
                        )}
                      </Show>
                    )}
                  </Show>
                </Show>
                <Show when={activeDockTab() === "missions" || activeDockTab() === "activity"}>
                  <Show
                    when={missionsActivityFeature()}
                    fallback={
                      <box
                        width="100%"
                        height="100%"
                        flexDirection="column"
                        justifyContent="center"
                        alignItems="center"
                        backgroundColor={semanticTheme().roles.surfaces.panel}
                      >
                        <text fg={semanticTheme().roles.text.secondary}>
                          {missionsActivityLoadState() === "failed"
                            ? "Missions and Activity unavailable · reopen to retry"
                            : "Loading Missions and Activity…"}
                        </text>
                      </box>
                    }
                  >
                    {(feature) => (
                      <Show when={missionsActivitySession()}>
                        {(session) => (
                          <Show
                            when={activeDockTab() === "missions"}
                            fallback={
                              <Dynamic
                                component={feature().ActivitySurface}
                                theme={semanticTheme()}
                                projection={session().activityProjection()}
                              />
                            }
                          >
                            <Dynamic
                              component={feature().MissionsSurface}
                              width={dockSurfaceWidth()}
                              dashboard={session().missionProjection()}
                              model={session().missionModel()}
                              snapshot={session().missionSnapshot()}
                              loadState={session().missionLoadState()}
                              errorMessage={session().missionErrorMessage()}
                              resolveDeepLink={session().resolveDeepLink}
                              isHovered={isHovered}
                              theme={semanticTheme()}
                            />
                          </Show>
                        )}
                      </Show>
                    )}
                  </Show>
                </Show>
              </>
            }
          />
        </ApplicationShell>
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
              backgroundColor={semanticTheme().roles.surfaces.command}
              border
              borderColor={semanticTheme().roles.borders.focused}
              paddingLeft={1}
              paddingRight={1}
            >
              <box flexDirection="row">
                <text fg={semanticTheme().roles.text.link} attributes={1}>
                  {"⎘ Paste buffer"}
                </text>
                <box flexGrow={1} />
                <text fg={semanticTheme().roles.text.muted}>{"esc back"}</text>
              </box>
              <text fg={semanticTheme().roles.borders.subtle}>{"─".repeat(paletteW() - 4)}</text>
              <For each={paletteBuffers()!.slice(paletteTop(), paletteTop() + PALETTE_ROWS)}>
                {(b, i) => (
                  <box
                    height={1}
                    flexDirection="row"
                    backgroundColor={
                      paletteTop() + i() === paletteSel()
                        ? semanticTheme().roles.selection.selection
                        : semanticTheme().roles.surfaces.command
                    }
                  >
                    <text
                      fg={
                        paletteTop() + i() === paletteSel()
                          ? semanticTheme().roles.selection.selectionText
                          : semanticTheme().roles.text.secondary
                      }
                    >
                      {`${paletteTop() + i() === paletteSel() ? "› " : "  "}${b.name}  `}
                    </text>
                    <text fg={semanticTheme().roles.text.muted}>{b.preview}</text>
                  </box>
                )}
              </For>
              <Show when={paletteBuffers()!.length === 0}>
                <text fg={semanticTheme().roles.text.muted}>{"  no buffers"}</text>
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
            backgroundColor={semanticTheme().roles.surfaces.command}
            border
            borderColor={semanticTheme().roles.borders.focused}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={semanticTheme().roles.text.link} attributes={1}>
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
                  armed()
                    ? DIFF_DEL_FG
                    : selected() || inputting()
                      ? semanticTheme().roles.selection.selectionText
                      : semanticTheme().roles.text.secondary;
                const bg = () =>
                  selected() || armed() || inputting()
                    ? semanticTheme().roles.selection.selection
                    : semanticTheme().roles.surfaces.command;
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
            backgroundColor={semanticTheme().roles.surfaces.command}
            border
            borderColor={semanticTheme().roles.borders.focused}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={semanticTheme().roles.text.link} attributes={1}>
              {(menu()!.items[menuSub()!]?.label ?? "")
                .slice(0, submenuGeom()!.width - 4)
                .padEnd(submenuGeom()!.width - 4)}
            </text>
            <For each={submenuItems() ?? []}>
              {(it, i) => {
                const innerW = () => submenuGeom()!.width - 4;
                const selected = () => menuSubSel() === i();
                return (
                  <box
                    height={1}
                    backgroundColor={
                      selected()
                        ? semanticTheme().roles.selection.selection
                        : semanticTheme().roles.surfaces.command
                    }
                  >
                    <text
                      fg={
                        selected()
                          ? semanticTheme().roles.selection.selectionText
                          : semanticTheme().roles.text.secondary
                      }
                    >
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
            backgroundColor={semanticTheme().roles.surfaces.command}
            border
            borderColor={previewAccent() ?? semanticTheme().roles.borders.focused}
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
                <text
                  fg={semanticTheme().roles.text.primary}
                >{`${dlgSelect()!.state.query}▏`}</text>
              </box>
            </Show>
            <text fg={semanticTheme().roles.borders.subtle}>{"─".repeat(dialogInnerWidth())}</text>
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
                  item.current
                    ? dlgAccent()
                    : selected()
                      ? semanticTheme().roles.selection.selectionText
                      : semanticTheme().roles.text.secondary;
                const bodyFg = () =>
                  armed()
                    ? DIFF_DEL_FG
                    : selected()
                      ? semanticTheme().roles.selection.selectionText
                      : semanticTheme().roles.text.secondary;
                return (
                  <box
                    height={1}
                    flexDirection="row"
                    backgroundColor={
                      selected() || armed()
                        ? semanticTheme().roles.selection.selection
                        : semanticTheme().roles.surfaces.command
                    }
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
              <text fg={semanticTheme().roles.text.muted}>{"  no matches"}</text>
            </Show>
            <text fg={semanticTheme().roles.text.muted}>
              {selectFooter(dlgSelectSpec()).slice(0, dialogInnerWidth())}
            </text>
          </box>
        </Show>
        <Show when={dlgPrompt()}>
          <box
            position="absolute"
            left={dialogPos(dims().width, dims().height, dialogW()).left}
            top={dialogPos(dims().width, dims().height, dialogW()).top}
            width={dialogW()}
            flexDirection="column"
            backgroundColor={semanticTheme().roles.surfaces.command}
            border
            borderColor={semanticTheme().roles.borders.focused}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={semanticTheme().roles.text.link} attributes={1}>
              {dlgPromptSpec().title.slice(0, dialogInnerWidth()).padEnd(dialogInnerWidth())}
            </text>
            <text fg={semanticTheme().roles.borders.subtle}>{"─".repeat(dialogInnerWidth())}</text>
            <box flexDirection="row">
              <text fg={semanticTheme().roles.text.link} attributes={1}>
                {"▸ "}
              </text>
              <Show
                when={dlgPrompt()!.state.input.length === 0 && dlgPromptSpec().placeholder}
                fallback={
                  <text
                    fg={semanticTheme().roles.text.primary}
                  >{`${dlgPrompt()!.state.input}▏`}</text>
                }
              >
                <text fg={semanticTheme().roles.text.primary}>{"▏"}</text>
                <text
                  fg={semanticTheme().roles.text.muted}
                >{` ${dlgPromptSpec().placeholder}`}</text>
              </Show>
            </box>
            <text
              fg={
                promptFooter(dlgPromptSpec(), dlgPrompt()!.state).error
                  ? semanticTheme().roles.statusTone.danger
                  : semanticTheme().roles.text.muted
              }
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
            backgroundColor={semanticTheme().roles.surfaces.command}
            border
            borderColor={semanticTheme().roles.borders.focused}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={semanticTheme().roles.text.link} attributes={1}>
              {dlgConfirmSpec().title.slice(0, dialogInnerWidth()).padEnd(dialogInnerWidth())}
            </text>
            <text fg={semanticTheme().roles.borders.subtle}>{"─".repeat(dialogInnerWidth())}</text>
            <For
              each={
                dlgConfirmSpec().body ? wrapText(dlgConfirmSpec().body!, dialogInnerWidth()) : []
              }
            >
              {(line) => <text fg={semanticTheme().roles.text.secondary}>{line || " "}</text>}
            </For>
            <For each={confirmOptions(dlgConfirmSpec())}>
              {(label, i) => {
                const selected = () => dlgConfirm()!.state.sel === i();
                return (
                  <box
                    height={1}
                    backgroundColor={
                      selected()
                        ? semanticTheme().roles.selection.selection
                        : semanticTheme().roles.surfaces.command
                    }
                  >
                    <text
                      fg={
                        selected()
                          ? semanticTheme().roles.selection.selectionText
                          : semanticTheme().roles.text.secondary
                      }
                    >
                      {`${selected() ? "› " : "  "}${label}`.slice(0, dialogInnerWidth())}
                    </text>
                  </box>
                );
              }}
            </For>
            <text fg={semanticTheme().roles.text.muted}>{confirmFooter()}</text>
          </box>
        </Show>
      </box>
    );
  }, appRenderer);
  // Native render lifetime ends only after lifecycle retirement. Observe a
  // spontaneous root failure without registering the root promise as a
  // closer (that would deadlock renderer-last shutdown).
  void root.catch(() => applicationLifecycle.shutdown("bootstrap-error"));
  return { root, ready: inputReady };
};

export async function startApplicationRoot(): Promise<void> {
  await startTuiApplication({
    argv: process.argv.slice(2),
    parseArgs: parseTuiAppArgs,
    loadConfig: loadTuiAppConfig,
    createRenderer: createTuiRenderer,
    createLifecycle: createTuiLifecycle,
    mountRoot: mountTuiRoot,
    publishReady() {
      publishTuiInputReady("app");
      publishToolReadiness();
    },
  });
}
