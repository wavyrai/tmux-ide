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
import { paneFrameModelFromCohesionPane } from "../../../../packages/daemon/src/ui/pane-frame/model.ts";
import type { PaneFrameModel } from "../../../../packages/daemon/src/ui/pane-frame/presenter.tsx";
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

export type DomPaletteGroupId = "workspace" | "workbench";

export interface DomPaletteEntry {
  readonly id: ProductSurfaceId;
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
  return ApplicationShellReplayStateV1SchemaZ.parse({
    activeMode: input.workspace.activeMode,
    dockMode: input.dock.mode,
    activeDockTool: visibleDockTool(input.dock.activeTool, input, hiddenDockTools),
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
    ...(input.terminalInventory?.resources.map(({ id }) => id) ?? []),
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

/**
 * Redirect a withheld dock tool onto one the reader can actually see. Identity
 * when nothing is hidden, so an unflagged shell keeps the exact selection the
 * snapshot asked for — including a tool the daemon marked unavailable, which
 * still has an honest disabled body to show.
 */
function visibleDockTool(
  preferred: DockToolId,
  input: ApplicationShellProjectionInputV1,
  hiddenDockTools: ReadonlySet<ProductSurfaceId>,
): DockToolId {
  if (!hiddenDockTools.has(preferred)) return preferred;
  const visible = input.dock.tools.filter((tool) => !hiddenDockTools.has(tool.id));
  return visible.find((tool) => tool.disabledReason === null)?.id ?? visible[0]?.id ?? preferred;
}

function reconcileResourceSelections(
  state: ApplicationShellReplayStateV1,
  input: ApplicationShellProjectionInputV1,
): ApplicationShellReplayStateV1["selectedResources"] {
  const terminalResourceIds = new Set([
    ...input.workspace.sidebar.sessions.map(({ id }) => id),
    ...input.workspace.sidebar.agents.map(({ id }) => id),
    ...(input.terminalInventory?.resources.map(({ id }) => id) ?? []),
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
  hiddenDockTools: ReadonlySet<ProductSurfaceId> = NO_HIDDEN_DOCK_TOOLS,
): ApplicationShellReplayStateV1 {
  const snapshotState = createDomShellReplayState(nextInput, hiddenDockTools);
  if (!sameDomShellIdentity(previousInput, nextInput)) {
    return ApplicationShellReplayStateV1SchemaZ.parse({
      ...snapshotState,
      activeDockTool: visibleDockTool(
        availableDockTool(snapshotState.activeDockTool, nextInput),
        nextInput,
        hiddenDockTools,
      ),
    });
  }
  return ApplicationShellReplayStateV1SchemaZ.parse({
    ...current,
    activeDockTool: visibleDockTool(
      availableDockTool(current.activeDockTool, nextInput),
      nextInput,
      hiddenDockTools,
    ),
    focus: focusIsAvailable(current.focus, nextInput) ? current.focus : snapshotState.focus,
    selectedResources: reconcileResourceSelections(current, nextInput),
  });
}

export function projectDomApplicationShell(
  input: ApplicationShellProjectionInputV1,
  state: ApplicationShellReplayStateV1,
  hiddenDockTools: ReadonlySet<ProductSurfaceId> = NO_HIDDEN_DOCK_TOOLS,
): DomApplicationShellProjection {
  const shell = projectApplicationShellV1({
    ...input,
    workspace: { ...input.workspace, activeMode: state.activeMode },
    dock: { ...input.dock, mode: state.dockMode, activeTool: state.activeDockTool },
    focus: state.focus,
  });
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
  return [...shell.primaryNavigation.items, ...shell.bottomDock.tools]
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
          ? { id: "workspace" as const, label: "Workspace", order: 0 }
          : { id: "workbench" as const, label: "Workbench", order: 1 },
      rank: surface.order,
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
