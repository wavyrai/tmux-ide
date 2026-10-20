// Replays recorded browser publications (PIPELINE_RECORD jsonl) and prices
// alternative bridge->GUI encodings on the exact same frame sequence:
//   verbose  - today's line (whole window, one JSON object per cell)
//   compact  - whole window, run-length JSON runs as the daemon's compact wire uses
//   binary   - whole window, run-length binary (prototype layout below)
//   rows-*   - only rows that changed since the previous publication of the same
//              geometry (seq-numbered; a geometry change or gap sends a full frame)
// Prints bytes and JS encode time per encoding. With --write DIR it also writes
// each binary frame to DIR/frame-N.bin for the Rust decode microbenchmark.
//
// Binary row layout (little endian):
//   u16 row index, u16 run count, then per run:
//   u16 repeat, u8 width, u8 attrs, u32 fg, u32 bg, u8 grapheme byte length, bytes
// Colors use the GUI's packed form (0 default, 0x01xxxxxx indexed, 0x02rrggbb rgb).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { performance } from "node:perf_hooks";

const [file, ...flags] = process.argv.slice(2);
const writeDir = flags[0] === "--write" ? flags[1] : null;
if (writeDir) mkdirSync(writeDir, { recursive: true });
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const color = (c) => (c.kind === "default" ? 0 : c.kind === "indexed" ? 0x01000000 | c.index : 0x02000000 | c.value);
const cellKey = (c) => `${c.grapheme}\u0000${c.width}\u0000${color(c.foreground)}\u0000${color(c.background)}\u0000${c.attributes}`;

function runs(row) {
  const out = [];
  let prev = null;
  for (const c of row.cells) {
    const key = cellKey(c);
    if (prev && prev.key === key) prev.n++;
    else out.push((prev = { key, n: 1, c }));
  }
  return out;
}
const compactRow = (row) => runs(row).map(({ n, c }) => [n, c.grapheme, c.width, color(c.foreground), color(c.background), c.attributes]);
const encoder = new TextEncoder();
function binaryRows(rows) {
  // Two passes: size, then fill. Rows are [index, row].
  const prepared = rows.map(([index, row]) => [index, runs(row).map((r) => ({ ...r, g: encoder.encode(r.c.grapheme) }))]);
  let size = 4 + 2;
  for (const [, rs] of prepared) {
    size += 4;
    for (const r of rs) size += 13 + r.g.length;
  }
  const buf = Buffer.allocUnsafe(size);
  let o = 0;
  buf.writeUInt32LE(size, o); o += 4;
  buf.writeUInt16LE(prepared.length, o); o += 2;
  for (const [index, rs] of prepared) {
    buf.writeUInt16LE(index, o); o += 2;
    buf.writeUInt16LE(rs.length, o); o += 2;
    for (const r of rs) {
      buf.writeUInt16LE(r.n, o); o += 2;
      buf[o++] = r.c.width;
      buf[o++] = r.c.attributes;
      buf.writeUInt32LE(color(r.c.foreground), o); o += 4;
      buf.writeUInt32LE(color(r.c.background), o); o += 4;
      buf[o++] = r.g.length;
      buf.set(r.g, o); o += r.g.length;
    }
  }
  return buf;
}
const rowText = (row) => row.cells.map(cellKey).join("\u0001");

const totals = {};
const add = (k, bytes, ms) => {
  const t = (totals[k] ??= { bytes: 0, ms: 0, frames: 0 });
  t.bytes += bytes;
  t.ms += ms;
  t.frames++;
};
let prev = null;
let changedRows = 0;
let totalRows = 0;
let n = 0;
for (const line of lines) {
  const e = JSON.parse(line);
  const s = e.snapshot;
  if (!s?.grid) continue;
  n++;
  add("verbose (today)", line.length, 0);
  let t = performance.now();
  const compact = JSON.stringify(s.grid.map(compactRow));
  add("compact JSON, full", compact.length, performance.now() - t);
  t = performance.now();
  const full = binaryRows(s.grid.map((row, i) => [i, row]));
  add("binary RLE, full", full.length, performance.now() - t);
  if (writeDir) writeFileSync(`${writeDir}/frame-${n}.bin`, full);
  const keys = s.grid.map(rowText);
  const same = prev && prev.cols === s.cols && prev.rows === s.rows;
  const changed = same ? s.grid.map((row, i) => [i, row]).filter(([i]) => keys[i] !== prev.keys[i]) : s.grid.map((row, i) => [i, row]);
  changedRows += changed.length;
  totalRows += s.grid.length;
  t = performance.now();
  const verboseRows = JSON.stringify({ seq: n, rows: changed.map(([i, row]) => [i, row]) });
  add("rows changed, verbose JSON", verboseRows.length, performance.now() - t);
  t = performance.now();
  const compactRows = JSON.stringify({ seq: n, rows: changed.map(([i, row]) => [i, compactRow(row)]) });
  add("rows changed, compact JSON", compactRows.length, performance.now() - t);
  t = performance.now();
  const binRows = binaryRows(changed);
  add("rows changed, binary RLE", binRows.length, performance.now() - t);
  prev = { cols: s.cols, rows: s.rows, keys };
}
const base = totals["verbose (today)"]?.bytes ?? 1;
console.log(JSON.stringify({ file, publications: n, changedRowShare: +(changedRows / Math.max(1, totalRows)).toFixed(3) }));
for (const [k, v] of Object.entries(totals))
  console.log(`${k.padEnd(28)} ${(v.bytes / 1e6).toFixed(2).padStart(8)} MB  ${(v.bytes / v.frames / 1e3).toFixed(1).padStart(8)} kB/frame  ${(100 * v.bytes / base).toFixed(2).padStart(7)}%  encode ${(v.ms / v.frames).toFixed(2)} ms/frame`);
