/**
 * Positioning anything that is painted OVER a terminal grid.
 *
 * The measured law this encodes is written up in CANVAS_INTERACTIONS.md under
 * "Grid overlay invariants". In short: a mirror pane's render is letterboxed
 * into its card by a uniform scale, so an overlay positioned in raw container
 * pixels is correct at scale 1 and wrong — by a growing margin — at every other
 * scale. Overlays are positioned from the SAME scale the renderer used.
 *
 * PURE. No DOM, no measurement; callers pass what they measured.
 */

export interface GridOverlayBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface GridOverlaySize {
  readonly width: number;
  readonly height: number;
}

/**
 * Where the letterboxed grid actually sits inside its container.
 *
 * `natural` is the grid's pre-transform size (what the emulator laid out),
 * `container` is the card it was fitted into, and `scale` is the value the
 * renderer applied — not one recomputed here, because a second derivation is a
 * second chance to disagree with the pixels on screen.
 *
 * Degenerate inputs collapse to the whole container rather than to a zero box:
 * an overlay covering slightly too much is a cosmetic error, and one collapsed
 * to nothing is an invisible feature.
 */
export function gridOverlayBox(
  natural: GridOverlaySize,
  container: GridOverlaySize,
  scale: number,
): GridOverlayBox {
  if (
    !Number.isFinite(scale) ||
    scale <= 0 ||
    natural.width <= 0 ||
    natural.height <= 0 ||
    container.width <= 0 ||
    container.height <= 0
  ) {
    return { left: 0, top: 0, width: container.width, height: container.height };
  }
  const width = Math.min(container.width, natural.width * scale);
  const height = Math.min(container.height, natural.height * scale);
  // The renderer centres its scaled grid, so the overlay centres with it; the
  // remainder is the letterbox margin and belongs to neither.
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}

/**
 * A cell rectangle, in the container's pixel space, through the fit scale.
 *
 * Any overlay anchored to a grid POSITION — a status glyph on a cell, a hover
 * highlight, a drag ghost — goes through this rather than multiplying by an
 * unscaled cell size. `cellWidth`/`cellHeight` are the emulator's own
 * pre-transform cell metrics.
 */
export function gridCellRect(
  cell: {
    readonly column: number;
    readonly row: number;
    readonly columns?: number;
    readonly rows?: number;
  },
  metrics: { readonly cellWidth: number; readonly cellHeight: number },
  box: GridOverlayBox,
  scale: number,
): GridOverlayBox {
  const columns = Math.max(1, cell.columns ?? 1);
  const rows = Math.max(1, cell.rows ?? 1);
  return {
    left: box.left + cell.column * metrics.cellWidth * scale,
    top: box.top + cell.row * metrics.cellHeight * scale,
    width: columns * metrics.cellWidth * scale,
    height: rows * metrics.cellHeight * scale,
  };
}
