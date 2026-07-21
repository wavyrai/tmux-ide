import type { WorkbenchDockTabId, WorkbenchFocusZone } from "./workbench-shell.ts";
import { CANONICAL_SURFACE_REGISTRY } from "@tmux-ide/contracts";

export interface WorkbenchShortcutEvent {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type WorkbenchCanvasPanel = "home" | "terminals";

export function workbenchCanvasShortcutForPanel(panel: WorkbenchCanvasPanel) {
  const surface = CANONICAL_SURFACE_REGISTRY.find(
    (candidate) => candidate.kind === "primary-mode" && candidate.id === panel,
  )!;
  return {
    key: surface.shortcut.toLowerCase() as `f${number}`,
    label: surface.shortcut as `F${number}`,
  };
}

export function workbenchCanvasPanelForShortcut(
  event: WorkbenchShortcutEvent,
): WorkbenchCanvasPanel | null {
  if (event.ctrl || event.meta || event.shift) return null;
  const surface = CANONICAL_SURFACE_REGISTRY.find(
    (candidate) =>
      candidate.kind === "primary-mode" &&
      candidate.shortcut.toLowerCase() === event.name.toLowerCase(),
  );
  return surface ? (surface.id as WorkbenchCanvasPanel) : null;
}

export function workbenchDockTabForShortcut(
  event: WorkbenchShortcutEvent,
): WorkbenchDockTabId | null {
  if (event.ctrl || event.meta || event.shift) return null;
  const surface = CANONICAL_SURFACE_REGISTRY.find(
    (candidate) =>
      candidate.kind === "dock-tool" &&
      candidate.shortcut.toLowerCase() === event.name.toLowerCase(),
  );
  return surface ? (surface.id as WorkbenchDockTabId) : null;
}

export type WorkbenchPasteTarget = "terminal" | "files-editor" | "consume";
export type WorkbenchFocusedPanel =
  | "home"
  | "terminals"
  | "files"
  | "diff"
  | "missions"
  | "activity";

export function resolveWorkbenchPasteTarget(input: {
  focusZone: WorkbenchFocusZone;
  focusedPanel: WorkbenchFocusedPanel;
  filesEditorFocused: boolean;
  filesEditorWritable: boolean;
  terminalAvailable: boolean;
}): WorkbenchPasteTarget {
  if (
    input.focusZone !== "dock-tabs" &&
    input.focusedPanel === "files" &&
    input.filesEditorFocused &&
    input.filesEditorWritable
  ) {
    return "files-editor";
  }
  if (input.focusZone === "canvas" && input.focusedPanel === "terminals") {
    return input.terminalAvailable ? "terminal" : "consume";
  }
  return "consume";
}
