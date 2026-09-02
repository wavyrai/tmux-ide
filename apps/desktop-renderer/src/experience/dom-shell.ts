import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellProjectionInputV1SchemaZ,
  COHESION_FIXTURE_V1,
  applicationShellCommandInvocation,
  commandsToOpenSurface,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionV1,
  type ApplicationShellReplayStateV1,
  type CommandSource,
  type DockToolId,
  type ProductSurfaceId,
  type SemanticIconId,
  type SurfaceCommandTemplate,
} from "@tmux-ide/contracts";
import {
  createApplicationShellReplayState,
  projectApplicationShellSession,
  reconcileApplicationShellReplayState,
  type NavigatorEntryScope,
  type NavigatorStatus,
} from "@tmux-ide/core";
import type {
  WorkbenchDockHostProjection,
  WorkbenchDockHostTabId,
} from "@tmux-ide/presentation/workbench-dock";
import {
  agentHarnessIcon,
  paneFrameModelFromCohesionPane,
} from "@tmux-ide/presentation/pane-frame";
import type { PaneFrameModel } from "@tmux-ide/presentation/pane-frame";
import { NO_HIDDEN_DOCK_TOOLS } from "./experimental-surfaces.ts";

export interface DomViewport {
  readonly width: number;
  readonly height: number;
}

export interface DomWorkbenchGeometry {
  readonly sidebarWidth?: number;
  readonly titlebarHeight?: number;
  readonly statusHeight?: number;
  readonly dockStripHeight?: number;
}

export type DomShellVariant = "compact" | "standard" | "wide";

export type DomPaletteGroupId = "workspaces" | "agents" | "panes" | "commands";

export type DomPaletteTarget =
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "pane"; readonly resourceId: string };

export interface DomPaletteEntry {
  readonly id: string;
  readonly icon: SemanticIconId;
  readonly label: string;
  readonly description: string;
  readonly shortcut: string;
  readonly keywords: readonly string[];
  readonly group: {
    readonly id: DomPaletteGroupId;
    readonly label: string;
    readonly order: number;
  };
  readonly rank: number;
  readonly scope: NavigatorEntryScope;
  readonly status: NavigatorStatus | null;
  readonly current: boolean;
  readonly disabledReason: string | null;
  readonly commands: readonly SurfaceCommandTemplate[];
  readonly target?: DomPaletteTarget;
}

export interface DomApplicationShellProjection extends Omit<
  ApplicationShellProjectionV1,
  "sidebar"
> {
  readonly sidebar: ApplicationShellProjectionV1["sidebar"] & {
    /** Canonical local selection, independent from the daemon's active tmux session. */
    readonly selectedResourceId: string | null;
  };
}

export const DOM_SHELL_GEOMETRY = Object.freeze({
  titlebarHeight: 50,
  statusHeight: 22,
  dockStripHeight: 40,
  sidebarWidth: 236,
  sidebarMinimumWidth: 220,
  sidebarMaximumWidth: 300,
  sidebarCollapsedWidth: 48,
});

export function createDefaultDomShellInput(): ApplicationShellProjectionInputV1 {
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    project: COHESION_FIXTURE_V1.project,
    workspace: COHESION_FIXTURE_V1.workspace,
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: COHESION_FIXTURE_V1.connection,
  });
}

/** Preview-only pane resources; production hosts pass fresh semantic models. */
export function createDefaultDomPaneFrames(): readonly PaneFrameModel[] {
  return COHESION_FIXTURE_V1.panes.map(paneFrameModelFromCohesionPane);
}

export function createDomShellReplayState(
  input: ApplicationShellProjectionInputV1,
  hiddenDockTools: ReadonlySet<ProductSurfaceId> = NO_HIDDEN_DOCK_TOOLS,
): ApplicationShellReplayStateV1 {
  return createApplicationShellReplayState(input, hiddenDockTools);
}

