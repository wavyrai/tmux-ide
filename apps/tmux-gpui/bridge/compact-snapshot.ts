import {
  TerminalReplicaSnapshotSchemaZ,
  type TerminalReplicaColor,
  type TerminalReplicaRow,
  type TerminalReplicaSnapshot,
} from "../../../packages/contracts/src/terminal-replica.ts";
import { z } from "zod";

// This is the negotiated local GUI encoding, not the daemon delivery protocol.
// Keep metadata explicit: only the repeated cell representation changes.
export const COMPACT_SNAPSHOT_ENCODING = "rle-v1" as const;
export const MAX_COMPACT_CELLS = 262_144;
export const MAX_COMPACT_GRAPHEME_BYTES = 8 * 1024 * 1024;
export type CompactRun = [number, string, 0 | 1 | 2, number, number, number];
export type CompactRow = [boolean, CompactRun[]];
export type CompactSnapshot = Omit<TerminalReplicaSnapshot, "grid" | "history"> & {
  encoding: typeof COMPACT_SNAPSHOT_ENCODING;
  grid: CompactRow[];
  history: CompactRow[];
};

const integer = z.number().int().nonnegative();
const runSchema = z.tuple([
  integer.positive().max(MAX_COMPACT_CELLS),
  z.string(),
  z.union([z.literal(0), z.literal(1), z.literal(2)]),
  integer,
  integer,
  integer.max(255),
]);
const rowSchema = z.tuple([z.boolean(), z.array(runSchema).max(MAX_COMPACT_CELLS)]);
const schema = TerminalReplicaSnapshotSchemaZ.extend({
  encoding: z.literal(COMPACT_SNAPSHOT_ENCODING),
  cols: integer.positive().max(65_535),
  rows: integer.positive().max(65_535),
  grid: z.array(rowSchema).max(MAX_COMPACT_CELLS),
  history: z.array(rowSchema).max(MAX_COMPACT_CELLS),
}).strict();

function packedColor(color: TerminalReplicaColor): number {
  if (color.kind === "default") return 0;
  return color.kind === "indexed" ? 0x01000000 + color.index : 0x02000000 + color.value;
}
function unpackColor(value: number): TerminalReplicaColor {
  if (value === 0) return { kind: "default" };
  if (value >= 0x01000000 && value <= 0x010000ff)
    return { kind: "indexed", index: value - 0x01000000 };
  if (value >= 0x02000000 && value <= 0x02ffffff) return { kind: "rgb", value: value - 0x02000000 };
  throw new Error("Invalid compact color");
}
function dimensions(cols: number, rows: number, grid: number, history: number): void {
  if (
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > 65_535 ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 65_535 ||
    grid !== rows ||
    cols * (rows + history) > MAX_COMPACT_CELLS
  )
    throw new Error("Compact snapshot dimensions exceed bounds");
}
function validGrapheme(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new Error("Invalid compact grapheme");
  // JSON permits lone surrogates, but the Rust consumer requires Unicode scalars.
  if (/[\uD800-\uDFFF]/u.test(value)) throw new Error("Invalid compact Unicode");
}
function validPairs(row: TerminalReplicaRow): void {
  for (const [x, cell] of row.cells.entries()) {
    if (
      cell.width === 1 ||
      (cell.width === 0 && x > 0 && row.cells[x - 1]!.width === 2 && cell.grapheme === "") ||
      (cell.width === 2 && x + 1 < row.cells.length && row.cells[x + 1]!.width === 0)
    )
      continue;
    throw new Error("Invalid compact wide-cell pair");
  }
}
export function encodeCompactSnapshot(snapshot: TerminalReplicaSnapshot): CompactSnapshot {
  dimensions(snapshot.cols, snapshot.rows, snapshot.grid.length, snapshot.history.length);
  let graphemeBytes = 0;
  const encodeRow = (row: TerminalReplicaRow): CompactRow => {
    if (row.cells.length !== snapshot.cols) throw new Error("Compact row width mismatch");
    validPairs(row);
    const runs: CompactRun[] = [];
    for (const cell of row.cells) {
      validGrapheme(cell.grapheme);
      graphemeBytes += Buffer.byteLength(cell.grapheme, "utf8");
      if (graphemeBytes > MAX_COMPACT_GRAPHEME_BYTES)
        throw new Error("Compact grapheme budget exceeded");
      const fg = packedColor(cell.foreground),
        bg = packedColor(cell.background);
      const prior = runs.at(-1);
      if (
        prior &&
        prior[1] === cell.grapheme &&
        prior[2] === cell.width &&
        prior[3] === fg &&
        prior[4] === bg &&
        prior[5] === cell.attributes
      )
        prior[0]++;
      else runs.push([1, cell.grapheme, cell.width, fg, bg, cell.attributes]);
    }
    return [row.wrapped, runs];
  };
  return {
    ...snapshot,
    encoding: COMPACT_SNAPSHOT_ENCODING,
    grid: snapshot.grid.map(encodeRow),
    history: snapshot.history.map(encodeRow),
  };
}

/** Validate budgets before expansion. No partially decoded snapshot escapes. */
export function decodeCompactSnapshot(value: unknown): TerminalReplicaSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid compact snapshot");
  const outline = value as Record<string, unknown>;
  if (
    typeof outline.cols !== "number" ||
    typeof outline.rows !== "number" ||
    !Array.isArray(outline.grid) ||
    !Array.isArray(outline.history)
  )
    throw new Error("Invalid compact dimensions");
  dimensions(outline.cols, outline.rows, outline.grid.length, outline.history.length);
  for (const row of [...outline.grid, ...outline.history]) {
    if (!Array.isArray(row) || !Array.isArray(row[1]) || row[1].length > outline.cols)
      throw new Error("Invalid compact run count");
  }
  const compact = schema.parse(value);
  dimensions(compact.cols, compact.rows, compact.grid.length, compact.history.length);
  let graphemeBytes = 0;
  const decodeRow = ([wrapped, runs]: CompactRow): TerminalReplicaRow => {
    let count = 0;
    for (const run of runs) {
      count += run[0];
      if (count > compact.cols) throw new Error("Compact row exceeds width");
      validGrapheme(run[1]);
      graphemeBytes += run[0] * Buffer.byteLength(run[1], "utf8");
      if (graphemeBytes > MAX_COMPACT_GRAPHEME_BYTES)
        throw new Error("Compact grapheme budget exceeded");
    }
    if (count !== compact.cols) throw new Error("Compact row width mismatch");
    const cells: TerminalReplicaRow["cells"] = [];
    for (const [repeat, grapheme, width, fg, bg, attributes] of runs) {
      const foreground = unpackColor(fg),
        background = unpackColor(bg);
      for (let i = 0; i < repeat; i++)
        cells.push({ grapheme, width, foreground, background, attributes });
    }
    const row = { wrapped, cells };
    validPairs(row);
    return row;
  };
  const { encoding: _, grid, history, ...metadata } = compact;
  if (
    !compact.cursor.hidden &&
    (compact.cursor.x >= compact.cols || compact.cursor.y >= compact.rows)
  )
    throw new Error("Compact cursor out of bounds");
  return { ...metadata, grid: grid.map(decodeRow), history: history.map(decodeRow) };
}
