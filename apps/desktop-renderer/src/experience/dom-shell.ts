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

export interface DomApplicationShellProjection extends Omit<
  ApplicationShellProjectionV1,
  "sidebar"
> {
  readonly sidebar: ApplicationShellProjectionV1["sidebar"] & {
    /** Canonical local selection, independent from the daemon's active tmux session. */
    readonly selectedResourceId: string | null;
  };
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

function sameDomShellIdentity(
  left: ApplicationShellProjectionInputV1,
  right: ApplicationShellProjectionInputV1,
): boolean {
  return left.project.id === right.project.id && left.workspace.id === right.workspace.id;
}

function availablePaneIds(input: ApplicationShellProjectionInputV1): ReadonlySet<string> {
  return new Set([
    ...input.workspace.sidebar.agents.flatMap((agent) =>
      agent.paneId === null ? [] : [agent.paneId],
    ),
    ...[
      input.focus.appFocusedPaneId,
      input.focus.terminalInputPaneId,
      input.focus.layoutSelectedPaneId,
    ].flatMap((paneId) => (paneId === null ? [] : [paneId])),
  ]);
}

function focusTargetIsAvailable(
  target: ApplicationShellReplayStateV1["focus"]["overlays"][number]["focusReturnTarget"],
  paneIds: ReadonlySet<string>,
): boolean {
  return target.kind !== "pane" || paneIds.has(target.paneId);
}

function focusIsAvailable(
  focus: ApplicationShellReplayStateV1["focus"],
  input: ApplicationShellProjectionInputV1,
): boolean {
  const paneIds = availablePaneIds(input);
  const referencedPaneIds = [
    focus.appFocusedPaneId,
    focus.terminalInputPaneId,
    focus.layoutSelectedPaneId,
  ];
  return (
    referencedPaneIds.every((paneId) => paneId === null || paneIds.has(paneId)) &&
    focus.overlays.every((overlay) => focusTargetIsAvailable(overlay.focusReturnTarget, paneIds))
  );
}

function availableDockTool(
  preferred: DockToolId,
  input: ApplicationShellProjectionInputV1,
): DockToolId {
  const preferredTool = input.dock.tools.find((tool) => tool.id === preferred);
  if (preferredTool?.disabledReason === null) return preferred;
  const snapshotTool = input.dock.tools.find((tool) => tool.id === input.dock.activeTool);
  if (snapshotTool?.disabledReason === null) return input.dock.activeTool;
  return input.dock.tools.find((tool) => tool.disabledReason === null)?.id ?? input.dock.activeTool;
}

function reconcileResourceSelections(
  state: ApplicationShellReplayStateV1,
  input: ApplicationShellProjectionInputV1,
): ApplicationShellReplayStateV1["selectedResources"] {
  const terminalResourceIds = new Set([
    ...input.workspace.sidebar.sessions.map(({ id }) => id),
    ...input.workspace.sidebar.agents.map(({ id }) => id),
  ]);
  return state.selectedResources.filter(
    (selection) =>
      selection.surface !== "terminals" || terminalResourceIds.has(selection.resourceId),
  );
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
): ApplicationShellReplayStateV1 {
  const snapshotState = createDomShellReplayState(nextInput);
  if (!sameDomShellIdentity(previousInput, nextInput)) {
    return ApplicationShellReplayStateV1SchemaZ.parse({
      ...snapshotState,
      activeDockTool: availableDockTool(snapshotState.activeDockTool, nextInput),
    });
  }
  return ApplicationShellReplayStateV1SchemaZ.parse({
    ...current,
    activeDockTool: availableDockTool(current.activeDockTool, nextInput),
    focus: focusIsAvailable(current.focus, nextInput) ? current.focus : snapshotState.focus,
    selectedResources: reconcileResourceSelections(current, nextInput),
  });
}

export function projectDomApplicationShell(
  input: ApplicationShellProjectionInputV1,
  state: ApplicationShellReplayStateV1,
): DomApplicationShellProjection {
  const shell = projectApplicationShellV1({
    ...input,
    workspace: { ...input.workspace, activeMode: state.activeMode },
    dock: { ...input.dock, mode: state.dockMode, activeTool: state.activeDockTool },
    focus: state.focus,
  });
  return Object.freeze({
    ...shell,
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
