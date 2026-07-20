import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  WORKSPACE_STATE_MAX_CHECKOUTS,
  WORKSPACE_STATE_MAX_ID_LENGTH,
  WORKSPACE_STATE_MAX_LAYOUTS,
  WORKSPACE_STATE_MAX_NAME_LENGTH,
  WORKSPACE_STATE_MAX_PANES,
  WORKSPACE_STATE_MAX_TREE_DEPTH,
  WORKSPACE_STATE_MAX_TREE_NODES,
  WORKSPACE_STATE_VERSION,
  WorkspaceCheckoutStateSchemaZ,
  WorkspaceLayoutApplyPlanSchemaZ,
  WorkspaceLayoutSnapshotSchemaZ,
  WorkspaceObservationSchemaZ,
  WorkspaceObservedPaneSchemaZ,
  WorkspaceProjectIdentitySchemaZ,
  WorkspaceStateV1SchemaZ,
  WorkspaceTimestampSchemaZ,
  type ParsedWorkspaceState,
  type WorkspaceCheckoutState,
  type WorkspaceDockSnapshot,
  type WorkspaceLayoutApplyPlan,
  type WorkspaceLayoutSnapshot,
  type WorkspaceNamedLayout,
  type WorkspaceObservation,
  type WorkspaceObservedPane,
  type WorkspacePaneBinding,
  type WorkspacePaneCwd,
  type WorkspacePaneDefinition,
  type WorkspacePaneTopology,
  type WorkspacePaneTreeNode,
  type WorkspaceProjectIdentity,
  type WorkspaceStateDiagnostic,
  type WorkspaceStateV1,
  type WorkspaceWorkbenchState,
} from "@tmux-ide/contracts";

export * from "@tmux-ide/contracts";

const EMPTY_DOCK: WorkspaceDockSnapshot = {
  activeTab: "files",
  mode: "open",
  preferredHeight: null,
  focusZone: "canvas",
};
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function defaultWorkspaceState(project: WorkspaceProjectIdentity): WorkspaceStateV1 {
  return {
    version: WORKSPACE_STATE_VERSION,
    project: WorkspaceProjectIdentitySchemaZ.parse(project),
    layouts: {},
    checkouts: {},
  };
}

export function defaultWorkspaceWorkbenchState(): WorkspaceWorkbenchState {
  return { canvasPanel: "home", dock: { ...EMPTY_DOCK } };
}

export function emptyWorkspaceTopology(): WorkspacePaneTopology {
  return { panes: {}, root: null };
}

export function emptyWorkspaceCheckout(
  checkoutKey: string,
  projectRoot: string,
): WorkspaceCheckoutState {
  const checkout = {
    checkoutKey: requireId(checkoutKey, "checkout key"),
    projectRoot: requireProjectRoot(projectRoot),
    activeLayoutId: null,
    topology: emptyWorkspaceTopology(),
    focusedPaneId: null,
    workbench: defaultWorkspaceWorkbenchState(),
    bindings: {},
    recovery: {
      status: "empty",
      capturedAt: null,
      sessionName: null,
      windowIndex: null,
      windowName: null,
      missingPaneIds: [],
      externalPaneIds: [],
    },
  };
  return WorkspaceCheckoutStateSchemaZ.parse(checkout);
}

export function projectWorkspaceTopology(
  observedPanes: readonly WorkspaceObservedPane[],
  projectRoot: string,
): WorkspacePaneTopology {
  const root = requireProjectRoot(projectRoot);
  const parsedPanes = WorkspaceObservedPaneSchemaZ.array()
    .max(WORKSPACE_STATE_MAX_PANES)
    .parse(observedPanes);
  const panes: Record<string, WorkspacePaneDefinition> = {};
  const semanticPaneIds = new Set<string>();
  const runtimePaneIds = new Set<string>();
  for (const pane of parsedPanes) {
    const id = pane.semanticPaneId;
    if (semanticPaneIds.has(id)) throw new Error(`duplicate semantic pane id "${id}"`);
    if (runtimePaneIds.has(pane.runtimePaneId)) {
      throw new Error(`duplicate runtime pane id "${pane.runtimePaneId}"`);
    }
    semanticPaneIds.add(id);
    runtimePaneIds.add(pane.runtimePaneId);
    panes[id] = {
      id,
      parentId: null,
      role: pane.role,
      harness: pane.harness ?? null,
      title: pane.title ?? null,
      command: pane.command ?? null,
      cwd: normalizePaneCwd(pane.cwd ?? null, root),
      rect: { ...pane.rect },
    };
  }
  const definitions = Object.values(panes).sort(comparePanes);
  return WorkspaceLayoutSnapshotSchemaZ.shape.topology.parse(
    finalizeTopology(panes, buildPaneTree(definitions)),
  );
}

