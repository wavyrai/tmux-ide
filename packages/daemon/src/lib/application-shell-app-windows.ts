import {
  APP_WINDOW_MAX_WINDOWS,
  AppWindowDocumentV1SchemaZ,
  type AppWindowDockNodeShape,
  type AppWindowDocumentV1,
  type AppWindowInstance,
} from "@tmux-ide/contracts";

import {
  AppWindowRepositoryError,
  AppWindowService,
  writeAppWindowDocument,
} from "./app-window-repository.ts";
import {
  openProjectRuntimeRepository,
  type ProjectRuntimeRepository,
} from "./project-runtime-repository.ts";
import { focusAppWindow, stableAppWindowInstanceId } from "../tui/mirror/app-window-state.ts";

const MAX_SPLIT_CHILDREN = 8;

function dockTree(stackNodes: readonly AppWindowDockNodeShape[]): AppWindowDockNodeShape | null {
  if (stackNodes.length === 0) return null;
  let level = [...stackNodes];
  let depth = 0;
  while (level.length > 1) {
    const next: AppWindowDockNodeShape[] = [];
    for (let index = 0; index < level.length; index += MAX_SPLIT_CHILDREN) {
      const children = level.slice(index, index + MAX_SPLIT_CHILDREN);
      if (children.length === 1) {
        next.push(children[0]!);
        continue;
      }
      next.push({
        type: "split",
        id: `split.terminals.${depth}.${Math.floor(index / MAX_SPLIT_CHILDREN)}`,
        axis: depth % 2 === 0 ? "horizontal" : "vertical",
        children,
        weights: children.map(() => 1),
      });
    }
    level = next;
    depth += 1;
  }
  return level[0]!;
}

/** First-run durable layout; every terminal gets its own visible dock leaf. */
export function initialApplicationShellAppWindows(
  terminalSourceIds: readonly string[],
  focusedTerminalSourceId: string | null,
  updatedAt: string,
): AppWindowDocumentV1 {
  const uniqueSourceIds = [...new Set(terminalSourceIds)]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, APP_WINDOW_MAX_WINDOWS);
  const windows: Record<string, AppWindowInstance> = {};
  const windowIdBySourceId = new Map<string, string>();
  const stacks = uniqueSourceIds.map((terminalSourceId, index): AppWindowDockNodeShape => {
    const source = { kind: "terminal" as const, terminalSourceId };
    const windowId = stableAppWindowInstanceId(source);
    const stackId = `stack.terminal.${index}`;
    windowIdBySourceId.set(terminalSourceId, windowId);
    windows[windowId] = {
      id: windowId,
      source,
      title: null,
      placement: {
        mode: "docked",
        docked: { stackId, index: 0 },
        floating: {
          x: 32 + (index % 4) * 28,
          y: 32 + (index % 4) * 24,
          width: 720,
          height: 440,
        },
      },
    };
    return { type: "stack", id: stackId, windowIds: [windowId], activeWindowId: windowId };
  });
  return AppWindowDocumentV1SchemaZ.parse({
    version: 1,
    revision: 0,
    updatedAt,
    windows,
    dockRoot: dockTree(stacks),
    dockState: { mode: "collapsed", preferredHeight: null, focusZone: "canvas" },
    floatingOrder: [],
    focusedWindowId:
      (focusedTerminalSourceId && windowIdBySourceId.get(focusedTerminalSourceId)) ??
      (uniqueSourceIds[0] ? windowIdBySourceId.get(uniqueSourceIds[0]) : undefined) ??
      null,
    activeLayoutId: null,
    layouts: {},
  });
}

function terminalWindowIdBySourceId(document: AppWindowDocumentV1): ReadonlyMap<string, string> {
  return new Map(
    Object.values(document.windows).flatMap((window) =>
      window.source.kind === "terminal"
        ? [[window.source.terminalSourceId, window.id] as const]
        : [],
    ),
  );
}

/**
 * Preserve every existing placement and admit newly discovered terminals as
 * floating cards. Sorting before the bounded slice makes overload behavior
 * deterministic, while never evicting durable windows to make room.
 */
