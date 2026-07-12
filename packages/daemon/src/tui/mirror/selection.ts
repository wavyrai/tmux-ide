/**
 * Pure, io-free geometry + text math for mouse selection & clipboard (M19.4).
 *
 * Two surfaces select the same way — the session MIRROR (pane snapshot rows)
 * and the built-in EDITOR (buffer lines) — so the coordinate math lives here,
 * unit-tested without a terminal, exactly like spans.ts / diff-model.ts. app.tsx
 * owns the mouse-gesture state machine and the io (OSC52 to stdout, tmux
 * passthrough, send-keys); this module owns the arithmetic.
 *
 * The selection is LINEAR (terminal-style, reading order), not rectangular: a
 * cell is selected if it falls between the anchor and head in row-major order.
 */

/** A cell in surface-local coordinates. Mirror (M25.6): ABSOLUTE xterm buffer
 *  line (0 = oldest scrollback line) + pane column — anchored to CONTENT, so
 *  the selection survives scrolling mid-drag and can span many screens. Editor:
 *  buffer line + buffer column (already absolute by nature). A visible pane row
 *  `r` at scroll offset `off` maps to absolute line `baseY + r` where
 *  `baseY = scrollbackDepth − off` (the search path's existing arithmetic —
 *  see PaneMirror.bufferLines). */
export interface Cell {
  row: number;
  col: number;
}

/** An active selection on one surface. `anchor` is where the drag began, `head`
 *  the current/last pointer cell; either may precede the other. Mirror cells
 *  are in ABSOLUTE buffer coordinates (see {@link Cell}). */
export type Selection =
  | { surface: "mirror"; paneId: string; anchor: Cell; head: Cell }
  | { surface: "editor"; anchor: Cell; head: Cell };

/** OpenTUI TextAttributes bit for inverse video (matches pane-mirror.ts). */
export const ATTR_INVERSE = 32;

/** Order two cells into reading order (row-major); both endpoints inclusive. */
export function orderCells(a: Cell, b: Cell): { start: Cell; end: Cell } {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return { start: a, end: b };
  return { start: b, end: a };
}

/**
 * The inclusive [from,to] column interval selected on `row` for a linear
 * selection between ordered endpoints, or null when the row is outside the
 * selection or has no cells. `rowLen` is the row's character count.
 */
export function rowSelectionRange(
  row: number,
  rowLen: number,
  start: Cell,
  end: Cell,
): { from: number; to: number } | null {
  if (row < start.row || row > end.row) return null;
  if (rowLen <= 0) return null;
  const rawFrom = row === start.row ? start.col : 0;
  const rawTo = row === end.row ? end.col : rowLen - 1;
  const from = Math.max(0, Math.min(rawFrom, rowLen - 1));
  const to = Math.max(0, Math.min(rawTo, rowLen - 1));
  if (to < from) return null;
  return { from, to };
}

/**
 * Extract the selected text from per-row plain strings between ordered
 * endpoints. Rows join with "\n". When `trimTrailing` (mirror snapshot rows are
 * space-padded to the pane width), trailing whitespace on each visual row is
 * stripped — the terminal-copy convention; the editor passes false to keep
 * buffer text exact.
 */
export function extractSelection(
  rowTexts: string[],
  start: Cell,
  end: Cell,
  trimTrailing = true,
): string {
  const out: string[] = [];
  for (let r = start.row; r <= end.row; r++) {
    const text = rowTexts[r] ?? "";
    const range = rowSelectionRange(r, text.length, start, end);
    let seg = range ? text.slice(range.from, range.to + 1) : "";
    if (trimTrailing) seg = seg.replace(/\s+$/u, "");
    out.push(seg);
  }
  return out.join("\n");
}

// ── Absolute-space mapping (M25.6) ──────────────────────────────────────────
// The selection model is anchored to ABSOLUTE buffer lines; the render works in
// visible pane rows. These mappers are the one bridge: given the pane's current
// baseY (scrollbackDepth − scrollOffset) and height, an absolute range resolves
// to the visible rows it covers and the per-row column spans to highlight.

/** A highlighted span on one VISIBLE pane row (row is viewport-relative). */
export interface VisibleSpan {
  row: number;
  from: number;
  to: number;
}

/** Visible pane rows [0,height) covered by an ORDERED absolute range at the
 *  current view (`baseY` = scrollbackDepth − scrollOffset). Empty when the
 *  whole range is scrolled off either edge. */
export function visibleSelRows(start: Cell, end: Cell, baseY: number, height: number): number[] {
  const lo = Math.max(0, start.row - baseY);
  const hi = Math.min(height - 1, end.row - baseY);
  const out: number[] = [];
  for (let r = lo; r <= hi; r++) out.push(r);
  return out;
}

/**
 * Map an ORDERED absolute range to the visible per-row column spans at the
 * current view. `rowLen(viewRow)` supplies each visible row's selectable cell
 * count (grid width for the framebuffer swap; the row's char count for run
 * tinting — wide glyphs collapse to one char there, so the two callers pass
 * different lengths and each gets spans clamped to ITS space). Rows whose
 * span is empty (zero-length row, or a first/last-row column interval that
 * falls outside it) are omitted.
 */
