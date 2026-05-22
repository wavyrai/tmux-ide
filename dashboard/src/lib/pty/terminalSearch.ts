/**
 * Pure terminal-buffer search engine (G20-P3).
 *
 * The xterm buffer stores wrapped lines as N separate physical rows
 * marked `isWrapped`. A naive `indexOf` on each row misses matches
 * that straddle a wrap. We build logical lines (concatenated wrap
 * groups) for the search, then translate matches back to physical
 * `{row, col, length}` triples the xterm `terminal.select()` API
 * consumes.
 *
 * Pure — accepts a structural duck-type so vitest can drive synthetic
 * buffers without spinning up xterm.
 */

export interface TerminalSearchBufferLineLike {
  isWrapped?: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalSearchBufferLike {
  length: number;
  getLine(index: number): TerminalSearchBufferLineLike | undefined;
}

export interface TerminalSearchMatch {
  row: number;
  col: number;
  length: number;
}

interface PhysicalSegment {
  row: number;
  startIndex: number;
}

interface LogicalLine {
  text: string;
  segments: PhysicalSegment[];
}

function buildLogicalLines(buffer: TerminalSearchBufferLike): LogicalLine[] {
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(false);
    if (!current || !line.isWrapped) {
      if (current) out.push(current);
      current = { text: "", segments: [] };
    }
    current.segments.push({ row: i, startIndex: current.text.length });
    current.text += text;
  }
  if (current) out.push(current);
  return out;
}

function resolveMatchStart(segments: PhysicalSegment[], startIndex: number): TerminalSearchMatch {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i]!;
    if (startIndex >= segment.startIndex) {
      return {
        row: segment.row,
        col: startIndex - segment.startIndex,
        length: 0,
      };
    }
  }
  const first = segments[0];
  return { row: first?.row ?? 0, col: 0, length: 0 };
}

/** Scan the buffer for case-insensitive matches. Empty queries return
 *  `[]` so callers can use `matches.length === 0` as the "nothing to
 *  highlight" predicate. */
export function collectTerminalSearchMatches(
  buffer: TerminalSearchBufferLike,
  query: string,
): TerminalSearchMatch[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const matches: TerminalSearchMatch[] = [];
  const lines = buildLogicalLines(buffer);
  for (const line of lines) {
    const haystack = line.text.toLocaleLowerCase();
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx === -1) break;
      const start = resolveMatchStart(line.segments, idx);
      matches.push({ row: start.row, col: start.col, length: query.length });
      from = idx + Math.max(1, needle.length);
    }
  }
  return matches;
}

function compareMatchPosition(a: TerminalSearchMatch, b: TerminalSearchMatch): number {
  if (a.row !== b.row) return a.row - b.row;
  if (a.col !== b.col) return a.col - b.col;
  return a.length - b.length;
}

function findExactIndex(
  matches: TerminalSearchMatch[],
  current: TerminalSearchMatch | null,
): number {
  if (!current) return -1;
  return matches.findIndex(
    (m) => m.row === current.row && m.col === current.col && m.length === current.length,
  );
}

/** Step to the next / previous match relative to `current`. Survives
 *  buffer mutations by falling back to the nearest match by position
 *  when the exact current row+col is gone. */
export function getNextTerminalSearchIndex(
  matches: TerminalSearchMatch[],
  current: TerminalSearchMatch | null,
  direction: "next" | "prev",
): number {
  if (matches.length === 0) return -1;
  const idx = findExactIndex(matches, current);
  if (idx === -1 && current) {
    if (direction === "prev") {
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        if (compareMatchPosition(matches[i]!, current) < 0) return i;
      }
      return matches.length - 1;
    }
    const nextIdx = matches.findIndex((m) => compareMatchPosition(m, current) > 0);
    return nextIdx === -1 ? 0 : nextIdx;
  }
  if (idx === -1) {
    return direction === "prev" ? matches.length - 1 : 0;
  }
  if (direction === "prev") {
    return idx === 0 ? matches.length - 1 : idx - 1;
  }
  return idx === matches.length - 1 ? 0 : idx + 1;
}
