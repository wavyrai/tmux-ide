import { z } from "zod";

/** Shared, serializable workspace-domain contract. No renderer or tmux dependencies. */
export const WORKSPACE_STATE_VERSION = 1 as const;
export const WORKSPACE_STATE_MAX_LAYOUTS = 32;
export const WORKSPACE_STATE_MAX_CHECKOUTS = 16;
export const WORKSPACE_STATE_MAX_PANES = 128;
export const WORKSPACE_STATE_MAX_TREE_DEPTH = 32;
export const WORKSPACE_STATE_MAX_TREE_NODES = 255;
export const WORKSPACE_STATE_MAX_ID_LENGTH = 128;
export const WORKSPACE_STATE_MAX_NAME_LENGTH = 80;

const RESERVED_RECORD_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SafeStringSchemaZ = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"), "text must not contain NUL bytes");
export const WorkspaceIdSchemaZ = z
  .string()
  .min(1)
  .max(WORKSPACE_STATE_MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");
const NullableTextSchemaZ = (max: number) => SafeStringSchemaZ(max).nullable();
const AbsolutePathSchemaZ = SafeStringSchemaZ(4096).refine(
  (value) => /^(?:[/\\]{1,2}|[A-Za-z]:[/\\])/u.test(value),
  "path must be absolute",
);
export const WorkspaceTimestampSchemaZ = z.string().datetime({ offset: false });

export const WorkspaceProjectIdentitySchemaZ = z
  .object({
    identityKey: WorkspaceIdSchemaZ,
    identitySource: z.enum(["git-common-dir", "canonical-realpath"]),
    identityAnchor: SafeStringSchemaZ(4096),
  })
  .strict();
export type WorkspaceProjectIdentity = z.infer<typeof WorkspaceProjectIdentitySchemaZ>;

export const WorkspacePaneRectSchemaZ = z
  .object({
    left: z.number().int().nonnegative(),
    top: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type WorkspacePaneRect = z.infer<typeof WorkspacePaneRectSchemaZ>;

export const WorkspacePaneCwdSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("project-relative"), path: SafeStringSchemaZ(4096) })
    .strict()
    .refine(
      (cwd) => projectRelativePathStaysContained(cwd.path),
      "project-relative cwd must remain inside the checkout",
    ),
  z
    .object({ kind: z.literal("absolute"), path: SafeStringSchemaZ(4096) })
    .strict()
    .refine(
      (cwd) => /^(?:[/\\]{1,2}|[A-Za-z]:[/\\])/u.test(cwd.path),
      "absolute cwd must use an absolute path",
    ),
]);
export type WorkspacePaneCwd = z.infer<typeof WorkspacePaneCwdSchemaZ>;

function projectRelativePathStaysContained(path: string): boolean {
  if (/^(?:[/\\]|[A-Za-z]:)/u.test(path)) return false;
  let depth = 0;
  for (const segment of path.split(/[/\\]+/u)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (depth === 0) return false;
      depth -= 1;
    } else {
      depth += 1;
    }
  }
  return true;
}

export const WorkspacePaneDefinitionSchemaZ = z
  .object({
    id: WorkspaceIdSchemaZ,
    /** Split-node id in the semantic tree; null only for a single-pane root. */
    parentId: WorkspaceIdSchemaZ.nullable(),
    role: z.enum(["agent", "shell"]),
    harness: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH),
    title: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH),
    command: NullableTextSchemaZ(512),
    /** Portable named-layout path; project-relative paths rebase across linked checkouts. */
    cwd: WorkspacePaneCwdSchemaZ.nullable(),
    rect: WorkspacePaneRectSchemaZ,
  })
  .strict();
export type WorkspacePaneDefinition = z.infer<typeof WorkspacePaneDefinitionSchemaZ>;
export type WorkspacePaneRole = WorkspacePaneDefinition["role"];

type WorkspacePaneTreeNodeShape =
  | { type: "pane"; nodeId: string; paneId: string }
  | {
      type: "split";
      nodeId: string;
      axis: "horizontal" | "vertical";
      children: WorkspacePaneTreeNodeShape[];
      weights: number[];
    };

const WorkspacePaneTreeNodeRecursiveSchemaZ: z.ZodType<WorkspacePaneTreeNodeShape> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("pane"),
        nodeId: WorkspaceIdSchemaZ,
        paneId: WorkspaceIdSchemaZ,
      })
      .strict(),
    z
      .object({
        type: z.literal("split"),
        nodeId: WorkspaceIdSchemaZ,
        axis: z.enum(["horizontal", "vertical"]),
        children: z.array(WorkspacePaneTreeNodeRecursiveSchemaZ).min(2).max(8),
        weights: z.array(z.number().int().positive()).min(2).max(8),
      })
      .strict()
      .refine((node) => node.children.length === node.weights.length, {
        message: "split weights must match children",
      }),
  ]),
);
export const WorkspacePaneTreeNodeSchemaZ: z.ZodType<WorkspacePaneTreeNodeShape> = z
  .unknown()
  .superRefine((value, ctx) => {
    const failure = paneTreeLimitFailure(value);
    if (failure) ctx.addIssue({ code: z.ZodIssueCode.custom, message: failure });
  })
  .pipe(WorkspacePaneTreeNodeRecursiveSchemaZ);
