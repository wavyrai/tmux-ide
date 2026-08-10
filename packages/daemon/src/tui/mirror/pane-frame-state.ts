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
      left.snapshot.scrollOffset !== right.snapshot.scrollOffset
    ) {
      return false;
    }
  }
  return true;
}

export interface LivePaneRuntime {
  readonly version: number;
  readonly scrollbackDepth: number;
}

export function livePaneRuntime(panes: readonly LivePane[]): ReadonlyMap<string, LivePaneRuntime> {
  return new Map(
    panes.map((pane) => [
      pane.id,
      { version: pane.version, scrollbackDepth: pane.scrollbackDepth },
    ]),
  );
}

export function sameLivePaneRuntime(
  previous: ReadonlyMap<string, LivePaneRuntime>,
  next: ReadonlyMap<string, LivePaneRuntime>,
): boolean {
  if (previous.size !== next.size) return false;
  for (const [paneId, runtime] of previous) {
    const candidate = next.get(paneId);
    if (
      !candidate ||
      candidate.version !== runtime.version ||
      candidate.scrollbackDepth !== runtime.scrollbackDepth
    ) {
      return false;
    }
  }
  return true;
}
