/**
 * Mouse helpers for the team TUI. Kept pure and separate from `index.tsx` —
 * which runs `render(...)` on import — so the double-click logic can be
 * unit-tested in isolation.
 */

/** A recorded click: which row index, and when (ms epoch). */
export interface ClickRecord {
  index: number;
  at: number;
}

/** Default window in which a second click on the same row counts as a double. */
export const DOUBLE_CLICK_MS = 400;

/**
 * A click at `index`/`now` is a double-click when the previous click was on the
 * SAME row and landed within `thresholdMs`. `prev === null` (no prior click) is
 * never a double-click.
 */
export function isDoubleClick(
  prev: ClickRecord | null,
  index: number,
  now: number,
  thresholdMs: number = DOUBLE_CLICK_MS,
): boolean {
  if (!prev) return false;
  return prev.index === index && now - prev.at <= thresholdMs;
}