export type WorkspacePaneTreeNode = z.infer<typeof WorkspacePaneTreeNodeSchemaZ>;

function paneTreeLimitFailure(value: unknown): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > WORKSPACE_STATE_MAX_TREE_NODES) return "pane tree node limit exceeded";
    if (current.depth > WORKSPACE_STATE_MAX_TREE_DEPTH) return "pane tree depth limit exceeded";
    if (
      current.value &&
      typeof current.value === "object" &&
      !Array.isArray(current.value) &&
      "type" in current.value &&
      current.value.type === "split" &&
      "children" in current.value &&
      Array.isArray(current.value.children)
    ) {
      if (current.value.children.length > 8) return "split child limit exceeded";
      for (const child of current.value.children) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

export const WorkspacePaneTopologySchemaZ = z
  .object({
    panes: z.record(WorkspaceIdSchemaZ, WorkspacePaneDefinitionSchemaZ),
    root: WorkspacePaneTreeNodeSchemaZ.nullable(),
  })
  .strict()
  .superRefine((topology, ctx) => {
    const paneIds = Object.keys(topology.panes);
    if (paneIds.length > WORKSPACE_STATE_MAX_PANES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pane limit exceeded",
        path: ["panes"],
      });
    }
    for (const [key, pane] of Object.entries(topology.panes)) {
      if (key !== pane.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pane record key must match pane id",
          path: ["panes", key, "id"],
        });
      }
    }
    if ((topology.root === null) !== (paneIds.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "topology root and panes must either both be empty or both be present",
        path: ["root"],
      });
      return;
    }
    const visitedPanes = new Set<string>();
    const visitedNodes = new Set<string>();
    const visit = (node: WorkspacePaneTreeNodeShape, parentId: string | null): void => {
      if (visitedNodes.has(node.nodeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tree node ids must be unique",
          path: ["root"],
        });
      }
      visitedNodes.add(node.nodeId);
      if (node.type === "split") {
        for (const child of node.children) visit(child, node.nodeId);
        return;
      }
      const pane = topology.panes[node.paneId];
      if (!pane || visitedPanes.has(node.paneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "tree pane references must be unique and resolve",
          path: ["root"],
        });
        return;
      }
      visitedPanes.add(node.paneId);
      if (pane.parentId !== parentId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pane parentId must match its semantic split parent",
          path: ["panes", node.paneId, "parentId"],
        });
      }
    };
    if (topology.root) visit(topology.root, null);
    if (visitedPanes.size !== paneIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "every pane must occur exactly once in the tree",
        path: ["root"],
      });
    }
  });
export type WorkspacePaneTopology = z.infer<typeof WorkspacePaneTopologySchemaZ>;

export const WorkspaceDockSnapshotSchemaZ = z
  .object({
    activeTab: z.enum(["files", "changes", "missions", "activity"]),
    mode: z.enum(["collapsed", "open", "maximized"]),
    preferredHeight: z.number().int().nonnegative().nullable(),
    focusZone: z.enum(["canvas", "dock-tabs", "dock-body"]),
  })
  .strict();
export type WorkspaceDockSnapshot = z.infer<typeof WorkspaceDockSnapshotSchemaZ>;

export const WorkspaceWorkbenchStateSchemaZ = z
  .object({
    canvasPanel: z.enum(["home", "terminals"]),
    dock: WorkspaceDockSnapshotSchemaZ,
  })
  .strict();
export type WorkspaceWorkbenchState = z.infer<typeof WorkspaceWorkbenchStateSchemaZ>;
export type WorkspaceCanvasPanel = WorkspaceWorkbenchState["canvasPanel"];

export const WorkspaceLayoutSnapshotSchemaZ = z
  .object({
    topology: WorkspacePaneTopologySchemaZ,
    focusedPaneId: WorkspaceIdSchemaZ.nullable(),
    workbench: WorkspaceWorkbenchStateSchemaZ,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.focusedPaneId && !snapshot.topology.panes[snapshot.focusedPaneId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "focused pane must exist in topology",
        path: ["focusedPaneId"],
      });
    }
  });
export type WorkspaceLayoutSnapshot = z.infer<typeof WorkspaceLayoutSnapshotSchemaZ>;

