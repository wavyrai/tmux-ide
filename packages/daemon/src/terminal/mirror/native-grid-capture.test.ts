import { describe, expect, it } from "vitest";
import {
  decodeNativeGridCapture,
  encodeNativeGridCapture,
  isNativeBootstrapCapture,
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
