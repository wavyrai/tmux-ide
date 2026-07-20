import type { WorkbenchDockTabId, WorkbenchFocusZone } from "./workbench-shell.ts";

export interface WorkbenchShortcutEvent {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const DOCK_SHORTCUTS: Readonly<Record<string, WorkbenchDockTabId>> = {
  f3: "files",
  f4: "changes",
  f6: "missions",
  f9: "activity",
};

export type WorkbenchCanvasPanel = "home" | "terminals";

const CANVAS_SHORTCUTS_BY_PANEL = {
  home: { key: "f1", label: "F1" },
  terminals: { key: "f2", label: "F2" },
} as const;

const CANVAS_SHORTCUTS: Readonly<Record<string, WorkbenchCanvasPanel>> = {
  f1: "home",
  f2: "terminals",
};

export function workbenchCanvasShortcutForPanel(panel: WorkbenchCanvasPanel) {
  return CANVAS_SHORTCUTS_BY_PANEL[panel];
}

export function workbenchCanvasPanelForShortcut(
  event: WorkbenchShortcutEvent,
): WorkbenchCanvasPanel | null {
  if (event.ctrl || event.meta || event.shift) return null;
  return CANVAS_SHORTCUTS[event.name.toLowerCase()] ?? null;
}

export function workbenchDockTabForShortcut(
  event: WorkbenchShortcutEvent,
): WorkbenchDockTabId | null {
  if (event.ctrl || event.meta || event.shift) return null;
  return DOCK_SHORTCUTS[event.name.toLowerCase()] ?? null;
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
