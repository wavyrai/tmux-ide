import { describe, expect, it } from "vitest";
import { isDoubleClick, DOUBLE_CLICK_MS } from "./mouse.ts";

describe("isDoubleClick", () => {
  it("is never true without a prior click", () => {
    expect(isDoubleClick(null, 0, 1000)).toBe(false);
  });

  it("is true for the same row within the threshold", () => {
    expect(isDoubleClick({ index: 2, at: 1000 }, 2, 1300)).toBe(true);
    expect(isDoubleClick({ index: 2, at: 1000 }, 2, 1000 + DOUBLE_CLICK_MS)).toBe(true);
  });

  it("is false for a different row", () => {
    expect(isDoubleClick({ index: 2, at: 1000 }, 3, 1100)).toBe(false);
  });

  it("is false once the threshold has elapsed", () => {
    expect(isDoubleClick({ index: 2, at: 1000 }, 2, 1000 + DOUBLE_CLICK_MS + 1)).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(isDoubleClick({ index: 0, at: 0 }, 0, 100, 50)).toBe(false);
    expect(isDoubleClick({ index: 0, at: 0 }, 0, 40, 50)).toBe(true);
  });
});
