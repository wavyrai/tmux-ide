/**
 * The unified app (M17.2) — tmux as the engine, tmux-ide as the screen.
 *
 * Sidebar (live fleet, click to switch session) · window tab strip · pane
 * canvas at exact tmux geometry with full color/attribute fidelity, local
 * scrollback (wheel; ↑n/depth badge; any key snaps live), real SGR mouse
 * forwarding into panes whose app enabled mouse mode, 60fps coalesced
 * rendering, ^o pane focus cycle, ^t window cycle, ^q quits (session
 * untouched).
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
 * name. A command PALETTE (F5, or ^p when it arrives) opens a centered,
 * keyboard-only overlay of fuzzy-filtered actions (switch tab / attach session /
 * open file / save / refresh diff / quit). App state — { lastTab, contextSession,
 * openFile, diffFile } — persists to `~/.tmux-ide/app-state.json`
 * (TMUX_IDE_HOME override), debounced, restored on launch.
 *
 * The main area is the HOME panel (fleet cards + detail), a session MIRROR (the
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
 * Two OpenTUI landmines dictate this design — measured empirically, see
 * M17.2 notes:
 *  1. `onMouse` handlers on LATE-MOUNTED nodes (children created by a <For>
 *     AFTER initial render) break dispatch for hits on those nodes entirely;
 *     handler-less late nodes bubble correctly to early-mounted ancestors.
 *     So: handlers ONLY on the always-present containers.
 *  2. Event-prop values must be INLINE ARROWS — a bare function reference is
 *     invoked as a reactive getter during prop wiring.
 * Corollary (M19.1): late-mounted <For> BOXES swallow even handler-less hits,
 * but late-mounted <For> TEXT runs bubble correctly (as the pane canvas proves).
 * So dynamic clickable strips render as bare styled text runs, not box wrappers:
 * the per-window strip is one text-run row hit-tested by x-span math (`spans`),
 * so segment clicks land (^t still cycles). HOVER feedback rides the same path —
 * every region resolves a {region,index} on motion ("over"/"move", cleared on
 * "out") and tints the hovered row/segment with HOVER_BG.
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
import { readdir, writeFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { RGBA, EditBuffer, decodePasteBytes } from "@opentui/core";
import { createSignal, createMemo, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { SessionMirror, type LivePane } from "./session-mirror.ts";
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
  clampSidebarWidth,
  isTab,
  type AppState,
  type Tab,
} from "./app-state.ts";
import { separatorAt, resizedSize, resizeCommand, type Separator } from "./resize-model.ts";
import {
  filterPaletteActions,
  parseBufferList,
  type PaletteAction,
  type TmuxBuffer,
} from "./palette.ts";
import {
  findMatches,
  visitOrder,
  stepMatch,
  offsetForMatch,
  type SearchMatch,
} from "./search-model.ts";
import {
  buildNodes,
  insertChildrenAt,
  removeSubtreeAt,
  type FileNode,
  type RawEntry,
} from "./file-tree.ts";
import { spans, spanHit, spansFromRight, type Span } from "./spans.ts";
import { scrollThumb, trackZone, pageTop, dragTop } from "./scrollbar-model.ts";
import {
  MENU_ITEMS,
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
  chunkByBytes,
  ATTR_INVERSE,
  type Cell,
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
}
interface FleetProject {
  name: string;
  dir: string | null;
  registered: boolean;
  running: boolean;
  status: AgentStatus;
  sessions: FleetSession[];
}
/** One selectable HOME row: a live session, carrying its project context. */
interface HomeRow {
  project: string;
  session: string;
  status: AgentStatus;
  windows: number;
  dir: string | null;
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
const TAB_ACTIVE_BG = RGBA.fromInts(40, 46, 66, 255);
// A single subtle pointer-hover tint, one lift above both DEFAULT_BG (16,16,22)
// and SIDEBAR_BG (22,22,30) and below TAB_ACTIVE_BG — the active/selected state
// always wins over hover. Used on every hoverable row/segment (see `hover`).
const HOVER_BG = RGBA.fromInts(30, 34, 48, 255);
const STATUS_COLOR: Record<AgentStatus, RGBA> = {
  blocked: RGBA.fromInts(240, 100, 100, 255),
  working: RGBA.fromInts(235, 200, 100, 255),
  done: RGBA.fromInts(120, 170, 250, 255),
  idle: RGBA.fromInts(120, 200, 140, 255),
  unknown: RGBA.fromInts(110, 110, 130, 255),
};
const STATUS_GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "●",
  done: "●",
  idle: "○",
  unknown: "·",
};
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
// resolve within CLICK_MS at the same cell; a paste forwarded into a pane is
// chunked so each `send-keys -H` stays under tmux's per-command length cap.
const MAX_CLIP_BYTES = 1_000_000;
const CLICK_MS = 400;
const PASTE_CHUNK_BYTES = 1024;
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
 *  by coordinate math and each render tints with HOVER_BG. */
