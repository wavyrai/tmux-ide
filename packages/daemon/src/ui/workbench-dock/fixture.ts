import {
  projectWorkbenchShell,
  type WorkbenchShellInput,
  type WorkbenchShellProjection,
} from "../../tui/mirror/workspace/workbench-shell.ts";
import type {
  WorkbenchDockHostActionId,
  WorkbenchDockHostMode,
  WorkbenchDockHostTabId,
} from "./presenter.tsx";

export function createWorkbenchDockHostFixture(
  overrides: Partial<WorkbenchShellInput> = {},
): WorkbenchShellProjection {
  return projectWorkbenchShell({
    width: 80,
    height: 24,
    dockMode: "open",
    persistedDockHeight: 8,
    activeDockTab: "missions",
    focusZone: "dock-tabs",
    hoveredDockTab: null,
    attentionDockTabs: new Set(["activity"]),
    disabledDockTabs: new Set(["changes"]),
    ...overrides,
  });
}

export const WORKBENCH_DOCK_HOST_ACTIONS = [
  { kind: "tab", id: "files" },
  { kind: "action", id: "toggle-collapse" },
  { kind: "action", id: "toggle-maximize" },
] as const;

export const EXPECTED_WORKBENCH_DOCK_HOST_TRACE = [
  "tab:files",
  "action:toggle-collapse:collapsed",
  "action:toggle-maximize:maximized",
] as const;

export function createWorkbenchDockHostTrace() {
  const calls: string[] = [];
  return {
    calls,
    onTabActivate(tabId: WorkbenchDockHostTabId) {
      calls.push(`tab:${tabId}`);
    },
    onActionActivate(actionId: WorkbenchDockHostActionId, nextMode: WorkbenchDockHostMode) {
      calls.push(`action:${actionId}:${nextMode}`);
    },
  };
}
