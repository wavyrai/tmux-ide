import type { ApplicationShellProjectionV1 } from "@tmux-ide/contracts";
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
import { workspaceIcon } from "./icons.ts";

export interface ApplicationShellInput {
  width: number;
  height: number;
  preferredSidebarWidth: number;
  shell: ApplicationShellProjectionV1;
  hoveredTabIndex: number | null;
  quitHint: string;
}

export interface ApplicationShellProjection {
  layout: ShellChromeLayout;
  content: Rect;
  semantic: ApplicationShellProjectionV1;
  views: readonly HostedPanelView[];
  tabs: readonly ShellTabPresentation[];
  sidebarHint: ShellSidebarHint;
  sessions: readonly {
    name: string;
    status: "idle" | "working" | "blocked" | "done" | "unknown";
  }[];
  activeSession: string;
  activeViewId: string;
}

export type ApplicationShellHit =
  | { kind: "view"; viewId: "home" | "terminals"; index: number }
  | { kind: "session"; session: string; index: number }
  | { kind: "palette" }
  | { kind: "status-strip" }
  | null;

function sessionStatus(
  state: ApplicationShellProjectionV1["sidebar"]["sessions"][number]["state"],
): "idle" | "working" | "blocked" | "done" | "unknown" {
  if (state === "connected") return "idle";
  if (state === "reconnecting") return "blocked";
  return "unknown";
}

/** Host geometry around the one renderer-neutral application-shell projection. */
export function projectApplicationShell(input: ApplicationShellInput): ApplicationShellProjection {
  const layout = shellChromeLayout(input.width, input.height, input.preferredSidebarWidth);
  const contentHeight = Math.max(0, layout.main.height - layout.status.height);
  const views: HostedPanelView[] = input.shell.primaryNavigation.items.map((surface) => ({
    id: surface.id,
    title: surface.label,
    panel: surface.id as "home" | "terminals",
    layout: null,
    glyph: workspaceIcon(surface.icon),
    order: surface.order,
    shortcut: {
      key: surface.shortcut.toLowerCase() as `f${number}`,
      label: surface.shortcut as `F${number}`,
    },
  }));
  const activeSession =
    input.shell.sidebar.sessions.find(
      (session) => session.id === input.shell.sidebar.activeSessionId,
    )?.label ??
    input.shell.sidebar.sessions[0]?.label ??
    "workspace";
  return {
    layout,
    content: {
      x: layout.main.x,
      y: layout.main.y,
      width: layout.main.width,
      height: contentHeight,
    },
    semantic: input.shell,
    views,
    tabs: shellSurfaceTabs(
      views,
      input.shell.primaryNavigation.activeMode,
      layout.variant,
      input.hoveredTabIndex,
      new Set(
        input.shell.primaryNavigation.items
          .filter(({ attention }) => attention)
          .map(({ id }) => id),
      ),
    ),
    sidebarHint: shellSidebarHint(layout.variant, input.quitHint, layout.sidebar.width),
    sessions: input.shell.sidebar.sessions.map((session) => ({
      name: session.label,
      status: sessionStatus(session.state),
    })),
    activeSession,
    activeViewId: input.shell.primaryNavigation.activeMode,
  };
}

/** One coordinate router for chrome owned by the application shell. */
export function applicationShellHitTest(
  projection: ApplicationShellProjection,
  x: number,
  y: number,
): ApplicationShellHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (
    cellX < 0 ||
    cellY < 0 ||
    cellX >= projection.layout.width ||
    cellY >= projection.layout.height
  ) {
    return null;
  }

  if (cellY === projection.layout.tabbar.y && projection.layout.tabbar.height > 0) {
    const index = projection.tabs.findIndex(
      (tab) => cellX >= tab.span.start && cellX < tab.span.start + tab.span.width,
    );
    const tab = projection.tabs[index];
    return tab && (tab.id === "home" || tab.id === "terminals")
      ? { kind: "view", viewId: tab.id, index }
      : null;
  }

  const status = projection.layout.status;
  if (
    status.height > 0 &&
    cellX >= status.x &&
    cellX < status.x + status.width &&
    cellY >= status.y &&
    cellY < status.y + status.height
  ) {
    return { kind: "status-strip" };
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
