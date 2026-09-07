import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type { Cell } from "../selection.ts";
import {
  terminalCopyLineLength,
  terminalCopyRow,
  type TerminalCopyKeyMode,
} from "./terminal-copy-selection.ts";

export interface TerminalCopyCursor {
  readonly snapshot: TerminalReplicaSnapshot;
  readonly mode: TerminalCopyKeyMode;
  readonly position: Cell;
  readonly anchor: Cell | null;
  readonly lastColumn: number;
  readonly lastLength: number;
}

export type TerminalCopyMotion = "left" | "right" | "up" | "down" | "home" | "end";

export function createTerminalCopyCursor(
  snapshot: TerminalReplicaSnapshot,
  mode: TerminalCopyKeyMode,
  viewport?: { x: number; y: number; cols: number; rows: number },
): TerminalCopyCursor {
  const position = { row: snapshot.history.length + snapshot.cursor.y, col: snapshot.cursor.x };
  if (viewport) {
    const first = Math.max(0, snapshot.history.length + viewport.y);
    position.row = Math.max(
      first,
      Math.min(
        first + Math.max(1, viewport.rows) - 1,
        position.row,
        snapshot.history.length + snapshot.grid.length - 1,
      ),
    );
    position.col = Math.max(
      viewport.x,
      Math.min(viewport.x + Math.max(1, viewport.cols) - 1, position.col, snapshot.cols - 1),
    );
  }
  return {
    snapshot,
    mode,
    anchor: null,
    lastColumn: 0,
    lastLength: 0,
    position,
  };
}

/** Native cell motion, including padding positions and emacs' extra end column. */
export function moveTerminalCopyCursor(
  state: TerminalCopyCursor,
  motion: TerminalCopyMotion,
): TerminalCopyCursor {
  const { snapshot, mode } = state;
  let { row, col } = state.position;
  let { lastColumn, lastLength } = state;
  const lastRow = snapshot.history.length + snapshot.grid.length - 1;
  const length = (index: number) => terminalCopyLineLength(terminalCopyRow(snapshot, index)!);
  const limit = (index: number) => Math.max(0, length(index) - (mode === "vi" ? 1 : 0));
  if (motion === "home") {
    while (row > 0 && terminalCopyRow(snapshot, row)?.wrapped) row--;
    col = 0;
  } else if (motion === "end") {
    while (row < lastRow && terminalCopyRow(snapshot, row + 1)?.wrapped) row++;
    col = limit(row);
  } else if (motion === "right") {
    if (col >= limit(row) && row < lastRow) {
      row++;
      col = 0;
    } else if (col < limit(row)) {
      col++;
      while (col < limit(row) && terminalCopyRow(snapshot, row)?.cells[col]?.width === 0) col++;
    }
  } else if (motion === "left") {
    while (col > 0 && terminalCopyRow(snapshot, row)?.cells[col]?.width === 0) col--;
    if (col === 0 && row > 0) {
      row--;
      col = length(row);
    } else if (col > 0) col--;
  } else {
    const oldLength = length(row);
    if (col !== oldLength) {
      lastColumn = col;
      lastLength = oldLength;
    }
    row = Math.max(0, Math.min(lastRow, row + (motion === "up" ? -1 : 1)));
    col = lastColumn;
    const nextLength = length(row);
    if ((col >= lastLength && col !== nextLength) || col > nextLength) col = nextLength;
  }
  col = Math.min(col, limit(row));
  return { ...state, position: { row, col }, lastColumn, lastLength };
}

/** Page within a client-local retained viewport, preserving native boundary motion. */
export function pageTerminalCopyCursor(
  state: TerminalCopyCursor,
  originY: number,
  height: number,
  direction: -1 | 1,
  half = false,
): { cursor: TerminalCopyCursor; originY: number } {
  const { snapshot, mode } = state;
  const first = -snapshot.history.length;
  const last = Math.max(first, snapshot.grid.length - height);
  const origin = Math.max(first, Math.min(last, originY));
  const distance = height > 2 ? (half ? Math.floor(height / 2) : height - 2) : 1;
  const nextOrigin = Math.max(first, Math.min(last, origin + direction * distance));
  let screenRow = state.position.row - snapshot.history.length - origin;
  if (direction < 0 && origin - distance < first) screenRow = Math.max(0, screenRow - distance);
  if (direction > 0 && origin + distance > last)
    screenRow = Math.min(height - 1, screenRow + distance);
  let row = Math.max(
    0,
    Math.min(
      snapshot.history.length + snapshot.grid.length - 1,
      snapshot.history.length + nextOrigin + screenRow,
    ),
  );
  let { lastColumn, lastLength } = state;
  const oldLength = terminalCopyLineLength(terminalCopyRow(snapshot, state.position.row)!);
  if (state.position.col !== oldLength) {
    lastColumn = state.position.col;
    lastLength = oldLength;
  }
  let col = lastColumn;
  const nextLength = terminalCopyLineLength(terminalCopyRow(snapshot, row)!);
  if ((col >= lastLength && col !== nextLength) || col > nextLength) {
    while (
      row < snapshot.history.length + snapshot.grid.length - 1 &&
      terminalCopyRow(snapshot, row + 1)?.wrapped
    )
      row++;
    col = terminalCopyLineLength(terminalCopyRow(snapshot, row)!);
  }
  col = Math.min(
    col,
    Math.max(0, terminalCopyLineLength(terminalCopyRow(snapshot, row)!) - (mode === "vi" ? 1 : 0)),
  );
  return {
    cursor: { ...state, position: { row, col }, lastColumn, lastLength },
    originY: nextOrigin,
  };
}

/** Native scroll-only motion keeps the copy cursor on its viewport row. */
export function scrollTerminalCopyCursor(
  state: TerminalCopyCursor,
  originY: number,
  height: number,
  direction: -1 | 1,
  lines: number,
): { cursor: TerminalCopyCursor; originY: number } {
  const first = -state.snapshot.history.length;
  const last = Math.max(first, state.snapshot.grid.length - height);
  let cursor = state;
  let origin = Math.max(first, Math.min(last, originY));
  for (let i = 0; i < lines; i++) {
    const next = Math.max(first, Math.min(last, origin + direction));
    if (next !== origin) cursor = moveTerminalCopyCursor(cursor, direction < 0 ? "up" : "down");
    origin = next;
  }
  return {
    cursor: { ...cursor, anchor: state.mode === "emacs" ? null : state.anchor },
    originY: origin,
  };
}