/**
 * Deterministically seeds the shared workspace domain from the independent V2
 * OpenTUI projection. The projection remains untouched and authoritative for
 * its view/surface state; only the compatible canvas and dock snapshot crosses
 * this boundary.
 */
export function migrateWorkspaceUiStateV2(
  project: WorkspaceProjectIdentity,
  checkoutKey: string,
  projectRoot: string,
  value: unknown,
  migratedAt: string,
): WorkspaceStateV1 {
  if (!isRecord(value) || value.version !== 2) {
    throw new Error("workspace UI state V2 is required for migration");
  }
  const key = requireId(checkoutKey, "checkout key");
  const root = requireProjectRoot(projectRoot);
  requireTimestamp(migratedAt);
  const active = isRecord(value.active) ? value.active : null;
  const canvasPanel = active?.panel === "home" ? "home" : "terminals";
  const dock = cleanLegacyDock(value.dock);
  const checkout = emptyWorkspaceCheckout(key, root);
  checkout.workbench = { canvasPanel, dock };
  return orderWorkspaceState({
    version: WORKSPACE_STATE_VERSION,
    project: WorkspaceProjectIdentitySchemaZ.parse(project),
    layouts: {},
    checkouts: { [key]: checkout },
  });
}

/**
 * Capture current tmux truth without mutating named layout definitions.
 * Repeating the same observation is byte-for-byte idempotent.
 */
export function captureWorkspaceObservation(
  state: WorkspaceStateV1,
  observation: WorkspaceObservation,
): WorkspaceStateV1 {
  const current = requireWorkspaceState(state);
  const observed = WorkspaceObservationSchemaZ.parse(observation);
  const checkoutKey = observed.checkoutKey;
  const projectRoot = requireProjectRoot(observed.projectRoot);
  const observedAt = observed.observedAt;
  const previous =
    current.checkouts[checkoutKey] ?? emptyWorkspaceCheckout(checkoutKey, projectRoot);
  if (resolve(previous.projectRoot) !== projectRoot) {
    throw new Error(`checkout "${checkoutKey}" belongs to a different project root`);
  }
  if (
    previous.recovery.capturedAt &&
    Date.parse(observedAt) <= Date.parse(previous.recovery.capturedAt)
  ) {
    return cloneWorkspaceState(current);
  }

  const observedTopology = projectWorkspaceTopology(observed.panes, projectRoot);
  const observedIds = Object.keys(observedTopology.panes);
  const layout = previous.activeLayoutId ? current.layouts[previous.activeLayoutId] : null;
  const previousIds = Object.keys(previous.topology.panes);
  const missingPreviousPane = previousIds.some((id) => !observedTopology.panes[id]);
  const preservesPriorTopology =
    previous.topology.root !== null &&
    (observedIds.length === 0 || (!layout && missingPreviousPane));
  const topology = preservesPriorTopology
    ? mergeRecoverableTopology(previous.topology, observedTopology)
    : observedTopology;
  const desiredIds = layout
    ? Object.keys(layout.snapshot.topology.panes)
    : Object.keys(previous.topology.panes);
  const missingPaneIds = desiredIds.filter((id) => !observedTopology.panes[id]).sort();
  const externalPaneIds = layout
    ? observedIds.filter((id) => !layout.snapshot.topology.panes[id]).sort()
    : [];
  const requestedFocus = observed.focusedPaneId;
  const focusedPaneId = preservesPriorTopology
    ? previous.focusedPaneId
    : ((requestedFocus && topology.panes[requestedFocus] ? requestedFocus : null) ??
      observedIds.find((id) =>
        observed.panes.some((pane) => pane.semanticPaneId === id && pane.active),
      ) ??
      observedIds[0] ??
      null);
  const bindings: Record<string, WorkspacePaneBinding> = preservesPriorTopology
    ? structuredClone(previous.bindings)
    : {};
  for (const pane of observed.panes) {
    for (const [boundPaneId, binding] of Object.entries(bindings)) {
      if (boundPaneId !== pane.semanticPaneId && binding.runtimePaneId === pane.runtimePaneId) {
        delete bindings[boundPaneId];
      }
    }
    bindings[pane.semanticPaneId] = {
      semanticPaneId: pane.semanticPaneId,
      runtimePaneId: pane.runtimePaneId,
      lastSeenAt: observedAt,
    };
  }
  const nextCheckout: WorkspaceCheckoutState = {
    checkoutKey,
    projectRoot,
    activeLayoutId:
      previous.activeLayoutId && current.layouts[previous.activeLayoutId]
        ? previous.activeLayoutId
        : null,
    topology,
    focusedPaneId,
    workbench: structuredClone(observed.workbench),
    bindings: orderedRecord(bindings),
    recovery: {
      status:
        observedIds.length === 0
          ? "empty"
          : missingPaneIds.length || externalPaneIds.length
            ? "reconciled"
            : "clean",
      capturedAt: observedAt,
      sessionName: observed.sessionName,
      windowIndex: observed.windowIndex,
      windowName: observed.windowName,
      missingPaneIds,
      externalPaneIds,
    },
  };
  const next = cloneWorkspaceState(current);
  next.checkouts[checkoutKey] = nextCheckout;
  return requireWorkspaceState(next);
}