/**
 * Reconcile a fresh immutable host snapshot with renderer-owned interaction
 * state. Local mode, dock, focus, and selection survive only for the same
 * project/workspace identity and only while their targets remain available.
 */
export function reconcileDomShellReplayState(
  previousInput: ApplicationShellProjectionInputV1,
  nextInput: ApplicationShellProjectionInputV1,
  current: ApplicationShellReplayStateV1,
  hiddenDockTools: ReadonlySet<ProductSurfaceId> = NO_HIDDEN_DOCK_TOOLS,
): ApplicationShellReplayStateV1 {
  return reconcileApplicationShellReplayState(previousInput, nextInput, current, hiddenDockTools);
}

export function projectDomApplicationShell(
  input: ApplicationShellProjectionInputV1,
  state: ApplicationShellReplayStateV1,
  hiddenDockTools: ReadonlySet<ProductSurfaceId> = NO_HIDDEN_DOCK_TOOLS,
): DomApplicationShellProjection {
  const shell = projectApplicationShellSession(input, state);
  /*
   * The canonical projection is registry-driven: it always emits every dock
   * tool the product knows about, and placement is the host's business. Hiding
   * withheld tools here — once, at the renderer's own projection seam — is what
   * makes the dock strip, the command palette and the surface shortcuts agree,
   * because all three read this one list.
   */
  return Object.freeze({
    ...shell,
    bottomDock: Object.freeze({
      ...shell.bottomDock,
      tools: shell.bottomDock.tools.filter((tool) => !hiddenDockTools.has(tool.id)),
    }),
    sidebar: Object.freeze({
      ...shell.sidebar,
      selectedResourceId:
        state.selectedResources.find(({ surface }) => surface === "terminals")?.resourceId ?? null,
    }),
  });
}

export function domShellVariant(viewport: DomViewport): DomShellVariant {
  if (viewport.width < 1_000) return "compact";
  if (viewport.width < 1_440) return "standard";
  return "wide";
}

