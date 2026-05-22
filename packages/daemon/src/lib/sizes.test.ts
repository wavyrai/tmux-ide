import { describe, it, expect } from "bun:test";
import { computeSizes, toSplitPercents } from "./sizes.ts";

describe("computeSizes", () => {
  it("distributes remaining space to items without size", () => {
    const result = computeSizes([{ size: "70%" }, {}]);
    expect(result).toEqual([70, 30]);
  });

  it("passes through all explicit sizes", () => {
    const result = computeSizes([{ size: "60%" }, { size: "40%" }]);
    expect(result).toEqual([60, 40]);
  });

  it("splits equally when no sizes specified", () => {
    const result = computeSizes([{}, {}, {}]);
    const expected = [100 / 3, 100 / 3, 100 / 3];
    expect(result).toEqual(expected);
  });

  it("handles 3 items with mixed sizes", () => {
    const result = computeSizes([{ size: "60%" }, { size: "25%" }, {}]);
    expect(result).toEqual([60, 25, 15]);
  });

  it("handles single item without size", () => {
    const result = computeSizes([{}]);
    expect(result).toEqual([100]);
  });

  it("handles single item with size", () => {
    const result = computeSizes([{ size: "50%" }]);
    expect(result).toEqual([50]);
  });

  it("handles empty array", () => {
    const result = computeSizes([]);
    expect(result).toEqual([]);
  });

  it("clamps remaining to zero when sizes exceed 100", () => {
    const result = computeSizes([{ size: "80%" }, { size: "30%" }, {}]);
    expect(result).toEqual([80, 30, 0]);
  });
});

describe("toSplitPercents", () => {
  it("converts 70/30 to [30]", () => {
    expect(toSplitPercents([70, 30])).toEqual([30]);
  });

  it("converts 60/25/15 correctly", () => {
    const result = toSplitPercents([60, 25, 15]);
    expect(result).toEqual([40, 38]);
  });

  it("converts equal 50/50 to [50]", () => {
    expect(toSplitPercents([50, 50])).toEqual([50]);
  });

  it("converts equal thirds", () => {
    const result = toSplitPercents([100 / 3, 100 / 3, 100 / 3]);
    expect(result).toEqual([67, 50]);
  });

  it("returns empty array for single item", () => {
    expect(toSplitPercents([100])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(toSplitPercents([])).toEqual([]);
  });
});
