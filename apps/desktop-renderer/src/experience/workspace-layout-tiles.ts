/**
 * The layout-faithful view, as arithmetic (m50).
 *
 * The whole premise of this view is that it cannot disagree with tmux, and the
 * way that promise is kept is structural: everything on screen is derived HERE,
 * from one pane-stream layout frame, by pure functions. The renderer owns no
 * geometry of its own — there is no saved rectangle, no float, no docked
 * placement, nothing that could survive a layout change and then contradict it.
 * A split, a resize, a zoom or a kill arrives as the next frame, and the next
 * frame is the next picture.
 *
 * Two coordinate systems meet here and it is worth being precise about them.
 * The frame speaks in CELLS, in the window's own grid: a pane's `left`/`top` is
 * the cell its first character occupies, and consecutive panes are separated by
 * exactly one cell of tmux's own border. The view speaks in FRACTIONS of the
 * rendered grid box, because the box is measured in the DOM and changes with
 * every window resize. Converting once, here, is what stops each surface from
 * inventing its own rounding.
 */

/** One pane's placement, exactly as the layout frame reported it. */
export interface LayoutFramePane {
  /** Null while the pane's semantic identity join is unverified. */
  readonly pane: string | null;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly active: boolean;
}

/** One window's complete geometry: the layout frame, narrowed to what tiles need. */
export interface LayoutFrame {
  readonly semanticWindowId: string | null;
  readonly windowName: string | null;
  readonly currentWindow: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly zoomed: boolean;
  readonly panes: readonly LayoutFramePane[];
}

/** A rectangle in fractions of the grid box, ready to become CSS percentages. */
export interface TileRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutTile {
  /** Semantic pane identity. Tiles for unjoined panes are not produced. */
  readonly pane: string;
  /**
   * The tile's box in grid fractions — the MOSAIC box, not the pane's own cells.
   * See {@link layoutTiles} for the invariant that makes adjacent boxes meet.
   */
  readonly rect: TileRect;
  readonly active: boolean;
  /**
   * Whether this tile's box includes tmux's separator row above the pane, which
   * is where the header is drawn. 0 for a pane flush with the top of the window,
   * which has no separator row to borrow — see {@link layoutTiles}.
   */
  readonly headerRows: 0 | 1;
  /** Cell geometry, kept for the drag arithmetic that has to speak in cells. */
  readonly cells: { readonly cols: number; readonly rows: number };
}

/**
 * One draggable border, owned by the pane on its left (vertical) or above it
 * (horizontal).
 *
 * Ownership is not cosmetic: `resize-pane -x` sets the TARGET pane's width, so
 * the pane whose edge is being dragged is the one the verb must name. Handing
 * the border to the neighbour instead would move the right edge by changing the
 * left one, which is the same picture and a different layout.
 */
export interface LayoutBorder {
  readonly id: string;
  readonly orientation: "vertical" | "horizontal";
  /** The pane whose width (vertical) or height (horizontal) a drag changes. */
  readonly pane: string;
  readonly rect: TileRect;
  /** The owning pane's current size on the dragged axis, in cells. */
  readonly cells: number;
}

export interface WindowTab {
  /** Durable window identity, when the stamp join succeeded. */
  readonly semanticWindowId: string | null;
  readonly label: string;
  readonly active: boolean;
  readonly paneCount: number;
  readonly zoomed: boolean;
  /**
   * A pane of this window, which is how the window is addressed: window verbs
   * accept a pane as the way to name its window, and `pane.select` is what makes
   * tmux's own current window follow a tab click. Null when no pane of the
   * window has a verified semantic identity, which is what makes the tab inert
   * rather than silently wrong.
   */
  readonly addressPane: string | null;
}

/** The tile a tab is keyed by when the window has no durable stamp yet. */
export function windowTabKey(frame: LayoutFrame): string {
  return frame.semanticWindowId ?? `unstamped:${frame.panes[0]?.pane ?? frame.windowName ?? ""}`;
}

