import {
  ApplicationShellReplayStateV1SchemaZ,
  applyApplicationShellInvocationV1,
  projectApplicationShellV1,
  type ApplicationShellCommandInvocation,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionV1,
  type ApplicationShellReplayStateV1,
  type DockToolId,
  type ProductSurfaceId,
} from "@tmux-ide/contracts";

const NO_UNAVAILABLE_SURFACES: ReadonlySet<ProductSurfaceId> = new Set();

function visibleDockTool(
  preferred: DockToolId,
  input: ApplicationShellProjectionInputV1,
  unavailableSurfaces: ReadonlySet<ProductSurfaceId>,
): DockToolId {
  if (!unavailableSurfaces.has(preferred)) return preferred;
  const visible = input.dock.tools.filter((tool) => !unavailableSurfaces.has(tool.id));
  return visible.find((tool) => tool.disabledReason === null)?.id ?? visible[0]?.id ?? preferred;
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

/** Create the canonical renderer-local replay state from an authority snapshot. */
export function createApplicationShellReplayState(
  input: ApplicationShellProjectionInputV1,
  unavailableSurfaces: ReadonlySet<ProductSurfaceId> = NO_UNAVAILABLE_SURFACES,
): ApplicationShellReplayStateV1 {
  return ApplicationShellReplayStateV1SchemaZ.parse({
    activeMode: input.workspace.activeMode,
    dockMode: input.dock.mode,
    activeDockTool: visibleDockTool(input.dock.activeTool, input, unavailableSurfaces),
    focus: input.focus,
    selectedResources: [],
  });
}

/** Create replay state from an already projected shell, used by non-DOM hosts. */
export function applicationShellReplayStateFromProjection(
  projection: ApplicationShellProjectionV1,
): ApplicationShellReplayStateV1 {
  return ApplicationShellReplayStateV1SchemaZ.parse({
    activeMode: projection.workspaceCanvas.activeMode,
    dockMode: projection.bottomDock.mode,
    activeDockTool: projection.bottomDock.activeTool,
    focus: {
      windowActivity: projection.focus.windowActivity,
      focusZone: projection.focus.zone,
      appFocusedPaneId: projection.focus.appFocusedPaneId,
      terminalInputPaneId: projection.focus.terminalInputPaneId,
      layoutSelectedPaneId: projection.focus.layoutSelectedPaneId,
      overlays: projection.focus.overlays,
    },
    selectedResources: [],
  });
}

function sameShellIdentity(
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

function focusIsAvailable(
  focus: ApplicationShellReplayStateV1["focus"],
  input: ApplicationShellProjectionInputV1,
): boolean {
  const paneIds = availablePaneIds(input);
  return (
    [focus.appFocusedPaneId, focus.terminalInputPaneId, focus.layoutSelectedPaneId].every(
      (paneId) => paneId === null || paneIds.has(paneId),
    ) &&
    focus.overlays.every(
      ({ focusReturnTarget }) =>
        focusReturnTarget.kind !== "pane" || paneIds.has(focusReturnTarget.paneId),
    )
  );
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
 * Merge a fresh authority snapshot with safe renderer-local interaction state.
 * Identity changes reset local state; stale pane focus and resource selections
 * are discarded deterministically by every renderer.
 */
export function reconcileApplicationShellReplayState(
  previousInput: ApplicationShellProjectionInputV1,
  nextInput: ApplicationShellProjectionInputV1,
  current: ApplicationShellReplayStateV1,
  unavailableSurfaces: ReadonlySet<ProductSurfaceId> = NO_UNAVAILABLE_SURFACES,
): ApplicationShellReplayStateV1 {
  const snapshotState = createApplicationShellReplayState(nextInput, unavailableSurfaces);
  if (!sameShellIdentity(previousInput, nextInput)) {
    return ApplicationShellReplayStateV1SchemaZ.parse({
      ...snapshotState,
      activeDockTool: visibleDockTool(
        availableDockTool(snapshotState.activeDockTool, nextInput),
        nextInput,
        unavailableSurfaces,
      ),
    });
  }
  return ApplicationShellReplayStateV1SchemaZ.parse({
    ...current,
    activeDockTool: visibleDockTool(
      availableDockTool(current.activeDockTool, nextInput),
      nextInput,
      unavailableSurfaces,
    ),
    focus: focusIsAvailable(current.focus, nextInput) ? current.focus : snapshotState.focus,
    selectedResources: reconcileResourceSelections(current, nextInput),
  });
}

export interface ApplicationShellTransactionStep {
  readonly invocation: ApplicationShellCommandInvocation;
  readonly previous: ApplicationShellReplayStateV1;
  readonly next: ApplicationShellReplayStateV1;
}

/** Apply an ordered semantic transaction once, independent of renderer effects. */
export function reduceApplicationShellTransaction(
  initial: ApplicationShellReplayStateV1,
  invocations: readonly ApplicationShellCommandInvocation[],
): {
  readonly state: ApplicationShellReplayStateV1;
  readonly steps: readonly ApplicationShellTransactionStep[];
} {
  let state = initial;
  const steps: ApplicationShellTransactionStep[] = [];
  for (const invocation of invocations) {
    const previous = state;
    state = applyApplicationShellInvocationV1(previous, invocation);
    steps.push({ invocation, previous, next: state });
  }
  return { state, steps };
}

/**
 * Project one authority snapshot through renderer-local replay state. This is
 * the shared GUI/TUI seam: workspace facts stay authoritative while view mode,
 * dock, focus, and local selection remain client-local.
 */
export function projectApplicationShellSession(
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
