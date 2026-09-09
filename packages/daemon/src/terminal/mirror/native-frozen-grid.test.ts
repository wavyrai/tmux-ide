import { describe, expect, it } from "vitest";
import { decodeNativeGridCapture } from "./native-grid-capture.ts";
import { resizeNativeFrozenHeight, resizeNativeFrozenGrid } from "./native-frozen-grid.ts";

const backing = (hscrolled: number) =>
  decodeNativeGridCapture(
    [
      JSON.stringify({
        version: 1,
        cols: 12,
        rows: 8,
        history: 2,
        hscrolled,
        limit: 2000,
        cursor: [5, 1],
      }),
      ...Array.from({ length: 10 }, (_, row) =>
        JSON.stringify({ row, flags: 0, used: 1, cells: [[0, 1, "41", 0, 8, 8, 8, 0, 0]] }),
      ),
    ].join("\n"),
  )!;

describe("native frozen backing height", () => {
  it("returns no replacement when a narrow resize would exceed the row budget", () => {
    const base = backing(0);
    const source = {
      ...base,
      cols: 262145,
      rows: 1,
      history: 0,
      hscrolled: 0,
      cursor: [0, 0] as const,
      grid: [{ flags: 0, cells: Array(262145).fill(base.grid[0]!.cells[0]!) }],
    };
    expect(resizeNativeFrozenGrid(source, 1, 1)).toBeNull();
    expect(source.grid[0]!.cells).toHaveLength(262145);
  });
  it("preserves RGB, indexed background and attributes when combined resizing splits styled rows", () => {
    const base = backing(0);
    const styled = {
      ...base,
      grid: [
        {
          flags: 2,
          cells: ["A", "B", "C", "D"].map((text) => ({
            ...base.grid[0]!.cells[0]!,
            text,
            bytesHex: Buffer.from(text).toString("hex"),
            foreground: 0x02010203,
            background: 0x01000011,
            attributes: 1,
            storageFlags: 8,
          })),
        },
        ...base.grid.slice(1),
      ],
    };
    const result = resizeNativeFrozenGrid(styled, 2, 5)!;
    expect(result.cursor).toEqual([0, 0]);
    expect(
      result.grid.slice(0, 2).map((row) => row.cells.map((cell) => cell.text).join("")),
    ).toEqual(["AB", "CD"]);
    for (const row of result.grid.slice(0, 2)) {
      expect(row.flags & 2).toBe(2);
      for (const cell of row.cells)
        expect(cell).toMatchObject({
          foreground: 0x02010203,
          background: 0x01000011,
          attributes: 1,
          storageFlags: 8,
        });
    }
    expect(styled.grid[0]!.cells).toHaveLength(4);
    expect(resizeNativeFrozenGrid(styled, 12, 8)).toBe(styled);
    expect(resizeNativeFrozenGrid(styled, 0, 8)).toBeNull();
  });
  it("distinguishes cleared history from scrolled history despite identical visible rows", () => {
    const cleared = backing(0);
    const scrolled = backing(2);
    expect(cleared.grid).toEqual(scrolled.grid);
    const a = resizeNativeFrozenHeight(cleared, 12)!;
    const b = resizeNativeFrozenHeight(scrolled, 12)!;
    expect(a).toMatchObject({ history: 2, hscrolled: 0, cursor: [5, 1] });
    expect(b).toMatchObject({ history: 0, hscrolled: 0, cursor: [5, 3] });
    expect(a.grid).toHaveLength(14);
    expect(b.grid).toHaveLength(12);
    expect(a.grid.slice(0, 10)).toEqual(cleared.grid);
    expect(a.grid.slice(10).every((row) => row.cells.length === 0)).toBe(true);
  });
  it("moves rows into history when shrinking, including rows below the cursor", () => {
    const source = backing(0);
    const small = resizeNativeFrozenHeight(source, 3)!;
    expect(small).toMatchObject({ history: 7, hscrolled: 5, cursor: [0, 0] });
    expect(small.grid).toEqual(source.grid);
    const restored = resizeNativeFrozenHeight(small, 8)!;
    expect(restored).toMatchObject({ history: 2, hscrolled: 0, cursor: [0, 5] });
    expect(restored.grid).toEqual(source.grid);
    expect(source.cursor).toEqual([5, 1]);
  });
  it("keeps no-op identity and rejects dimensions outside the bounded backing", () => {
    const source = backing(0);
    expect(resizeNativeFrozenHeight(source, 8)).toBe(source);
    for (const rows of [0, -1, 1.5, Infinity, 262144])
      expect(resizeNativeFrozenHeight(source, rows)).toBeNull();
  });
});

it("v2 reflows written spaces but preserves erased allocation without adding rows", () => {
  const empty = {
    flags: 64,
    width: 1,
    bytesHex: "20",
    text: " ",
    attributes: 0,
    foreground: 8,
    background: 16777233,
    underline: 8,
    link: 0,
    storageFlags: 66,
  };
  const source = {
    ...backing(0),
    version: 2 as const,
    cols: 4,
    rows: 1,
    history: 0,
    hscrolled: 0,
    cursor: [0, 0] as const,
    grid: [{ flags: 0, used: 0, cells: Array(4).fill(empty) }],
  };
  const erased = resizeNativeFrozenGrid(source, 2, 1)!;
  expect(erased.history).toBe(0);
  expect(erased.grid[0]!.used).toBe(0);
  expect(erased.grid[0]!.cells).toEqual(source.grid[0]!.cells);
  const written = resizeNativeFrozenGrid(
    {
      ...source,
      grid: [
        {
          ...source.grid[0]!,
          used: 4,
          cells: Array(4).fill({ ...empty, flags: 0, storageFlags: 2 }),
        },
      ],
    },
    2,
    1,
  )!;
  expect(written.history).toBe(1);
  expect(written.grid.map((row) => row.used)).toEqual([2, 2]);
  expect(written.grid.every((row) => row.cells.every((cell) => cell.background === 16777233))).toBe(
    true,
  );
});

it("v2 joining writes at used rather than appending after erased allocation", () => {
  const cell = (text: string, bg = 8) => ({
    flags: 0,
    width: 1,
    bytesHex: Buffer.from(text).toString("hex"),
    text,
    attributes: 0,
    foreground: 8,
    background: bg,
    underline: 8,
    link: 0,
    storageFlags: 0,
  });
  const source = {
    ...backing(0),
    version: 2 as const,
    cols: 2,
    rows: 2,
    history: 0,
    hscrolled: 0,
    cursor: [0, 0] as const,
    grid: [
      {
        flags: 1,
        used: 2,
        cells: [cell("a"), cell("b"), cell(" ", 16777233), cell(" ", 16777233)],
      },
      { flags: 0, used: 2, cells: [cell("c"), cell("d")] },
    ],
  };
  const joined = resizeNativeFrozenGrid(source, 4, 2)!;
  expect(joined.grid[0]!.used).toBe(4);
  expect(joined.grid[0]!.cells.map((cell) => cell.text).join("")).toBe("abcd");
  expect(joined.grid[0]!.cells[3]!.background).toBe(8);
});
