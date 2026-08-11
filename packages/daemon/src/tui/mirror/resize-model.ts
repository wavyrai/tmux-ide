/** Pure geometry for M19.3 pane-border drag resize. The mirror renders each tmux
 *  pane as an absolute box at (left,top) sized (width,height); the 1-cell gaps
 *  between adjacent panes show the canvas background as a SEPARATOR. A "down"
 *  landing on a separator (a canvas-local cell inside no pane rect, flanked by
 *  two panes) starts a border drag; the router turns the drag delta into an
 *  ABSOLUTE new size and applies it through the shared multiplexer authority
 *  (smoother than repeated -L/-R steps, and %layout-change resyncs the render).
 *  Keeping the hit-test + size math here (like spans/menu-model/diff-model) makes
 *  it unit-testable off the render loop. Pane coordinates are FRAMEBUFFER-LOCAL;
 *  callers translate through the projected terminal canvas instead of repeating
 *  shell/sidebar/chrome offsets. */

/** The minimal pane rectangle the hit test needs (LivePane is assignable). */
export interface PaneRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A resolved border between two adjacent panes. `axis` "x" = a VERTICAL
 *  separator column (drag left/right resizes widths); "y" = a HORIZONTAL
 *  separator row (drag up/down resizes heights). `aId` is the pane BEFORE the
 *  separator (to its left / above), `bId` the one after. `aSize`/`bSize` are the
 *  two panes' starting extents along the axis — the base the drag delta is added
 *  to (a) and the far bound (b) the clamp protects. */
export interface Separator {
  axis: "x" | "y";
  /** Framebuffer-local separator column/row. */
  position: number;
  /** Covered interval on the perpendicular axis, end-exclusive. */
  start: number;
  end: number;
  aId: string;
  bId: string;
  aSize: number;
  bSize: number;
}

/** The framebuffer origin inside the app-owned terminal canvas. */
export interface FramebufferOrigin {
  x: number;
  y: number;
}

export interface ResizeGuideRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Does pane `p` contain canvas cell (cx,cy)? */
function inside(p: PaneRect, cx: number, cy: number): boolean {
  return cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height;
}

/**
 * PURE — resolve the pane separator under canvas cell (cx,cy), or null. A cell
 * inside any pane rect is never a separator (that's a pane hit). A VERTICAL
 * separator is the 1-cell gap column where one pane ends (`a.left+a.width`) and
 * the next begins (`b.left`), both spanning row cy; a HORIZONTAL separator is the
 * gap row between a pane ending at `a.top+a.height` and one beginning at `b.top`,
 * both spanning column cx. Vertical is checked first (matches tmux's own
 * left/right bias); the first matching pair wins.
 */
export function separatorAt(panes: readonly PaneRect[], cx: number, cy: number): Separator | null {
  for (const p of panes) if (inside(p, cx, cy)) return null;
  // Vertical separator: `a` ends at column cx, `b` begins at cx+1, both cover cy.
  for (const a of panes) {
    if (a.left + a.width !== cx) continue;
    if (cy < a.top || cy >= a.top + a.height) continue;
    const b = panes.find((q) => q.left === cx + 1 && cy >= q.top && cy < q.top + q.height);
    if (b)
      return {
        axis: "x",
        position: cx,
        start: Math.max(a.top, b.top),
        end: Math.min(a.top + a.height, b.top + b.height),
        aId: a.id,
        bId: b.id,
        aSize: a.width,
        bSize: b.width,
      };
  }
  // Horizontal separator: `a` ends at row cy, `b` begins at cy+1, both cover cx.
  for (const a of panes) {
    if (a.top + a.height !== cy) continue;
    if (cx < a.left || cx >= a.left + a.width) continue;
    const b = panes.find((q) => q.top === cy + 1 && cx >= q.left && cx < q.left + q.width);
    if (b)
      return {
        axis: "y",
        position: cy,
        start: Math.max(a.left, b.left),
        end: Math.min(a.left + a.width, b.left + b.width),
        aId: a.id,
        bId: b.id,
        aSize: a.height,
        bSize: b.height,
      };
  }
  return null;
}

/**
 * Resolve a divider from APP-CANVAS coordinates using the exact projected
 * framebuffer origin. This is the seam between Workbench layout and tmux pane
 * geometry: focus rails and native pane chrome remain app-owned and can never
 * skew the gutter hit-test.
 */
export function separatorAtCanvas(
  panes: readonly PaneRect[],
  framebuffer: FramebufferOrigin,
  canvasX: number,
  canvasY: number,
): Separator | null {
  return separatorAt(panes, canvasX - framebuffer.x, canvasY - framebuffer.y);
}

/**
 * PURE — the absolute new extent for pane `a` given a drag `delta` (in cells)
 * along the separator's axis. Clamped so neither pane drops below `MIN_PANE`:
 * the two panes share `aSize + bSize` inner cells, so a's new size is bounded to
 * `[MIN_PANE, aSize + bSize - MIN_PANE]`. tmux enforces its own minimum too, but
 * clamping here keeps the emitted command sane and the math testable.
 */
export const MIN_PANE = 2;
export function resizedSize(sep: Separator, delta: number): number {
  const total = sep.aSize + sep.bSize;
  return Math.max(MIN_PANE, Math.min(total - MIN_PANE, sep.aSize + delta));
}

/** Exact one-cell visual guide for hover/drag feedback. */
export function resizeGuideRect(sep: Separator, delta = 0): ResizeGuideRect {
  return sep.axis === "x"
    ? {
        x: sep.position + delta,
        y: sep.start,
        width: 1,
        height: Math.max(1, sep.end - sep.start),
      }
    : {
        x: sep.start,
        y: sep.position + delta,
        width: Math.max(1, sep.end - sep.start),
        height: 1,
      };
}