export function reconcileApplicationShellAppWindows(
  document: AppWindowDocumentV1,
  terminalSourceIds: readonly string[],
  focusedTerminalSourceId: string | null,
  updatedAt: string,
): AppWindowDocumentV1 {
  const current = AppWindowDocumentV1SchemaZ.parse(document);
  const timestamp =
    Date.parse(updatedAt) < Date.parse(current.updatedAt) ? current.updatedAt : updatedAt;
  const sourceMap = terminalWindowIdBySourceId(current);
  const capacity = Math.max(0, APP_WINDOW_MAX_WINDOWS - Object.keys(current.windows).length);
  const admittedSourceIds = [...new Set(terminalSourceIds)]
    .filter((sourceId) => !sourceMap.has(sourceId))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, capacity);
  // Preserve the caller's identity for a semantic no-op. Schema parsing
  // intentionally clones the document; returning that clone would make the
  // repository reconciliation loop mistake every repeat load for a mutation
  // and attempt to persist an unchanged domain revision.
  if (admittedSourceIds.length === 0) return document;

  const windows = structuredClone(current.windows);
  const floatingOrder = [...current.floatingOrder];
  const nextSourceMap = new Map(sourceMap);
  for (const [index, terminalSourceId] of admittedSourceIds.entries()) {
    const source = { kind: "terminal" as const, terminalSourceId };
    const windowId = stableAppWindowInstanceId(source);
    nextSourceMap.set(terminalSourceId, windowId);
    windows[windowId] = {
      id: windowId,
      source,
      title: null,
      placement: {
        mode: "floating",
        docked: null,
        floating: {
          x: 32 + (index % 6) * 28,
          y: 32 + (index % 6) * 24,
          width: 720,
          height: 440,
        },
      },
    };
    floatingOrder.push(windowId);
  }

  const requestedFocusId = focusedTerminalSourceId
    ? (nextSourceMap.get(focusedTerminalSourceId) ?? null)
    : null;
  const focusId = requestedFocusId ?? current.focusedWindowId ?? floatingOrder[0] ?? null;
  const added = AppWindowDocumentV1SchemaZ.parse({
    ...current,
    windows,
    floatingOrder:
      current.focusedWindowId && windows[current.focusedWindowId]?.placement.mode === "floating"
        ? [
            ...floatingOrder.filter((windowId) => windowId !== current.focusedWindowId),
            current.focusedWindowId,
          ]
        : floatingOrder,
    revision: current.revision,
    updatedAt: timestamp,
    activeLayoutId: null,
  });
  return focusAppWindow(added, focusId, timestamp);
}

/**
 * Load the canonical persisted scene. A genuinely new project receives one
 * durable, CAS-protected first-run layout instead of a renderer-owned grid.
 */
export async function loadApplicationShellAppWindows(
  projectDir: string,
  terminalSourceIds: readonly string[],
  focusedTerminalSourceId: string | null,
): Promise<AppWindowDocumentV1> {
  const now = new Date().toISOString();
  const runtime = await openProjectRuntimeRepository(projectDir);
  return reconcileApplicationShellAppWindowRepository(
    runtime,
    terminalSourceIds,
    focusedTerminalSourceId,
    now,
  );
}

export function reconcileApplicationShellAppWindowRepository(
  runtime: ProjectRuntimeRepository,
  terminalSourceIds: readonly string[],
  focusedTerminalSourceId: string | null,
  now: string,
): AppWindowDocumentV1 {
  const service = new AppWindowService(runtime, {
    now: () => now,
    migration: { terminalSourceIds, focusedTerminalSourceId },
  });
  const loaded = service.load();
  if (loaded.writeProtected || terminalSourceIds.length === 0) {
    return loaded.document;
  }
  let current = loaded;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const next =
      current.revision === null
        ? initialApplicationShellAppWindows(terminalSourceIds, focusedTerminalSourceId, now)
        : reconcileApplicationShellAppWindows(
            current.document,
            terminalSourceIds,
            focusedTerminalSourceId,
            now,
          );
    if (next === current.document) return current.document;
    try {
      return writeAppWindowDocument(runtime, current.revision, next).document;
    } catch (error) {
      if (error instanceof AppWindowRepositoryError && error.code === "REVISION_CONFLICT") {
        current = service.load();
        if (current.writeProtected) return current.document;
        continue;
      }
      throw error;
    }
  }
  return service.load().document;
}