export function createWorkspaceLayout(
  state: WorkspaceStateV1,
  input: {
    id: string;
    name: string;
    checkoutKey: string;
    now: string;
    snapshot?: WorkspaceLayoutSnapshot;
  },
): WorkspaceStateV1 {
  const current = requireWorkspaceState(state);
  const id = requireId(input.id, "layout id");
  if (current.layouts[id]) throw new Error(`workspace layout "${id}" already exists`);
  if (Object.keys(current.layouts).length >= WORKSPACE_STATE_MAX_LAYOUTS) {
    throw new Error("workspace layout limit exceeded");
  }
  const checkout = requireCheckout(current, input.checkoutKey);
  const now = requireTimestamp(input.now);
  const snapshot = requireSnapshot(input.snapshot ?? snapshotFromCheckout(checkout));
  const next = cloneWorkspaceState(current);
  next.layouts[id] = {
    id,
    name: requireName(input.name),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    snapshot,
  };
  next.layouts = orderedRecord(next.layouts);
  next.checkouts[input.checkoutKey]!.activeLayoutId = id;
  return requireWorkspaceState(next);
}

export function renameWorkspaceLayout(
  state: WorkspaceStateV1,
  layoutId: string,
  name: string,
  now: string,
): WorkspaceStateV1 {
  const current = requireWorkspaceState(state);
  const layout = requireLayout(current, layoutId);
  const next = cloneWorkspaceState(current);
  next.layouts[layout.id] = {
    ...layout,
    name: requireName(name),
    revision: layout.revision + 1,
    updatedAt: requireTimestamp(now),
  };
  return requireWorkspaceState(next);
}

export function saveWorkspaceLayout(
  state: WorkspaceStateV1,
  layoutId: string,
  checkoutKey: string,
  now: string,
): WorkspaceStateV1 {
  const current = requireWorkspaceState(state);
  const layout = requireLayout(current, layoutId);
  const checkout = requireCheckout(current, checkoutKey);
  const next = cloneWorkspaceState(current);
  next.layouts[layout.id] = {
    ...layout,
    revision: layout.revision + 1,
    updatedAt: requireTimestamp(now),
    snapshot: requireSnapshot(snapshotFromCheckout(checkout)),
  };
  next.checkouts[checkoutKey]!.activeLayoutId = layout.id;
  return requireWorkspaceState(next);
}

export function deleteWorkspaceLayout(state: WorkspaceStateV1, layoutId: string): WorkspaceStateV1 {
  const current = requireWorkspaceState(state);
  const id = requireId(layoutId, "layout id");
  if (!current.layouts[id]) return cloneWorkspaceState(current);
  const next = cloneWorkspaceState(current);
  delete next.layouts[id];
  for (const checkout of Object.values(next.checkouts)) {
    if (checkout.activeLayoutId === id) checkout.activeLayoutId = null;
  }
  return requireWorkspaceState(next);
}

