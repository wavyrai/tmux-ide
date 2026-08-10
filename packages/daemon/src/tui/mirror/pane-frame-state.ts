import type { LivePane } from "./session-mirror.ts";

/**
 * Pane layout/chrome state is deliberately separate from terminal cell state.
 * A busy pane changes `version` (and often its cursor) on every parsed chunk,
 * but that must not invalidate application-shell geometry or pane chrome.
 */
export function sameLivePaneStructure(
  previous: readonly LivePane[],
  next: readonly LivePane[],
): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index++) {
    const left = previous[index]!;
    const right = next[index]!;
    if (
      left.id !== right.id ||
      left.left !== right.left ||
      left.top !== right.top ||
      left.width !== right.width ||
      left.height !== right.height ||
      left.active !== right.active ||
      left.appMouse !== right.appMouse ||
      left.zoomed !== right.zoomed ||
      left.scrollbackDepth !== right.scrollbackDepth ||
      left.snapshot.scrollOffset !== right.snapshot.scrollOffset
    ) {
      return false;
    }
  }
  return true;
}

export function livePaneVersions(panes: readonly LivePane[]): ReadonlyMap<string, number> {
  return new Map(panes.map((pane) => [pane.id, pane.version]));
}

export function sameLivePaneVersions(
  previous: ReadonlyMap<string, number>,
  next: ReadonlyMap<string, number>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [paneId, version] of previous) {
    if (next.get(paneId) !== version) return false;
  }
  return true;
}