type HoverRegion = "sidebar" | "home" | "surfacetab" | "windowtab" | "files" | "diff" | "button";

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
  stopPropagation?: () => void;
};

const DEFAULT_FG = RGBA.fromInts(212, 212, 216, 255);
const DEFAULT_BG = RGBA.fromInts(16, 16, 22, 255);
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

render(() => {
  const dims = useTerminalDimensions();
  const canvasCols = () => Math.max(20, dims().width - sidebarW());
  const canvasRows = () => Math.max(4, dims().height - HEADER_ROWS - TABBAR_H);

  // Persisted state (one-shot read at launch — NOT on the render loop). The tab
  // and context restore below; the open editor file / diff selection restore in
  // onMount (after the FFI buffer + fleet arrive).
  const persisted: AppState = loadAppState();
  // ── SIDEBAR WIDTH (M19.3) ────────────────────────────────────────────────
  // Once a fixed constant, now a DRAGGABLE, persisted signal: every geometry
  // that used to read the constant (canvasCols, pane/editor/diff offsets, the
  // window-strip spans, the router's region math, the render widths) reads
  // `sidebarW()` so a boundary drag reflows the whole app. Restored from
  // app-state (clamped), re-clamped defensively, re-persisted on release.
  const [sidebarW, setSidebarW] = createSignal(clampSidebarWidth(persisted.sidebarW));
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
  const [contextSession, setContextSession] = createSignal<string>(persisted.contextSession ?? "");
  const [contextDir, setContextDir] = createSignal<string>("");

  const [curTarget, setCurTarget] = createSignal(
    bareHome ? (persisted.contextSession ?? "") : target,
  );
  const [panes, setPanes] = createSignal<LivePane[]>([]);
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
  // sidebar's flat, deduped session list; `homeRows` is the HOME panel's
  // selectable session rows; `rollup` is the header tally.
  const fleet = (): Array<{ name: string; status: AgentStatus }> =>
    projectsData()
      .flatMap((p) => p.sessions.map((s) => ({ name: s.name, status: s.status })))
      .filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
  const homeRows = (): HomeRow[] =>
    projectsData().flatMap((p) =>
      p.sessions.map((s) => ({
        project: p.name,
        session: s.name,
        status: s.status,
        windows: s.windows.length,
        dir: p.dir,
      })),
    );
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
  const clampedSel = () => Math.min(sel(), Math.max(0, homeRows().length - 1));
  const detailLine = (): string => {
    const r = homeRows()[clampedSel()];
    if (!r) return "no live sessions — launch one, then it appears here";
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
  const [diffDir, setDiffDir] = createSignal(values.diff ?? process.cwd());
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
  const attach = (name: string) => {
    mirror?.dispose();
    scrollOffsets.clear();
    setPanes([]);
    setStatus(`attaching ${name}…`);
    const m = new SessionMirror({
      target: name,
      cols: canvasCols(),
      rows: canvasRows(),
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

  // ── FILES TAB (M18.4) ────────────────────────────────────────────────────
  // A minimal, one-level-expandable file list (left) beside the M18.2 editor
  // (right), rooted at the workspace dir. `fs.readdir` is ALWAYS async (the
  // render-loop landmine); the flat-tree splice/prune math is pure in
  // file-tree.ts.
  const [fileNodes, setFileNodes] = createSignal<FileNode[]>([]);
  const [fileSel, setFileSel] = createSignal(0);
  const [fileTop, setFileTop] = createSignal(0);
  // Which half of the Files tab has the keyboard: the file LIST (j/k/enter) or
  // the EDITOR (typing). Opening a file hands focus to the editor; esc hands it
  // back to the list.
  const [filesFocus, setFilesFocus] = createSignal<"list" | "editor">("list");
  const filesListW = () => Math.max(20, Math.min(44, Math.floor(canvasCols() * 0.34)));
  /** The workspace directory driving both the file list and the diff panel. */
  const workspaceDir = () => contextDir() || process.cwd();
  const fileListVisible = createMemo(() => {
    const nodes = fileNodes();
    const rows = editorRows();
    const top = clampTop(fileTop(), nodes.length, rows);
    return nodes.slice(top, top + rows).map((node, i) => ({ node, index: top + i }));
  });

  const toRaw = (e: { name: string; isDirectory: () => boolean }): RawEntry => ({
    name: e.name,
    isDir: e.isDirectory(),
  });
  /** (Re)load the top-level listing for `dir` (async). Directories that were
   *  expanded collapse back to the fresh root — a lean v1 (deep re-expansion is
   *  a later nicety). */
  const loadFileList = (dir: string) => {
    void readdir(dir, { withFileTypes: true })
      .then((ents) => {
        setFileNodes(buildNodes(dir, ents.map(toRaw), 0));
        setFileSel(0);
        setFileTop(0);
      })
      .catch(() => {
        setFileNodes([]);
      });
  };
  const moveFileSel = (delta: number) => {
    const nodes = fileNodes();
    if (nodes.length === 0) return;
    const idx = clampSel(fileSel() + delta, nodes.length);
    setFileSel(idx);
    setFileTop((t) => scrollToCursor(idx, t, editorRows(), nodes.length));
  };
  /** Enter on a row: open a file in the editor, or toggle a directory (async
   *  readdir → splice children in, or prune the subtree). */
  const activateFile = (index: number) => {
    const node = fileNodes()[index];
    if (!node) return;
    setFileSel(index);
    if (!node.isDir) {
      openEditor(node.path);
      return;
    }
    if (node.expanded) {
      setFileNodes((list) => removeSubtreeAt(list, index));
      return;
    }
    void readdir(node.path, { withFileTypes: true })
      .then((ents) => {
        const children = buildNodes(node.path, ents.map(toRaw), node.depth + 1);
        setFileNodes((list) => insertChildrenAt(list, index, children));
      })
      .catch(() => {});
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
    setContextSession(session);
    const wd = dir ?? process.cwd();
    setContextDir(wd);
    setDiffDir(wd);
    loadFileList(wd);
    switchTarget(session);
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
    if (t === "files" && fileNodes().length === 0) loadFileList(workspaceDir());
    setTab(t);
  };

  // ── COMMAND PALETTE (M18.4) ──────────────────────────────────────────────
  // A centered overlay (F5 / ^p) — a fuzzy input line + result list over the
  // action model in palette.ts. Keyboard-only for v1 (the overlay is late-
  // mounted inside <Show>, so per-node mouse handlers would trip the landmine);
  // the router never touches it.
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [paletteQuery, setPaletteQuery] = createSignal("");
  const [paletteSel, setPaletteSel] = createSignal(0);
  const paletteActions = createMemo(() =>
    filterPaletteActions(
      paletteQuery(),
      fleet().map((s) => s.name),
      { terminal: mode() === "mirror" },
    ),
  );
  const openPalette = () => {
    setPaletteQuery("");
    setPaletteSel(0);
    setPaletteBuffers(null); // always open on the action list, never mid-picker
    setPaletteOpen(true);
  };
  const runPaletteAction = (a: PaletteAction) => {
    // "Paste buffer…" descends into the second-level picker instead of
    // dispatching — keep the palette open and load the buffer list.
    if (a.kind === "paste-buffer") {
      setPaletteSel(0);
      loadBuffers();
      return;
    }
    setPaletteOpen(false);
    switch (a.kind) {
      case "tab":
        selectTab(a.tab);
        break;
      case "attach":
        openWorkspace(a.session, dirForSession(a.session));
        break;
      case "open-file":
        openEditor(a.path);
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
    } else if (evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      setPaletteQuery((q) => q + (evt.shift ? evt.name.toUpperCase() : evt.name));
      setPaletteSel(0);
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
      setPanes(mirror.panes(scrollOffsets));
    }, 16);
    // Fleet via an ASYNC subprocess — the in-process data layer is a chain of
    // synchronous execs that blocks the event loop for seconds and swallows
    // input (mouse events die during the storm). The child does the work.
    const cliPath = new URL("../../../../../bin/cli.js", import.meta.url).pathname;
    let fleetInFlight = false;
    const refreshFleet = () => {
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
    let lastW = canvasCols();
    let lastH = canvasRows();
    const sizeTimer = setInterval(() => {
      if (canvasCols() !== lastW || canvasRows() !== lastH) {
        lastW = canvasCols();
        lastH = canvasRows();
        void mirror?.resize(lastW, lastH);
      }
    }, 200);
    onCleanup(() => {
      clearInterval(t);
      clearInterval(fleetTimer);
      clearInterval(diffTimer);
      clearInterval(sizeTimer);
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
  const searchKey = (evt: { name: string; ctrl: boolean; meta: boolean; shift: boolean }): void => {
    const s = search();
    if (!s) return;
    if (s.editing) {
      if (evt.name === "escape") exitSearch();
      else if (evt.name === "return") executeSearch();
      else if (evt.name === "backspace") setSearch({ query: s.query.slice(0, -1), editing: true });
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
   *  else the focused pane wrapped in bracketed-paste markers + chunked under
   *  tmux's send-keys length cap. The shared paste path — bracketed-paste input
   *  and the buffer picker both funnel here. */
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
      void mirror.sendTextTo(pane, "\x1b[200~").catch(() => {});
      for (const chunk of chunkByBytes(text, PASTE_CHUNK_BYTES))
        void mirror.sendTextTo(pane, chunk).catch(() => {});
      void mirror.sendTextTo(pane, "\x1b[201~").catch(() => {});
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
    if (mirror) {
      void mirror
        .command(`show-buffer -b ${tmuxQuote(name)}`)
        .then((lines) => pasteIntoFocused(Buffer.from(lines.join("\n"), "latin1").toString("utf8")))
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
    return p ? p.snapshot.rows.map((runs) => runs.map((r) => r.text).join("")) : [];
  };
  const commitMirrorCopy = (paneId: string, anchor: Cell, head: Cell) => {
    const { start, end } = orderCells(anchor, head);
    const text = extractSelection(paneRowTexts(paneId), start, end);
    if (text.length > 0) copyText(text);
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
  const editorSelRange = (bufRow: number, lineLen: number): { from: number; to: number } | null => {
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
   *  the 16ms pane tick re-render (same path as the wheel). */
  const applyScrollTop = (surface: ScrollSurface, top: number) => {
    if (surface.surface === "editor") {
      setEditorTop(clampTop(top, editorLines().length, editorRows()));
    } else if (surface.surface === "diff") {
      setDiffTop(clampTop(top, diffLines().length, diffBodyRows()));
    } else {
      const offset = Math.max(0, Math.min(surface.scrollbackDepth, surface.scrollbackDepth - top));
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
    void mirror?.sendTextTo(pane.id, sgrMouse(0, col, row, release)).catch(() => {});
  };
  const wheel = (pane: LivePane, direction: "up" | "down", col: number, row: number) => {
    if (pane.appMouse) {
      void mirror
        ?.sendTextTo(pane.id, sgrMouse(direction === "up" ? 64 : 65, col, row, false))
        .catch(() => {});
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
      const s = fleet()[gy - 2];
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
      const r = homeRows()[gy - 2];
      if (!r) return null;
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
      const top = clampTop(fileTop(), fileNodes().length, editorRows());
      const idx = top + contentY;
      const node = fileNodes()[idx];
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
    return { region: "pane", title: pane.id, items: MENU_ITEMS.pane, paneId: pane.id };
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
    if (m.region === "session") {
      const name = m.session!;
      if (id === "attach") {
        closeMenu();
        openWorkspace(name, m.sessionDir ?? null);
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
            loadFileList(workspaceDir());
          })
          .catch((e) => setStatusNote(`create failed: ${(e as Error).message}`));
      } else if (id === "rename" && val && m.filePath) {
        const p = join(dirname(m.filePath), val);
        void rename(m.filePath, p)
          .then(() => {
            setStatusNote(`renamed → ${val}`);
            loadFileList(workspaceDir());
          })
          .catch((e) => setStatusNote(`rename failed: ${(e as Error).message}`));
      } else if (id === "delete" && m.filePath) {
        void rm(m.filePath, { recursive: true, force: false })
          .then(() => {
            setStatusNote(`deleted ${basename(m.filePath!)}`);
            loadFileList(workspaceDir());
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
      mirror?.dispose();
      editBuffer?.destroy();
      process.exit(0);
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
    // line + n/N navigation), so no key leaks to the pane; ^q above still quits.
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
      // toggles a directory. Otherwise the EDITOR has focus and types; esc hands
      // focus back to the list.
      if (filesFocus() === "list") {
        if (evt.name === "j" || evt.name === "down") moveFileSel(1);
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
      if (evt.name === "o") {
        setPathPrompt("");
        return;
      }
      // `d` — open the diff panel for the selected session's project dir (the
      // home row carries it via the team payload), adopting it as the context.
      if (evt.name === "d") {
        const r = homeRows()[clampedSel()];
        if (r) {
          setContextSession(r.session);
          setContextDir(r.dir ?? process.cwd());
        }
        enterDiff(r?.dir ?? process.cwd());
        return;
      }
      const rows = homeRows();
      if (evt.name === "j" || evt.name === "down") {
        setSel(Math.min(clampedSel() + 1, Math.max(0, rows.length - 1)));
      } else if (evt.name === "k" || evt.name === "up") {
        setSel(Math.max(clampedSel() - 1, 0));
      } else if (evt.name === "return") {
        const r = rows[clampedSel()];
        if (r) openWorkspace(r.session, r.dir);
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
    if (evt.ctrl && evt.name.length === 1) {
      void mirror.sendKey(`C-${evt.name}`).catch(() => {});
      return;
    }
    const named = KEYMAP[evt.name];
    if (named) {
      void mirror.sendKey(named).catch(() => {});
      return;
    }
    if (evt.name.length === 1 && !evt.meta) {
      void mirror.sendText(evt.shift ? evt.name.toUpperCase() : evt.name).catch(() => {});
    }
  });

  // Bracketed paste arrives as a discrete PasteEvent (OpenTUI detects the
  // \x1b[200~…\x1b[201~ markers on stdin). Route it to the focused surface: the
  // EDITOR inserts at the cursor as ONE undo unit; the TERMINAL forwards it to
  // the focused pane re-wrapped in bracketed markers (so apps see a paste, not
  // keystrokes), chunked so each send-keys stays under tmux's length cap.
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
  /** Buttons on the home footer (the last screen row): the two app-handled home
   *  keys (`o` open-file, `d` diff) as clickable chips. The other footer hints
   *  advertise tmux-chrome binds this app's keyboard doesn't own, so they stay
   *  plain text rather than dead buttons. Right-aligned to the fixed edge. */
  const homeButtons = createMemo<{ defs: HeaderButton[]; spans: Span[] }>(() => {
    const defs: HeaderButton[] =
      mode() === "home"
        ? [
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
    } else if (id === "home-open") setPathPrompt("");
    else if (id === "home-diff") {
      // Mirror the home `d` key: adopt the selected session's dir as context and
      // open its diff.
      const r = homeRows()[clampedSel()];
      if (r) {
        setContextSession(r.session);
        setContextDir(r.dir ?? process.cwd());
      }
      enterDiff(r?.dir ?? process.cwd());
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

  /** Resolve the hovered {region, index} from pointer coords with the SAME
   *  geometry the click router uses, then update `hover` (no-op unless changed).
   *  Called on every motion event so the click branches below stay untouched;
   *  any position that isn't a hoverable row/segment clears the tint. */
  const resolveHover = (x: number, y: number) => {
    if (y === 0) {
      const i = spanHit(TAB_SPANS, x);
      setHoverIf(i >= 0 ? { region: "surfacetab", index: i } : null);
      return;
    }
    const gy = y - TABBAR_H;
    if (x < sidebarW()) {
      const idx = gy - 2;
      setHoverIf(idx >= 0 && idx < fleet().length ? { region: "sidebar", index: idx } : null);
      return;
    }
    const m = mode();
    if (m === "home") {
      if (y === dims().height - 1) {
        const i = spanHit(homeButtons().spans, x);
        setHoverIf(i >= 0 ? { region: "button", index: i } : null);
        return;
      }
      const idx = gy - 2;
      setHoverIf(idx >= 0 && idx < homeRows().length ? { region: "home", index: idx } : null);
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
      const top = clampTop(fileTop(), fileNodes().length, editorRows());
      const idx = top + contentY;
      setHoverIf(idx >= 0 && idx < fileNodes().length ? { region: "files", index: idx } : null);
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
      if (x === sidebarW() - 1 || x === sidebarW()) {
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
          const delta = dragging.sep.axis === "x" ? cx - dragging.originCx : cy - dragging.originCy;
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
    // `selecting` null, so their trailing release passes straight through — as
    // does any release on an appMouse pane (which never starts a selection).
    if (type === "up" || type === "drag-end" || type === "drop") {
      if (selecting) {
        const s = selection();
        if (s && s.surface === "mirror" && selecting.surface === "mirror")
          commitMirrorCopy(s.paneId, s.anchor, s.head);
        selecting = null;
        return;
      }
    }
    // Row 0 — the surface tab bar (full width, above the sidebar).
    if (y === 0) {
      if (type !== "down") return;
      const i = spanHit(TAB_SPANS, x);
      if (i >= 0) selectTab(TABS[i]!.key);
      return;
    }
    const gy = y - TABBAR_H;
    if (x < sidebarW()) {
      if (type !== "down") return;
      const s = fleet()[gy - 2];
      if (s) openWorkspace(s.name, dirForSession(s.name));
      return;
    }
    // HOME mode: the main area is the fleet panel. Rows render below the header
    // (gy=0) + rule (gy=1), so a click at row gy hits home row `gy - 2`.
    if (mode() === "home") {
      if (type !== "down") return;
      // The footer occupies the last screen row; its right-aligned [o open] /
      // [d diff] chips are hit-tested there before the row math below.
      if (y === dims().height - 1) {
        const hb = homeButtons();
        const i = spanHit(hb.spans, x);
        if (i >= 0) runButton(hb.defs[i]!.id);
        return;
      }
      const r = homeRows()[gy - 2];
      if (r) {
        setSel(gy - 2);
        openWorkspace(r.session, r.dir);
      }
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
        if (overList) setFileTop((t) => clampTop(t + step, fileNodes().length, editorRows()));
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
        const top = clampTop(fileTop(), fileNodes().length, editorRows());
        const idx = top + contentY;
        if (idx >= 0 && idx < fileNodes().length) {
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
      if (pane.appMouse) {
        forwardPress(pane, x, gy, false);
        return;
      }
      // Non-appMouse pane: begin a drag selection, or on a repeat click select
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
    } else if (type === "up") {
      if (pane.appMouse) forwardPress(pane, x, gy, true);
    } else if (type === "scroll") {
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
              <text fg={tab() === t.key ? DEFAULT_BG : MUTED} attributes={tab() === t.key ? 1 : 0}>
                {tabCell(t)}
              </text>
            </box>
          )}
        </For>
        <box flexGrow={1} />
        <Show when={note()}>
          <text fg={ACCENT} attributes={1}>{`${note()} `}</text>
        </Show>
        <Show when={contextSession()}>
          <text fg={ACCENT}>{`⧉ ${contextSession()} `}</text>
        </Show>
        <text fg={MUTED}>{"F5 ⌘ palette "}</text>
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
          <box flexGrow={1} />
          <text fg={MUTED}>{"F1-4 tabs · F5 palette · ^q quit"}</text>
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
                  <text fg={STATUS_COLOR[c.status]}>{`${STATUS_GLYPH[c.status]} ${c.count}`}</text>
                )}
              </For>
            </box>
            <text fg={MUTED}>{"─".repeat(Math.max(4, canvasCols() - 2))}</text>
            <box flexDirection="column">
              <For each={homeRows()}>
                {(r, i) => (
                  <box
                    flexDirection="row"
                    gap={1}
                    paddingLeft={1}
                    backgroundColor={
                      i() === clampedSel()
                        ? TAB_ACTIVE_BG
                        : isHovered("home", i())
                          ? HOVER_BG
                          : DEFAULT_BG
                    }
                  >
                    <text fg={STATUS_COLOR[r.status]}>{STATUS_GLYPH[r.status]}</text>
                    <text fg={i() === clampedSel() ? DEFAULT_FG : MUTED} attributes={1}>
                      {r.session}
                    </text>
                    <text fg={MUTED}>{`${r.windows}w`}</text>
                    <text fg={MUTED}>{r.project === r.session ? "" : `· ${r.project}`}</text>
                  </box>
                )}
              </For>
            </box>
            <box flexGrow={1} />
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
                    <Show when={pane.snapshot.scrollOffset > 0}>
                      <box position="absolute" right={1} top={0} backgroundColor={BADGE_BG}>
                        <text fg={DEFAULT_FG}>
                          {` ↑${pane.snapshot.scrollOffset}/${pane.scrollbackDepth} `}
                        </text>
                      </box>
                    </Show>
                    {/* Right-edge scrollbar — only while scrolled up, so a live
                        terminal stays clean (mirrorScrollGeom gates on offset). */}
                    {scrollbarOverlay(() => mirrorScrollGeom(pane))}
                  </box>
                )}
              </For>
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
                    const prefix =
                      "  ".repeat(n.depth) + (n.isDir ? (n.expanded ? "▾ " : "▸ ") : "  ");
                    const label = (prefix + n.name).slice(0, filesListW() - 1);
                    return (
                      <box
                        paddingLeft={1}
                        height={1}
                        backgroundColor={
                          selected()
                            ? TAB_ACTIVE_BG
                            : isHovered("files", row.index)
                              ? HOVER_BG
                              : GUTTER_BG
                        }
                      >
                        <text fg={n.isDir ? DIR_FG : selected() ? DEFAULT_FG : MUTED}>{label}</text>
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
                {"j/k file · enter open · ^s save · esc list · ^g home · ^q quit"}
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
                {"j/k file · wheel scroll · ^e edit · r refresh · ^g home · ^q quit"}
              </text>
            </box>
          </Show>
        </box>
      </box>
      {/* COMMAND PALETTE overlay (M18.4) — centered, keyboard-only. Late-mounted
          inside <Show>, so it carries NO mouse handlers (the router never sees
          it); type to fuzzy-filter, up/down to move, enter to run, esc to close. */}
      <Show when={paletteOpen()}>
        <box
          position="absolute"
          left={Math.max(0, Math.floor((dims().width - PALETTE_W) / 2))}
          top={Math.max(1, Math.floor(dims().height / 6))}
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
                <For each={paletteActions().slice(0, PALETTE_ROWS)}>
                  {(a, i) => (
                    <box
                      height={1}
                      backgroundColor={i() === paletteSel() ? TAB_ACTIVE_BG : PALETTE_BG}
                    >
                      <text fg={i() === paletteSel() ? DEFAULT_FG : MUTED}>
                        {(i() === paletteSel() ? "› " : "  ") + a.label}
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
            <For each={paletteBuffers()!.slice(0, PALETTE_ROWS)}>
              {(b, i) => (
                <box
                  height={1}
                  flexDirection="row"
                  backgroundColor={i() === paletteSel() ? TAB_ACTIVE_BG : PALETTE_BG}
                >
                  <text fg={i() === paletteSel() ? DEFAULT_FG : MUTED}>
                    {`${i() === paletteSel() ? "› " : "  "}${b.name}  `}
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
              const bg = () => (selected() || armed() || inputting() ? TAB_ACTIVE_BG : PALETTE_BG);
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
    </box>
  );
});
