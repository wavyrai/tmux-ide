import {
  AppWindowDocumentV1SchemaZ,
  AppWindowIdSchemaZ,
  AppWindowTimestampSchemaZ,
  type AppWindowDockNodeShape,
  type AppWindowDocumentV1,
  type AppWindowInstance,
  type AppWindowRect,
} from "@tmux-ide/contracts";

import {
  focusAppWindow,
  restoreAppWindowNamedLayout,
  saveAppWindowNamedLayout,
} from "../tui/mirror/app-window-state.ts";

export const APP_WINDOW_FLOAT_MIN_WIDTH = 20;
export const APP_WINDOW_FLOAT_MIN_HEIGHT = 6;
const APP_WINDOW_COORDINATE_LIMIT = 1_000_000;

export type AppWindowKernelErrorCode =
  | "WINDOW_NOT_FOUND"
  | "STACK_NOT_FOUND"
  | "WINDOW_NOT_IN_STACK"
  | "INVALID_PLACEMENT"
  | "LAYOUT_NOT_FOUND"
  | "INVALID_INPUT"
  | "TIMESTAMP_REGRESSION";

export class AppWindowKernelError extends Error {
  readonly code: AppWindowKernelErrorCode;
  readonly path: string;

  constructor(code: AppWindowKernelErrorCode, path: string, message: string) {
    super(message);
    this.name = "AppWindowKernelError";
    this.code = code;
    this.path = path;
  }
}

export type AppWindowCommand =
  | { type: "window.focus"; windowId: string | null }
  | { type: "window.float"; windowId: string; rect?: AppWindowRect }
  | { type: "window.dock"; windowId: string; stackId?: string; index?: number }
  | { type: "window.move"; windowId: string; x: number; y: number }
  | { type: "window.resize"; windowId: string; width: number; height: number }
  | { type: "stack.activate"; stackId: string; windowId: string }
  | { type: "stack.reorder"; stackId: string; windowId: string; index: number }
  | {
      type: "layout.save";
      layoutId: string;
      name: string;
      description?: string | null;
    }
  | { type: "layout.restore"; layoutId: string }
  | { type: "layout.rename"; layoutId: string; name: string }
  | { type: "layout.delete"; layoutId: string };

export function applyAppWindowCommand(
  document: AppWindowDocumentV1,
  command: AppWindowCommand,
  timestamp: string,
): AppWindowDocumentV1 {
  const current = requireDocument(document);
  const at = requireTimestamp(current.updatedAt, timestamp);
  switch (command.type) {
    case "window.focus":
      if (command.windowId !== null) requireWindowId(current, command.windowId);
      try {
        return focusAppWindow(current, command.windowId, at);
      } catch (error) {
        throw translateStateError(error, command.windowId ? `$.windows.${command.windowId}` : "$");
      }
    case "window.float":
      return floatWindow(current, command, at);
    case "window.dock":
      return dockWindow(current, command, at);
    case "window.move":
      return moveFloatingWindow(current, command, at);
    case "window.resize":
      return resizeFloatingWindow(current, command, at);
    case "stack.activate":
      return activateStackWindow(current, command, at);
    case "stack.reorder":
      return reorderStackWindow(current, command, at);
    case "layout.save":
      try {
        return saveAppWindowNamedLayout(current, {
          id: command.layoutId,
          name: command.name,
          description: command.description,
          updatedAt: at,
        });
      } catch (error) {
        throw translateStateError(error, `$.layouts.${command.layoutId}`);
      }
    case "layout.restore":
      try {
        return restoreAppWindowNamedLayout(current, command.layoutId, at);
      } catch (error) {
        if ((error as Error).message.includes("unknown app window layout")) {
          throw new AppWindowKernelError(
            "LAYOUT_NOT_FOUND",
            `$.layouts.${command.layoutId}`,
            (error as Error).message,
          );
        }
        throw translateStateError(error, `$.layouts.${command.layoutId}`);
      }
    case "layout.rename":
      return renameLayout(current, command.layoutId, command.name, at);
    case "layout.delete":
      return deleteLayout(current, command.layoutId, at);
  }
}

/**
 * True when reapplying a semantic command would only repeat an outcome already
 * visible in the durable document. This is used after a CAS retry so commands
 * such as delete/dock do not fail merely because another writer completed the
 * same intent first.
 */