/**
 * The window tab strip.
 *
 * Labels come from the LIVE window name on every frame, never from a stored
 * title: a rename in tmux, from anywhere, is a new frame and therefore a new
 * label. A window with no name falls back to its index, which is what tmux shows
 * in the same situation.
 */
export function windowTabs(frames: readonly LayoutFrame[]): readonly WindowTab[] {
  return frames.map((frame, index) => {
    const joined = frame.panes.filter((pane) => pane.pane !== null);
    const active = joined.find((pane) => pane.active) ?? joined[0];
    return {
      semanticWindowId: frame.semanticWindowId,
      label: frame.windowName?.trim() || `Window ${index + 1}`,
      active: frame.currentWindow,
      paneCount: frame.panes.length,
      zoomed: frame.zoomed,
      addressPane: active?.pane ?? null,
    };
  });
}

function fraction(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

/** Keep an outer edge of the mosaic inside the grid box. */
function clamped(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * The active window's panes as rectangles.
 *
 * A ZOOMED window reports its zoomed pane filling the grid and its hidden panes
 * still carrying their unzoomed rects, so the zoomed pane is returned alone.
 * Rendering the hidden ones underneath would put a stack of tiles behind the one
 * the user is looking at, and every hit test would land on the wrong one.
 *
 * ── The mosaic invariant (m50.2, gaps 3 and 4) ────────────────────────────────
 *
 * A tile's box is NOT the pane's own cells. tmux spends one cell between two
 * panes drawing a border, so boxes drawn at the panes' cell rects sit one cell
 * apart and the grid reads as a scatter of separate rectangles rather than one
 * object. Each box therefore claims that shared cell:
 *
 *   width  = pane.width  + 1          shifted half a cell LEFT
 *   height = pane.height + headerRows shifted headerRows cells UP
 *
 * so that `left.right === right.left` and `top.bottom === bottom.top` exactly,
 * the outlines coincide, and the frame is connected. The asymmetry between the
 * axes is not an oversight: horizontally the shared cell is split in half
 * between the two neighbours, while vertically the whole separator row is given
 * to the pane BELOW it, because that row is where that pane's header is drawn.
 *
 * `headerRows` is 1 where a separator row exists above the pane and 0 where one
 * does not — a pane flush with the top of the window (`top === 0`) has no row to
 * borrow. Under `pane-border-status top` tmux spends a separator row above every
 * pane including the topmost, so every pane reports `top > 0` and every tile
 * gets its header row; where the option is off or inherited as `off` on a fresh
 * window, the top pane's header has nowhere to go and the view falls back to
 * revealing it on hover over the pane's own first row (see styles.css). Both
 * cases are honest; only the first is free.
 *
 * Outer edges are clamped to the grid box. The half-cell shift would otherwise
 * put the leftmost tile's outline half a cell outside the grid, where the pane
 * area clips it — the invariant only has to hold BETWEEN neighbours, and an
 * edge with no neighbour has nothing to meet.
 */
export function layoutTiles(frame: LayoutFrame): readonly LayoutTile[] {
  const joined = frame.panes.filter(
    (pane): pane is LayoutFramePane & { pane: string } => pane.pane !== null,
  );
  const visible = frame.zoomed
    ? joined.filter((pane) => pane.width >= frame.cols && pane.height >= frame.rows)
    : joined;
  // A zoomed frame whose zoomed pane cannot be identified is rendered whole
  // rather than blank: an empty pane area reads as a broken app, and the tiles
  // are still the truth the frame reported.
  const panes = frame.zoomed && visible.length === 0 ? joined : visible;
  return panes.map((pane) => {
    const headerRows = pane.top > 0 ? 1 : 0;
    const left = clamped(fraction(pane.left - 0.5, frame.cols));
    const top = clamped(fraction(pane.top - headerRows, frame.rows));
    const right = clamped(fraction(pane.left + pane.width + 0.5, frame.cols));
    const bottom = clamped(fraction(pane.top + pane.height, frame.rows));
    return {
      pane: pane.pane,
      active: pane.active,
      headerRows: headerRows as 0 | 1,
      cells: { cols: pane.width, rows: pane.height },
      rect: { left, top, width: right - left, height: bottom - top },
    };
  });
}

/** Do two spans on one axis overlap by at least one cell? */
function overlaps(start: number, length: number, otherStart: number, otherLength: number): boolean {
  return start < otherStart + otherLength && otherStart < start + length;
}

/**
 * The draggable borders of one window.
 *
 * Derived from the panes rather than from tmux's layout string, because the
 * frame is what the view already trusts and a second parser of the same fact is
 * a second thing that can disagree with it. A border exists where a pane's right
 * (or bottom) edge is separated from a neighbour by exactly the one cell tmux
 * spends on drawing it — which is also exactly where the handle can sit without
 * covering a single character of anyone's output.
 *
 * A zoomed window has no borders: its one visible pane fills the grid, and tmux
 * refuses a resize while it does.
 */
export function layoutBorders(frame: LayoutFrame): readonly LayoutBorder[] {
  if (frame.zoomed) return [];
  const joined = frame.panes.filter(
    (pane): pane is LayoutFramePane & { pane: string } => pane.pane !== null,
  );
  const borders: LayoutBorder[] = [];
  for (const pane of joined) {
    const rightEdge = pane.left + pane.width;
    const hasRightNeighbour = joined.some(
      (other) =>
        other.pane !== pane.pane &&
        other.left === rightEdge + 1 &&
        overlaps(pane.top, pane.height, other.top, other.height),
    );
    if (hasRightNeighbour) {
      borders.push({
        id: `${pane.pane}:cols`,
        orientation: "vertical",
        pane: pane.pane,
        cells: pane.width,
        rect: {
          left: fraction(rightEdge, frame.cols),
          top: fraction(pane.top, frame.rows),
          width: fraction(1, frame.cols),
          height: fraction(pane.height, frame.rows),
        },
      });
    }
    const bottomEdge = pane.top + pane.height;
    const hasBottomNeighbour = joined.some(
      (other) =>
        other.pane !== pane.pane &&
        other.top === bottomEdge + 1 &&
        overlaps(pane.left, pane.width, other.left, other.width),
    );
    if (hasBottomNeighbour) {
      borders.push({
        id: `${pane.pane}:rows`,
        orientation: "horizontal",
        pane: pane.pane,
        cells: pane.height,
        rect: {
          left: fraction(pane.left, frame.cols),
          top: fraction(bottomEdge, frame.rows),
          width: fraction(pane.width, frame.cols),
          height: fraction(1, frame.rows),
        },
      });
    }
  }
  return borders;
}

export interface BorderDragResolution {
  readonly axis: "cols" | "rows";
  readonly cells: number;
}

/**
 * Turn a finished border drag into the size to ask tmux for.
 *
 * Pixels become cells through the MEASURED grid box, so the conversion follows
 * the same cell size the user was actually looking at rather than a nominal one.
 * The result is clamped to at least one cell and to the window's own grid: tmux
 * clamps too, and asking for a number it will refuse outright only produces a
 * refusal where a smaller move would have worked.
 *
 * Returns null when the drag did not move a whole cell — the honest answer is
 * that nothing happened, and a route trip to prove it is waste.
 */
export function resolveBorderDrag(input: {
  readonly border: LayoutBorder;
  readonly frame: LayoutFrame;
  readonly gridBox: { readonly width: number; readonly height: number };
  readonly deltaX: number;
  readonly deltaY: number;
}): BorderDragResolution | null {
  const vertical = input.border.orientation === "vertical";
  const axis = vertical ? ("cols" as const) : ("rows" as const);
  const totalCells = vertical ? input.frame.cols : input.frame.rows;
  const boxPixels = vertical ? input.gridBox.width : input.gridBox.height;
  if (totalCells <= 0 || boxPixels <= 0) return null;
  const cellPixels = boxPixels / totalCells;
  const movedCells = Math.round((vertical ? input.deltaX : input.deltaY) / cellPixels);
  if (movedCells === 0) return null;
  const cells = Math.min(Math.max(input.border.cells + movedCells, 1), totalCells);
  return cells === input.border.cells ? null : { axis, cells };
}
