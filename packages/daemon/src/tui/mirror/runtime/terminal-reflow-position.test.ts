import { describe, expect, it } from "vitest";
import { blankTerminalReplicaSnapshot, freezeTerminalReplicaSnapshot } from "@tmux-ide/core";
import type { TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { reflowTerminalPosition, reflowRetainedTerminalSnapshot } from "../terminal-viewport.ts";
import { extractTerminalCopySelection } from "./terminal-copy-selection.ts";
import { extractTerminalSelection } from "./terminal-selection.ts";
import { retainedTerminalCell } from "../terminal-retained-row.ts";
import { createTerminalCopyCursor, moveTerminalCopyCursor } from "./terminal-copy-cursor.ts";

function snapshot(
  cols: number,
  history: number,
  lines: ReadonlyArray<readonly [string, boolean]>,
): TerminalReplicaSnapshot {
  const blank = blankTerminalReplicaSnapshot(cols, lines.length - history);
  const rows = lines.map(([text, wrapped]) => {
    const cells = blank.grid[0]!.cells.map((cell) => ({ ...cell }));
    let column = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
      text,
    )) {
      const width = segment === "界" ? 2 : 1;
      cells[column] = { ...cells[column]!, grapheme: segment, width };
      if (width === 2) cells[column + 1] = { ...cells[column + 1]!, grapheme: "", width: 0 };
      column += width;
    }
    expect(column).toBeLessThanOrEqual(cols);
    return { cells, wrapped };
  });
  return { ...blank, history: rows.slice(0, history), grid: rows.slice(history) };
}

