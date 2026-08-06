import { describe, expect, it } from "vitest";

import {
  layoutBorders,
  layoutTiles,
  resolveBorderDrag,
  windowTabKey,
  windowTabs,
  type LayoutFrame,
  type LayoutFramePane,
} from "./workspace-layout-tiles.ts";

/**
 * The frames these tests are written against are real tmux geometry, not
 * invented numbers: a 200x50 window split vertically gives panes of width 99
 * and 100 separated by ONE border cell at column 99, and tmux reports exactly
 * that. The one-cell gap is the whole reason the border handles cover no output.
 */
function frame(overrides: Partial<LayoutFrame> = {}): LayoutFrame {
  return {
    semanticWindowId: "win.one",
    windowName: "editor",
    currentWindow: true,
    cols: 200,
    rows: 50,
    zoomed: false,
    panes: [pane({ pane: "pane.a", width: 200, height: 50, active: true })],
    ...overrides,
  };
}

function pane(overrides: Partial<LayoutFramePane> & { pane: string | null }): LayoutFramePane {
  return { left: 0, top: 0, width: 200, height: 50, active: false, ...overrides };
}

const SPLIT_VERTICAL = frame({
  panes: [
    pane({ pane: "pane.a", left: 0, top: 0, width: 99, height: 50, active: true }),
    pane({ pane: "pane.b", left: 100, top: 0, width: 100, height: 50 }),
  ],
});

const SPLIT_HORIZONTAL = frame({
  panes: [
    pane({ pane: "pane.a", left: 0, top: 0, width: 200, height: 24, active: true }),
    pane({ pane: "pane.b", left: 0, top: 25, width: 200, height: 25 }),
  ],
});

describe("window tabs", () => {
  it("labels every window from its live name and marks tmux's current one", () => {
    const tabs = windowTabs([
      frame({ semanticWindowId: "win.one", windowName: "editor", currentWindow: false }),
      frame({ semanticWindowId: "win.two", windowName: "shell", currentWindow: true }),
    ]);
    expect(tabs.map((tab) => [tab.label, tab.active])).toEqual([
      ["editor", false],
      ["shell", true],
    ]);
  });

  it("falls back to a positional label rather than showing a blank tab", () => {
    // Bug this catches: an unnamed window renders as a tab with nothing in it,
    // which is indistinguishable from a rendering fault.
    const [first, second] = windowTabs([frame({ windowName: null }), frame({ windowName: "   " })]);
    expect(first!.label).toBe("Window 1");
    expect(second!.label).toBe("Window 2");
  });

  it("addresses a window by its ACTIVE pane so a tab click lands where tmux is", () => {
    const [tab] = windowTabs([SPLIT_VERTICAL]);
    expect(tab!.addressPane).toBe("pane.a");
    expect(tab!.paneCount).toBe(2);
  });

  it("carries no address for a window whose panes are all unjoined", () => {
    // Bug this catches: the tab dispatches a verb against a null identity and
    // the click reads as broken instead of as not-yet-addressable.
    const [tab] = windowTabs([frame({ panes: [pane({ pane: null })] })]);
    expect(tab!.addressPane).toBeNull();
  });

  it("keys an unstamped window by something stable rather than by nothing", () => {
    expect(windowTabKey(frame({ semanticWindowId: null }))).toBe("unstamped:pane.a");
    expect(windowTabKey(frame())).toBe("win.one");
  });
});

