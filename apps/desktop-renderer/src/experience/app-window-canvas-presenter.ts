import {
  AppWindowDocumentV1SchemaZ,
  type AppWindowDockNodeShape,
  type AppWindowDocumentV1,
  type AppWindowInstance,
  type AppWindowRect,
  type AppWindowSource,
} from "@tmux-ide/contracts";

export interface AppWindowCanvasViewport {
  readonly width: number;
  readonly height: number;
}

export interface AppWindowCanvasItem {
  /** Canonical durable identity. Never a tmux pane id. */
  readonly windowId: string;
  readonly source: AppWindowSource;
  readonly title: string | null;
  readonly rect: AppWindowRect;
  readonly placement: "docked" | "floating";
  readonly stackId: string | null;
  readonly stackIndex: number | null;
  readonly selected: boolean;
  readonly active: boolean;
  readonly zIndex: number;
  /**
   * Number of terminal resources this card represents (m41 attach-5). It is >1
   * only on the representative of a coalesced multi-pane window — the panes of
   * one durable tmux window, grouped by their shared `windowResourceId`, render
   * as ONE card. Absent (treated as 1) for an ordinary single-resource window.
   * A value >1 is what makes the card attach size-passive and letterbox.
   */
  readonly windowGroupPaneCount?: number;
}

export interface AppWindowCanvasProjection {
  readonly revision: number;
  readonly viewport: AppWindowCanvasViewport;
  readonly windows: readonly AppWindowCanvasItem[];
  readonly hiddenWindowIds: readonly string[];
  readonly focusedWindowId: string | null;
}

export type AppWindowCanvasCommand =
  | { readonly type: "window.focus"; readonly windowId: string | null }
  | {
      readonly type: "window.move";
      readonly windowId: string;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly type: "window.resize";
      readonly windowId: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly type: "window.float"; readonly windowId: string; readonly rect?: AppWindowRect }
  | {
      readonly type: "window.dock";
      readonly windowId: string;
      readonly stackId?: string;
      readonly index?: number;
    }
  | { readonly type: "stack.activate"; readonly stackId: string; readonly windowId: string };

export type AppWindowCanvasCommandSource = "keyboard" | "mouse" | "programmatic";

export interface AppWindowCanvasCommandInvocation {
  readonly command: AppWindowCanvasCommand;
  readonly source: AppWindowCanvasCommandSource;
}

export function appWindowFocusInvocation(
  windowId: string | null,
  source: AppWindowCanvasCommandSource,
): AppWindowCanvasCommandInvocation {
  return { command: { type: "window.focus", windowId }, source };
}

function finiteExtent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function normalizedViewport(viewport: AppWindowCanvasViewport): AppWindowCanvasViewport {
  return { width: finiteExtent(viewport.width), height: finiteExtent(viewport.height) };
}

function integerSegments(
  total: number,
  weights: readonly number[],
  gap: number,
): readonly number[] {
  const available = Math.max(0, total - Math.max(0, weights.length - 1) * gap);
  const sum = weights.reduce((current, weight) => current + weight, 0);
  let remaining = available;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return remaining;
    const extent = Math.floor((available * weight) / sum);
    remaining -= extent;
    return extent;
  });
}

function terminalWindowIdsInNode(
  node: AppWindowDockNodeShape,
  windows: Readonly<Record<string, AppWindowInstance>>,
): readonly string[] {
  if (node.type === "stack") {
    return node.windowIds.filter((windowId) => windows[windowId]?.source.kind === "terminal");
  }
  return node.children.flatMap((child) => terminalWindowIdsInNode(child, windows));
}

function projectDockNode(
  node: AppWindowDockNodeShape,
  rect: AppWindowRect,
  document: AppWindowDocumentV1,
  output: AppWindowCanvasItem[],
  hidden: string[],
  zIndex: { value: number },
  gap: number,
): void {
  if (node.type === "stack") {
    const terminalWindowIds = node.windowIds.filter(
      (windowId) => document.windows[windowId]?.source.kind === "terminal",
    );
    if (terminalWindowIds.length === 0) return;
    const activeWindowId = terminalWindowIds.includes(node.activeWindowId)
      ? node.activeWindowId
      : terminalWindowIds[0]!;
    for (const windowId of terminalWindowIds) {
      if (windowId !== activeWindowId) hidden.push(windowId);
    }
    const window = document.windows[activeWindowId]!;
    output.push({
      windowId: window.id,
      source: window.source,
      title: window.title,
      rect,
      placement: "docked",
      stackId: node.id,
      stackIndex: node.windowIds.indexOf(window.id),
      selected: document.focusedWindowId === window.id,
      active: true,
      zIndex: zIndex.value++,
    });
    return;
  }

  const renderable = node.children
    .map((child, index) => ({ child, weight: node.weights[index]! }))
    .filter(({ child }) => terminalWindowIdsInNode(child, document.windows).length > 0);
  if (renderable.length === 0) return;
  const horizontal = node.axis === "horizontal";
  const extents = integerSegments(
    horizontal ? rect.width : rect.height,
    renderable.map(({ weight }) => weight),
    gap,
  );
  let cursor = horizontal ? rect.x : rect.y;
  for (const [index, { child }] of renderable.entries()) {
    const extent = extents[index]!;
    const childRect = horizontal
      ? { x: cursor, y: rect.y, width: extent, height: rect.height }
      : { x: rect.x, y: cursor, width: rect.width, height: extent };
    projectDockNode(child, childRect, document, output, hidden, zIndex, gap);
    cursor += extent + gap;
  }
}

