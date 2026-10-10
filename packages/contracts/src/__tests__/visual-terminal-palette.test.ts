import { describe, expect, it } from "vitest";
import {
  createVisualTerminalPalette,
  XTERM_PALETTE,
  type VisualTerminalPaletteColors,
} from "../visual-terminal-palette.ts";
const colors: VisualTerminalPaletteColors = {
  foreground: 0xffffff,
  background: 0x000000,
  danger: 0x010204,
  success: 0x050607,
  warning: 0x08090a,
  link: 0x111213,
  accent: 0x141516,
  info: 0x171819,
  secondary: 0x202122,
  muted: 0x303132,
  bright: 0xeeeeee,
};
describe("renderer-neutral terminal palette", () => {
  it("retains canonical cube/grayscale and exact rounded ANSI brightening", () => {
    const palette = createVisualTerminalPalette(colors);
    expect(palette).toHaveLength(256);
    expect(palette.slice(0, 9)).toEqual([
      0, 0x010204, 0x050607, 0x08090a, 0x111213, 0x141516, 0x171819, 0x202122, 0x303132,
    ]);
    expect(palette[9]).toBe(0x343536);
    expect(palette[15]).toBe(0xeeeeee);
    expect(palette.slice(16)).toEqual(XTERM_PALETTE.slice(16));
    expect(Object.isFrozen(palette)).toBe(true);
  });
  it("applies partial host first16 entries including black without mutating callers or extended colors", () => {
    const host = [0, null, undefined, 0x123456, ...Array<number>(14).fill(0xabcdef)];
    const before = [...host];
    const baseline = createVisualTerminalPalette(colors);
    const actual = createVisualTerminalPalette(colors, host);
    expect(host).toEqual(before);
    expect(actual[0]).toBe(0);
    expect(actual[1]).toBe(baseline[1]);
    expect(actual[2]).toBe(baseline[2]);
    expect(actual[3]).toBe(0x123456);
    expect(actual.slice(16)).toEqual(baseline.slice(16));
  });
});