describe("layout tiles", () => {
  it("places panes at exactly the frame's proportions, each claiming its border cell", () => {
    const tiles = layoutTiles(SPLIT_VERTICAL);
    expect(tiles.map((tile) => tile.pane)).toEqual(["pane.a", "pane.b"]);
    // Half a cell past the pane's own 99 columns; the outer edges clamp to the
    // grid, so the left edge is 0 rather than -0.5 cells and the right edge 1.
    expect(tiles[0]!.rect).toEqual({ left: 0, top: 0, width: 99.5 / 200, height: 1 });
    expect(tiles[1]!.rect).toEqual({
      left: 99.5 / 200,
      top: 0,
      width: 1 - 99.5 / 200,
      height: 1,
    });
  });

  it("makes adjacent tiles MEET, so the grid reads as one connected frame", () => {
    /*
     * Bug this catches — the whole of gap 4: tiles drawn at the panes' own cell
     * rects sit one cell apart, because that cell is the one tmux spends on the
     * border. Each box is a separate rectangle with a gutter around it, and the
     * mosaic reads as scattered cards instead of a single divided surface.
     *
     * The claim is exact equality, not approximate: two outlines a fraction of a
     * pixel apart still render as two lines with a seam between them.
     */
    const [left, right] = layoutTiles(SPLIT_VERTICAL);
    expect(left!.rect.left + left!.rect.width).toBe(right!.rect.left);

    const [above, below] = layoutTiles(SPLIT_HORIZONTAL);
    expect(above!.rect.top + above!.rect.height).toBe(below!.rect.top);
  });

  it("gives a tile the separator row above it, which is where its header is drawn", () => {
    /*
     * Bug this catches: the header is drawn inside the pane's own box and covers
     * the first row of that pane's output permanently — a line of everyone's
     * terminal spent on a title bar. tmux already spends the row above the pane
     * drawing a separator, so the header costs nothing where one exists.
     */
    const [above, below] = layoutTiles(SPLIT_HORIZONTAL);
    // The top pane is flush with the top of the window: no separator row exists
    // above it to borrow, so it reports none and the view reveals its header on
    // hover instead of hoisting it.
    expect(above!.headerRows).toBe(0);
    expect(below!.headerRows).toBe(1);
    // …and the row it borrowed is the one tmux left empty between the panes.
    expect(below!.rect.top).toBe(24 / 50);
  });

  it("keeps the cell sizes, because the drag arithmetic speaks in cells", () => {
    expect(layoutTiles(SPLIT_HORIZONTAL)[0]!.cells).toEqual({ cols: 200, rows: 24 });
  });

  it("drops panes whose semantic identity is not yet joined", () => {
    // A tile with no pane identity has no verb it could dispatch, so rendering
    // one produces chrome whose every control refuses.
    const tiles = layoutTiles(
      frame({ panes: [pane({ pane: "pane.a", width: 99 }), pane({ pane: null, left: 100 })] }),
    );
    expect(tiles.map((tile) => tile.pane)).toEqual(["pane.a"]);
  });

  it("renders a ZOOMED window as its zoomed pane alone", () => {
    /*
     * Bug this catches: tmux keeps reporting the hidden panes' unzoomed rects
     * while a window is zoomed, so a view that renders every reported pane
     * stacks the hidden ones under the visible one — and every hit test, every
     * context menu and every border handle lands on a pane the user cannot see.
     */
    const zoomed = frame({
      zoomed: true,
      panes: [
        pane({ pane: "pane.a", left: 0, width: 200, height: 50, active: true }),
        pane({ pane: "pane.b", left: 100, width: 100, height: 50 }),
      ],
    });
    expect(layoutTiles(zoomed).map((tile) => tile.pane)).toEqual(["pane.a"]);
  });

  it("renders a zoomed frame whole rather than blank when no pane fills the grid", () => {
    const odd = frame({
      zoomed: true,
      panes: [
        pane({ pane: "pane.a", width: 99, active: true }),
        pane({ pane: "pane.b", left: 100, width: 100 }),
      ],
    });
    expect(layoutTiles(odd)).toHaveLength(2);
  });

  it("is a pure function of the frame: the same frame gives the same picture", () => {
    expect(layoutTiles(SPLIT_VERTICAL)).toEqual(layoutTiles(SPLIT_VERTICAL));
  });
});

