import { z } from "zod";
import { TerminalReplicaSnapshotSchemaZ } from "../../../packages/contracts/src/terminal-replica.ts";
import { MAX_COMPACT_CELLS, type CompactRow, type CompactSnapshot } from "./compact-snapshot.ts";
import type { CompactFrame } from "./compact-delta.ts";
import { MAX_BINARY_BODY, encodeBinaryFrame } from "./binary-framing.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const sequence = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const metadataSchema = TerminalReplicaSnapshotSchemaZ.omit({ grid: true, history: true })
  .extend({
    cols: z.number().int().min(1).max(65535),
    rows: z.number().int().min(1).max(65535),
    encoding: z.enum(["rle-v1", "rle-delta-v1"]),
    epoch: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\x21-\x7e]+$/),
    seq: sequence,
    baseSeq: sequence.optional(),
  })
  .strict();
type Metadata = z.infer<typeof metadataSchema>;
function validMetadata(value: unknown): Metadata {
  const metadata = metadataSchema.parse(value);
  if (
    metadata.encoding === "rle-v1"
      ? metadata.baseSeq !== undefined
      : metadata.baseSeq === undefined || metadata.seq !== metadata.baseSeq + 1
  )
    throw new Error("Invalid binary cell sequence");
  if (metadata.cols * metadata.rows > MAX_COMPACT_CELLS)
    throw new Error("Binary cell budget exceeded");
  return metadata;
}
function validateRows(
  metadata: Metadata,
  records: [number, CompactRow][],
  history: CompactRow[],
): void {
  if (metadata.cols * (metadata.rows + history.length) > MAX_COMPACT_CELLS)
    throw new Error("Binary cell budget exceeded");
  if (
    records.length > metadata.rows ||
    (metadata.encoding === "rle-v1" && records.length !== metadata.rows)
  )
    throw new Error("Binary row count mismatch");
  if (
    !metadata.cursor.hidden &&
    (metadata.cursor.x >= metadata.cols || metadata.cursor.y >= metadata.rows)
  )
    throw new Error("Binary cursor out of bounds");
  let previous = -1,
    graphemeBytes = 0;
  const color = (value: number) =>
    Number.isInteger(value) &&
    (value === 0 ||
      (value >= 0x01000000 && value <= 0x010000ff) ||
      (value >= 0x02000000 && value <= 0x02ffffff));
  const validateRow = (row: CompactRow) => {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== "boolean" ||
      !Array.isArray(row[1]) ||
      row[1].length > metadata.cols
    )
      throw new Error("Invalid binary row");
    let cells = 0,
      wide = false;
    for (const run of row[1]) {
      if (!Array.isArray(run) || run.length !== 6) throw new Error("Invalid binary run");
      const [repeat, text, width, fg, bg, attributes] = run;
      if (
        !Number.isInteger(repeat) ||
        repeat < 1 ||
        repeat > metadata.cols ||
        typeof text !== "string" ||
        ![0, 1, 2].includes(width) ||
        !color(fg) ||
        !color(bg) ||
        !Number.isInteger(attributes) ||
        attributes < 0 ||
        attributes > 255
      )
        throw new Error("Invalid binary run fields");
      cells += repeat;
      if (cells > metadata.cols) throw new Error("Binary row overflow");
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > 256) throw new Error("Invalid binary grapheme");
      for (const scalar of text) {
        const code = scalar.codePointAt(0)!;
        if (code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff))
          throw new Error("Invalid binary grapheme");
      }
      graphemeBytes += repeat * bytes;
      if (graphemeBytes > 8 * 1024 * 1024) throw new Error("Binary grapheme budget exceeded");
      if (wide ? width !== 0 || repeat !== 1 || text !== "" : width === 0)
        throw new Error("Invalid binary wide-cell pair");
      if (width === 2 && repeat !== 1) throw new Error("Invalid binary repeated wide cell");
      wide = width === 2;
    }
    if (cells !== metadata.cols || wide) throw new Error("Invalid binary row width");
  };
  for (const [index, row] of records) {
    if (!Number.isInteger(index) || index <= previous || index >= metadata.rows || index < 0)
      throw new Error("Binary row indices not sorted and unique");
    previous = index;
    validateRow(row);
  }
  for (const row of history) validateRow(row);
}

/** Body layout documented by binary-vectors.json; all integers use network byte order. */
export function encodeBinaryCellFrame(frame: CompactFrame): Buffer {
  const { history, ...body } = frame;
  let records: [number, CompactRow][], metadata: Metadata;
  if (frame.encoding === "rle-v1") {
    const { grid, ...rest } = body as Omit<
      Extract<CompactFrame, { encoding: "rle-v1" }>,
      "history"
    >;
    records = grid.map((row, index) => [index, row]);
    metadata = validMetadata(rest);
  } else {
    const { changedRows, ...rest } = body as Omit<
      Extract<CompactFrame, { encoding: "rle-delta-v1" }>,
      "history"
    >;
    records = changedRows;
    metadata = validMetadata(rest);
  }
  validateRows(metadata, records, history);
  const meta = Buffer.from(JSON.stringify(metadata), "utf8");
  let size = 4 + meta.length + 4 + 4;
  const rowSize = (row: CompactRow) =>
    5 + row[1].reduce((n, run) => n + 16 + Buffer.byteLength(run[1], "utf8"), 0);
  for (const [, row] of records) size += 4 + rowSize(row);
  for (const row of history) size += rowSize(row);
  if (size > MAX_BINARY_BODY) throw new Error("Binary cell frame too large");
  const out = Buffer.allocUnsafe(size);
  let offset = 0;
  const u32 = (n: number) => {
    out.writeUInt32BE(n, offset);
    offset += 4;
  };
  u32(meta.length);
  out.set(meta, offset);
  offset += meta.length;
  const row = (value: CompactRow) => {
    out[offset++] = value[0] ? 1 : 0;
    u32(value[1].length);
    for (const [repeat, text, width, fg, bg, attrs] of value[1]) {
      const bytes = Buffer.from(text, "utf8");
      u32(repeat);
      out.writeUInt16BE(bytes.length, offset);
      offset += 2;
      out.set(bytes, offset);
      offset += bytes.length;
      out[offset++] = width;
      u32(fg);
      u32(bg);
      out[offset++] = attrs;
    }
  };
  u32(records.length);
  for (const [index, value] of records) {
    u32(index);
    row(value);
  }
  u32(history.length);
  for (const value of history) row(value);
  if (offset !== size) throw new Error("Binary cell size mismatch");
  return out;
}