/** Build an adapter plan only; this function never issues tmux commands. */
export function applyWorkspaceLayout(
  state: WorkspaceStateV1,
  layoutId: string,
  observation: WorkspaceObservation,
): { state: WorkspaceStateV1; plan: WorkspaceLayoutApplyPlan } {
  const current = requireWorkspaceState(state);
  const observed = WorkspaceObservationSchemaZ.parse(observation);
  const layout = requireLayout(current, layoutId);
  const captured = captureWorkspaceObservation(current, observed);
  const checkout = requireCheckout(captured, observed.checkoutKey);
  if (resolve(checkout.projectRoot) !== requireProjectRoot(observed.projectRoot)) {
    throw new Error(`checkout "${observed.checkoutKey}" belongs to a different project root`);
  }
  const liveIds = observed.panes.map((pane) => pane.semanticPaneId).sort();
  const desiredIds = Object.keys(layout.snapshot.topology.panes);
  const liveIdSet = new Set(liveIds);
  const retainedPaneIds = desiredIds.filter((id) => liveIdSet.has(id)).sort();
  const missingPaneIds = desiredIds.filter((id) => !liveIdSet.has(id)).sort();
  const externalPaneIds = liveIds.filter((id) => !layout.snapshot.topology.panes[id]).sort();
  const targetTopology = requireSnapshot(layout.snapshot).topology;
  const targetFocusedPaneId =
    (layout.snapshot.focusedPaneId && targetTopology.panes[layout.snapshot.focusedPaneId]
      ? layout.snapshot.focusedPaneId
      : null) ??
    [...desiredIds].sort()[0] ??
    null;
  const liveFocusedPaneId =
    (observed.focusedPaneId && liveIdSet.has(observed.focusedPaneId)
      ? observed.focusedPaneId
      : null) ??
    observed.panes.find((pane) => pane.active)?.semanticPaneId ??
    liveIds[0] ??
    null;
  const retainedBindings = orderedRecord(
    Object.fromEntries(
      retainedPaneIds.flatMap((paneId) => {
        const binding = checkout.bindings[paneId];
        return binding ? [[paneId, { ...binding }] as const] : [];
      }),
    ),
  );
  const next = cloneWorkspaceState(captured);
  const nextCheckout = next.checkouts[observed.checkoutKey]!;
  nextCheckout.activeLayoutId = layout.id;
  nextCheckout.focusedPaneId = liveFocusedPaneId ?? nextCheckout.focusedPaneId;
  nextCheckout.workbench = cloneWorkbench(layout.snapshot.workbench);
  nextCheckout.recovery = {
    ...nextCheckout.recovery,
    status:
      observed.panes.length === 0
        ? "empty"
        : missingPaneIds.length || externalPaneIds.length
          ? "reconciled"
          : "clean",
    missingPaneIds,
    externalPaneIds,
  };
  const plan = WorkspaceLayoutApplyPlanSchemaZ.parse({
    layoutId: layout.id,
    checkoutKey: observed.checkoutKey,
    projectRoot: requireProjectRoot(observed.projectRoot),
    sessionName: observed.sessionName,
    windowIndex: observed.windowIndex,
    windowName: observed.windowName,
    targetTopology,
    materializedPaneCwds: orderedRecord(
      Object.fromEntries(
        Object.entries(targetTopology.panes).map(([paneId, pane]) => [
          paneId,
          materializePaneCwd(pane.cwd, observed.projectRoot),
        ]),
      ),
    ),
    targetFocusedPaneId,
    liveFocusedPaneId,
    workbench: cloneWorkbench(layout.snapshot.workbench),
    retainedBindings,
    retainedPaneIds,
    missingPaneIds,
    externalPaneIds,
  });
  return {
    state: requireWorkspaceState(next),
    plan,
  };
}

export function serializeWorkspaceState(state: WorkspaceStateV1): string {
  return `${JSON.stringify(orderWorkspaceState(requireWorkspaceState(state)), null, 2)}\n`;
}