export function isAppWindowCommandSatisfied(
  document: AppWindowDocumentV1,
  command: AppWindowCommand,
): boolean {
  const current = requireDocument(document);
  switch (command.type) {
    case "window.focus": {
      if (command.windowId === null) return current.focusedWindowId === null;
      const id = requireWindowId(current, command.windowId);
      if (current.focusedWindowId !== id) return false;
      const window = current.windows[id]!;
      if (window.placement.mode === "floating") return current.floatingOrder.at(-1) === id;
      const stack = window.placement.docked
        ? findStack(current.dockRoot, window.placement.docked.stackId)
        : null;
      return stack?.activeWindowId === id;
    }
    case "window.float": {
      const id = requireWindowId(current, command.windowId);
      const window = current.windows[id]!;
      if (
        window.placement.mode !== "floating" ||
        !window.placement.floating ||
        current.focusedWindowId !== id ||
        current.floatingOrder.at(-1) !== id
      ) {
        return false;
      }
      return command.rect === undefined
        ? true
        : sameRect(window.placement.floating, normalizeRect(command.rect));
    }
    case "window.dock": {
      const id = requireWindowId(current, command.windowId);
      const window = current.windows[id]!;
      if (window.placement.mode !== "docked" || !window.placement.docked) return false;
      if (command.stackId !== undefined) {
        const stackId = requireId(command.stackId, "$.stackId");
        if (!findStack(current.dockRoot, stackId)) {
          throw new AppWindowKernelError(
            "STACK_NOT_FOUND",
            `$.dockRoot.${stackId}`,
            `unknown app window stack "${stackId}"`,
          );
        }
        if (window.placement.docked.stackId !== stackId) return false;
      }
      const stack = findStack(current.dockRoot, window.placement.docked.stackId);
      if (!stack || stack.activeWindowId !== id || current.focusedWindowId !== id) return false;
      if (command.index === undefined) return true;
      requireNonnegativeIndex(command.index, "$.index", "dock index must be nonnegative");
      return stack.windowIds.indexOf(id) === Math.min(command.index, stack.windowIds.length - 1);
    }
    case "window.move": {
      const [, , rect] = requireFloatingWindow(current, command.windowId);
      return (
        rect.x === boundedCoordinate(command.x, "$.x") &&
        rect.y === boundedCoordinate(command.y, "$.y")
      );
    }
    case "window.resize": {
      const [, , rect] = requireFloatingWindow(current, command.windowId);
      return (
        rect.width === boundedExtent(command.width, APP_WINDOW_FLOAT_MIN_WIDTH, "$.width") &&
        rect.height === boundedExtent(command.height, APP_WINDOW_FLOAT_MIN_HEIGHT, "$.height")
      );
    }
    case "stack.activate": {
      const stackId = requireId(command.stackId, "$.stackId");
      const windowId = requireWindowId(current, command.windowId);
      const stack = requireStack(current.dockRoot, stackId);
      if (!stack.windowIds.includes(windowId)) {
        throw new AppWindowKernelError(
          "WINDOW_NOT_IN_STACK",
          `$.dockRoot.${stackId}`,
          `window "${windowId}" is not in stack "${stackId}"`,
        );
      }
      return stack.activeWindowId === windowId && current.focusedWindowId === windowId;
    }
    case "stack.reorder": {
      const stackId = requireId(command.stackId, "$.stackId");
      const windowId = requireWindowId(current, command.windowId);
      const stack = requireStack(current.dockRoot, stackId);
      if (!stack.windowIds.includes(windowId)) {
        throw new AppWindowKernelError(
          "WINDOW_NOT_IN_STACK",
          `$.dockRoot.${stackId}`,
          `window "${windowId}" is not in stack "${stackId}"`,
        );
      }
      requireNonnegativeIndex(command.index, "$.index", "index must be nonnegative");
      return (
        stack.windowIds.indexOf(windowId) === Math.min(command.index, stack.windowIds.length - 1)
      );
    }
    case "layout.save": {
      const id = requireId(command.layoutId, "$.layoutId");
      const layout = Object.hasOwn(current.layouts, id) ? current.layouts[id] : null;
      return Boolean(
        layout &&
        layout.name === command.name &&
        layout.description === (command.description ?? null) &&
        current.activeLayoutId === id &&
        sameScene(layout.scene, current),
      );
    }
    case "layout.restore": {
      const id = requireId(command.layoutId, "$.layoutId");
      const layout = Object.hasOwn(current.layouts, id) ? current.layouts[id] : null;
      if (!layout) return false;
      return current.activeLayoutId === id && sameScene(layout.scene, current);
    }
    case "layout.rename": {
      const id = requireId(command.layoutId, "$.layoutId");
      const layout = Object.hasOwn(current.layouts, id) ? current.layouts[id] : null;
      return layout?.name === command.name;
    }
    case "layout.delete": {
      const id = requireId(command.layoutId, "$.layoutId");
      return !Object.hasOwn(current.layouts, id);
    }
  }
}

