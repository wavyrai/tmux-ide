import { describe, it, expect } from "vitest";
import { findMatches, visitOrder, stepMatch, offsetForMatch } from "./search-model.ts";

describe("findMatches", () => {
  it("finds case-insensitive substrings in buffer order", () => {
    const lines = ["line 1 MARKER here", "nothing", "another marker line", "MARKER"];
    const matches = findMatches(lines, "marker");
    expect(matches).toEqual([
      { line: 0, col: 7 },
      { line: 2, col: 8 },
      { line: 3, col: 0 },
    ]);
  });

  it("returns multiple non-overlapping matches on one line, left→right", () => {
    expect(findMatches(["abab ab"], "ab")).toEqual([
      { line: 0, col: 0 },
      { line: 0, col: 2 },
      { line: 0, col: 5 },
    ]);
  });

  it("does not count overlapping matches (advances past each hit)", () => {
    expect(findMatches(["aaaa"], "aa")).toEqual([
      { line: 0, col: 0 },
      { line: 0, col: 2 },
    ]);
  });

  it("returns no matches for an empty query", () => {
    expect(findMatches(["anything"], "")).toEqual([]);
  });
});

describe("visitOrder", () => {
  it("reverses to bottom-up so the nearest match is index 0 (shown 1/N)", () => {
    const top = [
      { line: 0, col: 0 },
      { line: 5, col: 2 },
      { line: 9, col: 1 },
    ];
    expect(visitOrder(top)).toEqual([
      { line: 9, col: 1 },
      { line: 5, col: 2 },
      { line: 0, col: 0 },
    ]);
  });
  it("does not mutate the input", () => {
    const top = [
      { line: 0, col: 0 },
      { line: 5, col: 2 },
    ];
    visitOrder(top);
    expect(top).toEqual([
      { line: 0, col: 0 },
      { line: 5, col: 2 },
    ]);
  });
  it("handles the empty case", () => {
    expect(visitOrder([])).toEqual([]);
  });
});

describe("stepMatch", () => {
  it("cycles forward and backward with wraparound", () => {
    expect(stepMatch(0, 1, 3)).toBe(1);
    expect(stepMatch(2, 1, 3)).toBe(0);
    expect(stepMatch(0, -1, 3)).toBe(2);
    expect(stepMatch(1, -1, 3)).toBe(0);
  });

  it("stays -1 when there are no matches", () => {
    expect(stepMatch(-1, 1, 0)).toBe(-1);
  });
});

describe("offsetForMatch", () => {
  it("centers the match line in the viewport, clamped to [0, depth]", () => {
    // depth 100, viewH 20 → target row 10; line 50 → offset 100+10-50 = 60.
    expect(offsetForMatch(50, 100, 20)).toBe(60);
  });

  it("clamps to 0 when the match sits at/below the live viewport", () => {
    // line near the live bottom would need a negative offset → clamp to live.
    expect(offsetForMatch(115, 100, 20)).toBe(0);
  });

  it("clamps to depth when the match is at the very top of scrollback", () => {
    expect(offsetForMatch(0, 100, 20)).toBe(100);
  });

  it("puts a live-view match at the target row without scrolling past live", () => {
    // depth 100, target 10, line = depth + target = 110 → offset 0 (already live).
    expect(offsetForMatch(110, 100, 20)).toBe(0);
  });
});
