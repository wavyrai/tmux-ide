import type { AgentActivity } from "@tmux-ide/contracts";

import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { MIN_PANE, type ResizeGuideRect } from "../resize-model.ts";
import { clipTerminal } from "../terminal-text.ts";
import { nativePaneResizeCells } from "./pane-resize-geometry.ts";
import type { OpenTuiPaneFrame } from "./terminal-layout-projection.ts";

export interface ApplicationTerminalAgentIndicator {
  readonly name: string;
  readonly activity: AgentActivity;
  readonly attention: boolean;
}

export interface ApplicationPaneResizePreview {
  readonly semanticPaneId: string;
  readonly axis: "cols" | "rows";
  readonly cells: number;
  readonly guide: ResizeGuideRect;
  /** Exact renderer-global guide cells after nested shell/canvas projection. */
  readonly globalGuide?: ResizeGuideRect;
  readonly pointerIngress?: {
    readonly gestureId: string;
    readonly traceId: string;
    readonly action: "down" | "drag" | "up";
    readonly x: number;
    readonly y: number;
    readonly atMicros: number;
  };
}

export interface ApplicationPaneSeparator {
  readonly axis: "x" | "y";
  readonly position: number;
  readonly start: number;
  readonly end: number;
  readonly paneId: string;
  readonly initialCells: number;
  readonly siblingCells: number;
}

export function terminalAgentStatusLabel(activity: AgentActivity): string {
  switch (activity) {
    case "running":
      return "WORKING";
    case "waiting":
      return "BLOCKED";
    case "complete":
      return "DONE";
    case "failed":
      return "FAILED";
    case "disconnected":
      return "UNKNOWN";
    case "idle":
      return "IDLE";
  }
}

function labelWithReservedStatus(
  marker: string,
  title: string,
  status: string | null,
  attention: boolean,
  width: number,
): string {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return "";
  if (!status) return clipTerminal(`${marker} ${title}`, safeWidth);
  const suffix = `${attention ? " !" : ""} [${status}]`;
  if (safeWidth <= suffix.length + 2) return clipTerminal(`${marker} ${status}`, safeWidth);
  const titleWidth = Math.max(1, safeWidth - marker.length - 1 - suffix.length);
  return clipTerminal(`${marker} ${clipTerminal(title, titleWidth)}${suffix}`, safeWidth);
}

export function terminalPaneChromeLabel(
  paneId: string,
  focused: boolean,
  width: number,
  indicator?: ApplicationTerminalAgentIndicator,
  displayName?: string | null,
  displayNameSource?: "manual" | "agent" | "process" | "title" | "generated" | null,
): string {
  const title = terminalPaneDisplayTitle(paneId, indicator, displayName, displayNameSource);
  return labelWithReservedStatus(
    focused ? "●" : "○",
    title,
    indicator ? terminalAgentStatusLabel(indicator.activity) : null,
    indicator?.attention === true,
    width,
  );
}

export function terminalPaneDisplayTitle(
  paneId: string,
  indicator?: ApplicationTerminalAgentIndicator,
  displayName?: string | null,
  displayNameSource?: "manual" | "agent" | "process" | "title" | "generated" | null,
): string {
  const presentedName = displayName?.trim() || paneId;
  return indicator
    ? displayNameSource === "manual" && presentedName !== indicator.name.trim()
      ? `${presentedName} · ${indicator.name.trim()}`
      : indicator.name.trim() || presentedName
    : presentedName;
}

export function terminalWindowTitle(
  window: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
): string {
  return window.windowName ?? window.semanticWindowId ?? "window";
}

export function terminalWindowPane(
  window: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
): string | null {
  return (
    window.panes.find((pane) => pane.active && pane.pane)?.pane ??
    window.panes.find((pane) => pane.pane)?.pane ??
    null
  );
}

export function retainedTerminalWindowKey(
  window: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
): string | null {
  return window.semanticWindowId ?? terminalWindowPane(window);
}

const AGENT_ACTIVITY_PRIORITY: Readonly<Record<AgentActivity, number>> = Object.freeze({
  failed: 6,
  waiting: 5,
  running: 4,
  disconnected: 3,
  complete: 2,
  idle: 1,
});