export function visibleSelectionSpans(
  start: Cell,
  end: Cell,
  baseY: number,
  height: number,
  rowLen: (viewRow: number) => number,
): VisibleSpan[] {
  const out: VisibleSpan[] = [];
  for (const r of visibleSelRows(start, end, baseY, height)) {
    const range = rowSelectionRange(baseY + r, rowLen(r), start, end);
    if (range) out.push({ row: r, from: range.from, to: range.to });
  }
  return out;
}

/**
 * Re-anchor an absolute cell after the buffer trimmed `trimDelta` lines off its
 * top (the scrollback cap rotating mid-drag): every retained line's index
 * dropped by the trim, so the cell follows its content down. A cell whose line
 * was trimmed away clamps to the oldest retained line (row 0), col 0 — the
 * selection top pins to the oldest text still in the buffer.
 */
export function trimAdjustCell(cell: Cell, trimDelta: number): Cell {
  if (trimDelta <= 0) return cell;
  const row = cell.row - trimDelta;
  if (row < 0) return { row: 0, col: 0 };
  return { row, col: cell.col };
}

/**
 * The inclusive [from,to] char interval of the word at `col` in `text`,
 * splitting on /\W/ (word chars are [A-Za-z0-9_]). A click on a non-word char
 * selects just that char; an empty line selects {0,0}.
 */
export function wordRangeAt(text: string, col: number): { from: number; to: number } {
  const n = text.length;
  if (n === 0) return { from: 0, to: 0 };
  const c = Math.max(0, Math.min(col, n - 1));
  const isWord = (ch: string): boolean => /\w/u.test(ch);
  if (!isWord(text[c]!)) return { from: c, to: c };
  let from = c;
  let to = c;
  while (from > 0 && isWord(text[from - 1]!)) from--;
  while (to < n - 1 && isWord(text[to + 1]!)) to++;
  return { from, to };
}

/** The inclusive [from,to] interval covering the line up to its last non-blank
 *  char (a blank line → {0,0}). */
export function lineRangeAt(text: string): { from: number; to: number } {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return { from: 0, to: 0 };
  return { from: 0, to: trimmed.length - 1 };
}

/**
 * The resulting click count (1/2/3, cycling to 1 after 3) for double/triple
 * detection: a click at the same cell within `windowMs` of the previous one
 * increments; anything else resets to 1.
 */
export function clickCount(
  prev: { row: number; col: number; ts: number; count: number } | null,
  cell: Cell,
  ts: number,
  windowMs: number,
): number {
  if (prev && prev.row === cell.row && prev.col === cell.col && ts - prev.ts <= windowMs) {
    return prev.count >= 3 ? 1 : prev.count + 1;
  }
  return 1;
}

/**
 * Toggle the inverse attribute across chars [from,to] (inclusive, in row-char
 * columns) of a row's styled runs, splitting runs at the boundaries so the
 * selected span renders highlighted while every other run keeps its colors.
 * XOR (not OR) so an already-inverse cell — e.g. the painted cursor — flips
 * back, matching pane-mirror's cursor treatment.
 */
export function tintRunsInverse<T extends { text: string; attributes: number }>(
  runs: T[],
  from: number,
  to: number,
): T[] {
  if (to < from) return runs;
  const out: T[] = [];
  let col = 0;
  for (const run of runs) {
    const len = run.text.length;
    const runStart = col;
    const runEnd = col + len - 1;
    col += len;
    if (len === 0 || runEnd < from || runStart > to) {
      out.push(run);
      continue;
    }
    const a = Math.max(from, runStart) - runStart;
    const b = Math.min(to, runEnd) - runStart;
    if (a > 0) out.push({ ...run, text: run.text.slice(0, a) });
    out.push({ ...run, text: run.text.slice(a, b + 1), attributes: run.attributes ^ ATTR_INVERSE });
    if (b + 1 < len) out.push({ ...run, text: run.text.slice(b + 1) });
  }
  return out;
}

/**
 * Set the background color across chars [from,to] (inclusive, in row-char
 * columns) of a row's styled runs, splitting runs at the boundaries so the
 * spanned cells render with `bg` while every other run keeps its colors. The
 * twin of {@link tintRunsInverse} — search-match highlighting paints an accent
 * background (a distinct treatment from the inverse-video selection) so the two
 * can coexist on one row. `bg` is packed 0xRRGGBB (the run bg convention).
 */
export function tintRunsBg<T extends { text: string; bg: number | null }>(
  runs: T[],
  from: number,
  to: number,
  bg: number,
): T[] {
  if (to < from) return runs;
  const out: T[] = [];
  let col = 0;
  for (const run of runs) {
    const len = run.text.length;
    const runStart = col;
    const runEnd = col + len - 1;
    col += len;
    if (len === 0 || runEnd < from || runStart > to) {
      out.push(run);
      continue;
    }
    const a = Math.max(from, runStart) - runStart;
    const b = Math.min(to, runEnd) - runStart;
    if (a > 0) out.push({ ...run, text: run.text.slice(0, a) });
    out.push({ ...run, text: run.text.slice(a, b + 1), bg });
    if (b + 1 < len) out.push({ ...run, text: run.text.slice(b + 1) });
  }
  return out;
}

