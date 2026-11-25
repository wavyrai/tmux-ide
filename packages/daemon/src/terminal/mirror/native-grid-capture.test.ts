import { describe, expect, it } from "vitest";
import {
  decodeNativeGridCapture,
  encodeNativeGridCapture,
  isNativeBootstrapCapture,
  NATIVE_BOOTSTRAP_PROBE_FLAGS,
  NATIVE_BOOTSTRAP_PROBE_LIMITS,
  readNativeBootstrapProbe,
  decodeNativeHistoryPiece,
  nativeHistoryPieceRows,
  nativeSeedHistoryRows,
  NATIVE_HISTORY_PIECE_CELL_BUDGET,
  NATIVE_SEED_CELL_BUDGET,
} from "./native-grid-capture.ts";

function records() {
  return [
    { version: 1, cols: 2, rows: 1, history: 1, hscrolled: 1, limit: 2000, cursor: [1, 0] },
    { row: 0, flags: 3, used: 1, cells: [[8, 2, "e7958c", 0, 8, 8, 8, 0, 8]] },
    {
      row: 1,
      flags: 2,
      used: 2,
      cells: [
        [4, 1, "21", 0, 8, 8, 8, 0, 4],
        [8, 1, "65cc81", 0, 8, 8, 8, 0, 8],
      ],
    },
  ];
}
const encode = (value: unknown[]) => value.map((row) => JSON.stringify(row)).join("\n") + "\n";

describe("decodeNativeGridCapture", () => {
  it("preserves detached padding, native widths and scroll provenance without renderer normalization", () => {
    const result = decodeNativeGridCapture(encode(records()))!;
    expect(result).not.toBeNull();
    expect(result.hscrolled).toBe(1);
    expect(result.grid[0]!.cells).toHaveLength(1);
    expect(result.grid[0]!.cells[0]).toMatchObject({ text: "界", width: 2 });
    expect(result.grid[1]!.cells[0]).toMatchObject({ flags: 4, width: 1, storageFlags: 4 });
    expect(result.grid[1]!.cells[1]!.text).toBe("é");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.grid[1]!.cells[0])).toBe(true);
    expect(decodeNativeGridCapture(encode(records()).trimEnd())).toEqual(result);
  });

  it("preserves a legal offscreen cursor after an alternate-screen non-reflow shrink", () => {
    const value = records();
    value[0] = { ...value[0]!, version: 2, cursor: [34, 0], currentAttributes: [0, 8, 8, 8] };
    const decoded = decodeNativeGridCapture(encode(value))!;
    expect(decoded).not.toBeNull();
    expect(decoded.cols).toBe(2);
    expect(decoded.cursor).toEqual([34, 0]);
    expect(isNativeBootstrapCapture(decoded)).toBe(true);
    expect(decodeNativeGridCapture(encodeNativeGridCapture(decoded)!)).toEqual(decoded);
  });

  it("preserves empty zero-width padding and an end-column cursor", () => {
    const value = records();
    value[0]!.cursor = [2, 0];
    value[2]!.cells![0] = [4, 0, "", 0, 8, 8, 8, 0, 8];
    expect(decodeNativeGridCapture(encode(value))?.grid[1]!.cells[0]).toMatchObject({
      flags: 4,
      width: 0,
      bytesHex: "",
      text: "",
      storageFlags: 8,
    });
  });

  it.each([
    { version: 3 },
    { cols: 0 },
    { rows: 0 },
    { history: -1 },
    { hscrolled: 2 },
    { cursor: [1_000_001, 0] },
    { cursor: [-1, 0] },
    { cursor: [1.5, 0] },
    { cursor: [0, 1] },
    { history: 262144 },
    { limit: 1.5 },
  ])("rejects invalid metadata %j", (change) => {
    const value = records();
    value[0] = { ...value[0]!, ...change };
    expect(decodeNativeGridCapture(encode(value))).toBeNull();
  });

  it.each([
    { row: 2 },
    { used: 3 },
    { used: -1 },
    { used: 1_000_001 },
    { flags: -1 },
    { cells: null },
  ])("rejects incomplete or malformed rows %j", (change) => {
    const value: unknown[] = records();
    value[2] = { ...(value[2] as object), ...change };
    expect(decodeNativeGridCapture(encode(value))).toBeNull();
  });

  it.each([
    [0, -1],
    [1, 256],
    [2, "abc"],
    [2, "zz"],
    [2, "ff"],
    [3, 65536],
    [4, 0x80000000],
    [7, -1],
    [8, 256],
  ])("rejects invalid cell field %s=%s", (field, replacement) => {
    const value = records();
    value[2]!.cells![0]![Number(field)] = replacement;
    expect(decodeNativeGridCapture(encode(value))).toBeNull();
  });

  it("rejects unsupported commands, truncated grids, trailing records and excessive bytes", () => {
    expect(decodeNativeGridCapture("unknown flag -R")).toBeNull();
    expect(decodeNativeGridCapture(encode(records().slice(0, 2)))).toBeNull();
    expect(decodeNativeGridCapture(encode([...records(), {}]))).toBeNull();
    expect(decodeNativeGridCapture(encode(records()) + "\n")).toBeNull();
    expect(decodeNativeGridCapture(" ".repeat(16 * 1024 * 1024 + 1))).toBeNull();
  });
});

