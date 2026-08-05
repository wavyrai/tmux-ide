import { describe, expect, it } from "vitest";

import { readWidgetCellRows, type GridReader } from "./xterm-cell-rows.ts";
import { detectWidgetMarker, encodeWidgetMarkerLine } from "@tmux-ide/contracts";

/**
 * A buffer built from cell strings, the way xterm reports them: the trailing
 * half of a wide glyph is a zero-width cell that repeats the same characters.
 */
function grid(lines: readonly { cells: readonly string[]; wrapped?: boolean }[]): GridReader {
  const built = lines.map((line) => ({
    length: line.cells.length,
    isWrapped: line.wrapped ?? false,
    getCell: (column: number) => {
      const chars = line.cells[column];
      if (chars === undefined) return undefined;
      // Zero-width: a cell whose characters belong to the cell before it.
      const width = chars === "" ? 1 : [...chars][0]!.codePointAt(0)! > 0x2fff ? 2 : 1;
      const isTrailingHalf = column > 0 && line.cells[column - 1] === chars && width === 2;
      return {
        getChars: () => chars,
        getWidth: () => (isTrailingHalf ? 0 : width),
      };
    },
  }));
  return { buffer: { active: { length: built.length, getLine: (index) => built[index] } } };
}

describe("reading a grid as cells", () => {
  it("reads a plain row", () => {
    const rows = readWidgetCellRows(grid([{ cells: ["a", "b", "c"] }]), 10);
    expect(rows).toEqual([{ cells: ["a", "b", "c"], wrapped: false }]);
  });

  /*
   * Rule 10, at the boundary where it actually bites. xterm reports the second
   * half of a wide glyph as a zero-width cell carrying the SAME characters. A
   * reader that took `getChars()` at face value would emit "日日本本" for a row
   * that says "日本" — and every column index after it would be wrong.
   */
  it("does not duplicate a wide glyph across the cell that carries its tail", () => {
    const rows = readWidgetCellRows(grid([{ cells: ["日", "日", "本", "本", "!"] }]), 10);
    expect(rows[0]!.cells).toEqual(["日", "", "本", "", "!"]);
  });

  it("carries the wrapped flag, which is what rejoins a long marker", () => {
    const rows = readWidgetCellRows(
      grid([{ cells: ["a"] }, { cells: ["b"], wrapped: true }, { cells: ["c"] }]),
      10,
    );
    expect(rows.map((row) => row.wrapped)).toEqual([false, true, false]);
  });

  it("reads only the newest rows when the scan window is smaller than the buffer", () => {
    const rows = readWidgetCellRows(
      grid([{ cells: ["1"] }, { cells: ["2"] }, { cells: ["3"] }, { cells: ["4"] }]),
      2,
    );
    expect(rows.map((row) => row.cells.join(""))).toEqual(["3", "4"]);
  });

  it("returns nothing for an empty buffer or a zero window", () => {
    expect(readWidgetCellRows(grid([]), 10)).toEqual([]);
    expect(readWidgetCellRows(grid([{ cells: ["a"] }]), 0)).toEqual([]);
  });

  /*
   * The two halves of the feature, joined: what the reader produces is what the
   * detector consumes, including across a wrap the emulator introduced.
   */
  it("feeds the detector a marker the grid had to wrap", () => {
    const marker = encodeWidgetMarkerLine("markdown", { text: "hello from a pane" });
    const characters = [...marker];
    const width = 20;
    const lines: { cells: string[]; wrapped?: boolean }[] = [];
    for (let offset = 0; offset < characters.length; offset += width) {
      lines.push({ cells: characters.slice(offset, offset + width), wrapped: offset > 0 });
    }
    expect(lines.length).toBeGreaterThan(2);
    const detected = detectWidgetMarker(readWidgetCellRows(grid(lines), 2_048));
    expect(detected).toMatchObject({ id: "markdown", args: { text: "hello from a pane" } });
  });
});
