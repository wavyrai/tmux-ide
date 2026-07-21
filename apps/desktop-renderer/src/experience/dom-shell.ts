import {
  APPLICATION_SHELL_COMMAND_IDS,
  ApplicationShellProjectionInputV1SchemaZ,
  ApplicationShellReplayStateV1SchemaZ,
  COHESION_FIXTURE_V1,
  applicationShellCommandInvocation,
  commandsToOpenSurface,
  projectApplicationShellV1,
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
import type {
  WorkbenchDockHostProjection,
  WorkbenchDockHostTabId,
} from "../../../../packages/daemon/src/ui/workbench-dock/presenter.tsx";

export interface DomViewport {
  readonly width: number;
  readonly height: number;
}

export type DomShellVariant = "compact" | "standard" | "wide";

export interface DomPaletteEntry {
  readonly id: ProductSurfaceId;
  readonly icon: SemanticIconId;
  readonly label: string;
  readonly shortcut: string;
  readonly current: boolean;
  readonly disabledReason: string | null;
  readonly commands: readonly SurfaceCommandTemplate[];
}

const TITLEBAR_HEIGHT = 28;
const STATUS_HEIGHT = 18;
const DOCK_STRIP_HEIGHT = 28;

export function createDefaultDomShellInput(): ApplicationShellProjectionInputV1 {
  return ApplicationShellProjectionInputV1SchemaZ.parse({
    project: COHESION_FIXTURE_V1.project,
    workspace: COHESION_FIXTURE_V1.workspace,
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: COHESION_FIXTURE_V1.connection,
  });
}

export function createDomShellReplayState(
  input: ApplicationShellProjectionInputV1,
): ApplicationShellReplayStateV1 {
  return ApplicationShellReplayStateV1SchemaZ.parse({
    activeMode: input.workspace.activeMode,
    dockMode: input.dock.mode,
    activeDockTool: input.dock.activeTool,
    focus: input.focus,
    selectedResources: [],
  });
}

export function projectDomApplicationShell(
  input: ApplicationShellProjectionInputV1,
  state: ApplicationShellReplayStateV1,
): ApplicationShellProjectionV1 {
  return projectApplicationShellV1({
    ...input,
    workspace: { ...input.workspace, activeMode: state.activeMode },
    dock: { ...input.dock, mode: state.dockMode, activeTool: state.activeDockTool },
    focus: state.focus,
  });
}

export function domShellVariant(viewport: DomViewport): DomShellVariant {
  if (viewport.width < 1_000) return "compact";
  if (viewport.width < 1_440) return "standard";
  return "wide";
}

function variantMetrics(variant: DomShellVariant): {
  sidebar: number;
  minimumDock: number;
  minimumCanvas: number;
} {
  if (variant === "compact") return { sidebar: 48, minimumDock: 126, minimumCanvas: 144 };
  if (variant === "standard") return { sidebar: 168, minimumDock: 180, minimumCanvas: 216 };
  return { sidebar: 184, minimumDock: 252, minimumCanvas: 288 };
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
): WorkbenchDockHostProjection {
  const variant = domShellVariant(viewport);
  const metrics = variantMetrics(variant);
  const workbenchHeight = Math.max(0, viewport.height - TITLEBAR_HEIGHT - STATUS_HEIGHT);
  const workspaceWidth = Math.max(0, viewport.width - metrics.sidebar);
  const maximumOpenDock = Math.max(metrics.minimumDock, workbenchHeight - metrics.minimumCanvas);
  const openDockHeight = clamp(
    Math.round(workbenchHeight * 0.3),
    metrics.minimumDock,
    maximumOpenDock,
  );
  const dockHeight =
    shell.bottomDock.mode === "collapsed"
      ? DOCK_STRIP_HEIGHT
      : shell.bottomDock.mode === "maximized"
        ? workbenchHeight
        : openDockHeight;
  const dockY = TITLEBAR_HEIGHT + workbenchHeight - dockHeight;
  let cursor = metrics.sidebar;
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
      x: viewport.width - 56,
      width: 28,
    },
    {
      id: "toggle-maximize" as const,
      label: shell.bottomDock.mode === "maximized" ? "Restore" : "Maximize",
      description:
        shell.bottomDock.mode === "maximized" ? "Restore bottom dock" : "Maximize bottom dock",
      nextMode: shell.bottomDock.mode === "maximized" ? ("open" as const) : ("maximized" as const),
      active: shell.bottomDock.mode === "maximized",
      x: viewport.width - 28,
      width: 28,
    },
  ];
  const bodyHeight = shell.bottomDock.mode === "collapsed" ? 0 : dockHeight - DOCK_STRIP_HEIGHT;

  return {
    variant,
    dockMode: shell.bottomDock.mode,
    focusZone:
      shell.focus.zone === "dock-tabs" || shell.focus.zone === "dock-body"
        ? shell.focus.zone
        : "canvas",
    activeDockTab: shell.bottomDock.activeTool,
    dock: { x: metrics.sidebar, y: dockY, width: workspaceWidth, height: dockHeight },
    dockTabs: {
      x: metrics.sidebar,
      y: dockY,
      width: workspaceWidth,
      height: DOCK_STRIP_HEIGHT,
    },
    dockBody: {
      x: metrics.sidebar,
      y: dockY + DOCK_STRIP_HEIGHT,
      width: workspaceWidth,
      height: bodyHeight,
    },
    dockBodyRail: {
      x: metrics.sidebar,
      y: dockY + DOCK_STRIP_HEIGHT,
      width: DOCK_STRIP_HEIGHT,
      height: bodyHeight,
    },
    dockBodyContent: {
      x: metrics.sidebar + DOCK_STRIP_HEIGHT,
      y: dockY + DOCK_STRIP_HEIGHT,
      width: Math.max(0, workspaceWidth - DOCK_STRIP_HEIGHT),
      height: bodyHeight,
    },
    tabs,
    actions,
  };
}

export function createDomPaletteEntries(
  shell: ApplicationShellProjectionV1,
): readonly DomPaletteEntry[] {
  return [...shell.primaryNavigation.items, ...shell.bottomDock.tools]
    .sort((left, right) =>
      left.kind === right.kind ? left.order - right.order : left.kind === "primary-mode" ? -1 : 1,
    )
    .map((surface) => ({
      id: surface.id,
      icon: surface.icon,
      label: surface.label,
      shortcut: surface.shortcut,
      current: surface.active,
      disabledReason: surface.disabledReason,
      commands: commandsToOpenSurface({ surface: surface.id }),
    }));
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
