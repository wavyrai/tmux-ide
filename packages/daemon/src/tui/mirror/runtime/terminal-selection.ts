import type { SessionRuntimeTerminalInput } from "@tmux-ide/contracts";
import type { TerminalReplicaRow, TerminalReplicaSnapshot } from "@tmux-ide/contracts";

import { orderCells, rowSelectionRange, type Cell } from "../selection.ts";
import { retainedTerminalCell } from "../terminal-retained-row.ts";
import {
  terminalViewportCell,
  type TerminalViewportOrigin,
  type TerminalViewportSize,
} from "../terminal-viewport.ts";

export const MAX_TERMINAL_SELECTION_BYTES = 1_000_000;

export interface TerminalSelectionRange {
  readonly paneId: string;
  readonly start: Cell;
  readonly end: Cell;
}

export interface TerminalGestureRuntimeIdentity {
  readonly daemonGeneration: string;
  readonly clientGeneration: number;
  readonly connection: object;
  readonly client: object;
  readonly adapter: object;
  readonly rendererEpoch: number;
}

export interface TerminalGestureLease {
  readonly paneId: string;
  readonly runtime: TerminalGestureRuntimeIdentity;
  readonly sourceEpoch: number;
  readonly canonicalIdentity: Readonly<{
    generation: string;
    incarnation: string;
    revision: number;
    stateHash: string;
    cols: number;
    rows: number;
  }>;
  readonly snapshot: TerminalReplicaSnapshot;
  readonly historyLength: number;
  readonly historyTrim: number;
  readonly mouseProtocol: TerminalReplicaSnapshot["modes"]["mouseProtocol"];
  readonly mouseEncoding: TerminalReplicaSnapshot["modes"]["mouseEncoding"];
  readonly frame: Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
    contentHeight: number;
  }>;
}

export function terminalGestureLeaseMatches(
  lease: TerminalGestureLease,
  current: Readonly<{
    runtime: TerminalGestureRuntimeIdentity | null;
    identity:
      | (TerminalGestureLease["canonicalIdentity"] & {
          readonly sourceEpoch: number;
          readonly historyTrim?: number;
        })
      | null;
    snapshot: TerminalReplicaSnapshot | null;
    frame: TerminalGestureLease["frame"] | null;
  }>,
): boolean {
  const { runtime, identity, snapshot, frame } = current;
  return Boolean(
    runtime &&
    runtime.daemonGeneration === lease.runtime.daemonGeneration &&
    runtime.clientGeneration === lease.runtime.clientGeneration &&
    runtime.connection === lease.runtime.connection &&
    runtime.client === lease.runtime.client &&
    runtime.adapter === lease.runtime.adapter &&
    runtime.rendererEpoch === lease.runtime.rendererEpoch &&
    identity &&
    identity.generation === lease.canonicalIdentity.generation &&
    identity.incarnation === lease.canonicalIdentity.incarnation &&
    identity.revision === lease.canonicalIdentity.revision &&
    identity.stateHash === lease.canonicalIdentity.stateHash &&
    identity.cols === lease.canonicalIdentity.cols &&
    identity.rows === lease.canonicalIdentity.rows &&
    identity.sourceEpoch === lease.sourceEpoch &&
    snapshot &&
    snapshot.cols === lease.snapshot.cols &&
    snapshot.rows === lease.snapshot.rows &&
    snapshot.history.length === lease.historyLength &&
    identity.historyTrim === lease.historyTrim &&
    snapshot.modes.mouseProtocol === lease.mouseProtocol &&
    snapshot.modes.mouseEncoding === lease.mouseEncoding &&
    frame &&
    frame.left === lease.frame.left &&
    frame.top === lease.frame.top &&
    frame.width === lease.frame.width &&
    frame.height === lease.frame.height &&
    frame.contentHeight === lease.frame.contentHeight,
  );
}