function floatWindow(
  current: AppWindowDocumentV1,
  command: Extract<AppWindowCommand, { type: "window.float" }>,
  timestamp: string,
): AppWindowDocumentV1 {
  const id = requireWindowId(current, command.windowId);
  const window = current.windows[id]!;
  const rect = normalizeRect(
    command.rect ?? window.placement.floating ?? { x: 2, y: 2, width: 80, height: 24 },
  );
  const windows = structuredClone(current.windows);
  windows[id] = {
    ...window,
    placement: {
      mode: "floating",
      docked: window.placement.docked,
      floating: rect,
    },
  };
  const dockRoot = removeDockWindow(current.dockRoot, id);
  syncDockMemories(windows, dockRoot);
  return finalize(current, timestamp, {
    windows,
    dockRoot,
    floatingOrder: [...current.floatingOrder.filter((candidate) => candidate !== id), id],
    focusedWindowId: id,
  });
}

function dockWindow(
  current: AppWindowDocumentV1,
  command: Extract<AppWindowCommand, { type: "window.dock" }>,
  timestamp: string,
): AppWindowDocumentV1 {
  const id = requireWindowId(current, command.windowId);
  const window = current.windows[id]!;
  const requestedStackId =
    command.stackId !== undefined
      ? requireId(command.stackId, "$.stackId")
      : window.placement.docked?.stackId;
  if (command.stackId !== undefined && !findStack(current.dockRoot, requestedStackId!)) {
    throw new AppWindowKernelError(
      "STACK_NOT_FOUND",
      `$.dockRoot.${requestedStackId}`,
      `unknown app window stack "${requestedStackId}"`,
    );
  }
  const dockRootWithoutWindow = removeDockWindow(current.dockRoot, id);
  const existingFallback = firstStackId(dockRootWithoutWindow);
  const removedFromRequestedStack =
    window.placement.mode === "docked" && window.placement.docked?.stackId === requestedStackId;
  const targetStackId =
    (requestedStackId && findStack(dockRootWithoutWindow, requestedStackId)
      ? requestedStackId
      : removedFromRequestedStack
        ? requestedStackId
        : existingFallback) ?? uniqueRootStackId(dockRootWithoutWindow);
  const rememberedIndex =
    command.index ?? window.placement.docked?.index ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(rememberedIndex) || rememberedIndex < 0) {
    throw new AppWindowKernelError(
      "INVALID_INPUT",
      "$.index",
      "dock index must be a nonnegative integer",
    );
  }
  const windows = structuredClone(current.windows);
  windows[id] = {
    ...window,
    placement: {
      mode: "docked",
      docked: { stackId: targetStackId, index: 0 },
      floating: window.placement.floating,
    },
  };
  let dockRoot = dockRootWithoutWindow
    ? insertDockWindow(dockRootWithoutWindow, targetStackId, id, rememberedIndex)
    : {
        type: "stack" as const,
        id: targetStackId,
        windowIds: [id],
        activeWindowId: id,
      };
  dockRoot = activateDockWindow(dockRoot, targetStackId, id);
  syncDockMemories(windows, dockRoot);
  return finalize(current, timestamp, {
    windows,
    dockRoot,
    floatingOrder: current.floatingOrder.filter((candidate) => candidate !== id),
    focusedWindowId: id,
  });
}

function moveFloatingWindow(
  current: AppWindowDocumentV1,
  command: Extract<AppWindowCommand, { type: "window.move" }>,
  timestamp: string,
): AppWindowDocumentV1 {
  const [id, window, rect] = requireFloatingWindow(current, command.windowId);
  return updateFloatingRect(
    current,
    id,
    window,
    {
      ...rect,
      x: boundedCoordinate(command.x, "$.x"),
      y: boundedCoordinate(command.y, "$.y"),
    },
    timestamp,
  );
}

