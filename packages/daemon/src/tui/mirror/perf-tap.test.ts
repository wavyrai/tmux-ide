import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./perf-tap.ts";

describe("percentile", () => {
  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });
  it("returns the sole value for a singleton", () => {
    expect(percentile([7], 95)).toBe(7);
  });
  it("interpolates between ranks", () => {
    const sorted = [0, 10, 20, 30, 40];
    expect(percentile(sorted, 0)).toBe(0);
    expect(percentile(sorted, 50)).toBe(20);
    expect(percentile(sorted, 100)).toBe(40);
    expect(percentile(sorted, 25)).toBe(10);
  });
  it("clamps out-of-range p", () => {
    expect(percentile([1, 2, 3], -5)).toBe(1);
    expect(percentile([1, 2, 3], 500)).toBe(3);
  });
});

describe("summarize", () => {
  it("summarizes a distribution regardless of input order", () => {
    const s = summarize([30, 10, 20, 40, 0]);
    expect(s).toEqual({ count: 5, p50: 20, p95: 38, min: 0, max: 40, mean: 20 });
  });
  it("handles an empty input", () => {
    expect(summarize([])).toEqual({ count: 0, p50: 0, p95: 0, min: 0, max: 0, mean: 0 });
  });
});