describe("native v2 allocated cells", () => {
  const fixture = (used = 1) =>
    encode([
      { version: 2, cols: 4, rows: 1, history: 0, hscrolled: 0, limit: 2000, cursor: [1, 0] },
      {
        row: 0,
        flags: 0,
        used,
        cells: [
          [0, 1, "61", 0, 8, 16777233, 8, 0, 2],
          ...Array.from({ length: 3 }, () => [64, 1, "20", 0, 8, 16777233, 8, 0, 66]),
        ],
      },
    ]);
  it("round trips allocated colored erased tails independently of written cells", () => {
    const source = decodeNativeGridCapture(fixture())!;
    expect(source.version).toBe(2);
    expect(source.grid[0]!.used).toBe(1);
    expect(source.grid[0]!.cells).toHaveLength(4);
    expect(source.grid[0]!.cells[3]!.background).toBe(16777233);
    expect(decodeNativeGridCapture(encodeNativeGridCapture(source)!)).toEqual(source);
    expect(decodeNativeGridCapture(fixture(0))!.grid[0]!.used).toBe(0);
  });
  it("rejects corrupt logical boundaries and preserves the v1 capability marker", () => {
    for (const used of [-1, 1.5, 5]) expect(decodeNativeGridCapture(fixture(used))).toBeNull();
    expect(decodeNativeGridCapture(encode(records()))!.version).toBe(1);
  });
});

it("validates current rendition independently of backing-only v2 capability", () => {
  const value = records();
  value[0]!.version = 2;
  for (const currentAttributes of [[0, 8, 8, 8], null]) {
    const source = decodeNativeGridCapture(
      encode([{ ...value[0], currentAttributes }, ...value.slice(1)]),
    )!;
    expect(source).not.toBeNull();
    expect(source.currentAttributes).toEqual(currentAttributes ?? undefined);
    expect(decodeNativeGridCapture(encodeNativeGridCapture(source)!)).toEqual(source);
  }
  for (const currentAttributes of [
    [0, 8],
    [-1, 8, 8, 8],
    [0, 8, "bad", 8],
    [0, 8, 8, 0x100000000],
  ]) {
    expect(
      decodeNativeGridCapture(encode([{ ...value[0], currentAttributes }, ...value.slice(1)])),
    ).toBeNull();
  }
});

it("bounds sparse native bootstrap width and dense parser allocation", () => {
  const base = decodeNativeGridCapture(encode(records()))!;
  const source = { ...base, version: 2 as const, currentAttributes: [0, 8, 8, 8] as const };
  expect(isNativeBootstrapCapture(source)).toBe(true);
  expect(isNativeBootstrapCapture({ ...source, cols: 16385 })).toBe(false);
  expect(isNativeBootstrapCapture({ ...source, cols: 16384, history: 100 })).toBe(false);
});

