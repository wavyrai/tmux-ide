/**
 * Compute absolute sizes for items where some have explicit sizes and others don't.
 * Items with `size` (e.g. "70%") keep their value; remaining space is split equally
 * among items without a size.
 */
export function computeSizes(items: { size?: string }[]): number[] {
  let claimed = 0;
  let unclaimed = 0;
  for (const item of items) {
    if (item.size) {
      claimed += parseFloat(item.size);
    } else {
      unclaimed++;
    }
  }
  const remaining = Math.max(0, 100 - claimed);
  const defaultSize = unclaimed > 0 ? remaining / unclaimed : 0;
  return items.map((item) => (item.size ? parseFloat(item.size) : defaultSize));
}

/**
 * Convert absolute sizes (e.g. [70, 30]) to tmux split percentages for sequential splits.
 * Returns array of -p values (one per split after the first item).
 *
 * Each tmux split divides the current pane. The percentage given to -p is
 * the portion allocated to the NEW (bottom/right) pane.
 */
export function toSplitPercents(sizes: number[]): number[] {
  const percents: number[] = [];
  for (let i = 1; i < sizes.length; i++) {
    const remaining = sizes.slice(i - 1).reduce((a, b) => a + b, 0);
    const topShare = sizes[i - 1]!;
    percents.push(Math.round(((remaining - topShare) / remaining) * 100));
  }
  return percents;
}
