import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSizes, toSplitPercents } from "./sizes.ts";

describe("computeSizes", () => {
  it("distributes remaining space to items without size", () => {
    const result = computeSizes([{ size: "70%" }, {}]);
    assert.deepStrictEqual(result, [70, 30]);
  });

  it("passes through all explicit sizes", () => {
    const result = computeSizes([{ size: "60%" }, { size: "40%" }]);
    assert.deepStrictEqual(result, [60, 40]);
  });

  it("splits equally when no sizes specified", () => {
    const result = computeSizes([{}, {}, {}]);
    const expected = [100 / 3, 100 / 3, 100 / 3];
    assert.deepStrictEqual(result, expected);
  });

  it("handles 3 items with mixed sizes", () => {
    const result = computeSizes([{ size: "60%" }, { size: "25%" }, {}]);
    assert.deepStrictEqual(result, [60, 25, 15]);
  });

  it("handles single item without size", () => {
    const result = computeSizes([{}]);
    assert.deepStrictEqual(result, [100]);
  });

  it("handles single item with size", () => {
    const result = computeSizes([{ size: "50%" }]);
    assert.deepStrictEqual(result, [50]);
  });

  it("handles empty array", () => {
    const result = computeSizes([]);
    assert.deepStrictEqual(result, []);
  });

  it("clamps remaining to zero when sizes exceed 100", () => {
    const result = computeSizes([{ size: "80%" }, { size: "30%" }, {}]);
    assert.deepStrictEqual(result, [80, 30, 0]);
  });
});

describe("toSplitPercents", () => {
  it("converts 70/30 to [30]", () => {
    assert.deepStrictEqual(toSplitPercents([70, 30]), [30]);
  });

  it("converts 60/25/15 correctly", () => {
    const result = toSplitPercents([60, 25, 15]);
    assert.deepStrictEqual(result, [40, 38]);
  });

  it("converts equal 50/50 to [50]", () => {
    assert.deepStrictEqual(toSplitPercents([50, 50]), [50]);
  });

  it("converts equal thirds", () => {
    const result = toSplitPercents([100 / 3, 100 / 3, 100 / 3]);
    assert.deepStrictEqual(result, [67, 50]);
  });

  it("returns empty array for single item", () => {
    assert.deepStrictEqual(toSplitPercents([100]), []);
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(toSplitPercents([]), []);
  });
});
