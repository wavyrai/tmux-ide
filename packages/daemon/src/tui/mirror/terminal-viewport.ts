import type {
  TerminalReplicaCell,
  TerminalReplicaRow,
  TerminalReplicaSnapshot,
} from "@tmux-ide/contracts";
import { retainedTerminalCell, retainClippedWideOwner } from "./terminal-retained-row.ts";
import type { NativeGridCapture } from "../../terminal/mirror/native-grid-capture.ts";
import {
  resizeNativeFrozenGrid,
  nativeGridCellOrigin,
} from "../../terminal/mirror/native-frozen-grid.ts";
import { projectNativeGridRow } from "../../terminal/mirror/native-grid-projection.ts";
import { terminalReplicaRowsEqual } from "@tmux-ide/core";

const nativeBacking = new WeakMap<TerminalReplicaSnapshot, NativeGridCapture>();

/** Admit only backing whose visible cells match this immutable canonical snapshot. */
export function retainNativeTerminalBacking(
  snapshot: TerminalReplicaSnapshot,
  backing: NativeGridCapture,
): boolean {
  if (
    snapshot.cols !== backing.cols ||
    snapshot.rows !== backing.rows ||
    snapshot.history.length !== backing.history
  )
    return false;
  const rows = [...snapshot.history, ...snapshot.grid];
  for (let index = 0; index < rows.length; index++) {
    const row = projectNativeGridRow(
      backing.grid[index],
      backing.cols,
      0,
      index > 0 && (backing.grid[index - 1]!.flags & 1) !== 0,
    );
    if (!row || !terminalReplicaRowsEqual(rows[index]!, row)) return false;
  }
  nativeBacking.set(snapshot, backing);
  return true;
}

/** Client-local cell coordinates; these never resize or mutate the native pane. */
export interface TerminalViewportOrigin {
  readonly x: number;
  readonly y: number;
}

export interface TerminalViewportSize {
  readonly cols: number;
  readonly rows: number;
}

interface TerminalViewportSource extends TerminalViewportSize {
  readonly cursor: Readonly<{ x: number; y: number; hidden: boolean }>;
}

export function clampTerminalViewportOrigin(
  source: TerminalViewportSize,
  viewport: TerminalViewportSize,
  origin: TerminalViewportOrigin,
  historyDepth = 0,
): TerminalViewportOrigin {
  return {
    x: Math.max(0, Math.min(Math.max(0, source.cols - viewport.cols), origin.x)),
    y: Math.max(-historyDepth, Math.min(Math.max(0, source.rows - viewport.rows), origin.y)),
  };
}

/**
 * tmux tty_window_offset1's automatic cursor following, applied to a pane's
 * content rectangle after the shell has removed sidebar, headers and footer.
 * Hidden cursors retain the top-left view, as native tmux does. A caller reading
 * history retains its own origin instead of following subsequent live output.
 */
export function terminalLiveViewportOrigin(
  source: TerminalViewportSource,
  viewport: TerminalViewportSize,
): TerminalViewportOrigin {
  const cols = Math.max(1, viewport.cols);
  const rows = Math.max(1, viewport.rows);
  const maxX = Math.max(0, source.cols - cols);
  const maxY = Math.max(0, source.rows - rows);
  if (source.cursor.hidden) return { x: 0, y: 0 };
  const x =
    source.cursor.x < cols
      ? 0
      : source.cursor.x > maxX
        ? maxX
        : source.cursor.x - Math.floor(cols / 2);
  const y = source.cursor.y < rows ? 0 : source.cursor.y > maxY ? maxY : source.cursor.y - rows + 1;
  return { x: Math.max(0, Math.min(maxX, x)), y: Math.max(0, Math.min(maxY, y)) };
}