export const WorkspaceNamedLayoutSchemaZ = z
  .object({
    id: WorkspaceIdSchemaZ,
    name: SafeStringSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH).refine(
      (value) => value.trim().length > 0,
      "layout name must contain visible text",
    ),
    revision: z.number().int().positive(),
    createdAt: WorkspaceTimestampSchemaZ,
    updatedAt: WorkspaceTimestampSchemaZ,
    snapshot: WorkspaceLayoutSnapshotSchemaZ,
  })
  .strict();
export type WorkspaceNamedLayout = z.infer<typeof WorkspaceNamedLayoutSchemaZ>;

export const WorkspacePaneBindingSchemaZ = z
  .object({
    semanticPaneId: WorkspaceIdSchemaZ,
    runtimePaneId: z.string().regex(/^%[0-9]+$/u),
    lastSeenAt: WorkspaceTimestampSchemaZ,
  })
  .strict();
export type WorkspacePaneBinding = z.infer<typeof WorkspacePaneBindingSchemaZ>;

export const WorkspaceRecoveryStateSchemaZ = z
  .object({
    status: z.enum(["empty", "clean", "reconciled"]),
    capturedAt: WorkspaceTimestampSchemaZ.nullable(),
    sessionName: NullableTextSchemaZ(256),
    windowIndex: z.number().int().nonnegative().nullable(),
    windowName: NullableTextSchemaZ(256),
    missingPaneIds: z.array(WorkspaceIdSchemaZ).max(WORKSPACE_STATE_MAX_PANES),
    externalPaneIds: z.array(WorkspaceIdSchemaZ).max(WORKSPACE_STATE_MAX_PANES),
  })
  .strict();
export type WorkspaceRecoveryState = z.infer<typeof WorkspaceRecoveryStateSchemaZ>;

export const WorkspaceCheckoutStateSchemaZ = z
  .object({
    checkoutKey: WorkspaceIdSchemaZ,
    projectRoot: AbsolutePathSchemaZ,
    activeLayoutId: WorkspaceIdSchemaZ.nullable(),
    topology: WorkspacePaneTopologySchemaZ,
    focusedPaneId: WorkspaceIdSchemaZ.nullable(),
    workbench: WorkspaceWorkbenchStateSchemaZ,
    bindings: z.record(WorkspaceIdSchemaZ, WorkspacePaneBindingSchemaZ),
    recovery: WorkspaceRecoveryStateSchemaZ,
  })
  .strict()
  .superRefine((checkout, ctx) => {
    if (checkout.focusedPaneId && !checkout.topology.panes[checkout.focusedPaneId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "focused pane must exist in topology",
        path: ["focusedPaneId"],
      });
    }
    const runtimePaneIds = new Set<string>();
    for (const [key, binding] of Object.entries(checkout.bindings)) {
      if (key !== binding.semanticPaneId || !checkout.topology.panes[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "binding key must match a live semantic pane",
          path: ["bindings", key],
        });
      }
      if (runtimePaneIds.has(binding.runtimePaneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "runtime pane bindings must be injective",
          path: ["bindings", key, "runtimePaneId"],
        });
      }
      runtimePaneIds.add(binding.runtimePaneId);
    }
  });
export type WorkspaceCheckoutState = z.infer<typeof WorkspaceCheckoutStateSchemaZ>;

export const WorkspaceStateV1SchemaZ = z
  .object({
    version: z.literal(WORKSPACE_STATE_VERSION),
    project: WorkspaceProjectIdentitySchemaZ,
    layouts: z.record(WorkspaceIdSchemaZ, WorkspaceNamedLayoutSchemaZ),
    checkouts: z.record(WorkspaceIdSchemaZ, WorkspaceCheckoutStateSchemaZ),
  })
  .strict()
  .superRefine((state, ctx) => {
    if (Object.keys(state.layouts).length > WORKSPACE_STATE_MAX_LAYOUTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "layout limit exceeded",
        path: ["layouts"],
      });
    }
    if (Object.keys(state.checkouts).length > WORKSPACE_STATE_MAX_CHECKOUTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "checkout limit exceeded",
        path: ["checkouts"],
      });
    }
    for (const [key, layout] of Object.entries(state.layouts)) {
      if (key !== layout.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "layout record key must match layout id",
          path: ["layouts", key, "id"],
        });
      }
    }
    for (const [key, checkout] of Object.entries(state.checkouts)) {
      if (key !== checkout.checkoutKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "checkout record key must match checkout key",
          path: ["checkouts", key, "checkoutKey"],
        });
      }
      if (checkout.activeLayoutId && !state.layouts[checkout.activeLayoutId]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "active layout must exist",
          path: ["checkouts", key, "activeLayoutId"],
        });
      }
    }
  });