export function parseWorkspaceStateValue(
  value: unknown,
  expectedProject: WorkspaceProjectIdentity,
): ParsedWorkspaceState {
  if (!isRecord(value)) {
    return {
      state: defaultWorkspaceState(expectedProject),
      diagnostics: [{ code: "MALFORMED", path: "$", message: "workspace state must be an object" }],
      writeProtected: true,
    };
  }
  if (value.version !== WORKSPACE_STATE_VERSION) {
    return {
      state: defaultWorkspaceState(expectedProject),
      diagnostics: [
        {
          code: Number.isInteger(value.version) ? "UNSUPPORTED_VERSION" : "MALFORMED",
          path: "$.version",
          message: `unsupported workspace state version ${String(value.version)}`,
        },
      ],
      writeProtected: true,
    };
  }
  const preflightFailure = workspaceStateLimitFailure(value);
  if (preflightFailure) {
    return {
      state: defaultWorkspaceState(expectedProject),
      diagnostics: [
        { code: "OVERSIZED", path: preflightFailure.path, message: preflightFailure.message },
      ],
      writeProtected: true,
    };
  }
  const parsed = WorkspaceStateV1SchemaZ.safeParse(value);
  if (!parsed.success) {
    return {
      state: defaultWorkspaceState(expectedProject),
      diagnostics: parsed.error.issues.map((issue) => ({
        code: issue.message.includes("limit exceeded") ? "OVERSIZED" : "INVALID_FIELD",
        path: issue.path.length ? `$.${issue.path.join(".")}` : "$",
        message: issue.message,
      })),
      writeProtected: true,
    };
  }
  const expected = WorkspaceProjectIdentitySchemaZ.parse(expectedProject);
  const project = parsed.data.project;
  if (
    project.identityKey !== expected.identityKey ||
    project.identitySource !== expected.identitySource
  ) {
    return {
      state: defaultWorkspaceState(expectedProject),
      diagnostics: [
        {
          code: "IDENTITY_MISMATCH",
          path: "$.project.identityKey",
          message: "workspace state belongs to a different project identity",
        },
      ],
      writeProtected: true,
    };
  }
  const diagnostics: WorkspaceStateDiagnostic[] = [];
  if (project.identityAnchor !== expectedProject.identityAnchor) {
    diagnostics.push({
      code: "PROJECT_RELINKED",
      path: "$.project.identityAnchor",
      message: "workspace project identity anchor was refreshed",
    });
  }
  return {
    state: orderWorkspaceState({
      ...parsed.data,
      project: expected,
    }),
    diagnostics,
    writeProtected: false,
  };
}

export function cloneWorkspaceState(state: WorkspaceStateV1): WorkspaceStateV1 {
  return WorkspaceStateV1SchemaZ.parse(JSON.parse(serializeWorkspaceState(state)));
}

function cleanLegacyDock(value: unknown): WorkspaceDockSnapshot {
  return cleanWorkbench({
    canvasPanel: "terminals",
    dock: isRecord(value) ? (value as WorkspaceDockSnapshot) : { ...EMPTY_DOCK },
  }).dock;
}

function cleanWorkbench(value: WorkspaceWorkbenchState): WorkspaceWorkbenchState {
  const dock = value.dock;
  return {
    canvasPanel: value.canvasPanel === "terminals" ? "terminals" : "home",
    dock: {
      activeTab:
        dock?.activeTab === "changes" ||
        dock?.activeTab === "missions" ||
        dock?.activeTab === "activity"
          ? dock.activeTab
          : "files",
      mode: dock?.mode === "collapsed" || dock?.mode === "maximized" ? dock.mode : "open",
      preferredHeight: cleanNullableInt(dock?.preferredHeight),
      focusZone:
        dock?.focusZone === "dock-tabs" || dock?.focusZone === "dock-body"
          ? dock.focusZone
          : "canvas",
    },
  };
}

function snapshotFromCheckout(checkout: WorkspaceCheckoutState): WorkspaceLayoutSnapshot {
  return {
    topology: structuredClone(checkout.topology),
    focusedPaneId: checkout.focusedPaneId,
    workbench: cloneWorkbench(checkout.workbench),
  };
}

function mergeRecoverableTopology(
  previous: WorkspacePaneTopology,
  observed: WorkspacePaneTopology,
): WorkspacePaneTopology {
  const panes = Object.fromEntries(
    Object.entries(previous.panes).map(([paneId, pane]) => [paneId, structuredClone(pane)]),
  ) as Record<string, WorkspacePaneDefinition>;
  for (const [paneId, pane] of Object.entries(observed.panes)) {
    panes[paneId] = structuredClone(pane);
  }
  const hasNewPane = Object.keys(observed.panes).some((paneId) => !previous.panes[paneId]);
  const root = hasNewPane
    ? buildPaneTree(Object.values(panes).sort(comparePanes))
    : previous.root
      ? structuredClone(previous.root)
      : null;
  return finalizeTopology(panes, root);
}

