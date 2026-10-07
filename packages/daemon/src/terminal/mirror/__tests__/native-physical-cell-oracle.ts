/** TM04 test oracle. Intentionally imports no runtime decoder, projector or
 * schema: both tmux records and delivered cells face literal fixture truth.
 * Native constants are from pinned tmux.h GRID_ATTR_* / COLOUR_FLAG_*; only
 * the small authored fixture vocabulary is accepted. This is not a renderer. */
export type OracleCell = {
  text: string;
  width: number;
  foreground: string;
  background: string;
  attributes: string[];
};
export type OracleFrame = {
  cols: number;
  rows: number;
  history: number;
  cursor: number[];
  wrapped: boolean[];
  cells: OracleCell[][];
};
const names = ["bold", "dim", "italic", "underline", "blink", "inverse", "hidden", "strike"];
const nativeBits = [1, 2, 64, 4, 8, 16, 32, 256];
const blank = (): OracleCell => ({
  text: "",
  width: 1,
  foreground: "default",
  background: "default",
  attributes: [],
});
function integer(value: unknown, name: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`oracle invalid ${name}`);
}
function nativeColor(value: number): string {
  integer(value, "color", 0, 0x02ffffff);
  if (value === 8) return "default";
  if (value >= 0 && value <= 7) return `indexed:${value}`;
  if (value >= 90 && value <= 97) return `indexed:${value - 82}`;
  if (value >= 0x01000000 && value <= 0x010000ff) return `indexed:${value - 0x01000000}`;
  if (value >= 0x02000000 && value <= 0x02ffffff)
    return `rgb:${(value - 0x02000000).toString(16).padStart(6, "0")}`;
  throw new Error(`oracle unsupported native color ${value}`);
}
export function readPhysicalFrame(
  raw: string,
  geometry: "tm04" | "styled-reconnect" | "styled-reconnect-narrow" = "tm04",
): OracleFrame {
  const cols = geometry === "tm04" ? 8 : geometry === "styled-reconnect-narrow" ? 24 : 40;
  const rows = geometry === "tm04" ? 4 : 8;
  if (
    geometry !== "tm04" &&
    geometry !== "styled-reconnect" &&
    geometry !== "styled-reconnect-narrow"
  )
    throw new Error("oracle unknown fixture");
  if (Buffer.byteLength(raw) > 32768) throw new Error("oracle fixture exceeds bound");
  const [header, ...records] = raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    header.version !== 2 ||
    header.cols !== cols ||
    header.rows !== rows ||
    (geometry === "tm04" && header.history !== 0) ||
    records.length !== rows
  )
    throw new Error("oracle unexpected physical geometry/version/history");
  integer(header.history, "history", 0, geometry === "tm04" ? 0 : 10000);
  if (!Array.isArray(header.cursor) || header.cursor.length !== 2)
    throw new Error("oracle invalid cursor");
  integer(header.cursor[0], "cursor x", 0, cols);
  integer(header.cursor[1], "cursor y", 0, rows - 1);
  integer(header.hscrolled, "hscrolled", 0, 0);
  integer(header.limit, "limit", 0, 10000);
  if (JSON.stringify(header.currentAttributes) !== "[0,8,8,8]")
    throw new Error("oracle unexpected fixture rendition");
  const cells = records.map((row, y): OracleCell[] => {
    if (row.row !== y + header.history || !Array.isArray(row.cells) || row.cells.length > cols)
      throw new Error("oracle malformed row");
    integer(row.flags, "row flags", 0, 3);
    integer(row.used, "row used", 0, row.cells.length);
    const result = Array.from({ length: cols }, blank);
    // Native v2 omits unallocated default suffix cells. Allocation length is
    // not logical content: reject used beyond allocation, then supply only
    // default suffix cells. Literal colored-tail expectations still catch loss.
    for (let x = 0; x < row.cells.length; x++) {
      const cell = row.cells[x];
      if (!Array.isArray(cell) || cell.length !== 9) throw new Error("oracle invalid cell record");
      const [flags, width, hex, attrs, fg, bg] = cell;
      integer(flags, "cell flags", 0, 255);
      integer(width, "cell width", 1, flags & 128 ? 6 : 2);
      integer(attrs, "cell attributes", 0, 0x17f);
      integer(cell[6], "underline color", 8, 8);
      integer(cell[7], "link", 0, 0);
      integer(cell[8], "storage flags", 0, 255);
      if (
        !Array.isArray(cell) ||
        cell.length !== 9 ||
        typeof hex !== "string" ||
        !/^(?:[0-9a-f]{2})+$/u.test(hex) ||
        (attrs & ~0x17f) !== 0
      )
        throw new Error("oracle unsupported cell");
      const style = {
        foreground: nativeColor(fg),
        background: nativeColor(bg),
        attributes: names.filter((_, index) => (attrs & nativeBits[index]!) !== 0),
      };
      if (flags & 128) {
        // Pinned grid_set_tab stores width spaces, not byte09. HT preserves
        // the pre-existing blank rendition, independently of current SGR.
        if (
          geometry !== "tm04" ||
          x !== 1 ||
          width !== 6 ||
          hex !== "20".repeat(6) ||
          (flags & ~(128 | 64)) !== 0
        )
          throw new Error("oracle unsupported tab span");
        for (let offset = 1; offset < 6; offset++)
          if (JSON.stringify(row.cells[x + offset]) !== '[4,1,"21",0,8,8,8,0,4]')
            throw new Error("oracle invalid tab continuation");
        for (let offset = 0; offset < 6; offset++)
          result[x + offset] = { ...style, text: "", width: 1 };
        x += 5;
      } else if (flags & 4) {
        // A normal wide continuation is logically owned by the preceding cell.
        if (x === 0 || result[x - 1]!.width !== 2)
          throw new Error("oracle fixture has detached padding");
        result[x] = { ...result[x - 1]!, text: "", width: 0 };
      } else {
        if (width === 2 && (x === cols - 1 || !(row.cells[x + 1]?.[0] & 4)))
          throw new Error("oracle wide owner lacks padding");
        result[x] = {
          ...style,
          text:
            flags & 64
              ? ""
              : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(hex, "hex")),
          width,
        };
      }
    }
    return result;
  });
  return {
    cols,
    rows,
    history: header.history,
    cursor: header.cursor,
    // tmux marks the row that wraps onward; logical canonical rows mark
    // continuation from the previous row. Literal wrap fixtures check both.
    wrapped: records.map((_, index) => index > 0 && (records[index - 1].flags & 1) !== 0),
    cells,
  };
}
export function knownFrame(stage: "initial" | "edited"): OracleFrame {
  const cells = Array.from({ length: 4 }, () => Array.from({ length: 8 }, blank));
  const styled = (text: string, width = 1): OracleCell => ({
    text,
    width,
    foreground: "indexed:1",
    background: "indexed:17",
    attributes: ["bold", "italic", "underline"],
  });
  cells[0] = [
    styled("A"),
    styled("界", 2),
    styled("", 0),
    styled("é"),
    { ...blank(), text: " " },
    { ...blank(), text: "R", foreground: "rgb:010203", background: "rgb:040506" },
    blank(),
    blank(),
  ];
  for (const [x, text] of [...(stage === "initial" ? "ABCDEF" : "AB CDEF")].entries())
    cells[1]![x] = { ...blank(), text: text === " " ? "" : text };
  cells[2] = Array.from({ length: 8 }, (_, x) => ({
    ...blank(),
    text: x === 0 ? "Z" : "",
    background: "indexed:17",
  }));
  for (const [x, text] of [...(stage === "initial" ? "READY" : "DONE")].entries())
    cells[3]![x] = { ...blank(), text };
  return {
    cols: 8,
    rows: 4,
    history: 0,
    cursor: stage === "initial" ? [2, 1] : [3, 1],
    wrapped: [false, false, false, false],
    cells,
  };
}
export function readDeliveredFrame(snapshot: {
  cols: number;
  rows: number;
  history: readonly unknown[];
  cursor: { x: number; y: number };
  grid: readonly {
    wrapped: boolean;
    cells: readonly {
      grapheme: string;
      width: number;
      attributes: number;
      foreground: { kind: string; index?: number; value?: number };
      background: { kind: string; index?: number; value?: number };
    }[];
  }[];
}): OracleFrame {
  const color = (value: { kind: string; index?: number; value?: number }) =>
    value.kind === "default"
      ? "default"
      : value.kind === "indexed"
        ? `indexed:${value.index}`
        : value.kind === "rgb"
          ? `rgb:${value.value!.toString(16).padStart(6, "0")}`
          : "unsupported";
  return {
    cols: snapshot.cols,
    rows: snapshot.rows,
    history: snapshot.history.length,
    cursor: [snapshot.cursor.x, snapshot.cursor.y],
    wrapped: snapshot.grid.map((row) => row.wrapped),
    cells: snapshot.grid.map((row) =>
      row.cells.map((cell) => {
        integer(cell.attributes, "delivered attributes", 0, 255);
        return {
          text: cell.grapheme,
          width: cell.width,
          foreground: color(cell.foreground),
          background: color(cell.background),
          attributes: names.filter((_, index) => (cell.attributes & (2 ** index)) !== 0),
        };
      }),
    ),
  };
}
export function comparePhysicalFrame(actual: OracleFrame, expected: OracleFrame): void {
  for (const field of ["cols", "rows", "history", "cursor", "wrapped"] as const)
    if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field]))
      throw new Error(`oracle ${field} mismatch`);
  for (let y = 0; y < expected.rows; y++)
    for (let x = 0; x < expected.cols; x++) {
      for (const field of ["text", "width", "foreground", "background", "attributes"] as const)
        if (
          JSON.stringify(actual.cells[y]?.[x]?.[field]) !==
          JSON.stringify(expected.cells[y]![x]![field])
        )
          throw new Error(
            `oracle cell[${y},${x}].${field} mismatch: ${JSON.stringify(actual.cells[y]?.[x]?.[field])} != ${JSON.stringify(expected.cells[y]![x]![field])}`,
          );
    }
}
export const INITIAL_BYTES =
  "\x1b[0m\x1b[2J\x1b[H\x1b[1;3;4;31;48;5;17mA界é\x1b[0m \x1b[38;2;1;2;3;48;2;4;5;6mR\x1b[0m\x1b[K\x1b[2;1HABCDEF\x1b[3;1H\x1b[48;5;17m\x1b[2KZ\x1b[0m\x1b[4;1HREADY\x1b[2;3H\x1b]2;tm04-initial\x07";