export function terminalWindowAgentIndicator(
  window: OpenTuiWorkspaceLayoutSnapshot["windows"][number],
  indicators: ReadonlyMap<string, ApplicationTerminalAgentIndicator>,
): Pick<ApplicationTerminalAgentIndicator, "activity" | "attention"> | undefined {
  let selected: AgentActivity | undefined;
  let attention = false;
  for (const pane of window.panes) {
    if (!pane.pane) continue;
    const indicator = indicators.get(pane.pane);
    const activity = indicator?.activity;
    attention ||= indicator?.attention === true;
    if (
      activity &&
      (selected === undefined ||
        AGENT_ACTIVITY_PRIORITY[activity] > AGENT_ACTIVITY_PRIORITY[selected])
    )
      selected = activity;
  }
  return selected ? { activity: selected, attention } : undefined;
}

export function terminalPaneSeparatorAt(
  frames: readonly OpenTuiPaneFrame[],
  paneBorderStatus: "top" | "bottom" | "off",
  x: number,
  y: number,
): ApplicationPaneSeparator | null {
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        y >= Math.max(before.top, candidate.top) &&
        y < Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (after && x === before.left + before.width)
      return Object.freeze({
        axis: "x",
        position: before.left + before.width,
        start: Math.max(before.top, after.top),
        end: Math.min(before.top + before.height, after.top + after.height),
        paneId: before.paneId,
        initialCells: before.width,
        siblingCells: after.width,
      });
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top === before.top + before.height + 1 &&
        x >= Math.max(before.left, candidate.left) &&
        x < Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (after && y === before.top + before.height) {
      const initialCells = nativePaneResizeCells(before, "rows", paneBorderStatus);
      const siblingCells = nativePaneResizeCells(after, "rows", paneBorderStatus);
      if (initialCells === null || siblingCells === null) return null;
      return Object.freeze({
        axis: "y",
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells,
        siblingCells,
      });
    }
  }
  return null;
}

export function terminalPaneSeparators(
  frames: readonly OpenTuiPaneFrame[],
  paneBorderStatus: "top" | "bottom" | "off",
): readonly ApplicationPaneSeparator[] {
  const separators: ApplicationPaneSeparator[] = [];
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.left === before.left + before.width + 1 &&
        Math.max(before.top, candidate.top) <
          Math.min(before.top + before.height, candidate.top + candidate.height),
    );
    if (after)
      separators.push({
        axis: "x",
        position: before.left + before.width,
        start: Math.max(before.top, after.top),
        end: Math.min(before.top + before.height, after.top + after.height),
        paneId: before.paneId,
        initialCells: before.width,
        siblingCells: after.width,
      });
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top === before.top + before.height + 1 &&
        Math.max(before.left, candidate.left) <
          Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (!after) continue;
    const initialCells = nativePaneResizeCells(before, "rows", paneBorderStatus);
    const siblingCells = nativePaneResizeCells(after, "rows", paneBorderStatus);
    if (initialCells !== null && siblingCells !== null)
      separators.push({
        axis: "y",
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells,
        siblingCells,
      });
  }
  return Object.freeze(separators);
}

export function terminalPaneResizePreview(
  separator: ApplicationPaneSeparator,
  pointer: number,
  origin: number,
): ApplicationPaneResizePreview {
  const total = separator.initialCells + separator.siblingCells;
  const cells = Math.max(
    MIN_PANE,
    Math.min(total - MIN_PANE, separator.initialCells + pointer - origin),
  );
  const delta = cells - separator.initialCells;
  return Object.freeze({
    semanticPaneId: separator.paneId,
    axis: separator.axis === "x" ? "cols" : "rows",
    cells,
    guide:
      separator.axis === "x"
        ? Object.freeze({
            x: separator.position + delta,
            y: separator.start,
            width: 1,
            height: Math.max(1, separator.end - separator.start),
          })
        : Object.freeze({
            x: separator.start,
            y: separator.position + delta,
            width: Math.max(1, separator.end - separator.start),
            height: 1,
          }),
  });
}