function buildPaneTree(panes: readonly WorkspacePaneDefinition[]): WorkspacePaneTreeNode | null {
  if (panes.length === 0) return null;
  if (panes.length === 1) {
    const paneId = panes[0]!.id;
    return { type: "pane", nodeId: paneNodeId(paneId), paneId };
  }
  const split = findGeometricSplit(panes);
  if (split) {
    const children = [buildPaneTree(split.before)!, buildPaneTree(split.after)!];
    return {
      type: "split",
      nodeId: splitNodeId(split.axis, children),
      axis: split.axis,
      children,
      weights: [span(split.before, split.axis), span(split.after, split.axis)],
    };
  }
  const ordered = [...panes].sort(comparePanes);
  const midpoint = Math.ceil(ordered.length / 2);
  const before = ordered.slice(0, midpoint);
  const after = ordered.slice(midpoint);
  const children = [buildPaneTree(before)!, buildPaneTree(after)!];
  return {
    type: "split",
    nodeId: splitNodeId("horizontal", children),
    axis: "horizontal",
    children,
    weights: [before.length, after.length],
  };
}

function finalizeTopology(
  panes: Record<string, WorkspacePaneDefinition>,
  root: WorkspacePaneTreeNode | null,
): WorkspacePaneTopology {
  const finalized = Object.fromEntries(
    Object.entries(panes).map(([id, pane]) => [id, { ...pane, parentId: null }]),
  ) as Record<string, WorkspacePaneDefinition>;
  const visit = (node: WorkspacePaneTreeNode, parentId: string | null): void => {
    if (node.type === "pane") {
      const pane = finalized[node.paneId];
      if (pane) pane.parentId = parentId;
      return;
    }
    for (const child of node.children) visit(child, node.nodeId);
  };
  if (root) visit(root, null);
  return { panes: orderedRecord(finalized), root };
}

function paneNodeId(paneId: string): string {
  return `node.pane.${stableNodeDigest(paneId)}`;
}

function splitNodeId(
  axis: "horizontal" | "vertical",
  children: readonly WorkspacePaneTreeNode[],
): string {
  return `node.split.${stableNodeDigest(
    `${axis}\0${children
      .map((child) => child.nodeId)
      .sort()
      .join("\0")}`,
  )}`;
}

function stableNodeDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function findGeometricSplit(panes: readonly WorkspacePaneDefinition[]): {
  axis: "horizontal" | "vertical";
  before: WorkspacePaneDefinition[];
  after: WorkspacePaneDefinition[];
} | null {
  let best: {
    axis: "horizontal" | "vertical";
    before: WorkspacePaneDefinition[];
    after: WorkspacePaneDefinition[];
    imbalance: number;
    axisRank: number;
    boundary: number;
  } | null = null;
  for (const [axisRank, axis] of (["horizontal", "vertical"] as const).entries()) {
    const start = (pane: WorkspacePaneDefinition) =>
      axis === "horizontal" ? pane.rect.left : pane.rect.top;
    const end = (pane: WorkspacePaneDefinition) =>
      start(pane) + (axis === "horizontal" ? pane.rect.width : pane.rect.height);
    const boundaries = [...new Set(panes.flatMap((pane) => [start(pane), end(pane)]))].sort(
      (a, b) => a - b,
    );
    for (const boundary of boundaries) {
      const before = panes.filter((pane) => end(pane) <= boundary);
      const after = panes.filter((pane) => start(pane) >= boundary);
      if (before.length > 0 && after.length > 0 && before.length + after.length === panes.length) {
        const candidate = {
          axis,
          before: [...before].sort(comparePanes),
          after: [...after].sort(comparePanes),
          imbalance: Math.abs(before.length - after.length),
          axisRank,
          boundary,
        };
        if (
          !best ||
          candidate.imbalance < best.imbalance ||
          (candidate.imbalance === best.imbalance && candidate.axisRank < best.axisRank) ||
          (candidate.imbalance === best.imbalance &&
            candidate.axisRank === best.axisRank &&
            candidate.boundary < best.boundary)
        ) {
          best = candidate;
        }
      }
    }
  }
  return best ? { axis: best.axis, before: best.before, after: best.after } : null;
}

