/** Upstream tmux 3.8 reuses -R for a textual grid dump, not our JSON extension.
 * Require the generated grid and first-row headers; arbitrary malformed native
 * replies must remain errors rather than silently downgrading capture fidelity.
 */
export function isStockRawGridCapture(lines: readonly string[]): boolean {
  return (
    /^G [1-9][0-9]*x[1-9][0-9]* \([0-9]+\/[0-9]+\)$/.test(lines[0] ?? "") &&
    /^\tL 0 \((?:-|0)\) flags=/.test(lines[1] ?? "")
  );
}

/**
 * The capability question, asked without reading the pane's history (#869).
 * `-V` exists only in tmux-ide's build, in every revision of the patch that
 * adds its `-R`, and tmux rejects an unknown flag while it parses the command.
 * `-V` comes first, so an upstream server refuses the command at once whatever
 * the pane holds: 3.7 and older lack both flags, and 3.8 has an `-R` of its own
 * that dumps the whole grid as text and ignores `-S` (28 MB for 2,000 lines at
 * 120 columns). tmux-ide's build honours `-S 0 -E 0` and answers with the
 * header and one row.
 */
export const NATIVE_BOOTSTRAP_PROBE_FLAGS: readonly string[] = ["-V", "-R", "-S", "0", "-E", "0"];
/** A header and one row; the row has at most one cell per column. */
export const NATIVE_BOOTSTRAP_PROBE_LIMITS = { maxBytes: 1024 * 1024, maxLines: 4 } as const;

export type NativeBootstrapProbeResult = "native" | "unsupported" | "unknown";

/**
 * Read the probe's reply. Only a proven answer is "native" or "unsupported";
 * a failed or malformed reply stays "unknown" so the caller can ask again
 * instead of settling the server's capability on a bad read.
 */
export function readNativeBootstrapProbe(
  ok: boolean,
  lines: readonly string[],
): NativeBootstrapProbeResult {
  if (!ok)
    return lines.some((line) =>
      /^(?:parse error: )?(?:command capture-pane: )?unknown flag -V$/.test(line.trim()),
    )
      ? "unsupported"
      : "unknown";
  if (isStockRawGridCapture(lines)) return "unsupported";
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    return "unknown";
  }
  // Every revision's header names the grid's width; a row record does not.
  if (header === null || typeof header !== "object" || !("cols" in header)) return "unknown";
  // With -V a pane in a mode reports that mode's screen, whose current
  // rendition is null. A build that predates the field omits the key.
  return "version" in header && header.version === 2 && "currentAttributes" in header
    ? "native"
    : "unsupported";
}

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
  /** Logical reflow boundary; allocation may contain erased cells beyond it. */
  readonly used?: number;
  readonly flags: number;
  readonly cells: readonly NativeGridCaptureCell[];
}

