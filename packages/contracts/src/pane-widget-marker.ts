/**
 * The widget marker: how a command opts its pane into rich rendering.
 *
 * PURE — every function here is a total function over strings and cell rows.
 * The grammar, the digest and the reassembly rules are all testable without a
 * terminal, a DOM or a daemon, which is the point: detection is the one part of
 * this feature that must never be able to fire by accident.
 *
 * See WIDGET_MARKER.md for the grammar as a specification.
 */

/**
 * The sentinel token. Version is part of the token rather than a separate
 * field, so a future grammar cannot be half-parsed by today's detector — a v2
 * line simply does not match v1 and is left as ordinary terminal output.
 */
export const WIDGET_MARKER_SENTINEL = "TMUXIDE-WIDGET/1";

/**
 * SGR 8 (conceal) and SGR 0 (reset), wrapped around the marker so a plain
 * terminal with no tmux-ide attached prints a blank line rather than a line of
 * machine noise. Detection never reads attributes — only cell characters — so a
 * terminal that ignores conceal changes nothing except what the user sees.
 */
export const WIDGET_MARKER_CONCEAL_PREFIX = "\u001b[8m";
export const WIDGET_MARKER_CONCEAL_SUFFIX = "\u001b[0m";

/**
 * Ceiling on the encoded payload field, in characters.
 *
 * The binding constraint is the mirror SEED, not the emulator's scrollback. A
 * pane is reseeded with `capture-pane -p -e -J -S -2000` (DEFAULT_HISTORY_LINES
 * in terminal/mirror/session-channel.ts), so a marker that has scrolled past
 * 2,000 grid rows comes back beheaded after any reseed — a flow thaw, a
 * reconnect, a re-lease. xterm's own 10,000-line scrollback never binds; it is
 * four times larger.
 *
 * 98,304 characters wrap to 1,229 rows at a reference 80 columns, leaving 771
 * rows (39%) of margin inside the seed window. The image widget's source cap is
 * derived FROM this through two encoding steps, which is the easy thing to get
 * wrong — see PANE_WIDGET_IMAGE_MAX_BYTES and the derivation table in
 * apps/desktop-renderer/src/terminal/widgets/WIDGETS.md.
 *
 * A marker that IS truncated fails closed: all five grammar conditions are
 * checked against the whole line, so the pane stays an ordinary terminal rather
 * than rendering half a widget.
 */
export const WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS = 96 * 1024;

/** Widget ids are lowercase, hyphenated, and short enough to read in a log. */
const WIDGET_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DIGEST_PATTERN = /^[0-9a-f]{8}$/u;

/** The payload field when a widget takes no arguments. Never a valid base64url. */
const EMPTY_PAYLOAD = "-";

/** One terminal cell row, as read through a cell API rather than as a string. */
export interface WidgetCellRow {
  /**
   * One entry per grid column. An entry holds the WHOLE cell — which may be
   * several code units for an emoji, a combining mark or a variation selector —
   * and is empty for the trailing half of a wide glyph. Joining cells is the
   * only correct way to recover the row's text; indexing a joined string by
   * column is the rule-10 mistake this shape exists to prevent.
   */
  readonly cells: readonly string[];
  /** True when this row continues the previous one rather than starting a new line. */
  readonly wrapped: boolean;
}

export interface WidgetMarker {
  readonly id: string;
  /** The decoded JSON arguments, or `null` when the marker carried none. */
  readonly args: unknown;
  /** Index into the LOGICAL lines (not the cell rows) the marker was found on. */
  readonly lineIndex: number;
}

/**
 * FNV-1a, 32-bit, as eight lowercase hex digits.
 *
 * This is an accident detector, not a signature: it costs a few lines, no
 * dependency and no async, and it is what makes a marker quoted inside ordinary
 * output inert unless it was quoted whole and unmodified.
 */
