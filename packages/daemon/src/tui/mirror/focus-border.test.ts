/** Unit tests for the focus-border gutter-strip geometry (M22.7). */
import { describe, expect, it } from "vitest";
import { focusStrips } from "./focus-border.ts";

describe("focusStrips", () => {
  it("renders nothing for a single-pane window", () => {
    expect(focusStrips({ left: 0, top: 0, width: 100, height: 40 }, 100, 40, 1)).toEqual([]);
  });

  it("renders nothing for a degenerate rect", () => {
    expect(focusStrips({ left: 0, top: 0, width: 0, height: 40 }, 100, 40, 2)).toEqual([]);
  });

  it("a full-canvas pane in a multi-pane window has no gutters to paint", () => {
    // Zoomed: one pane covers the canvas even though the window has more.
    expect(focusStrips({ left: 0, top: 0, width: 100, height: 40 }, 100, 40, 3)).toEqual([]);
  });

  it("left pane of a vertical split paints only its right gutter", () => {
    const strips = focusStrips({ left: 0, top: 0, width: 49, height: 40 }, 100, 40, 2);
    expect(strips).toEqual([{ left: 49, top: 0, width: 1, height: 40 }]);
  });

  it("right pane of a vertical split paints only its left gutter", () => {
    const strips = focusStrips({ left: 50, top: 0, width: 50, height: 40 }, 100, 40, 2);
    expect(strips).toEqual([{ left: 49, top: 0, width: 1, height: 40 }]);
  });

  it("an interior pane paints all four sides with filled corners", () => {
    const strips = focusStrips({ left: 10, top: 5, width: 20, height: 10 }, 100, 40, 4);
    expect(strips).toContainEqual({ left: 9, top: 4, width: 22, height: 1 }); // top, corner-extended
    expect(strips).toContainEqual({ left: 9, top: 15, width: 22, height: 1 }); // bottom
    expect(strips).toContainEqual({ left: 9, top: 5, width: 1, height: 10 }); // left
    expect(strips).toContainEqual({ left: 30, top: 5, width: 1, height: 10 }); // right
    expect(strips).toHaveLength(4);
  });

  it("horizontal strips do not extend past a flush canvas edge", () => {
    // Top-left pane of a 2x2 grid: gutters only right + bottom.
    const strips = focusStrips({ left: 0, top: 0, width: 49, height: 19 }, 100, 40, 4);
    expect(strips).toContainEqual({ left: 0, top: 19, width: 50, height: 1 }); // bottom reaches right gutter only
    expect(strips).toContainEqual({ left: 49, top: 0, width: 1, height: 19 }); // right
    expect(strips).toHaveLength(2);
  });
});
