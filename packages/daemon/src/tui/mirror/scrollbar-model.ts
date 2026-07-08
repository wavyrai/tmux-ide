/**
 * Pure scrollbar geometry (M19.5) — shared by the editor viewport, the diff
 * pane, and any scrolled mirror pane.
 *
 * A 1-col track at the right edge of an always-present container; the thumb's
 * position and size are pure functions of (viewportTop, contentLen, viewH).
 * Both the RENDER (draws the track cells) and the ROUTER (classifies a press as
 * thumb vs track, maps a thumb drag to an absolute scroll top, pages a track
 * click) read the SAME math from here — the surface-bar discipline applied to a
 * vertical strip. Deliberately opentui-free so it unit-tests under Node.
 */

export interface ScrollThumb {
  /** Whether the content overflows the viewport (nothing to scroll → hidden). */
  overflow: boolean;
  /** First track row (0-based, within [0, viewH)) the thumb occupies. */
  start: number;
  /** Thumb height in rows (≥1, ≤viewH). */
  size: number;
}

/** The thumb size for a content/viewport pair — a viewport-fraction of the
 *  track, floored at one cell so a thumb always exists. Shared by every
 *  function below so their maths never drift. */
function thumbSize(contentLen: number, viewH: number): number {
  return Math.max(1, Math.min(viewH, Math.round((viewH * viewH) / contentLen)));
}

/** The thumb geometry for a scroll position. `viewportTop` is the first visible
 *  content line; `contentLen` the total lines; `viewH` the visible rows. When
 *  the content fits, `overflow` is false and the caller draws no track. */
export function scrollThumb(viewportTop: number, contentLen: number, viewH: number): ScrollThumb {
  if (viewH <= 0 || contentLen <= viewH) {
    return { overflow: false, start: 0, size: Math.max(1, viewH) };
  }
  const size = thumbSize(contentLen, viewH);
  const maxTop = contentLen - viewH;
  const maxStart = viewH - size;
  const top = Math.max(0, Math.min(maxTop, viewportTop));
  const start = maxStart <= 0 ? 0 : Math.round((top / maxTop) * maxStart);
  return { overflow: true, start: Math.max(0, Math.min(maxStart, start)), size };
}

/** Where a track row falls relative to the thumb — the fourth drag-origin's
 *  press classifier and the page-click direction source. */
export type TrackZone = "above" | "thumb" | "below";

export function trackZone(row: number, thumb: ScrollThumb): TrackZone {
  if (row < thumb.start) return "above";
  if (row >= thumb.start + thumb.size) return "below";
  return "thumb";
}

/** Page the viewport toward a click at track `row` (above the thumb → up one
 *  viewport, below → down one; on the thumb → unchanged), clamped to range. */
export function pageTop(
  row: number,
  viewportTop: number,
  contentLen: number,
  viewH: number,
): number {
  const thumb = scrollThumb(viewportTop, contentLen, viewH);
  if (!thumb.overflow) return viewportTop;
  const maxTop = contentLen - viewH;
  const zone = trackZone(row, thumb);
  const next =
    zone === "above" ? viewportTop - viewH : zone === "below" ? viewportTop + viewH : viewportTop;
  return Math.max(0, Math.min(maxTop, next));
}

/** Map a dragged thumb to an absolute scroll top. `trackRow` is the current
 *  pointer row within the track; `grabOffset` is the row within the thumb where
 *  the drag began (so the thumb doesn't jump under the cursor). Returns the new
 *  first-visible line, clamped. */
export function dragTop(
  trackRow: number,
  grabOffset: number,
  contentLen: number,
  viewH: number,
): number {
  if (viewH <= 0 || contentLen <= viewH) return 0;
  const size = thumbSize(contentLen, viewH);
  const maxStart = viewH - size;
  const maxTop = contentLen - viewH;
  if (maxStart <= 0) return 0;
  const start = Math.max(0, Math.min(maxStart, trackRow - grabOffset));
  return Math.round((start / maxStart) * maxTop);
}
