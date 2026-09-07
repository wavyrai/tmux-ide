import type {
  TerminalReplicaCell,
  TerminalReplicaColor,
  TerminalReplicaRow,
} from "@tmux-ide/contracts";
import type { NativeGridCaptureCell, NativeGridCaptureRow } from "./native-grid-capture.ts";

const rowSources = new WeakMap<
  TerminalReplicaRow,
  { source: NativeGridCaptureRow; startColumn: number }
>();
const paintCache = new WeakMap<
  NativeGridCaptureRow,
  {
    columns: number;
    startColumn: number;
    wrapped: boolean;
    row: TerminalReplicaRow;
  }
>();
export function nativeProjectedRowSource(row: TerminalReplicaRow) {
  return rowSources.get(row);
}

const defaultColor: TerminalReplicaColor = Object.freeze({ kind: "default" });
const empty: TerminalReplicaCell = Object.freeze({
  grapheme: "",
  width: 1,
  foreground: defaultColor,
  background: defaultColor,
  attributes: 0,
});
const acsKeys = [..."+,-.0`abcdefghijklmnopqrstuvwxyz{|}~"];
const acsValues = [..."→←↑↓▮◆▒␉␌␍␊°±␤␋┘┐┌└┼⎺⎻─⎼⎽├┤┴┬│≤≥π≠£·"];
const acs = new Map(acsKeys.map((key, index) => [key, acsValues[index]!]));

function color(value: number): TerminalReplicaColor {
  if (value < 0 || value === 8 || value === 9) return defaultColor;
  if (value & 0x02000000) return Object.freeze({ kind: "rgb", value: value & ((1 << 24) - 1) });
  if (value & 0x01000000) return Object.freeze({ kind: "indexed", index: value & 255 });
  if (value <= 7) return Object.freeze({ kind: "indexed", index: value });
  if (value >= 90 && value <= 97) return Object.freeze({ kind: "indexed", index: value - 82 });
  return defaultColor;
}

function paint(cell: NativeGridCaptureCell): TerminalReplicaCell {
  const bits = cell.attributes;
  return Object.freeze({
    grapheme: bits & 0x80 ? (acs.get(cell.text) ?? cell.text) : cell.text,
    width: cell.width === 2 ? 2 : 1,
    foreground: color(cell.foreground),
    background: color(cell.background),
    attributes:
      (bits & 3) |
      (bits & 0x40 ? 4 : 0) |
      (bits & 0x1e04 ? 8 : 0) |
      (bits & 8 ? 16 : 0) |
      (bits & 0x10 ? 32 : 0) |
      (bits & 0x20 ? 64 : 0) |
      (bits & 0x100 ? 128 : 0),
  });
}

/**
 * Clean, column-preserving paint for a retained native row. This is a viewport
 * projection, never a replacement for raw selection/copy backing. Unlike
 * native copy-screen repainting it cannot retain stale cells in unwritten tails.
 */
export function projectNativeGridRow(
  source: NativeGridCaptureRow | undefined,
  columns: number,
  startColumn = 0,
  wrapped = false,
): TerminalReplicaRow | null {
  if (
    !Number.isSafeInteger(columns) ||
    columns < 1 ||
    columns > 16384 ||
    !Number.isSafeInteger(startColumn) ||
    startColumn < 0 ||
    startColumn > 1_000_000
  )
    return null;
  const reusable = source && Object.isFrozen(source) && Object.isFrozen(source.cells);
  const cached = reusable ? paintCache.get(source) : undefined;
  if (
    cached?.columns === columns &&
    cached.startColumn === startColumn &&
    cached.wrapped === wrapped
  )
    return cached.row;
  const cells: TerminalReplicaCell[] = Array(columns).fill(empty);
  for (let x = 0; x < columns; x++) {
    const index = startColumn + x;
    const native = source?.cells[index];
    if (!native) continue;
    const previous = source?.cells[index - 1];
    const clippedOwner =
      x === 0 && (native.flags & 4) !== 0 && previous?.width === 2 && !(previous.flags & 4);
    const styled = paint(clippedOwner ? previous! : native);
    if (
      native.flags & (4 | 0x40 | 0x80) ||
      native.width < 1 ||
      native.width > 2 ||
      x + native.width > columns
    ) {
      const span = native.flags & 0x80 ? Math.max(1, Math.min(native.width, columns - x)) : 1;
      const blank = Object.freeze({ ...styled, grapheme: "", width: 1 as const });
      for (let offset = 0; offset < span; offset++) cells[x + offset] = blank;
      x += span - 1;
      continue;
    }
    cells[x] = styled;
    if (native.width === 2) {
      cells[++x] = Object.freeze({ ...styled, grapheme: "", width: 0 });
    }
  }
  const row = Object.freeze({
    cells: Object.freeze(cells),
    wrapped,
  }) as unknown as TerminalReplicaRow;
  if (source) rowSources.set(row, { source, startColumn });
  if (reusable) paintCache.set(source, { columns, startColumn, wrapped, row });
  return row;
}
