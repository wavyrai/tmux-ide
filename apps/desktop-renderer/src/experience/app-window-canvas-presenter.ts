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

/**
 * Pure durable-scene -> terminal canvas projection. Native dock/window nodes
 * are pruned before split allocation because those surfaces remain owned by
 * the native workbench in this first canvas slice.
 */
export function projectAppWindowCanvas(
  value: AppWindowDocumentV1,
  requestedViewport: AppWindowCanvasViewport,
  options: { readonly gap?: number } = {},
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

  return Object.freeze({
    revision: document.revision,
    viewport: Object.freeze(viewport),
    windows: Object.freeze(windows.map((window) => Object.freeze(window))),
    hiddenWindowIds: Object.freeze(hiddenWindowIds),
    focusedWindowId: document.focusedWindowId,
  });
}