export function decodeBinaryCellFrame(payload: Uint8Array): CompactFrame {
  if (payload.length < 12 || payload.length > MAX_BINARY_BODY)
    throw new Error("Invalid binary cell payload length");
  const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const require = (n: number) => {
    if (n < 0 || n > payload.length - offset) throw new Error("Truncated binary cells");
  };
  const u32 = () => {
    require(4);
    const n = data.getUint32(offset, false);
    offset += 4;
    return n;
  };
  const u8 = () => {
    require(1);
    return payload[offset++]!;
  };
  const metaLength = u32();
  require(metaLength);
  const metadata = validMetadata(
    JSON.parse(utf8.decode(payload.subarray(offset, offset + metaLength))),
  );
  offset += metaLength;
  let graphemeBytes = 0;
  const row = (): CompactRow => {
    const wrapped = u8();
    if (wrapped > 1) throw new Error("Invalid binary wrapped flag");
    const count = u32();
    if (count < 1 || count > metadata.cols) throw new Error("Invalid binary run count");
    const runs: CompactRow[1] = [];
    let cells = 0;
    for (let i = 0; i < count; i++) {
      const repeat = u32();
      require(2);
      const length = data.getUint16(offset, false);
      offset += 2;
      if (repeat < 1 || repeat > metadata.cols || length > 256)
        throw new Error("Invalid binary run bounds");
      cells += repeat;
      if (cells > metadata.cols) throw new Error("Binary row overflow");
      graphemeBytes += repeat * length;
      if (graphemeBytes > 8 * 1024 * 1024) throw new Error("Binary grapheme budget exceeded");
      require(length);
      const text = utf8.decode(payload.subarray(offset, offset + length));
      offset += length;
      const width = u8();
      if (width > 2) throw new Error("Invalid binary cell width");
      runs.push([repeat, text, width as 0 | 1 | 2, u32(), u32(), u8()]);
    }
    if (cells !== metadata.cols) throw new Error("Binary row underflow");
    return [wrapped === 1, runs];
  };
  const count = u32();
  if (count > metadata.rows || (metadata.encoding === "rle-v1" && count !== metadata.rows))
    throw new Error("Invalid binary row count");
  const records: [number, CompactRow][] = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const index = u32();
    if (index <= previous || index >= metadata.rows) throw new Error("Invalid binary row index");
    previous = index;
    records.push([index, row()]);
  }
  const historyCount = u32();
  if (metadata.cols * (metadata.rows + historyCount) > MAX_COMPACT_CELLS)
    throw new Error("Binary history budget exceeded");
  const history: CompactRow[] = [];
  for (let i = 0; i < historyCount; i++) history.push(row());
  if (offset !== payload.length) throw new Error("Trailing binary cell bytes");
  validateRows(metadata, records, history);
  if (metadata.encoding === "rle-v1") {
    const { baseSeq, ...full } = metadata;
    void baseSeq;
    return {
      ...full,
      encoding: "rle-v1",
      grid: records.map(([, r]) => r),
      history,
    } as CompactSnapshot & { epoch: string; seq: number };
  }
  return {
    ...metadata,
    encoding: "rle-delta-v1",
    baseSeq: metadata.baseSeq!,
    changedRows: records,
    history,
  };
}

function publicationObject(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.hasOwn(value, "snapshot")
  )
    throw new Error("Binary publication metadata must omit snapshot");
  return value as Record<string, unknown>;
}
/** Wrap an already encoded cell body atomically with its outer authority metadata. */
export function encodeBinaryCellPublication(
  publication: Record<string, unknown>,
  cellBody: Uint8Array,
): Buffer {
  publicationObject(publication);
  const json = Buffer.from(JSON.stringify(publication), "utf8");
  const length = 4 + json.length + cellBody.length;
  if (cellBody.length < 12 || length > MAX_BINARY_BODY)
    throw new Error("Binary publication exceeds bounds");
  const payload = Buffer.allocUnsafe(length);
  payload.writeUInt32BE(json.length);
  payload.set(json, 4);
  payload.set(cellBody, 4 + json.length);
  return encodeBinaryFrame(2, payload);
}
export function decodeBinaryCellPublication(payload: Uint8Array): {
  publication: Record<string, unknown>;
  frame: CompactFrame;
} {
  if (payload.length < 5 || payload.length > MAX_BINARY_BODY)
    throw new Error("Invalid binary publication bounds");
  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
    0,
    false,
  );
  if (length < 2 || length > payload.length - 4 - 12)
    throw new Error("Invalid binary publication metadata length");
  const publication = publicationObject(JSON.parse(utf8.decode(payload.subarray(4, 4 + length))));
  return { publication, frame: decodeBinaryCellFrame(payload.subarray(4 + length)) };
}
