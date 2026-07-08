import { describe, it, expect } from "vitest";
import {
  writeCell,
  writeContinuation,
  swapCells,
  paintBg,
  CHAR_CONTINUATION,
  SPACE_CODE,
  type CellArrays,
} from "./blit.ts";

/** A plain-array stand-in for OptimizedBuffer.buffers (same shape/strides). */
function arrays(cells: number): CellArrays {
  return {
    char: new Uint32Array(cells),
    fg: new Uint16Array(cells * 4),
    bg: new Uint16Array(cells * 4),
    attributes: new Uint32Array(cells),
  };
}

// Defaults used across cases: fg 212,212,216 · bg 16,16,22 (the app's terminal
// default fg/bg), passed as the six trailing channel args.
const D = [212, 212, 216, 16, 16, 22] as const;

describe("writeCell", () => {
  it("writes an explicit packed fg/bg as split channels, opaque", () => {
    const b = arrays(1);
    writeCell(b, 0, 0x41, 0xff8800, 0x001122, 1, ...D);
    expect(b.char[0]).toBe(0x41);
    expect([...b.fg.slice(0, 4)]).toEqual([0xff, 0x88, 0x00, 255]);
    expect([...b.bg.slice(0, 4)]).toEqual([0x00, 0x11, 0x22, 255]);
    expect(b.attributes[0]).toBe(1);
  });

  it("falls back to the default channels when fg/bg are null", () => {
    const b = arrays(1);
    writeCell(b, 0, SPACE_CODE, null, null, 0, ...D);
    expect([...b.fg.slice(0, 4)]).toEqual([212, 212, 216, 255]);
    expect([...b.bg.slice(0, 4)]).toEqual([16, 16, 22, 255]);
  });

  it("writes at the correct flat offset for a non-zero index", () => {
    const b = arrays(3);
    writeCell(b, 2, 0x5a, 0x102030, null, 0, ...D);
    expect(b.char[2]).toBe(0x5a);
    expect([...b.fg.slice(8, 12)]).toEqual([0x10, 0x20, 0x30, 255]);
    // untouched cells stay zero
    expect(b.char[0]).toBe(0);
  });
});

describe("writeContinuation", () => {
  it("blanks the spacer half (char 0) and inherits the wide glyph's colors", () => {
    const b = arrays(2);
    // A wide glyph at cell 0 with a red bg.
    writeCell(b, 0, 0x4e2d /* 中 */, 0xffffff, 0xaa0000, 4, ...D);
    // Pre-dirty the spacer cell to prove writeContinuation clears its char.
    b.char[1] = 0x999;
    writeContinuation(b, 1);
    // The native renderer measures the lead cell's width and skips the spacer,
    // so its char must be empty (0) — NOT a stray codepoint (which would show).
    expect(b.char[1]).toBe(CHAR_CONTINUATION);
    expect(CHAR_CONTINUATION).toBe(0);
    // continuation inherits fg/bg/attrs so the background spans both cells
    expect([...b.bg.slice(4, 8)]).toEqual([0xaa, 0x00, 0x00, 255]);
    expect([...b.fg.slice(4, 8)]).toEqual([0xff, 0xff, 0xff, 255]);
    expect(b.attributes[1]).toBe(4);
  });
});

describe("swapCells", () => {
  it("swaps fg/bg across the inclusive clamped span of one row", () => {
    const width = 5;
    const b = arrays(width * 2);
    // Give row 1 a distinct fg (10,11,12) and bg (90,91,92) across its cells.
    for (let x = 0; x < width; x++) {
      writeCell(b, width + x, 0x41, 0x0a0b0c, 0x5a5b5c, 0, ...D);
    }
    swapCells(b, width, 1, 1, 3);
    // cells 1..3 swapped: fg now the old bg, bg now the old fg
    for (const x of [1, 2, 3]) {
      const o = (width + x) * 4;
      expect([...b.fg.slice(o, o + 3)]).toEqual([0x5a, 0x5b, 0x5c]);
      expect([...b.bg.slice(o, o + 3)]).toEqual([0x0a, 0x0b, 0x0c]);
    }
    // cell 0 untouched (fg still the original)
    expect([...b.fg.slice(width * 4, width * 4 + 3)]).toEqual([0x0a, 0x0b, 0x0c]);
  });

  it("two swaps return a cell to normal (selection over the cursor)", () => {
    const width = 3;
    const b = arrays(width);
    writeCell(b, 0, 0x41, 0x111111, 0x222222, 0, ...D);
    swapCells(b, width, 0, 0, 0); // cursor
    swapCells(b, width, 0, 0, 0); // selection over it
    expect([...b.fg.slice(0, 3)]).toEqual([0x11, 0x11, 0x11]);
    expect([...b.bg.slice(0, 3)]).toEqual([0x22, 0x22, 0x22]);
  });

  it("clamps out-of-range endpoints to the row", () => {
    const width = 4;
    const b = arrays(width);
    for (let x = 0; x < width; x++) writeCell(b, x, 0x41, 0xaabbcc, 0x112233, 0, ...D);
    swapCells(b, width, 0, -5, 99);
    for (let x = 0; x < width; x++) {
      const o = x * 4;
      expect([...b.fg.slice(o, o + 3)]).toEqual([0x11, 0x22, 0x33]);
    }
  });
});

describe("paintBg", () => {
  it("sets the packed background across the clamped span, opaque", () => {
    const width = 4;
    const b = arrays(width * 2);
    paintBg(b, width, 1, 1, 2, 0x334455);
    expect([...b.bg.slice((width + 1) * 4, (width + 1) * 4 + 4)]).toEqual([0x33, 0x44, 0x55, 255]);
    expect([...b.bg.slice((width + 2) * 4, (width + 2) * 4 + 4)]).toEqual([0x33, 0x44, 0x55, 255]);
    // outside the span untouched
    expect([...b.bg.slice(width * 4, width * 4 + 4)]).toEqual([0, 0, 0, 0]);
  });
});
