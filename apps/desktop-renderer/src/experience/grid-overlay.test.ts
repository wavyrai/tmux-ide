import { describe, expect, it } from "vitest";

import { gridCellRect, gridOverlayBox } from "./grid-overlay.ts";
import { mirrorFitScale } from "../terminal/mirror-xterm-renderer.ts";

describe("gridOverlayBox", () => {
  it("fills the container when the grid was not scaled", () => {
    expect(gridOverlayBox({ width: 400, height: 300 }, { width: 400, height: 300 }, 1)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    });
  });

  /*
   * The rule-1 failure, in our clothing.
   *
   * A mirror pane letterboxes its render by a uniform scale, so an overlay
   * positioned at the CARD's inset covers the letterbox margins as well as the
   * grid — it is right at scale 1 and wrong by a growing margin at every other
   * scale. Bug this catches: a widget surface (or a status glyph, or a hover
   * highlight) that drifts off the terminal the moment the deck shrinks a node.
   */
  it("centres on the scaled grid, not on the container", () => {
    const natural = { width: 800, height: 600 };
    const container = { width: 400, height: 400 };
    const scale = mirrorFitScale(natural, container);
    expect(scale).toBe(0.5);
    const box = gridOverlayBox(natural, container, scale);
    expect(box).toEqual({ left: 0, top: 50, width: 400, height: 300 });
    // The letterbox margin belongs to neither the grid nor the overlay.
    expect(box.top + box.height).toBeLessThan(container.height);
  });

  it("never reports a box larger than the container it was fitted into", () => {
    const box = gridOverlayBox({ width: 2_000, height: 100 }, { width: 300, height: 300 }, 1);
    expect(box.width).toBe(300);
  });

  /*
   * Bug this catches: a container measured before layout returns zero, the
   * overlay collapses to nothing, and the feature is simply invisible with no
   * error anywhere. Covering slightly too much is recoverable; disappearing is
   * not.
   */
  it("falls back to the whole container rather than collapsing", () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gridOverlayBox({ width: 10, height: 10 }, { width: 50, height: 40 }, scale)).toEqual({
        left: 0,
        top: 0,
        width: 50,
        height: 40,
      });
    }
    expect(gridOverlayBox({ width: 0, height: 0 }, { width: 50, height: 40 }, 1)).toEqual({
      left: 0,
      top: 0,
      width: 50,
      height: 40,
    });
  });
});

describe("gridCellRect", () => {
  const metrics = { cellWidth: 8, cellHeight: 16 };

  it("maps a cell through the same scale the renderer committed", () => {
    const box = { left: 10, top: 20, width: 320, height: 240 };
    expect(gridCellRect({ column: 4, row: 2 }, metrics, box, 0.5)).toEqual({
      left: 10 + 4 * 8 * 0.5,
      top: 20 + 2 * 16 * 0.5,
      width: 4,
      height: 8,
    });
  });

  it("spans multiple cells without leaving the grid's own units", () => {
    const box = { left: 0, top: 0, width: 800, height: 600 };
    expect(gridCellRect({ column: 0, row: 0, columns: 10, rows: 3 }, metrics, box, 1)).toEqual({
      left: 0,
      top: 0,
      width: 80,
      height: 48,
    });
  });

  it("treats a zero or missing span as one cell", () => {
    const box = { left: 0, top: 0, width: 100, height: 100 };
    expect(gridCellRect({ column: 1, row: 1, columns: 0, rows: 0 }, metrics, box, 1)).toMatchObject(
      {
        width: 8,
        height: 16,
      },
    );
  });
});
