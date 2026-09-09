import { expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { terminalSelectionUnit, extendTerminalSelectionUnit } from "./terminal-selection-units.ts";
import { extractTerminalSelection } from "./terminal-selection.ts";

function fixture() {
  const blank = blankTerminalReplicaSnapshot(6, 4);
  const row = (text: string, wrapped = false) => ({
    wrapped,
    cells: [...text].map((grapheme) => ({ ...blank.grid[0]!.cells[0]!, grapheme })),
  });
  return {
    ...blank,
    history: [row("hello_")],
    grid: [row("world!", true), row("ab  !!"), row("next  "), row("last  ")],
  };
}
it("selects words across soft wrapping but stops at a hard line", () => {
  const snapshot = fixture();
  const range = terminalSelectionUnit(snapshot, { row: 1, col: 2 }, "word")!;
  expect(range).toEqual({ start: { row: 0, col: 0 }, end: { row: 1, col: 4 } });
  expect(extractTerminalSelection(snapshot, range.start, range.end)?.text).toBe("hello_world");
  expect(terminalSelectionUnit(snapshot, { row: 2, col: 0 }, "word")).toEqual({
    start: { row: 2, col: 0 },
    end: { row: 2, col: 1 },
  });
  expect(terminalSelectionUnit(snapshot, { row: 2, col: 2 }, "word")).toEqual({
    start: { row: 2, col: 2 },
    end: { row: 2, col: 3 },
  });
  expect(terminalSelectionUnit(snapshot, { row: 2, col: 5 }, "word")).toEqual({
    start: { row: 2, col: 4 },
    end: { row: 2, col: 5 },
  });
});
it("selects a complete wrapped logical line from either physical row", () => {
  const snapshot = fixture();
  const expected = { start: { row: 0, col: 0 }, end: { row: 1, col: 5 } };
  expect(terminalSelectionUnit(snapshot, { row: 0, col: 2 }, "line")).toEqual(expected);
  expect(terminalSelectionUnit(snapshot, { row: 1, col: 5 }, "line")).toEqual(expected);
  expect(extractTerminalSelection(snapshot, expected.start, expected.end)?.text).toBe(
    "hello_world!",
  );
});
it("normalizes wide padding and treats combined Unicode letters as word cells", () => {
  const snapshot = fixture();
  const cell = snapshot.grid[0]!.cells[0]!;
  snapshot.grid[2] = {
    wrapped: false,
    cells: [
      { ...cell, grapheme: "界", width: 2 as const },
      { ...cell, grapheme: "", width: 0 as const },
      { ...cell, grapheme: "e\u0301" },
      { ...cell, grapheme: "_" },
      { ...cell, grapheme: "7" },
      { ...cell, grapheme: " " },
    ],
  };
  const point = { row: 3, col: 1 };
  expect(terminalSelectionUnit(snapshot, point, "cell")).toEqual({
    start: { row: 3, col: 0 },
    end: { row: 3, col: 0 },
  });
  const range = terminalSelectionUnit(snapshot, point, "word")!;
  expect(extractTerminalSelection(snapshot, range.start, range.end)?.text).toBe("界é_7");
});
it("extends whole units backward and forward without shrinking the original unit", () => {
  const snapshot = fixture();
  const anchor = terminalSelectionUnit(snapshot, { row: 2, col: 0 }, "word")!;
  expect(extendTerminalSelectionUnit(snapshot, anchor, { row: 0, col: 4 }, "word")).toEqual({
    start: { row: 2, col: 1 },
    end: { row: 0, col: 0 },
  });
  expect(extendTerminalSelectionUnit(snapshot, anchor, { row: 2, col: 0 }, "cell")).toEqual(anchor);
  expect(extendTerminalSelectionUnit(snapshot, anchor, { row: 3, col: 1 }, "word")).toEqual({
    start: { row: 2, col: 0 },
    end: { row: 3, col: 3 },
  });
  expect(terminalSelectionUnit(snapshot, { row: NaN, col: 0 }, "word")).toBeNull();
  expect(terminalSelectionUnit(snapshot, { row: 0, col: 6 }, "line")).toBeNull();
});

it("bounds long wrapped units while finding a nearby word without scanning the chain", () => {
  const base = fixture();
  const repeated = {
    wrapped: true,
    cells: base.history[0]!.cells.map((cell) => ({ ...cell, grapheme: "x" })),
  };
  const snapshot = { ...base, history: Array.from({ length: 12000 }, () => repeated) };
  expect(terminalSelectionUnit(snapshot, { row: 100, col: 0 }, "line")).toBeNull();
  expect(terminalSelectionUnit(snapshot, { row: 100, col: 0 }, "word")).toBeNull();
  snapshot.history[100] = {
    ...repeated,
    cells: repeated.cells.map((cell, index) => ({ ...cell, grapheme: index === 2 ? "!" : "x" })),
  };
  expect(terminalSelectionUnit(snapshot, { row: 100, col: 2 }, "word")).toEqual({
    start: { row: 100, col: 2 },
    end: { row: 100, col: 2 },
  });
});
