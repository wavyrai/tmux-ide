import type { LivePane } from "./session-mirror.ts";

/**
 * Pane layout state is deliberately separate from terminal cells and focus.
 * A busy pane changes `version` on every parsed chunk, while focus has its own
 * synchronous control-plane signal; neither should invalidate shell geometry.
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
      left.appMouse !== right.appMouse ||
      left.zoomed !== right.zoomed ||
      left.snapshot.scrollOffset !== right.snapshot.scrollOffset
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve the pane that owns terminal input and chrome. Explicit control-plane
 * focus wins while it belongs to the visible window; the geometry snapshot is
 * only the bootstrap/fallback authority.
 */
export function activeLivePaneId(
  panes: readonly LivePane[],
  focusedPaneId: string | null,
): string | null {
  if (focusedPaneId && panes.some((pane) => pane.id === focusedPaneId)) return focusedPaneId;
  return panes.find((pane) => pane.active)?.id ?? null;
}

/** Project focus into pane chrome without coupling it to terminal pixels. */
export function withLivePaneFocus(
  panes: readonly LivePane[],
  focusedPaneId: string | null,
): LivePane[] {
  const activeId = activeLivePaneId(panes, focusedPaneId);
  return panes.map((pane) => {
    const active = pane.id === activeId;
    return pane.active === active ? pane : { ...pane, active };
  });
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