/** Translate an on-screen cell to a canonical live/history cell. Negative y is history. */
export function terminalViewportCell(
  viewport: TerminalViewportSize,
  origin: TerminalViewportOrigin,
  column: number,
  row: number,
): Readonly<{ col: number; row: number }> | null {
  if (
    !Number.isSafeInteger(column) ||
    !Number.isSafeInteger(row) ||
    column < 0 ||
    row < 0 ||
    column >= viewport.cols ||
    row >= viewport.rows
  )
    return null;
  return { col: origin.x + column, row: origin.y + row };
}

type PositionToken =
  | { kind: "cell"; cell: TerminalReplicaCell; row: number; column: number; padding: boolean }
  | { kind: "end"; row: number; column: number };

interface LogicalRange {
  start: number;
  end: number;
}

function* logicalRanges(
  snapshot: TerminalReplicaSnapshot,
): Generator<LogicalRange, undefined, void> {
  const count = snapshot.history.length + snapshot.grid.length;
  let start = 0;
  for (let row = 1; row < count; row++) {
    const current =
      row < snapshot.history.length
        ? snapshot.history[row]
        : snapshot.grid[row - snapshot.history.length];
    if (!current!.wrapped) {
      yield { start, end: row };
      start = row;
    }
  }
  if (count > 0) yield { start, end: count };
}

/** Walk logical text without copying history or allocating a token array. */
function* logicalTokens(
  snapshot: TerminalReplicaSnapshot,
  range?: LogicalRange,
): Generator<PositionToken, undefined, void> {
  const count = snapshot.history.length + snapshot.grid.length;
  const rowAt = (index: number) =>
    index < snapshot.history.length
      ? snapshot.history[index]
      : snapshot.grid[index - snapshot.history.length];
  for (let row = range?.start ?? 0; row < (range?.end ?? count); row++) {
    const current = rowAt(row)!;
    const next = rowAt(row + 1);
    const continues = next?.wrapped === true;
    let used = current.cells.length;
    if (!continues) {
      while (used > 0 && (retainedTerminalCell(current, used - 1)!.grapheme || " ") === " ") used--;
    }
    for (let column = 0; column < used; column++) {
      const cell = retainedTerminalCell(current, column)!;
      if (cell.width === 0) continue;
      yield {
        kind: "cell",
        cell,
        row,
        column,
        // A wide glyph can leave one unused column before wrapping. Qualify
        // this painted space against the other snapshot's logical text.
        padding:
          continues &&
          column === current.cells.length - 1 &&
          (cell.grapheme || " ") === " " &&
          next !== undefined &&
          retainedTerminalCell(next, 0)?.width === 2,
      };
    }
    if (!continues) yield { kind: "end", row, column: used };
  }
}

function matchLogicalPosition(
  previous: TerminalReplicaSnapshot,
  next: TerminalReplicaSnapshot,
  origin: TerminalViewportOrigin,
  beforeRange?: LogicalRange,
  afterRange?: LogicalRange,
): TerminalViewportOrigin | null {
  if (previous.modes.alternateScreen || next.modes.alternateScreen) return null;
  const oldRow = previous.history.length + origin.y;
  const before = logicalTokens(previous, beforeRange);
  const after = logicalTokens(next, afterRange);
  let a = before.next().value;
  let b = after.next().value;
  let mapped: { row: number; column: number } | null = null;
  while (a || b) {
    // Height changes may add/remove unused blank rows below the retained text.
    // They do not shift an already mapped point in the common logical prefix.
    if (!a && b?.kind === "end") {
      b = after.next().value;
    } else if (!b && a?.kind === "end") {
      a = before.next().value;
    } else if (a?.kind === "end" && b?.kind === "end") {
      if (oldRow === a.row && origin.x >= a.column) mapped = b;
      // The complete anchored line and everything before it agree. Output
      // below that line cannot move the reader and need not be scanned.
      if (mapped) return { x: mapped.column, y: mapped.row - next.history.length };
      a = before.next().value;
      b = after.next().value;
    } else if (
      a?.kind === "cell" &&
      b?.kind === "cell" &&
      (a.cell.grapheme || " ") === (b.cell.grapheme || " ") &&
      a.cell.width === b.cell.width
    ) {
      if (a.row === oldRow && origin.x >= a.column && origin.x < a.column + a.cell.width)
        mapped = { row: b.row, column: b.column + origin.x - a.column };
      a = before.next().value;
      b = after.next().value;
    } else if (a?.kind === "cell" && a.padding) {
      if (a.row === oldRow && a.column === origin.x && b) mapped = { row: b.row, column: b.column };
      a = before.next().value;
    } else if (b?.kind === "cell" && b.padding) b = after.next().value;
    else return null;
  }
  return mapped ? { x: mapped.column, y: mapped.row - next.history.length } : null;
}

