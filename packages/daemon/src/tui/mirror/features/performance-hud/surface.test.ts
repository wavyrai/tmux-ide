import { describe, expect, it } from "vitest";

import { performanceHudGeometry } from "./surface.tsx";

describe("performanceHudGeometry", () => {
  it.each([
    [120, 30, "full", 88, 4],
    [80, 24, "medium", 54, 6],
    [48, 20, "compact", 48, 8],
  ] as const)("projects the %s×%s viewport into %s mode", (width, height, mode, w, h) => {
    const geometry = performanceHudGeometry(width, height);
    expect(geometry).toMatchObject({ mode, width: w, height: h });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.left + geometry.width).toBeLessThanOrEqual(width);
    expect(geometry.top + geometry.height).toBeLessThanOrEqual(height);
  });

  it("clips safely inside a viewport smaller than its compact design", () => {
    expect(performanceHudGeometry(12, 4)).toEqual({
      mode: "compact",
      left: 0,
      top: 0,
      width: 12,
      height: 4,
    });
  });
});
