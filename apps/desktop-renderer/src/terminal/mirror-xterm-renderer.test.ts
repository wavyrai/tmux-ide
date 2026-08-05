/* @vitest-environment happy-dom */
import { describe, expect, it } from "vitest";

import { cursorPositionSequence, mirrorFitScale } from "./mirror-xterm-renderer.ts";

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
