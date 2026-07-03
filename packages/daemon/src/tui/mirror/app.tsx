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
 * FOUR MODES: the main area is the HOME panel (fleet cards + detail; the
 * bare-launch / `^h` state), a session MIRROR (the SessionMirror canvas), the
 * built-in file EDITOR (M18.2 — tmux stays the engine running servers/agents;
 * files are edited natively by us), or the git DIFF panel (M18.3 — the
 * working-tree diff of a project's dir, rendered natively). One `mode()` signal
 * drives both the render (`<Show>`) and the router: `route` branches on mode so a
 * home-row click, a pane click, an editor click, and a diff file-row click share
 * one entry point. `switchTarget(name)` → mirror (attach); `^h`/`^g` → home
 * (dispose mirror, keep the live fleet). A real `--target` starts in mirror mode;
 * bare starts in home; `--edit <file>` opens the editor; `--diff <dir>` opens the
 * diff panel. On home, `o` opens a path prompt, `d` opens the diff panel for the
 * selected session's dir; `^e` toggles editor↔previous.
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
 * Known residue: hits precisely ON late-mounted tab-strip boxes still swallow
 * (even handler-less) — the ^t cycle covers window switching until the
 * upstream quirk is fixed.
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
import { appendFileSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, EditBuffer } from "@opentui/core";
import { createSignal, createMemo, onMount, onCleanup, For, Show } from "solid-js";
import { SessionMirror, type LivePane } from "./session-mirror.ts";
import { execFile } from "node:child_process";
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
const sgrMouse = (button: number, col: number, row: number, release: boolean): string =>
  `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
interface WindowTab {
  index: number;
  name: string;
  active: boolean;
}

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
const SIDEBAR_W = 24;
const HEADER_ROWS = 2;
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
  const canvasCols = () => Math.max(20, dims().width - SIDEBAR_W);
  const canvasRows = () => Math.max(4, dims().height - HEADER_ROWS);
  const [mode, setMode] = createSignal<"home" | "mirror" | "editor" | "diff">(
    startDiff ? "diff" : bareHome ? "home" : "mirror",
  );
  const [curTarget, setCurTarget] = createSignal(bareHome ? "" : target);
  const [panes, setPanes] = createSignal<LivePane[]>([]);
  const [windowTabs, setWindowTabs] = createSignal<WindowTab[]>([]);
  const [projectsData, setProjectsData] = createSignal<FleetProject[]>([]);
  const [sel, setSel] = createSignal(0);
  const [status, setStatus] = createSignal(bareHome ? "home" : "attaching…");

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

  // Visible text rows = full height minus header (1) + rule/banner (1) + footer (1).
  const editorRows = () => Math.max(1, dims().height - 3);
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
    setMode("editor");
  };

  const toggleEditor = () => {
    if (!editBuffer) return; // nothing opened yet
    if (mode() === "editor") setMode(prevMode);
    else {
      prevMode = mode() === "mirror" ? "mirror" : "home";
      setMode("editor");
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

  // Body rows below header (1) + rule (1), above the footer (1) — shared by both
  // columns. The left column width is a capped fraction of the canvas.
  const diffBodyRows = () => Math.max(1, dims().height - 3);
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
      const idx = clampSel(diffSel(), files.length);
      setDiffSel(idx);
      loadDiff(files[idx]!);
    });
  };

  /** Enter the diff panel for `dir` (from home `d`, or `--diff` on boot). */
  const enterDiff = (dir: string) => {
    setDiffDir(dir);
    setDiffSel(0);
    setDiffTop(0);
    setDiffFileTop(0);
    setDiffText("");
    setDiffMsg("");
    setMode("diff");
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
  const switchTarget = (name: string) => {
    if (mode() === "mirror" && name === curTarget()) return;
    setCurTarget(name);
    setMode("mirror");
    attach(name);
  };
  /** ^h — leave the mirror and return to the HOME panel. Disposes the control
   *  client (the session itself is untouched) but keeps the live fleet running. */
  const goHome = () => {
    mirror?.dispose();
    mirror = null;
    scrollOffsets.clear();
    setPanes([]);
    setWindowTabs([]);
    setCurTarget("");
    setSel(0);
    setStatus("home");
    setMode("home");
  };

  onMount(() => {
    // `--edit <file>` boots straight into the editor (post-render so the native
    // EditBuffer FFI is loaded).
    if (values.edit) openEditor(values.edit);
    if (mode() === "diff") refreshStatus();
    if (mode() === "mirror") attach(curTarget());
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
        } catch {
          // keep the previous fleet on parse trouble
        }
      });
    };
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

  const paneCell = (pane: LivePane, gx: number, gy: number) => ({
    col: Math.max(0, Math.min(pane.width - 1, gx - SIDEBAR_W - pane.left)),
    row: Math.max(0, Math.min(pane.height - 1, gy - HEADER_ROWS - pane.top)),
  });
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

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "q") {
      mirror?.dispose();
      editBuffer?.destroy();
      process.exit(0);
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
      // home row carries it via the team payload), falling back to the cwd.
      if (evt.name === "d") {
        const r = homeRows()[clampedSel()];
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
        if (r) switchTarget(r.session);
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

  /** One router, fed by the two region containers; geometry is ours. */
  const route = (e: { type: string; x: number; y: number; scroll?: { direction: string } }) => {
    const { type, x, y } = e;
    zzlog(`${type} ${x},${y}`);
    if (x < SIDEBAR_W) {
      if (type !== "down") return;
      const s = fleet()[y - 2];
      if (s) switchTarget(s.name);
      return;
    }
    // HOME mode: the main area is the fleet panel. Rows render below the header
    // (y=0) + rule (y=1), so a click at global row y hits home row `y - 2`.
    if (mode() === "home") {
      if (type !== "down") return;
      const r = homeRows()[y - 2];
      if (r) {
        setSel(y - 2);
        switchTarget(r.session);
      }
      return;
    }
    // EDITOR mode: header (y=0) + rule/banner (y=1), then text rows from y=2.
    // Wheel scrolls the viewport; a click positions the cursor. All coordinate
    // math against geometry we render ourselves — no handlers on the text rows.
    if (mode() === "editor") {
      if (type === "scroll") {
        const dir = e.scroll?.direction;
        if (dir === "up" || dir === "down") {
          setEditorTop((t) =>
            clampTop(
              t + (dir === "up" ? -SCROLL_STEP : SCROLL_STEP),
              editorLines().length,
              editorRows(),
            ),
          );
        }
        return;
      }
      if (type !== "down" || !editBuffer) return;
      const contentY = y - HEADER_ROWS;
      if (contentY < 0 || contentY >= editorRows()) return;
      const { line, col } = clickToCursor({
        cx: x - SIDEBAR_W,
        contentY,
        gutterW: gutterWidth(editorLines().length),
        top: editorTop(),
        lines: editorLines(),
      });
      editBuffer.setCursor(line, col);
      setEditorRev((r) => r + 1);
      return;
    }
    // DIFF mode: header (y=0) + rule (y=1), body from y=2. Left column [0,listW)
    // is the file list, the rest is the diff. Wheel scrolls whichever column the
    // pointer is over; a left-column click selects that file row.
    if (mode() === "diff") {
      const overList = x < SIDEBAR_W + diffListW();
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
      const contentY = y - HEADER_ROWS;
      if (contentY < 0 || !overList) return;
      const top = clampTop(diffFileTop(), diffFiles().length, diffBodyRows());
      const idx = top + contentY;
      if (idx >= 0 && idx < diffFiles().length) selectDiffFile(idx);
      return;
    }
    if (y === 1) {
      if (type !== "down") return;
      let col = SIDEBAR_W + 1;
      for (const w of windowTabs()) {
        const width = ` ${w.index}:${w.name} `.length;
        if (x >= col && x < col + width) {
          mirror?.switchWindow(w.index);
          return;
        }
        col += width + 1;
      }
      return;
    }
    const cx = x - SIDEBAR_W;
    const cy = y - HEADER_ROWS;
    const pane = panes().find(
      (p) => cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height,
    );
    if (!pane) return;
    if (type === "down") {
      mirror?.focus(pane.id);
      if (pane.appMouse) forwardPress(pane, x, y, false);
    } else if (type === "up") {
      if (pane.appMouse) forwardPress(pane, x, y, true);
    } else if (type === "scroll") {
      const dir = e.scroll?.direction;
      if (dir === "up" || dir === "down") {
        const { col, row } = paneCell(pane, x, y);
        wheel(pane, dir, col, row);
      }
    }
  };

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={DEFAULT_BG}>
      <box
        width={SIDEBAR_W}
        flexDirection="column"
        backgroundColor={SIDEBAR_BG}
        paddingLeft={1}
        onMouse={(e: { type: string; x: number; y: number; scroll?: { direction: string } }) =>
          route(e)
        }
      >
        <text fg={ACCENT} attributes={1}>
          tmux-ide
        </text>
        <text fg={MUTED}>{"─".repeat(SIDEBAR_W - 2)}</text>
        <box flexDirection="column">
          <For each={fleet()}>
            {(s) => (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={s.name === curTarget() ? TAB_ACTIVE_BG : SIDEBAR_BG}
              >
                <text fg={STATUS_COLOR[s.status]}>{STATUS_GLYPH[s.status]}</text>
                <text fg={s.name === curTarget() ? DEFAULT_FG : MUTED}>
                  {s.name.slice(0, SIDEBAR_W - 5)}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexGrow={1} />
        <text fg={MUTED}>{"^h home · ^t tab · ^q quit"}</text>
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        onMouse={(e: { type: string; x: number; y: number }) => route(e)}
      >
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
                  backgroundColor={i() === clampedSel() ? TAB_ACTIVE_BG : DEFAULT_BG}
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
          <box paddingLeft={1}>
            <text fg={MUTED}>{`${homeFooter()}   o open file   d diff`}</text>
          </box>
        </Show>
        <Show when={mode() === "mirror"}>
          <box paddingLeft={1} flexDirection="row" gap={1}>
            <text fg={DEFAULT_FG} attributes={1}>
              {curTarget()}
            </text>
            <text fg={MUTED}>{status()}</text>
          </box>
          <box paddingLeft={1} flexDirection="row" gap={1}>
            <For each={windowTabs()}>
              {(w) => (
                <box backgroundColor={w.active ? TAB_ACTIVE_BG : DEFAULT_BG}>
                  <text fg={w.active ? ACCENT : MUTED}>{` ${w.index}:${w.name} `}</text>
                </box>
              )}
            </For>
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
                  <For each={pane.snapshot.rows}>
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
                </box>
              )}
            </For>
          </box>
        </Show>
        <Show when={mode() === "editor"}>
          {/* header (y=0) · rule/banner (y=1) · text rows (y=2+). `route`
              reverses this geometry for wheel + click. Text rows carry NO
              onMouse handler — the main column container routes everything. */}
          <box paddingLeft={1} flexDirection="row" gap={1}>
            <text fg={ACCENT} attributes={1}>
              {editorPath() ? basename(editorPath()!) : "editor"}
            </text>
            <Show when={editorModified()}>
              <text fg={MODIFIED_FG}>●</text>
            </Show>
            <text fg={MUTED}>{`${editorCursor().row + 1}:${editorCursor().col + 1}`}</text>
            <text fg={MUTED}>{`${editorLines().length}L`}</text>
            <text fg={MUTED}>{editorMsg()}</text>
          </box>
          <Show
            when={readOnlyBanner(editorReadOnly())}
            fallback={<text fg={MUTED}>{"─".repeat(Math.max(4, canvasCols() - 2))}</text>}
          >
            <box paddingLeft={1}>
              <text fg={BANNER_FG}>{readOnlyBanner(editorReadOnly())}</text>
            </box>
          </Show>
          <box flexDirection="column">
            <For each={editorVisible()}>
              {(ln) => {
                const gw = gutterWidth(editorLines().length);
                return (
                  <box flexDirection="row" height={1}>
                    <text bg={GUTTER_BG} fg={GUTTER_FG}>
                      {formatGutter(ln.num, gw)}
                    </text>
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
                  </box>
                );
              }}
            </For>
          </box>
          <box flexGrow={1} />
          <box paddingLeft={1}>
            <text fg={MUTED}>{"^s save · ^z undo · ^e toggle · ^g home · ^q quit"}</text>
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
                    backgroundColor={row.index === diffSel() ? TAB_ACTIVE_BG : GUTTER_BG}
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
            {/* Right: unified diff of the selected file. */}
            <box flexGrow={1} flexDirection="column" paddingLeft={1}>
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
  );
});
