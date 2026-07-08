/**
 * Focus-border geometry (M22.7): the accent strips drawn in the canvas GUTTER
 * cells around the focused pane, so focus is pane-level obvious without
 * consuming any terminal cells (a real box border would shrink the grid).
 *
 * Strips exist only where the pane has a neighboring gutter INSIDE the canvas —
 * a pane flush to a canvas edge has no room on that side (tmux gives edge panes
 * flush edges), and a single-pane window renders no strips at all (there is no
 * ambiguity to resolve, and no gutters to paint). Horizontal strips extend one
 * cell into the adjacent vertical gutters so the corners fill.
 *
 * PURE — rect math only; the app renders each strip as one background-tinted
 * box, and the strips are handler-less so gutter presses still bubble to the
 * central router (border drags keep working).
 */

export interface PaneRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FocusStrip {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The gutter strips around `pane` within a `cols`×`rows` canvas — empty when
 * the window has a single pane (`paneCount < 2`) or the rect is degenerate.
 */
export function focusStrips(
  pane: PaneRectLike,
  cols: number,
  rows: number,
  paneCount: number,
): FocusStrip[] {
  if (paneCount < 2) return [];
  if (pane.width <= 0 || pane.height <= 0) return [];
  const strips: FocusStrip[] = [];
  const hasLeft = pane.left > 0;
  const hasRight = pane.left + pane.width < cols;
  const hasTop = pane.top > 0;
  const hasBottom = pane.top + pane.height < rows;
  // Horizontal strips reach into the side gutters so corners fill.
  const hx = hasLeft ? pane.left - 1 : pane.left;
  const hw = pane.width + (hasLeft ? 1 : 0) + (hasRight ? 1 : 0);
  if (hasTop) strips.push({ left: hx, top: pane.top - 1, width: hw, height: 1 });
  if (hasBottom) strips.push({ left: hx, top: pane.top + pane.height, width: hw, height: 1 });
  if (hasLeft) strips.push({ left: pane.left - 1, top: pane.top, width: 1, height: pane.height });
  if (hasRight)
    strips.push({ left: pane.left + pane.width, top: pane.top, width: 1, height: pane.height });
  return strips;
}