function resizeFloatingWindow(
  current: AppWindowDocumentV1,
  command: Extract<AppWindowCommand, { type: "window.resize" }>,
  timestamp: string,
): AppWindowDocumentV1 {
  const [id, window, rect] = requireFloatingWindow(current, command.windowId);
  return updateFloatingRect(
    current,
    id,
    window,
    {
      ...rect,
      width: boundedExtent(command.width, APP_WINDOW_FLOAT_MIN_WIDTH, "$.width"),
      height: boundedExtent(command.height, APP_WINDOW_FLOAT_MIN_HEIGHT, "$.height"),
    },
    timestamp,
  );
}

function activateStackWindow(
  current: AppWindowDocumentV1,
  command: Extract<AppWindowCommand, { type: "stack.activate" }>,
  timestamp: string,
): AppWindowDocumentV1 {
  const stackId = requireId(command.stackId, "$.stackId");
  const windowId = requireWindowId(current, command.windowId);
  const stack = requireStack(current.dockRoot, stackId);
  if (!stack.windowIds.includes(windowId)) {
    throw new AppWindowKernelError(
      "WINDOW_NOT_IN_STACK",
      `$.dockRoot.${stackId}`,
      `window "${windowId}" is not in stack "${stackId}"`,
    );
  }
  return finalize(current, timestamp, {
    dockRoot: activateDockWindow(current.dockRoot!, stackId, windowId),
    focusedWindowId: windowId,
  });
}

function reorderStackWindow(
  current: AppWindowDocumentV1,
  command: Extract<AppWindowCommand, { type: "stack.reorder" }>,
  timestamp: string,
): AppWindowDocumentV1 {
  const stackId = requireId(command.stackId, "$.stackId");
  const windowId = requireWindowId(current, command.windowId);
  const stack = requireStack(current.dockRoot, stackId);
  if (!stack.windowIds.includes(windowId)) {
    throw new AppWindowKernelError(
      "WINDOW_NOT_IN_STACK",
      `$.dockRoot.${stackId}`,
      `window "${windowId}" is not in stack "${stackId}"`,
    );
  }
  if (!Number.isInteger(command.index) || command.index < 0) {
    throw new AppWindowKernelError("INVALID_INPUT", "$.index", "index must be nonnegative");
  }
  const ids = stack.windowIds.filter((candidate) => candidate !== windowId);
  ids.splice(Math.min(command.index, ids.length), 0, windowId);
  const dockRoot = replaceStack(current.dockRoot!, stackId, { ...stack, windowIds: ids });
  const windows = structuredClone(current.windows);
  syncDockMemories(windows, dockRoot);
  return finalize(current, timestamp, { windows, dockRoot });
}

function renameLayout(
  current: AppWindowDocumentV1,
  layoutId: string,
  name: string,
  timestamp: string,
): AppWindowDocumentV1 {
  const id = requireId(layoutId, "$.layoutId");
  const layout = Object.hasOwn(current.layouts, id) ? current.layouts[id] : null;
  if (!layout) {
    throw new AppWindowKernelError(
      "LAYOUT_NOT_FOUND",
      `$.layouts.${id}`,
      `unknown app window layout "${id}"`,
    );
  }
  return finalize(current, timestamp, {
    layouts: {
      ...current.layouts,
      [id]: { ...layout, name, revision: layout.revision + 1, updatedAt: timestamp },
    },
  });
}

function deleteLayout(
  current: AppWindowDocumentV1,
  layoutId: string,
  timestamp: string,
): AppWindowDocumentV1 {
  const id = requireId(layoutId, "$.layoutId");
  if (!Object.hasOwn(current.layouts, id)) {
    throw new AppWindowKernelError(
      "LAYOUT_NOT_FOUND",
      `$.layouts.${id}`,
      `unknown app window layout "${id}"`,
    );
  }
  const layouts = { ...current.layouts };
  delete layouts[id];
  return finalize(current, timestamp, {
    layouts,
    activeLayoutId: current.activeLayoutId === id ? null : current.activeLayoutId,
  });
}

function updateFloatingRect(
  current: AppWindowDocumentV1,
  id: string,
  window: AppWindowInstance,
  rect: AppWindowRect,
  timestamp: string,
): AppWindowDocumentV1 {
  return finalize(current, timestamp, {
    windows: {
      ...current.windows,
      [id]: { ...window, placement: { ...window.placement, floating: rect } },
    },
  });
}

