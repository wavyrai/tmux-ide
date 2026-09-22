import { expect, it } from "vitest";
import {
  correctContrastForeground,
  fastContrastForeground,
  packedContrastRatio,
  createContrastPairCache,
  createAutomaticContrastPass,
} from "./automatic-contrast.ts";

it("retains passing RGB exactly and meets quantized 4.5 for adversarial and seeded colors", () => {
  let seed = 1949;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) & 0xffffff;
  for (let i = 0; i < 2000; i++) {
    const fg = i < 256 ? i * 0x10101 : next();
    const bg = i < 256 ? 0x777777 : next();
    const result = correctContrastForeground(fg, bg);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xffffff);
    expect(packedContrastRatio(result, bg)).toBeGreaterThanOrEqual(4.5);
    if (packedContrastRatio(fg, bg) >= 4.5) expect(result).toBe(fg);
  }
});
it("bounds pair history through churn, including cached black", () => {
  const cache = createContrastPairCache(8);
  for (let i = 0; i < 100; i++) {
    cache.correct(i, 0xffffff);
    expect(cache.size).toBeLessThanOrEqual(8);
  }
  expect(cache.correct(0, 0xffffff)).toBe(0);
  expect(cache.correct(0, 0xffffff)).toBe(0);
});
it("preserves hidden/art/glyphs and effective backgrounds; materializes DIM and inverse", () => {
  const char = Uint32Array.from([65, 66, 67, 32, 0x2588, 0x2801, 0x80000001, 0x40000001]);
  const attributes = Uint32Array.from([2, 32, 64, 0, 0, 0, 0, 0]);
  const fg = new Uint16Array(char.length * 4),
    bg = fg.slice();
  for (let i = 0; i < char.length; i++) {
    fg.set([120, 120, 120, 255], i * 4);
    bg.set([128, 128, 128, 255], i * 4);
  }
  const before = {
    char: char.slice(),
    fg: fg.slice(),
    bg: bg.slice(),
    attributes: attributes.slice(),
  };
  createAutomaticContrastPass()({ buffers: { char, fg, bg, attributes } });
  expect(char).toEqual(before.char);
  expect(attributes).toEqual(Uint32Array.from([0, 32, 64, 0, 0, 0, 0, 0]));
  expect(bg.slice(0, 4)).toEqual(before.bg.slice(0, 4));
  expect(fg.slice(4, 8)).toEqual(before.fg.slice(4, 8));
  expect(fg.slice(8, 24)).toEqual(before.fg.slice(8, 24));
  expect(bg.slice(8)).toEqual(before.bg.slice(8));
  expect(fg.slice(0, 4)).not.toEqual(before.fg.slice(0, 4));
  expect(bg.slice(4, 8)).not.toEqual(before.bg.slice(4, 8));
});
it("resolves corrected metadata to RGB and leaves unresolved alpha exact", () => {
  const fg = Uint16Array.from([0x1178, 0x0178, 120, 255, 120, 120, 120, 127]);
  const bg = Uint16Array.from([128, 128, 128, 255, 128, 128, 128, 255]);
  const before = fg.slice(4);
  createAutomaticContrastPass()({
    buffers: { char: Uint32Array.from([65, 66]), attributes: new Uint32Array(2), fg, bg },
  });
  expect(Array.from(fg.slice(0, 4)).every((n) => n <= 255)).toBe(true);
  expect(
    packedContrastRatio((fg[0]! << 16) | (fg[1]! << 8) | fg[2]!, 0x808080),
  ).toBeGreaterThanOrEqual(4.5);
  expect(fg.slice(4)).toEqual(before);
});

it("bounds frame search work with a verified quantized fallback under color churn", () => {
  const cache = createContrastPairCache();
  cache.beginFrame();
  for (let i = 0; i < 6000; i++) {
    const fg = (i * 1949) & 0xffffff,
      bg = (i * 7949) & 0xffffff;
    const result = cache.correct(fg, bg);
    expect(packedContrastRatio(result, bg)).toBeGreaterThanOrEqual(4.5);
    expect(packedContrastRatio(fastContrastForeground(fg, bg), bg)).toBeGreaterThanOrEqual(4.5);
    if (packedContrastRatio(fg, bg) >= 4.5) expect(result).toBe(fg);
    expect(cache.size).toBeLessThanOrEqual(4096);
  }
});
