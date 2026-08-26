import { describe, expect, it } from "vitest";

import {
  applicationPaletteKeyboardDisposition,
  applicationPaletteOwnsInput,
} from "./application-palette-input.ts";

describe("application-root-v2 palette input ownership", () => {
  it("blocks unhandled keys and paste while the palette owns input", () => {
    expect(applicationPaletteKeyboardDisposition({ name: "a" }, true, 0)).toEqual({
      kind: "block",
    });
    expect(applicationPaletteKeyboardDisposition({ name: "enter" }, true, 1)).toEqual({
      kind: "activate",
      command: "terminals",
    });
    expect(applicationPaletteKeyboardDisposition({ name: "a" }, false, 0)).toBeNull();
    expect(applicationPaletteOwnsInput(true)).toBe(true);
    expect(applicationPaletteOwnsInput(false)).toBe(false);
  });
});
