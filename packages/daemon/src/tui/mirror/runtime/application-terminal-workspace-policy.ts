import type { WindowLinkTarget } from "@tmux-ide/contracts";
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
  readonly nativeCellsPerDisplayCell?: number;
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
      return "DISCONNECTED";
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

function resizeScale(before: OpenTuiPaneFrame, after: OpenTuiPaneFrame, axis: "x" | "y") {
  const native =
    axis === "x"
      ? (before.nativeWidth ?? before.width) + (after.nativeWidth ?? after.width)
      : (before.nativeHeight ?? before.contentHeight) + (after.nativeHeight ?? after.contentHeight);
  const displayed =
    axis === "x" ? before.width + after.width : before.contentHeight + after.contentHeight;
  return native === displayed ? {} : { nativeCellsPerDisplayCell: native / displayed };
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
        initialCells: before.nativeWidth ?? before.width,
        siblingCells: after.nativeWidth ?? after.width,
        ...resizeScale(before, after, "x"),
      });
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top ===
          before.top + before.height + (before.nativeHeight === undefined ? 1 : 0) &&
        x >= Math.max(before.left, candidate.left) &&
        x < Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (
      after &&
      y === before.top + before.height &&
      (before.nativeHeight === undefined || x === Math.max(before.left, after.left))
    ) {
      const initialCells =
        before.nativeHeight ?? nativePaneResizeCells(before, "rows", paneBorderStatus);
      const siblingCells =
        after.nativeHeight ?? nativePaneResizeCells(after, "rows", paneBorderStatus);
      if (initialCells === null || siblingCells === null) return null;
      return Object.freeze({
        axis: "y",
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells,
        siblingCells,
        ...resizeScale(before, after, "y"),
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
        initialCells: before.nativeWidth ?? before.width,
        siblingCells: after.nativeWidth ?? after.width,
        ...resizeScale(before, after, "x"),
      });
  }
  for (const before of frames) {
    const after = frames.find(
      (candidate) =>
        candidate.top ===
          before.top + before.height + (before.nativeHeight === undefined ? 1 : 0) &&
        Math.max(before.left, candidate.left) <
          Math.min(before.left + before.width, candidate.left + candidate.width),
    );
    if (!after) continue;
    const initialCells =
      before.nativeHeight ?? nativePaneResizeCells(before, "rows", paneBorderStatus);
    const siblingCells =
      after.nativeHeight ?? nativePaneResizeCells(after, "rows", paneBorderStatus);
    if (initialCells !== null && siblingCells !== null)
      separators.push({
        axis: "y",
        position: before.top + before.height,
        start: Math.max(before.left, after.left),
        end: Math.min(before.left + before.width, after.left + after.width),
        paneId: before.paneId,
        initialCells,
        siblingCells,
        ...resizeScale(before, after, "y"),
      });
  }
  return Object.freeze(separators);
}

/** Highlight the observed divider, never the pointer's unconfirmed target. */
export function terminalPaneObservedResizeGuide(
  frames: readonly OpenTuiPaneFrame[],
  paneBorderStatus: "top" | "bottom" | "off",
  preview: ApplicationPaneResizePreview,
): ResizeGuideRect | null {
  const separator = terminalPaneSeparators(frames, paneBorderStatus).find(
    (candidate) =>
      candidate.paneId === preview.semanticPaneId &&
      candidate.axis === (preview.axis === "cols" ? "x" : "y"),
  );
  return separator
    ? terminalPaneResizePreview(separator, separator.position, separator.position).guide
    : null;
}

export function terminalPaneResizePreview(
  separator: ApplicationPaneSeparator,
  pointer: number,
  origin: number,
): ApplicationPaneResizePreview {
  const scale = separator.nativeCellsPerDisplayCell ?? 1;
  const total = separator.initialCells + separator.siblingCells;
  const cells = Math.max(
    MIN_PANE,
    Math.min(total - MIN_PANE, separator.initialCells + Math.round((pointer - origin) * scale)),
  );
  const delta = Math.round((cells - separator.initialCells) / scale);
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

/** Resolve only live opaque observations; native indexes are display metadata. */
export function windowLinkTarget(
  snapshot: OpenTuiWorkspaceLayoutSnapshot,
  linkId: string,
): WindowLinkTarget | null {
  const topology = snapshot.windowLinks;
  const link = topology?.links.find((candidate) => candidate.linkId === linkId);
  if (!topology || !link) return null;
  return {
    liveSessionId: topology.liveSessionId,
    linkRevision: topology.linkRevision,
    linkId: link.linkId,
    expectedSemanticWindowId: link.semanticWindowId,
  };
}

/** Pane navigation within the active link must not silently choose a sibling link. */
export function windowLinkForPane(
  snapshot: OpenTuiWorkspaceLayoutSnapshot,
  paneId: string,
): WindowLinkTarget | null {
  const backing = snapshot.windows.find((window) =>
    window.panes.some((pane) => pane.pane === paneId),
  );
  const topology = snapshot.windowLinks;
  if (!backing || !topology) return null;
  const links = topology.links.filter((link) => link.semanticWindowId === backing.semanticWindowId);
  const link =
    links.find((candidate) => candidate.linkId === topology.activeLinkId) ??
    (links.length === 1 ? links[0] : undefined);
  return link ? windowLinkTarget(snapshot, link.linkId) : null;
}

/** Root composition for backing zoom and link actions, all restoring host focus. */
export function terminalWindowActionCallbacks(
  controller: Pick<
    import("./application-terminal-interaction-controller.ts").ApplicationTerminalInteractionController,
    "selectWindowLink" | "unlinkWindowLink" | "zoomPane" | "selectPane"
  >,
  notify: (message: string) => void,
  recover: import("./application-host-focus-presentation.ts").ApplicationHostFocusRecovery,
  cancelNavigation: () => void,
) {
  return {
    onSelectPane: recover((paneId: string) => {
      cancelNavigation();
      controller.selectPane(paneId);
    }),
    onZoomPane: recover((paneId?: string) => {
      void controller.zoomPane(paneId).then(notify);
    }),
    onSelectWindowLink: recover((target: WindowLinkTarget) => {
      cancelNavigation();
      void controller.selectWindowLink(target);
    }),
    onUnlinkWindowLink: recover((target: WindowLinkTarget) => {
      void controller.unlinkWindowLink(target).then(notify);
    }),
  };
}
