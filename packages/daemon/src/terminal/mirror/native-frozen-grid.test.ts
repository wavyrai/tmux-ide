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