function requireWindowId(current: AppWindowDocumentV1, value: string): string {
  const id = requireId(value, "$.windowId");
  if (!Object.hasOwn(current.windows, id)) {
    throw new AppWindowKernelError(
      "WINDOW_NOT_FOUND",
      `$.windows.${id}`,
      `unknown app window "${id}"`,
    );
  }
  return id;
}

function requireFloatingWindow(
  current: AppWindowDocumentV1,
  value: string,
): [string, AppWindowInstance, AppWindowRect] {
  const id = requireWindowId(current, value);
  const window = current.windows[id]!;
  if (window.placement.mode !== "floating" || !window.placement.floating) {
    throw new AppWindowKernelError(
      "INVALID_PLACEMENT",
      `$.windows.${id}.placement`,
      `window "${id}" is not floating`,
    );
  }
  return [id, window, window.placement.floating];
}

function requireStack(
  root: AppWindowDockNodeShape | null,
  stackId: string,
): Extract<AppWindowDockNodeShape, { type: "stack" }> {
  const stack = findStack(root, stackId);
  if (!stack) {
    throw new AppWindowKernelError(
      "STACK_NOT_FOUND",
      `$.dockRoot.${stackId}`,
      `unknown app window stack "${stackId}"`,
    );
  }
  return stack;
}

function findStack(
  node: AppWindowDockNodeShape | null,
  stackId: string,
): Extract<AppWindowDockNodeShape, { type: "stack" }> | null {
  if (!node) return null;
  if (node.type === "stack") return node.id === stackId ? node : null;
  for (const child of node.children) {
    const found = findStack(child, stackId);
    if (found) return found;
  }
  return null;
}

function firstStackId(node: AppWindowDockNodeShape | null): string | null {
  if (!node) return null;
  if (node.type === "stack") return node.id;
  return firstStackId(node.children[0] ?? null);
}

function removeDockWindow(
  node: AppWindowDockNodeShape | null,
  windowId: string,
): AppWindowDockNodeShape | null {
  if (!node) return null;
  if (node.type === "stack") {
    const index = node.windowIds.indexOf(windowId);
    if (index < 0) return node;
    const windowIds = node.windowIds.filter((candidate) => candidate !== windowId);
    if (windowIds.length === 0) return null;
    return {
      ...node,
      windowIds,
      activeWindowId:
        node.activeWindowId === windowId
          ? windowIds[Math.min(index, windowIds.length - 1)]!
          : node.activeWindowId,
    };
  }
  const pairs = node.children
    .map((child, index) => ({
      child: removeDockWindow(child, windowId),
      weight: node.weights[index]!,
    }))
    .filter(
      (pair): pair is { child: AppWindowDockNodeShape; weight: number } => pair.child !== null,
    );
  if (pairs.length === 0) return null;
  if (pairs.length === 1) return pairs[0]!.child;
  return {
    ...node,
    children: pairs.map((pair) => pair.child),
    weights: pairs.map((pair) => pair.weight),
  };
}

function insertDockWindow(
  node: AppWindowDockNodeShape,
  stackId: string,
  windowId: string,
  index: number,
): AppWindowDockNodeShape {
  if (node.type === "stack") {
    if (node.id !== stackId) return node;
    const windowIds = [...node.windowIds];
    windowIds.splice(Math.min(index, windowIds.length), 0, windowId);
    return { ...node, windowIds };
  }
  return {
    ...node,
    children: node.children.map((child) => insertDockWindow(child, stackId, windowId, index)),
  };
}

function activateDockWindow(
  node: AppWindowDockNodeShape,
  stackId: string,
  windowId: string,
): AppWindowDockNodeShape {
  if (node.type === "stack") {
    return node.id === stackId ? { ...node, activeWindowId: windowId } : node;
  }
  return {
    ...node,
    children: node.children.map((child) => activateDockWindow(child, stackId, windowId)),
  };
}

function replaceStack(
  node: AppWindowDockNodeShape,
  stackId: string,
  replacement: Extract<AppWindowDockNodeShape, { type: "stack" }>,
): AppWindowDockNodeShape {
  if (node.type === "stack") return node.id === stackId ? replacement : node;
  return {
    ...node,
    children: node.children.map((child) => replaceStack(child, stackId, replacement)),
  };
}

