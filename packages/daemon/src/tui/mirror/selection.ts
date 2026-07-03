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

/** A cell in surface-local coordinates: mirror = snapshot row + pane column;
 *  editor = buffer line + buffer column. */
export interface Cell {
  row: number;
  col: number;
}

/** An active selection on one surface. `anchor` is where the drag began, `head`
 *  the current/last pointer cell; either may precede the other. */
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
