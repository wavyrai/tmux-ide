import { describe, expect, it } from "vitest";
import type { NativeGridCaptureCell } from "./native-grid-capture.ts";
import { projectNativeGridRow } from "./native-grid-projection.ts";
const cell = (text: string, width = 1, flags = 0): NativeGridCaptureCell => ({
  text,
  width,
  flags,
  bytesHex: Buffer.from(text).toString("hex"),
  attributes: 0,
  foreground: 8,
  background: 8,
  underline: 8,
  link: 0,
  storageFlags: flags,
});
describe("native backing paint projection", () => {
  it("keeps detached padding as a blank column without shifting copy coordinates", () => {
    const source = { flags: 0, cells: [cell("!", 1, 4), cell("é")] };
    const row = projectNativeGridRow(source, 4)!;
    expect(row.cells.map((cell) => cell.grapheme)).toEqual(["", "é", "", ""]);
    expect(row.cells.map((cell) => cell.width)).toEqual([1, 1, 1, 1]);
    expect(source.cells[0]!.text).toBe("!");
  });
  it("paints a wide owner with valid continuation, clips either edge and preserves the backing", () => {
    const source = {
      flags: 0,
      cells: [{ ...cell("界", 2), background: 0x02010203 }, cell("!", 1, 4), cell("z")],
    };
    expect(
      projectNativeGridRow(source, 3)!.cells.map((cell) => [cell.grapheme, cell.width]),
    ).toEqual([
      ["界", 2],
      ["", 0],
      ["z", 1],
    ]);
    expect(projectNativeGridRow(source, 1)!.cells[0]).toMatchObject({
      grapheme: "",
      width: 1,
      background: { kind: "rgb", value: 0x010203 },
    });
    expect(projectNativeGridRow(source, 2, 1)!.cells.map((cell) => cell.grapheme)).toEqual([
      "",
      "z",
    ]);
    expect(projectNativeGridRow(source, 2, 1)!.cells[0]!.background).toEqual({
      kind: "rgb",
      value: 0x010203,
    });
    expect(source.cells[0]!.text).toBe("界");
  });
  it("maps native attribute bits, colors and alternate-character-set borders", () => {
    const source = {
      flags: 0,
      cells: [
        {
          ...cell("q"),
          attributes: 0x80 | 0x100 | 0x40 | 0x200,
          foreground: 91,
          background: 0x01000008,
        },
      ],
    };
    expect(projectNativeGridRow(source, 1)!.cells[0]).toMatchObject({
      grapheme: "─",
      attributes: 128 | 4 | 8,
      foreground: { kind: "indexed", index: 9 },
      background: { kind: "indexed", index: 8 },
    });
  });
  it("expands tab spans into styled blanks and starts every projection with a clean tail", () => {
    const source = {
      flags: 0,
      cells: [
        { ...cell("\t", 3, 0x80), background: 2 },
        cell("!", 1, 4),
        cell("!", 1, 4),
        cell("A"),
      ],
    };
    expect(projectNativeGridRow(source, 5)!.cells.map((cell) => cell.grapheme)).toEqual([
      "",
      "",
      "",
      "A",
      "",
    ]);
    expect(
      projectNativeGridRow(undefined, 5)!.cells.every(
        (cell) => cell.grapheme === "" && cell.width === 1,
      ),
    ).toBe(true);
    expect(
      projectNativeGridRow(source, 2)!.cells.every((cell) => cell.background.kind === "indexed"),
    ).toBe(true);
  });
  it("bounds viewport allocation and returns immutable rows", () => {
    for (const width of [0, -1, 1.5, 16385])
      expect(projectNativeGridRow(undefined, width)).toBeNull();
    expect(projectNativeGridRow(undefined, 1, -1)).toBeNull();
    const row = projectNativeGridRow(undefined, 2, 0, true)!;
    expect(row.wrapped).toBe(true);
    expect(Object.isFrozen(row.cells)).toBe(true);
    expect(Object.isFrozen(row.cells[0])).toBe(true);
  });
});

it("preserves erased background and distinguishes it from explicitly written spaces", () => {
  const background = 0x01000011;
  const row = projectNativeGridRow(
    {
      flags: 0,
      used: 1,
      cells: [
        { ...cell(" "), background },
        { ...cell(" ", 1, 64), background },
      ],
    },
    2,
  )!;
  expect(row.cells.map((cell) => cell.grapheme)).toEqual([" ", ""]);
  expect(row.cells.map((cell) => cell.background)).toEqual([
    { kind: "indexed", index: 17 },
    { kind: "indexed", index: 17 },
  ]);
});
