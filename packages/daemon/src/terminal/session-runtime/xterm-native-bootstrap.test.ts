import { describe, expect, it } from "vitest";
import { blankTerminalReplicaSnapshot } from "@tmux-ide/core";
import { decodeNativeGridCapture } from "../mirror/native-grid-capture.ts";
import { projectNativeGridRow } from "../mirror/native-grid-projection.ts";
import { XtermTerminalInterpreterBackend } from "./xterm-terminal-interpreter-backend.ts";

const source = (current = 8) =>
  decodeNativeGridCapture(
    [
      {
        version: 2,
        cols: 4,
        rows: 2,
        history: 1,
        hscrolled: 1,
        limit: 2000,
        cursor: [1, 1],
        currentAttributes: [0, current, 8, 8],
      },
      {
        row: 0,
        flags: 1,
        used: 4,
        cells: [
          [0, 1, "41", 0, 8, 8, 8, 0, 0],
          [0, 1, "20", 0, 8, 16777233, 8, 0, 2],
          [8, 2, "e7958c", 0, 8, 8, 8, 0, 8],
          [4, 0, "", 0, 8, 8, 8, 0, 8],
        ],
      },
      {
        row: 1,
        flags: 0,
        used: 2,
        cells: [
          [8, 1, "65cc81", 0, 8, 8, 8, 0, 8],
          [0, 1, "20", 0, 8, 16777233, 8, 0, 2],
          [64, 1, "20", 0, 8, 16777233, 8, 0, 66],
          [64, 1, "20", 0, 8, 16777233, 8, 0, 66],
        ],
      },
      {
        row: 2,
        flags: 0,
        used: 0,
        cells: Array.from({ length: 4 }, () => [64, 1, "20", 0, 8, 16777233, 8, 0, 66]),
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
  )!;

describe("pinned native parser bootstrap", () => {
  it.each([8, 1])(
    "imports exact physical cells and resumes with current foreground %s",
    async (current) => {
      const native = source(current);
      const backend = new XtermTerminalInterpreterBackend({ cols: 4, rows: 2, scrollback: 2000 });
      try {
        expect(backend.canImportNativeGrid()).toBe(true);
        expect(backend.importNativeGrid(native)).toBe(true);
        const projected = backend.project(blankTerminalReplicaSnapshot(4, 2));
        expect([...projected.history, ...projected.grid]).toEqual(
          native.grid.map((row, index) =>
            projectNativeGridRow(row, 4, 0, index > 0 && (native.grid[index - 1]!.flags & 1) !== 0),
          ),
        );
        await backend.write("X");
        const after = backend.project(blankTerminalReplicaSnapshot(4, 2));
        expect(after.grid[1]!.cells[1]!.grapheme).toBe("X");
        expect(after.grid[1]!.cells[1]!.foreground).toEqual(
          current === 8 ? { kind: "default" } : { kind: "indexed", index: current },
        );
      } finally {
        backend.dispose();
      }
    },
  );
  it("keeps the parser erasure template blank after importing a final written cell", async () => {
    const original = source();
    const last = original.grid[2]!;
    const written = { ...last.cells[3]!, flags: 0, text: "Z", bytesHex: "5a" };
    const native = {
      ...original,
      grid: [
        ...original.grid.slice(0, 2),
        { ...last, used: 4, cells: [...last.cells.slice(0, 3), written] },
      ],
    };
    const backend = new XtermTerminalInterpreterBackend({ cols: 4, rows: 2, scrollback: 2000 });
    try {
      expect(backend.importNativeGrid(native)).toBe(true);
      await backend.write("\r\n");
      expect(
        backend
          .project(blankTerminalReplicaSnapshot(4, 2))
          .grid[1]!.cells.map((cell) => cell.grapheme),
      ).toEqual(["", "", "", ""]);
    } finally {
      backend.dispose();
    }
  });
  it("rejects a history import exceeding parser capacity without truncating it", () => {
    const backend = new XtermTerminalInterpreterBackend({ cols: 4, rows: 2, scrollback: 0 });
    try {
      expect(backend.importNativeGrid(source())).toBe(false);
    } finally {
      backend.dispose();
    }
  });
  it("refuses backing-only exports rather than guessing current rendition", () => {
    const backend = new XtermTerminalInterpreterBackend({ cols: 4, rows: 2, scrollback: 2000 });
    try {
      const backing = { ...source(), currentAttributes: undefined };
      expect(backend.importNativeGrid(backing)).toBe(false);
      expect(backend.importNativeGrid({ ...source(), cols: 16385 })).toBe(false);
      expect(backend.importNativeGrid({ ...source(), version: 1 })).toBe(false);
    } finally {
      backend.dispose();
    }
  });
});
