import { describe, expect, it } from "vitest";

import {
  TERMINAL_CONFORMANCE_FIXTURES,
  XTERM_PALETTE,
  XTERM_PALETTE_HEX,
} from "./terminal-conformance.ts";

describe("terminal conformance corpus", () => {
  it("defines one complete, byte-identical xterm palette for every renderer", () => {
    expect(XTERM_PALETTE).toHaveLength(256);
    expect(XTERM_PALETTE_HEX).toHaveLength(256);
    expect(XTERM_PALETTE[0]).toBe(0x000000);
    expect(XTERM_PALETTE[16]).toBe(0x000000);
    expect(XTERM_PALETTE[231]).toBe(0xffffff);
    expect(XTERM_PALETTE[232]).toBe(0x080808);
    expect(XTERM_PALETTE[255]).toBe(0xeeeeee);
    for (let index = 0; index < XTERM_PALETTE.length; index += 1) {
      expect(XTERM_PALETTE_HEX[index]).toBe(
        `#${XTERM_PALETTE[index]!.toString(16).padStart(6, "0")}`,
      );
    }
  });

  it("keeps fixture ids and asserted cell coordinates unique", () => {
    const ids = TERMINAL_CONFORMANCE_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fixture of TERMINAL_CONFORMANCE_FIXTURES) {
      const cells = fixture.cells.map((cell) => `${cell.row}:${cell.column}`);
      expect(new Set(cells).size, fixture.id).toBe(cells.length);
      expect(fixture.writes.join("").length, fixture.id).toBeGreaterThan(0);
      for (const cell of fixture.cells) {
        expect(cell.row).toBeLessThan(fixture.rows);
        expect(cell.column).toBeLessThan(fixture.cols);
      }
    }
  });
});