export type WorkspaceStateV1 = z.infer<typeof WorkspaceStateV1SchemaZ>;

export const WorkspaceObservedPaneSchemaZ = z
  .object({
    semanticPaneId: WorkspaceIdSchemaZ,
    runtimePaneId: z.string().regex(/^%[0-9]+$/u),
    role: z.enum(["agent", "shell"]),
    harness: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH).optional(),
    title: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH).optional(),
    command: NullableTextSchemaZ(512).optional(),
    cwd: NullableTextSchemaZ(4096).optional(),
    rect: WorkspacePaneRectSchemaZ,
    active: z.boolean().optional(),
  })
  .strict();
export type WorkspaceObservedPane = z.infer<typeof WorkspaceObservedPaneSchemaZ>;

export const WorkspaceObservationSchemaZ = z
  .object({
    checkoutKey: WorkspaceIdSchemaZ,
    projectRoot: AbsolutePathSchemaZ,
    observedAt: WorkspaceTimestampSchemaZ,
    sessionName: NullableTextSchemaZ(256),
    windowIndex: z.number().int().nonnegative().nullable(),
    windowName: NullableTextSchemaZ(256),
    panes: z.array(WorkspaceObservedPaneSchemaZ).max(WORKSPACE_STATE_MAX_PANES),
    focusedPaneId: WorkspaceIdSchemaZ.nullable(),
    workbench: WorkspaceWorkbenchStateSchemaZ,
  })
  .strict()
  .superRefine((observation, ctx) => {
    const semanticPaneIds = new Set<string>();
    const runtimePaneIds = new Set<string>();
    for (const [index, pane] of observation.panes.entries()) {
      if (semanticPaneIds.has(pane.semanticPaneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "observed semantic pane ids must be unique",
          path: ["panes", index, "semanticPaneId"],
        });
      }
      if (runtimePaneIds.has(pane.runtimePaneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "observed runtime pane ids must be unique",
          path: ["panes", index, "runtimePaneId"],
        });
      }
      semanticPaneIds.add(pane.semanticPaneId);
      runtimePaneIds.add(pane.runtimePaneId);
    }
  });
export type WorkspaceObservation = z.infer<typeof WorkspaceObservationSchemaZ>;

export const WorkspaceLayoutApplyPlanSchemaZ = z
  .object({
    layoutId: WorkspaceIdSchemaZ,
    checkoutKey: WorkspaceIdSchemaZ,
    projectRoot: AbsolutePathSchemaZ,
    sessionName: NullableTextSchemaZ(256),
    windowIndex: z.number().int().nonnegative().nullable(),
    windowName: NullableTextSchemaZ(256),
    targetTopology: WorkspacePaneTopologySchemaZ,
    materializedPaneCwds: z.record(WorkspaceIdSchemaZ, NullableTextSchemaZ(4096)),
    targetFocusedPaneId: WorkspaceIdSchemaZ.nullable(),
    liveFocusedPaneId: WorkspaceIdSchemaZ.nullable(),
    workbench: WorkspaceWorkbenchStateSchemaZ,
    retainedBindings: z.record(WorkspaceIdSchemaZ, WorkspacePaneBindingSchemaZ),
    retainedPaneIds: z.array(WorkspaceIdSchemaZ),
    missingPaneIds: z.array(WorkspaceIdSchemaZ),
    externalPaneIds: z.array(WorkspaceIdSchemaZ),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (plan.targetFocusedPaneId && !plan.targetTopology.panes[plan.targetFocusedPaneId]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target focus must exist in target topology",
        path: ["targetFocusedPaneId"],
      });
    }
    for (const [paneId, binding] of Object.entries(plan.retainedBindings)) {
      if (
        paneId !== binding.semanticPaneId ||
        !plan.targetTopology.panes[paneId] ||
        !plan.retainedPaneIds.includes(paneId)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "retained binding must correlate to a retained target pane",
          path: ["retainedBindings", paneId],
        });
      }
    }
  });
export type WorkspaceLayoutApplyPlan = z.infer<typeof WorkspaceLayoutApplyPlanSchemaZ>;

export const WorkspaceStateDiagnosticSchemaZ = z
  .object({
    code: z.enum([
      "MALFORMED",
      "UNSUPPORTED_VERSION",
      "INVALID_FIELD",
      "OVERSIZED",
      "IDENTITY_MISMATCH",
      "PROJECT_RELINKED",
    ]),
    path: z.string(),
    message: z.string(),
  })
  .strict();
export type WorkspaceStateDiagnostic = z.infer<typeof WorkspaceStateDiagnosticSchemaZ>;

export interface ParsedWorkspaceState {
  state: WorkspaceStateV1;
  diagnostics: WorkspaceStateDiagnostic[];
  writeProtected: boolean;
}