function span(panes: readonly WorkspacePaneDefinition[], axis: "horizontal" | "vertical"): number {
  const starts = panes.map((pane) => (axis === "horizontal" ? pane.rect.left : pane.rect.top));
  const ends = panes.map(
    (pane) =>
      (axis === "horizontal" ? pane.rect.left : pane.rect.top) +
      (axis === "horizontal" ? pane.rect.width : pane.rect.height),
  );
  return Math.max(1, Math.max(...ends) - Math.min(...starts));
}

function comparePanes(a: WorkspacePaneDefinition, b: WorkspacePaneDefinition): number {
  return a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.id.localeCompare(b.id);
}

function orderWorkspaceState(state: WorkspaceStateV1): WorkspaceStateV1 {
  const layouts: Record<string, WorkspaceNamedLayout> = {};
  for (const id of Object.keys(state.layouts).sort()) {
    const layout = state.layouts[id]!;
    layouts[id] = {
      ...layout,
      snapshot: {
        topology: orderTopology(layout.snapshot.topology),
        focusedPaneId: layout.snapshot.focusedPaneId,
        workbench: cloneWorkbench(layout.snapshot.workbench),
      },
    };
  }
  const checkouts: Record<string, WorkspaceCheckoutState> = {};
  for (const id of Object.keys(state.checkouts).sort()) {
    const checkout = state.checkouts[id]!;
    checkouts[id] = {
      ...checkout,
      topology: orderTopology(checkout.topology),
      workbench: cloneWorkbench(checkout.workbench),
      bindings: orderedRecord(
        Object.fromEntries(
          Object.entries(checkout.bindings).map(([key, binding]) => [key, { ...binding }]),
        ),
      ),
      recovery: {
        ...checkout.recovery,
        missingPaneIds: [...checkout.recovery.missingPaneIds].sort(),
        externalPaneIds: [...checkout.recovery.externalPaneIds].sort(),
      },
    };
  }
  return {
    version: WORKSPACE_STATE_VERSION,
    project: { ...state.project },
    layouts,
    checkouts,
  };
}

function orderTopology(topology: WorkspacePaneTopology): WorkspacePaneTopology {
  return {
    panes: orderedRecord(
      Object.fromEntries(
        Object.entries(topology.panes).map(([key, pane]) => [
          key,
          {
            ...pane,
            cwd: pane.cwd ? { ...pane.cwd } : null,
            rect: { ...pane.rect },
          },
        ]),
      ),
    ),
    root: topology.root ? structuredClone(topology.root) : null,
  };
}

function cloneWorkbench(value: WorkspaceWorkbenchState): WorkspaceWorkbenchState {
  return { canvasPanel: value.canvasPanel, dock: { ...value.dock } };
}

function requireLayout(state: WorkspaceStateV1, layoutId: string): WorkspaceNamedLayout {
  const id = requireId(layoutId, "layout id");
  const layout = state.layouts[id];
  if (!layout) throw new Error(`workspace layout "${id}" does not exist`);
  return layout;
}

function requireCheckout(state: WorkspaceStateV1, checkoutKey: string): WorkspaceCheckoutState {
  const id = requireId(checkoutKey, "checkout key");
  const checkout = state.checkouts[id];
  if (!checkout) throw new Error(`workspace checkout "${id}" does not exist`);
  return checkout;
}

function requireWorkspaceState(state: WorkspaceStateV1): WorkspaceStateV1 {
  return WorkspaceStateV1SchemaZ.parse(state);
}

function requireSnapshot(snapshot: WorkspaceLayoutSnapshot): WorkspaceLayoutSnapshot {
  return WorkspaceLayoutSnapshotSchemaZ.parse(snapshot);
}

function requireProjectRoot(projectRoot: string): string {
  const root = cleanRequiredText(projectRoot, 4096);
  if (!root || !isAbsolute(root)) throw new Error("workspace project root must be absolute");
  return resolve(root);
}

function normalizePaneCwd(cwd: string | null, projectRoot: string): WorkspacePaneCwd | null {
  if (cwd === null) return null;
  const absolutePath = resolve(projectRoot, cwd);
  const portablePath = relative(projectRoot, absolutePath);
  const remainsInsideProject =
    portablePath === "" ||
    (portablePath !== ".." && !portablePath.startsWith(`..${sep}`) && !isAbsolute(portablePath));
  return remainsInsideProject
    ? { kind: "project-relative", path: portablePath || "." }
    : { kind: "absolute", path: absolutePath };
}

