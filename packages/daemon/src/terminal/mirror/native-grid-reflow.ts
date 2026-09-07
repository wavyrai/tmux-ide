/*
 * Row transformation adapted from tmux grid.c.
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

/**
 * Native backing cells are not renderer cells: a padding cell can occupy a
 * storage column on a different row from its wide owner after grid_reflow.
 * Keep storage positions and tmux's width budget separate.
 */
export interface NativeReflowCell {
  readonly text: string;
  readonly width: number;
  readonly padding: boolean;
  readonly requiresExtended?: boolean;
  readonly lineFlags?: number;
}

export const NATIVE_REFLOW_ROW_LIMIT = 262144;
export class NativeReflowLimitError extends RangeError {
  constructor() {
    super("Native reflow exceeds the retained row budget");
  }
}

export interface NativeReflowRow<C extends NativeReflowCell = NativeReflowCell> {
  readonly cells: readonly C[];
  /** tmux GRID_LINE_WRAPPED: this row continues onto the next row. */
  readonly continues: boolean;
  readonly extended: boolean;
  readonly rowFlags?: number;
}

type MutableRow<C extends NativeReflowCell> = {
  cells: C[];
  rowFlags?: number;
  continues: boolean;
  extended: boolean;
  dead?: boolean;
};

/**
 * Physical row transformation corresponding to tmux 3.7c grid.c. The caller
 * supplies cellused cells, including padding, and handles screen/history and
 * cursor positioning separately. No canonical replica is mutated or produced.
 */
export function reflowNativeRows<C extends NativeReflowCell>(
  input: readonly NativeReflowRow<C>[],
  cols: number,
): readonly NativeReflowRow<C>[] {
  return reflowNativeRowsWithHistory(input, cols, 0, 0).grid;
}

export function reflowNativeRowsWithHistory<C extends NativeReflowCell>(
  input: readonly NativeReflowRow<C>[],
  cols: number,
  screenRows: number,
  hscrolled: number,
  copyCell?: (cell: C) => C,
  maxOutputRows = NATIVE_REFLOW_ROW_LIMIT,
): Readonly<{ grid: readonly NativeReflowRow<C>[]; history: number; hscrolled: number }> {
  if (
    !Number.isSafeInteger(screenRows) ||
    screenRows < 0 ||
    screenRows > input.length ||
    !Number.isSafeInteger(hscrolled) ||
    hscrolled < 0 ||
    hscrolled > input.length - screenRows
  )
    throw new RangeError("Invalid native history boundary");
  if (!Number.isSafeInteger(cols) || cols < 1) throw new RangeError("Invalid native grid width");
  if (
    !Number.isSafeInteger(maxOutputRows) ||
    maxOutputRows < 1 ||
    maxOutputRows > NATIVE_REFLOW_ROW_LIMIT
  )
    throw new RangeError("Invalid native reflow row budget");
  if (input.length > NATIVE_REFLOW_ROW_LIMIT || screenRows > maxOutputRows)
    throw new NativeReflowLimitError();
  const source: MutableRow<C>[] = input.map((row) => ({ ...row, cells: [...row.cells] }));
  const output: MutableRow<C>[] = [];
  const empty = (): MutableRow<C> => ({ cells: [], continues: false, extended: false });
  const put = (row: MutableRow<C>, cell: C) => {
    // grid_set_cell into a fresh compact slot drops zero-width padding's
    // extended storage. The source width still governs this pass's budget;
    // the copied cell reads back as width one on the next resize.
    row.cells.push(
      copyCell ? copyCell(cell) : cell.padding && cell.width === 0 ? { ...cell, width: 1 } : cell,
    );
    if (cell.lineFlags) row.rowFlags = (row.rowFlags ?? 0) | cell.lineFlags;
    if (
      cell.requiresExtended ||
      cell.width > 1 ||
      cell.text.length > 1 ||
      cell.text.charCodeAt(0) > 0x7f
    )
      row.extended = true;
  };
  const join = (index: number, target: MutableRow<C>, initialWidth: number) => {
    let width = initialWidth;
    let copied = false;
    let removed = 0;
    const targetIndex = output.length - 1;
    const emptyRows: MutableRow<C>[] = [];
    for (let next = index + 1; next < source.length; next++) {
      const row = source[next]!;
      if (row.cells.length === 0) {
        if (!row.continues) break;
        emptyRows.push(row);
        continue;
      }
      let consumed = 0;
      for (const cell of row.cells) {
        if (width + cell.width > cols) break;
        width += cell.width;
        put(target, cell);
        consumed++;
      }
      if (consumed === 0) break;
      copied = true;
      if (consumed < row.cells.length) {
        row.cells = row.cells.slice(consumed);
        break;
      }
      row.dead = true;
      removed++;
      if (!row.continues) target.continues = false;
      if (!row.continues || width === cols) break;
    }
    if (copied) {
      for (const row of emptyRows) row.dead = true;
      removed += emptyRows.length;
      if (hscrolled > targetIndex + removed) hscrolled -= removed;
      else if (hscrolled > targetIndex) hscrolled = targetIndex;
    }
  };
  for (let index = 0; index < source.length; index++) {
    const row = source[index]!;
    if (row.dead) continue;
    let width = 0;
    let at = 0;
    if (!row.extended) {
      width = row.cells.length;
      at = Math.min(cols, width);
    } else {
      row.cells.forEach((cell, column) => {
        if (at === 0 && width + cell.width > cols) at = column;
        width += cell.width;
      });
    }
    if (width <= cols) {
      if (output.length === maxOutputRows) throw new NativeReflowLimitError();
      output.push(row);
      if (width < cols && row.continues) join(index, row, width);
      continue;
    }
    // Native splitting reserves rows first. Preserve even empty reserved rows
    // (notably a glyph wider than the destination), rather than flattening text.
    let count = 1 + Math.floor((row.cells.length - 1) / cols);
    if (row.extended) {
      count = 2;
      width = 0;
      for (const cell of row.cells.slice(at)) {
        if (width + cell.width > cols) {
          count++;
          width = 0;
        }
        width += cell.width;
      }
    }
    // Refuse expansion before allocating rows or invoking the cell copier.
    if (count > maxOutputRows - output.length) throw new NativeReflowLimitError();
    const split = Array.from({ length: count }, empty);
    split[0] = { ...row, cells: row.cells.slice(0, at), continues: true };
    let line = 1;
    width = 0;
    for (const cell of row.cells.slice(at)) {
      if (width + cell.width > cols) {
        split[line]!.continues = true;
        line++;
        width = 0;
      }
      width += cell.width;
      put(split[line]!, cell);
    }
    split[line]!.continues = row.continues;
    // Large valid splits must not depend on the engine's argument-count limit.
    for (const part of split) output.push(part);
    if (index <= hscrolled) hscrolled += count - 1;
    if (width < cols && row.continues) join(index, split[split.length - 1]!, width);
  }
  while (output.length < screenRows) output.push(empty());
  const history = output.length - screenRows;
  const grid = Object.freeze(
    output.map((row) =>
      Object.freeze({
        cells: Object.freeze(row.cells),
        continues: row.continues,
        extended: row.extended,
        ...(row.rowFlags === undefined ? {} : { rowFlags: row.rowFlags }),
      }),
    ),
  );
  return Object.freeze({ grid, history, hscrolled: Math.min(hscrolled, history) });
}