function semanticOwnerColumn(row: TerminalReplicaRow, column: number): number | null {
  const cell = retainedTerminalCell(row, column);
  if (!cell) return null;
  if (cell.width !== 0) return column;
  for (let owner = column - 1; owner >= 0; owner -= 1) {
    const candidate = retainedTerminalCell(row, owner);
    if (!candidate) return null;
    if (candidate.width === 2 && owner + 1 === column) return owner;
    if (candidate.width !== 0) return null;
  }
  return null;
}

export function terminalSelectionCell(
  snapshot: TerminalReplicaSnapshot,
  column: number,
  row: number,
  scrollOffset = 0,
  viewport?: TerminalViewportSize & { readonly origin: TerminalViewportOrigin },
): Cell | null {
  if (viewport) {
    const source = terminalViewportCell(viewport, viewport.origin, column, row);
    if (!source) return null;
    column = source.col;
    row = source.row;
  }
  if (
    !Number.isSafeInteger(column) ||
    !Number.isSafeInteger(row) ||
    column < 0 ||
    row < (viewport ? -snapshot.history.length : 0) ||
    column >= snapshot.cols ||
    row >= snapshot.rows
  )
    return null;
  const absolute = viewport
    ? snapshot.history.length + row
    : snapshot.history.length - Math.max(0, Math.min(snapshot.history.length, scrollOffset)) + row;
  const source =
    absolute < snapshot.history.length
      ? snapshot.history[absolute]
      : snapshot.grid[absolute - snapshot.history.length];
  if (!source) return null;
  const owner = semanticOwnerColumn(source, column);
  return owner === null ? null : Object.freeze({ row: absolute, col: owner });
}

function rowCells(row: TerminalReplicaRow, cols: number): readonly string[] {
  const cells: string[] = [];
  for (let column = 0; column < cols; column += 1) {
    const cell = retainedTerminalCell(row, column);
    cells.push(!cell || cell.width === 0 ? "" : cell.grapheme || " ");
  }
  return cells;
}

/** Bounded terminal-cell extraction over the immutable canonical replica. */
export function extractTerminalSelection(
  snapshot: TerminalReplicaSnapshot,
  first: Cell,
  last: Cell,
  maxBytes = MAX_TERMINAL_SELECTION_BYTES,
): Readonly<{ text: string; bytes: number }> | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TERMINAL_SELECTION_BYTES)
    return null;
  for (const point of [first, last]) {
    if (!Number.isSafeInteger(point.row) || !Number.isSafeInteger(point.col)) return null;
  }
  const rowCount = snapshot.history.length + snapshot.grid.length;
  const rowAt = (index: number) =>
    index < snapshot.history.length
      ? snapshot.history[index]
      : snapshot.grid[index - snapshot.history.length];
  const ordered = orderCells(first, last);
  if (
    ordered.start.row < 0 ||
    ordered.end.row >= rowCount ||
    ordered.start.col < 0 ||
    ordered.end.col < 0 ||
    ordered.start.col >= snapshot.cols ||
    ordered.end.col >= snapshot.cols
  )
    return null;
  const startOwner = semanticOwnerColumn(rowAt(ordered.start.row)!, ordered.start.col);
  const endOwner = semanticOwnerColumn(rowAt(ordered.end.row)!, ordered.end.col);
  if (startOwner === null || endOwner === null) return null;
  const start = Object.freeze({ row: ordered.start.row, col: startOwner });
  const end = Object.freeze({ row: ordered.end.row, col: endOwner });
  const selected: string[] = [];
  let bytes = 0;
  for (let index = start.row; index <= end.row; index += 1) {
    const cells = rowCells(rowAt(index)!, snapshot.cols);
    const range = rowSelectionRange(index, snapshot.cols, start, end);
    // tmux clips a hard line at its last non-space cell before selecting;
    // it preserves the full width of a wrapped line. Trimming the selected
    // substring would erase intentional separators and Unicode whitespace.
    let lineEnd = cells.length;
    if (!rowAt(index + 1)?.wrapped) while (lineEnd > 0 && cells[lineEnd - 1] === " ") lineEnd--;
    const segment = range ? cells.slice(range.from, Math.min(range.to + 1, lineEnd)).join("") : "";
    const joinsWrappedRow = selected.length > 0 && rowAt(index)!.wrapped;
    const separatorBytes = selected.length === 0 || joinsWrappedRow ? 0 : 1;
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    if (bytes + separatorBytes + segmentBytes > maxBytes) return null;
    if (separatorBytes) bytes += separatorBytes;
    bytes += segmentBytes;
    if (joinsWrappedRow) selected[selected.length - 1] = `${selected.at(-1) ?? ""}${segment}`;
    else selected.push(segment);
  }
  if (bytes === 0) return null;
  return Object.freeze({ text: selected.join("\n"), bytes });
}

