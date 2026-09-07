export interface SemanticPaneResizeGeometry {
  readonly width: number;
  /** Visible-layout leaf height; a configured pane status row is included. */
  readonly height: number;
  readonly top?: number;
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
  windowRows?: number,
): number | null {
  if (axis !== "cols" && axis !== "rows") return null;
  if (paneBorderStatus !== "top" && paneBorderStatus !== "bottom" && paneBorderStatus !== "off")
    return null;
  const statusRow =
    paneBorderStatus !== "off" &&
    (pane.top === undefined ||
      windowRows === undefined ||
      (paneBorderStatus === "top" ? pane.top === 0 : pane.top + pane.height === windowRows));
  const cells = axis === "cols" ? pane.width : pane.height - (statusRow ? 1 : 0);
  return Number.isSafeInteger(cells) && cells > 0 && cells <= 4_096 ? cells : null;
}
