/**
 * Compact wire coverage for `DiffStatLabel` + `hasNonZeroStat`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { DiffStatLabel, hasNonZeroStat } from "../src/components/DiffStatLabel";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("hasNonZeroStat", () => {
  it("returns false when both additions and deletions are zero", () => {
    expect(hasNonZeroStat({ additions: 0, deletions: 0 })).toBe(false);
  });

  it("returns true when additions or deletions are non-zero", () => {
    expect(hasNonZeroStat({ additions: 1, deletions: 0 })).toBe(true);
    expect(hasNonZeroStat({ additions: 0, deletions: 1 })).toBe(true);
  });
});

describe("DiffStatLabel", () => {
  it("renders +A / −D with the numeric values", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <DiffStatLabel additions={4} deletions={2} />, container);
    const root = container.querySelector("[data-testid='diff-stat-label']");
    expect(root?.getAttribute("data-additions")).toBe("4");
    expect(root?.getAttribute("data-deletions")).toBe("2");
    expect(root?.textContent).toContain("+4");
    expect(root?.textContent).toContain("−2");
  });

  it("renders the parenthesized variant when showParentheses=true", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(() => <DiffStatLabel additions={1} deletions={1} showParentheses />, container);
    const text = container.querySelector("[data-testid='diff-stat-label']")?.textContent ?? "";
    expect(text.startsWith("(")).toBe(true);
    expect(text.endsWith(")")).toBe(true);
  });
});
