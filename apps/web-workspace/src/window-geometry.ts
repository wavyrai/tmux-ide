import type { PaneStreamLayoutEvent } from "../../desktop-renderer/src/terminal/pane-stream-transport";
/** Layout allocation includes tmux's outer status row; the PTY does not. */
export function paneContentRows(
  layout: PaneStreamLayoutEvent,
  pane: PaneStreamLayoutEvent["panes"][number],
) {
  const statusRow =
    (layout.paneBorderStatus === "top" && pane.top === 0) ||
    (layout.paneBorderStatus === "bottom" && pane.top + pane.height === layout.rows);
  return Math.max(1, pane.height - (statusRow ? 1 : 0));
}

/** Preserve source cells and reserve header space once per occupied row band. */
export function projectWindowGeometry(
  layout: PaneStreamLayoutEvent,
  cell: { width: number; height: number },
  header: number,
) {
  const visible = layout.zoomed ? layout.panes.filter((p) => p.active) : layout.panes;
  const tops = [...new Set(visible.filter((p) => p.pane).map((p) => p.top))].sort((a, b) => a - b);
  const panes = visible.map((p) => ({
    ...p,
    x: p.left * cell.width,
    y:
      Math.max(0, p.top - (layout.paneBorderStatus === "top" ? 1 : 0)) * cell.height +
      tops.filter((top) => top < p.top).length * header,
    pixelWidth: p.width * cell.width,
    contentRows: paneContentRows(layout, p),
    // A spanning pane reserves the bands used by its stacked neighbours too.
    pixelHeight:
      paneContentRows(layout, p) * cell.height +
      tops.filter((top) => top >= p.top && top < p.top + p.height).length * header,
  }));
  return {
    width: layout.cols * cell.width,
    height:
      (layout.rows - (layout.paneBorderStatus === "off" ? 0 : 1)) * cell.height +
      tops.length * header,
    panes,
  };
}

/** Measure the terminal body, which already excludes sidebar, tabs and controls. */
export function fitWindowCells(
  layout: PaneStreamLayoutEvent,
  body: { width: number; height: number },
  cell: { width: number; height: number },
  header: number,
): { cols: number; rows: number } | null {
  if (
    ![body.width, body.height, cell.width, cell.height, header].every(Number.isFinite) ||
    body.width <= 0 ||
    body.height <= 0 ||
    cell.width <= 0 ||
    cell.height <= 0 ||
    header < 0
  )
    return null;
  const visible = layout.zoomed ? layout.panes.filter((p) => p.active) : layout.panes;
  const bands = new Set(visible.filter((p) => p.pane).map((p) => p.top)).size;
  const cols = Math.floor(body.width / cell.width);
  const rows =
    Math.floor((body.height - bands * header) / cell.height) +
    (layout.paneBorderStatus === "off" ? 0 : 1);
  if (cols < 2 || rows < 2) return null;
  return { cols: Math.min(4096, cols), rows: Math.min(4096, rows) };
}

/** Native tmux session sizing: one cell budget must fit every window's chrome. */
export function fitSessionCells(
  layouts: readonly PaneStreamLayoutEvent[],
  body: { width: number; height: number },
  cell: { width: number; height: number },
  header: number,
): { cols: number; rows: number } | null {
  if (!layouts.length) return null;
  const fits = layouts.map((layout) => fitWindowCells(layout, body, cell, header));
  if (fits.some((fit) => fit === null)) return null;
  return {
    cols: Math.min(...fits.map((fit) => fit!.cols)),
    rows: Math.min(...fits.map((fit) => fit!.rows)),
  };
}
