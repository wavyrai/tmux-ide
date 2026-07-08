import { describe, it, expect } from "vitest";
import {
  effectiveWindowSize,
  detectSizeMismatch,
  letterboxOffset,
  formatSizeHint,
  type Rect,
} from "./size-truth.ts";

const rect = (left: number, top: number, width: number, height: number): Rect => ({
  left,
  top,
  width,
  height,
});

describe("effectiveWindowSize", () => {
  it("is null with no panes", () => {
    expect(effectiveWindowSize([])).toBeNull();
  });

  it("is the pane's own size for a single full-window pane", () => {
    expect(effectiveWindowSize([rect(0, 0, 120, 39)])).toEqual({ cols: 120, rows: 39 });
  });

  it("takes the bounding box of a horizontal split (border between panes)", () => {
    // 100-col window: pane A [0,49), border col 49, pane B [50,100).
    const panes = [rect(0, 0, 49, 30), rect(50, 0, 50, 30)];
    expect(effectiveWindowSize(panes)).toEqual({ cols: 100, rows: 30 });
  });

  it("takes the bounding box of a vertical split (border row between panes)", () => {
    const panes = [rect(0, 0, 80, 19), rect(0, 20, 80, 20)];
    expect(effectiveWindowSize(panes)).toEqual({ cols: 80, rows: 40 });
  });
});

describe("detectSizeMismatch", () => {
  it("is null when the window matches what we pinned", () => {
    expect(detectSizeMismatch({ cols: 200, rows: 55 }, { cols: 200, rows: 55 })).toBeNull();
  });

  it("reports the actual window when a smaller terminal shrank it", () => {
    expect(detectSizeMismatch({ cols: 200, rows: 55 }, { cols: 120, rows: 39 })).toEqual({
      cols: 120,
      rows: 39,
    });
  });

  it("reports a mismatch on a single differing axis", () => {
    expect(detectSizeMismatch({ cols: 200, rows: 55 }, { cols: 200, rows: 39 })).toEqual({
      cols: 200,
      rows: 39,
    });
  });

  it("reports a window LARGER than the canvas too (we would clip)", () => {
    expect(detectSizeMismatch({ cols: 120, rows: 40 }, { cols: 200, rows: 55 })).toEqual({
      cols: 200,
      rows: 55,
    });
  });
});

describe("letterboxOffset", () => {
  it("centers a smaller window inside the canvas, floored", () => {
    // (200-120)/2 = 40 ; (55-39)/2 = 8
    expect(letterboxOffset({ cols: 200, rows: 55 }, { cols: 120, rows: 39 })).toEqual({
      x: 40,
      y: 8,
    });
  });

  it("floors an odd gap so cells stay aligned", () => {
    // (201-120)/2 = 40.5 -> 40
    expect(letterboxOffset({ cols: 201, rows: 56 }, { cols: 120, rows: 39 })).toEqual({
      x: 40,
      y: 8,
    });
  });

  it("is zero when sizes agree", () => {
    expect(letterboxOffset({ cols: 120, rows: 40 }, { cols: 120, rows: 40 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("never goes negative when the window is larger than the canvas", () => {
    expect(letterboxOffset({ cols: 120, rows: 40 }, { cols: 200, rows: 55 })).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("formatSizeHint", () => {
  it("is the quiet plain-language answer in cols×rows", () => {
    expect(formatSizeHint({ cols: 120, rows: 39 })).toBe(
      "window sized by another terminal — 120×39",
    );
  });
});