describe("native bootstrap probe (#869)", () => {
  const header = {
    version: 2,
    cols: 120,
    rows: 40,
    history: 1962,
    hscrolled: 1962,
    limit: 2000,
    cursor: [8, 39],
    currentAttributes: [0, 8, 8, 8],
  };
  const row = JSON.stringify({
    row: 1962,
    flags: 0,
    used: 1,
    cells: [[0, 1, "32", 0, 8, 8, 8, 0, 0]],
  });
  const reply = (value: object) => [JSON.stringify(value), row];

  it("asks for one row behind a flag only tmux-ide's tmux has", () => {
    // -V first: an upstream tmux refuses the command before it reads -R. -S 0
    // -E 0 bounds the answer of tmux-ide's tmux to the header and one row.
    expect(NATIVE_BOOTSTRAP_PROBE_FLAGS).toEqual(["-V", "-R", "-S", "0", "-E", "0"]);
    expect(NATIVE_BOOTSTRAP_PROBE_LIMITS.maxLines).toBeLessThanOrEqual(4);
    expect(NATIVE_BOOTSTRAP_PROBE_LIMITS.maxBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it.each([
    ["tmux 3.8 and older, from the command line", "command capture-pane: unknown flag -V"],
    ["tmux 3.8 and older, in control mode", "parse error: command capture-pane: unknown flag -V"],
  ])("reads %s as unsupported", (_name, line) => {
    expect(readNativeBootstrapProbe(false, [line])).toBe("unsupported");
  });

  it("reads upstream's text grid as unsupported", () => {
    expect(
      readNativeBootstrapProbe(true, ["G 120x40 (1962/2000)", "\tL 0 (-) flags=NONE[0] 4/30"]),
    ).toBe("unsupported");
  });

  it("reads a version 2 header as native, also for a mode's screen", () => {
    expect(readNativeBootstrapProbe(true, reply(header))).toBe("native");
    expect(readNativeBootstrapProbe(true, reply({ ...header, currentAttributes: null }))).toBe(
      "native",
    );
  });

  it("reads an older native format as unsupported", () => {
    const without = (key: string) =>
      Object.fromEntries(Object.entries(header).filter(([name]) => name !== key));
    expect(readNativeBootstrapProbe(true, reply(without("currentAttributes")))).toBe("unsupported");
    expect(readNativeBootstrapProbe(true, reply({ ...header, version: 1 }))).toBe("unsupported");
    expect(readNativeBootstrapProbe(true, reply(without("version")))).toBe("unsupported");
  });

  it.each([
    ["another failure", false, ["can't find pane: %9"]],
    ["a failure that only mentions the flag", false, ["no such thing as unknown flag -V here"]],
    ["a refused -R, which this probe never reaches", false, ["unknown flag -R"]],
    ["an empty reply", true, []],
    ["text", true, ["truncated native JSON"]],
    ["a JSON value that is not a header", true, ["[1,2]"]],
    ["a JSON null", true, ["null"]],
    ["a JSON number", true, ["7"]],
    ["a JSON string", true, ['"cols"']],
    [
      "an object without a grid width",
      true,
      [JSON.stringify({ version: 2, currentAttributes: [] })],
    ],
    ["a row without its header", true, [row]],
  ])("leaves %s unknown", (_name, ok, lines) => {
    expect(readNativeBootstrapProbe(ok, lines)).toBe("unknown");
  });
});

describe("bounded first open and history pieces (#873)", () => {
  const cell = (char: string) => [0, 1, Buffer.from(char).toString("hex"), 0, 8, 8, 8, 0, 0];
  const header = (history: number, rows = 1) => ({
    version: 2,
    currentAttributes: [0, 8, 8, 8],
    cols: 4,
    rows,
    history,
    hscrolled: 0,
    limit: 2000,
    cursor: [0, 0],
  });
  const row = (index: number, text: string, flags = 0) => ({
    row: index,
    flags,
    used: text.length,
    cells: [...text].map(cell),
  });

  it("sizes a seed and a piece by cells, never below zero rows or one row", () => {
    expect(NATIVE_SEED_CELL_BUDGET).toBe(262_144);
    expect(NATIVE_HISTORY_PIECE_CELL_BUDGET).toBe(262_144);
    expect(nativeSeedHistoryRows(120, 40)).toBe(2_144);
    expect(nativeSeedHistoryRows(200, 40)).toBe(1_270);
    expect(nativeSeedHistoryRows(262_144, 40)).toBe(0);
    expect(nativeSeedHistoryRows(0, 40)).toBe(0);
    expect(nativeSeedHistoryRows(120, 0)).toBe(0);
    expect(nativeHistoryPieceRows(120)).toBe(2_184);
    expect(nativeHistoryPieceRows(200)).toBe(1_310);
    expect(nativeHistoryPieceRows(1_000_000)).toBe(1);
    expect(nativeHistoryPieceRows(0)).toBe(1);
  });

  it("decodes a tail capture only when asked, and counts the rows it left out", () => {
    // tmux holds 5 history rows; the capture starts at its row 3.
    const tail = encode([header(5), row(3, "d"), row(4, "e"), row(5, "s")]);
    expect(decodeNativeGridCapture(tail)).toBeNull();
    const decoded = decodeNativeGridCapture(tail, { tail: true })!;
    expect(decoded.history).toBe(2);
    expect(decoded.omittedHistory).toBe(2 + 1);
    expect(decoded.grid.map((r) => r.cells.map((c) => c.text).join(""))).toEqual(["d", "e", "s"]);
    expect(isNativeBootstrapCapture(decoded)).toBe(true);
    // A whole capture read as a tail leaves nothing out.
    const whole = decodeNativeGridCapture(encode([header(1), row(0, "a"), row(1, "s")]), {
      tail: true,
    })!;
    expect(whole.history).toBe(1);
    expect("omittedHistory" in whole).toBe(false);
    // Rows must still be contiguous and end at the screen's last row.
    for (const broken of [
      [header(5), row(3, "d"), row(5, "s")],
      [header(5), row(3, "d"), row(4, "e")],
      [header(5), row(6, "x")],
    ])
      expect(decodeNativeGridCapture(encode(broken), { tail: true })).toBeNull();
  });

  it("decodes a tail of a history longer than one whole capture may hold", () => {
    const decoded = decodeNativeGridCapture(
      encode([header(400_000), row(399_999, "h"), row(400_000, "s")]),
      { tail: true },
    )!;
    expect(decoded).toMatchObject({ history: 1, omittedHistory: 399_999 });
    expect(
      decodeNativeGridCapture(encode([header(400_000), row(0, "h")]), { tail: true }),
    ).toBeNull();
  });

  it("decodes a piece of history rows with tmux's numbers and wrap flags", () => {
    const piece = decodeNativeHistoryPiece(
      encode([header(9, 3), row(2, "ab", 1), row(3, "c"), row(4, "")]),
    )!;
    expect(piece.cols).toBe(4);
    expect(piece.historySize).toBe(9);
    expect(piece.firstRow).toBe(2);
    expect(piece.rows.map((r) => [r.flags, r.cells.map((c) => c.text).join("")])).toEqual([
      [1, "ab"],
      [0, "c"],
      [0, ""],
    ]);
  });

  it("takes a piece that ends at tmux's newest history row", () => {
    const piece = decodeNativeHistoryPiece(encode([header(9, 3), row(7, "g"), row(8, "h")]))!;
    expect(piece.firstRow).toBe(7);
    expect(piece.rows).toHaveLength(2);
  });

  it("refuses a piece that is empty, holds a screen row, skips a row or is malformed", () => {
    for (const broken of [
      [header(9)],
      [header(9), row(8, "a"), row(9, "s")],
      [header(9), row(9, "s")],
      [header(9), row(2, "a"), row(4, "b")],
      [header(9), row(3, "a"), row(2, "b")],
      [{ ...header(9), version: 1, currentAttributes: undefined }, row(2, "a")],
      [{ ...header(9), history: undefined }, row(2, "a")],
      [header(9), { ...row(2, "a"), used: 5 }],
      [header(9), { ...row(2, "a"), cells: [[0, 1, "zz", 0, 8, 8, 8, 0, 0]] }],
    ])
      expect(decodeNativeHistoryPiece(encode(broken))).toBeNull();
    expect(decodeNativeHistoryPiece("not json\n")).toBeNull();
    expect(decodeNativeHistoryPiece("")).toBeNull();
  });
});
