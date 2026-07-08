/**
 * Size truth (M22.8) — is tmux's window the size we pinned, or did a co-attached
 * terminal shrink it out from under us?
 *
 * The mirror pins its virtual control client to the render area
 * (`refresh-client -C`), so when we are the only (or the latest-active) client
 * the window matches our canvas. But tmux's default `window-size latest` lets a
 * second, smaller terminal attached to the same session dictate the window size
 * — and our canvas then renders letterboxed. These PURE helpers detect that
 * mismatch from the pane layout, center the grid inside the canvas, and format
 * the quiet honest hint. No tmux, no render loop — unit-tested in isolation; the
 * app reads the pane geometry and the pinned canvas size and wires the rest.
 */

export interface Size {
  cols: number;
  rows: number;
}

/** The minimal pane rectangle the bounding box needs (LivePane is assignable). */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * PURE — the effective window size implied by the pane layout: the bounding box
 * of all pane rects. tmux tiles panes to fill the whole window (edge panes sit
 * flush to the edges, borders live between them), so the maximum right edge
 * (`left + width`) is the window width and the maximum bottom edge
 * (`top + height`) is the window height. Null when there are no panes yet.
 */
export function effectiveWindowSize(panes: readonly Rect[]): Size | null {
  if (panes.length === 0) return null;
  let cols = 0;
  let rows = 0;
  for (const p of panes) {
    cols = Math.max(cols, p.left + p.width);
    rows = Math.max(rows, p.top + p.height);
  }
  return { cols, rows };
}

/**
 * PURE — the actual window size when it DIFFERS from what we pinned (another
 * terminal is dictating it), else null. Any difference on either axis counts;
 * equal sizes mean we own the window and there is nothing to surface.
 */
export function detectSizeMismatch(pinned: Size, effective: Size): Size | null {
  if (effective.cols === pinned.cols && effective.rows === pinned.rows) return null;
  return { cols: effective.cols, rows: effective.rows };
}

/**
 * PURE — the letterbox offset that centers a `content`-sized grid inside a
 * `canvas`-sized area. Never negative (a window LARGER than the canvas pins to
 * the origin and clips rather than shifting off-screen), floored so cells stay
 * aligned to the grid.
 */
export function letterboxOffset(canvas: Size, content: Size): { x: number; y: number } {
  return {
    x: Math.max(0, Math.floor((canvas.cols - content.cols) / 2)),
    y: Math.max(0, Math.floor((canvas.rows - content.rows) / 2)),
  };
}

/**
 * PURE — the quiet, plain-language hint for a size mismatch: the honest answer
 * ("here is the size another terminal chose"), dimensions in the terminal-native
 * `cols×rows` form. Dismiss-free — the app shows it only while the mismatch
 * exists, so it disappears the moment the sizes agree.
 */
export function formatSizeHint(effective: Size): string {
  return `window sized by another terminal — ${effective.cols}×${effective.rows}`;
}
