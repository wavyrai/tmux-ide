import type { WidgetCellRow } from "@tmux-ide/contracts";

/**
 * Reading a terminal's grid as CELLS.
 *
 * Rule 10, in code: a column number is turned into a character only through the
 * emulator's cell API. The tempting shortcut — `line.translateToString()` and
 * then index by column — diverges at the first cell that is not one UTF-16 unit
 * wide (an emoji, a combining mark, a variation selector, a ZWJ sequence) and
 * stays diverged for the rest of the line. Every marker after that point on the
 * row would be read at the wrong offset, which is a bug that appears only for
 * users whose output contains emoji and is invisible to everyone testing it.
 *
 * The structural types below are the subset of xterm's buffer API this needs, so
 * the reader is testable against a plain object rather than a live emulator.
 */

export interface CellReader {
  getChars(): string;
  /** 0 for the trailing half of a wide glyph; 1 or 2 otherwise. */
  getWidth(): number;
}

export interface BufferLineReader {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(column: number): CellReader | undefined;
}

export interface BufferReader {
  readonly length: number;
  getLine(index: number): BufferLineReader | undefined;
}

export interface GridReader {
  readonly buffer: { readonly active: BufferReader };
}

/**
 * The most recent `maxRows` rows of the buffer, oldest first.
 *
 * Bounded on purpose: the marker's payload can wrap over a thousand rows, and
 * the pane's scrollback can hold ten thousand more that no marker will ever be
 * in. Reading a window off the end costs a predictable amount per scan.
 */
export function readWidgetCellRows(grid: GridReader, maxRows: number): WidgetCellRow[] {
  const buffer = grid.buffer.active;
  const total = buffer.length;
  if (total <= 0 || maxRows <= 0) return [];
  const start = Math.max(0, total - maxRows);
  const rows: WidgetCellRow[] = [];
  for (let index = start; index < total; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const cells: string[] = [];
    for (let column = 0; column < line.length; column += 1) {
      const cell = line.getCell(column);
      if (!cell) {
        cells.push("");
        continue;
      }
      // A zero-width cell is the second half of a wide glyph; its characters
      // already belong to the cell before it, so emitting them again would
      // duplicate every wide character in the row.
      cells.push(cell.getWidth() === 0 ? "" : cell.getChars());
    }
    rows.push({ cells, wrapped: line.isWrapped });
  }
  return rows;
}

/**
 * How deep a scan goes.
 *
 * A marker at the payload ceiling wraps to roughly 1200 rows on an 80-column
 * grid, and the emulator keeps the rows above it, so the window has to be
 * deeper than the biggest legal marker or a large image would be detected only
 * while its tail was still on screen.
 */
export const WIDGET_SCAN_MAX_ROWS = 2_048;
