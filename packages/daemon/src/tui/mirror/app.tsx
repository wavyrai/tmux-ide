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
 * SURFACE TABS (M18.4): a persistent top row — [⌂ Home][❯ Terminal][▤ Files]
 * [± Diff] — makes the app a real IDE. F1..F4 switch (F-keys encode reliably;
 * ctrl+digit/alt do NOT — measured); the tab bar is also clickable (fixed x-span
 * math in `TAB_SPANS`). The active `tab()` is the source of truth; `mode()` is a
 * DERIVED view (home|mirror|editor|diff) so the per-surface render/route math is
 * unchanged. CRITICAL for the IDE feel: switching AWAY from Terminal does NOT
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
 * DIFF (M18.3): a two-column panel — left is the changed-file list (status letter
 * + path, selected row highlighted), right is the unified diff of the selected
 * file (add/del/hunk/context colored). Git runs via ASYNC execFile ONLY (the
 * landmine: no sync execs near the render loop; the one exception is reading a
 * single untracked file to show it as additions). `git status --porcelain` +
 * `git diff --no-color -- <file>` refresh on a 3s timer while mode=diff and on
 * manual `r`. j/k move the file selection; the wheel scrolls the diff (or the
 * file list when over the left column); a left-column click selects a file; `^e`
 * opens the selected file in the EDITOR at its repo-relative path. Pure parsing +
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
import { RGBA, EditBuffer, decodePasteBytes } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { SessionMirror, type LivePane } from "./session-mirror.ts";
import { registerPaneSurface, type PaneSearchHighlight } from "./pane-surface.tsx";
import { tapInputSent, tapInputTick } from "./perf-tap.ts";
import { execFile, spawn } from "node:child_process";
import type { AgentStatus } from "../detect/classify.ts";
import { rollupChips, homeFooterHints, type FleetRollup } from "../team/home.ts";
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
  parseStatusPorcelain,
  classifyDiff,
  untrackedDiffText,
  clampSel,
  type StatusEntry,
  type DiffLineKind,
} from "./diff-model.ts";
import {
  loadAppState,
  saveAppState,
  addRecentFolder,
  addCustomCommand,
  clampSidebarWidth,
  isTab,
  rememberSpawn,
  spawnMemoryKey,
  type AppState,
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
  filterPaletteActions,
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
  DIALOG_W,
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
  keybindingItems,
  notificationItems,
  notificationTogglePatch,
  presetRgb,
  quietHoursItems,
  quietHoursOffPatch,
  quietHoursPatch,
  resetSettingsPatch,
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
  type NotificationToggleId,
  type SettingsCommandId,
} from "./settings-model.ts";
import { loadAppConfig, loadRawAppConfig, updateAppConfig } from "../../lib/app-config.ts";
import { parseNotificationPrefs } from "../chrome/notify.ts";
import {
  buildHomeItems,
  centerPad,
  clampSelectable,
  firstRunTip,
  isFirstRun,
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
  sidebarHit,
  AGENTS_ADD_CHIP,
  AGENTS_EMPTY_LINE,
  AGENTS_GAP_ROWS,
  type AgentRowInput,
} from "./agent-rows.ts";
import { STATUS_COLOR, STATUS_GLYPH } from "./status-grammar.ts";
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
import { agentsByPane, chipLabel } from "./agent-chip.ts";
import { focusStrips } from "./focus-border.ts";
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

const SIDEBAR_BG = RGBA.fromInts(22, 22, 30, 255);
const ACCENT = RGBA.fromInts(130, 170, 255, 255);
const MUTED = RGBA.fromInts(110, 110, 130, 255);
const BADGE_BG = RGBA.fromInts(60, 66, 92, 255);
// Focused-pane gutter hairline (M22.7): the ACCENT family, drawn as │/─ glyphs
// so the gutter stays visually thin (a filled bar read as extra padding — user
// feedback). Doesn't compete with the blocked chip's red — focus is an accent
// signal, agent state is a status signal, never the same hue.
const FOCUS_BORDER_FG = RGBA.fromInts(110, 145, 230, 255);
const TAB_ACTIVE_BG = RGBA.fromInts(40, 46, 66, 255);
// A single subtle pointer-hover tint, one lift above both DEFAULT_BG (16,16,22)
// and SIDEBAR_BG (22,22,30) and below TAB_ACTIVE_BG — the active/selected state
// always wins over hover. Used on every hoverable row/segment (see `hover`).
const HOVER_BG = RGBA.fromInts(30, 34, 48, 255);
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
  | "button"
  | "tabbtn"
  | "homechip"
  | "homeagentchip"
  | "welcomeopen"
  | "sidebtn"
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

const DEFAULT_FG = RGBA.fromInts(212, 212, 216, 255);
const DEFAULT_BG = RGBA.fromInts(16, 16, 22, 255);
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
const CHIP_ATTN_BG = RGBA.fromInts(92, 44, 48, 255);
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
const HEADER_ROWS = 2;
// The persistent surface-tab row is one screen row at the very top (above the
// sidebar + main region). Its height offsets every region's global y, so the
// router subtracts it once (`gy = y - TABBAR_H`) before the per-mode math.
const TABBAR_H = 1;
/** The four top-level surfaces, in F-key order (F1..F4). Glyphs are all
 *  single display-width so the tab-bar x-span math (`TAB_SPANS`) is exact. */
const TABS: { key: Tab; label: string; glyph: string; fkey: string }[] = [
  { key: "home", label: "Home", glyph: "⌂", fkey: "f1" },
  { key: "terminal", label: "Terminal", glyph: "❯", fkey: "f2" },
  { key: "files", label: "Files", glyph: "▤", fkey: "f3" },
  { key: "diff", label: "Diff", glyph: "±", fkey: "f4" },
];
/** One tab cell's rendered string (leading + trailing pad); width === length
 *  because every glyph above is single-width. */
const tabCell = (t: { glyph: string; label: string }): string => ` ${t.glyph} ${t.label} `;
/** The surface bar's x-spans. TABS is static (mounted at initial render), so the
 *  layout is constant — computed once and shared by the router (hit test) and,
 *  implicitly, the render (which walks TABS with the same cell strings). */
const TAB_SPANS = spans(TABS.map(tabCell), 0, 0);
const PALETTE_W = 60;
const PALETTE_ROWS = 10;
// ── M21.9 clickable-chip labels ─────────────────────────────────────────────
// Fixed strings so the x-span math is constant (every glyph single-width). The
// home chips sit flush right on their row (trailing space = a 1-cell inset);
// the tab-bar labels are the EXACT strings the bar renders, so `spansFromRight`
// lands cell-for-cell on what's drawn.
const HOME_CHIP_SESSION = "[± diff] ";
const HOME_CHIP_PROJECT = "[▸ launch] ";
const HOME_CHIP_RECENT = "[▸ open] ";
// The spawn verb's home entry (M23.1): session/project rows carry a second
// chip left of the primary one; `a` is its keyboard twin.
const HOME_CHIP_AGENT = "[+ agent] ";
const TABBAR_PALETTE_LABEL = "F5 ⌘ palette ";
// ── M22.5 first-run welcome ─────────────────────────────────────────────────
// A centered greeting shown only on a truly empty fleet (no sessions, no
// registered projects). WELCOME_ROWS rows in the content area (gy 2…); the
// clickable "open a folder" action sits at WELCOME_ACTION_ROW. The render
// centers each line with the same centerPad the router hit-tests with.
const WELCOME_LINE = "Welcome to tmux-ide — a cockpit for the tmux sessions you already have.";
const WELCOME_ACTION_LABEL = "▸ open a folder — press f";
const WELCOME_ROWS = 6;
const WELCOME_ACTION_ROW = 3; // 0-based within the welcome block
// HOSTED mode (M23.2): the detachable-cockpit launcher stamps this marker on
// the app's pane command inside `_tmux-ide-app`. ^q then detaches the tmux
// client instead of exiting (the cockpit survives the terminal); every "^q
// quit" hint reads "detach" so the keycap tells the truth.
const HOSTED = process.env.TMUX_IDE_HOSTED === "1";
const QUIT_HINT = HOSTED ? "^q detach" : "^q quit";
// The sidebar footer hint, split so its "F5 palette" segment is a chip: the
// span starts after paddingLeft (1) + the pre text.
const SIDEBAR_HINT_PRE = "F1-4 tabs · ";
const SIDEBAR_HINT_BTN = "F5 palette";
const SIDEBAR_HINT_POST = ` · ${QUIT_HINT}`;
const SIDEBAR_HINT_SPAN = { start: 1 + SIDEBAR_HINT_PRE.length, width: SIDEBAR_HINT_BTN.length };
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
const BUTTON_HOVER_BG = RGBA.fromInts(52, 60, 86, 255);
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

