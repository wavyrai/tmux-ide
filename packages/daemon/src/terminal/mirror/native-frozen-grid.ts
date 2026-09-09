/*
 * Frozen height transformation adapted from tmux screen.c.
 * Copyright (c) 2008 Nicholas Marriott <nicholas.marriott@gmail.com>
 *
 * Permission to use, copy, modify, and distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

import type {
  NativeGridCapture,
  NativeGridCaptureRow,
  NativeGridCaptureCell,
} from "./native-grid-capture.ts";
import { reflowNativeRowsWithHistory, NativeReflowLimitError } from "./native-grid-reflow.ts";

const cellOrigins = new WeakMap<NativeGridCaptureCell, NativeGridCaptureCell>();
/** Stable cell identity across the native storage conversions performed by reflow. */
export function nativeGridCellOrigin(cell: NativeGridCaptureCell): NativeGridCaptureCell {
  return cellOrigins.get(cell) ?? cell;
}

function requiresExtended(cell: NativeGridCaptureCell): boolean {
  return (
    cell.attributes > 255 ||
    cell.bytesHex.length > 2 ||
    cell.width > 1 ||
    ((cell.foreground | cell.background) & 0x02000000) !== 0 ||
    cell.underline !== 8 ||
    cell.link !== 0 ||
    (cell.flags & 0x80) !== 0
  );
}

/** Combined frozen backing resize in native order: height, then width. */
export function resizeNativeFrozenGrid(
  source: NativeGridCapture,
  cols: number,
  rows: number,
): NativeGridCapture | null {
  try {
    return resizeNativeFrozenGridWithinBudget(source, cols, rows);
  } catch (error) {
    if (error instanceof NativeReflowLimitError) return null;
    throw error;
  }
}

function resizeNativeFrozenGridWithinBudget(
  source: NativeGridCapture,
  cols: number,
  rows: number,
): NativeGridCapture | null {
  if (!Number.isSafeInteger(cols) || cols < 1 || cols > 1_000_000) return null;
  const height = resizeNativeFrozenHeight(source, rows);
  if (!height || cols === source.cols) return height;
  const backing = reflowNativeRowsWithHistory(
    height.grid.map((row) => ({
      rowFlags: row.flags,
      used: row.used,
      continues: (row.flags & 1) !== 0,
      extended: (row.flags & 2) !== 0,
      cells: row.cells.map((cell) => ({
        text: cell.text,
        width: cell.width,
        padding: (cell.flags & 4) !== 0,
        requiresExtended: requiresExtended(cell),
        lineFlags: cell.link ? 0x20 : 0,
        native: cell,
      })),
    })),
    cols,
    rows,
    height.hscrolled,
    (cell) => {
      const original = cell.native;
      const flags = original.flags & ~0x40;
      const extended = requiresExtended(original);
      const padding = cell.padding && original.width === 0 && !extended;
      const native = Object.freeze({
        ...original,
        flags,
        width: extended ? original.width : 1,
        bytesHex: padding ? "21" : original.bytesHex,
        text: padding ? "!" : original.text,
        storageFlags: extended
          ? flags | 8
          : flags |
            (original.foreground & 0x01000000 ? 1 : 0) |
            (original.background & 0x01000000 ? 2 : 0),
      });
      cellOrigins.set(native, nativeGridCellOrigin(original));
      return { ...cell, text: native.text, width: native.width, native };
    },
  );
  if (backing.grid.length > 262144) return null;
  return Object.freeze({
    ...height,
    cols,
    history: backing.history,
    hscrolled: backing.hscrolled,
    // Native copy backing reflows with cursor=0. The selection cursor is separate.
    cursor: Object.freeze([0, 0]) as readonly [number, number],
    grid: Object.freeze(
      backing.grid.map((row) =>
        Object.freeze({
          ...(source.version === 2 ? { used: row.used ?? row.cells.length } : {}),
          flags: ((row.rowFlags ?? 0) & ~3) | (row.continues ? 1 : 0) | (row.extended ? 2 : 0),
          cells: Object.freeze(row.cells.map((cell) => cell.native)),
        }),
      ),
    ),
  });
}

/**
 * Height-only part of tmux's frozen copy backing resize. Copy mode enables
 * history and uses eat_empty=0: shrinking retains every row, while growth may
 * reclaim scrolled history but must not reclaim explicitly cleared history.
 * Width reflow is a separate subsequent operation in native screen_resize.
 */
export function resizeNativeFrozenHeight(
  source: NativeGridCapture,
  rows: number,
): NativeGridCapture | null {
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 262144) return null;
  if (rows === source.rows) return source;
  const difference = rows - source.rows;
  const reclaimed = difference > 0 ? Math.min(difference, source.hscrolled) : difference;
  const history = source.history - reclaimed;
  if (history + rows > 262144) return null;
  const grid: NativeGridCaptureRow[] = [...source.grid];
  const empty = Object.freeze({ flags: 0, cells: Object.freeze([]) });
  while (grid.length < history + rows) grid.push(empty);
  const absoluteCursorRow = source.history + source.cursor[1];
  const cursor =
    absoluteCursorRow >= history ? [source.cursor[0], absoluteCursorRow - history] : [0, 0];
  return Object.freeze({
    ...source,
    rows,
    history,
    hscrolled: source.hscrolled - reclaimed,
    cursor: Object.freeze(cursor) as readonly [number, number],
    grid: Object.freeze(grid),
  });
}