/** Preserve an ordered prefix, or a unique retained line after logical rows were removed. */
export function reflowTerminalPosition(
  previous: TerminalReplicaSnapshot,
  next: TerminalReplicaSnapshot,
  origin: TerminalViewportOrigin,
  frozen = false,
): TerminalViewportOrigin | null {
  // Native backing can arrive without replacing the immutable retained view.
  // Its coordinates are already exact; avoid walking the entire history just
  // to rediscover the same row (including the native cell-identity search).
  if (
    previous === next &&
    Number.isInteger(origin.x) &&
    origin.x >= 0 &&
    origin.x < previous.cols &&
    Number.isInteger(origin.y) &&
    origin.y >= -previous.history.length &&
    origin.y < previous.grid.length
  )
    return { ...origin };
  const beforeBacking = nativeBacking.get(previous);
  const afterBacking = nativeBacking.get(next);
  if (beforeBacking && afterBacking) {
    const cell = beforeBacking.grid[beforeBacking.history + origin.y]?.cells[origin.x];
    if (cell) {
      const identity = nativeGridCellOrigin(cell);
      for (let row = 0; row < afterBacking.grid.length; row++) {
        const column = afterBacking.grid[row]!.cells.findIndex(
          (candidate) => nativeGridCellOrigin(candidate) === identity,
        );
        if (column >= 0)
          return { x: Math.min(column, next.cols - 1), y: row - afterBacking.history };
      }
    }
  }
  if (frozen) {
    previous = { ...previous, modes: { ...previous.modes, alternateScreen: false } };
    next = { ...next, modes: { ...next.modes, alternateScreen: false } };
  }
  const oldRow = previous.history.length + origin.y;
  if (
    !previous.modes.alternateScreen &&
    !next.modes.alternateScreen &&
    previous.cols === next.cols &&
    Number.isInteger(oldRow) &&
    oldRow >= 0 &&
    oldRow < previous.history.length + previous.grid.length &&
    Number.isInteger(origin.x) &&
    origin.x >= 0 &&
    origin.x <= previous.cols
  ) {
    let sharedPrefix = true;
    for (let index = 0; index <= oldRow; index++) {
      const before =
        index < previous.history.length
          ? previous.history[index]
          : previous.grid[index - previous.history.length];
      const after =
        index < next.history.length ? next.history[index] : next.grid[index - next.history.length];
      if (before !== after) {
        sharedPrefix = false;
        break;
      }
    }
    if (sharedPrefix) return { x: origin.x, y: oldRow - next.history.length };
  }
  const prefix = matchLogicalPosition(previous, next, origin);
  if (prefix || previous.modes.alternateScreen || next.modes.alternateScreen) return prefix;
  let anchored: LogicalRange | undefined;
  let oldLines = 0;
  for (const range of logicalRanges(previous)) {
    oldLines++;
    if (oldRow >= range.start && oldRow < range.end) anchored = range;
  }
  if (!anchored) return null;
  let candidate: TerminalViewportOrigin | null = null;
  let newLines = 0;
  for (const range of logicalRanges(next)) {
    newLines++;
    const match = matchLogicalPosition(previous, next, origin, anchored, range);
    if (match) {
      // A repeated paragraph has no unique correspondence. Never pick its
      // first occurrence merely because its text looks plausible.
      if (candidate) return null;
      candidate = match;
    }
  }
  return newLines < oldLines ? candidate : null;
}

