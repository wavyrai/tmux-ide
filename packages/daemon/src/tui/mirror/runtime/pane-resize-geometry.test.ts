import { describe, expect, it } from "vitest";

import { nativePaneResizeCells } from "./pane-resize-geometry.ts";

describe("nativePaneResizeCells", () => {
  it("converts visible-layout status rows while columns and off layouts stay native", () => {
    expect(nativePaneResizeCells({ width: 132, height: 41 }, "cols", "top")).toBe(132);
    expect(nativePaneResizeCells({ width: 132, height: 41 }, "rows", "top")).toBe(40);
    expect(nativePaneResizeCells({ width: 65, height: 20 }, "rows", "bottom")).toBe(19);
    expect(nativePaneResizeCells({ width: 65, height: 20 }, "rows", "off")).toBe(20);
  });

  it("fails closed on missing native body rows or oversized geometry", () => {
    expect(nativePaneResizeCells({ width: 80, height: 1 }, "rows", "top")).toBeNull();
    expect(nativePaneResizeCells({ width: 4_097, height: 40 }, "cols", "off")).toBeNull();
    expect(
      nativePaneResizeCells({ width: 65, height: 41 }, "rows", "malformed" as "top"),
    ).toBeNull();
  });
});
