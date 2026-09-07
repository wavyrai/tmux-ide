import type { TerminalReplicaRow, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { orderCells, type Cell } from "../selection.ts";
import { MAX_TERMINAL_SELECTION_BYTES } from "./terminal-selection.ts";
import { retainedTerminalCell } from "../terminal-retained-row.ts";

export type TerminalCopyKeyMode = "emacs" | "vi";

/** Native copy positions include history and may address a padding or end cell. */
export function terminalCopyRow(
  snapshot: TerminalReplicaSnapshot,
  row: number,
): TerminalReplicaRow | undefined {
  return row < snapshot.history.length
    ? snapshot.history[row]
    : snapshot.grid[row - snapshot.history.length];
}

export function terminalCopyLineLength(row: TerminalReplicaRow): number {
  let end = row.cells.length;
  while (end > 0) {
    const cell = retainedTerminalCell(row, end - 1)!;
    if (cell.width !== 1 || (cell.grapheme !== "" && cell.grapheme !== " ")) break;
    end--;
  }
  return end;
}

/** Keyboard copy uses native cell endpoints, unlike owner-normalized mouse selection. */
export function extractTerminalCopySelection(
  snapshot: TerminalReplicaSnapshot,
  anchor: Cell,
  cursor: Cell,
  mode: TerminalCopyKeyMode,
  maxBytes = MAX_TERMINAL_SELECTION_BYTES,
): Readonly<{ text: string; bytes: number }> | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TERMINAL_SELECTION_BYTES)
    return null;
  const count = snapshot.history.length + snapshot.grid.length;
  for (const point of [anchor, cursor]) {
    if (
      !Number.isSafeInteger(point.row) ||
      !Number.isSafeInteger(point.col) ||
      point.row < 0 ||
      point.row >= count ||
      point.col < 0 ||
      point.col > snapshot.cols
    )
      return null;
  }
  const { start, end } = orderCells(anchor, cursor);
  const finalLength = terminalCopyLineLength(terminalCopyRow(snapshot, end.row)!);
  const finalStop = Math.min(end.col, finalLength) + (mode === "vi" ? 1 : 0);
  const parts: string[] = [];
  let bytes = 0;
  const append = (text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > maxBytes) return false;
    parts.push(text);
    return true;
  };
  for (let index = start.row; index <= end.row; index++) {
    const row = terminalCopyRow(snapshot, index)!;
    const wrapped = terminalCopyRow(snapshot, index + 1)?.wrapped === true;
    const length = wrapped ? row.cells.length : terminalCopyLineLength(row);
    const from = Math.min(index === start.row ? start.col : 0, length);
    const stop = Math.min(index === end.row ? finalStop : snapshot.cols, length);
    for (let column = from; column < stop; column++) {
      const cell = retainedTerminalCell(row, column)!;
      if (cell.width !== 0 && !append(cell.grapheme || " ")) return null;
    }
    const final = index === end.row;
    const trimFinalNewline =
      final &&
      (mode === "emacs" || finalStop <= finalLength) &&
      (!wrapped || finalStop !== finalLength);
    if ((!wrapped || stop !== length) && !trimFinalNewline && !append("\n")) return null;
  }
  return bytes === 0 ? null : Object.freeze({ text: parts.join(""), bytes });
}