/** Bound expanded presentation storage independently of compact wire size. */
export const RETAINED_TERMINAL_MAX_CELLS = 1_000_000;
export const RETAINED_TERMINAL_MAX_ROWS = 10_000;

function resizeRetainedTerminalHeight(
  source: TerminalReplicaSnapshot,
  rows: number,
): TerminalReplicaSnapshot | null {
  const count = source.history.length + source.grid.length;
  if (Math.max(count, rows) > RETAINED_TERMINAL_MAX_ROWS) return null;
  const output = [...source.history, ...source.grid];
  if (rows > count) {
    if (source.cols > RETAINED_TERMINAL_MAX_CELLS) return null;
    const empty: TerminalReplicaCell = Object.freeze({
      grapheme: "",
      width: 1,
      attributes: 0,
      foreground: { kind: "default" as const },
      background: { kind: "default" as const },
    });
    const blank = Object.freeze({
      wrapped: false,
      cells: Object.freeze(Array<TerminalReplicaCell>(source.cols).fill(empty)),
    }) as unknown as TerminalReplicaRow;
    while (output.length < rows) output.push(blank);
  }
  const depth = output.length - rows;
  return Object.freeze({
    ...source,
    rows,
    history: Object.freeze(output.slice(0, depth)),
    grid: Object.freeze(output.slice(depth)),
    cursor: Object.freeze({
      ...source.cursor,
      y: Math.max(0, Math.min(rows - 1, source.history.length + source.cursor.y - depth)),
    }),
  }) as unknown as TerminalReplicaSnapshot;
}