export function widgetMarkerDigest(id: string, payload: string): string {
  const subject = `${WIDGET_MARKER_SENTINEL}:${id}:${payload}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < subject.length; index += 1) {
    hash ^= subject.charCodeAt(index) & 0xff;
    // The 32-bit FNV prime, as shifts: `hash * 16777619` overflows a double's
    // exact-integer range and would silently start rounding.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Chunked so a large payload cannot blow the argument limit of `fromCharCode`. */
function bytesToBinaryString(bytes: Uint8Array): string {
  const CHUNK = 0x2000;
  let out = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return out;
}

export function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return btoa(bytesToBinaryString(bytes))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

export function decodeBase64Url(value: string): string | null {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export class WidgetMarkerTooLargeError extends Error {
  readonly payloadCharacters: number;

  constructor(payloadCharacters: number) {
    super(
      `The widget payload encodes to ${payloadCharacters} characters, over the ` +
        `${WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS}-character marker limit.`,
    );
    this.name = "WidgetMarkerTooLargeError";
    this.payloadCharacters = payloadCharacters;
  }
}

/**
 * Build the marker line for `id`, WITHOUT the conceal wrapper or a newline.
 *
 * Arguments are JSON, then UTF-8, then base64url: the encoded field can hold no
 * whitespace, no quotes and nothing a shell would reinterpret, so the line
 * survives being echoed, piped and replayed through tmux with its field
 * structure intact.
 */
export function encodeWidgetMarkerLine(id: string, args?: unknown): string {
  if (!WIDGET_ID_PATTERN.test(id)) {
    throw new Error(`"${id}" is not a valid widget id.`);
  }
  const payload = args === undefined ? EMPTY_PAYLOAD : encodeBase64Url(JSON.stringify(args));
  if (payload.length > WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS) {
    throw new WidgetMarkerTooLargeError(payload.length);
  }
  return `${WIDGET_MARKER_SENTINEL} ${id} ${payload} ${widgetMarkerDigest(id, payload)}`;
}

/** The complete byte sequence a helper prints to opt a pane into a widget. */
export function widgetMarkerAnnouncement(id: string, args?: unknown): string {
  return `${WIDGET_MARKER_CONCEAL_PREFIX}${encodeWidgetMarkerLine(id, args)}${WIDGET_MARKER_CONCEAL_SUFFIX}\n`;
}

/**
 * Parse one logical line. Returns null for anything that is not a complete,
 * self-consistent marker — which is every line of ordinary program output.
 *
 * The five conditions a line must satisfy, in the order they are cheapest to
 * reject on: the sentinel token, exactly four fields, a well-formed id, a
 * decodable base64url payload holding valid JSON, and a digest that matches.
 */
export function decodeWidgetMarkerLine(line: string): { id: string; args: unknown } | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(WIDGET_MARKER_SENTINEL)) return null;
  const fields = trimmed.split(" ").filter((field) => field.length > 0);
  if (fields.length !== 4) return null;
  const [sentinel, id, payload, digest] = fields as [string, string, string, string];
  if (sentinel !== WIDGET_MARKER_SENTINEL) return null;
  if (!WIDGET_ID_PATTERN.test(id)) return null;
  if (!DIGEST_PATTERN.test(digest)) return null;
  if (payload.length > WIDGET_MARKER_MAX_PAYLOAD_CHARACTERS) return null;
  if (payload !== EMPTY_PAYLOAD && !BASE64URL_PATTERN.test(payload)) return null;
  if (widgetMarkerDigest(id, payload) !== digest) return null;
  if (payload === EMPTY_PAYLOAD) return { id, args: null };
  const json = decodeBase64Url(payload);
  if (json === null) return null;
  try {
    return { id, args: JSON.parse(json) as unknown };
  } catch {
    return null;
  }
}

/**
 * Rebuild the pane's LOGICAL lines from its cell rows.
 *
 * A row that the emulator marked wrapped is the continuation of the row above
 * it, so it is appended rather than started; that is what lets a marker longer
 * than the grid is wide survive being displayed at all. Trailing blank cells
 * are dropped per row, because the grid pads every row out to `cols` and those
 * pad cells are not content.
 */
export function widgetLogicalLines(rows: readonly WidgetCellRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    let end = row.cells.length;
    while (end > 0 && isBlankCell(row.cells[end - 1])) end -= 1;
    let text = "";
    for (let index = 0; index < end; index += 1) text += row.cells[index] ?? "";
    if (row.wrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines;
}

function isBlankCell(cell: string | undefined): boolean {
  return cell === undefined || cell === "" || cell === " ";
}

/**
 * Find the marker a pane is currently rendering, if any.
 *
 * The LAST valid marker wins: a pane that renders one widget and then another
 * shows the newest, and a marker still sitting in scrollback above a newer one
 * cannot outrank it.
 */
export function detectWidgetMarker(rows: readonly WidgetCellRow[]): WidgetMarker | null {
  const lines = widgetLogicalLines(rows);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const decoded = decodeWidgetMarkerLine(lines[index]!);
    if (decoded) return { id: decoded.id, args: decoded.args, lineIndex: index };
  }
  return null;
}

/**
 * Recover a marker directly from canonical terminal-replica rows.
 *
 * The structural input deliberately accepts the retained replica rows without
 * projecting or copying their cell grids. Only the logical line strings needed
 * by the marker grammar are allocated. This keeps rich-preview discovery off
 * the terminal paint path and preserves canonical snapshot identity.
 */
export function detectWidgetMarkerFromReplicaRows(
  rows: Iterable<{
    readonly cells: readonly { readonly grapheme: string }[];
    readonly wrapped: boolean;
  }>,
): WidgetMarker | null {
  const lines: string[] = [];
  for (const row of rows) {
    let end = row.cells.length;
    while (end > 0 && isBlankCell(row.cells[end - 1]?.grapheme)) end -= 1;
    let text = "";
    for (let index = 0; index < end; index += 1) text += row.cells[index]?.grapheme ?? "";
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const decoded = decodeWidgetMarkerLine(lines[index]!);
    if (decoded) return { id: decoded.id, args: decoded.args, lineIndex: index };
  }
  return null;
}

/**
 * A cheap gate on the raw byte stream, so the expensive cell-row scan only runs
 * when a marker could plausibly have arrived.
 *
 * The emulator is the only thing that knows where cells are, so detection has
 * to happen after a write commits — but scanning the whole buffer on every
 * write would cost the pane its frame budget. This watches the bytes for the
 * sentinel's ASCII token instead, carrying the tail across chunk boundaries so
 * a marker split by the transport still trips it.
 */
export function createWidgetMarkerByteWatcher(): {
  observe(bytes: Uint8Array): boolean;
  reset(): void;
} {
  const token = WIDGET_MARKER_SENTINEL;
  let carry = "";
  return {
    observe(bytes: Uint8Array): boolean {
      // Latin-1 rather than UTF-8: the token is pure ASCII, and decoding
      // byte-per-character means a multi-byte sequence straddling a chunk edge
      // cannot throw or swallow the bytes after it.
      const text = carry + bytesToBinaryString(bytes);
      const found = text.includes(token);
      carry = text.slice(Math.max(0, text.length - (token.length - 1)));
      return found;
    },
    reset(): void {
      carry = "";
    },
  };
}