export function terminalSgrMouse(input: {
  readonly action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down";
  readonly column: number;
  readonly row: number;
  readonly button?: number;
  readonly shift?: boolean;
  readonly alt?: boolean;
  readonly ctrl?: boolean;
}): string | null {
  if (
    !Number.isSafeInteger(input.column) ||
    !Number.isSafeInteger(input.row) ||
    input.column < 0 ||
    input.row < 0 ||
    input.column > 16_383 ||
    input.row > 16_383
  )
    return null;
  const button =
    input.action === "wheel-up" ? 64 : input.action === "wheel-down" ? 65 : (input.button ?? 0);
  if (input.action !== "wheel-up" && input.action !== "wheel-down" && ![0, 1, 2].includes(button))
    return null;
  const modifiers = (input.shift ? 4 : 0) + (input.alt ? 8 : 0) + (input.ctrl ? 16 : 0);
  const code =
    (input.action === "move" ? 35 : input.action === "drag" ? 32 + button : button) + modifiers;
  return `\x1b[<${code};${input.column + 1};${input.row + 1}${input.action === "up" ? "m" : "M"}`;
}

/** Encode native pane input without treating legacy protocol bytes as UTF-8 text. */
export function terminalMouseInput(
  input: Parameters<typeof terminalSgrMouse>[0],
  encoding: TerminalReplicaSnapshot["modes"]["mouseEncoding"],
): SessionRuntimeTerminalInput | null {
  const sgr = terminalSgrMouse(input);
  if (!sgr) return null;
  if (encoding === "sgr") return { kind: "text", data: sgr };
  if (encoding !== "default" && encoding !== "utf8") return null;
  const button =
    input.action === "wheel-up" ? 64 : input.action === "wheel-down" ? 65 : (input.button ?? 0);
  const modifiers = (input.shift ? 4 : 0) + (input.alt ? 8 : 0) + (input.ctrl ? 16 : 0);
  const code =
    (input.action === "up"
      ? 3
      : input.action === "move"
        ? 35
        : input.action === "drag"
          ? 32 + button
          : button) + modifiers;
  // Native input-keys.c clamps legacy positions and rejects overflowing UTF-8 reports.
  const values = [code + 32, input.column + 33, input.row + 33];
  if (encoding === "utf8" && values.some((value) => value > 2047)) return null;
  const payload =
    encoding === "utf8"
      ? Buffer.from(String.fromCharCode(...values), "utf8")
      : Buffer.from(values.map((value) => Math.min(255, value)));
  return { kind: "bytes", data: Buffer.concat([Buffer.from("\x1b[M"), payload]).toString("hex") };
}

export function terminalMouseActionSupported(
  snapshot: TerminalReplicaSnapshot,
  action: "down" | "drag" | "move" | "up" | "wheel-up" | "wheel-down",
): boolean {
  if (!["sgr", "default", "utf8"].includes(snapshot.modes.mouseEncoding ?? "")) return false;
  const protocol = snapshot.modes.mouseProtocol;
  if (!protocol) return false;
  if (protocol === "none") return false;
  if (action === "down") return true;
  if (action === "wheel-up" || action === "wheel-down") return protocol !== "x10";
  if (action === "up") return protocol !== "x10";
  if (action === "drag") return protocol === "drag" || protocol === "any";
  return protocol === "any";
}