/** Resize a frozen presentation without interpreting bytes or changing live state. */
export function reflowRetainedTerminalSnapshot(
  source: TerminalReplicaSnapshot,
  cols: number,
  rows: number,
): TerminalReplicaSnapshot | null {
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 1 || rows < 1)
    return null;
  if (cols === source.cols && rows === source.rows) return source;
  const backing = nativeBacking.get(source);
  if (backing) {
    const resized = resizeNativeFrozenGrid(backing, cols, rows);
    if (!resized) return null;
    const projected = resized.grid.map((row, index) =>
      projectNativeGridRow(row, cols, 0, index > 0 && (resized.grid[index - 1]!.flags & 1) !== 0),
    );
    if (projected.some((row) => row === null)) return null;
    const snapshot = Object.freeze({
      ...source,
      cols,
      rows,
      history: Object.freeze(projected.slice(0, resized.history)),
      grid: Object.freeze(projected.slice(resized.history)),
      cursor: Object.freeze({
        ...source.cursor,
        x: Math.min(cols - 1, resized.cursor[0]),
        y: resized.cursor[1],
      }),
    }) as unknown as TerminalReplicaSnapshot;
    nativeBacking.set(snapshot, resized);
    return snapshot;
  }
  // Moving the screen/history boundary does not change physical text rows.
  // Share them instead of walking and rebuilding every retained cell.
  if (cols === source.cols) return resizeRetainedTerminalHeight(source, rows);
  const maxOutputRows = Math.min(
    RETAINED_TERMINAL_MAX_ROWS,
    Math.floor(RETAINED_TERMINAL_MAX_CELLS / cols),
  );
  if (rows > maxOutputRows) return null;
  // Each logical line needs at least one output row. Reject an impossible
  // expansion before allocating cells, including large histories of short lines.
  let minimumRows = 0;
  for (let index = 0; index < source.history.length + source.grid.length; index++) {
    const next =
      index + 1 < source.history.length
        ? source.history[index + 1]
        : source.grid[index + 1 - source.history.length];
    if (!next?.wrapped && ++minimumRows > maxOutputRows) return null;
  }
  const empty: TerminalReplicaCell = Object.freeze({
    grapheme: "",
    width: 1,
    foreground: { kind: "default" as const },
    background: { kind: "default" as const },
    attributes: 0,
  });
  const output: TerminalReplicaRow[] = [];
  let cells: TerminalReplicaCell[] = [];
  let clippedWideOwner: TerminalReplicaCell | null = null;
  let clippedWideContinuation: TerminalReplicaCell | undefined;
  let wrapped = false;
  let cursor = { x: 0, absoluteRow: 0 };
  const cursorRow = source.history.length + source.cursor.y;
  const finish = () => {
    if (output.length >= maxOutputRows) return false;
    while (cells.length < cols) cells.push(empty);
    const row = Object.freeze({
      cells: Object.freeze(cells),
      wrapped,
    }) as unknown as TerminalReplicaRow;
    if (clippedWideOwner) retainClippedWideOwner(row, clippedWideOwner, clippedWideContinuation);
    output.push(row);
    cells = [];
    clippedWideOwner = null;
    clippedWideContinuation = undefined;
    return true;
  };
  const sourceCount = source.history.length + source.grid.length;
  const at = (index: number) =>
    index < source.history.length
      ? source.history[index]
      : source.grid[index - source.history.length];
  for (let index = 0; index < sourceCount; index++) {
    const row = at(index)!;
    let used = row.cells.length;
    // Preserve written spaces and styled blanks; discard only unused tail cells.
    while (used > 0) {
      const cell = retainedTerminalCell(row, used - 1)!;
      if (
        cell.width !== 1 ||
        cell.grapheme !== "" ||
        cell.attributes !== 0 ||
        cell.foreground.kind !== "default" ||
        cell.background.kind !== "default"
      )
        break;
      used--;
    }
    for (let column = 0; column < used; column++) {
      const cell = retainedTerminalCell(row, column)!;
      if (cell.width === 0) continue;
      const paintedWidth = Math.min(cell.width, cols);
      if (cells.length + paintedWidth > cols) {
        if (!finish()) return null;
        wrapped = true;
      }
      if (output.length >= maxOutputRows) return null;
      if (index === cursorRow && source.cursor.x >= column && source.cursor.x < column + cell.width)
        cursor = { x: cells.length + source.cursor.x - column, absoluteRow: output.length };
      if (cell.width > cols) {
        clippedWideOwner = cell;
        clippedWideContinuation = retainedTerminalCell(row, column + 1);
        cells.push(Object.freeze({ ...cell, grapheme: "", width: 1 }));
      } else cells.push(cell);
      if (cell.width === 2 && cols > 1)
        cells.push(
          retainedTerminalCell(row, column + 1)?.width === 0
            ? retainedTerminalCell(row, column + 1)!
            : Object.freeze({ ...cell, grapheme: "", width: 0 }),
        );
    }
    if (index === cursorRow && source.cursor.x >= used)
      cursor = { x: Math.min(cols - 1, cells.length), absoluteRow: output.length };
    if (!at(index + 1)?.wrapped) {
      if (!finish()) return null;
      wrapped = false;
    }
  }
  if (cells.length > 0 && !finish()) return null;
  while (output.length < rows) {
    wrapped = false;
    if (!finish()) return null;
  }
  const depth = output.length - rows;
  return Object.freeze({
    ...source,
    cols,
    rows,
    history: Object.freeze(output.slice(0, depth)),
    grid: Object.freeze(output.slice(depth)),
    cursor: Object.freeze({
      ...source.cursor,
      x: Math.min(cols - 1, cursor.x),
      y: Math.max(0, Math.min(rows - 1, cursor.absoluteRow - depth)),
    }),
  }) as unknown as TerminalReplicaSnapshot;
}
