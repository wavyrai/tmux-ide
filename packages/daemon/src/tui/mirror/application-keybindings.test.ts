import { describe, expect, it } from "vitest";

import { APPLICATION_KEYBINDING_ROWS, PALETTE_KEYCAPS } from "./application-keybindings.ts";

describe("application keybinding catalog", () => {
  it("is the dependency-free source for palette keycaps and viewer rows", () => {
    expect(PALETTE_KEYCAPS).toEqual({
      "surface:home": "F1",
      "surface:terminals": "F2",
      "surface:files": "F3",
      "surface:changes": "F4",
      "surface:missions": "F6",
      "surface:activity": "F9",
      save: "^s",
      quit: "^q",
    });
    for (const [action, keycap] of Object.entries(PALETTE_KEYCAPS)) {
      expect(
        APPLICATION_KEYBINDING_ROWS.some(
          (row) => row.paletteAction === action && row.keycap === keycap,
        ),
      ).toBe(true);
    }
  });

  it("does not expose mutable catalog objects", () => {
    expect(Object.isFrozen(APPLICATION_KEYBINDING_ROWS)).toBe(true);
    expect(Object.isFrozen(PALETTE_KEYCAPS)).toBe(true);
  });
});