export const EDIT_BYTES =
  "\x1b[2;3H\x1b[2@\x1b[2;4H\x1b[P\x1b[4;1HDONE\x1b[K\x1b[2;4H\x1b]2;tm04-edited\x07";

/** Default tab stops only: col1 tabs to col7 in this eight-column screen. */
export function knownTabFrame(stage: "initial" | "edited"): OracleFrame {
  const cells = Array.from({ length: 4 }, () => Array.from({ length: 8 }, blank));
  cells[0] = Array.from({ length: 8 }, (_, x) => ({
    text: x === 0 ? "A" : x === 7 ? "B" : "",
    width: 1,
    foreground: x === 0 || x === 7 ? "indexed:2" : "default",
    background: "indexed:17",
    attributes: x === 0 || x === 7 ? ["bold"] : [],
  }));
  if (stage === "edited") cells[1]![0] = { ...blank(), text: "C" };
  return {
    cols: 8,
    rows: 4,
    history: 0,
    cursor: stage === "initial" ? [8, 0] : [1, 1],
    wrapped: [false, stage === "edited", false, false],
    cells,
  };
}
export const TAB_INITIAL_BYTES =
  "\x1b[0m\x1b[2J\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[4;1H\x1b[2K\x1b[H\x1b[48;5;17m\x1b[2K\x1b[1;32mA\tB\x1b[0m\x1b]2;tm04-initial\x07";
export const TAB_EDIT_BYTES = "C\x1b]2;tm04-edited\x07";