function terminalGroupKey(
  window: AppWindowCanvasItem,
  groupBySourceId: ReadonlyMap<string, string>,
): string | null {
  return window.source.kind === "terminal"
    ? (groupBySourceId.get(window.source.terminalSourceId) ?? null)
    : null;
}

/**
 * PURE — coalesce the panes of one durable tmux window into a single card
 * (m41 attach-5). The daemon still projects one AppWindow per pane resource, so
 * a multi-pane window arrives as N terminal windows that share one
 * `windowResourceId` (minted by attach-4 from the durable window stamp). Every
 * group of >1 collapses to ONE representative card — chosen by the smallest
 * window id so the card identity, geometry, and attach pane stay STABLE as the
 * active pane changes inside tmux — and the rest are hidden. Selection folds
 * across the whole group, and a focus that pointed at a hidden member is
 * remapped to the representative so focus/selection resolve through the group.
 */
function coalesceWindowGroups(
  windows: readonly AppWindowCanvasItem[],
  hiddenWindowIds: string[],
  focusedWindowId: string | null,
  groupBySourceId: ReadonlyMap<string, string>,
): { readonly windows: AppWindowCanvasItem[]; readonly focusedWindowId: string | null } {
  if (groupBySourceId.size === 0) return { windows: [...windows], focusedWindowId };
  const members = new Map<string, AppWindowCanvasItem[]>();
  for (const window of windows) {
    const key = terminalGroupKey(window, groupBySourceId);
    if (key === null) continue;
    (members.get(key) ?? members.set(key, []).get(key)!).push(window);
  }
  const representativeByGroup = new Map<string, string>();
  const coalescedAway = new Set<string>();
  for (const [key, group] of members) {
    if (group.length < 2) continue;
    const representative = [...group].sort((left, right) =>
      left.windowId.localeCompare(right.windowId),
    )[0]!;
    representativeByGroup.set(key, representative.windowId);
    for (const window of group) {
      if (window.windowId !== representative.windowId) coalescedAway.add(window.windowId);
    }
  }
  if (coalescedAway.size === 0) return { windows: [...windows], focusedWindowId };
  let nextFocused = focusedWindowId;
  if (focusedWindowId !== null && coalescedAway.has(focusedWindowId)) {
    const focused = windows.find((window) => window.windowId === focusedWindowId);
    const key = focused ? terminalGroupKey(focused, groupBySourceId) : null;
    nextFocused = (key !== null ? representativeByGroup.get(key) : undefined) ?? focusedWindowId;
  }
  const nextWindows: AppWindowCanvasItem[] = [];
  for (const window of windows) {
    if (coalescedAway.has(window.windowId)) {
      hiddenWindowIds.push(window.windowId);
      continue;
    }
    const key = terminalGroupKey(window, groupBySourceId);
    if (key !== null && representativeByGroup.get(key) === window.windowId) {
      const group = members.get(key)!;
      nextWindows.push({
        ...window,
        selected: group.some((member) => member.selected || member.windowId === focusedWindowId),
        active: group.some((member) => member.active),
        windowGroupPaneCount: group.length,
      });
      continue;
    }
    nextWindows.push(window);
  }
  return { windows: nextWindows, focusedWindowId: nextFocused };
}

/**
 * Pure durable-scene -> terminal canvas projection. Native dock/window nodes
 * are pruned before split allocation because those surfaces remain owned by
 * the native workbench in this first canvas slice.
 *
 * `windowGroupBySourceId` maps a terminal source id to the `windowResourceId`
 * it shares with the other panes of its durable tmux window (m41 attach-5).
 * When supplied, panes of one window coalesce into a single representative card.
 */
export function projectAppWindowCanvas(
  value: AppWindowDocumentV1,
  requestedViewport: AppWindowCanvasViewport,
  options: {
    readonly gap?: number;
    readonly windowGroupBySourceId?: ReadonlyMap<string, string>;
  } = {},
): AppWindowCanvasProjection {
  const document = AppWindowDocumentV1SchemaZ.parse(value);
  const viewport = normalizedViewport(requestedViewport);
  const gap = Math.max(0, Math.round(options.gap ?? 6));
  const windows: AppWindowCanvasItem[] = [];
  const hiddenWindowIds: string[] = [];
  const dockZ = { value: 1 };
  if (document.dockRoot) {
    projectDockNode(
      document.dockRoot,
      { x: 0, y: 0, width: viewport.width, height: viewport.height },
      document,
      windows,
      hiddenWindowIds,
      dockZ,
      gap,
    );
  }

  for (const [order, windowId] of document.floatingOrder.entries()) {
    const window = document.windows[windowId]!;
    if (window.source.kind !== "terminal") continue;
    const rect = window.placement.floating!;
    windows.push({
      windowId: window.id,
      source: window.source,
      title: window.title,
      rect: { ...rect },
      placement: "floating",
      stackId: null,
      stackIndex: null,
      selected: document.focusedWindowId === window.id,
      active: document.focusedWindowId === window.id,
      zIndex: dockZ.value + order,
    });
  }

  const coalesced = coalesceWindowGroups(
    windows,
    hiddenWindowIds,
    document.focusedWindowId,
    options.windowGroupBySourceId ?? new Map(),
  );

  return Object.freeze({
    revision: document.revision,
    viewport: Object.freeze(viewport),
    windows: Object.freeze(coalesced.windows.map((window) => Object.freeze(window))),
    hiddenWindowIds: Object.freeze(hiddenWindowIds),
    focusedWindowId: coalesced.focusedWindowId,
  });
}
