/**
 * FLIP planning for tmux-authoritative pane chrome.
 *
 * The renderer never owns pane geometry: it snapshots the last confirmed DOM
 * rectangles, lets tmux's next layout render, then animates only the visual
 * difference. Keeping the arithmetic pure makes semantic identity—not DOM
 * position or array index—the thing that survives split/kill/zoom changes.
 */

export interface PanePixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PaneLayoutSnapshot {
  readonly pane: string;
  readonly title: string;
  readonly rect: PanePixelRect;
}

export interface PaneLayoutMove {
  readonly pane: string;
  readonly from: PanePixelRect;
  readonly to: PanePixelRect;
  readonly translateX: number;
  readonly translateY: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

export interface PaneLayoutTransitionPlan {
  readonly moves: readonly PaneLayoutMove[];
  readonly enters: readonly PaneLayoutSnapshot[];
  readonly exits: readonly PaneLayoutSnapshot[];
}

function valid(rect: PanePixelRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function materiallyChanged(from: PanePixelRect, to: PanePixelRect): boolean {
  return (
    Math.abs(from.left - to.left) >= 0.5 ||
    Math.abs(from.top - to.top) >= 0.5 ||
    Math.abs(from.width - to.width) >= 0.5 ||
    Math.abs(from.height - to.height) >= 0.5
  );
}

/** Build the compositor-only FLIP delta between two confirmed pane layouts. */
export function planPaneLayoutTransition(
  previous: readonly PaneLayoutSnapshot[],
  current: readonly PaneLayoutSnapshot[],
): PaneLayoutTransitionPlan {
  const before = new Map(previous.map((entry) => [entry.pane, entry]));
  const after = new Map(current.map((entry) => [entry.pane, entry]));
  const moves: PaneLayoutMove[] = [];
  const enters: PaneLayoutSnapshot[] = [];
  const exits: PaneLayoutSnapshot[] = [];

  for (const entry of current) {
    const prior = before.get(entry.pane);
    if (!prior) {
      enters.push(entry);
      continue;
    }
    if (!valid(prior.rect) || !valid(entry.rect) || !materiallyChanged(prior.rect, entry.rect)) {
      continue;
    }
    moves.push({
      pane: entry.pane,
      from: prior.rect,
      to: entry.rect,
      translateX: prior.rect.left - entry.rect.left,
      translateY: prior.rect.top - entry.rect.top,
      scaleX: prior.rect.width / entry.rect.width,
      scaleY: prior.rect.height / entry.rect.height,
    });
  }

  for (const entry of previous) {
    if (!after.has(entry.pane)) exits.push(entry);
  }

  return { moves, enters, exits };
}
