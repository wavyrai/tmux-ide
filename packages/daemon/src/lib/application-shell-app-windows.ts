import {
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
import { openProjectRuntimeRepository } from "./project-runtime-repository.ts";
import { stableAppWindowInstanceId } from "../tui/mirror/app-window-state.ts";

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
  const uniqueSourceIds = [...new Set(terminalSourceIds)];
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
  const service = new AppWindowService(runtime, {
    now: () => now,
    migration: { terminalSourceIds, focusedTerminalSourceId },
  });
  const loaded = service.load();
  if (loaded.revision !== null || loaded.writeProtected || terminalSourceIds.length === 0) {
    return loaded.document;
  }
  const initial = initialApplicationShellAppWindows(
    terminalSourceIds,
    focusedTerminalSourceId,
    now,
  );
  try {
    return writeAppWindowDocument(runtime, null, initial).document;
  } catch (error) {
    if (error instanceof AppWindowRepositoryError && error.code === "REVISION_CONFLICT") {
      return service.load().document;
    }
    throw error;
  }
}