function materializePaneCwd(cwd: WorkspacePaneCwd | null, projectRoot: string): string | null {
  if (!cwd) return null;
  if (cwd.kind === "absolute") return cwd.path;
  const root = requireProjectRoot(projectRoot);
  const materialized = resolve(root, cwd.path.replace(/[/\\]+/gu, sep));
  const relativePath = relative(root, materialized);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`project-relative pane cwd "${cwd.path}" escapes checkout root`);
  }
  return materialized;
}

interface WorkspaceStateLimitFailure {
  path: string;
  message: string;
}

function workspaceStateLimitFailure(
  value: Record<string, unknown>,
): WorkspaceStateLimitFailure | null {
  if (isRecord(value.layouts)) {
    const layoutIds = Object.keys(value.layouts);
    if (layoutIds.length > WORKSPACE_STATE_MAX_LAYOUTS) {
      return { path: "$.layouts", message: "workspace layout limit exceeded" };
    }
    for (const layoutId of layoutIds) {
      const layout = value.layouts[layoutId];
      const snapshot = isRecord(layout) ? layout.snapshot : null;
      const failure = topologyLimitFailure(
        isRecord(snapshot) ? snapshot.topology : null,
        `$.layouts.${layoutId}.snapshot.topology`,
      );
      if (failure) return failure;
    }
  }
  if (isRecord(value.checkouts)) {
    const checkoutKeys = Object.keys(value.checkouts);
    if (checkoutKeys.length > WORKSPACE_STATE_MAX_CHECKOUTS) {
      return { path: "$.checkouts", message: "workspace checkout limit exceeded" };
    }
    for (const checkoutKey of checkoutKeys) {
      const checkout = value.checkouts[checkoutKey];
      if (!isRecord(checkout)) continue;
      const failure = topologyLimitFailure(
        checkout.topology,
        `$.checkouts.${checkoutKey}.topology`,
      );
      if (failure) return failure;
      if (
        isRecord(checkout.bindings) &&
        Object.keys(checkout.bindings).length > WORKSPACE_STATE_MAX_PANES
      ) {
        return {
          path: `$.checkouts.${checkoutKey}.bindings`,
          message: "workspace binding limit exceeded",
        };
      }
    }
  }
  return null;
}

function topologyLimitFailure(value: unknown, path: string): WorkspaceStateLimitFailure | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.panes) && Object.keys(value.panes).length > WORKSPACE_STATE_MAX_PANES) {
    return { path: `${path}.panes`, message: "workspace pane limit exceeded" };
  }
  if (value.root === null || value.root === undefined) return null;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: value.root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > WORKSPACE_STATE_MAX_TREE_NODES) {
      return { path: `${path}.root`, message: "workspace pane tree node limit exceeded" };
    }
    if (current.depth > WORKSPACE_STATE_MAX_TREE_DEPTH) {
      return { path: `${path}.root`, message: "workspace pane tree depth limit exceeded" };
    }
    if (isRecord(current.value) && current.value.type === "split") {
      if (!Array.isArray(current.value.children)) continue;
      if (current.value.children.length > 8) {
        return { path: `${path}.root`, message: "workspace split child limit exceeded" };
      }
      for (const child of current.value.children) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function requireId(value: string, label: string): string {
  const id = cleanId(value);
  if (!id) throw new Error(`${label} is invalid`);
  return id;
}

function requireName(value: string): string {
  const name = cleanRequiredText(value, WORKSPACE_STATE_MAX_NAME_LENGTH);
  if (!name || name.trim().length === 0) throw new Error("workspace layout name is required");
  return name;
}

function requireTimestamp(value: string): string {
  return WorkspaceTimestampSchemaZ.parse(value);
}

function cleanId(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > WORKSPACE_STATE_MAX_ID_LENGTH
  )
    return null;
  if (
    value.includes("\0") ||
    RESERVED_KEYS.has(value) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  )
    return null;
  return value;
}

function cleanNonnegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cleanNullableInt(value: unknown): number | null {
  return value === null || value === undefined ? null : cleanNonnegativeInt(value);
}

function cleanRequiredText(value: unknown, max: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !value.includes("\0")
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function orderedRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]!]),
  ) as Record<string, T>;
}
