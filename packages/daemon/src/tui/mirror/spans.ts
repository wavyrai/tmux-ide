/** Pure horizontal-span geometry shared by the two clickable tab rows — the
 *  surface tab bar (F1..F4, startX=0, gap=0) and the per-window strip inside the
 *  Terminal surface (startX=SIDEBAR_W+1, gap=1). Both render a row of labels
 *  laid out left-to-right and both resolve clicks in the central `route` by
 *  x-span math; keeping that math in one tested place is the whole point (the
 *  window strip's old inline math drifted from its render and hit the late-mount
 *  landmine). Index `i` of the returned array maps to `labels[i]`. */
export interface Span {
  /** First column (inclusive) this label occupies. */
  start: number;
  /** Cell width — the label's string length (labels are single display-width). */
  width: number;
}

/** Lay `labels` out from `startX`, each `label.length` cells wide, separated by
 *  `gap` blank cells. Pure. */
export function spans(labels: string[], startX: number, gap: number): Span[] {
  const out: Span[] = [];
  let x = startX;
  for (const label of labels) {
    out.push({ start: x, width: label.length });
    x += label.length + gap;
  }
  return out;
}

/** Lay `labels` out left-to-right anchored to the RIGHT: the last label ends
 *  flush at `rightEdge` (its final cell is `rightEdge - 1`), separated by `gap`.
 *  For right-aligned header affordance buttons whose PRECEDING content is
 *  variable-width — the layout is pinned to the (fixed) right edge, not a left
 *  origin, so the render (a flexGrow spacer then the buttons) and the router
 *  agree cell-for-cell. Pure. */
export function spansFromRight(labels: string[], rightEdge: number, gap: number): Span[] {
  const total = labels.reduce((n, l) => n + l.length, 0) + gap * Math.max(0, labels.length - 1);
  return spans(labels, rightEdge - total, gap);
}

/** Index of the span containing column `x`, or -1. Gap cells between spans and
 *  columns past the last span resolve to -1 (no hit). */
export function spanHit(list: Span[], x: number): number {
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (x >= s.start && x < s.start + s.width) return i;
  }
  return -1;
}
