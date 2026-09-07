import { describe, expect, it } from "vitest";
import type { TerminalReplicaCell, TerminalReplicaSnapshot } from "@tmux-ide/contracts";
import { createTerminalCopyCursor } from "./terminal-copy-cursor.ts";
import { extractTerminalCopySelection } from "./terminal-copy-selection.ts";

const color = { kind: "default" as const };
const cell = (grapheme: string, width: 0 | 1 | 2 = 1): TerminalReplicaCell => ({
  grapheme,
  width,
  foreground: color,
  background: color,
  attributes: 0,
});
const row = (cells: TerminalReplicaCell[]) => ({ cells, wrapped: false });
const snapshot = (): TerminalReplicaSnapshot => ({
  cols: 6,
  rows: 2,
  history: [row([cell("h"), cell("i"), cell(" "), cell(" "), cell(" "), cell(" ")])],
  grid: [
    row([cell("A"), cell("界", 2), cell("", 0), cell("e\u0301"), cell(" "), cell(" ")]),
    row([cell("z"), cell("e"), cell("r"), cell("o"), cell(" "), cell(" ")]),
  ],
  cursor: { x: 0, y: 0, hidden: false, style: "block", blink: false },
  modes: {
    alternateScreen: false,
    applicationCursor: false,
    applicationKeypad: false,
    bracketedPaste: false,
    insert: false,
    origin: false,
    wraparound: true,
    mouseTracking: false,
    synchronizedOutput: false,
  },
  placements: [],
  bootstrap: { kind: "authoritative-stream", hiddenState: "observed-from-start" },
});

describe("native keyboard copy endpoints", () => {
  it.each([
    ["emacs", 1, 3, "界"],
    ["emacs", 3, 2, null],
    ["emacs", 1, 6, "界é B"],
    ["vi", 1, 3, "界é"],
    ["vi", 3, 2, "é"],
    ["vi", 1, 5, "界é B"],
  ] as const)("%s from %i to %i preserves exact native bytes", (mode, anchor, cursor, expected) => {
    const state = snapshot();
    state.grid[0] = row([cell("A"), cell("界", 2), cell("", 0), cell("é"), cell(" "), cell("B")]);
    const result = extractTerminalCopySelection(
      state,
      { row: 1, col: anchor },
      { row: 1, col: cursor },
      mode,
    );
    expect(result?.text ?? null).toBe(expected);
    if (expected) expect(result?.bytes).toBe(Buffer.byteLength(expected));
  });

  it("preserves wrapped spaces, hard newlines, and vi end-of-line selection", () => {
    const state = snapshot();
    state.history = [row([..."hello "].map((value) => cell(value)))];
    state.grid[0] = { ...row([..."world "].map((value) => cell(value))), wrapped: true };
    expect(
      extractTerminalCopySelection(state, { row: 0, col: 0 }, { row: 1, col: 5 }, "emacs")?.text,
    ).toBe("hello world");
    expect(
      extractTerminalCopySelection(state, { row: 0, col: 0 }, { row: 1, col: 5 }, "vi")?.text,
    ).toBe("hello world\n");
    expect(
      extractTerminalCopySelection(state, { row: 1, col: 0 }, { row: 2, col: 1 }, "emacs")?.text,
    ).toBe("world\nz");
  });

  it("rejects invalid points and byte overflow without returning partial text", () => {
    const state = snapshot();
    const a = { row: 1, col: 1 },
      b = { row: 1, col: 3 };
    expect(extractTerminalCopySelection(state, a, b, "emacs", 3)?.text).toBe("界");
    expect(extractTerminalCopySelection(state, a, b, "emacs", 2)).toBeNull();
    for (const point of [
      { row: -1, col: 0 },
      { row: 3, col: 0 },
      { row: 1, col: 7 },
      { row: 1.5, col: 1 },
      { row: 1, col: NaN },
    ]) {
      expect(extractTerminalCopySelection(state, a, point, "vi")).toBeNull();
    }
  });
});

it("enters keyboard copy inside the retained viewport without moving its origin", () => {
  const state = snapshot();
  state.cursor = { ...state.cursor, x: 5, y: 1 };
  const viewport = { x: 1, y: -1, cols: 3, rows: 1 };
  const cursor = createTerminalCopyCursor(state, "vi", viewport);
  expect(cursor.position).toEqual({ row: 0, col: 3 });
  expect(cursor.snapshot).toBe(state);
  expect(cursor.anchor).toBeNull();
  expect(viewport).toEqual({ x: 1, y: -1, cols: 3, rows: 1 });
});