describe("logical terminal reflow position", () => {
  it("preserves a reader after preceding styled blank tails wrap during retained resize", () => {
    const before = snapshot(8, 2, [
      ["OLD", false],
      ["READ", false],
      ["LIVE", false],
    ]);
    for (const row of [...before.history, ...before.grid]) {
      for (const cell of row.cells) cell.background = { kind: "indexed", index: 17 };
    }
    const after = reflowRetainedTerminalSnapshot(before, 4, 3)!;
    expect(after.history.length).toBe(3);
    expect(reflowTerminalPosition(before, after, { x: 0, y: -1 }, true)).toEqual({ x: 0, y: -1 });
    expect(reflowTerminalPosition(after, before, { x: 0, y: -1 }, true)).toEqual({ x: 0, y: -1 });
  });

  it("matches displayed gaps and unused tails across capture representations", () => {
    const wide = snapshot(4, 0, [
      ["a B", false],
      ["", false],
    ]);
    wide.grid[0]!.cells[1]!.grapheme = "";
    wide.grid[0]!.cells[3]!.grapheme = "";
    for (const cell of wide.grid[1]!.cells) cell.grapheme = "";
    const narrow = snapshot(2, 1, [
      ["a ", false],
      ["B", true],
      ["", false],
    ]);
    expect(reflowTerminalPosition(wide, narrow, { x: 2, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(reflowTerminalPosition(narrow, wide, { x: 0, y: 0 })).toEqual({ x: 2, y: 0 });
  });

  it("maps a logical offset between history and the grid in both directions", () => {
    const wide = snapshot(8, 1, [
      ["ABCDEFGH", false],
      ["IJKL", true],
      ["TAIL", false],
    ]);
    const narrow = snapshot(4, 2, [
      ["ABCD", false],
      ["EFGH", true],
      ["IJKL", true],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(wide, narrow, { x: 5, y: -1 })).toEqual({ x: 1, y: -1 });
    expect(reflowTerminalPosition(narrow, wide, { x: 1, y: -1 })).toEqual({ x: 5, y: -1 });
    expect(reflowTerminalPosition(wide, narrow, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(reflowTerminalPosition(wide, narrow, { x: 6, y: 0 })).toEqual({ x: 4, y: 0 });
  });

  it("distinguishes a wide-glyph wrap slot from the preceding written space", () => {
    const wide = snapshot(6, 1, [
      ["abc 界", false],
      ["é", true],
      ["TAIL", false],
    ]);
    const narrow = snapshot(5, 1, [
      ["abc  ", false],
      ["界é", true],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(wide, narrow, { x: 4, y: -1 })).toEqual({ x: 0, y: 0 });
    expect(reflowTerminalPosition(wide, narrow, { x: 5, y: -1 })).toEqual({ x: 1, y: 0 });
    expect(reflowTerminalPosition(narrow, wide, { x: 0, y: 0 })).toEqual({ x: 4, y: -1 });
    expect(reflowTerminalPosition(narrow, wide, { x: 3, y: -1 })).toEqual({ x: 3, y: -1 });
    expect(reflowTerminalPosition(narrow, wide, { x: 2, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it("keeps repeated logical lines in order instead of searching for matching text", () => {
    const wide = snapshot(6, 1, [
      ["repeat", false],
      ["repeat", false],
      ["tail", false],
    ]);
    const narrow = snapshot(3, 4, [
      ["rep", false],
      ["eat", true],
      ["rep", false],
      ["eat", true],
      ["tai", false],
      ["l", true],
    ]);
    expect(reflowTerminalPosition(wide, narrow, { x: 0, y: 0 })).toEqual({ x: 0, y: -2 });
  });

  it("maps a unique retained line after older logical lines disappear", () => {
    const before = snapshot(8, 3, [
      ["OLD", false],
      ["DISCARD", false],
      ["ABCDEFGH", false],
      ["TAIL", false],
    ]);
    const after = snapshot(4, 2, [
      ["ABCD", false],
      ["EFGH", true],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(before, after, { x: 5, y: -1 })).toEqual({ x: 1, y: -1 });
  });

  it("does not guess between repeated remaining logical lines after trimming", () => {
    const before = snapshot(8, 3, [
      ["OLD", false],
      ["same", false],
      ["same", false],
      ["TAIL", false],
    ]);
    const after = snapshot(4, 2, [
      ["same", false],
      ["same", false],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(before, after, { x: 0, y: -2 })).toBeNull();
  });

  it("preserves a unique reading paragraph after native padding changes earlier text", () => {
    const before = snapshot(8, 2, [
      ["abc界def", false],
      ["READ", false],
      ["TAIL", false],
    ]);
    const after = snapshot(4, 3, [
      ["abc", false],
      ["界 d", true],
      ["ef", true],
      ["READ", false],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(before, after, { x: 1, y: -1 })).toEqual({ x: 1, y: 0 });
    const appended = {
      ...after,
      rows: after.rows + 1,
      grid: [...after.grid, snapshot(4, 0, [["MORE", false]]).grid[0]!],
    };
    expect(reflowTerminalPosition(before, appended, { x: 1, y: -1 })).toEqual({ x: 1, y: 0 });
    const changed = snapshot(4, 3, [
      ["abc", false],
      ["界 d", true],
      ["ef", true],
      ["READ", false],
      ["FAIL", false],
    ]);
    expect(reflowTerminalPosition(before, changed, { x: 1, y: -1 })).toBeNull();
  });

  it("rejects equal-count recovery when the old or new reading paragraph repeats", () => {
    const before = snapshot(8, 2, [
      ["same", false],
      ["same", false],
      ["TAIL", false],
    ]);
    const after = snapshot(4, 2, [
      ["NEW", false],
      ["same", false],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(before, after, { x: 0, y: -1 })).toBeNull();
    const unique = snapshot(8, 3, [
      ["OLD", false],
      ["same", false],
      ["diff", false],
      ["TAIL", false],
    ]);
    const repeated = snapshot(4, 3, [
      ["NEW", false],
      ["same", false],
      ["same", false],
      ["TAIL", false],
    ]);
    expect(reflowTerminalPosition(unique, repeated, { x: 0, y: -2 })).toBeNull();
  });

  it("preserves a complete reading line while later output changes during resize", () => {
    const before = snapshot(8, 1, [
      ["ABCDEFGH", false],
      ["TAIL", false],
    ]);
    const after = snapshot(4, 2, [
      ["ABCD", false],
      ["EFGH", true],
      ["TAIL", false],
      ["MORE", true],
    ]);
    expect(reflowTerminalPosition(before, after, { x: 5, y: -1 })).toEqual({ x: 1, y: -1 });
    expect(reflowTerminalPosition(before, after, { x: 0, y: 0 })).toBeNull();
  });

  it("preserves retained text when height changes pull all history into the grid", () => {
    const short = snapshot(4, 1, [
      ["OLD", false],
      ["READ", false],
      ["TAIL", false],
    ]);
    const tall = snapshot(4, 0, [
      ["OLD", false],
      ["READ", false],
      ["TAIL", false],
      ["", false],
      ["", false],
    ]);
    expect(reflowTerminalPosition(short, tall, { x: 0, y: 0 })).toEqual({ x: 0, y: 1 });
    expect(reflowTerminalPosition(tall, short, { x: 0, y: 1 })).toEqual({ x: 0, y: 0 });
    expect(reflowTerminalPosition(tall, short, { x: 0, y: 4 })).toBeNull();
  });

  it("rejects changed or removed reading lines and alternate screens", () => {
    const before = snapshot(8, 1, [
      ["ABCDEFGH", false],
      ["TAIL", false],
    ]);
    const changed = snapshot(4, 2, [
      ["ABCD", false],
      ["XFGH", true],
      ["TAIL", false],
    ]);
    const removed = snapshot(4, 1, [
      ["ABCD", false],
      ["EFGH", true],
    ]);
    expect(reflowTerminalPosition(before, changed, { x: 0, y: -1 })).toBeNull();
    expect(reflowTerminalPosition(before, removed, { x: 0, y: -1 })).toEqual({ x: 0, y: -1 });
    expect(reflowTerminalPosition(before, removed, { x: 0, y: 0 })).toBeNull();
    expect(reflowTerminalPosition(before, changed, { x: 0, y: 0 })).toBeNull();
    expect(
      reflowTerminalPosition(
        before,
        { ...before, modes: { ...before.modes, alternateScreen: true } },
        { x: 0, y: -1 },
      ),
    ).toBeNull();
  });
});

describe("retained terminal cell reflow", () => {
  it("shares physical rows and preserves an unused-column cursor during height-only resizing", () => {
    const original = snapshot(4, 1, [
      ["HEAD", false],
      ["BODY", false],
      ["", false],
    ]);
    original.grid[1]!.cells.forEach((cell) => {
      cell.grapheme = "";
    });
    original.cursor = { ...original.cursor, x: 3, y: 1 };
    const before = structuredClone(original);
    const short = reflowRetainedTerminalSnapshot(original, 4, 1)!;
    expect(short.history[0]).toBe(original.history[0]);
    expect(short.history[1]).toBe(original.grid[0]);
    expect(short.grid[0]).toBe(original.grid[1]);
    expect(short.cursor).toMatchObject({ x: 3, y: 0 });
    const tall = reflowRetainedTerminalSnapshot(short, 4, 5)!;
    expect(tall.grid[0]).toBe(original.history[0]);
    expect(tall.grid[1]).toBe(original.grid[0]);
    expect(tall.grid[2]).toBe(original.grid[1]);
    expect(tall.grid[3]).toBe(tall.grid[4]);
    expect(Object.isFrozen(tall.grid[3]?.cells)).toBe(true);
    expect(tall.cursor).toMatchObject({ x: 3, y: 2 });
    expect(original).toEqual(before);
  });

  it("does not scan retained history when mapping within the identical snapshot", () => {
    const original = snapshot(4, 0, [["ABCD", false]]);
    let rowReads = 0;
    const history = new Proxy(
      Array.from({ length: 9000 }, () => original.grid[0]!),
      {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) rowReads++;
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const retained = { ...original, history };
    // Late native backing admission can revise the view's backing identity
    // without replacing this immutable snapshot or moving its reading anchor.
    expect(reflowTerminalPosition(retained, retained, { x: 2, y: -5 }, true)).toEqual({
      x: 2,
      y: -5,
    });
    expect(rowReads).toBe(0);
  });

  it("does not read history cell arrays when only height changes", () => {
    const original = snapshot(4, 0, [["ABCD", false]]);
    const historyRow = Object.freeze({
      wrapped: false,
      get cells(): (typeof original.grid)[0]["cells"] {
        throw new Error("history cells walked");
      },
    });
    const source = { ...original, history: Array.from({ length: 9000 }, () => historyRow) };
    const resized = reflowRetainedTerminalSnapshot(source, 4, 2)!;
    expect(resized.history).toHaveLength(8999);
    expect(resized.grid[0]).toBe(historyRow);
    expect(resized.grid[1]).toBe(original.grid[0]);
    expect(reflowTerminalPosition(source, resized, { x: 2, y: -4500 })).toEqual({
      x: 2,
      y: -4499,
    });
  });
  it("refuses unbounded expanded history without truncating or mutating the frozen source", () => {
    const original = snapshot(2, 0, [["AB", false]]);
    const before = structuredClone(original);
    expect(reflowRetainedTerminalSnapshot(original, Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(reflowRetainedTerminalSnapshot(original, 1000, 1001)).toBeNull();
    expect(reflowRetainedTerminalSnapshot(original, 1, 10_001)).toBeNull();
    // One thousand and one independent short lines cannot be merged on grow.
    // Screen dimensions alone fit, but expanded history exceeds the cell cap.
    const history = {
      ...original,
      history: Array.from({ length: 1000 }, () => original.grid[0]!),
    };
    expect(reflowRetainedTerminalSnapshot(history, 1000, 1)).toBeNull();
    expect(
      reflowRetainedTerminalSnapshot(
        {
          ...history,
          history: history.history.map(() => ({
            wrapped: false,
            get cells(): (typeof original.grid)[number]["cells"] {
              throw new Error("rejected expansion read cells");
            },
          })),
        },
        1000,
        1,
      ),
    ).toBeNull();
    expect(history.history).toHaveLength(1000);
    expect(history.history.every((row) => row === original.grid[0])).toBe(true);
    const atLimit = reflowRetainedTerminalSnapshot(
      { ...history, history: history.history.slice(1) },
      1000,
      1,
    )!;
    expect(atLimit.history).toHaveLength(999);
    expect(atLimit.grid).toHaveLength(1);
    expect(atLimit.grid[0]?.cells).toHaveLength(1000);
    expect(original).toEqual(before);
    expect(reflowRetainedTerminalSnapshot(original, 4, 1)?.grid[0]?.cells[0]?.grapheme).toBe("A");
  });
  it("reflows written spaces, wide glyphs and styles without reading live content", () => {
    const original = snapshot(6, 0, [
      ["ab 界", false],
      ["tail", false],
    ]);
    original.grid[0]!.cells[5]!.grapheme = "";
    original.grid[1]!.cells[4]!.grapheme = "";
    original.grid[1]!.cells[5]!.grapheme = "";
    original.grid[0]!.cells[3]!.foreground = { kind: "indexed", index: 2 };
    const narrow = reflowRetainedTerminalSnapshot(original, 3, 2)!;
    expect(narrow.history.length).toBe(2);
    const lines = [...narrow.history, ...narrow.grid];
    expect(
      lines.map((row) =>
        row.cells
          .filter((cell) => cell.width !== 0)
          .map((cell) => cell.grapheme || " ")
          .join(""),
      ),
    ).toEqual(["ab ", "界 ", "tai", "l  "]);
    expect(lines.map((row) => row.wrapped)).toEqual([false, true, false, true]);
    expect(lines[1]!.cells[0]).toBe(original.grid[0]!.cells[3]);
    expect(lines[1]!.cells[0]!.foreground).toEqual({ kind: "indexed", index: 2 });
    const restored = reflowRetainedTerminalSnapshot(narrow, 6, 2)!;
    expect(restored.history.length).toBe(0);
    expect(restored.grid).toEqual(original.grid);
    expect(original.cols).toBe(6);
    const one = reflowRetainedTerminalSnapshot(original, 1, 2)!;
    expect(() => freezeTerminalReplicaSnapshot(one)).not.toThrow();
    expect(one.cols).toBe(1);
    const oneRows = [...one.history, ...one.grid];
    const wideIndex = oneRows.findIndex((row) => retainedTerminalCell(row, 0)?.grapheme === "界");
    expect(wideIndex).toBeGreaterThanOrEqual(0);
    expect(oneRows[wideIndex]!.cells).toHaveLength(1);
    expect(oneRows[wideIndex]!.cells[0]).toMatchObject({ grapheme: "", width: 1 });
    expect(
      extractTerminalCopySelection(
        one,
        { row: 0, col: 0 },
        { row: oneRows.length - 1, col: 1 },
        "emacs",
      )?.text,
    ).toBe("ab 界\ntail");
    expect(
      extractTerminalSelection(one, { row: wideIndex, col: 0 }, { row: wideIndex, col: 0 })?.text,
    ).toBe("界");
    const keyboard = {
      ...createTerminalCopyCursor(one, "emacs"),
      position: { row: wideIndex, col: 0 },
      anchor: { row: wideIndex, col: 0 },
    };
    const afterWide = moveTerminalCopyCursor(keyboard, "right");
    expect(afterWide.position).toEqual({ row: wideIndex, col: 1 });
    expect(
      extractTerminalCopySelection(one, keyboard.position, afterWide.position, "emacs")?.text,
    ).toBe("界");
    expect(moveTerminalCopyCursor(afterWide, "right").position).toEqual({
      row: wideIndex + 1,
      col: 0,
    });
    const tallerOne = reflowRetainedTerminalSnapshot(one, 1, 3)!;
    expect(
      retainedTerminalCell([...tallerOne.history, ...tallerOne.grid][wideIndex]!, 0)?.grapheme,
    ).toBe("界");
    expect(reflowRetainedTerminalSnapshot(tallerOne, 6, 2)!.grid).toEqual(original.grid);
  });

  it("keeps frozen rows through height changes and pads with unused cells", () => {
    const original = snapshot(4, 1, [
      ["HEAD", false],
      ["BODY", false],
      ["TAIL", false],
    ]);
    const short = reflowRetainedTerminalSnapshot(original, 4, 1)!;
    expect(short.history).toHaveLength(2);
    expect(short.grid[0]!.cells).toEqual(original.grid[1]!.cells);
    const tall = reflowRetainedTerminalSnapshot(short, 4, 5)!;
    expect(tall.history).toHaveLength(0);
    expect(
      tall.grid.slice(0, 3).map((row) => row.cells.map((cell) => cell.grapheme).join("")),
    ).toEqual(["HEAD", "BODY", "TAIL"]);
    expect(tall.grid[4]!.cells.every((cell) => cell.grapheme === "")).toBe(true);
  });
});
