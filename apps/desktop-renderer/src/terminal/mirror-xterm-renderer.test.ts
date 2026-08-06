/* @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";

import {
  cursorPositionSequence,
  mirrorFitScale,
  mirrorFitTransform,
} from "./mirror-xterm-renderer.ts";

describe("mirror cursor positioning", () => {
  it("converts 0-based wire coordinates to a 1-based CUP", () => {
    expect(cursorPositionSequence(0, 0)).toBe("\u001b[1;1H");
    expect(cursorPositionSequence(7, 2)).toBe("\u001b[3;8H");
  });
});

describe("mirror letterbox fit", () => {
  it("shrinks a grid wider and taller than its card by the tighter axis", () => {
    // The measured defect: an 824x476 grid inside a 480x282 card body.
    expect(mirrorFitScale({ width: 824, height: 476 }, { width: 480, height: 282 })).toBeCloseTo(
      480 / 824,
      5,
    );
    expect(mirrorFitScale({ width: 500, height: 476 }, { width: 480, height: 282 })).toBeCloseTo(
      282 / 476,
      5,
    );
  });

  it("never magnifies a grid smaller than its card", () => {
    expect(mirrorFitScale({ width: 200, height: 100 }, { width: 480, height: 282 })).toBe(1);
  });

  it("leaves the render untouched when either box has not been laid out", () => {
    expect(mirrorFitScale({ width: 0, height: 0 }, { width: 480, height: 282 })).toBe(1);
    expect(mirrorFitScale({ width: 824, height: 476 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("mirror letterbox placement", () => {
  /*
   * The regression this file exists for (m50.2).
   *
   * The fit used to be `scale()` about `center center`, which is only the same
   * placement when the emulator's element already fits its card. Once tmux's
   * window grew past it — the ordinary case now that the app owns the window
   * geometry — the element laid out at its GRID size, and centring on THAT box
   * pushed the render clean out of the card. The measured case is below: the
   * mirror was rendered 180px beneath the card that contains it, off the bottom
   * of a 900px window, where xterm stops painting altogether.
   */
  it("lands the scaled grid inside the card, not around the overflowing element", () => {
    const natural = { width: 1134, height: 503 };
    const container = { width: 318, height: 176 };
    const fit = mirrorFitTransform(natural, container);

    expect(fit.scale).toBeCloseTo(container.width / natural.width, 5);
    const width = natural.width * fit.scale;
    const height = natural.height * fit.scale;
    // Top-left origin: the placed box IS translate → translate+size.
    expect(fit.translateX).toBeCloseTo((container.width - width) / 2, 5);
    expect(fit.translateY).toBeCloseTo((container.height - height) / 2, 5);
    expect(fit.translateX).toBeGreaterThanOrEqual(0);
    expect(fit.translateY).toBeGreaterThanOrEqual(0);
    expect(fit.translateX + width).toBeLessThanOrEqual(container.width + 0.001);
    expect(fit.translateY + height).toBeLessThanOrEqual(container.height + 0.001);
  });

  it("centres a grid smaller than its card at 1:1", () => {
    const fit = mirrorFitTransform({ width: 200, height: 100 }, { width: 480, height: 282 });
    expect(fit.scale).toBe(1);
    expect(fit.translateX).toBe(140);
    expect(fit.translateY).toBe(91);
  });

  it("discounts the grid layer's own offset inside the transformed element", () => {
    const flush = mirrorFitTransform({ width: 400, height: 200 }, { width: 200, height: 200 });
    const inset = mirrorFitTransform(
      { width: 400, height: 200 },
      { width: 200, height: 200 },
      { left: 0, top: 20 },
    );
    expect(inset.scale).toBe(flush.scale);
    expect(inset.translateY).toBeCloseTo(flush.translateY - 20 * flush.scale, 5);
  });

  it("places nothing at an offset when a box has not been laid out", () => {
    expect(mirrorFitTransform({ width: 0, height: 0 }, { width: 0, height: 0 })).toEqual({
      scale: 1,
      translateX: 0,
      translateY: 0,
    });
  });
});
