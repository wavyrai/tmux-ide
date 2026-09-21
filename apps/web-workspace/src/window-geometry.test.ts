import { describe, it, expect } from "vitest";
import { fitSessionCells, fitWindowCells, projectWindowGeometry } from "./window-geometry";
const layout = {
  semanticWindowId: "window.a",
  windowName: "a",
  currentWindow: true,
  cols: 81,
  rows: 41,
  zoomed: false,
  paneBorderStatus: "off" as const,
  panes: [
    { pane: "pane.left", left: 0, top: 0, width: 40, height: 41, active: true },
    { pane: "pane.top", left: 41, top: 0, width: 40, height: 20, active: false },
    { pane: "pane.bottom", left: 41, top: 21, width: 40, height: 20, active: false },
  ],
};
describe("tmux window header geometry", () => {
  it("keeps a spanning pane and a stacked column inside the same bottom edge", () => {
    const projected = projectWindowGeometry(layout, { width: 8, height: 16 }, 26);
    expect(projected.height).toBe(41 * 16 + 52);
    for (const p of projected.panes) {
      expect(p.y + p.pixelHeight).toBeLessThanOrEqual(projected.height);
      expect(p.x + p.pixelWidth).toBeLessThanOrEqual(projected.width);
    }
    const [left, top, bottom] = projected.panes;
    expect(left!.pixelHeight).toBe(projected.height);
    expect(bottom!.y + bottom!.pixelHeight).toBe(projected.height);
    expect(top!.y + top!.pixelHeight).toBeLessThan(bottom!.y);
  });
  it("does not reserve hidden pane header rows while zoomed", () => {
    const zoomed = {
      ...layout,
      zoomed: true,
      panes: [{ ...layout.panes[0]!, width: 81, height: 41 }, ...layout.panes.slice(1)],
    };
    const projected = projectWindowGeometry(zoomed, { width: 7.5, height: 15 }, 26);
    expect(projected.panes).toHaveLength(1);
    expect(projected.height).toBe(41 * 15 + 26);
  });
});

describe("window fit measurement", () => {
  it("subtracts header bands exactly once from the measured content body", () => {
    expect(
      fitWindowCells(layout, { width: 810, height: 462 }, { width: 10, height: 10 }, 26),
    ).toEqual({ cols: 81, rows: 41 });
    expect(
      fitWindowCells(
        { ...layout, zoomed: true },
        { width: 810, height: 462 },
        { width: 10, height: 10 },
        26,
      ),
    ).toEqual({ cols: 81, rows: 43 });
  });
  it("floors fractional cell dimensions and rejects hidden/invalid measurements", () => {
    expect(
      fitWindowCells(layout, { width: 811, height: 669 }, { width: 7.5, height: 15 }, 26),
    ).toEqual({ cols: 108, rows: 41 });
    for (const width of [0, NaN, Infinity, -1])
      expect(
        fitWindowCells(layout, { width, height: 600 }, { width: 8, height: 16 }, 26),
      ).toBeNull();
    expect(
      fitWindowCells(layout, { width: 800, height: 60 }, { width: 8, height: 16 }, 26),
    ).toBeNull();
  });
});

describe("session fitting", () => {
  it("reserves the largest header requirement even when a simpler window is selected", () => {
    const simple = { ...layout, panes: [layout.panes[0]!], zoomed: true };
    expect(
      fitSessionCells([simple, layout], { width: 810, height: 462 }, { width: 10, height: 10 }, 26),
    ).toEqual({ cols: 81, rows: 41 });
    expect(
      fitSessionCells([layout, simple], { width: 810, height: 462 }, { width: 10, height: 10 }, 26),
    ).toEqual({ cols: 81, rows: 41 });
  });
  it("does not size an empty or hidden session", () => {
    expect(
      fitSessionCells([], { width: 810, height: 462 }, { width: 10, height: 10 }, 26),
    ).toBeNull();
    expect(
      fitSessionCells([layout], { width: 810, height: 0 }, { width: 10, height: 10 }, 26),
    ).toBeNull();
  });
});

it.each(["top", "bottom"] as const)(
  "replaces the native %s status row with web headers",
  (paneBorderStatus) => {
    const bordered = { ...layout, paneBorderStatus };
    const projected = projectWindowGeometry(bordered, { width: 8, height: 16 }, 26);
    expect(projected.height).toBe(40 * 16 + 52);
    for (const pane of projected.panes)
      expect(pane.y + pane.pixelHeight).toBeLessThanOrEqual(projected.height);
    expect(projected.panes[0]!.contentRows).toBe(40);
    expect(projected.panes[paneBorderStatus === "top" ? 1 : 2]!.contentRows).toBe(19);
    expect(
      fitWindowCells(bordered, { width: 648, height: 692 }, { width: 8, height: 16 }, 26),
    ).toEqual({ cols: 81, rows: 41 });
  },
);
