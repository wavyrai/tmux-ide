import { describe, expect, it } from "vitest";
import { reflowNativeRowsWithHistory, type NativeReflowRow } from "./terminal-native-reflow.ts";
const row = (text: string): NativeReflowRow => ({
  cells: [...text].map((text) => ({ text, width: 1, padding: false })),
  continues: false,
  extended: false,
});
describe("native reflow history boundary", () => {
  it("tracks scrolled history separately while splitting and joining cleared rows", () => {
    const input = [row("abcd"), row("efgh"), row("")];
    const narrow = reflowNativeRowsWithHistory(input, 2, 2, 0);
    expect(narrow).toMatchObject({ history: 3, hscrolled: 2 });
    expect(narrow.grid.map((row) => row.cells.map((cell) => cell.text).join(""))).toEqual([
      "ab",
      "cd",
      "ef",
      "gh",
      "",
    ]);
    const wide = reflowNativeRowsWithHistory(narrow.grid, 4, 2, narrow.hscrolled);
    expect(wide).toMatchObject({ history: 1, hscrolled: 1 });
    expect(wide.grid).toEqual(input);
    expect(input[0]!.cells).toHaveLength(4);
  });
  it("rejects history metadata outside the input backing", () => {
    for (const [rows, scrolled] of [
      [-1, 0],
      [4, 0],
      [2, 2],
      [2, -1],
      [1.5, 0],
    ])
      expect(() =>
        reflowNativeRowsWithHistory([row("a"), row("b"), row("")], 2, rows!, scrolled!),
      ).toThrow(RangeError);
  });
});

it("rejects a split before copying cells beyond the output-row budget", () => {
  let copies = 0;
  const source = [row("abcdefgh")];
  expect(() =>
    reflowNativeRowsWithHistory(
      source,
      1,
      1,
      0,
      (cell) => {
        copies++;
        return cell;
      },
      4,
    ),
  ).toThrow("retained row budget");
  expect(copies).toBe(0);
  expect(source[0]!.cells).toHaveLength(8);
});

it("supports a large valid split without spreading rows into function arguments", () => {
  const cell = { text: "x", width: 1, padding: false };
  const source: NativeReflowRow = {
    cells: Array(150000).fill(cell),
    continues: false,
    extended: false,
  };
  const result = reflowNativeRowsWithHistory([source], 1, 1, 0);
  expect(result.grid).toHaveLength(150000);
  expect(result.history).toBe(149999);
  expect(result.grid[149999]!.cells).toEqual([cell]);
});
