/** Private native capture experiment; this is not the canonical renderer schema. */
export interface NativeGridCaptureCell {
  readonly flags: number;
  readonly width: number;
  readonly bytesHex: string;
  readonly text: string;
  readonly attributes: number;
  readonly foreground: number;
  readonly background: number;
  readonly underline: number;
  readonly link: number;
  readonly storageFlags: number;
}

export interface NativeGridCaptureRow {
  readonly flags: number;
  readonly cells: readonly NativeGridCaptureCell[];
}

export interface NativeGridCapture {
  readonly cols: number;
  readonly rows: number;
  readonly history: number;
  readonly hscrolled: number;
  readonly limit: number;
  readonly cursor: readonly [number, number];
  readonly grid: readonly NativeGridCaptureRow[];
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = MAX_BYTES / 64;
const MAX_CELLS = 1_000_000;

/** Compact renderer-neutral backing transport, using the same bounded native format. */
export function encodeNativeGridCapture(source: NativeGridCapture): string | null {
  const records = [
    JSON.stringify({
      version: 1,
      cols: source.cols,
      rows: source.rows,
      history: source.history,
      hscrolled: source.hscrolled,
      limit: source.limit,
      cursor: source.cursor,
    }) + "\n",
  ];
  let bytes = records[0]!.length;
  for (let index = 0; index < source.grid.length; index++) {
    const row = source.grid[index]!;
    const record =
      JSON.stringify({
        row: index,
        flags: row.flags,
        used: row.cells.length,
        cells: row.cells.map((cell) => [
          cell.flags,
          cell.width,
          cell.bytesHex,
          cell.attributes,
          cell.foreground,
          cell.background,
          cell.underline,
          cell.link,
          cell.storageFlags,
        ]),
      }) + "\n";
    bytes += record.length;
    if (bytes > MAX_BYTES) return null;
    records.push(record);
  }
  return records.join("");
}
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const uint = (value: unknown, max = 0xffffffff): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const signed = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= -0x80000000 &&
  value <= 0x7fffffff;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Accept a complete version-one raw backing only. Ordinary tmux errors, partial
 * captures and oversized payloads produce no state. Iterate NDJSON records
 * without first allocating an unbounded array of lines.
 */
export function decodeNativeGridCapture(text: string): NativeGridCapture | null {
  if (text.length > MAX_BYTES || Buffer.byteLength(text, "utf8") > MAX_BYTES) return null;
  let offset = 0;
  const next = (): unknown => {
    if (offset >= text.length) return null;
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const record: unknown = JSON.parse(text.slice(offset, end));
    offset = end + 1;
    return record;
  };
  try {
    const header = next();
    if (
      !object(header) ||
      header.version !== 1 ||
      !uint(header.cols, MAX_CELLS) ||
      header.cols === 0 ||
      !uint(header.rows, MAX_ROWS) ||
      header.rows === 0 ||
      !uint(header.history, MAX_ROWS) ||
      header.history + header.rows > MAX_ROWS ||
      !uint(header.hscrolled, header.history) ||
      !uint(header.limit) ||
      !Array.isArray(header.cursor) ||
      header.cursor.length !== 2 ||
      !uint(header.cursor[0], header.cols) ||
      !uint(header.cursor[1], header.rows - 1)
    )
      return null;
    const grid: NativeGridCaptureRow[] = [];
    let count = 0;
    for (let index = 0; index < header.history + header.rows; index++) {
      const row = next();
      if (
        !object(row) ||
        row.row !== index ||
        !uint(row.flags) ||
        !uint(row.used, MAX_CELLS - count) ||
        !Array.isArray(row.cells) ||
        row.cells.length !== row.used
      )
        return null;
      count += row.used;
      const cells: NativeGridCaptureCell[] = [];
      for (const raw of row.cells) {
        if (
          !Array.isArray(raw) ||
          raw.length !== 9 ||
          !uint(raw[0]) ||
          !uint(raw[1], 255) ||
          typeof raw[2] !== "string" ||
          raw[2].length > 128 ||
          raw[2].length % 2 !== 0 ||
          !/^[0-9a-f]*$/.test(raw[2]) ||
          !uint(raw[3], 0xffff) ||
          !signed(raw[4]) ||
          !signed(raw[5]) ||
          !signed(raw[6]) ||
          !uint(raw[7]) ||
          !uint(raw[8], 255)
        )
          return null;
        cells.push(
          Object.freeze({
            flags: raw[0],
            width: raw[1],
            bytesHex: raw[2],
            text: utf8.decode(Buffer.from(raw[2], "hex")),
            attributes: raw[3],
            foreground: raw[4],
            background: raw[5],
            underline: raw[6],
            link: raw[7],
            storageFlags: raw[8],
          }),
        );
      }
      grid.push(Object.freeze({ flags: row.flags, cells: Object.freeze(cells) }));
    }
    if (offset < text.length) return null;
    return Object.freeze({
      cols: header.cols,
      rows: header.rows,
      history: header.history,
      hscrolled: header.hscrolled,
      limit: header.limit,
      cursor: Object.freeze([header.cursor[0], header.cursor[1]]) as readonly [number, number],
      grid: Object.freeze(grid),
    });
  } catch {
    return null;
  }
}