function variantMetrics(variant: DomShellVariant): {
  minimumDock: number;
  minimumCanvas: number;
} {
  if (variant === "compact") return { minimumDock: 132, minimumCanvas: 140 };
  if (variant === "standard") return { minimumDock: 168, minimumCanvas: 216 };
  return { minimumDock: 192, minimumCanvas: 288 };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

/**
 * Translate the canonical shell into the shared dock presenter's real desktop
 * geometry. Geometry remains a DOM-host concern; surface identity never does.
 */
export function projectDomWorkbenchDock(
  shell: ApplicationShellProjectionV1,
  viewport: DomViewport,
  geometry: DomWorkbenchGeometry = {},
): WorkbenchDockHostProjection {
  const variant = domShellVariant(viewport);
  const metrics = variantMetrics(variant);
  const titlebarHeight = geometry.titlebarHeight ?? DOM_SHELL_GEOMETRY.titlebarHeight;
  const statusHeight = geometry.statusHeight ?? DOM_SHELL_GEOMETRY.statusHeight;
  const dockStripHeight = geometry.dockStripHeight ?? DOM_SHELL_GEOMETRY.dockStripHeight;
  const sidebarWidth = clamp(
    geometry.sidebarWidth ?? DOM_SHELL_GEOMETRY.sidebarWidth,
    0,
    viewport.width,
  );
  const workbenchHeight = Math.max(0, viewport.height - titlebarHeight - statusHeight);
  const workspaceWidth = Math.max(0, viewport.width - sidebarWidth);
  const maximumOpenDock = Math.max(metrics.minimumDock, workbenchHeight - metrics.minimumCanvas);
  const openDockHeight = clamp(
    Math.round(workbenchHeight * 0.24),
    metrics.minimumDock,
    maximumOpenDock,
  );
  const dockHeight =
    shell.bottomDock.mode === "collapsed"
      ? dockStripHeight
      : shell.bottomDock.mode === "maximized"
        ? workbenchHeight
        : openDockHeight;
  const dockY = titlebarHeight + workbenchHeight - dockHeight;
  let cursor = sidebarWidth;
  const tabs = shell.bottomDock.tools.map((tool) => {
    const width = Math.max(72, 28 + tool.label.length * 8 + tool.shortcut.length * 8);
    const tab = {
      id: tool.id as WorkbenchDockHostTabId,
      title: tool.label,
      label: tool.label,
      shortcut: tool.shortcut,
      selected: tool.active,
      focused: shell.focus.zone === "dock-tabs" && tool.active,
      hovered: false,
      attention: tool.attention,
      disabled: tool.disabledReason !== null,
      disabledReason: tool.disabledReason,
      x: cursor,
      width,
    };
    cursor += width;
    return tab;
  });
  const actions = [
    {
      id: "toggle-collapse" as const,
      label: shell.bottomDock.mode === "collapsed" ? "Open" : "Collapse",
      description:
        shell.bottomDock.mode === "collapsed" ? "Open bottom dock" : "Collapse bottom dock",
      nextMode: shell.bottomDock.mode === "collapsed" ? ("open" as const) : ("collapsed" as const),
      active: shell.bottomDock.mode !== "collapsed",
      x: viewport.width - 72,
      width: 36,
    },
    {
      id: "toggle-maximize" as const,
      label: shell.bottomDock.mode === "maximized" ? "Restore" : "Maximize",
      description:
        shell.bottomDock.mode === "maximized" ? "Restore bottom dock" : "Maximize bottom dock",
      nextMode: shell.bottomDock.mode === "maximized" ? ("open" as const) : ("maximized" as const),
      active: shell.bottomDock.mode === "maximized",
      x: viewport.width - 36,
      width: 36,
    },
  ];
  const bodyHeight = shell.bottomDock.mode === "collapsed" ? 0 : dockHeight - dockStripHeight;

  return {
    variant,
    dockMode: shell.bottomDock.mode,
    focusZone:
      shell.focus.zone === "dock-tabs" || shell.focus.zone === "dock-body"
        ? shell.focus.zone
        : "canvas",
    activeDockTab: shell.bottomDock.activeTool,
    dock: { x: sidebarWidth, y: dockY, width: workspaceWidth, height: dockHeight },
    dockTabs: {
      x: sidebarWidth,
      y: dockY,
      width: workspaceWidth,
      height: dockStripHeight,
    },
    dockBody: {
      x: sidebarWidth,
      y: dockY + dockStripHeight,
      width: workspaceWidth,
      height: bodyHeight,
    },
    dockBodyRail: {
      x: sidebarWidth,
      y: dockY + dockStripHeight,
      width: 0,
      height: bodyHeight,
    },
    dockBodyContent: {
      x: sidebarWidth,
      y: dockY + dockStripHeight,
      width: workspaceWidth,
      height: bodyHeight,
    },
    tabs,
    actions,
  };
}

export function createDomPaletteEntries(
  shell: ApplicationShellProjectionV1,
): readonly DomPaletteEntry[] {
  const navigation = [...shell.primaryNavigation.items, ...shell.bottomDock.tools]
    .sort((left, right) =>
      left.kind === right.kind ? left.order - right.order : left.kind === "primary-mode" ? -1 : 1,
    )
    .map((surface) => ({
      id: surface.id,
      icon: surface.icon,
      label: surface.label,
      description:
        surface.kind === "primary-mode"
          ? `Switch the workspace to ${surface.label}`
          : `Open ${surface.label} in the workbench panel`,
      shortcut: surface.shortcut,
      keywords:
        surface.kind === "primary-mode"
          ? ["navigate", "workspace", "view", surface.id]
          : ["panel", "tool", "bottom", "dock", surface.id],
      group:
        surface.kind === "primary-mode"
          ? { id: "workspaces" as const, label: "Workspaces", order: 0 }
          : { id: "commands" as const, label: "Commands", order: 3 },
      rank: surface.order,
      scope: surface.kind === "primary-mode" ? ("workspaces" as const) : ("commands" as const),
      status: null,
      current: surface.active,
      disabledReason: surface.disabledReason,
      commands: commandsToOpenSurface({ surface: surface.id }),
    }));

  const sessions: DomPaletteEntry[] = shell.sidebar.sessions.map((session, rank) => ({
    id: `workspace:${session.id}`,
    icon: "home",
    label: session.label,
    description: `Workspace session · ${session.state}`,
    shortcut: "",
    keywords: ["workspace", "session", session.state, session.id],
    group: { id: "workspaces", label: "Workspaces", order: 0 },
    rank: 100 + rank,
    scope: "workspaces",
    status:
      session.state === "connected"
        ? "working"
        : session.state === "reconnecting"
          ? "idle"
          : "blocked",
    current: session.active,
    disabledReason: null,
    commands: commandsToOpenSurface({ surface: "terminals", resourceId: session.id }),
  }));

  const agentStatus = (
    agent: ApplicationShellProjectionV1["sidebar"]["agents"][number],
  ): NavigatorStatus => {
    if (agent.attention || agent.activity === "disconnected") return "blocked";
    if (agent.activity === "running") return "working";
    if (agent.activity === "complete") return "done";
    return "idle";
  };
  const agents: DomPaletteEntry[] = shell.sidebar.agents.map((agent, rank) => ({
    id: `agent:${agent.id}`,
    icon: agentHarnessIcon(agent.harness),
    label: agent.name,
    description: `${agent.harness} · ${agent.activity}${agent.attention ? " · needs attention" : ""}`,
    shortcut: "",
    keywords: ["agent", agent.harness, agent.activity, agent.id],
    group: { id: "agents", label: "Agents", order: 1 },
    rank,
    scope: "agents",
    status: agentStatus(agent),
    current: agent.paneId !== null && shell.terminalInventory?.activeResourceId === agent.paneId,
    disabledReason: agent.paneId === null ? "Agent has no terminal pane" : null,
    commands: [],
    target: { kind: "agent", agentId: agent.id },
  }));

  const panes: DomPaletteEntry[] = (shell.terminalInventory?.resources ?? []).map(
    (resource, rank) => ({
      id: `pane:${resource.id}`,
      icon: "terminals",
      label: resource.title,
      description:
        resource.attachability.status === "available"
          ? `${resource.kind === "agent" ? "Agent terminal" : "Terminal pane"} · ready`
          : `Terminal pane · ${resource.attachability.reason}`,
      shortcut: "",
      keywords: ["pane", "terminal", resource.kind, resource.id],
      group: { id: "panes", label: "Panes", order: 2 },
      rank,
      scope: "panes",
      status: resource.active ? "working" : "idle",
      current: resource.active,
      disabledReason:
        resource.attachability.status === "available"
          ? null
          : `Pane unavailable: ${resource.attachability.reason}`,
      commands: [],
      target: { kind: "pane", resourceId: resource.id },
    }),
  );

  return [...navigation, ...sessions, ...agents, ...panes];
}

export function invocationFromSurfaceCommand(
  command: SurfaceCommandTemplate,
  source: CommandSource,
): ApplicationShellCommandInvocation {
  switch (command.id) {
    case APPLICATION_SHELL_COMMAND_IDS.activateMode:
      return applicationShellCommandInvocation(command.id, command.args, source);
    case APPLICATION_SHELL_COMMAND_IDS.activateDockTool:
      return applicationShellCommandInvocation(command.id, command.args, source);
    case APPLICATION_SHELL_COMMAND_IDS.setDockMode:
      return applicationShellCommandInvocation(command.id, command.args, source);
    case APPLICATION_SHELL_COMMAND_IDS.selectResource:
      return applicationShellCommandInvocation(command.id, command.args, source);
  }
}

export function dockToolIcon(shell: ApplicationShellProjectionV1, id: DockToolId): SemanticIconId {
  return shell.bottomDock.tools.find((tool) => tool.id === id)!.icon;
}
