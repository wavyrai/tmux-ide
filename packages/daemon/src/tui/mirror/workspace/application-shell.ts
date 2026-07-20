import type { HostedPanelView } from "../panel-host.ts";
import {
  shellChromeLayout,
  shellSidebarHint,
  shellSurfaceTabs,
  type ShellChromeLayout,
  type ShellSidebarHint,
  type ShellTabPresentation,
} from "../shell-chrome.ts";
import type { Rect } from "../recipes.ts";

export interface ApplicationShellSession {
  name: string;
  status: "idle" | "working" | "blocked" | "done" | "unknown";
}

export interface ApplicationShellInput {
  width: number;
  height: number;
  preferredSidebarWidth: number;
  views: readonly HostedPanelView[];
  activeViewId: string;
  hoveredTabIndex: number | null;
  attentionViewIds?: ReadonlySet<string>;
  sessions: readonly ApplicationShellSession[];
  activeSession: string;
  quitHint: string;
}

export interface ApplicationShellProjection {
  layout: ShellChromeLayout;
  content: Rect;
  views: readonly HostedPanelView[];
  tabs: readonly ShellTabPresentation[];
  sidebarHint: ShellSidebarHint;
  sessions: readonly ApplicationShellSession[];
  activeSession: string;
  activeViewId: string;
}

export type ApplicationShellHit =
  | { kind: "view"; viewId: string; index: number }
  | { kind: "session"; session: string; index: number }
  | { kind: "palette" }
  | null;

/** Pure application-shell geometry. Runtime stores and tmux never enter here. */
export function projectApplicationShell(input: ApplicationShellInput): ApplicationShellProjection {
  const layout = shellChromeLayout(input.width, input.height, input.preferredSidebarWidth);
  const contentHeight = Math.max(0, layout.main.height - layout.status.height);
  return {
    layout,
    content: {
      x: layout.main.x,
      y: layout.main.y,
      width: layout.main.width,
      height: contentHeight,
    },
    views: input.views,
    tabs: shellSurfaceTabs(
      input.views,
      input.activeViewId,
      layout.variant,
      input.hoveredTabIndex,
      input.attentionViewIds,
    ),
    sidebarHint: shellSidebarHint(layout.variant, input.quitHint, layout.sidebar.width),
    sessions: input.sessions,
    activeSession: input.activeSession,
    activeViewId: input.activeViewId,
  };
}

/**
 * One coordinate router for shell chrome. Surface/pane hit testing remains with
 * the active surface and the root application controller.
 */
export function applicationShellHitTest(
  projection: ApplicationShellProjection,
  x: number,
  y: number,
): ApplicationShellHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (cellX < 0 || cellY < 0 || cellX >= projection.layout.width) return null;

  if (cellY === projection.layout.tabbar.y && projection.layout.tabbar.height > 0) {
    const index = projection.tabs.findIndex(
      (tab) => cellX >= tab.span.start && cellX < tab.span.start + tab.span.width,
    );
    const tab = projection.tabs[index];
    return tab ? { kind: "view", viewId: tab.id, index } : null;
  }

  const sidebar = projection.layout.sidebar;
  if (
    cellX < sidebar.x ||
    cellX >= sidebar.x + sidebar.width ||
    cellY < sidebar.y ||
    cellY >= sidebar.y + sidebar.height
  ) {
    return null;
  }

  const hintRow = sidebar.y + sidebar.height - 1;
  const hint = projection.sidebarHint;
  if (
    cellY === hintRow &&
    cellX >= sidebar.x + hint.buttonSpan.start &&
    cellX < sidebar.x + hint.buttonSpan.start + hint.buttonSpan.width
  ) {
    return { kind: "palette" };
  }

  const sessionIndex = cellY - sidebar.y - 1;
  const session = projection.sessions[sessionIndex];
  return session ? { kind: "session", session: session.name, index: sessionIndex } : null;
}