export interface NativeGridCapture {
  /** v1 omits allocated erased tails and is not complete painted backing. */
  readonly version?: 1 | 2;
  /** Current rendition from the input parser; absent on backing-only captures. */
  readonly currentAttributes?: readonly [number, number, number, number];
  readonly cols: number;
  readonly rows: number;
  /** History rows in `grid`, which holds `history + rows` rows. */
  readonly history: number;
  /**
   * #873: tmux history rows older than `grid[0]` that this capture left out.
   * tmux's history_size is `history + omittedHistory`. Absent on a capture of
   * the whole history.
   */
  readonly omittedHistory?: number;
  readonly hscrolled: number;
  readonly limit: number;
  readonly cursor: readonly [number, number];
  readonly grid: readonly NativeGridCaptureRow[];
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ROWS = MAX_BYTES / 64;
const MAX_CELLS = 1_000_000;

/**
 * #873: the first open reads the screen and the newest history that fits this
 * many cells; older rows follow in pieces of the same size. A cell is 25 to 45
 * bytes of the native JSON, so a piece stays well under the 16 MiB reply cap.
 */
export const NATIVE_SEED_CELL_BUDGET = 262_144;
export const NATIVE_HISTORY_PIECE_CELL_BUDGET = 262_144;

/** History rows a first-open capture asks for at this pane size; never below zero. */
export function nativeSeedHistoryRows(cols: number, rows: number): number {
  if (!Number.isSafeInteger(cols) || cols < 1 || !Number.isSafeInteger(rows) || rows < 1) return 0;
  return Math.max(0, Math.floor(NATIVE_SEED_CELL_BUDGET / cols) - rows);
}

/** Rows one history piece holds at this width; at least one. */
export function nativeHistoryPieceRows(cols: number): number {
  if (!Number.isSafeInteger(cols) || cols < 1) return 1;
  return Math.max(1, Math.floor(NATIVE_HISTORY_PIECE_CELL_BUDGET / cols));
}

/**
 * #873: older history rows read from tmux after the first open, oldest first.
 * tmux numbers rows from its oldest history row; `firstRow` is that number for
 * `rows[0]`, read at the instant tmux's history held `historySize` rows.
 */
export interface NativeHistoryRequest {
  /** tmux's number for the requester's oldest row; the piece ends just before it. */
  readonly endRow: number;
  /** Rows wanted, the newest at `endRow - 1`. */
  readonly rows: number;
  /** The requester's history_size, to turn row numbers into `-S`/`-E` offsets. */
  readonly historySize: number;
}

export interface NativeHistoryPiece {
  readonly cols: number;
  readonly historySize: number;
  readonly firstRow: number;
  readonly rows: readonly NativeGridCaptureRow[];
}

/** Dense parser import must also fit the cell budget, even for sparse exports. */
export function isNativeBootstrapCapture(snapshot: NativeGridCapture): boolean {
  return (
    uint(snapshot.cols, 16384) &&
    snapshot.cols > 0 &&
    uint(snapshot.rows, MAX_ROWS) &&
    snapshot.rows > 0 &&
    uint(snapshot.history, MAX_ROWS) &&
    snapshot.version === 2 &&
    snapshot.currentAttributes !== undefined &&
    snapshot.cols * (snapshot.history + snapshot.rows) <= MAX_CELLS
  );
}

/** Compact renderer-neutral backing transport, using the same bounded native format. */
export function encodeNativeGridCapture(source: NativeGridCapture): string | null {
  const records = [
    JSON.stringify({
      version: source.version ?? 1,
      ...(source.currentAttributes ? { currentAttributes: source.currentAttributes } : {}),
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
        used: row.used ?? row.cells.length,
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
export function decodeNativeGridCapture(
  text: string,
  options: { readonly tail?: boolean } = {},
): NativeGridCapture | null {
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
      (header.version !== 1 && header.version !== 2) ||
      !uint(header.cols, MAX_CELLS) ||
      header.cols === 0 ||
      !uint(header.rows, MAX_ROWS) ||
      header.rows === 0 ||
      !uint(header.history, options.tail ? 0xffffffff : MAX_ROWS) ||
      (!options.tail && header.history + header.rows > MAX_ROWS) ||
      !uint(header.hscrolled, header.history) ||
      !uint(header.limit) ||
      !Array.isArray(header.cursor) ||
      header.cursor.length !== 2 ||
      // screen_resize_cursor preserves x after a non-reflow (alternate)
      // shrink. Bound the source coordinate independently of current columns.
      !uint(header.cursor[0], MAX_CELLS) ||
      !uint(header.cursor[1], header.rows - 1)
    )
      return null;
    const attrs = header.currentAttributes;
    if (
      attrs != null &&
      (header.version !== 2 ||
        !Array.isArray(attrs) ||
        attrs.length !== 4 ||
        !uint(attrs[0], 0xffff) ||
        !signed(attrs[1]) ||
        !signed(attrs[2]) ||
        !signed(attrs[3]))
    )
      return null;
    const grid: NativeGridCaptureRow[] = [];
    let count = 0;
    // #873: a tail capture (`-S -N`) starts at the oldest row it read. tmux
    // numbers rows from its oldest history row, so the first row's number is
    // how many older rows the capture left out.
    const savedOffset = offset;
    const first = options.tail ? next() : null;
    offset = savedOffset;
    const omitted =
      options.tail && object(first) && uint(first.row, header.history) ? first.row : 0;
    if (header.history - omitted + header.rows > MAX_ROWS) return null;
    for (let index = omitted; index < header.history + header.rows; index++) {
      const row = next();
      if (
        !object(row) ||
        row.row !== index ||
        !uint(row.flags) ||
        !uint(row.used, MAX_CELLS - count) ||
        !Array.isArray(row.cells) ||
        row.cells.length > MAX_CELLS - count ||
        (header.version === 1 ? row.cells.length !== row.used : row.cells.length < row.used)
      )
        return null;
      count += row.cells.length;
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
      grid.push(
        Object.freeze({
          flags: row.flags,
          ...(header.version === 2 ? { used: row.used } : {}),
          cells: Object.freeze(cells),
        }),
      );
    }
    if (offset < text.length) return null;
    return Object.freeze({
      version: header.version,
      ...(Array.isArray(attrs)
        ? {
            currentAttributes: Object.freeze([...attrs]) as readonly [
              number,
              number,
              number,
              number,
            ],
          }
        : {}),
      cols: header.cols,
      rows: header.rows,
      history: header.history - omitted,
      ...(omitted > 0 ? { omittedHistory: omitted } : {}),
      hscrolled: header.hscrolled,
      limit: header.limit,
      cursor: Object.freeze([header.cursor[0], header.cursor[1]]) as readonly [number, number],
      grid: Object.freeze(grid),
    });
  } catch {
    return null;
  }
}

/**
 * #873: decode a `capture-pane -R -S <a> -E <b>` reply that holds history rows
 * only. Rows must be contiguous and older than the screen. A malformed reply,
 * an empty one or one with a screen row is null.
 */
export function decodeNativeHistoryPiece(text: string): NativeHistoryPiece | null {
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  let header: unknown;
  let first: unknown;
  try {
    header = JSON.parse(text.slice(0, newline));
    const second = text.indexOf("\n", newline + 1);
    first = JSON.parse(text.slice(newline + 1, second < 0 ? text.length : second));
  } catch {
    return null;
  }
  if (!object(header) || !object(first) || !uint(first.row) || !uint(header.history)) return null;
  const firstRow = first.row;
  // Rewrite the header as a capture whose history ends at the piece's last row
  // and whose screen is empty, then reuse the full decoder's checks: re-number
  // the rows from zero so its contiguity check applies to the piece.
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const count = lines.length - 1;
  if (firstRow + count > header.history) return null;
  const renumbered: string[] = [];
  for (let index = 0; index < count; index++) {
    const line = lines[index + 1]!;
    const prefix = `{"row":${firstRow + index},`;
    if (!line.startsWith(prefix)) return null;
    renumbered.push(`{"row":${index},` + line.slice(prefix.length));
  }
  const synthetic = {
    ...header,
    history: count - 1,
    rows: 1,
    hscrolled: 0,
    cursor: [0, 0],
  };
  const capture = decodeNativeGridCapture(
    JSON.stringify(synthetic) + "\n" + renumbered.join("\n") + "\n",
  );
  if (!capture || capture.version !== 2) return null;
  return Object.freeze({
    cols: capture.cols,
    historySize: header.history,
    firstRow,
    rows: capture.grid,
  });
}
