/**
 * Pure, io-free math for scrollback search (M20.3) — the copy-mode `/` finder,
 * app-native. app.tsx owns the search-session state machine + the io (reading a
 * pane's `bufferLines`, driving scrollOffset); this module owns the arithmetic,
 * unit-tested without a terminal exactly like selection.ts / diff-model.ts.
 *
 * A match is a (line, col) into the pane's full buffer (0 = oldest scrollback
 * line). The render maps a match line to a visible row and inverse/accent-tints
 * its [col, col+len) span; a jump converts a match line to a scrollOffset.
 */

/** One substring hit: `line` is the absolute buffer line, `col` the 0-based
 *  character column of the match start on that line. */
export interface SearchMatch {
  line: number;
  col: number;
}

/**
 * Every case-insensitive substring occurrence of `query` across `lines`, in
 * buffer order (top→bottom, left→right), one entry per occurrence (multiple per
 * line allowed; non-overlapping — the scan advances past each hit). An empty
 * query yields no matches.
 */
export function findMatches(lines: readonly string[], query: string): SearchMatch[] {
  const out: SearchMatch[] = [];
  if (query.length === 0) return out;
  const needle = query.toLowerCase();
  for (let line = 0; line < lines.length; line++) {
    const hay = (lines[line] ?? "").toLowerCase();
    let from = 0;
    for (;;) {
      const idx = hay.indexOf(needle, from);
      if (idx === -1) break;
      out.push({ line, col: idx });
      from = idx + needle.length;
    }
  }
  return out;
}

/**
 * Matches in VISIT order — bottom-up (nearest the live viewport first), the
 * order `/`-then-Enter lands on and n/N cycle through. So visit index 0 is the
 * bottom-most match (shown as "1/N"), and `n` walks upward through the buffer.
 * A fresh copy (does not mutate the input).
 */
export function visitOrder(matches: readonly SearchMatch[]): SearchMatch[] {
  return [...matches].reverse();
}

/** Cycle a match index by `dir` (+1 next / -1 prev) with wraparound; -1 stays
 *  -1 when there are no matches. */
export function stepMatch(current: number, dir: number, total: number): number {
  if (total <= 0) return -1;
  return (((current + dir) % total) + total) % total;
}

/**
 * The scrollOffset (lines above the live viewport) that brings buffer `line`
 * into view, positioned roughly at the middle of a `viewH`-row viewport, clamped
 * to [0, depth]. `depth` is the scrollback budget (lines above the live top);
 * the pane snapshot renders visible row `r` from buffer line `depth - offset + r`,
 * so putting `line` at row `target` needs `offset = depth + target - line`.
 */
export function offsetForMatch(line: number, depth: number, viewH: number): number {
  const target = Math.floor(Math.max(0, viewH) / 2);
  const raw = depth + target - line;
  return Math.max(0, Math.min(depth, raw));
}
