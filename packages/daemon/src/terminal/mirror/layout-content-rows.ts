/** Content height of one pane in a qualified visible or saved tmux layout. */
export function layoutContentRows(
  paneTop: number,
  paneHeight: number,
  windowRows: number,
  border: "off" | "top" | "bottom",
): number {
  if (border === "off") return paneHeight;
  // Only the pane touching the configured outer edge loses a content row.
  // Interior separators are already represented by the layout geometry.
  const touchesStatusEdge = border === "top" ? paneTop === 0 : paneTop + paneHeight === windowRows;
  return paneHeight - (touchesStatusEdge ? 1 : 0);
}

/**
 * The status line a window's tiled panes have, from its `pane-border-status`.
 * tmux 3.8's `top-floating` and `bottom-floating` put a status line on floating
 * panes only (`window_get_pane_status`), so tiled panes are laid out as "off".
 * Null for a value this daemon does not know.
 */
export function tiledPaneBorderStatus(option: string | undefined): "off" | "top" | "bottom" | null {
  if (option === "off" || option === "top" || option === "bottom") return option;
  return option === "top-floating" || option === "bottom-floating" ? "off" : null;
}
