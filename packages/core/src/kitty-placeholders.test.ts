import { describe, expect, it } from "vitest";
import type { TerminalReplicaCell, TerminalReplicaRow } from "@tmux-ide/contracts";
import {
  decodeKittyPlaceholderCell,
  kittyPlaceholderRects,
  resolveKittyPlacements,
} from "./kitty-placeholders.ts";

const PLACEHOLDER = String.fromCodePoint(0x10eeee);
const D = ["̅", "̍", "̎", "̐"];
const cell = (grapheme: string, index?: number): TerminalReplicaCell => ({
  grapheme,
  width: 1,
  foreground: index === undefined ? { kind: "default" } : { kind: "indexed", index },
  background: { kind: "default" },
  attributes: 0,
});
const row = (cells: TerminalReplicaCell[]): TerminalReplicaRow => ({ cells, wrapped: false });

describe("kitty placeholders", () => {
  it("decodes cells with inherited row and column and 24-bit ids", () => {
    const fg = { kind: "indexed", index: 9 } as const;
    const first = decodeKittyPlaceholderCell(PLACEHOLDER + D[1] + D[2], fg, null)!;
    expect(first).toEqual({ imageId: 9, row: 1, col: 2 });
    expect(decodeKittyPlaceholderCell(PLACEHOLDER, fg, first)).toEqual({
      imageId: 9,
      row: 1,
      col: 3,
    });
    expect(decodeKittyPlaceholderCell("x", fg, first)).toBeNull();
    expect(
      decodeKittyPlaceholderCell(
        PLACEHOLDER + D[0] + D[0] + D[1],
        { kind: "rgb", value: 0x123456 },
        null,
      ),
    ).toEqual({ imageId: 0x1123456, row: 0, col: 0 });
  });

  it("merges runs into rectangles and splits on discontinuities", () => {
    const grid = [
      row([cell("a"), cell(PLACEHOLDER + D[0] + D[0], 5), cell(PLACEHOLDER, 5), cell("b")]),
      row([cell("a"), cell(PLACEHOLDER + D[1] + D[0], 5), cell(PLACEHOLDER, 5), cell("b")]),
      row([cell(PLACEHOLDER + D[3] + D[1], 5), cell("c"), cell("c"), cell("c")]),
    ];
    expect(kittyPlaceholderRects(grid)).toEqual([
      { imageId: 5, row: 0, column: 1, rows: 2, columns: 2, srcRow: 0, srcCol: 0 },
      { imageId: 5, row: 2, column: 0, rows: 1, columns: 1, srcRow: 3, srcCol: 1 },
    ]);
  });

  it("resolves placements only for registered images within their virtual grid", () => {
    const digest = "0".repeat(32);
    const grid = [row([cell(PLACEHOLDER + D[0] + D[0], 5), cell(PLACEHOLDER, 7)])];
    const image = { digest, format: "png" as const, width: 2, height: 2, bytes: 10 };
    expect(
      resolveKittyPlacements(grid, {
        revision: 1,
        images: [{ ...image, imageId: 5, placeholder: { columns: 2, rows: 2 } }],
        placements: [],
      }),
    ).toEqual([
      {
        digest,
        row: 0,
        column: 0,
        rows: 1,
        columns: 1,
        sourceRow: 0,
        sourceColumn: 0,
        totalRows: 2,
        totalColumns: 2,
      },
    ]);
    // An image without a virtual placement is not placed by its cells.
    expect(
      resolveKittyPlacements(grid, {
        revision: 1,
        images: [{ ...image, imageId: 5, placeholder: null }],
        placements: [],
      }),
    ).toEqual([]);
  });
});
