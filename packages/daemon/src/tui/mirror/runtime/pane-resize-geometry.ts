export interface SemanticPaneResizeGeometry {
  readonly width: number;
  /** Visible-layout leaf height; a configured pane status row is included. */
  readonly height: number;
}

/**
 * Converts daemon-visible layout geometry to the exact native tmux resize
 * unit. A top/bottom pane status row is part of the visible-layout leaf but
 * excluded from `#{pane_height}`; `off` has no such conversion.
 */
export function nativePaneResizeCells(
  pane: SemanticPaneResizeGeometry,
  axis: "cols" | "rows",
  paneBorderStatus: "top" | "bottom" | "off",
): number | null {
  if (axis !== "cols" && axis !== "rows") return null;
  if (paneBorderStatus !== "top" && paneBorderStatus !== "bottom" && paneBorderStatus !== "off")
    return null;
  const cells = axis === "cols" ? pane.width : pane.height - (paneBorderStatus === "off" ? 0 : 1);
  return Number.isSafeInteger(cells) && cells > 0 && cells <= 4_096 ? cells : null;
}