// ── Select mode on app-mouse panes (M22.9) ──────────────────────────────────
// Panes whose app turned mouse reporting on (`appMouse`) normally get every
// press FORWARDED, so a drag can never start a local selection there. Two
// entries reopen selection: an explicit per-pane SELECT MODE (right-click →
// "Select text…", paused forwarding until esc / a completed copy / focus
// leaving the pane) and a SHIFT-modified press when the terminal passes shift
// through (SGR encodes it as +4 on the button code; many terminals keep
// shift+drag for native selection instead — then only select mode applies).

// ── Implicit drag-select default (M24.2) ─────────────────────────────────────
// Every agent pane (claude/codex) is app-mouse, so "forwarding wins" meant a
// user's whole fleet couldn't drag-select. The DEFAULT now follows the pane:
// where our own detection says an agent runs there, a plain drag selects and
// only a genuine click (press+release in one cell) is forwarded — deferred
// until motion or release decides. Shift INVERTS the pane's default (so on an
// agent pane shift+drag forwards; on a vim pane it selects, as in M22.9), the
// right-click toggle overrides per pane for the session, and `app.dragSelect`
// ("agents"|"always"|"never") sets the policy.

/** Where a plain left drag on a pane goes by default. */
export type PaneDragDefault = "select" | "forward";
/** The `app.dragSelect` policy values (app-config). */
export type DragSelectSetting = "agents" | "always" | "never";

/** PURE — a pane's drag default. Precedence: the session's per-pane override
 *  (the right-click toggle) > the config policy ("always"/"never") > the agent
 *  join ("agents": a pane matching a fleet agent entry selects; every other
 *  app-mouse pane forwards). */
export function paneDragDefault(
  agentEntry: { paneId: string } | undefined,
  config: DragSelectSetting,
  override: PaneDragDefault | null,
): PaneDragDefault {
  if (override !== null) return override;
  if (config === "always") return "select";
  if (config === "never") return "forward";
  return agentEntry !== undefined ? "select" : "forward";
}

/** What a left press on a pane does: run the selection machine NOW, forward
 *  the SGR press NOW, or DEFER (withhold the press until motion starts a
 *  selection or a release-in-place forwards the owed click pair). */
export type PressRouting = "select" | "forward" | "defer";

/** PURE — route a left press. Plain panes and select mode keep the immediate
 *  selection machine. Otherwise the pane's drag default decides, with shift
 *  inverting it: a shift press that lands on "select" stays IMMEDIATE (the
 *  M22.9 behavior — a shift-click was never forwarded), while an unshifted
 *  "select" defers so the pane's app still gets genuine clicks. */
export function routePanePress(
  appMouse: boolean,
  selectModeOn: boolean,
  shift: boolean,
  dragDefault: PaneDragDefault,
): PressRouting {
  if (!appMouse || selectModeOn) return "select";
  const effective: PaneDragDefault = shift
    ? dragDefault === "select"
      ? "forward"
      : "select"
    : dragDefault;
  if (effective === "forward") return "forward";
  return shift ? "select" : "defer";
}

/** PURE — whether the wheel scrolls the LOCAL mirror scrollback (vs. being
 *  forwarded as SGR wheel events). Select mode reclaims the wheel so older
 *  output can be scrolled into view and selected. */
export function wheelScrollsLocal(appMouse: boolean, selectModeOn: boolean): boolean {
  return !appMouse || selectModeOn;
}

/** PURE — the select-mode badge text for a pane width (rendered in the pane's
 *  top-right badge family, next to the scroll badge), degrading label → glyph
 *  → hidden on narrow panes exactly like the agent chip's budget. */
export function selectBadgeLabel(paneWidth: number): string | null {
  if (paneWidth >= 16) return " ⧉ select ";
  if (paneWidth >= 5) return " ⧉ ";
  return null;
}

/** The raw OSC52 clipboard-set escape for a base64 payload (BEL-terminated). */
export function osc52Sequence(base64: string): string {
  return `\x1b]52;c;${base64}\x07`;
}

/**
 * Wrap a sequence in the tmux passthrough envelope (DCS `tmux;` … ST) with inner
 * ESC bytes doubled, so it rides through an outer tmux (with allow-passthrough
 * on) verbatim to the real terminal. Kept tested + available; the app prefers
 * raw OSC52 so `set-clipboard on` captures it into tmux's paste buffer.
 */
export function tmuxPassthrough(seq: string): string {
  const doubled = seq.split("\x1b").join("\x1b\x1b");
  return `\x1bPtmux;${doubled}\x1b\\`;
}

/** Split `text` into chunks each at most `maxBytes` UTF-8 bytes, never breaking
 *  a code point — for send-keys -H, whose per-command length tmux caps. */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  const enc = new TextEncoder();
  const chunks: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of text) {
    const b = enc.encode(ch).length;
    if (curBytes + b > maxBytes && cur.length > 0) {
      chunks.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}