render(
  () => {
    // Register <pane_surface> before any is created (M21.3). An explicit call —
    // a bare side-effect import of the module gets DCE'd by the transpiler.
    if (FB_PANES) registerPaneSurface();
    const dims = useTerminalDimensions();
    const canvasCols = () => Math.max(20, dims().width - sidebarW());
    const canvasRows = () => Math.max(4, dims().height - HEADER_ROWS - TABBAR_H);

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
    const [sidebarW, setSidebarW] = createSignal(clampSidebarWidth(persisted.sidebarW));
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
    // The first-run tip line — the user's ACTUAL keybindings, read once at launch
    // (loadAppConfig honors TMUX_IDE_CONFIG). Cheap + pure, computed once.
    const welcomeTip = firstRunTip(loadAppConfig().keys);
    // The active surface TAB is the source of truth. Explicit CLI args win, else a
    // real `--target` boots into Terminal, else the persisted tab, else Home.
    const initialTab: Tab = startDiff
      ? "diff"
      : values.edit !== undefined
        ? "files"
        : !bareHome
          ? "terminal"
          : isTab(persisted.lastTab)
            ? persisted.lastTab
            : "home";
    const [tab, setTab] = createSignal<Tab>(initialTab);
    // The four render/route branches were written against a `mode` of
    // home|mirror|editor|diff; keep that vocabulary as a DERIVED view of `tab` so
    // the per-surface geometry math is untouched — only the top-level switching
    // and state-retention change.
    const mode = (): "home" | "mirror" | "editor" | "diff" =>
      tab() === "terminal"
        ? "mirror"
        : tab() === "files"
          ? "editor"
          : tab() === "diff"
            ? "diff"
            : "home";

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

    // ── SELECTION & CLIPBOARD (M19.4) ────────────────────────────────────────
    // The visible selection (drives inverse-tint on the mirror/editor render) and
    // the gesture state machine driving it. `selecting` marks a drag in progress
    // (null = none, discrete word/line selections leave it null); `selAnchor` is
    // where the drag began; `lastClick` tracks click-count for double/triple. A
    // transient `note` reuses the status channel for "copied/pasted N chars".
    const [selection, setSelection] = createSignal<Selection | null>(null);
    let selecting: { surface: "mirror"; paneId: string } | { surface: "editor" } | null = null;
    let selAnchor: Cell = { row: 0, col: 0 };
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
      if (selection() !== null) setSelection(null);
    };

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
    // cell the user pressed. Only one of {pendingPress, selecting, dragging}
    // is ever live.
    let pendingPress: { paneId: string; x: number; gy: number; cell: Cell } | null = null;
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
    const homeItems = createMemo<HomeItem[]>(() => buildHomeItems(projectsData(), recentFolders()));
    // First-run (M22.5): a truly empty fleet gets a centered welcome. It reserves
    // WELCOME_ROWS at the top of the content area, so the home row math shifts by
    // that offset while it shows (shared by render, hover and click routing).
    const firstRun = () => isFirstRun(projectsData());
    const welcomeOffset = () => (firstRun() ? WELCOME_ROWS : 0);
    /** The centered x-span [start, end) of the welcome's clickable action — the
     *  render draws the label after the same centerPad, so a click lands on it. */
    const welcomeActionSpan = (): [number, number] => {
      const start = sidebarW() + centerPad(canvasCols(), WELCOME_ACTION_LABEL.length);
      return [start, start + WELCOME_ACTION_LABEL.length];
    };
    /** Whether (gy, x) hits the welcome action row (only while first-run). */
    const welcomeActionHit = (gy: number, x: number): boolean => {
      if (!firstRun() || gy - 2 !== WELCOME_ACTION_ROW) return false;
      const [x0, x1] = welcomeActionSpan();
      return x >= x0 && x < x1;
    };
    /** The home item index under content-row gy (accounting for the welcome
     *  offset), or -1 when gy is above the first row / on the welcome block. */
    const homeItemIndexAt = (gy: number): number => {
      const idx = gy - 2 - welcomeOffset();
      return idx >= 0 ? idx : -1;
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
    // A path-input line on HOME (`o` to open). null = not prompting.
    const [pathPrompt, setPathPrompt] = createSignal<string | null>(null);
    // A session-name input line on HOME (`n` / the [n new session] chip).
    const [sessionPrompt, setSessionPrompt] = createSignal<string | null>(null);

    // Visible text rows = full height minus tab bar (1) + header (1) + rule/banner
    // (1) + footer (1).
    const editorRows = () => Math.max(1, dims().height - 3 - TABBAR_H);
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

    const openEditor = (rawPath: string) => {
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
      if (mode() !== "editor") prevMode = mode() === "mirror" ? "mirror" : "home";
      setEditorPath(path);
      setEditorReadOnly(reason);
      setEditorModified(false);
      setEditorTop(0);
      setEditorMsg("");
      setEditorRev((r) => r + 1);
      setFilesFocus("editor");
      setTab("files");
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
      } else if (!ro && name.length === 1 && !evt.ctrl && !evt.meta) {
        eb.insertText(evt.shift ? name.toUpperCase() : name);
        setEditorModified(true);
      } else {
        return; // unhandled key: no re-render, no scroll churn
      }
      editorSyncScroll();
      setEditorRev((r) => r + 1);
    };

    // ── DIFF (M18.3) ────────────────────────────────────────────────────────
    // The working-tree diff of `diffDir`, rendered natively. Git runs via async
    // execFile (`runGit`); the only sync io is reading a single untracked file to
    // show it as additions. `diffText` holds the raw diff for the selected file;
    // `diffLoadToken` discards a slow diff whose selection has since moved on.
    const [diffDir, setDiffDir] = createSignal(values.diff ?? invokeCwd);
    const [diffFiles, setDiffFiles] = createSignal<StatusEntry[]>([]);
    const [diffSel, setDiffSel] = createSignal(0);
    const [diffText, setDiffText] = createSignal("");
    const [diffTop, setDiffTop] = createSignal(0); // diff-pane scroll (right)
    const [diffFileTop, setDiffFileTop] = createSignal(0); // file-list scroll (left)
    const [diffMsg, setDiffMsg] = createSignal("");
    let diffLoadToken = 0;
    // A diff file to re-select once `git status` repopulates the list (restore).
    let pendingDiffFile: string | null = persisted.diffFile;

    // Body rows below header (1) + rule (1), above the footer (1) — shared by both
    // columns. The left column width is a capped fraction of the canvas.
    const diffBodyRows = () => Math.max(1, dims().height - 3 - TABBAR_H);
    const diffListW = () => Math.max(20, Math.min(48, Math.floor(canvasCols() * 0.34)));
    const diffLines = createMemo(() => classifyDiff(diffText()));
    const diffVisible = createMemo(() => {
      const lines = diffLines();
      const rows = diffBodyRows();
      const top = clampTop(diffTop(), lines.length, rows);
      return lines.slice(top, top + rows);
    });
    const fileVisible = createMemo(() => {
      const files = diffFiles();
      const rows = diffBodyRows();
      const top = clampTop(diffFileTop(), files.length, rows);
      return files.slice(top, top + rows).map((entry, i) => ({ entry, index: top + i }));
    });

    const runGit = (args: string[], cb: (out: string) => void) => {
      execFile(
        "git",
        ["-C", diffDir(), "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", ...args],
        { timeout: 10_000, maxBuffer: 16_000_000 },
        (err, stdout) => cb(err ? "" : stdout),
      );
    };

    /** Load the diff for one file: async `git diff` for tracked paths (falling
     *  back to `--cached` when the change is staged-only), or the untracked file's
     *  contents rendered as additions. Guarded by `diffLoadToken` against races. */
    const loadDiff = (entry: StatusEntry) => {
      const token = ++diffLoadToken;
      setDiffMsg("");
      if (entry.status === "?") {
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
      runGit(["diff", "--no-color", "--", entry.path], (out) => {
        if (token !== diffLoadToken) return;
        if (out.trim()) {
          setDiffText((p) => (p === out ? p : out));
          return;
        }
        runGit(["diff", "--no-color", "--cached", "--", entry.path], (cached) => {
          if (token !== diffLoadToken) return;
          setDiffText((p) => (p === cached ? p : cached));
        });
      });
    };

    /** Select file `i`: highlight it, reset the diff scroll, keep it in view in the
     *  file list, and (re)load its diff. */
    const selectDiffFile = (i: number) => {
      const files = diffFiles();
      if (files.length === 0) return;
      const idx = clampSel(i, files.length);
      setDiffSel(idx);
      setDiffTop(0);
      setDiffFileTop((t) => scrollToCursor(idx, t, diffBodyRows(), files.length));
      loadDiff(files[idx]!);
    };
    const moveDiffSel = (delta: number) => selectDiffFile(diffSel() + delta);

    /** Re-run `git status --porcelain`, reconcile the selection, and reload the
     *  selected file's diff (so an external edit is reflected). */
    const refreshStatus = () => {
      runGit(["status", "--porcelain"], (out) => {
        const files = parseStatusPorcelain(out);
        setDiffFiles(files);
        if (files.length === 0) {
          setDiffText("");
          setDiffSel(0);
          setDiffMsg("working tree clean");
          return;
        }
        // Restore: re-select the persisted diff file once it appears in the list.
        if (pendingDiffFile) {
          const restored = files.findIndex((f) => f.path === pendingDiffFile);
          pendingDiffFile = null;
          if (restored !== -1) {
            selectDiffFile(restored);
            return;
          }
        }
        const idx = clampSel(diffSel(), files.length);
        setDiffSel(idx);
        loadDiff(files[idx]!);
      });
    };

    /** Enter the diff panel for `dir` (from home `d`, the Diff tab, or `--diff`
     *  on boot). */
    const enterDiff = (dir: string) => {
      setDiffDir(dir);
      setDiffSel(0);
      setDiffTop(0);
      setDiffFileTop(0);
      setDiffText("");
      setDiffMsg("");
      setTab("diff");
      refreshStatus();
    };

    let mirror: SessionMirror | null = null;
    // ── EVENT-DRIVEN RE-PIN (M23.5) ──────────────────────────────────────────
    // The 200ms canvas size poll is gone: a createEffect on the renderer dims
    // signal (canvasCols/canvasRows read dims() + sidebarW()) re-pins the
    // mirror the moment the size actually changes. `lastPin` is what we last
    // asked tmux for; `repinInFlight` gates the size-truth hint while tmux
    // confirms (D4b — see the tick).
    let lastPin: Size = { cols: canvasCols(), rows: canvasRows() };
    let repinInFlight: RepinState | null = null;
    createEffect(() => {
      const next: Size = { cols: canvasCols(), rows: canvasRows() };
      if (next.cols === lastPin.cols && next.rows === lastPin.rows) return;
      repinInFlight = { prev: lastPin, at: performance.now() };
      lastPin = next;
      void mirror?.resize(next.cols, next.rows);
    });
    const attach = (name: string) => {
      mirror?.dispose();
      scrollOffsets.clear();
      setPanes([]);
      setStatus(`attaching ${name}…`);
      // A fresh mirror pins at the current canvas size — no re-pin in flight.
      lastPin = { cols: canvasCols(), rows: canvasRows() };
      repinInFlight = null;
      const m = new SessionMirror({
        target: name,
        cols: lastPin.cols,
        rows: lastPin.rows,
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
        setTab("terminal");
        return;
      }
      setCurTarget(name);
      setTab("terminal");
      attach(name);
    };
    /** ^g / F1 — show the HOME tab. The mirror is KEPT ALIVE (it keeps streaming
     *  in the background so a back-switch is instant); the session is untouched. */
    const goHome = () => {
      clearSelection();
      setTab("home");
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
    // Which half of the Files tab has the keyboard: the file LIST (j/k/enter) or
    // the EDITOR (typing). Opening a file hands focus to the editor; esc hands it
    // back to the list.
    const [filesFocus, setFilesFocus] = createSignal<"list" | "editor">("list");
    const filesListW = () => Math.max(20, Math.min(44, Math.floor(canvasCols() * 0.34)));
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
    onCleanup(() => void stopFilesWatch?.().catch(() => {}));
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
    onCleanup(() => clearInterval(filesStatusPoll));

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
        if (!err) decorate(stdout);
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
    // optional, skippable offers: remember the project, and (if no ide.yml) set
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

    /** ASYNC — whether `dir` already has an ide.yml (skip the layout offer). */
    const hasIdeYml = async (dir: string): Promise<boolean> =>
      (await pathKind(join(dir, "ide.yml"))) === "file";

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

    /** Write a starter ide.yml for `dir` via `tmux-ide detect --write` (async
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
      if (!(await hasIdeYml(dir))) {
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

    /** Switch tabs preserving each surface's state: the editor buffer and diff
     *  selection SURVIVE a round trip (only lazily initialized when a surface is
     *  first shown empty). The Terminal tab never re-attaches here — the mirror is
     *  already streaming in the background. */
    const selectTab = (t: Tab) => {
      clearSelection();
      if (t === "diff") {
        if (diffFiles().length === 0) enterDiff(workspaceDir());
        else setTab("diff");
        return;
      }
      if (t === "files") {
        if (fileNodes().length === 0) loadFileList(workspaceDir());
        else catchUpFilesIfStale();
      }
      setTab(t);
    };

    // ── COMMAND PALETTE (M18.4, mouse-complete M21.9) ───────────────────────
    // A centered overlay (F5 / ^p / the tab bar's palette chip) — a fuzzy input
    // line + result list over the action model in palette.ts. The overlay is
    // late-mounted inside <Show> and carries NO per-node handlers (central-
    // routing discipline): `route` checks `paletteOpen()` right after the menu
    // and hit-tests rows with the pure palette geometry (palettePos/paletteRowAt
    // — the same math the render places the box with). Motion moves the
    // selection (the selection highlight IS the hover feedback, like the context
    // menu), a left press on a row runs it, the wheel scrolls `paletteTop`, and
    // a press outside dismisses. Keyboard behavior is unchanged.
    const [paletteOpen, setPaletteOpen] = createSignal(false);
    const [paletteQuery, setPaletteQuery] = createSignal("");
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
    const [paletteSel, setPaletteSel] = createSignal(0);
    // The wheel-scrolled window top of the result list (0 unless scrolled — the
    // keyboard never moves it, so keyboard-only sessions render exactly as
    // before). Reset wherever the list identity changes (query edits, level
    // swaps, reopen).
    const [paletteTop, setPaletteTop] = createSignal(0);
    const paletteActions = createMemo(() =>
      filterPaletteActions(
        paletteQuery(),
        fleet().map((s) => s.name),
        {
          terminal: mode() === "mirror",
          agents: fleetAgents(),
          sizeMismatch: windowMismatch() !== null,
          appMousePane: panes().find((p) => p.active)?.appMouse === true,
          // Pins "New agent: <name> (again)" FIRST when this context has spawn
          // memory (M24.1) — F5 → Enter repeats the last spawn.
          againName: currentAgainName(),
          // "Go to file:" rows (M24.6) — appended after everything.
          repoFiles: repoFiles(),
        },
      ),
    );
    /** The current palette LIST length — buffers level when open, else actions. */
    const paletteCount = () => paletteBuffers()?.length ?? paletteActions().length;
    /** The palette box geometry as placed by the render, for the router. */
    const paletteGeom = (): PaletteGeom => {
      const { left, top } = palettePos(dims().width, dims().height, PALETTE_W);
      return {
        left,
        top,
        width: PALETTE_W,
        visibleRows: Math.min(PALETTE_ROWS, Math.max(0, paletteCount() - paletteTop())),
      };
    };
    const openPalette = () => {
      setPaletteQuery("");
      setPaletteSel(0);
      setPaletteTop(0);
      setPaletteBuffers(null); // always open on the action list, never mid-picker
      setHoverIf(null); // the overlay owns the pointer; drop any underlying tint
      loadRepoFiles(); // refresh the "Go to file:" source (async, M24.6)
      setPaletteOpen(true);
    };
    const runPaletteAction = (a: PaletteAction) => {
      // "Paste buffer…" descends into the second-level picker instead of
      // dispatching — keep the palette open and load the buffer list.
      if (a.kind === "paste-buffer") {
        setPaletteSel(0);
        setPaletteTop(0);
        loadBuffers();
        return;
      }
      setPaletteOpen(false);
      switch (a.kind) {
        case "tab":
          selectTab(a.tab);
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
          mirror?.dispose();
          editBuffer?.destroy();
          process.exit(0);
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
          setPaletteBuffers(null);
          setPaletteSel(0);
          setPaletteTop(0);
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
      const actions = paletteActions();
      if (evt.name === "escape") {
        setPaletteOpen(false);
      } else if (evt.name === "return") {
        const a = actions[Math.min(paletteSel(), actions.length - 1)];
        if (a) runPaletteAction(a);
      } else if (evt.name === "up") {
        setPaletteSel((s) => Math.max(0, s - 1));
      } else if (evt.name === "down") {
        setPaletteSel((s) => Math.min(Math.max(0, actions.length - 1), s + 1));
      } else if (evt.name === "backspace") {
        setPaletteQuery((q) => q.slice(0, -1));
        setPaletteSel(0);
        setPaletteTop(0);
      } else if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
        setPaletteQuery((q) => q + (evt.shift ? evt.name.toUpperCase() : evt.name));
        setPaletteSel(0);
        setPaletteTop(0);
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
    const DLG_INNER_W = dialogInnerW(DIALOG_W);
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
      const { left, top } = dialogPos(dims().width, dims().height, DIALOG_W);
      const visibleRows =
        e.spec.kind === "select"
          ? Math.min(DIALOG_ROWS, Math.max(0, dialogStack.filtered().length - e.state.top))
          : e.spec.kind === "confirm"
            ? 2
            : 1;
      return {
        left,
        top,
        width: DIALOG_W,
        headerRows: dialogHeaderRows(e.spec),
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
        footerHint: "silences macOS banners during the window",
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
        items: keybindingItems(freshCfg().keys),
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
        diffFile: diffFiles()[diffSel()]?.path ?? null,
        sidebarW: sidebarW(),
        recentFolders: recentFolders(),
        lastSpawns: lastSpawns(),
        customCommands: customCommands(),
        filesShowHidden: showHiddenFiles(),
        filesShowIgnored: showIgnoredFiles(),
      };
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void saveAppState(snapshot), 400);
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
      else if (persisted.openFile) {
        openEditor(persisted.openFile);
        setTab(initialTab);
      }
      if (mode() === "editor" && fileNodes().length === 0) loadFileList(workspaceDir());
      if (mode() === "diff") refreshStatus();
      if (mode() === "mirror" && curTarget()) attach(curTarget());
      const t = setInterval(() => {
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
        const pinned: Size = { cols: canvasCols(), rows: canvasRows() };
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
        if (fleetInFlight) return;
        fleetInFlight = true;
        execFile("node", [cliPath, "team", "--json"], { timeout: 10_000 }, (err, stdout) => {
          fleetInFlight = false;
          if (err) return;
          try {
            const data = JSON.parse(stdout) as { projects?: FleetProject[] };
            setProjectsData(data.projects ?? []);
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
      onCleanup(() => {
        clearInterval(t);
        clearInterval(fleetTimer);
        clearInterval(diffTimer);
        if (saveTimer) clearTimeout(saveTimer);
        if (noteTimer) clearTimeout(noteTimer);
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
      if (mode() === "editor" && filesFocus() === "editor" && editBuffer && !editorReadOnly()) {
        editBuffer.insertText(text); // single insertText call = one undo unit
        setEditorModified(true);
        editorSyncScroll();
        setEditorRev((r) => r + 1);
        setStatusNote(`pasted ${text.length} chars`);
        return;
      }
      if (mirror) {
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
      setPaletteBuffers([]); // loading / empty placeholder
      const fmt = `#{buffer_name}\t#{buffer_sample}`;
      const done = (lines: string[]) => {
        setPaletteBuffers(parseBufferList(lines));
        setPaletteSel(0);
        setPaletteTop(0);
      };
      if (mirror) {
        void mirror
          .command(`list-buffers -F ${tmuxQuote(fmt)}`)
          .then(done)
          .catch(() => setPaletteBuffers([]));
        return;
      }
      execFile("tmux", ["list-buffers", "-F", fmt], (err, stdout) => {
        if (err) return setPaletteBuffers([]);
        done(stdout.split("\n").filter((l) => l.length > 0));
      });
    };
    /** Fetch one buffer's content and paste it. The control client reads replies as
     *  latin1 (byte-per-char) so multibyte glyphs must be re-encoded latin1→utf8
     *  (the same fix the pane seed uses) before hitting the paste path. */
    const pasteBuffer = (name: string) => {
      setPaletteOpen(false);
      setPaletteBuffers(null);
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
      const { start, end } = orderCells(anchor, head);
      const text = extractSelection(paneRowTexts(paneId), start, end);
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
        const { start, end } = orderCells(s.anchor, s.head);
        rows = rows.map((runs, r) => {
          const rowLen = runs.reduce((n, run) => n + run.text.length, 0);
          const range = rowSelectionRange(r, rowLen, start, end);
          return range ? tintRunsInverse(runs, range.from, range.to) : runs;
        });
      }
      return rows;
    };

    // FB-path twins of the two paneSelRows passes, shaped as <pane_surface> props
    // (cell-column based; the renderable applies them over the blitted cells).
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
        const top = clampTop(diffFileTop(), diffFiles().length, diffBodyRows());
        const idx = top + contentY;
        const entry = diffFiles()[idx];
        if (!entry) return null;
        return {
          region: "difffile",
          title: basename(entry.path),
          items: MENU_ITEMS.difffile,
          diffPath: join(diffDir(), entry.path),
        };
      }
      // mirror: gy=0 is the target/status row (no menu); gy=1 is the WINDOW STRIP —
      // a right-click there opens the window menu. The window under a label span is
      // the target; an empty-area / button right-click (span miss) falls back to the
      // ACTIVE window. This dual targeting means the menu still opens even if the
      // strip's known label-cell click swallow (see windowStripParts) eats the hit,
      // because the empty area to the right of the labels always routes.
      if (gy === 1) {
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
      // The pane canvas lives below the header (gy=0) + window strip (gy=1).
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
    const openMenu = (x: number, y: number) => {
      const t = resolveMenuTarget(x, y);
      if (!t) {
        closeMenu();
        return;
      }
      const { width, height } = menuDims(t.title, t.items);
      const { left, top } = clampMenuPos(x, y, width, height, dims().width, dims().height);
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
      if (evt.ctrl && evt.name === "q") {
        // HOSTED (M23.2): put the cockpit away and keep running — the palette's
        // "Quit" verb is the real exit. A client that came here via
        // switch-client (launched inside tmux) bounces BACK to its last
        // session; a client that attached from a plain terminal has no last
        // session, so `switch-client -l` fails and it detaches instead. No -t:
        // tmux resolves "current client" from the pane's $TMUX to the most
        // recently active client on our session — the presser.
        if (HOSTED) {
          execFile("tmux", ["switch-client", "-l"], (err) => {
            if (err) execFile("tmux", ["detach-client"], () => {});
          });
          return;
        }
        mirror?.dispose();
        editBuffer?.destroy();
        process.exit(0);
      }
      // A DIALOG owns the keyboard while open (M22.4) — topmost overlay, so it
      // is checked before the menu and the palette. EVERY key is consumed here
      // (escape pops one stack level inside dialogKey): nothing may leak to the
      // pane/editor beneath while a settings flow is on screen.
      if (dialogStack.depth() > 0) {
        dialogKey(dialogStack, evt);
        return;
      }
      // The context menu owns the keyboard while open (before the palette).
      if (menu()) {
        menuKey(evt);
        return;
      }
      // The palette owns the keyboard while open (keyboard-only overlay); esc/enter
      // inside close it.
      if (paletteOpen()) {
        paletteKey(evt);
        return;
      }
      // The scrollback-search session owns the keyboard while open (the bottom input
      // line + n/N navigation), so no key leaks to the pane; ^q above still works.
      if (search()) {
        searchKey(evt);
        return;
      }
      // F5 (and ^p when it arrives) open the command palette.
      if (evt.name === "f5" || (evt.ctrl && evt.name === "p")) {
        openPalette();
        return;
      }
      // F1..F4 switch the top-level surface TABS. F-keys encode reliably across
      // terminals (ctrl+digit / alt do NOT — measured); the tab bar mirrors these.
      const fTab = TABS.find((t) => t.fkey === evt.name);
      if (fTab) {
        selectTab(fTab.key);
        return;
      }
      // ^e — from the diff panel, open the SELECTED file in the editor at its
      // repo-relative path; elsewhere toggle the editor against the previous mode
      // (no-op until a file is opened via `o`/`--edit`).
      if (evt.ctrl && evt.name === "e") {
        if (mode() === "diff") {
          const entry = diffFiles()[diffSel()];
          if (entry) openEditor(join(diffDir(), entry.path));
        } else {
          toggleEditor();
        }
        return;
      }
      // ^g, not ^h: legacy encoding makes ctrl+h indistinguishable from
      // backspace (0x08), which must keep flowing to the pane. Works from mirror
      // OR editor.
      if (evt.ctrl && (evt.name === "g" || evt.name === "h")) {
        if (mode() !== "home") goHome();
        return;
      }
      if (mode() === "editor") {
        // ^c with an active selection copies the buffer range (exact text — no
        // trailing trim); without a selection it falls through (no pane to reach
        // from the editor). Save / undo / redo work regardless of focused half.
        if (evt.ctrl && evt.name === "c") {
          const s = selection();
          if (s && s.surface === "editor") {
            const { start, end } = orderCells(s.anchor, s.head);
            copyText(extractSelection(editorLines(), start, end, false));
          }
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
        if (filesFocus() === "list") {
          const q = filesQuery();
          if (q !== null) {
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
      if (mode() === "diff") {
        // ^e / ^g / ^q are handled above; here j/k move the file selection and `r`
        // forces a status+diff refresh.
        if (evt.name === "j" || evt.name === "down") moveDiffSel(1);
        else if (evt.name === "k" || evt.name === "up") moveDiffSel(-1);
        else if (evt.name === "r") refreshStatus();
        return;
      }
      if (mode() === "home") {
        // Path-input line (`o` to open); while prompting, every key feeds it.
        if (pathPrompt() !== null) {
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
        if (sessionPrompt() !== null) {
          if (evt.name === "escape") setSessionPrompt(null);
          else if (evt.name === "return") submitSessionPrompt();
          else if (evt.name === "backspace") setSessionPrompt((s) => (s ?? "").slice(0, -1));
          else if (evt.name.length === 1 && !evt.ctrl && !evt.meta)
            setSessionPrompt((s) => (s ?? "") + (evt.shift ? evt.name.toUpperCase() : evt.name));
          return;
        }
        if (evt.name === "o") {
          setPathPrompt("");
          return;
        }
        // `f` — open a folder (M22.5): the [f open folder] chip / welcome action /
        // palette command's keyboard twin. Launches the filesystem picker.
        if (evt.name === "f") {
          void openFolderFlow();
          return;
        }
        // `n` — the [n new session] chip's keyboard twin.
        if (evt.name === "n") {
          setSessionPrompt("");
          return;
        }
        // `a` — the row [+ agent] chip's keyboard twin (M23.1): spawn an agent
        // for the selected row (or a fresh session when nothing is selected).
        if (evt.name === "a") {
          newAgentFromHome(selectedHomeItem());
          return;
        }
        // `d` — open the diff panel for the selected row's project dir (the
        // home item carries it via the team payload), adopting it as context.
        if (evt.name === "d") {
          const r = selectedHomeItem();
          if (r && r.kind === "session") {
            setContextSession(r.session);
            setContextDir(r.dir ?? invokeCwd);
          }
          enterDiff(selectedHomeDir() ?? invokeCwd);
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
      // `/` opens scrollback search on the focused pane (copy-mode's finder). Only
      // in Terminal mode (home/editor/diff returned above); a raw `/` still reaches
      // the pane once search is open, since search then owns the keyboard.
      if (evt.name === "/" && !evt.ctrl && !evt.meta) {
        openSearch();
        return;
      }
      // ^c copies an active mirror selection; with no selection it passes through
      // to the pane (interrupt) exactly as before.
      if (evt.ctrl && evt.name === "c") {
        const s = selection();
        if (s && s.surface === "mirror") {
          commitMirrorCopy(s.paneId, s.anchor, s.head);
          return;
        }
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
    usePaste((e) => pasteIntoFocused(decodePasteBytes(e.bytes)));

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
    /** Buttons on the home footer (the last screen row): the app-handled home
     *  keys (`n` new session, `o` open-file, `d` diff) as clickable chips. The
     *  other footer hints advertise tmux-chrome binds this app's keyboard
     *  doesn't own, so they stay plain text rather than dead buttons.
     *  Right-aligned to the fixed edge. */
    const homeButtons = createMemo<{ defs: HeaderButton[]; spans: Span[] }>(() => {
      const defs: HeaderButton[] =
        mode() === "home"
          ? [
              { id: "home-openfolder", label: "[f open folder]" },
              { id: "home-new", label: "[n new session]" },
              { id: "home-agent", label: "[a new agent]" },
              { id: "home-open", label: "[o open]" },
              { id: "home-diff", label: "[d diff]" },
            ]
          : [];
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
    /** Buttons on the terminal window-strip row (gy=1): zoom-toggle then a vertical
     *  split of the focused pane. Placed on the far right, clear of the window-label
     *  cells. The zoom chip renders active-tinted while the window is zoomed. */
    const stripButtons = createMemo<{ defs: HeaderButton[]; spans: Span[] }>(() => {
      const defs: HeaderButton[] =
        mode() === "mirror" && panes().length > 0
          ? [
              { id: "zoom", label: "[⛶]", active: isZoomed() },
              { id: "split", label: "[+ split]" },
            ]
          : [];
      return {
        defs,
        spans: spansFromRight(
          defs.map((d) => d.label),
          buttonRightEdge(),
          1,
        ),
      };
    });
    /** Run a header/strip button by id. Reload re-reads the open file from disk
     *  (discarding unsaved edits — the ● dot warns first); split forks the focused
     *  pane via the control client, same command the context menu issues. */
    const runButton = (id: string) => {
      if (id === "save") saveEditor();
      else if (id === "reload") {
        const p = editorPath();
        if (p) openEditor(p);
      } else if (id === "refresh") refreshStatus();
      else if (id === "split") {
        const pid = mirror?.focusedPane();
        if (pid) void mirror?.command(`split-window -h -t ${pid}`).catch(() => {});
      } else if (id === "zoom") {
        const pid = mirror?.focusedPane();
        if (pid) void mirror?.command(`resize-pane -Z -t ${pid}`).catch(() => {});
      } else if (id === "home-openfolder") void openFolderFlow();
      else if (id === "home-agent") newAgentFromHome(selectedHomeItem());
      else if (id === "home-open") setPathPrompt("");
      else if (id === "home-new") setSessionPrompt("");
      else if (id === "home-diff") {
        // Mirror the home `d` key: adopt the selected session's dir as context and
        // open its diff.
        const r = selectedHomeItem();
        if (r && r.kind === "session") {
          setContextSession(r.session);
          setContextDir(r.dir ?? invokeCwd);
        }
        enterDiff(selectedHomeDir() ?? invokeCwd);
      }
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
      if (id === "tab-palette") openPalette();
      else if (id === "tab-context" && contextSession()) switchTarget(contextSession());
    };
    /** A home row's right-aligned verb chip span (sessions/projects only). The
     *  row box runs flush to the terminal's right edge, so the span anchors
     *  there — same for every row of a kind. */
    const homeChipLabel = (it: HomeItem | undefined): string =>
      it?.kind === "session"
        ? HOME_CHIP_SESSION
        : it?.kind === "project"
          ? HOME_CHIP_PROJECT
          : it?.kind === "recent"
            ? HOME_CHIP_RECENT
            : "";
    /** A home row's chip list, left to right: session/project rows lead with
     *  the [+ agent] spawn chip (M23.1), then every row's PRIMARY verb chip.
     *  The render walks these defs and the hit-test lays the SAME labels out
     *  from the right edge, so clicks land exactly on what's drawn. */
    const homeRowChips = (
      it: HomeItem | undefined,
    ): { id: "agent" | "primary"; label: string }[] => {
      const defs: { id: "agent" | "primary"; label: string }[] = [];
      if (it?.kind === "session" || it?.kind === "project") {
        defs.push({ id: "agent", label: HOME_CHIP_AGENT });
      }
      const primary = homeChipLabel(it);
      if (primary) defs.push({ id: "primary", label: primary });
      return defs;
    };
    /** Which chip (if any) column `x` hits on the row for `it`. */
    const homeChipAt = (it: HomeItem | undefined, x: number): "agent" | "primary" | null => {
      const defs = homeRowChips(it);
      if (defs.length === 0) return null;
      const i = spanHit(
        spansFromRight(
          defs.map((d) => d.label),
          buttonRightEdge(),
          0,
        ),
        x,
      );
      return i >= 0 ? defs[i]!.id : null;
    };
    /** The `[+ agent]` chip's x-span on the sidebar's AGENTS header row and the
     *  empty-state row (M24.1) — right-anchored flush to the sidebar's edge; the
     *  render (label · flexGrow spacer · chip) lays out the same cells. */
    const agentsChipSpans = createMemo(() => spansFromRight([AGENTS_ADD_CHIP], sidebarW(), 0));
    /** A home row's muted meta text — sessions keep the exact `3w · project`
     *  string the panel always showed; projects show their dir + origin. */
    const homeRowMeta = (it: HomeItem): string =>
      it.kind === "session"
        ? `${it.windows}w${it.project === it.session ? "" : ` · ${it.project}`}`
        : it.kind === "project"
          ? `${it.dir ?? ""} · registered`
          : it.kind === "recent"
            ? `${dirname(it.dir)} · recent`
            : "";

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
        const i = spanHit(TAB_SPANS, x);
        setHoverIf(i >= 0 ? { region: "surfacetab", index: i } : null);
        return;
      }
      const gy = y - TABBAR_H;
      if (x < sidebarW()) {
        // The sidebar footer's "F5 palette" segment is a chip (last screen row).
        if (y === dims().height - 1) {
          setHoverIf(
            spanHit([SIDEBAR_HINT_SPAN], x) === 0 ? { region: "sidebtn", index: 0 } : null,
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
      const m = mode();
      if (m === "home") {
        if (y === dims().height - 1) {
          const i = spanHit(homeButtons().spans, x);
          setHoverIf(i >= 0 ? { region: "button", index: i } : null);
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
        const chip = homeChipAt(it, x);
        setHoverIf({
          region: chip === "agent" ? "homeagentchip" : chip === "primary" ? "homechip" : "home",
          index: idx,
        });
        return;
      }
      if (m === "editor") {
        if (gy === 0) {
          const i = spanHit(headerButtons().spans, x);
          setHoverIf(i >= 0 ? { region: "button", index: i } : null);
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
        if (gy === 0) {
          const i = spanHit(headerButtons().spans, x);
          setHoverIf(i >= 0 ? { region: "button", index: i } : null);
          return;
        }
        const contentY = gy - HEADER_ROWS;
        const overList = x < sidebarW() + diffListW();
        if (!overList || contentY < 0) {
          setHoverIf(null);
          return;
        }
        const top = clampTop(diffFileTop(), diffFiles().length, diffBodyRows());
        const idx = top + contentY;
        setHoverIf(idx >= 0 && idx < diffFiles().length ? { region: "diff", index: idx } : null);
        return;
      }
      // mirror mode: the per-window strip lives on gy=1, with the [+ split] button
      // on its right (checked first, matching the click router's precedence).
      if (gy === 1) {
        const bi = spanHit(stripButtons().spans, x);
        if (bi >= 0) {
          setHoverIf({ region: "button", index: bi });
          return;
        }
        const i = spanHit(windowSpans(), x);
        setHoverIf(i >= 0 ? { region: "windowtab", index: i } : null);
        return;
      }
      setHoverIf(null);
    };

    /** One router, fed by the three always-present region containers (tab bar,
     *  sidebar, main). Geometry is ours. The tab bar is the top screen row; every
     *  other region is offset below it, so we subtract TABBAR_H once (`gy`) and the
     *  per-mode math below is exactly as it was before the bar existed. */
    /** Extend a live selection's head to the pointer (surface-local cells). */
    const extendSelection = (x: number, y: number) => {
      if (!selecting) return;
      const gy = y - TABBAR_H;
      if (selecting.surface === "mirror") {
        const paneId = selecting.paneId;
        const pane = panes().find((p) => p.id === paneId);
        if (!pane) return;
        setSelection({
          surface: "mirror",
          paneId: pane.id,
          anchor: selAnchor,
          head: paneCell(pane, x, gy),
        });
      } else {
        const { line, col } = editorCellAt(x, gy);
        setSelection({ surface: "editor", anchor: selAnchor, head: { row: line, col } });
        editBuffer?.setCursor(line, col);
        setEditorRev((r) => r + 1);
      }
    };

    const route = (e: RouteEvent) => {
      const { type, x, y } = e;
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
      // While the PALETTE is open it owns pointer routing (M21.9), mirroring the
      // menu above: motion over a result row moves the selection (the selection
      // highlight is the hover feedback), the wheel scrolls the visible window,
      // a left press on a row runs it (action list or paste-buffer level), a
      // press anywhere else inside the box is a no-op, and a press OUTSIDE
      // dismisses. Geometry comes from the same pure math the render places the
      // box with (palettePos/paletteRowAt/paletteContains).
      if (paletteOpen()) {
        const g = paletteGeom();
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir === "up" || dir === "down") {
            const step = dir === "up" ? -1 : 1;
            setPaletteTop((t) => clampPaletteTop(t + step, paletteCount(), PALETTE_ROWS));
          }
          return;
        }
        if (type === "move" || type === "over" || type === "drag") {
          const ri = paletteRowAt(g, x, y);
          if (ri >= 0) setPaletteSel(paletteTop() + ri);
          return;
        }
        if (type !== "down") return;
        const ri = paletteRowAt(g, x, y);
        if (ri >= 0) {
          if (e.button === 2) return; // right press on a row: no-op, stay open
          const abs = paletteTop() + ri;
          setPaletteSel(abs);
          const bufs = paletteBuffers();
          if (bufs !== null) {
            const b = bufs[abs];
            if (b) pasteBuffer(b.name);
          } else {
            const a = paletteActions()[abs];
            if (a) runPaletteAction(a);
          }
          return;
        }
        if (!paletteContains(g, x, y)) setPaletteOpen(false);
        return;
      }
      // A right-button press (SGR button 2) opens the context menu at the pointer.
      // Left/middle presses fall through to the normal click routing below.
      if (type === "down" && e.button === 2) {
        openMenu(x, y);
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
        const isEnd = type === "up" || type === "drag-end" || type === "drop";
        if (isDrag || isEnd) {
          if (dragging.kind === "sidebar") {
            setSidebarW(clampSidebarWidth(x));
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
            selAnchor = pp.cell;
            selecting = { surface: "mirror", paneId: pane.id };
            setSelection({ surface: "mirror", paneId: pane.id, anchor: pp.cell, head: cell });
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
      if (type === "move" || type === "over" || type === "drag") {
        resolveHover(x, y);
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
          return;
        }
        // A FORWARDED press's release: pay the debt to the pane that got the
        // down — at the pointer's release cell, clamped into that pane — and
        // only once (the synthesized duplicates find no debt and stay local).
        if (forwardedDown) {
          const pane = panesById().get(forwardedDown);
          forwardedDown = null;
          if (pane && selectModePane() !== pane.id) forwardPress(pane, x, y - TABBAR_H, true);
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
        const i = spanHit(TAB_SPANS, x);
        if (i >= 0) selectTab(TABS[i]!.key);
        return;
      }
      const gy = y - TABBAR_H;
      if (x < sidebarW()) {
        if (type !== "down") return;
        // The footer hint's "F5 palette" segment is a chip (last screen row).
        if (y === dims().height - 1) {
          if (spanHit([SIDEBAR_HINT_SPAN], x) === 0) openPalette();
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
        // The footer occupies the last screen row; its right-aligned chips
        // ([n new session] / [o open] / [d diff]) are hit-tested there first.
        if (y === dims().height - 1) {
          const hb = homeButtons();
          const i = spanHit(hb.spans, x);
          if (i >= 0) runButton(hb.defs[i]!.id);
          return;
        }
        // The first-run welcome's "open a folder" action (M22.5).
        if (welcomeActionHit(gy, x)) {
          void openFolderFlow();
          return;
        }
        // A row click: the right-aligned verb chips win over the row body
        // ([+ agent] spawns — M23.1; the primary chip diffs/launches/reopens);
        // header rows are inert. Sessions open, projects launch, recents reopen.
        const idx = homeItemIndexAt(gy);
        const it = homeItems()[idx];
        if (!it || it.kind === "header") return;
        const chip = homeChipAt(it, x);
        if (chip === "agent") {
          setSel(idx);
          newAgentFromHome(it);
        } else if (chip === "primary") runHomeChip(idx);
        else activateHomeItem(idx);
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
        // The header row (gy=0) carries the right-aligned save/reload buttons.
        if (gy === 0) {
          const hb = headerButtons();
          const i = spanHit(hb.spans, x);
          if (i >= 0) runButton(hb.defs[i]!.id);
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
      // DIFF mode: header (gy=0) + rule (gy=1), body from gy=2. Left column
      // [0,listW) is the file list, the rest is the diff. Wheel scrolls whichever
      // column the pointer is over; a left-column click selects that file row.
      if (mode() === "diff") {
        const overList = x < sidebarW() + diffListW();
        if (type === "scroll") {
          const dir = e.scroll?.direction;
          if (dir !== "up" && dir !== "down") return;
          const step = dir === "up" ? -SCROLL_STEP : SCROLL_STEP;
          if (overList) {
            setDiffFileTop((t) => clampTop(t + step, diffFiles().length, diffBodyRows()));
          } else {
            setDiffTop((t) => clampTop(t + step, diffLines().length, diffBodyRows()));
          }
          return;
        }
        if (type !== "down") return;
        // The header row (gy=0) carries the right-aligned refresh button.
        if (gy === 0) {
          const hb = headerButtons();
          const i = spanHit(hb.spans, x);
          if (i >= 0) runButton(hb.defs[i]!.id);
          return;
        }
        const contentY = gy - HEADER_ROWS;
        if (contentY < 0 || !overList) return;
        const top = clampTop(diffFileTop(), diffFiles().length, diffBodyRows());
        const idx = top + contentY;
        if (idx >= 0 && idx < diffFiles().length) selectDiffFile(idx);
        return;
      }
      // The per-window strip (gy=1) — resolved by the SAME x-span math the render
      // lays out, so the formerly-swallowed segment clicks now land.
      if (gy === 1) {
        if (type !== "down") return;
        // The right side of the strip carries the [+ split] button (clear of the
        // window-label cells); it wins the hit test over the window spans.
        const sbtn = stripButtons();
        const bi = spanHit(sbtn.spans, x);
        if (bi >= 0) {
          runButton(sbtn.defs[bi]!.id);
          return;
        }
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
          pendingPress = { paneId: pane.id, x, gy, cell: paneCell(pane, x, gy) };
          return;
        }
        // Begin a drag selection, or on a repeat click select
        // the word (double) / line (triple) and copy it immediately.
        const cell = paneCell(pane, x, gy);
        const now = Date.now();
        const count = clickCount(lastClick, cell, now, CLICK_MS);
        lastClick = { row: cell.row, col: cell.col, ts: now, count };
        if (count >= 2) {
          const rowText = paneRowTexts(pane.id)[cell.row] ?? "";
          const r = count === 2 ? wordRangeAt(rowText, cell.col) : lineRangeAt(rowText);
          const anchor = { row: cell.row, col: r.from };
          const head = { row: cell.row, col: r.to };
          setSelection({ surface: "mirror", paneId: pane.id, anchor, head });
          selecting = null;
          commitMirrorCopy(pane.id, anchor, head);
        } else {
          selAnchor = cell;
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

    // ── Per-pane agent chips (M22.3) ─────────────────────────────────────────
    // The fleet payload's per-pane agent entries (M22.1), joined by tmux pane id
    // (the mirror's pane ids are the same %N ids). Consumes the 3s fleet poll's
    // signal as-is; staleness is already applied by the report, and a missing
    // `agents` field (older payload) degrades to an empty map.
    const agentByPane = createMemo(() => agentsByPane(projectsData()));
    // A pane's agent chip: glyph + kind at the pane's TOP-LEFT (the scroll badge
    // owns the top-right), colored by the app's status grammar — reference sites:
    // STATUS_GLYPH + STATUS_COLOR (this file). PASSIVE by design: no handler, and
    // the label is a TEXT run covering its wrapper box, so a press lands on text
    // and bubbles to the router (same law as the scrollbar cells above) — pane
    // forwarding and the right-click menu are untouched. Blocked is the only
    // attention state: bold, attention bg, and the label spells `blocked` plus
    // the authority age ("blocked 4m"). The label re-derives on every fleet tick;
    // width changes re-truncate (chipLabel degrades label → glyph → hidden). The
    // chip is anchored to the pane box, so zoom/resize/focus moves ride along.
    const agentChipOverlay = (pane: () => { id: string; width: number } | undefined) => {
      const entry = () => {
        const p = pane();
        return p ? agentByPane().get(p.id) : undefined;
      };
      const label = () => {
        const e = entry();
        const p = pane();
        if (!e || !p) return null;
        // Budget: pane width minus the left inset (1) + padding (2), capped so a
        // wide pane's chip stays a chip (and clears the top-right scroll badge).
        return chipLabel(e, STATUS_GLYPH[e.state], Date.now(), Math.min(p.width - 3, 28));
      };
      return (
        <Show when={label()}>
          <box position="absolute" left={1} top={0} flexDirection="row">
            <text
              fg={STATUS_COLOR[entry()!.state]}
              bg={entry()!.state === "blocked" ? CHIP_ATTN_BG : BADGE_BG}
              attributes={entry()!.state === "blocked" ? 1 : 0}
            >
              {` ${label()} `}
            </text>
          </box>
        </Show>
      );
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
    /** The right-aligned affordance-button run for a header/strip row: a flexGrow
     *  spacer pushes the chips flush to the container right edge, matching the
     *  `spansFromRight` layout the router hit-tests. Hover lifts the chip. */
    const buttonRow = (buttons: () => { defs: HeaderButton[]; spans: Span[] }) => (
      <>
        <box flexGrow={1} />
        <For each={buttons().defs}>
          {(b, i) => (
            <text
              fg={BUTTON_FG}
              bg={
                b.active ? BUTTON_ACTIVE_BG : isHovered("button", i()) ? BUTTON_HOVER_BG : BUTTON_BG
              }
            >
              {b.label}
            </text>
          )}
        </For>
      </>
    );

    return (
      <box
        flexDirection="column"
        flexGrow={1}
        backgroundColor={DEFAULT_BG}
        onMouse={(e: RouteEvent) => route(e)}
      >
        {/* Surface tab bar — the top screen row (gy=0), full width above the
          sidebar. Rendered at mount (static <For>), so the click x-spans in
          `TAB_SPANS` are exact and never hit the late-mount landmine. F1..F4
          switch; the active tab carries the accent background, a hovered one a
          subtle tint. */}
        <box
          height={TABBAR_H}
          flexDirection="row"
          backgroundColor={TABBAR_BG}
          onMouse={(e: RouteEvent) => route(e)}
        >
          <For each={TABS}>
            {(t, i) => (
              <box
                backgroundColor={
                  tab() === t.key ? ACCENT : isHovered("surfacetab", i()) ? HOVER_BG : TABBAR_BG
                }
              >
                <text
                  fg={tab() === t.key ? DEFAULT_BG : MUTED}
                  attributes={tab() === t.key ? 1 : 0}
                >
                  {tabCell(t)}
                </text>
              </box>
            )}
          </For>
          <box flexGrow={1} />
          <Show when={note()}>
            <text fg={ACCENT} attributes={1}>{`${note()} `}</text>
          </Show>
          {/* Right-aligned CHIPS (M21.9): the workspace-context chip (click →
            its Terminal) and the palette hint (click → open the palette). The
            router hit-tests `tabbarButtons().spans` — the same defs walked
            here, right-anchored, so the cells match exactly. */}
          <For each={tabbarButtons().defs}>
            {(b, i) => (
              <text
                fg={b.id === "tab-context" ? ACCENT : MUTED}
                bg={isHovered("tabbtn", i()) ? BUTTON_HOVER_BG : TABBAR_BG}
              >
                {b.label}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" flexGrow={1} backgroundColor={DEFAULT_BG}>
          <box
            width={sidebarW()}
            flexDirection="column"
            backgroundColor={SIDEBAR_BG}
            paddingLeft={1}
            onMouse={(e: RouteEvent) => route(e)}
          >
            <text fg={ACCENT} attributes={1}>
              tmux-ide
            </text>
            <text fg={MUTED}>{"─".repeat(sidebarW() - 2)}</text>
            <box flexDirection="column">
              <For each={fleet()}>
                {(s, i) => (
                  <box
                    flexDirection="row"
                    gap={1}
                    backgroundColor={
                      s.name === curTarget()
                        ? TAB_ACTIVE_BG
                        : isHovered("sidebar", i())
                          ? HOVER_BG
                          : SIDEBAR_BG
                    }
                  >
                    <text fg={STATUS_COLOR[s.status]}>{STATUS_GLYPH[s.status]}</text>
                    <text fg={s.name === curTarget() ? DEFAULT_FG : MUTED}>
                      {s.name.slice(0, sidebarW() - 5)}
                    </text>
                  </box>
                )}
              </For>
            </box>
            {/* AGENTS section (M22.2): the fleet's agents at a glance, one row
              per agent, sorted attention-first (fleetAgents), each a JUMP target
              (click → its session/window/pane). REUSES the session rows' glyph +
              state-color grammar (STATUS_GLYPH/STATUS_COLOR by state). Row
              y-accounting for the router is pure in `sidebarHit`: this section
              starts right after the session <For>, one header row then the agent
              rows (or one quiet empty-state line). Hover reveals the state age. */}
            <box flexDirection="column" marginTop={AGENTS_GAP_ROWS}>
              {/* Header row (M24.1): label + a right-aligned [+ agent] chip.
                The row body opens the TEAM dialog, the chip spawns; the router
                x-tests `agentsChipSpans` — the flexGrow spacer here lays the
                chip on exactly those cells. The empty state keeps a chip twin
                so spawning is discoverable before any agent runs. */}
              <box
                flexDirection="row"
                backgroundColor={isHovered("agentshdr", 0) ? HOVER_BG : SIDEBAR_BG}
              >
                <text fg={MUTED} attributes={1}>
                  {agentsHeaderLabel(
                    fleetAgents().length,
                    Math.max(1, sidebarW() - AGENTS_ADD_CHIP.length - 2),
                  )}
                </text>
                <box flexGrow={1} />
                <text fg={MUTED} bg={isHovered("agentschip", 0) ? BUTTON_HOVER_BG : SIDEBAR_BG}>
                  {AGENTS_ADD_CHIP}
                </text>
              </box>
              <Show
                when={fleetAgents().length > 0}
                fallback={
                  <box flexDirection="row">
                    <text fg={MUTED}>
                      {AGENTS_EMPTY_LINE.slice(
                        0,
                        Math.max(1, sidebarW() - AGENTS_ADD_CHIP.length - 2),
                      )}
                    </text>
                    <box flexGrow={1} />
                    <text fg={MUTED} bg={isHovered("agentschip", 1) ? BUTTON_HOVER_BG : SIDEBAR_BG}>
                      {AGENTS_ADD_CHIP}
                    </text>
                  </box>
                }
              >
                <For each={fleetAgents()}>
                  {(a, i) => {
                    const age = () =>
                      agentAgeLabel(a.state, a.since, Math.floor(Date.now() / 1000));
                    const hovered = () => isHovered("sidebaragent", i());
                    const ageShown = () => (hovered() ? age() : null);
                    const labelBudget = () => {
                      const a2 = ageShown();
                      return sidebarW() - 5 - (a2 ? a2.length + 1 : 0);
                    };
                    // Blocked is the attention state: bold, matching the
                    // statusline's grammar (`blocked` reads bold there too).
                    const attn = () => (a.state === "blocked" ? 1 : 0);
                    return (
                      <box
                        flexDirection="row"
                        gap={1}
                        backgroundColor={hovered() ? HOVER_BG : SIDEBAR_BG}
                      >
                        <text fg={STATUS_COLOR[a.state]} attributes={attn()}>
                          {STATUS_GLYPH[a.state]}
                        </text>
                        <text
                          fg={a.state === "blocked" ? STATUS_COLOR.blocked : MUTED}
                          attributes={attn()}
                        >
                          {agentRowLabel(a.kind, a.session, labelBudget())}
                        </text>
                        <Show when={ageShown()}>
                          <box flexGrow={1} />
                          <text fg={MUTED}>{ageShown()}</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>
            </box>
            <box flexGrow={1} />
            {/* Footer hint — its "F5 palette" segment is a CHIP (M21.9): the
              router hit-tests SIDEBAR_HINT_SPAN on the last screen row, and
              these three runs render the exact same cells. */}
            <box flexDirection="row">
              <text fg={MUTED}>{SIDEBAR_HINT_PRE}</text>
              <text fg={MUTED} bg={isHovered("sidebtn", 0) ? BUTTON_HOVER_BG : SIDEBAR_BG}>
                {SIDEBAR_HINT_BTN}
              </text>
              <text fg={MUTED}>{SIDEBAR_HINT_POST}</text>
            </box>
          </box>
          <box flexDirection="column" flexGrow={1} onMouse={(e: RouteEvent) => route(e)}>
            <Show when={mode() === "home"}>
              {/* HOME header (y=0) + rule (y=1); rows below start at y=2 — the
              coordinate `route` reverses for a home-row click. */}
              <box paddingLeft={1} flexDirection="row" gap={1}>
                <text fg={ACCENT} attributes={1}>
                  tmux-ide
                </text>
                <text fg={MUTED}>{`· ${rollup().sessions} sessions ·`}</text>
                <For each={rollupChips(rollup())}>
                  {(c) => (
                    <text
                      fg={STATUS_COLOR[c.status]}
                    >{`${STATUS_GLYPH[c.status]} ${c.count}`}</text>
                  )}
                </For>
              </box>
              <text fg={MUTED}>{"─".repeat(Math.max(4, canvasCols() - 2))}</text>
              {/* FIRST-RUN welcome (M22.5): exactly WELCOME_ROWS rows so the home
                row math below simply shifts by welcomeOffset(). Each line is
                centered with the SAME centerPad the click router hit-tests, so
                the "open a folder" action lands where it's drawn. */}
              <Show when={firstRun()}>
                <box flexDirection="column">
                  <box height={1} />
                  <box flexDirection="row">
                    <text>{" ".repeat(centerPad(canvasCols(), WELCOME_LINE.length))}</text>
                    <text fg={DEFAULT_FG}>{WELCOME_LINE}</text>
                  </box>
                  <box height={1} />
                  <box flexDirection="row">
                    <text>{" ".repeat(centerPad(canvasCols(), WELCOME_ACTION_LABEL.length))}</text>
                    <text
                      fg={BUTTON_FG}
                      bg={isHovered("welcomeopen", 0) ? BUTTON_HOVER_BG : BUTTON_BG}
                    >
                      {WELCOME_ACTION_LABEL}
                    </text>
                  </box>
                  <box height={1} />
                  <box flexDirection="row">
                    <text>{" ".repeat(centerPad(canvasCols(), welcomeTip.length))}</text>
                    <text fg={MUTED}>{welcomeTip}</text>
                  </box>
                </box>
              </Show>
              {/* HOME items (M21.9): live-session rows, then the registry
                section (header + launchable project rows), then (M22.5) the
                recently-opened folders. One uniform selectable-row layout —
                status glyph / title / meta — plus a right-aligned verb CHIP the
                router hit-tests by the same right-anchored span math
                (homeChipHit). Headers are inert. */}
              <box flexDirection="column">
                <For each={homeItems()}>
                  {(it, i) => (
                    <Show
                      when={it.kind !== "header"}
                      fallback={
                        <box height={1} paddingLeft={1}>
                          <text fg={MUTED}>{it.kind === "header" ? `· ${it.label}` : ""}</text>
                        </box>
                      }
                    >
                      <box
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        height={1}
                        backgroundColor={
                          i() === clampedSel()
                            ? TAB_ACTIVE_BG
                            : isHovered("home", i())
                              ? HOVER_BG
                              : DEFAULT_BG
                        }
                      >
                        <text fg={it.kind === "session" ? STATUS_COLOR[it.status] : DIR_FG}>
                          {it.kind === "session"
                            ? STATUS_GLYPH[it.status]
                            : it.kind === "recent"
                              ? "↺"
                              : "▸"}
                        </text>
                        <text fg={i() === clampedSel() ? DEFAULT_FG : MUTED} attributes={1}>
                          {it.kind === "session"
                            ? it.session
                            : it.kind === "project"
                              ? it.name
                              : it.kind === "recent"
                                ? it.name
                                : ""}
                        </text>
                        <text fg={MUTED}>{homeRowMeta(it)}</text>
                        <box flexGrow={1} />
                        {/* The row's chips (M23.1: [+ agent] before the primary
                          verb) — the SAME defs homeChipAt lays out from the
                          right edge, so hover/click match cell-for-cell. */}
                        <For each={homeRowChips(it)}>
                          {(c) => (
                            <text
                              fg={BUTTON_FG}
                              bg={
                                isHovered(c.id === "agent" ? "homeagentchip" : "homechip", i())
                                  ? BUTTON_HOVER_BG
                                  : BUTTON_BG
                              }
                            >
                              {c.label}
                            </text>
                          )}
                        </For>
                      </box>
                    </Show>
                  )}
                </For>
              </box>
              <box flexGrow={1} />
              <Show
                when={sessionPrompt() !== null}
                fallback={
                  <Show
                    when={pathPrompt() !== null}
                    fallback={
                      <box paddingLeft={1}>
                        <text fg={ACCENT}>{detailLine()}</text>
                      </box>
                    }
                  >
                    <box paddingLeft={1} flexDirection="row">
                      <text fg={ACCENT}>{"open file: "}</text>
                      <text fg={DEFAULT_FG}>{`${pathPrompt() ?? ""}▏`}</text>
                    </box>
                  </Show>
                }
              >
                <box paddingLeft={1} flexDirection="row">
                  <text fg={ACCENT}>{"new session: "}</text>
                  <text fg={DEFAULT_FG}>{`${sessionPrompt() ?? ""}▏`}</text>
                </box>
              </Show>
              <box paddingLeft={1} flexDirection="row" gap={1}>
                <text fg={MUTED}>{homeFooter()}</text>
                {buttonRow(homeButtons)}
              </box>
            </Show>
            <Show when={mode() === "mirror"}>
              <box paddingLeft={1} flexDirection="row" gap={1}>
                <text fg={DEFAULT_FG} attributes={1}>
                  {curTarget()}
                </text>
                <text fg={MUTED}>{status()}</text>
              </box>
              {/* The per-window strip (gy=1). Rendered as bare styled TEXT runs (no
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
                {/* Zoomed indicator: the focused pane's id + a [Z] chip, shown only
                  while the window is zoomed. Left-aligned after the labels; the
                  button row's flexGrow spacer keeps the [⛶]/[+ split] chips pinned
                  right regardless, and windowSpans are measured from the left, so
                  neither the click routing nor the button spans shift. */}
                <Show when={isZoomed()}>
                  <text fg={ACCENT} bg={TAB_ACTIVE_BG} attributes={1}>
                    {` ${focusedLivePane()?.id ?? ""} [Z] `}
                  </text>
                </Show>
                {/* Synchronize-panes indicator (M20.2): shown while the active
                  window's synchronize-panes option is on. Left-aligned after the
                  labels like [Z]; the button row's flexGrow spacer keeps the
                  right-pinned chips and their spans unaffected. */}
                <Show when={syncOn()}>
                  <text fg={BUTTON_FG} bg={BUTTON_ACTIVE_BG} attributes={1}>
                    {" [SYNC] "}
                  </text>
                </Show>
                {buttonRow(stripButtons)}
              </box>
              <box position="relative" flexGrow={1} backgroundColor={GUTTER_BG}>
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
                              when={selectModePane() === pane.id && selectBadgeLabel(pane.width)}
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
                          {agentChipOverlay(() => pane)}
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
                            <box position="absolute" right={1} top={0} flexDirection="row">
                              <Show
                                when={selectModePane() === id && selectBadgeLabel(pane()!.width)}
                              >
                                <text fg={DEFAULT_FG} bg={BUTTON_ACTIVE_BG} attributes={1}>
                                  {selectBadgeLabel(pane()!.width)!}
                                </text>
                              </Show>
                              <Show when={pane()!.snapshot.scrollOffset > 0}>
                                <text fg={DEFAULT_FG} bg={BADGE_BG}>
                                  {` ↑${pane()!.snapshot.scrollOffset}/${pane()!.scrollbackDepth} `}
                                </text>
                              </Show>
                            </box>
                            {agentChipOverlay(pane)}
                            {scrollbarOverlay(() => mirrorScrollGeom(pane()!))}
                          </box>
                        </Show>
                      );
                    }}
                  </For>
                </Show>
                {/* Focused-pane border (M22.7): accent strips in the GUTTER cells
                  around the active pane — the strips live outside every pane rect
                  so no terminal cell is consumed or tinted, and they're
                  handler-less boxes (gutter presses still bubble to the router,
                  border drags keep working). Single-pane and zoomed windows paint
                  nothing (focusStrips returns [] when the rect fills the canvas
                  or the window has one pane). */}
                <For
                  each={(() => {
                    const focused = panes().find((p) => p.active);
                    return focused
                      ? focusStrips(focused, canvasCols(), canvasRows(), panes().length)
                      : [];
                  })()}
                >
                  {(strip) => (
                    // A HAIRLINE, not a filled bar (user feedback: bars read as
                    // extra gutter padding): line glyphs in accent fg on the
                    // normal canvas bg keep the gutter visually thin. One text
                    // per strip — newline-joined glyphs render as a column.
                    <box
                      position="absolute"
                      left={strip.left}
                      top={strip.top}
                      width={strip.width}
                      height={strip.height}
                    >
                      <text fg={FOCUS_BORDER_FG}>
                        {strip.height === 1
                          ? "─".repeat(strip.width)
                          : Array(strip.height).fill("│").join("\n")}
                      </text>
                    </box>
                  )}
                </For>
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
              {/* Scrollback-search input (M20.3) — a bottom-of-canvas line, like the
                palette's input but inline. A normal-flow row after the pane canvas
                (keyboard-only, no mouse handler — search owns the keyboard while
                open); it steals the canvas's last row only while open, so the pane
                grid is untouched the rest of the time. `editing` shows a "/query▏"
                cursor; navigation shows the query + the "3/17 matches" tally. */}
              <Show when={search()}>
                <box
                  flexDirection="row"
                  backgroundColor={PALETTE_BG}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <text fg={ACCENT} attributes={1}>
                    {search()!.editing ? "/" : "search "}
                  </text>
                  <text fg={DEFAULT_FG}>{`${search()!.query}${search()!.editing ? "▏" : ""}`}</text>
                  <box flexGrow={1} />
                  <text fg={MUTED}>{searchStatus()}</text>
                </box>
              </Show>
            </Show>
            <Show when={mode() === "editor"}>
              {/* FILES tab: header (gy=0) · rule/banner (gy=1) · two-column body
              (gy=2+): the file LIST on the left, the editor on the right. `route`
              reverses this geometry for wheel + click. NO onMouse on the rows —
              the main column container routes everything. */}
              <box paddingLeft={1} flexDirection="row" gap={1}>
                <text fg={ACCENT} attributes={1}>
                  {editorPath() ? basename(editorPath()!) : "files"}
                </text>
                <Show when={editorModified()}>
                  <text fg={MODIFIED_FG}>●</text>
                </Show>
                <text fg={MUTED}>{`${editorCursor().row + 1}:${editorCursor().col + 1}`}</text>
                <text fg={MUTED}>{`${editorLines().length}L`}</text>
                <text fg={MUTED}>{editorMsg()}</text>
                <Show when={filesQuery() !== null}>
                  <text fg={ACCENT}>{`/${filesQuery()}▏`}</text>
                </Show>
                {buttonRow(headerButtons)}
              </box>
              <Show
                when={readOnlyBanner(editorReadOnly())}
                fallback={<text fg={MUTED}>{"─".repeat(Math.max(4, canvasCols() - 2))}</text>}
              >
                <box paddingLeft={1}>
                  <text fg={BANNER_FG}>{readOnlyBanner(editorReadOnly())}</text>
                </box>
              </Show>
              <box flexDirection="row" flexGrow={1}>
                {/* Left: the workspace file list (one-level expandable). */}
                <box width={filesListW()} flexDirection="column" backgroundColor={GUTTER_BG}>
                  <For each={fileListVisible()}>
                    {(row) => {
                      const n = row.node;
                      const selected = () => row.index === fileSel() && filesFocus() === "list";
                      // Reactive: the status map refreshes on the watcher/poll.
                      const letter = () => fileStatusFor(n);
                      const prefix =
                        "  ".repeat(n.depth) + (n.isDir ? (n.expanded ? "▾ " : "▸ ") : "  ");
                      const label = (prefix + n.name).slice(0, filesListW() - 4);
                      return (
                        <box
                          paddingLeft={1}
                          height={1}
                          flexDirection="row"
                          backgroundColor={
                            selected()
                              ? TAB_ACTIVE_BG
                              : isHovered("files", row.index)
                                ? HOVER_BG
                                : GUTTER_BG
                          }
                        >
                          <text
                            flexGrow={1}
                            fg={
                              n.ignored
                                ? DIFF_META_FG // gitignored: dimmed when shown
                                : n.isDir
                                  ? DIR_FG
                                  : selected()
                                    ? DEFAULT_FG
                                    : MUTED
                            }
                          >
                            {label}
                          </text>
                          <Show when={letter()}>
                            <text fg={STATUS_LETTER_FG[letter()!] ?? DEFAULT_FG}>
                              {` ${letter()!}`}
                            </text>
                          </Show>
                        </box>
                      );
                    }}
                  </For>
                </box>
                {/* Right: the editor viewport (gutter + text runs + cursor) with a
                  right-edge scrollbar overlaid on the last column. */}
                <box position="relative" flexGrow={1} flexDirection="column">
                  {scrollbarOverlay(editorScrollGeom)}
                  <For each={editorVisible()}>
                    {(ln) => {
                      const gw = gutterWidth(editorLines().length);
                      // An active selection on this line inverse-tints its span
                      // (and wins over the cursor cell, which sits at the drag head
                      // on the selection boundary anyway).
                      const selR = editorSelRange(ln.num - 1, ln.text.length);
                      return (
                        <box flexDirection="row" height={1}>
                          <text bg={GUTTER_BG} fg={GUTTER_FG}>
                            {formatGutter(ln.num, gw)}
                          </text>
                          <Show
                            when={selR}
                            fallback={
                              <Show
                                when={ln.cursorCol !== null}
                                fallback={<text fg={DEFAULT_FG}>{ln.text}</text>}
                              >
                                <text fg={DEFAULT_FG}>{ln.text.slice(0, ln.cursorCol!)}</text>
                                <text fg={DEFAULT_BG} bg={CURSOR_BG}>
                                  {ln.text[ln.cursorCol!] ?? " "}
                                </text>
                                <text fg={DEFAULT_FG}>{ln.text.slice(ln.cursorCol! + 1)}</text>
                              </Show>
                            }
                          >
                            <text fg={DEFAULT_FG}>{ln.text.slice(0, selR!.from)}</text>
                            <text fg={DEFAULT_FG} attributes={ATTR_INVERSE}>
                              {ln.text.slice(selR!.from, selR!.to + 1) || " "}
                            </text>
                            <text fg={DEFAULT_FG}>{ln.text.slice(selR!.to + 1)}</text>
                          </Show>
                        </box>
                      );
                    }}
                  </For>
                </box>
              </box>
              <box paddingLeft={1}>
                <text fg={MUTED}>
                  {`j/k · enter open · [/] change · / filter · H dot:${
                    showHiddenFiles() ? "on" : "off"
                  } · I ign:${
                    showIgnoredFiles() ? "on" : "off"
                  } · ^s save · esc list · ^g home · ${QUIT_HINT}`}
                </text>
              </box>
            </Show>
            <Show when={mode() === "diff"}>
              {/* header (y=0) · rule (y=1) · two-column body (y=2+). `route` reverses
              this geometry: left column = file list, right = diff. NO onMouse on
              the rows — the main column container routes everything. */}
              <box paddingLeft={1} flexDirection="row" gap={1}>
                <text fg={ACCENT} attributes={1}>
                  {basename(diffDir()) || "diff"}
                </text>
                <text fg={MUTED}>{`${diffFiles().length} changed`}</text>
                <Show when={diffMsg()}>
                  <text fg={MUTED}>{`· ${diffMsg()}`}</text>
                </Show>
                {buttonRow(headerButtons)}
              </box>
              <text fg={MUTED}>{"─".repeat(Math.max(4, canvasCols() - 2))}</text>
              <box flexDirection="row" flexGrow={1}>
                {/* Left: changed-file list. */}
                <box width={diffListW()} flexDirection="column" backgroundColor={GUTTER_BG}>
                  <For each={fileVisible()}>
                    {(row) => (
                      <box
                        flexDirection="row"
                        gap={1}
                        paddingLeft={1}
                        backgroundColor={
                          row.index === diffSel()
                            ? TAB_ACTIVE_BG
                            : isHovered("diff", row.index)
                              ? HOVER_BG
                              : GUTTER_BG
                        }
                      >
                        <text fg={STATUS_LETTER_FG[row.entry.status] ?? DEFAULT_FG}>
                          {row.entry.status}
                        </text>
                        <text fg={row.index === diffSel() ? DEFAULT_FG : MUTED}>
                          {row.entry.path.length > diffListW() - 4
                            ? "…" + row.entry.path.slice(-(diffListW() - 5))
                            : row.entry.path}
                        </text>
                      </box>
                    )}
                  </For>
                </box>
                {/* Right: unified diff of the selected file, with a right-edge
                  scrollbar overlaid on the last column. */}
                <box position="relative" flexGrow={1} flexDirection="column" paddingLeft={1}>
                  {scrollbarOverlay(diffScrollGeom)}
                  <For each={diffVisible()}>
                    {(ln) => (
                      <box height={1}>
                        <text fg={DIFF_FG[ln.kind]}>{ln.text || " "}</text>
                      </box>
                    )}
                  </For>
                </box>
              </box>
              <box paddingLeft={1}>
                <text fg={MUTED}>
                  {`j/k file · wheel scroll · ^e edit · r refresh · ^g home · ${QUIT_HINT}`}
                </text>
              </box>
            </Show>
          </box>
        </box>
        {/* COMMAND PALETTE overlay (M18.4; mouse-complete M21.9) — centered.
          Late-mounted inside <Show> and still carries NO per-node handlers:
          clicks bubble to the root box, whose `route` checks `paletteOpen()`
          and hit-tests rows against the SAME pure geometry placing this box
          (palettePos). Type to fuzzy-filter; up/down or pointer motion move;
          enter or a row click runs; wheel scrolls (`paletteTop` windows the
          slice); esc or an outside click closes. */}
        <Show when={paletteOpen()}>
          <box
            position="absolute"
            left={palettePos(dims().width, dims().height, PALETTE_W).left}
            top={palettePos(dims().width, dims().height, PALETTE_W).top}
            width={PALETTE_W}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            {/* Second level (paste-buffer picker) when `paletteBuffers` is set;
              otherwise the normal fuzzy action list. Same late-mount discipline —
              no per-row handlers; paletteKey drives both. */}
            <Show
              when={paletteBuffers() !== null}
              fallback={
                <>
                  <box flexDirection="row">
                    <text fg={ACCENT} attributes={1}>
                      {"⌘ "}
                    </text>
                    <text fg={DEFAULT_FG}>{`${paletteQuery()}▏`}</text>
                  </box>
                  <text fg={MUTED}>{"─".repeat(PALETTE_W - 4)}</text>
                  <For each={paletteActions().slice(paletteTop(), paletteTop() + PALETTE_ROWS)}>
                    {(a, i) => (
                      <box
                        height={1}
                        backgroundColor={
                          paletteTop() + i() === paletteSel() ? TAB_ACTIVE_BG : PALETTE_BG
                        }
                      >
                        <text fg={paletteTop() + i() === paletteSel() ? DEFAULT_FG : MUTED}>
                          {(paletteTop() + i() === paletteSel() ? "› " : "  ") + a.label}
                        </text>
                      </box>
                    )}
                  </For>
                  <Show when={paletteActions().length === 0}>
                    <text fg={MUTED}>{"  no matches"}</text>
                  </Show>
                </>
              }
            >
              <box flexDirection="row">
                <text fg={ACCENT} attributes={1}>
                  {"⎘ Paste buffer"}
                </text>
                <box flexGrow={1} />
                <text fg={MUTED}>{"esc back"}</text>
              </box>
              <text fg={MUTED}>{"─".repeat(PALETTE_W - 4)}</text>
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
            </Show>
          </box>
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
            left={dialogPos(dims().width, dims().height, DIALOG_W).left}
            top={dialogPos(dims().width, dims().height, DIALOG_W).top}
            width={DIALOG_W}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={previewAccent() ?? PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={dlgAccent()} attributes={1}>
              {dlgSelectSpec().title.slice(0, DLG_INNER_W).padEnd(DLG_INNER_W)}
            </text>
            <Show when={dlgSelectSpec().filterable !== false}>
              <box flexDirection="row">
                <text fg={dlgAccent()} attributes={1}>
                  {"▸ "}
                </text>
                <text fg={DEFAULT_FG}>{`${dlgSelect()!.state.query}▏`}</text>
              </box>
            </Show>
            <text fg={MUTED}>{"─".repeat(DLG_INNER_W)}</text>
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
                    innerW: item.swatch ? DLG_INNER_W - 2 : DLG_INNER_W,
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
            <text fg={MUTED}>{selectFooter(dlgSelectSpec()).slice(0, DLG_INNER_W)}</text>
          </box>
        </Show>
        <Show when={dlgPrompt()}>
          <box
            position="absolute"
            left={dialogPos(dims().width, dims().height, DIALOG_W).left}
            top={dialogPos(dims().width, dims().height, DIALOG_W).top}
            width={DIALOG_W}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ACCENT} attributes={1}>
              {dlgPromptSpec().title.slice(0, DLG_INNER_W).padEnd(DLG_INNER_W)}
            </text>
            <text fg={MUTED}>{"─".repeat(DLG_INNER_W)}</text>
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
              {promptFooter(dlgPromptSpec(), dlgPrompt()!.state).text.slice(0, DLG_INNER_W)}
            </text>
          </box>
        </Show>
        <Show when={dlgConfirm()}>
          <box
            position="absolute"
            left={dialogPos(dims().width, dims().height, DIALOG_W).left}
            top={dialogPos(dims().width, dims().height, DIALOG_W).top}
            width={DIALOG_W}
            flexDirection="column"
            backgroundColor={PALETTE_BG}
            border
            borderColor={PALETTE_BORDER}
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={ACCENT} attributes={1}>
              {dlgConfirmSpec().title.slice(0, DLG_INNER_W).padEnd(DLG_INNER_W)}
            </text>
            <text fg={MUTED}>{"─".repeat(DLG_INNER_W)}</text>
            <For each={dlgConfirmSpec().body ? wrapText(dlgConfirmSpec().body!, DLG_INNER_W) : []}>
              {(line) => <text fg={MUTED}>{line || " "}</text>}
            </For>
            <For each={confirmOptions(dlgConfirmSpec())}>
              {(label, i) => {
                const selected = () => dlgConfirm()!.state.sel === i();
                return (
                  <box height={1} backgroundColor={selected() ? TAB_ACTIVE_BG : PALETTE_BG}>
                    <text fg={selected() ? DEFAULT_FG : MUTED}>
                      {`${selected() ? "› " : "  "}${label}`.slice(0, DLG_INNER_W)}
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
  },
  // targetFps stays EXPLICIT: @opentui 0.4.3 still silently defaults it to 30
  // (maxFps already defaults to 60). Re-confirmed on the 0.4.3 bump (M21.2).
  // consoleMode: OpenTUI's error console is an in-app OVERLAY that pops over
  // the canvas on any console.error (a runtime exception mid-render flashed it
  // during the M23.5 resize battery). Off in production; the mirror debug flag
  // keeps it for development, where it is genuinely useful.
  {
    targetFps: 60,
    maxFps: 60,
    consoleMode: process.env.TMUX_IDE_MIRROR_DEBUG ? "console-overlay" : "disabled",
  },
);