function syncDockMemories(
  windows: Record<string, AppWindowInstance>,
  node: AppWindowDockNodeShape | null,
): void {
  if (!node) return;
  if (node.type === "split") {
    for (const child of node.children) syncDockMemories(windows, child);
    return;
  }
  for (const [index, id] of node.windowIds.entries()) {
    const window = Object.hasOwn(windows, id) ? windows[id] : null;
    if (!window || window.placement.mode !== "docked") continue;
    windows[id] = {
      ...window,
      placement: { ...window.placement, docked: { stackId: node.id, index } },
    };
  }
}

function uniqueRootStackId(root: AppWindowDockNodeShape | null): string {
  let ordinal = 0;
  while (true) {
    const candidate = ordinal === 0 ? "stack-root" : `stack-root-${ordinal}`;
    if (!findStack(root, candidate)) return candidate;
    ordinal += 1;
  }
}

function normalizeRect(rect: AppWindowRect): AppWindowRect {
  return {
    x: boundedCoordinate(rect.x, "$.rect.x"),
    y: boundedCoordinate(rect.y, "$.rect.y"),
    width: boundedExtent(rect.width, APP_WINDOW_FLOAT_MIN_WIDTH, "$.rect.width"),
    height: boundedExtent(rect.height, APP_WINDOW_FLOAT_MIN_HEIGHT, "$.rect.height"),
  };
}

function sameRect(left: AppWindowRect, right: AppWindowRect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function sameScene(
  left: {
    windows: AppWindowDocumentV1["windows"];
    dockRoot: AppWindowDocumentV1["dockRoot"];
    dockState: AppWindowDocumentV1["dockState"];
    floatingOrder: AppWindowDocumentV1["floatingOrder"];
    focusedWindowId: AppWindowDocumentV1["focusedWindowId"];
  },
  right: AppWindowDocumentV1,
): boolean {
  return (
    JSON.stringify({
      windows: left.windows,
      dockRoot: left.dockRoot,
      dockState: left.dockState,
      floatingOrder: left.floatingOrder,
      focusedWindowId: left.focusedWindowId,
    }) ===
    JSON.stringify({
      windows: right.windows,
      dockRoot: right.dockRoot,
      dockState: right.dockState,
      floatingOrder: right.floatingOrder,
      focusedWindowId: right.focusedWindowId,
    })
  );
}

function requireNonnegativeIndex(value: number, path: string, message: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppWindowKernelError("INVALID_INPUT", path, message);
  }
}

function boundedCoordinate(value: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new AppWindowKernelError("INVALID_INPUT", path, "coordinate must be finite");
  }
  return Math.max(-APP_WINDOW_COORDINATE_LIMIT, Math.min(APP_WINDOW_COORDINATE_LIMIT, value));
}

function boundedExtent(value: number, minimum: number, path: string): number {
  if (!Number.isFinite(value)) {
    throw new AppWindowKernelError("INVALID_INPUT", path, "extent must be finite");
  }
  return Math.max(minimum, Math.min(APP_WINDOW_COORDINATE_LIMIT, value));
}

function requireTimestamp(previous: string, value: string): string {
  let timestamp: string;
  try {
    timestamp = AppWindowTimestampSchemaZ.parse(value);
  } catch (error) {
    throw translateStateError(error, "$.timestamp");
  }
  if (Date.parse(timestamp) < Date.parse(previous)) {
    throw new AppWindowKernelError(
      "TIMESTAMP_REGRESSION",
      "$.updatedAt",
      "app window mutation timestamp must not move backwards",
    );
  }
  return timestamp;
}

function requireDocument(value: AppWindowDocumentV1): AppWindowDocumentV1 {
  try {
    return AppWindowDocumentV1SchemaZ.parse(value);
  } catch (error) {
    throw translateStateError(error, "$");
  }
}

function requireId(value: string, path: string): string {
  try {
    return AppWindowIdSchemaZ.parse(value);
  } catch (error) {
    throw translateStateError(error, path);
  }
}

function finalize(
  current: AppWindowDocumentV1,
  timestamp: string,
  patch: Partial<AppWindowDocumentV1>,
): AppWindowDocumentV1 {
  try {
    return AppWindowDocumentV1SchemaZ.parse({
      ...current,
      ...patch,
      version: current.version,
      revision: current.revision + 1,
      updatedAt: timestamp,
    });
  } catch (error) {
    throw translateStateError(error, "$");
  }
}

function translateStateError(error: unknown, path: string): AppWindowKernelError {
  if (error instanceof AppWindowKernelError) return error;
  const message = (error as Error).message;
  return new AppWindowKernelError("INVALID_INPUT", path, message);
}
