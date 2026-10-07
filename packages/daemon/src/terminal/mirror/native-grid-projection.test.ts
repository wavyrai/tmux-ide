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

it("shares only exact normalized default empty and space values through ownership", async () => {
  const {
    TERMINAL_REPLICA_EMPTY_CELL: empty,
    TERMINAL_REPLICA_SPACE_CELL: space,
    applyTerminalReplicaPatch,
    blankTerminalReplicaSnapshot,
  } = await import("@tmux-ide/core");
  const source = {
    flags: 0,
    cells: [cell(""), cell(" "), cell(" ", 1, 64), cell("\t", 2, 0x80), cell("!", 1, 4)],
  };
  const row = projectNativeGridRow(source, 6)!;
  expect(row.cells).toEqual([empty, space, empty, empty, empty, empty]);
  expect(row.cells.map((c) => (c === empty ? "empty" : c === space ? "space" : "copied"))).toEqual([
    "empty",
    "space",
    "empty",
    "empty",
    "empty",
    "empty",
  ]);
  const owned = applyTerminalReplicaPatch(blankTerminalReplicaSnapshot(6, 1), {
    rows: [{ index: 0, row }],
  }).grid[0]!;
  row.cells.forEach((c, i) => expect(owned.cells[i]).toBe(c));
  expect(source.cells[2]!.text).toBe(" ");
  expect(source.cells[3]!.text).toBe("\t");
  expect(Reflect.set(empty, "grapheme", "changed")).toBe(false);
});

it("keeps styled blanks and wide continuations distinct from shared defaults", async () => {
  const { TERMINAL_REPLICA_EMPTY_CELL: empty, TERMINAL_REPLICA_SPACE_CELL: space } =
    await import("@tmux-ide/core");
  for (const attributes of [1, 2, 4, 8, 16, 32, 64, 256, 512]) {
    const result = projectNativeGridRow({ flags: 0, cells: [{ ...cell(" "), attributes }] }, 1)!
      .cells[0]!;
    expect(result).not.toBe(empty);
    expect(result).not.toBe(space);
    expect(result.attributes).not.toBe(0);
  }
  for (const background of [2, 0x01000011, 0x02010203]) {
    const source = { flags: 0, cells: [{ ...cell("界", 2), background }, cell("", 0, 4)] };
    const wide = projectNativeGridRow(source, 2)!;
    expect(wide.cells.map((c) => c.width)).toEqual([2, 0]);
    expect(wide.cells[1]).not.toBe(empty);
    const clipped = projectNativeGridRow(source, 1, 1)!.cells[0]!;
    expect(clipped.grapheme).toBe("");
    expect(clipped.background).toEqual(wide.cells[0]!.background);
    expect(clipped).not.toBe(empty);
  }
  const defaultWide = projectNativeGridRow(
    { flags: 0, cells: [cell("界", 2), cell("", 0, 4)] },
    2,
  )!;
  expect(defaultWide.cells[1]!.width).toBe(0);
  expect(defaultWide.cells[1]).not.toBe(empty);
});

it("preserves foreign getter reads and detaches later foreign changes", () => {
  const reads: string[] = [];
  const backing = { ...cell(" ") };
  const foreign = new Proxy(backing, {
    get(target, key, receiver) {
      reads.push(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  const row = projectNativeGridRow({ flags: 0, cells: [foreign] }, 1)!;
  expect(reads).toEqual([
    "flags",
    "attributes",
    "text",
    "width",
    "foreground",
    "background",
    "flags",
    "width",
    "width",
    "width",
    "width",
  ]);
  backing.text = "X";
  backing.background = 2;
  expect(row.cells[0]).toEqual({
    grapheme: " ",
    width: 1,
    foreground: { kind: "default" },
    background: { kind: "default" },
    attributes: 0,
  });
  const next = projectNativeGridRow({ flags: 0, cells: [foreign] }, 1)!;
  expect(next.cells[0]!.grapheme).toBe("X");
  expect(next.cells[0]!.background).toEqual({ kind: "indexed", index: 2 });
});
