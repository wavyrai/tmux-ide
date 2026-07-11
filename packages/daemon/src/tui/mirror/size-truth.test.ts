import { describe, it, expect } from "vitest";
import {
  effectiveWindowSize,
  detectSizeMismatch,
  detectSizeMismatchWithRepin,
  REPIN_GRACE_MS,
  REPIN_STALE_GRACE_MS,
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

describe("detectSizeMismatchWithRepin", () => {
  const prev = { cols: 120, rows: 40 };
  const pinned = { cols: 160, rows: 50 }; // the NEW pin (a grow)
  const repin = { prev, at: 1000 };

  it("passes mismatches through with no re-pin in flight", () => {
    expect(detectSizeMismatchWithRepin(pinned, prev, null, 99_999)).toEqual(prev);
  });

  it("is null when sizes agree (and regardless of any re-pin)", () => {
    expect(detectSizeMismatchWithRepin(pinned, pinned, repin, 1001)).toBeNull();
  });

  it("suppresses ANY mismatch within the re-pin grace (the grow flash)", () => {
    expect(detectSizeMismatchWithRepin(pinned, prev, repin, 1000 + REPIN_GRACE_MS - 1)).toBeNull();
    // Even a size that is neither pin (mid-transition on a storm).
    expect(detectSizeMismatchWithRepin(pinned, { cols: 130, rows: 44 }, repin, 1100)).toBeNull();
  });

  it("keeps suppressing the exact pre-repin size up to the stale grace", () => {
    expect(
      detectSizeMismatchWithRepin(pinned, prev, repin, 1000 + REPIN_STALE_GRACE_MS - 1),
    ).toBeNull();
    expect(detectSizeMismatchWithRepin(pinned, prev, repin, 1000 + REPIN_STALE_GRACE_MS)).toEqual(
      prev,
    );
  });

  it("surfaces a DIFFERENT size once the short grace passed (a real co-attach)", () => {
    const other = { cols: 100, rows: 30 };
    expect(detectSizeMismatchWithRepin(pinned, other, repin, 1000 + REPIN_GRACE_MS)).toEqual(other);
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
