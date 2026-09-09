import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import type { Cell } from "../selection.ts";
import { retainedTerminalCell } from "../terminal-retained-row.ts";

export type TerminalSelectionUnitMode = "cell" | "word" | "line";
export interface TerminalSelectionUnitRange {
  readonly start: Cell;
  readonly end: Cell;
}

/** Absolute canonical cells; padding belongs to its preceding wide grapheme. */
export function terminalSelectionUnit(
  snapshot: TerminalReplicaSnapshot,
  cell: Cell,
  mode: TerminalSelectionUnitMode,
): TerminalSelectionUnitRange | null {
  const count = snapshot.history.length + snapshot.grid.length;
  const rowAt = (index: number) =>
    index < snapshot.history.length
      ? snapshot.history[index]
      : snapshot.grid[index - snapshot.history.length];
  if (
    !Number.isSafeInteger(cell.row) ||
    !Number.isSafeInteger(cell.col) ||
    cell.row < 0 ||
    cell.row >= count ||
    cell.col < 0 ||
    cell.col >= snapshot.cols
  )
    return null;
  const owner = (point: Cell): Cell | null => {
    const row = rowAt(point.row);
    if (!row) return null;
    const value = retainedTerminalCell(row, point.col);
    if (!value) return null;
    if (value.width !== 0) return point;
    const previous = point.col > 0 ? retainedTerminalCell(row, point.col - 1) : null;
    return previous?.width === 2 ? { row: point.row, col: point.col - 1 } : null;
  };
  const selected = owner(cell);
  if (!selected) return null;
  if (mode === "cell") return { start: selected, end: selected };
  const maximumWork = 65_536;
  if (mode === "line") {
    let firstRow = selected.row;
    let lastRow = selected.row;
    let work = snapshot.cols;
    while (firstRow > 0 && rowAt(firstRow)?.wrapped) {
      if ((work += snapshot.cols) > maximumWork) return null;
      firstRow--;
    }
    while (lastRow + 1 < count && rowAt(lastRow + 1)?.wrapped) {
      if ((work += snapshot.cols) > maximumWork) return null;
      lastRow++;
    }
    return {
      start: { row: firstRow, col: 0 },
      end: owner({ row: lastRow, col: snapshot.cols - 1 }) ?? {
        row: lastRow,
        col: snapshot.cols - 1,
      },
    };
  }
  let work = 0;
  const kind = (point: Cell) => {
    const text = retainedTerminalCell(rowAt(point.row)!, point.col)?.grapheme || " ";
    if ((work += Math.max(1, text.length)) > maximumWork) return null;
    if (/^[\p{L}\p{N}\p{M}_]+$/u.test(text)) return "word";
    if (/^\s+$/u.test(text)) return "space";
    return "punctuation";
  };
  const wanted = kind(selected);
  if (wanted === null) return null;
  let start = selected;
  let end = selected;
  while (true) {
    const previous =
      start.col > 0
        ? { row: start.row, col: start.col - 1 }
        : start.row > 0 && rowAt(start.row)?.wrapped
          ? { row: start.row - 1, col: snapshot.cols - 1 }
          : null;
    const candidate = previous && owner(previous);
    if (!candidate) break;
    const candidateKind = kind(candidate);
    if (candidateKind === null) return null;
    if (candidateKind !== wanted) break;
    start = candidate;
  }
  while (true) {
    const width = retainedTerminalCell(rowAt(end.row)!, end.col)!.width;
    const column = end.col + width;
    const next =
      column < snapshot.cols
        ? { row: end.row, col: column }
        : end.row + 1 < count && rowAt(end.row + 1)?.wrapped
          ? { row: end.row + 1, col: 0 }
          : null;
    const candidate = next && owner(next);
    if (!candidate) break;
    const candidateKind = kind(candidate);
    if (candidateKind === null) return null;
    if (candidateKind !== wanted) break;
    end = candidate;
  }
  return { start, end };
}

/** Keep the original click unit selected while dragging in either direction. */
export function extendTerminalSelectionUnit(
  snapshot: TerminalReplicaSnapshot,
  anchorRange: TerminalSelectionUnitRange,
  head: Cell,
  mode: TerminalSelectionUnitMode,
): TerminalSelectionUnitRange | null {
  const anchorStart = terminalSelectionUnit(snapshot, anchorRange.start, "cell");
  const anchorEnd = terminalSelectionUnit(snapshot, anchorRange.end, "cell");
  const expanded = terminalSelectionUnit(snapshot, head, mode);
  if (!anchorStart || !anchorEnd || !expanded) return null;
  const before = (a: Cell, b: Cell) => a.row < b.row || (a.row === b.row && a.col < b.col);
  if (before(anchorEnd.end, anchorStart.start)) return null;
  return before(expanded.start, anchorStart.start)
    ? { start: anchorEnd.end, end: expanded.start }
    : {
        start: anchorStart.start,
        end: before(expanded.end, anchorEnd.end) ? anchorEnd.end : expanded.end,
      };
}