describe("layout borders", () => {
  it("puts a vertical handle on the one border cell between two side-by-side panes", () => {
    const borders = layoutBorders(SPLIT_VERTICAL);
    expect(borders).toHaveLength(1);
    expect(borders[0]).toMatchObject({
      orientation: "vertical",
      // Owned by the LEFT pane: `resize-pane -x` sets the target's own width.
      pane: "pane.a",
      cells: 99,
    });
    // Column 99 — tmux's border cell, so the handle covers no output at all.
    expect(borders[0]!.rect).toEqual({ left: 99 / 200, top: 0, width: 1 / 200, height: 1 });
  });

  it("puts a horizontal handle on the border row between stacked panes", () => {
    const [border] = layoutBorders(SPLIT_HORIZONTAL);
    expect(border).toMatchObject({ orientation: "horizontal", pane: "pane.a", cells: 24 });
    expect(border!.rect).toEqual({ left: 0, top: 24 / 50, width: 1, height: 1 / 50 });
  });

  it("finds no border in a single-pane window", () => {
    expect(layoutBorders(frame())).toEqual([]);
  });

  it("finds no border while the window is zoomed", () => {
    // tmux refuses a resize on a zoomed window, so offering the handle would be
    // offering a drag that can only fail.
    expect(layoutBorders({ ...SPLIT_VERTICAL, zoomed: true })).toEqual([]);
  });

  it("ignores a pane that is merely aligned, not adjacent", () => {
    // Bug this catches: two panes in different columns of a three-way layout are
    // read as neighbours, producing a handle in the middle of a pane's output.
    const gapped = frame({
      panes: [
        pane({ pane: "pane.a", left: 0, width: 60, height: 50 }),
        pane({ pane: "pane.b", left: 130, width: 70, height: 50 }),
      ],
    });
    expect(layoutBorders(gapped)).toEqual([]);
  });

  it("ignores a neighbour that does not overlap on the shared axis", () => {
    const staggered = frame({
      panes: [
        pane({ pane: "pane.a", left: 0, top: 0, width: 99, height: 24 }),
        pane({ pane: "pane.b", left: 100, top: 25, width: 100, height: 25 }),
      ],
    });
    expect(layoutBorders(staggered)).toEqual([]);
  });

  it("gives a pane with neighbours on both axes one handle per axis", () => {
    const grid = frame({
      panes: [
        pane({ pane: "pane.a", left: 0, top: 0, width: 99, height: 24 }),
        pane({ pane: "pane.b", left: 100, top: 0, width: 100, height: 24 }),
        pane({ pane: "pane.c", left: 0, top: 25, width: 200, height: 25 }),
      ],
    });
    expect(
      layoutBorders(grid)
        .filter((border) => border.pane === "pane.a")
        .map((border) => border.orientation)
        .sort(),
    ).toEqual(["horizontal", "vertical"]);
  });
});

describe("resolving a border drag", () => {
  const border = layoutBorders(SPLIT_VERTICAL)[0]!;
  const gridBox = { width: 1_000, height: 500 };

  it("converts pixels to cells through the measured grid box", () => {
    // 1000px over 200 cells is 5px per cell, so +50px is +10 cells.
    expect(
      resolveBorderDrag({ border, frame: SPLIT_VERTICAL, gridBox, deltaX: 50, deltaY: 0 }),
    ).toEqual({ axis: "cols", cells: 109 });
  });

  it("resolves a drag the other way as a smaller pane", () => {
    expect(
      resolveBorderDrag({ border, frame: SPLIT_VERTICAL, gridBox, deltaX: -50, deltaY: 0 }),
    ).toEqual({ axis: "cols", cells: 89 });
  });

  it("answers null for a drag that did not move a whole cell", () => {
    // Bug this catches: every mouse-up dispatches a resize, so a click on the
    // border spends a route trip proving nothing changed.
    expect(
      resolveBorderDrag({ border, frame: SPLIT_VERTICAL, gridBox, deltaX: 2, deltaY: 0 }),
    ).toBeNull();
  });

  it("reads the drag on the axis its border runs, ignoring the other one", () => {
    const horizontal = layoutBorders(SPLIT_HORIZONTAL)[0]!;
    expect(
      resolveBorderDrag({
        border: horizontal,
        frame: SPLIT_HORIZONTAL,
        gridBox,
        deltaX: 400,
        deltaY: 50,
      }),
      // 500px over 50 rows is 10px per row: +50px is +5 rows, and the 400px of
      // sideways wobble is not a resize of anything.
    ).toEqual({ axis: "rows", cells: 29 });
  });

  it("clamps to the window's own grid rather than asking for the impossible", () => {
    expect(
      resolveBorderDrag({ border, frame: SPLIT_VERTICAL, gridBox, deltaX: 100_000, deltaY: 0 }),
    ).toEqual({ axis: "cols", cells: 200 });
    expect(
      resolveBorderDrag({ border, frame: SPLIT_VERTICAL, gridBox, deltaX: -100_000, deltaY: 0 }),
    ).toEqual({ axis: "cols", cells: 1 });
  });

  it("answers null for an unmeasured grid box instead of dividing by zero", () => {
    expect(
      resolveBorderDrag({
        border,
        frame: SPLIT_VERTICAL,
        gridBox: { width: 0, height: 0 },
        deltaX: 50,
        deltaY: 0,
      }),
    ).toBeNull();
  });
});
