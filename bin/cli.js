#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// packages/contracts/src/lib-internal/auth.ts
import { z } from "zod";
var AuthConfigSchema;
var init_auth = __esm({
  "packages/contracts/src/lib-internal/auth.ts"() {
    "use strict";
    AuthConfigSchema = z.object({
      /** Auth method: "none" disables auth (default), "ssh" enables SSH key challenge-response. */
      method: z.enum(["none", "ssh"]).default("none"),
      /** JWT secret — auto-generated if omitted. */
      secret: z.string().optional(),
      /** Token expiry in seconds (default 86400 = 24h). */
      token_expiry: z.number().min(60).default(86400)
    });
  }
});

// packages/contracts/src/lib-internal/hq.ts
import { z as z2 } from "zod";
var RegistrationPayloadSchema, HQConfigSchema;
var init_hq = __esm({
  "packages/contracts/src/lib-internal/hq.ts"() {
    "use strict";
    RegistrationPayloadSchema = z2.object({
      id: z2.string().min(1),
      name: z2.string().min(1),
      url: z2.string().url(),
      token: z2.string().min(1)
    });
    HQConfigSchema = z2.object({
      enabled: z2.boolean().default(false),
      role: z2.enum(["hq", "remote"]),
      hq_url: z2.string().url().optional(),
      secret: z2.string().optional(),
      heartbeat_interval: z2.number().min(1e3).default(15e3),
      machine_name: z2.string().optional()
    });
  }
});

// packages/contracts/src/workspace-state.ts
import { z as z3 } from "zod";
function projectRelativePathStaysContained(path2) {
  if (/^(?:[/\\]|[A-Za-z]:)/u.test(path2)) return false;
  let depth = 0;
  for (const segment of path2.split(/[/\\]+/u)) {
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
function paneTreeLimitFailure(value) {
  const stack = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > WORKSPACE_STATE_MAX_TREE_NODES) return "pane tree node limit exceeded";
    if (current.depth > WORKSPACE_STATE_MAX_TREE_DEPTH) return "pane tree depth limit exceeded";
    if (current.value && typeof current.value === "object" && !Array.isArray(current.value) && "type" in current.value && current.value.type === "split" && "children" in current.value && Array.isArray(current.value.children)) {
      if (current.value.children.length > 8) return "split child limit exceeded";
      for (const child of current.value.children) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}
var WORKSPACE_STATE_VERSION, WORKSPACE_SEMANTIC_PANE_OPTION, WORKSPACE_STATE_MAX_LAYOUTS, WORKSPACE_STATE_MAX_CHECKOUTS, WORKSPACE_STATE_MAX_PANES, WORKSPACE_STATE_MAX_TREE_DEPTH, WORKSPACE_STATE_MAX_TREE_NODES, WORKSPACE_STATE_MAX_ID_LENGTH, WORKSPACE_STATE_MAX_NAME_LENGTH, RESERVED_RECORD_KEYS, SafeStringSchemaZ, WorkspaceIdSchemaZ, NullableTextSchemaZ, AbsolutePathSchemaZ, WorkspaceTimestampSchemaZ, WorkspaceProjectIdentitySchemaZ, WorkspacePaneRectSchemaZ, WorkspacePaneCwdSchemaZ, WorkspacePaneDefinitionSchemaZ, WorkspacePaneTreeNodeRecursiveSchemaZ, WorkspacePaneTreeNodeSchemaZ, WorkspacePaneTopologySchemaZ, WorkspaceDockSnapshotSchemaZ, WorkspaceWorkbenchStateSchemaZ, WorkspaceLayoutSnapshotSchemaZ, WorkspaceNamedLayoutSchemaZ, WorkspacePaneBindingSchemaZ, WorkspaceRecoveryStateSchemaZ, WorkspaceCheckoutStateSchemaZ, WorkspaceStateV1SchemaZ, WorkspaceObservedPaneSchemaZ, WorkspaceObservationSchemaZ, WorkspaceLayoutApplyPlanSchemaZ, WorkspaceStateDiagnosticSchemaZ;
var init_workspace_state = __esm({
  "packages/contracts/src/workspace-state.ts"() {
    "use strict";
    WORKSPACE_STATE_VERSION = 1;
    WORKSPACE_SEMANTIC_PANE_OPTION = "@tmux_ide_pane_id";
    WORKSPACE_STATE_MAX_LAYOUTS = 32;
    WORKSPACE_STATE_MAX_CHECKOUTS = 16;
    WORKSPACE_STATE_MAX_PANES = 128;
    WORKSPACE_STATE_MAX_TREE_DEPTH = 32;
    WORKSPACE_STATE_MAX_TREE_NODES = 255;
    WORKSPACE_STATE_MAX_ID_LENGTH = 128;
    WORKSPACE_STATE_MAX_NAME_LENGTH = 80;
    RESERVED_RECORD_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
    SafeStringSchemaZ = (max) => z3.string().min(1).max(max).refine((value) => !value.includes("\0"), "text must not contain NUL bytes");
    WorkspaceIdSchemaZ = z3.string().min(1).max(WORKSPACE_STATE_MAX_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).refine((value) => !RESERVED_RECORD_KEYS.has(value), "reserved record key is not allowed");
    NullableTextSchemaZ = (max) => SafeStringSchemaZ(max).nullable();
    AbsolutePathSchemaZ = SafeStringSchemaZ(4096).refine(
      (value) => /^(?:[/\\]{1,2}|[A-Za-z]:[/\\])/u.test(value),
      "path must be absolute"
    );
    WorkspaceTimestampSchemaZ = z3.string().datetime({ offset: false });
    WorkspaceProjectIdentitySchemaZ = z3.object({
      identityKey: WorkspaceIdSchemaZ,
      identitySource: z3.enum(["git-common-dir", "canonical-realpath"]),
      identityAnchor: SafeStringSchemaZ(4096)
    }).strict();
    WorkspacePaneRectSchemaZ = z3.object({
      left: z3.number().int().nonnegative(),
      top: z3.number().int().nonnegative(),
      width: z3.number().int().positive(),
      height: z3.number().int().positive()
    }).strict();
    WorkspacePaneCwdSchemaZ = z3.discriminatedUnion("kind", [
      z3.object({ kind: z3.literal("project-relative"), path: SafeStringSchemaZ(4096) }).strict().refine(
        (cwd) => projectRelativePathStaysContained(cwd.path),
        "project-relative cwd must remain inside the checkout"
      ),
      z3.object({ kind: z3.literal("absolute"), path: SafeStringSchemaZ(4096) }).strict().refine(
        (cwd) => /^(?:[/\\]{1,2}|[A-Za-z]:[/\\])/u.test(cwd.path),
        "absolute cwd must use an absolute path"
      )
    ]);
    WorkspacePaneDefinitionSchemaZ = z3.object({
      id: WorkspaceIdSchemaZ,
      /** Split-node id in the semantic tree; null only for a single-pane root. */
      parentId: WorkspaceIdSchemaZ.nullable(),
      role: z3.enum(["agent", "shell"]),
      harness: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH),
      title: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH),
      command: NullableTextSchemaZ(512),
      /** Portable named-layout path; project-relative paths rebase across linked checkouts. */
      cwd: WorkspacePaneCwdSchemaZ.nullable(),
      rect: WorkspacePaneRectSchemaZ
    }).strict();
    WorkspacePaneTreeNodeRecursiveSchemaZ = z3.lazy(
      () => z3.discriminatedUnion("type", [
        z3.object({
          type: z3.literal("pane"),
          nodeId: WorkspaceIdSchemaZ,
          paneId: WorkspaceIdSchemaZ
        }).strict(),
        z3.object({
          type: z3.literal("split"),
          nodeId: WorkspaceIdSchemaZ,
          axis: z3.enum(["horizontal", "vertical"]),
          children: z3.array(WorkspacePaneTreeNodeRecursiveSchemaZ).min(2).max(8),
          weights: z3.array(z3.number().int().positive()).min(2).max(8)
        }).strict().refine((node) => node.children.length === node.weights.length, {
          message: "split weights must match children"
        })
      ])
    );
    WorkspacePaneTreeNodeSchemaZ = z3.unknown().superRefine((value, ctx) => {
      const failure = paneTreeLimitFailure(value);
      if (failure) ctx.addIssue({ code: z3.ZodIssueCode.custom, message: failure });
    }).pipe(WorkspacePaneTreeNodeRecursiveSchemaZ);
    WorkspacePaneTopologySchemaZ = z3.object({
      panes: z3.record(WorkspaceIdSchemaZ, WorkspacePaneDefinitionSchemaZ),
      root: WorkspacePaneTreeNodeSchemaZ.nullable()
    }).strict().superRefine((topology, ctx) => {
      const paneIds = Object.keys(topology.panes);
      if (paneIds.length > WORKSPACE_STATE_MAX_PANES) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "pane limit exceeded",
          path: ["panes"]
        });
      }
      for (const [key, pane] of Object.entries(topology.panes)) {
        if (key !== pane.id) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "pane record key must match pane id",
            path: ["panes", key, "id"]
          });
        }
      }
      if (topology.root === null !== (paneIds.length === 0)) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "topology root and panes must either both be empty or both be present",
          path: ["root"]
        });
        return;
      }
      const visitedPanes = /* @__PURE__ */ new Set();
      const visitedNodes = /* @__PURE__ */ new Set();
      const visit = (node, parentId) => {
        if (visitedNodes.has(node.nodeId)) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "tree node ids must be unique",
            path: ["root"]
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
            code: z3.ZodIssueCode.custom,
            message: "tree pane references must be unique and resolve",
            path: ["root"]
          });
          return;
        }
        visitedPanes.add(node.paneId);
        if (pane.parentId !== parentId) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "pane parentId must match its semantic split parent",
            path: ["panes", node.paneId, "parentId"]
          });
        }
      };
      if (topology.root) visit(topology.root, null);
      if (visitedPanes.size !== paneIds.length) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "every pane must occur exactly once in the tree",
          path: ["root"]
        });
      }
    });
    WorkspaceDockSnapshotSchemaZ = z3.object({
      activeTab: z3.enum(["files", "changes", "missions", "activity"]),
      mode: z3.enum(["collapsed", "open", "maximized"]),
      preferredHeight: z3.number().int().nonnegative().nullable(),
      focusZone: z3.enum(["canvas", "dock-tabs", "dock-body"])
    }).strict();
    WorkspaceWorkbenchStateSchemaZ = z3.object({
      canvasPanel: z3.enum(["home", "terminals"]),
      dock: WorkspaceDockSnapshotSchemaZ
    }).strict();
    WorkspaceLayoutSnapshotSchemaZ = z3.object({
      topology: WorkspacePaneTopologySchemaZ,
      focusedPaneId: WorkspaceIdSchemaZ.nullable(),
      workbench: WorkspaceWorkbenchStateSchemaZ
    }).strict().superRefine((snapshot, ctx) => {
      if (snapshot.focusedPaneId && !snapshot.topology.panes[snapshot.focusedPaneId]) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "focused pane must exist in topology",
          path: ["focusedPaneId"]
        });
      }
    });
    WorkspaceNamedLayoutSchemaZ = z3.object({
      id: WorkspaceIdSchemaZ,
      name: SafeStringSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH).refine(
        (value) => value.trim().length > 0,
        "layout name must contain visible text"
      ),
      revision: z3.number().int().positive(),
      createdAt: WorkspaceTimestampSchemaZ,
      updatedAt: WorkspaceTimestampSchemaZ,
      snapshot: WorkspaceLayoutSnapshotSchemaZ
    }).strict();
    WorkspacePaneBindingSchemaZ = z3.object({
      semanticPaneId: WorkspaceIdSchemaZ,
      runtimePaneId: z3.string().regex(/^%[0-9]+$/u),
      lastSeenAt: WorkspaceTimestampSchemaZ
    }).strict();
    WorkspaceRecoveryStateSchemaZ = z3.object({
      status: z3.enum(["empty", "clean", "reconciled"]),
      capturedAt: WorkspaceTimestampSchemaZ.nullable(),
      sessionName: NullableTextSchemaZ(256),
      windowIndex: z3.number().int().nonnegative().nullable(),
      windowName: NullableTextSchemaZ(256),
      missingPaneIds: z3.array(WorkspaceIdSchemaZ).max(WORKSPACE_STATE_MAX_PANES),
      externalPaneIds: z3.array(WorkspaceIdSchemaZ).max(WORKSPACE_STATE_MAX_PANES)
    }).strict();
    WorkspaceCheckoutStateSchemaZ = z3.object({
      checkoutKey: WorkspaceIdSchemaZ,
      projectRoot: AbsolutePathSchemaZ,
      activeLayoutId: WorkspaceIdSchemaZ.nullable(),
      topology: WorkspacePaneTopologySchemaZ,
      focusedPaneId: WorkspaceIdSchemaZ.nullable(),
      workbench: WorkspaceWorkbenchStateSchemaZ,
      bindings: z3.record(WorkspaceIdSchemaZ, WorkspacePaneBindingSchemaZ),
      recovery: WorkspaceRecoveryStateSchemaZ
    }).strict().superRefine((checkout, ctx) => {
      if (checkout.focusedPaneId && !checkout.topology.panes[checkout.focusedPaneId]) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "focused pane must exist in topology",
          path: ["focusedPaneId"]
        });
      }
      const runtimePaneIds = /* @__PURE__ */ new Set();
      for (const [key, binding] of Object.entries(checkout.bindings)) {
        if (key !== binding.semanticPaneId || !checkout.topology.panes[key]) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "binding key must match a live semantic pane",
            path: ["bindings", key]
          });
        }
        if (runtimePaneIds.has(binding.runtimePaneId)) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "runtime pane bindings must be injective",
            path: ["bindings", key, "runtimePaneId"]
          });
        }
        runtimePaneIds.add(binding.runtimePaneId);
      }
    });
    WorkspaceStateV1SchemaZ = z3.object({
      version: z3.literal(WORKSPACE_STATE_VERSION),
      project: WorkspaceProjectIdentitySchemaZ,
      layouts: z3.record(WorkspaceIdSchemaZ, WorkspaceNamedLayoutSchemaZ),
      checkouts: z3.record(WorkspaceIdSchemaZ, WorkspaceCheckoutStateSchemaZ)
    }).strict().superRefine((state, ctx) => {
      if (Object.keys(state.layouts).length > WORKSPACE_STATE_MAX_LAYOUTS) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "layout limit exceeded",
          path: ["layouts"]
        });
      }
      if (Object.keys(state.checkouts).length > WORKSPACE_STATE_MAX_CHECKOUTS) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "checkout limit exceeded",
          path: ["checkouts"]
        });
      }
      for (const [key, layout] of Object.entries(state.layouts)) {
        if (key !== layout.id) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "layout record key must match layout id",
            path: ["layouts", key, "id"]
          });
        }
      }
      for (const [key, checkout] of Object.entries(state.checkouts)) {
        if (key !== checkout.checkoutKey) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "checkout record key must match checkout key",
            path: ["checkouts", key, "checkoutKey"]
          });
        }
        if (checkout.activeLayoutId && !state.layouts[checkout.activeLayoutId]) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "active layout must exist",
            path: ["checkouts", key, "activeLayoutId"]
          });
        }
      }
    });
    WorkspaceObservedPaneSchemaZ = z3.object({
      semanticPaneId: WorkspaceIdSchemaZ,
      runtimePaneId: z3.string().regex(/^%[0-9]+$/u),
      role: z3.enum(["agent", "shell"]),
      harness: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH).optional(),
      title: NullableTextSchemaZ(WORKSPACE_STATE_MAX_NAME_LENGTH).optional(),
      command: NullableTextSchemaZ(512).optional(),
      cwd: NullableTextSchemaZ(4096).optional(),
      rect: WorkspacePaneRectSchemaZ,
      active: z3.boolean().optional()
    }).strict();
    WorkspaceObservationSchemaZ = z3.object({
      checkoutKey: WorkspaceIdSchemaZ,
      projectRoot: AbsolutePathSchemaZ,
      observedAt: WorkspaceTimestampSchemaZ,
      sessionName: NullableTextSchemaZ(256),
      windowIndex: z3.number().int().nonnegative().nullable(),
      windowName: NullableTextSchemaZ(256),
      panes: z3.array(WorkspaceObservedPaneSchemaZ).max(WORKSPACE_STATE_MAX_PANES),
      focusedPaneId: WorkspaceIdSchemaZ.nullable(),
      workbench: WorkspaceWorkbenchStateSchemaZ
    }).strict().superRefine((observation2, ctx) => {
      const semanticPaneIds = /* @__PURE__ */ new Set();
      const runtimePaneIds = /* @__PURE__ */ new Set();
      for (const [index, pane] of observation2.panes.entries()) {
        if (semanticPaneIds.has(pane.semanticPaneId)) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "observed semantic pane ids must be unique",
            path: ["panes", index, "semanticPaneId"]
          });
        }
        if (runtimePaneIds.has(pane.runtimePaneId)) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "observed runtime pane ids must be unique",
            path: ["panes", index, "runtimePaneId"]
          });
        }
        semanticPaneIds.add(pane.semanticPaneId);
        runtimePaneIds.add(pane.runtimePaneId);
      }
    });
    WorkspaceLayoutApplyPlanSchemaZ = z3.object({
      layoutId: WorkspaceIdSchemaZ,
      checkoutKey: WorkspaceIdSchemaZ,
      projectRoot: AbsolutePathSchemaZ,
      sessionName: NullableTextSchemaZ(256),
      windowIndex: z3.number().int().nonnegative().nullable(),
      windowName: NullableTextSchemaZ(256),
      targetTopology: WorkspacePaneTopologySchemaZ,
      materializedPaneCwds: z3.record(WorkspaceIdSchemaZ, NullableTextSchemaZ(4096)),
      targetFocusedPaneId: WorkspaceIdSchemaZ.nullable(),
      liveFocusedPaneId: WorkspaceIdSchemaZ.nullable(),
      workbench: WorkspaceWorkbenchStateSchemaZ,
      retainedBindings: z3.record(WorkspaceIdSchemaZ, WorkspacePaneBindingSchemaZ),
      retainedPaneIds: z3.array(WorkspaceIdSchemaZ),
      missingPaneIds: z3.array(WorkspaceIdSchemaZ),
      externalPaneIds: z3.array(WorkspaceIdSchemaZ)
    }).strict().superRefine((plan, ctx) => {
      if (plan.targetFocusedPaneId && !plan.targetTopology.panes[plan.targetFocusedPaneId]) {
        ctx.addIssue({
          code: z3.ZodIssueCode.custom,
          message: "target focus must exist in target topology",
          path: ["targetFocusedPaneId"]
        });
      }
      for (const [paneId, binding] of Object.entries(plan.retainedBindings)) {
        if (paneId !== binding.semanticPaneId || !plan.targetTopology.panes[paneId] || !plan.retainedPaneIds.includes(paneId)) {
          ctx.addIssue({
            code: z3.ZodIssueCode.custom,
            message: "retained binding must correlate to a retained target pane",
            path: ["retainedBindings", paneId]
          });
        }
      }
    });
    WorkspaceStateDiagnosticSchemaZ = z3.object({
      code: z3.enum([
        "MALFORMED",
        "UNSUPPORTED_VERSION",
        "INVALID_FIELD",
        "OVERSIZED",
        "IDENTITY_MISMATCH",
        "PROJECT_RELINKED"
      ]),
      path: z3.string(),
      message: z3.string()
    }).strict();
  }
});

// packages/contracts/src/ide-config.ts
import { z as z4 } from "zod";
var sizeField, ThemeConfigSchema, PaneSchema, RowSchema, WebhookConfigSchema, OrchestratorYamlConfigSchema, TunnelConfigSchema, CommandCenterConfigSchema, DashboardConfigSchema, SidebarConfigSchema, IdeConfigSchema, PaneActionSchema, SessionStateSchema;
var init_ide_config = __esm({
  "packages/contracts/src/ide-config.ts"() {
    "use strict";
    init_auth();
    init_hq();
    init_workspace_state();
    sizeField = z4.string().regex(/^[1-9]\d*%$/).refine((v) => parseInt(v) <= 100);
    ThemeConfigSchema = z4.object({
      accent: z4.string().optional(),
      border: z4.string().optional(),
      bg: z4.string().optional(),
      fg: z4.string().optional()
    });
    PaneSchema = z4.object({
      /** Stable semantic identity. Strongly recommended for long-lived agent panes. */
      id: WorkspaceIdSchemaZ.optional(),
      title: z4.string().optional(),
      command: z4.string().optional(),
      type: z4.enum([
        "explorer",
        "changes",
        "preview",
        "tasks",
        "costs",
        "config",
        "mission-control",
        "sidebar"
      ]).optional(),
      target: z4.string().optional(),
      dir: z4.string().optional(),
      size: sizeField.optional(),
      focus: z4.boolean().optional(),
      env: z4.record(z4.string(), z4.union([z4.string(), z4.number()])).optional(),
      role: z4.enum(["lead", "teammate", "planner", "validator", "researcher"]).optional(),
      task: z4.string().optional(),
      specialty: z4.string().optional(),
      skill: z4.string().optional()
    });
    RowSchema = z4.object({
      size: sizeField.optional(),
      panes: z4.array(PaneSchema).min(1)
    });
    WebhookConfigSchema = z4.object({
      url: z4.string(),
      events: z4.array(z4.string()).optional(),
      secret: z4.string().optional()
    });
    OrchestratorYamlConfigSchema = z4.object({
      enabled: z4.boolean().optional(),
      port: z4.number().int().positive().optional(),
      auto_dispatch: z4.boolean().optional(),
      stall_timeout: z4.number().optional(),
      poll_interval: z4.number().min(100).optional(),
      master_pane: z4.string().optional(),
      before_run: z4.string().optional(),
      after_run: z4.string().optional(),
      dispatch_mode: z4.enum(["tasks", "goals", "missions"]).optional(),
      max_concurrent_agents: z4.number().min(1).max(50).optional(),
      widgets: z4.boolean().optional(),
      webhooks: z4.array(WebhookConfigSchema).optional(),
      services: z4.record(
        z4.string(),
        z4.object({
          command: z4.string(),
          port: z4.number().optional(),
          healthcheck: z4.string().optional()
        })
      ).optional(),
      research: z4.object({
        enabled: z4.boolean().optional(),
        triggers: z4.object({
          mission_start: z4.boolean().optional(),
          milestone_progress: z4.number().min(0).optional(),
          milestone_complete: z4.boolean().optional(),
          periodic_minutes: z4.number().min(0).optional(),
          retry_cluster: z4.boolean().optional(),
          stall_detected: z4.boolean().optional(),
          discovered_issue: z4.boolean().optional()
        }).optional()
      }).optional()
    });
    TunnelConfigSchema = z4.object({
      provider: z4.enum(["tailscale", "ngrok", "cloudflare"]),
      auto_start: z4.boolean().optional(),
      port: z4.number().int().positive().optional(),
      domain: z4.string().optional(),
      authtoken: z4.string().optional()
    });
    CommandCenterConfigSchema = z4.object({
      port: z4.number().optional(),
      enabled: z4.boolean().optional()
    });
    DashboardConfigSchema = z4.object({
      port: z4.number().int().positive().optional()
    });
    SidebarConfigSchema = z4.union([
      z4.boolean(),
      z4.object({ width: z4.string().optional() })
    ]);
    IdeConfigSchema = z4.object({
      name: z4.string().optional(),
      before: z4.string().optional(),
      team: z4.object({
        name: z4.string(),
        model: z4.string().optional(),
        permissions: z4.array(z4.string()).optional()
      }).optional(),
      rows: z4.array(RowSchema).min(1),
      sidebar: SidebarConfigSchema.optional(),
      theme: ThemeConfigSchema.optional(),
      orchestrator: OrchestratorYamlConfigSchema.optional(),
      command_center: CommandCenterConfigSchema.optional(),
      dashboard: DashboardConfigSchema.optional(),
      auth: AuthConfigSchema.optional(),
      tunnel: TunnelConfigSchema.optional(),
      hq: HQConfigSchema.optional()
    }).superRefine((config2, context) => {
      const explicitPaneIds = /* @__PURE__ */ new Set();
      for (const [rowIndex, row] of config2.rows.entries()) {
        for (const [paneIndex, pane] of row.panes.entries()) {
          if (!pane.id) continue;
          if (explicitPaneIds.has(pane.id)) {
            context.addIssue({
              code: "custom",
              path: ["rows", rowIndex, "panes", paneIndex, "id"],
              message: `Duplicate pane id "${pane.id}"`
            });
          }
          explicitPaneIds.add(pane.id);
        }
      }
    });
    PaneActionSchema = z4.object({
      targetPane: z4.string(),
      title: z4.string().nullable(),
      chdir: z4.string().nullable(),
      exports: z4.array(z4.string()),
      command: z4.string().nullable(),
      widgetType: z4.string().nullable(),
      widgetTarget: z4.string().nullable(),
      paneRole: z4.string().nullable(),
      paneType: z4.string().nullable()
    });
    SessionStateSchema = z4.object({
      running: z4.boolean(),
      reason: z4.string().nullable()
    });
  }
});

// packages/contracts/src/domain.ts
import { z as z5 } from "zod";
function checkUnique(values2, path2, label, ctx) {
  const seen = /* @__PURE__ */ new Set();
  for (const value of values2) {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        path: path2,
        message: `duplicate ${label} are not allowed`
      });
      return;
    }
    seen.add(value);
  }
}
var MissionIdPattern, TaskIdPattern, AttemptIdPattern, ProofIdPattern, ReferenceIdPattern, TmuxPaneIdPattern, TimestampSchemaZ, MissionDomainVersionSchemaZ, MissionIdSchemaZ, MissionTaskIdSchemaZ, MissionAttemptIdSchemaZ, MissionProofIdSchemaZ, MissionReferenceIdSchemaZ, MissionTerminalReferenceSchemaZ, MissionActorSchemaZ, MissionSourceSchemaZ, MissionStatusSchemaZ, MissionTaskStatusSchemaZ, MissionAttemptStatusSchemaZ, MissionAttemptOutcomeSchemaZ, MissionProofTestSchemaZ, MissionProofSchemaZ, MissionEventBaseSchemaZ, MissionEventSchemas, MissionEventSchemaZ, MissionTaskSchemaZ, MissionAttemptSchemaZ, MissionSnapshotSchemaZ, MissionProjectStateSchemaZ, MissionHistoryEntrySchemaZ, PaneInfoSchemaZ, SessionOverviewSchemaZ;
var init_domain = __esm({
  "packages/contracts/src/domain.ts"() {
    "use strict";
    MissionIdPattern = /^mis_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
    TaskIdPattern = /^tsk_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
    AttemptIdPattern = /^att_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
    ProofIdPattern = /^prf_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
    ReferenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
    TmuxPaneIdPattern = /^%[0-9]{1,20}$/u;
    TimestampSchemaZ = z5.string().refine(
      (value) => {
        try {
          return new Date(value).toISOString() === value;
        } catch {
          return false;
        }
      },
      { message: "must be a canonical ISO timestamp" }
    );
    MissionDomainVersionSchemaZ = z5.literal(1);
    MissionIdSchemaZ = z5.string().regex(MissionIdPattern);
    MissionTaskIdSchemaZ = z5.string().regex(TaskIdPattern);
    MissionAttemptIdSchemaZ = z5.string().regex(AttemptIdPattern);
    MissionProofIdSchemaZ = z5.string().regex(ProofIdPattern);
    MissionReferenceIdSchemaZ = z5.string().regex(ReferenceIdPattern);
    MissionTerminalReferenceSchemaZ = z5.string().refine((value) => ReferenceIdPattern.test(value) || TmuxPaneIdPattern.test(value), {
      message: "must be a mission reference id or canonical tmux pane id"
    });
    MissionActorSchemaZ = z5.strictObject({
      type: z5.enum(["user", "system", "agent", "service"]),
      id: MissionReferenceIdSchemaZ.optional(),
      profile: MissionReferenceIdSchemaZ.optional(),
      displayName: z5.string().min(1).max(200).optional()
    });
    MissionSourceSchemaZ = z5.strictObject({
      type: z5.enum(["user", "system", "import", "service"]),
      id: MissionReferenceIdSchemaZ.optional()
    });
    MissionStatusSchemaZ = z5.enum([
      "created",
      "planned",
      "started",
      "blocked",
      "review",
      "completed",
      "failed",
      "cancelled"
    ]);
    MissionTaskStatusSchemaZ = z5.enum([
      "added",
      "ready",
      "claimed",
      "started",
      "blocked",
      "submitted",
      "completed",
      "failed",
      "cancelled"
    ]);
    MissionAttemptStatusSchemaZ = z5.enum([
      "started",
      "submitted",
      "approved",
      "rejected",
      "failed",
      "interrupted"
    ]);
    MissionAttemptOutcomeSchemaZ = z5.enum([
      "submitted",
      "approved",
      "rejected",
      "failed",
      "interrupted"
    ]);
    MissionProofTestSchemaZ = z5.strictObject({
      name: z5.string().min(1),
      status: z5.enum(["passed", "failed", "skipped"]),
      passed: z5.number().int().nonnegative().optional(),
      total: z5.number().int().nonnegative().optional(),
      url: z5.string().url().optional(),
      notes: z5.string().min(1).optional()
    }).superRefine((test, ctx) => {
      if (test.passed !== void 0 && test.total !== void 0 && test.passed > test.total) {
        ctx.addIssue({
          code: "custom",
          path: ["passed"],
          message: "passed must not exceed total"
        });
      }
    });
    MissionProofSchemaZ = z5.strictObject({
      tests: z5.array(MissionProofTestSchemaZ).optional(),
      commits: z5.array(
        z5.strictObject({
          sha: z5.string().regex(/^[A-Fa-f0-9]{7,64}$/u),
          repo: MissionReferenceIdSchemaZ.optional(),
          url: z5.string().url().optional()
        })
      ).optional(),
      diff: z5.strictObject({
        summary: z5.string().min(1).optional(),
        stats: z5.strictObject({
          filesChanged: z5.number().int().nonnegative().optional(),
          insertions: z5.number().int().nonnegative().optional(),
          deletions: z5.number().int().nonnegative().optional()
        }).optional(),
        url: z5.string().url().optional()
      }).optional(),
      pr: z5.strictObject({
        number: z5.number().int().positive().optional(),
        url: z5.string().url().optional(),
        status: z5.enum(["draft", "open", "merged", "closed"]).optional()
      }).optional(),
      artifacts: z5.array(
        z5.strictObject({
          name: z5.string().min(1),
          uri: z5.string().min(1),
          kind: z5.string().min(1).optional()
        })
      ).optional(),
      notes: z5.string().min(1).optional(),
      noProofReason: z5.string().min(1).optional()
    }).superRefine((proof, ctx) => {
      const hasEvidence = Boolean(
        proof.noProofReason || proof.notes || (proof.tests?.length ?? 0) > 0 || (proof.commits?.length ?? 0) > 0 || proof.diff?.summary || proof.diff?.url || proof.diff?.stats?.filesChanged !== void 0 || proof.diff?.stats?.insertions !== void 0 || proof.diff?.stats?.deletions !== void 0 || proof.pr?.url || proof.pr?.number || proof.pr?.status || (proof.artifacts?.length ?? 0) > 0
      );
      if (!hasEvidence) {
        ctx.addIssue({
          code: "custom",
          message: "proof must include meaningful evidence or an explicit noProofReason"
        });
      }
    });
    MissionEventBaseSchemaZ = z5.strictObject({
      version: MissionDomainVersionSchemaZ,
      actor: MissionActorSchemaZ
    });
    MissionEventSchemas = [
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("mission.created"),
        missionId: MissionIdSchemaZ,
        title: z5.string().min(1),
        objective: z5.string().min(1),
        acceptanceCriteria: z5.array(z5.string().min(1)).default([]),
        constraints: z5.array(z5.string().min(1)).default([]),
        labels: z5.array(z5.string().min(1)).default([]),
        source: MissionSourceSchemaZ
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.enum([
          "mission.planned",
          "mission.started",
          "mission.review",
          "mission.completed",
          "mission.failed",
          "mission.cancelled"
        ]),
        missionId: MissionIdSchemaZ,
        reason: z5.string().min(1).optional(),
        proofId: MissionProofIdSchemaZ.optional()
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("mission.blocked"),
        missionId: MissionIdSchemaZ,
        reason: z5.string().min(1)
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("task.added"),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        title: z5.string().min(1),
        description: z5.string().min(1).optional(),
        priority: z5.number().int().default(0),
        dependencies: z5.array(MissionTaskIdSchemaZ).default([]),
        assignee: MissionReferenceIdSchemaZ.optional()
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("task.updated"),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        title: z5.string().min(1).optional(),
        description: z5.string().min(1).optional(),
        priority: z5.number().int().optional(),
        dependencies: z5.array(MissionTaskIdSchemaZ).optional(),
        assignee: MissionReferenceIdSchemaZ.nullable().optional()
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.enum([
          "task.ready",
          "task.started",
          "task.submitted",
          "task.completed",
          "task.failed",
          "task.cancelled"
        ]),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        reason: z5.string().min(1).optional(),
        proofId: MissionProofIdSchemaZ.optional()
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("task.claimed"),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        assignee: MissionReferenceIdSchemaZ
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("task.blocked"),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        reason: z5.string().min(1)
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("attempt.started"),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        attemptId: MissionAttemptIdSchemaZ,
        agent: MissionReferenceIdSchemaZ,
        harness: MissionReferenceIdSchemaZ,
        model: MissionReferenceIdSchemaZ.optional(),
        terminal: MissionTerminalReferenceSchemaZ.optional(),
        session: MissionReferenceIdSchemaZ.optional(),
        worktree: z5.string().min(1).optional()
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.enum([
          "attempt.submitted",
          "attempt.approved",
          "attempt.rejected",
          "attempt.failed",
          "attempt.interrupted"
        ]),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        attemptId: MissionAttemptIdSchemaZ,
        proofId: MissionProofIdSchemaZ.optional(),
        reason: z5.string().min(1).optional()
      }),
      MissionEventBaseSchemaZ.extend({
        type: z5.literal("proof.recorded"),
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ.optional(),
        attemptId: MissionAttemptIdSchemaZ.optional(),
        proofId: MissionProofIdSchemaZ,
        proof: MissionProofSchemaZ
      })
    ];
    MissionEventSchemaZ = z5.discriminatedUnion("type", MissionEventSchemas);
    MissionTaskSchemaZ = z5.strictObject({
      id: MissionTaskIdSchemaZ,
      missionId: MissionIdSchemaZ,
      title: z5.string().min(1),
      description: z5.string().min(1).optional(),
      priority: z5.number().int(),
      dependencies: z5.array(MissionTaskIdSchemaZ),
      assignee: MissionReferenceIdSchemaZ.optional(),
      status: MissionTaskStatusSchemaZ,
      createdAt: TimestampSchemaZ,
      updatedAt: TimestampSchemaZ,
      startedAt: TimestampSchemaZ.optional(),
      finishedAt: TimestampSchemaZ.optional(),
      proofIds: z5.array(MissionProofIdSchemaZ),
      attemptIds: z5.array(MissionAttemptIdSchemaZ)
    });
    MissionAttemptSchemaZ = z5.strictObject({
      id: MissionAttemptIdSchemaZ,
      missionId: MissionIdSchemaZ,
      taskId: MissionTaskIdSchemaZ,
      agent: MissionReferenceIdSchemaZ,
      harness: MissionReferenceIdSchemaZ,
      model: MissionReferenceIdSchemaZ.optional(),
      terminal: MissionTerminalReferenceSchemaZ.optional(),
      session: MissionReferenceIdSchemaZ.optional(),
      worktree: z5.string().min(1).optional(),
      status: MissionAttemptStatusSchemaZ,
      outcome: MissionAttemptOutcomeSchemaZ.optional(),
      startedAt: TimestampSchemaZ,
      updatedAt: TimestampSchemaZ,
      finishedAt: TimestampSchemaZ.optional(),
      proofIds: z5.array(MissionProofIdSchemaZ)
    });
    MissionSnapshotSchemaZ = z5.strictObject({
      id: MissionIdSchemaZ,
      title: z5.string().min(1),
      objective: z5.string().min(1),
      acceptanceCriteria: z5.array(z5.string().min(1)),
      constraints: z5.array(z5.string().min(1)),
      labels: z5.array(z5.string().min(1)),
      source: MissionSourceSchemaZ,
      status: MissionStatusSchemaZ,
      createdAt: TimestampSchemaZ,
      updatedAt: TimestampSchemaZ,
      startedAt: TimestampSchemaZ.optional(),
      finishedAt: TimestampSchemaZ.optional(),
      tasks: z5.record(MissionTaskIdSchemaZ, MissionTaskSchemaZ),
      attempts: z5.record(MissionAttemptIdSchemaZ, MissionAttemptSchemaZ),
      proofs: z5.record(MissionProofIdSchemaZ, MissionProofSchemaZ)
    }).superRefine((mission, ctx) => {
      for (const [taskKey, task] of Object.entries(mission.tasks)) {
        if (taskKey !== task.id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskKey, "id"],
            message: "task record key must equal task id"
          });
        }
        if (task.missionId !== mission.id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskKey, "missionId"],
            message: "task missionId must equal parent mission id"
          });
        }
        checkUnique(task.dependencies, ["tasks", taskKey, "dependencies"], "dependency ids", ctx);
        checkUnique(task.proofIds, ["tasks", taskKey, "proofIds"], "proof ids", ctx);
        checkUnique(task.attemptIds, ["tasks", taskKey, "attemptIds"], "attempt ids", ctx);
        for (const dependencyId of task.dependencies) {
          if (!mission.tasks[dependencyId]) {
            ctx.addIssue({
              code: "custom",
              path: ["tasks", taskKey, "dependencies"],
              message: `dependency ${dependencyId} must resolve to a task`
            });
          }
        }
        for (const proofId of task.proofIds) {
          if (!mission.proofs[proofId]) {
            ctx.addIssue({
              code: "custom",
              path: ["tasks", taskKey, "proofIds"],
              message: `proof ${proofId} must resolve`
            });
          }
        }
        for (const attemptId of task.attemptIds) {
          const attempt = mission.attempts[attemptId];
          if (!attempt) {
            ctx.addIssue({
              code: "custom",
              path: ["tasks", taskKey, "attemptIds"],
              message: `attempt ${attemptId} must resolve`
            });
          } else if (attempt.taskId !== task.id) {
            ctx.addIssue({
              code: "custom",
              path: ["tasks", taskKey, "attemptIds"],
              message: `attempt ${attemptId} must point back to task ${task.id}`
            });
          }
        }
      }
      for (const [attemptKey, attempt] of Object.entries(mission.attempts)) {
        if (attemptKey !== attempt.id) {
          ctx.addIssue({
            code: "custom",
            path: ["attempts", attemptKey, "id"],
            message: "attempt record key must equal attempt id"
          });
        }
        if (attempt.missionId !== mission.id) {
          ctx.addIssue({
            code: "custom",
            path: ["attempts", attemptKey, "missionId"],
            message: "attempt missionId must equal parent mission id"
          });
        }
        if (!mission.tasks[attempt.taskId]) {
          ctx.addIssue({
            code: "custom",
            path: ["attempts", attemptKey, "taskId"],
            message: "attempt taskId must resolve to a task"
          });
        }
        checkUnique(attempt.proofIds, ["attempts", attemptKey, "proofIds"], "proof ids", ctx);
        for (const proofId of attempt.proofIds) {
          if (!mission.proofs[proofId]) {
            ctx.addIssue({
              code: "custom",
              path: ["attempts", attemptKey, "proofIds"],
              message: `proof ${proofId} must resolve`
            });
          }
        }
      }
    });
    MissionProjectStateSchemaZ = z5.strictObject({
      sequence: z5.number().int().nonnegative(),
      missions: z5.record(MissionIdSchemaZ, MissionSnapshotSchemaZ)
    }).superRefine((state, ctx) => {
      for (const [missionKey, mission] of Object.entries(state.missions)) {
        if (missionKey !== mission.id) {
          ctx.addIssue({
            code: "custom",
            path: ["missions", missionKey, "id"],
            message: "mission record key must equal mission id"
          });
        }
      }
    });
    MissionHistoryEntrySchemaZ = z5.strictObject({
      sequence: z5.number().int().positive(),
      timestamp: TimestampSchemaZ,
      event: MissionEventSchemaZ
    });
    PaneInfoSchemaZ = z5.object({
      id: z5.string(),
      index: z5.number(),
      title: z5.string(),
      currentCommand: z5.string(),
      width: z5.number(),
      height: z5.number(),
      active: z5.boolean(),
      role: z5.enum(["lead", "teammate", "planner", "validator", "researcher", "widget", "shell"]).nullable(),
      name: z5.string().nullable(),
      type: z5.string().nullable()
    });
    SessionOverviewSchemaZ = z5.object({
      name: z5.string(),
      dir: z5.string()
    });
  }
});

// packages/contracts/src/mission-projections.ts
import { z as z6 } from "zod";
var TimestampSchemaZ2, UniqueStringArraySchemaZ, MissionProjectionVersionSchemaZ, MissionBoardColumnSchemaZ, MissionProgressSummarySchemaZ, MissionProofSummarySchemaZ, MissionAttemptSummarySchemaZ, TaskCardViewSchemaZ, MissionCardViewSchemaZ, MissionBoardViewSchemaZ, MissionTimelineEntrySchemaZ, MissionHistorySummarySchemaZ, MissionDetailViewSchemaZ;
var init_mission_projections = __esm({
  "packages/contracts/src/mission-projections.ts"() {
    "use strict";
    init_domain();
    TimestampSchemaZ2 = z6.string().refine(
      (value) => {
        try {
          return new Date(value).toISOString() === value;
        } catch {
          return false;
        }
      },
      { message: "must be a canonical ISO timestamp" }
    );
    UniqueStringArraySchemaZ = (item) => z6.array(item).superRefine((values2, ctx) => {
      const seen = /* @__PURE__ */ new Set();
      for (const [index, value] of values2.entries()) {
        if (seen.has(value)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: "duplicate references are not allowed"
          });
        }
        seen.add(value);
      }
    });
    MissionProjectionVersionSchemaZ = z6.literal(1);
    MissionBoardColumnSchemaZ = z6.enum([
      "planned",
      "running",
      "blocked",
      "review",
      "done"
    ]);
    MissionProgressSummarySchemaZ = z6.strictObject({
      total: z6.number().int().nonnegative(),
      planned: z6.number().int().nonnegative(),
      running: z6.number().int().nonnegative(),
      blocked: z6.number().int().nonnegative(),
      review: z6.number().int().nonnegative(),
      completed: z6.number().int().nonnegative(),
      failed: z6.number().int().nonnegative(),
      cancelled: z6.number().int().nonnegative(),
      done: z6.number().int().nonnegative()
    });
    MissionProofSummarySchemaZ = z6.strictObject({
      proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ),
      hasProof: z6.boolean(),
      noProofReasons: z6.array(z6.string().min(1)),
      notesCount: z6.number().int().nonnegative(),
      tests: z6.strictObject({
        suites: z6.number().int().nonnegative(),
        passed: z6.number().int().nonnegative(),
        failed: z6.number().int().nonnegative(),
        skipped: z6.number().int().nonnegative(),
        total: z6.number().int().nonnegative()
      }),
      commits: UniqueStringArraySchemaZ(z6.string().min(1)),
      diff: z6.strictObject({
        summaries: UniqueStringArraySchemaZ(z6.string().min(1)),
        urls: UniqueStringArraySchemaZ(z6.string().url()),
        filesChanged: z6.number().int().nonnegative(),
        insertions: z6.number().int().nonnegative(),
        deletions: z6.number().int().nonnegative()
      }),
      prs: z6.array(
        z6.strictObject({
          number: z6.number().int().positive().optional(),
          url: z6.string().url().optional(),
          status: z6.enum(["draft", "open", "merged", "closed"]).optional()
        })
      ),
      artifacts: z6.array(
        z6.strictObject({
          name: z6.string().min(1),
          uri: z6.string().min(1),
          kind: z6.string().min(1).optional()
        })
      )
    });
    MissionAttemptSummarySchemaZ = z6.strictObject({
      id: MissionAttemptIdSchemaZ,
      taskId: MissionTaskIdSchemaZ,
      status: MissionAttemptStatusSchemaZ,
      outcome: z6.enum(["submitted", "approved", "rejected", "failed", "interrupted"]).optional(),
      agent: MissionReferenceIdSchemaZ,
      harness: MissionReferenceIdSchemaZ,
      model: MissionReferenceIdSchemaZ.optional(),
      terminal: MissionTerminalReferenceSchemaZ.optional(),
      session: MissionReferenceIdSchemaZ.optional(),
      worktree: z6.string().min(1).optional(),
      startedAt: TimestampSchemaZ2,
      updatedAt: TimestampSchemaZ2,
      finishedAt: TimestampSchemaZ2.optional(),
      durationMs: z6.number().int().nonnegative().nullable(),
      proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ)
    });
    TaskCardViewSchemaZ = z6.strictObject({
      version: MissionProjectionVersionSchemaZ,
      id: MissionTaskIdSchemaZ,
      missionId: MissionIdSchemaZ,
      title: z6.string().min(1),
      summary: z6.string().min(1),
      status: MissionTaskStatusSchemaZ,
      column: MissionBoardColumnSchemaZ,
      priority: z6.number().int(),
      assignee: MissionReferenceIdSchemaZ.optional(),
      dependencies: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
      blockedBy: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
      createdAt: TimestampSchemaZ2,
      updatedAt: TimestampSchemaZ2,
      startedAt: TimestampSchemaZ2.optional(),
      finishedAt: TimestampSchemaZ2.optional(),
      durationMs: z6.number().int().nonnegative().nullable(),
      latestAttempt: MissionAttemptSummarySchemaZ.nullable(),
      proofSummary: MissionProofSummarySchemaZ,
      refs: z6.strictObject({
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ,
        attemptIds: UniqueStringArraySchemaZ(MissionAttemptIdSchemaZ),
        proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ),
        terminal: MissionTerminalReferenceSchemaZ.optional(),
        session: MissionReferenceIdSchemaZ.optional(),
        worktree: z6.string().min(1).optional()
      })
    });
    MissionCardViewSchemaZ = z6.strictObject({
      version: MissionProjectionVersionSchemaZ,
      id: MissionIdSchemaZ,
      title: z6.string().min(1),
      summary: z6.string().min(1),
      status: MissionStatusSchemaZ,
      column: MissionBoardColumnSchemaZ,
      labels: z6.array(z6.string().min(1)),
      createdAt: TimestampSchemaZ2,
      updatedAt: TimestampSchemaZ2,
      startedAt: TimestampSchemaZ2.optional(),
      finishedAt: TimestampSchemaZ2.optional(),
      durationMs: z6.number().int().nonnegative().nullable(),
      progress: MissionProgressSummarySchemaZ,
      blockedBy: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
      latestAttempt: MissionAttemptSummarySchemaZ.nullable(),
      proofSummary: MissionProofSummarySchemaZ,
      refs: z6.strictObject({
        missionId: MissionIdSchemaZ,
        taskIds: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
        attemptIds: UniqueStringArraySchemaZ(MissionAttemptIdSchemaZ),
        proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ)
      })
    });
    MissionBoardViewSchemaZ = z6.strictObject({
      version: MissionProjectionVersionSchemaZ,
      columns: z6.strictObject({
        planned: z6.array(MissionCardViewSchemaZ),
        running: z6.array(MissionCardViewSchemaZ),
        blocked: z6.array(MissionCardViewSchemaZ),
        review: z6.array(MissionCardViewSchemaZ),
        done: z6.array(MissionCardViewSchemaZ)
      }),
      counts: z6.strictObject({
        planned: z6.number().int().nonnegative(),
        running: z6.number().int().nonnegative(),
        blocked: z6.number().int().nonnegative(),
        review: z6.number().int().nonnegative(),
        done: z6.number().int().nonnegative(),
        total: z6.number().int().nonnegative()
      })
    });
    MissionTimelineEntrySchemaZ = z6.strictObject({
      version: MissionProjectionVersionSchemaZ,
      sequence: z6.number().int().positive(),
      timestamp: TimestampSchemaZ2,
      missionId: MissionIdSchemaZ,
      taskId: MissionTaskIdSchemaZ.optional(),
      attemptId: MissionAttemptIdSchemaZ.optional(),
      proofId: MissionProofIdSchemaZ.optional(),
      type: z6.string().min(1),
      label: z6.string().min(1),
      actor: MissionActorSchemaZ,
      reason: z6.string().min(1).optional(),
      refs: z6.strictObject({
        missionId: MissionIdSchemaZ,
        taskId: MissionTaskIdSchemaZ.optional(),
        attemptId: MissionAttemptIdSchemaZ.optional(),
        proofId: MissionProofIdSchemaZ.optional(),
        terminal: MissionTerminalReferenceSchemaZ.optional(),
        session: MissionReferenceIdSchemaZ.optional(),
        worktree: z6.string().min(1).optional()
      })
    });
    MissionHistorySummarySchemaZ = z6.strictObject({
      version: MissionProjectionVersionSchemaZ,
      mission: MissionCardViewSchemaZ,
      outcome: z6.enum(["completed", "failed", "cancelled"]),
      startedAt: TimestampSchemaZ2.optional(),
      finishedAt: TimestampSchemaZ2,
      durationMs: z6.number().int().nonnegative().nullable(),
      taskTotals: MissionProgressSummarySchemaZ,
      attemptTotals: z6.strictObject({
        total: z6.number().int().nonnegative(),
        submitted: z6.number().int().nonnegative(),
        approved: z6.number().int().nonnegative(),
        rejected: z6.number().int().nonnegative(),
        failed: z6.number().int().nonnegative(),
        interrupted: z6.number().int().nonnegative(),
        running: z6.number().int().nonnegative()
      }),
      proofSummary: MissionProofSummarySchemaZ,
      lastEvent: MissionTimelineEntrySchemaZ.nullable()
    });
    MissionDetailViewSchemaZ = z6.strictObject({
      version: MissionProjectionVersionSchemaZ,
      mission: MissionCardViewSchemaZ,
      taskBoard: z6.strictObject({
        columns: z6.strictObject({
          planned: z6.array(TaskCardViewSchemaZ),
          running: z6.array(TaskCardViewSchemaZ),
          blocked: z6.array(TaskCardViewSchemaZ),
          review: z6.array(TaskCardViewSchemaZ),
          done: z6.array(TaskCardViewSchemaZ)
        }),
        counts: z6.strictObject({
          planned: z6.number().int().nonnegative(),
          running: z6.number().int().nonnegative(),
          blocked: z6.number().int().nonnegative(),
          review: z6.number().int().nonnegative(),
          done: z6.number().int().nonnegative(),
          total: z6.number().int().nonnegative()
        })
      }),
      attempts: z6.array(MissionAttemptSummarySchemaZ),
      proofSummary: MissionProofSummarySchemaZ,
      progress: MissionProgressSummarySchemaZ,
      timeline: z6.array(MissionTimelineEntrySchemaZ)
    });
  }
});

// packages/contracts/src/tmux.ts
import { z as z7 } from "zod";
var TmuxPaneSchemaZ, TmuxWindowSchemaZ, TmuxSessionSchemaZ, TmuxPaneTargetSchemaZ;
var init_tmux = __esm({
  "packages/contracts/src/tmux.ts"() {
    "use strict";
    TmuxPaneSchemaZ = z7.object({
      /** Stable tmux pane id (e.g. `%23`). */
      id: z7.string(),
      /** Pane index within its window (zero-based). */
      paneIndex: z7.number().int().nonnegative(),
      /** Window index within the session (zero-based). */
      windowIndex: z7.number().int().nonnegative(),
      title: z7.string().nullable(),
      command: z7.string().nullable(),
      active: z7.boolean()
    });
    TmuxWindowSchemaZ = z7.object({
      index: z7.number().int().nonnegative(),
      name: z7.string(),
      panes: z7.array(TmuxPaneSchemaZ)
    });
    TmuxSessionSchemaZ = z7.object({
      name: z7.string(),
      windows: z7.array(TmuxWindowSchemaZ),
      /** Session creation time (epoch milliseconds). */
      created: z7.number().int().nonnegative(),
      attached: z7.boolean(),
      /** Project directory the session was launched from, when known. */
      projectDir: z7.string().nullable()
    });
    TmuxPaneTargetSchemaZ = z7.discriminatedUnion("kind", [
      z7.object({ kind: z7.literal("byId"), id: z7.string() }),
      z7.object({ kind: z7.literal("byIndex"), index: z7.number().int().nonnegative() }),
      z7.object({ kind: z7.literal("byTitle"), title: z7.string() }),
      z7.object({ kind: z7.literal("byRole"), role: z7.string() })
    ]);
  }
});

// packages/contracts/src/workspace.ts
import { z as z8 } from "zod";
var WorkspaceSchemaZ, WorkspaceListResponseSchemaZ, AddWorkspaceRequestSchemaZ, AddWorkspaceResponseSchemaZ, WorkspaceAddedFrameSchemaZ, WorkspaceRemovedFrameSchemaZ;
var init_workspace = __esm({
  "packages/contracts/src/workspace.ts"() {
    "use strict";
    WorkspaceSchemaZ = z8.object({
      /** Stable workspace name (typically equal to tmux session name). */
      name: z8.string().min(1),
      /** Tmux session this workspace maps to. */
      sessionName: z8.string().min(1),
      /** Absolute project directory. */
      projectDir: z8.string().min(1),
      /** Absolute path to the legacy ide.yml driving this workspace, when present. */
      ideConfigPath: z8.string().nullable(),
      /** Winning config kind, appended without replacing ideConfigPath. */
      configKind: z8.enum(["workspace", "legacy", "none"]).optional(),
      /** Absolute path to the winning config, if any. */
      configPath: z8.string().nullable().optional(),
      /** Whether the workspace has `.tmux-ide/workspace.yml`. */
      hasWorkspaceConfig: z8.boolean().optional(),
      /** ISO timestamp of when the workspace was added. */
      addedAt: z8.string()
    });
    WorkspaceListResponseSchemaZ = z8.object({
      workspaces: z8.array(WorkspaceSchemaZ)
    });
    AddWorkspaceRequestSchemaZ = z8.object({
      /** Absolute path to the project directory. */
      projectDir: z8.string().min(1),
      /** Optional explicit workspace name. Auto-derived from basename when absent. */
      name: z8.string().min(1).optional(),
      /** Optional override for the tmux session name (defaults to `name`). */
      sessionName: z8.string().min(1).optional(),
      /** Optional ide.yml path the workspace was launched with. Preserved for wire compatibility. */
      ideConfigPath: z8.string().min(1).optional(),
      /** Optional generalized config kind. */
      configKind: z8.enum(["workspace", "legacy", "none"]).optional(),
      /** Optional generalized config path. */
      configPath: z8.string().min(1).optional(),
      /** Optional workspace config presence fact. */
      hasWorkspaceConfig: z8.boolean().optional()
    });
    AddWorkspaceResponseSchemaZ = z8.object({
      workspace: WorkspaceSchemaZ
    });
    WorkspaceAddedFrameSchemaZ = z8.object({
      type: z8.literal("workspace.added"),
      workspace: WorkspaceSchemaZ
    });
    WorkspaceRemovedFrameSchemaZ = z8.object({
      type: z8.literal("workspace.removed"),
      name: z8.string()
    });
  }
});

// packages/contracts/src/app-window-state.ts
import { z as z9 } from "zod";
function dockTreeLimitFailure(value) {
  const stack = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > APP_WINDOW_MAX_TREE_NODES) return "dock tree node limit exceeded";
    if (current.depth > APP_WINDOW_MAX_TREE_DEPTH) return "dock tree depth limit exceeded";
    if (current.value && typeof current.value === "object" && !Array.isArray(current.value) && "type" in current.value && current.value.type === "split" && "children" in current.value && Array.isArray(current.value.children)) {
      if (current.value.children.length > 8) return "dock split child limit exceeded";
      for (const child of current.value.children) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return null;
}
function refineScene(scene, ctx) {
  const windowEntries = Object.entries(scene.windows);
  if (windowEntries.length > APP_WINDOW_MAX_WINDOWS) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "app window limit exceeded",
      path: ["windows"]
    });
  }
  for (const [key, window] of windowEntries) {
    if (key !== window.id) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "window record key must match window id",
        path: ["windows", key, "id"]
      });
    }
  }
  const dockMembership = /* @__PURE__ */ new Map();
  const nodeIds = /* @__PURE__ */ new Set();
  const visit = (node) => {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "dock node ids must be unique",
        path: ["dockRoot"]
      });
    }
    nodeIds.add(node.id);
    if (node.type === "split") {
      for (const child of node.children) visit(child);
      return;
    }
    for (const [index, windowId] of node.windowIds.entries()) {
      if (dockMembership.has(windowId)) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "docked window must occur in exactly one stack",
          path: ["dockRoot"]
        });
      }
      dockMembership.set(windowId, {
        stackId: node.id,
        index,
        activeWindowId: node.activeWindowId
      });
    }
  };
  if (scene.dockRoot) visit(scene.dockRoot);
  const floatingSet = new Set(scene.floatingOrder);
  if (floatingSet.size !== scene.floatingOrder.length) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "floating z-order ids must be unique",
      path: ["floatingOrder"]
    });
  }
  for (const [windowId, window] of windowEntries) {
    const dockedAt = dockMembership.get(windowId);
    const isFloating = floatingSet.has(windowId);
    if (window.placement.mode === "docked") {
      if (!dockedAt || isFloating) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "docked window must occur only in the dock tree",
          path: ["windows", windowId, "placement"]
        });
      } else if (window.placement.docked?.stackId !== dockedAt.stackId || window.placement.docked.index !== dockedAt.index) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "dock placement memory must match current stack membership",
          path: ["windows", windowId, "placement", "docked"]
        });
      }
    } else if (dockedAt || !isFloating) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "floating window must occur only in floating z-order",
        path: ["windows", windowId, "placement"]
      });
    }
  }
  for (const windowId of dockMembership.keys()) {
    if (!Object.hasOwn(scene.windows, windowId)) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "dock tree references an unknown window",
        path: ["dockRoot"]
      });
    }
  }
  for (const windowId of floatingSet) {
    if (!Object.hasOwn(scene.windows, windowId)) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "floating z-order references an unknown window",
        path: ["floatingOrder"]
      });
    }
  }
  if (scene.focusedWindowId && !Object.hasOwn(scene.windows, scene.focusedWindowId)) {
    ctx.addIssue({
      code: z9.ZodIssueCode.custom,
      message: "focused window must exist",
      path: ["focusedWindowId"]
    });
  } else if (scene.focusedWindowId) {
    const focused = scene.windows[scene.focusedWindowId];
    if (focused.placement.mode === "floating" && scene.floatingOrder.at(-1) !== scene.focusedWindowId) {
      ctx.addIssue({
        code: z9.ZodIssueCode.custom,
        message: "focused floating window must be top-most",
        path: ["focusedWindowId"]
      });
    }
    if (focused.placement.mode === "docked") {
      const membership = dockMembership.get(scene.focusedWindowId);
      if (membership && membership.activeWindowId !== scene.focusedWindowId) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "focused docked window must be the active window in its stack",
          path: ["focusedWindowId"]
        });
      }
    }
  }
}
var APP_WINDOW_DOCUMENT_VERSION, APP_WINDOW_MAX_WINDOWS, APP_WINDOW_MAX_LAYOUTS, APP_WINDOW_MAX_TREE_DEPTH, APP_WINDOW_MAX_TREE_NODES, APP_WINDOW_MAX_ID_LENGTH, APP_WINDOW_MAX_TITLE_LENGTH, RESERVED_RECORD_KEYS2, finiteCoordinate, finiteExtent, VisibleTextSchemaZ, AppWindowIdSchemaZ, AppWindowTimestampSchemaZ, AppWindowNativeSurfaceSchemaZ, AppWindowSourceSchemaZ, AppWindowRectSchemaZ, AppWindowDockMemorySchemaZ, AppWindowPlacementSchemaZ, AppWindowDockStateSchemaZ, AppWindowInstanceSchemaZ, AppWindowDockNodeRecursiveSchemaZ, AppWindowDockNodeSchemaZ, AppWindowSceneShapeSchemaZ, AppWindowSceneSchemaZ, AppWindowNamedLayoutSchemaZ, AppWindowDocumentV1SchemaZ;
var init_app_window_state = __esm({
  "packages/contracts/src/app-window-state.ts"() {
    "use strict";
    APP_WINDOW_DOCUMENT_VERSION = 1;
    APP_WINDOW_MAX_WINDOWS = 128;
    APP_WINDOW_MAX_LAYOUTS = 32;
    APP_WINDOW_MAX_TREE_DEPTH = 24;
    APP_WINDOW_MAX_TREE_NODES = 255;
    APP_WINDOW_MAX_ID_LENGTH = 128;
    APP_WINDOW_MAX_TITLE_LENGTH = 160;
    RESERVED_RECORD_KEYS2 = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
    finiteCoordinate = z9.number().finite().min(-1e6).max(1e6);
    finiteExtent = z9.number().finite().positive().max(1e6);
    VisibleTextSchemaZ = (max) => z9.string().max(max).refine((value) => !value.includes("\0"), "text must not contain NUL bytes").refine((value) => value.trim().length > 0, "text must contain visible characters");
    AppWindowIdSchemaZ = z9.string().min(1).max(APP_WINDOW_MAX_ID_LENGTH).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u).refine((value) => !RESERVED_RECORD_KEYS2.has(value), "reserved record key is not allowed");
    AppWindowTimestampSchemaZ = z9.string().datetime({ offset: false });
    AppWindowNativeSurfaceSchemaZ = z9.enum([
      "home",
      "files",
      "changes",
      "missions",
      "activity"
    ]);
    AppWindowSourceSchemaZ = z9.discriminatedUnion("kind", [
      z9.object({
        kind: z9.literal("native"),
        surface: AppWindowNativeSurfaceSchemaZ,
        /** Stable resource identity for multiple instances of one native surface. */
        resourceId: AppWindowIdSchemaZ.nullable()
      }).strict(),
      z9.object({
        kind: z9.literal("terminal"),
        /** Durable semantic source id. A live tmux `%pane_id` is intentionally invalid. */
        terminalSourceId: AppWindowIdSchemaZ
      }).strict()
    ]);
    AppWindowRectSchemaZ = z9.object({
      x: finiteCoordinate,
      y: finiteCoordinate,
      width: finiteExtent,
      height: finiteExtent
    }).strict();
    AppWindowDockMemorySchemaZ = z9.object({
      stackId: AppWindowIdSchemaZ,
      index: z9.number().int().nonnegative().max(APP_WINDOW_MAX_WINDOWS - 1)
    }).strict();
    AppWindowPlacementSchemaZ = z9.object({
      mode: z9.enum(["docked", "floating"]),
      /** Current dock location when docked; last dock location when floating. */
      docked: AppWindowDockMemorySchemaZ.nullable(),
      /** Current rect when floating; last floating rect when docked. */
      floating: AppWindowRectSchemaZ.nullable()
    }).strict().superRefine((placement, ctx) => {
      if (placement.mode === "docked" && placement.docked === null) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "docked windows require dock placement memory",
          path: ["docked"]
        });
      }
      if (placement.mode === "floating" && placement.floating === null) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "floating windows require a floating rect",
          path: ["floating"]
        });
      }
    });
    AppWindowDockStateSchemaZ = z9.object({
      mode: z9.enum(["collapsed", "open", "maximized"]),
      preferredHeight: z9.number().int().nonnegative().max(1e6).nullable(),
      focusZone: z9.enum(["canvas", "dock-tabs", "dock-body"])
    }).strict();
    AppWindowInstanceSchemaZ = z9.object({
      id: AppWindowIdSchemaZ,
      source: AppWindowSourceSchemaZ,
      title: VisibleTextSchemaZ(APP_WINDOW_MAX_TITLE_LENGTH).nullable(),
      placement: AppWindowPlacementSchemaZ
    }).strict();
    AppWindowDockNodeRecursiveSchemaZ = z9.lazy(
      () => z9.discriminatedUnion("type", [
        z9.object({
          type: z9.literal("stack"),
          id: AppWindowIdSchemaZ,
          windowIds: z9.array(AppWindowIdSchemaZ).min(1).max(APP_WINDOW_MAX_WINDOWS),
          activeWindowId: AppWindowIdSchemaZ
        }).strict().superRefine((stack, ctx) => {
          if (new Set(stack.windowIds).size !== stack.windowIds.length) {
            ctx.addIssue({
              code: z9.ZodIssueCode.custom,
              message: "stack window ids must be unique",
              path: ["windowIds"]
            });
          }
          if (!stack.windowIds.includes(stack.activeWindowId)) {
            ctx.addIssue({
              code: z9.ZodIssueCode.custom,
              message: "active window must belong to the stack",
              path: ["activeWindowId"]
            });
          }
        }),
        z9.object({
          type: z9.literal("split"),
          id: AppWindowIdSchemaZ,
          axis: z9.enum(["horizontal", "vertical"]),
          children: z9.array(AppWindowDockNodeRecursiveSchemaZ).min(2).max(8),
          weights: z9.array(z9.number().int().positive().max(1e6)).min(2).max(8)
        }).strict().refine((node) => node.children.length === node.weights.length, {
          message: "split weights must match children",
          path: ["weights"]
        })
      ])
    );
    AppWindowDockNodeSchemaZ = z9.unknown().superRefine((value, ctx) => {
      const failure = dockTreeLimitFailure(value);
      if (failure) ctx.addIssue({ code: z9.ZodIssueCode.custom, message: failure });
    }).pipe(AppWindowDockNodeRecursiveSchemaZ);
    AppWindowSceneShapeSchemaZ = z9.object({
      windows: z9.record(AppWindowIdSchemaZ, AppWindowInstanceSchemaZ),
      dockRoot: AppWindowDockNodeSchemaZ.nullable(),
      dockState: AppWindowDockStateSchemaZ,
      /** Back-to-front order. The last id is the top-most floating window. */
      floatingOrder: z9.array(AppWindowIdSchemaZ).max(APP_WINDOW_MAX_WINDOWS),
      focusedWindowId: AppWindowIdSchemaZ.nullable()
    }).strict();
    AppWindowSceneSchemaZ = AppWindowSceneShapeSchemaZ.superRefine(refineScene);
    AppWindowNamedLayoutSchemaZ = z9.object({
      id: AppWindowIdSchemaZ,
      name: VisibleTextSchemaZ(80),
      description: VisibleTextSchemaZ(512).nullable(),
      revision: z9.number().int().positive(),
      createdAt: AppWindowTimestampSchemaZ,
      updatedAt: AppWindowTimestampSchemaZ,
      scene: AppWindowSceneSchemaZ
    }).strict().refine((layout) => Date.parse(layout.updatedAt) >= Date.parse(layout.createdAt), {
      message: "layout updatedAt must not precede createdAt",
      path: ["updatedAt"]
    });
    AppWindowDocumentV1SchemaZ = AppWindowSceneShapeSchemaZ.extend({
      version: z9.literal(APP_WINDOW_DOCUMENT_VERSION),
      revision: z9.number().int().nonnegative(),
      updatedAt: AppWindowTimestampSchemaZ,
      activeLayoutId: AppWindowIdSchemaZ.nullable(),
      layouts: z9.record(AppWindowIdSchemaZ, AppWindowNamedLayoutSchemaZ)
    }).strict().superRefine((document, ctx) => {
      refineScene(document, ctx);
      if (Object.keys(document.layouts).length > APP_WINDOW_MAX_LAYOUTS) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "named layout limit exceeded",
          path: ["layouts"]
        });
      }
      for (const [key, layout] of Object.entries(document.layouts)) {
        if (key !== layout.id) {
          ctx.addIssue({
            code: z9.ZodIssueCode.custom,
            message: "layout record key must match layout id",
            path: ["layouts", key, "id"]
          });
        }
      }
      if (document.activeLayoutId && !Object.hasOwn(document.layouts, document.activeLayoutId)) {
        ctx.addIssue({
          code: z9.ZodIssueCode.custom,
          message: "active layout must exist",
          path: ["activeLayoutId"]
        });
      }
      for (const [key, layout] of Object.entries(document.layouts)) {
        if (Date.parse(layout.updatedAt) > Date.parse(document.updatedAt)) {
          ctx.addIssue({
            code: z9.ZodIssueCode.custom,
            message: "layout updatedAt must not exceed document updatedAt",
            path: ["layouts", key, "updatedAt"]
          });
        }
      }
    });
  }
});

// packages/contracts/src/workspace-config.ts
import { z as z10 } from "zod";
function validateWorkspaceLayoutTree(root, path2, context) {
  const seen = /* @__PURE__ */ new Map();
  let count = 0;
  const walk = (node, nodePath, depth) => {
    count += 1;
    if (count > 64) {
      context.addIssue({
        code: "custom",
        path: path2,
        message: "Composite view layout must not exceed 64 nodes"
      });
      return;
    }
    if (depth > 8) {
      context.addIssue({
        code: "custom",
        path: nodePath,
        message: "Composite view layout must not be deeper than 8 nodes"
      });
    }
    const existing = seen.get(node.id);
    if (existing) {
      context.addIssue({
        code: "custom",
        path: [...nodePath, "id"],
        message: `Duplicate layout node id "${node.id}"`
      });
    } else {
      seen.set(node.id, [...nodePath, "id"]);
    }
    if (node.type === "split") {
      if (node.weights !== void 0 && node.weights.length !== node.children.length) {
        context.addIssue({
          code: "custom",
          path: [...nodePath, "weights"],
          message: "Split weights length must match children length"
        });
      }
      node.children.forEach(
        (child, childIndex) => walk(child, [...nodePath, "children", childIndex], depth + 1)
      );
    } else if (node.type === "tabs") {
      if (node.active && !node.children.some((child) => child.id === node.active)) {
        context.addIssue({
          code: "custom",
          path: [...nodePath, "active"],
          message: `Unknown active tab child "${node.active}"`
        });
      }
      node.children.forEach(
        (child, childIndex) => walk(child, [...nodePath, "children", childIndex], depth + 1)
      );
    }
  };
  walk(root, path2, 1);
}
var NonEmptyStringSchema, ProfileNameSchema, WorkspaceCommandSchemaZ, WorkspaceTerminalPaneSchemaZ, WorkspaceTerminalRowSchemaZ, WorkspaceTerminalConfigSchemaZ, WorkspacePanelKindSchemaZ, WorkspaceLayoutIdSchemaZ, WorkspaceAppLayoutNodeSchemaZ, WorkspaceFullPanelViewSchemaZ, WorkspaceCompositeViewSchemaZ, WorkspaceAppViewSchemaZ, WorkspaceAppConfigSchemaZ, WorkspaceHarnessProfileSchemaZ, WorkspaceAgentRoleSchemaZ, WorkspaceAgentProfileSchemaZ, WorkspaceMissionDefaultsSchemaZ, WorkspaceConfigV1ObjectSchemaZ, WorkspaceConfigV1SchemaZ;
var init_workspace_config = __esm({
  "packages/contracts/src/workspace-config.ts"() {
    "use strict";
    init_ide_config();
    NonEmptyStringSchema = z10.string().min(1);
    ProfileNameSchema = z10.string().min(1);
    WorkspaceCommandSchemaZ = z10.union([
      NonEmptyStringSchema,
      z10.array(NonEmptyStringSchema).min(1)
    ]);
    WorkspaceTerminalPaneSchemaZ = PaneSchema.pick({
      id: true,
      title: true,
      command: true,
      type: true,
      target: true,
      dir: true,
      size: true,
      focus: true,
      env: true
    }).strict();
    WorkspaceTerminalRowSchemaZ = z10.strictObject({
      size: RowSchema.shape.size,
      panes: z10.array(WorkspaceTerminalPaneSchemaZ).min(1)
    });
    WorkspaceTerminalConfigSchemaZ = z10.strictObject({
      rows: z10.array(WorkspaceTerminalRowSchemaZ).min(1),
      theme: ThemeConfigSchema.strict().optional()
    });
    WorkspacePanelKindSchemaZ = z10.enum(["home", "terminals", "files", "diff", "missions"]);
    WorkspaceLayoutIdSchemaZ = NonEmptyStringSchema.max(128);
    WorkspaceAppLayoutNodeSchemaZ = z10.lazy(
      () => z10.discriminatedUnion("type", [
        z10.strictObject({
          type: z10.literal("panel"),
          id: WorkspaceLayoutIdSchemaZ,
          panel: WorkspacePanelKindSchemaZ,
          min_size: z10.number().int().positive().optional()
        }),
        z10.strictObject({
          type: z10.literal("split"),
          id: WorkspaceLayoutIdSchemaZ,
          direction: z10.enum(["horizontal", "vertical"]),
          children: z10.array(WorkspaceAppLayoutNodeSchemaZ).min(2).max(4),
          weights: z10.array(z10.number().positive()).optional()
        }),
        z10.strictObject({
          type: z10.literal("tabs"),
          id: WorkspaceLayoutIdSchemaZ,
          children: z10.array(WorkspaceAppLayoutNodeSchemaZ).min(1).max(8),
          active: WorkspaceLayoutIdSchemaZ.optional()
        })
      ])
    );
    WorkspaceFullPanelViewSchemaZ = z10.strictObject({
      id: NonEmptyStringSchema,
      title: NonEmptyStringSchema.optional(),
      panel: WorkspacePanelKindSchemaZ
    });
    WorkspaceCompositeViewSchemaZ = z10.strictObject({
      id: NonEmptyStringSchema,
      title: NonEmptyStringSchema.optional(),
      layout: WorkspaceAppLayoutNodeSchemaZ
    });
    WorkspaceAppViewSchemaZ = z10.union([
      WorkspaceFullPanelViewSchemaZ,
      WorkspaceCompositeViewSchemaZ
    ]);
    WorkspaceAppConfigSchemaZ = z10.strictObject({
      views: z10.array(WorkspaceAppViewSchemaZ).min(1)
    });
    WorkspaceHarnessProfileSchemaZ = z10.strictObject({
      adapter: NonEmptyStringSchema,
      command: WorkspaceCommandSchemaZ,
      env: z10.record(NonEmptyStringSchema, z10.string()).optional()
    });
    WorkspaceAgentRoleSchemaZ = z10.enum([
      "manager",
      "implementer",
      "reviewer",
      "researcher",
      "validator"
    ]);
    WorkspaceAgentProfileSchemaZ = z10.strictObject({
      harness: ProfileNameSchema,
      model: NonEmptyStringSchema.optional(),
      role: WorkspaceAgentRoleSchemaZ
    });
    WorkspaceMissionDefaultsSchemaZ = z10.strictObject({
      manager: ProfileNameSchema.optional(),
      workers: z10.array(ProfileNameSchema).optional(),
      reviewer: ProfileNameSchema.optional(),
      isolation: z10.enum(["shared", "worktree"]).optional(),
      max_concurrent_tasks: z10.number().int().positive().optional()
    });
    WorkspaceConfigV1ObjectSchemaZ = z10.strictObject({
      version: z10.literal(1),
      name: NonEmptyStringSchema.optional(),
      before: z10.string().optional(),
      terminal: WorkspaceTerminalConfigSchemaZ.optional(),
      app: WorkspaceAppConfigSchemaZ.optional(),
      harnesses: z10.record(ProfileNameSchema, WorkspaceHarnessProfileSchemaZ).optional(),
      agents: z10.record(ProfileNameSchema, WorkspaceAgentProfileSchemaZ).optional(),
      missions: WorkspaceMissionDefaultsSchemaZ.optional()
    });
    WorkspaceConfigV1SchemaZ = WorkspaceConfigV1ObjectSchemaZ.superRefine(
      (config2, context) => {
        const explicitPaneIds = /* @__PURE__ */ new Set();
        for (const [rowIndex, row] of (config2.terminal?.rows ?? []).entries()) {
          for (const [paneIndex, pane] of row.panes.entries()) {
            if (!pane.id) continue;
            if (explicitPaneIds.has(pane.id)) {
              context.addIssue({
                code: "custom",
                path: ["terminal", "rows", rowIndex, "panes", paneIndex, "id"],
                message: `Duplicate pane id "${pane.id}"`
              });
            }
            explicitPaneIds.add(pane.id);
          }
        }
        const harnessNames = new Set(Object.keys(config2.harnesses ?? {}));
        for (const [agentName, agent] of Object.entries(config2.agents ?? {})) {
          if (!harnessNames.has(agent.harness)) {
            context.addIssue({
              code: "custom",
              path: ["agents", agentName, "harness"],
              message: `Unknown harness profile "${agent.harness}"`
            });
          }
        }
        const agentNames = new Set(Object.keys(config2.agents ?? {}));
        const checkAgentReference = (name, path2) => {
          if (name !== void 0 && !agentNames.has(name)) {
            context.addIssue({
              code: "custom",
              path: path2,
              message: `Unknown agent profile "${name}"`
            });
          }
        };
        checkAgentReference(config2.missions?.manager, ["missions", "manager"]);
        checkAgentReference(config2.missions?.reviewer, ["missions", "reviewer"]);
        for (const [index, worker] of (config2.missions?.workers ?? []).entries()) {
          checkAgentReference(worker, ["missions", "workers", index]);
        }
        const viewIds = /* @__PURE__ */ new Set();
        for (const [index, view] of (config2.app?.views ?? []).entries()) {
          if (viewIds.has(view.id)) {
            context.addIssue({
              code: "custom",
              path: ["app", "views", index, "id"],
              message: `Duplicate view id "${view.id}"`
            });
          }
          viewIds.add(view.id);
          if ("layout" in view) {
            validateWorkspaceLayoutTree(view.layout, ["app", "views", index, "layout"], context);
          }
        }
      }
    );
  }
});

// packages/contracts/src/actions-contract.ts
import { z as z11 } from "zod";
function isActionName(name) {
  return name in ActionContractsZ;
}
var ProjectOpenTerminalInputZ, ProjectOpenTerminalResultZ, ProjectLaunchInputZ, ProjectLaunchResultZ, ProjectStopInputZ, ProjectStopResultZ, ProjectRestartInputZ, ProjectRestartResultZ, ProjectActivateInputZ, ProjectActivateResultZ, TerminalRespawnInputZ, TerminalRespawnResultZ, TerminalStopInputZ, TerminalStopResultZ, ConfigSetInputZ, ConfigResultZ, ConfigAddPaneInputZ, ConfigAddPaneResultZ, ConfigRemovePaneInputZ, ConfigRemovePaneResultZ, ConfigAddRowInputZ, ConfigAddRowResultZ, ConfigEnableTeamInputZ, ConfigEnableTeamResultZ, ConfigDisableTeamInputZ, ConfigDisableTeamResultZ, AppSetRemoteAccessInputZ, AppSetRemoteAccessResultZ, DaemonShutdownInputZ, DaemonShutdownResultZ, ActionContractsZ, ACTION_NAMES;
var init_actions_contract = __esm({
  "packages/contracts/src/actions-contract.ts"() {
    "use strict";
    init_ide_config();
    ProjectOpenTerminalInputZ = z11.object({
      name: z11.string().min(1)
    });
    ProjectOpenTerminalResultZ = z11.object({
      sessionName: z11.string(),
      cwd: z11.string().min(1),
      terminalTabId: z11.string(),
      /**
       * `true` when the dispatcher had to launch the tmux session as part of
       * resolving the terminal. `false` when the session was already running.
       */
      launched: z11.boolean()
    });
    ProjectLaunchInputZ = z11.object({
      name: z11.string().min(1)
    });
    ProjectLaunchResultZ = z11.object({
      sessionName: z11.string(),
      /**
       * `false` when the session was already running (idempotent no-op),
       * `true` when this call started a fresh session.
       */
      started: z11.boolean()
    });
    ProjectStopInputZ = z11.object({
      name: z11.string().min(1)
    });
    ProjectStopResultZ = z11.object({
      sessionName: z11.string(),
      /**
       * `false` when no session was running (idempotent no-op),
       * `true` when this call killed a session.
       */
      stopped: z11.boolean()
    });
    ProjectRestartInputZ = z11.object({
      name: z11.string().min(1)
    });
    ProjectRestartResultZ = z11.object({
      sessionName: z11.string(),
      restarted: z11.literal(true)
    });
    ProjectActivateInputZ = z11.object({
      name: z11.string().min(1)
    });
    ProjectActivateResultZ = z11.object({
      active: z11.boolean(),
      projectName: z11.string()
    });
    TerminalRespawnInputZ = z11.object({
      sessionName: z11.string().min(1),
      terminalId: z11.string().min(1),
      /**
       * Optional cwd override. Omit to respawn at the bridge's current cwd
       * (re-using the `lastCwd` recorded by the PTY bridge).
       */
      cwd: z11.string().min(1).optional()
    });
    TerminalRespawnResultZ = z11.object({
      respawned: z11.literal(true),
      cwd: z11.string().min(1)
    });
    TerminalStopInputZ = z11.object({
      sessionName: z11.string().min(1),
      terminalId: z11.string().min(1)
    });
    TerminalStopResultZ = z11.object({
      stopped: z11.literal(true)
    });
    ConfigSetInputZ = z11.object({
      projectName: z11.string().min(1).optional(),
      path: z11.string().min(1),
      value: z11.unknown()
    });
    ConfigResultZ = z11.object({
      config: IdeConfigSchema
    });
    ConfigAddPaneInputZ = PaneSchema.partial().extend({
      projectName: z11.string().min(1).optional(),
      rowIndex: z11.number().int().min(0)
    });
    ConfigAddPaneResultZ = ConfigResultZ;
    ConfigRemovePaneInputZ = z11.object({
      projectName: z11.string().min(1).optional(),
      rowIndex: z11.number().int().min(0),
      paneIndex: z11.number().int().min(0)
    });
    ConfigRemovePaneResultZ = ConfigResultZ;
    ConfigAddRowInputZ = z11.object({
      projectName: z11.string().min(1).optional(),
      size: z11.string().optional()
    });
    ConfigAddRowResultZ = ConfigResultZ;
    ConfigEnableTeamInputZ = z11.object({
      projectName: z11.string().min(1).optional(),
      name: z11.string().min(1).optional()
    });
    ConfigEnableTeamResultZ = ConfigResultZ;
    ConfigDisableTeamInputZ = z11.object({
      projectName: z11.string().min(1).optional()
    });
    ConfigDisableTeamResultZ = ConfigResultZ;
    AppSetRemoteAccessInputZ = z11.object({
      enabled: z11.boolean()
    });
    AppSetRemoteAccessResultZ = z11.object({
      enabled: z11.boolean(),
      url: z11.string().nullable(),
      token: z11.string().nullable(),
      qrPayload: z11.string().nullable()
    });
    DaemonShutdownInputZ = z11.object({
      reason: z11.string().optional(),
      expectedInstanceId: z11.uuid().optional()
    });
    DaemonShutdownResultZ = z11.object({
      stopping: z11.literal(true)
    });
    ActionContractsZ = {
      "project.openTerminal": {
        input: ProjectOpenTerminalInputZ,
        result: ProjectOpenTerminalResultZ
      },
      "project.launch": {
        input: ProjectLaunchInputZ,
        result: ProjectLaunchResultZ
      },
      "project.stop": {
        input: ProjectStopInputZ,
        result: ProjectStopResultZ
      },
      "project.restart": {
        input: ProjectRestartInputZ,
        result: ProjectRestartResultZ
      },
      "project.activate": {
        input: ProjectActivateInputZ,
        result: ProjectActivateResultZ
      },
      "terminal.respawn": {
        input: TerminalRespawnInputZ,
        result: TerminalRespawnResultZ
      },
      "terminal.stop": {
        input: TerminalStopInputZ,
        result: TerminalStopResultZ
      },
      "config.set": {
        input: ConfigSetInputZ,
        result: ConfigResultZ
      },
      "config.addPane": {
        input: ConfigAddPaneInputZ,
        result: ConfigAddPaneResultZ
      },
      "config.removePane": {
        input: ConfigRemovePaneInputZ,
        result: ConfigRemovePaneResultZ
      },
      "config.addRow": {
        input: ConfigAddRowInputZ,
        result: ConfigAddRowResultZ
      },
      "config.enableTeam": {
        input: ConfigEnableTeamInputZ,
        result: ConfigEnableTeamResultZ
      },
      "config.disableTeam": {
        input: ConfigDisableTeamInputZ,
        result: ConfigDisableTeamResultZ
      },
      "app.setRemoteAccess": {
        input: AppSetRemoteAccessInputZ,
        result: AppSetRemoteAccessResultZ
      },
      "daemon.shutdown": {
        input: DaemonShutdownInputZ,
        result: DaemonShutdownResultZ
      }
    };
    ACTION_NAMES = Object.keys(ActionContractsZ);
  }
});

// packages/contracts/src/actions-errors.ts
var init_actions_errors = __esm({
  "packages/contracts/src/actions-errors.ts"() {
    "use strict";
  }
});

// packages/contracts/src/terminals.ts
import { z as z12 } from "zod";
async function createScriptTerminalId(args) {
  const scope = args.scopeId ?? args.taskId;
  if (!scope) {
    throw new Error("createScriptTerminalId: scopeId (or taskId) is required");
  }
  const key = `${args.projectId}::${scope}::${args.kind}::${args.script}`;
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
var terminalKindSchema, terminalCreateRequestSchema, terminalRenameRequestSchema;
var init_terminals = __esm({
  "packages/contracts/src/terminals.ts"() {
    "use strict";
    terminalKindSchema = z12.enum(["shell", "setup", "run", "teardown"]);
    terminalCreateRequestSchema = z12.object({
      scopeId: z12.string().trim().min(1).max(256),
      name: z12.string().trim().min(1).max(120),
      kind: terminalKindSchema.optional(),
      /** Provide for script tabs to opt into deterministic id collapse. */
      script: z12.string().max(2048).optional(),
      /** Explicit id wins. Used by the dashboard to reserve a known id
       *  (e.g. the default shell tab derived from session.dir). */
      id: z12.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/u, "id may only contain alphanumerics, '-', '_'").optional()
    }).refine((v) => v.kind !== void 0 || v.script === void 0, {
      message: "script requires kind",
      path: ["script"]
    });
    terminalRenameRequestSchema = z12.object({
      name: z12.string().trim().min(1).max(120)
    });
  }
});

// packages/contracts/src/control.ts
import { z as z13 } from "zod";
var CONTROL_PROTOCOL_VERSION, controlIdSchema, agentStatusSchema, controlRequestSchema, controlErrorSchema, controlResponseSchema, controlEventSchema, agentStatusEventSchema, agentsParamsSchema, sendParamsSchema, CONTROL_WAIT_MAX_TIMEOUT_MS, waitTimeoutSchema, waitParamsSchema, spawnPlacementSchema, spawnParamsSchema, restartAgentParamsSchema, stopAgentParamsSchema, explainParamsSchema, subscribeParamsSchema;
var init_control = __esm({
  "packages/contracts/src/control.ts"() {
    "use strict";
    CONTROL_PROTOCOL_VERSION = 1;
    controlIdSchema = z13.union([z13.string(), z13.number()]);
    agentStatusSchema = z13.enum(["blocked", "working", "done", "idle", "unknown"]);
    controlRequestSchema = z13.object({
      v: z13.literal(CONTROL_PROTOCOL_VERSION),
      id: controlIdSchema,
      verb: z13.string().min(1),
      params: z13.record(z13.string(), z13.unknown()).optional()
    });
    controlErrorSchema = z13.object({
      code: z13.string(),
      message: z13.string()
    });
    controlResponseSchema = z13.discriminatedUnion("ok", [
      z13.object({
        v: z13.literal(CONTROL_PROTOCOL_VERSION),
        id: controlIdSchema.nullable(),
        ok: z13.literal(true),
        data: z13.unknown()
      }),
      z13.object({
        v: z13.literal(CONTROL_PROTOCOL_VERSION),
        id: controlIdSchema.nullable(),
        ok: z13.literal(false),
        error: controlErrorSchema
      })
    ]);
    controlEventSchema = z13.object({
      v: z13.literal(CONTROL_PROTOCOL_VERSION),
      event: z13.string().min(1),
      data: z13.unknown()
    });
    agentStatusEventSchema = z13.object({
      ts: z13.string(),
      session: z13.string(),
      from: agentStatusSchema.nullable(),
      to: agentStatusSchema
    });
    agentsParamsSchema = z13.object({
      session: z13.string().optional()
    });
    sendParamsSchema = z13.object({
      session: z13.string().min(1),
      target: z13.string().min(1),
      message: z13.string().min(1),
      noEnter: z13.boolean().optional(),
      dir: z13.string().optional()
    });
    CONTROL_WAIT_MAX_TIMEOUT_MS = 6e5;
    waitTimeoutSchema = z13.number().int().positive().max(CONTROL_WAIT_MAX_TIMEOUT_MS).optional();
    waitParamsSchema = z13.discriminatedUnion("kind", [
      z13.object({
        kind: z13.literal("agent-status"),
        session: z13.string().min(1),
        status: agentStatusSchema,
        timeoutMs: waitTimeoutSchema
      }),
      z13.object({
        kind: z13.literal("output"),
        target: z13.string().min(1),
        match: z13.string().min(1),
        timeoutMs: waitTimeoutSchema
      })
    ]);
    spawnPlacementSchema = z13.enum(["window", "split-h", "split-v"]);
    spawnParamsSchema = z13.object({
      kind: z13.string().min(1).optional(),
      command: z13.string().min(1).optional(),
      session: z13.string().min(1).optional(),
      sessionName: z13.string().min(1).optional(),
      dir: z13.string().optional(),
      placement: spawnPlacementSchema.optional(),
      paneId: z13.string().optional()
    }).refine((p) => Boolean(p.kind) !== Boolean(p.command), {
      message: "exactly one of `kind` or `command` is required"
    }).refine((p) => Boolean(p.session) || Boolean(p.sessionName), {
      message: "`session` (spawn into it) or `sessionName` (create it) is required"
    }).refine((p) => !(p.placement && p.placement !== "window") || Boolean(p.paneId), {
      message: "split placements need `paneId`"
    });
    restartAgentParamsSchema = z13.object({
      paneId: z13.string().min(1),
      kind: z13.string().min(1).optional(),
      command: z13.string().min(1).optional()
    }).refine((p) => Boolean(p.kind) || Boolean(p.command), {
      message: "`kind` or `command` is required"
    });
    stopAgentParamsSchema = z13.object({
      paneId: z13.string().min(1)
    });
    explainParamsSchema = z13.object({
      target: z13.string().min(1)
    });
    subscribeParamsSchema = z13.object({}).loose();
  }
});

// packages/contracts/src/commands.ts
import { z as z14 } from "zod";
var COMMAND_PROTOCOL_VERSION, CommandIdSchemaZ, CommandOwnerSchemaZ, CommandSourceKindSchemaZ, CommandSourceSchemaZ, CommandSchemaReferencesSchemaZ, CommandConfirmationSchemaZ, CommandDescriptorSchemaZ, CommandArgumentsSchemaZ, CommandInvocationSchemaZ, CommandAvailabilitySchemaZ, CommandResolutionErrorCodeSchemaZ, CommandResolutionErrorSchemaZ, APPLICATION_SHELL_COMMAND_IDS, ApplicationShellCommandIdSchemaZ;
var init_commands = __esm({
  "packages/contracts/src/commands.ts"() {
    "use strict";
    COMMAND_PROTOCOL_VERSION = 1;
    CommandIdSchemaZ = z14.string().min(3).max(160).regex(
      /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/,
      "command id must be a dot-namespaced identifier"
    );
    CommandOwnerSchemaZ = z14.enum(["daemon", "renderer"]);
    CommandSourceKindSchemaZ = z14.enum([
      "cli",
      "http",
      "local-control",
      "keyboard",
      "palette",
      "menu",
      "mouse",
      "wheel",
      "program"
    ]);
    CommandSourceSchemaZ = z14.object({
      kind: CommandSourceKindSchemaZ,
      surface: z14.string().min(1).max(80).optional()
    }).strict();
    CommandSchemaReferencesSchemaZ = z14.object({
      input: z14.string().min(1).max(160),
      result: z14.string().min(1).max(160).optional()
    }).strict();
    CommandConfirmationSchemaZ = z14.enum(["none", "inline", "dialog"]);
    CommandDescriptorSchemaZ = z14.object({
      version: z14.literal(COMMAND_PROTOCOL_VERSION),
      id: CommandIdSchemaZ,
      owner: CommandOwnerSchemaZ,
      label: z14.string().min(1).max(160),
      description: z14.string().min(1).max(500).optional(),
      category: z14.string().min(1).max(80),
      schemas: CommandSchemaReferencesSchemaZ,
      dangerous: z14.boolean(),
      confirmation: CommandConfirmationSchemaZ
    }).strict();
    CommandArgumentsSchemaZ = z14.record(z14.string(), z14.json());
    CommandInvocationSchemaZ = z14.object({
      version: z14.literal(COMMAND_PROTOCOL_VERSION),
      id: CommandIdSchemaZ,
      source: CommandSourceSchemaZ,
      args: CommandArgumentsSchemaZ
    }).strict();
    CommandAvailabilitySchemaZ = z14.discriminatedUnion("available", [
      z14.object({ available: z14.literal(true) }).strict(),
      z14.object({
        available: z14.literal(false),
        reason: z14.string().min(1).max(500)
      }).strict()
    ]);
    CommandResolutionErrorCodeSchemaZ = z14.enum([
      "unknown-command",
      "invalid-invocation",
      "invalid-input",
      "unavailable"
    ]);
    CommandResolutionErrorSchemaZ = z14.object({
      code: CommandResolutionErrorCodeSchemaZ,
      message: z14.string().min(1),
      commandId: CommandIdSchemaZ.optional(),
      details: z14.json().optional()
    }).strict();
    APPLICATION_SHELL_COMMAND_IDS = Object.freeze({
      activateMode: "application.shell.mode.activate",
      activateDockTool: "application.shell.dock.activate",
      setDockMode: "application.shell.dock.mode.set",
      moveFocus: "application.shell.focus.move",
      openPalette: "application.shell.palette.open",
      closePalette: "application.shell.palette.close",
      selectResource: "application.shell.resource.select"
    });
    ApplicationShellCommandIdSchemaZ = z14.enum(
      Object.values(APPLICATION_SHELL_COMMAND_IDS)
    );
  }
});

// packages/contracts/src/desktop-host.ts
import { z as z15 } from "zod";
var DESKTOP_HOST_API_VERSION, DesktopRuntimeKindSchemaZ, DesktopPlatformSchemaZ, DesktopThemeModeSchemaZ, DesktopThemeStateSchemaZ, DesktopWindowStateSchemaZ, DesktopDaemonPreflightSchemaZ, DesktopHostBootstrapSchemaZ, DesktopMenuResultSchemaZ, DesktopDirectorySelectionSchemaZ;
var init_desktop_host = __esm({
  "packages/contracts/src/desktop-host.ts"() {
    "use strict";
    DESKTOP_HOST_API_VERSION = 1;
    DesktopRuntimeKindSchemaZ = z15.enum(["browser", "electron"]);
    DesktopPlatformSchemaZ = z15.enum(["darwin", "linux", "win32", "unknown"]);
    DesktopThemeModeSchemaZ = z15.enum(["light", "dark"]);
    DesktopThemeStateSchemaZ = z15.object({
      mode: DesktopThemeModeSchemaZ,
      highContrast: z15.boolean(),
      reducedMotion: z15.boolean()
    }).strict();
    DesktopWindowStateSchemaZ = z15.object({
      maximized: z15.boolean(),
      fullscreen: z15.boolean(),
      focused: z15.boolean()
    }).strict();
    DesktopDaemonPreflightSchemaZ = z15.discriminatedUnion("status", [
      z15.object({ status: z15.literal("ready"), apiBaseUrl: z15.string().url() }).strict(),
      z15.object({ status: z15.literal("absent") }).strict(),
      z15.object({ status: z15.literal("deferred"), reason: z15.string().min(1) }).strict(),
      z15.object({ status: z15.literal("unavailable"), reason: z15.string().min(1) }).strict()
    ]);
    DesktopHostBootstrapSchemaZ = z15.object({
      apiVersion: z15.literal(DESKTOP_HOST_API_VERSION),
      runtime: DesktopRuntimeKindSchemaZ,
      platform: DesktopPlatformSchemaZ,
      appVersion: z15.string().min(1),
      theme: DesktopThemeStateSchemaZ,
      window: DesktopWindowStateSchemaZ,
      daemon: DesktopDaemonPreflightSchemaZ
    }).strict();
    DesktopMenuResultSchemaZ = z15.object({ status: z15.literal("unavailable") }).strict();
    DesktopDirectorySelectionSchemaZ = z15.object({ path: z15.string().min(1) }).strict();
  }
});

// packages/contracts/src/experience-identifiers.ts
import { z as z16 } from "zod";
var SEMANTIC_ICON_IDS, SemanticIconIdSchemaZ, PANE_ROLE_IDS, PaneRoleIdSchemaZ;
var init_experience_identifiers = __esm({
  "packages/contracts/src/experience-identifiers.ts"() {
    "use strict";
    SEMANTIC_ICON_IDS = [
      "home",
      "terminals",
      "files",
      "changes",
      "missions",
      "activity",
      "preview",
      "native",
      "more",
      "close",
      "minimize",
      "maximize",
      "restore",
      "split-right",
      "split-down",
      "duplicate",
      "dock",
      "float",
      "move",
      "resize",
      "pop-out",
      "search",
      "refresh",
      "command"
    ];
    SemanticIconIdSchemaZ = z16.enum(SEMANTIC_ICON_IDS);
    PANE_ROLE_IDS = [
      "home",
      "terminal",
      "files",
      "changes",
      "missions",
      "activity",
      "preview",
      "native"
    ];
    PaneRoleIdSchemaZ = z16.enum(PANE_ROLE_IDS);
  }
});

// packages/contracts/src/pane-appearance.ts
import { z as z17 } from "zod";
var SemanticProductIdSchemaZ, PANE_STRUCTURE_IDS, PaneStructureSchemaZ, AGENT_ACTIVITY_IDS, AgentActivitySchemaZ, CANONICAL_DOMAIN_STATUS_IDS, CanonicalDomainStatusSchemaZ, PANE_ATTENTION_IDS, PaneAttentionSchemaZ, PaneVisualStateV1SchemaZ, DOMAIN_STATUS_TONES;
var init_pane_appearance = __esm({
  "packages/contracts/src/pane-appearance.ts"() {
    "use strict";
    SemanticProductIdSchemaZ = z17.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "semantic id contains a transport-only character");
    PANE_STRUCTURE_IDS = ["docked", "floating", "maximized"];
    PaneStructureSchemaZ = z17.enum(PANE_STRUCTURE_IDS);
    AGENT_ACTIVITY_IDS = [
      "idle",
      "running",
      "waiting",
      "complete",
      "failed",
      "disconnected"
    ];
    AgentActivitySchemaZ = z17.enum(AGENT_ACTIVITY_IDS);
    CANONICAL_DOMAIN_STATUS_IDS = [
      "idle",
      "running",
      "blocked",
      "review",
      "done",
      "disconnected",
      "recovering"
    ];
    CanonicalDomainStatusSchemaZ = z17.enum(CANONICAL_DOMAIN_STATUS_IDS);
    PANE_ATTENTION_IDS = [
      "none",
      "unread",
      "requested",
      "warning",
      "destructive",
      "recovery"
    ];
    PaneAttentionSchemaZ = z17.enum(PANE_ATTENTION_IDS);
    PaneVisualStateV1SchemaZ = z17.object({
      structure: PaneStructureSchemaZ,
      applicationFocus: z17.object({ pane: z17.boolean(), terminalInput: z17.boolean(), windowActive: z17.boolean() }).strict(),
      agentActivity: AgentActivitySchemaZ,
      domainStatus: CanonicalDomainStatusSchemaZ,
      attention: PaneAttentionSchemaZ,
      layoutInteraction: z17.object({
        editable: z17.boolean(),
        selected: z17.boolean(),
        dragging: z17.boolean(),
        resizing: z17.boolean(),
        previewing: z17.boolean()
      }).strict(),
      controlInteraction: z17.object({
        hover: z17.boolean(),
        focusVisible: z17.boolean(),
        pressed: z17.boolean(),
        disabled: z17.boolean(),
        loading: z17.boolean()
      }).strict()
    }).strict();
    DOMAIN_STATUS_TONES = Object.freeze({
      idle: "neutral",
      running: "info",
      blocked: "warning",
      review: "info",
      done: "success",
      disconnected: "danger",
      recovering: "danger"
    });
  }
});

// packages/contracts/src/experience-shell.ts
import { z as z18 } from "zod";
function deepFreezeData(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreezeData(child);
  return Object.freeze(value);
}
var ShellAreaIdSchemaZ, PRIMARY_WORKSPACE_MODE_IDS, PrimaryWorkspaceModeIdSchemaZ, DOCK_TOOL_IDS, DockToolIdSchemaZ, PRODUCT_SURFACE_IDS, ProductSurfaceIdSchemaZ, CANONICAL_SHELL_AREAS, SurfaceKindSchemaZ, ApplicationShellDockModeSchemaZ, SurfaceCommandTemplateSchemaZ, ProductSurfaceDefinitionSchemaZ, modeCommand, dockCommand, CANONICAL_SURFACE_REGISTRY, surfaceById;
var init_experience_shell = __esm({
  "packages/contracts/src/experience-shell.ts"() {
    "use strict";
    init_commands();
    init_experience_identifiers();
    init_pane_appearance();
    ShellAreaIdSchemaZ = z18.enum([
      "application-bar",
      "sidebar",
      "primary-navigation",
      "context-actions",
      "workspace-canvas",
      "bottom-dock",
      "status-strip"
    ]);
    PRIMARY_WORKSPACE_MODE_IDS = Object.freeze(["home", "terminals"]);
    PrimaryWorkspaceModeIdSchemaZ = z18.enum(PRIMARY_WORKSPACE_MODE_IDS);
    DOCK_TOOL_IDS = Object.freeze(["files", "changes", "missions", "activity"]);
    DockToolIdSchemaZ = z18.enum(DOCK_TOOL_IDS);
    PRODUCT_SURFACE_IDS = Object.freeze([
      ...PRIMARY_WORKSPACE_MODE_IDS,
      ...DOCK_TOOL_IDS
    ]);
    ProductSurfaceIdSchemaZ = z18.enum(PRODUCT_SURFACE_IDS);
    CANONICAL_SHELL_AREAS = deepFreezeData([
      { id: "application-bar", label: "Application bar", order: 0 },
      { id: "sidebar", label: "Workspace sidebar", order: 1 },
      { id: "primary-navigation", label: "Workspace modes", order: 2 },
      { id: "context-actions", label: "Context actions", order: 3 },
      { id: "workspace-canvas", label: "Workspace canvas", order: 4 },
      { id: "bottom-dock", label: "Bottom dock", order: 5 },
      { id: "status-strip", label: "Status and recovery", order: 6 }
    ]);
    SurfaceKindSchemaZ = z18.enum(["primary-mode", "dock-tool"]);
    ApplicationShellDockModeSchemaZ = z18.enum(["collapsed", "open", "maximized"]);
    SurfaceCommandTemplateSchemaZ = z18.discriminatedUnion("id", [
      z18.object({
        id: z18.literal(APPLICATION_SHELL_COMMAND_IDS.activateMode),
        args: z18.object({ mode: PrimaryWorkspaceModeIdSchemaZ }).strict()
      }).strict(),
      z18.object({
        id: z18.literal(APPLICATION_SHELL_COMMAND_IDS.activateDockTool),
        args: z18.object({ tool: DockToolIdSchemaZ }).strict()
      }).strict(),
      z18.object({
        id: z18.literal(APPLICATION_SHELL_COMMAND_IDS.setDockMode),
        args: z18.object({ mode: ApplicationShellDockModeSchemaZ }).strict()
      }).strict(),
      z18.object({
        id: z18.literal(APPLICATION_SHELL_COMMAND_IDS.selectResource),
        args: z18.object({ surface: ProductSurfaceIdSchemaZ, resourceId: SemanticProductIdSchemaZ }).strict()
      }).strict()
    ]);
    ProductSurfaceDefinitionSchemaZ = z18.object({
      id: ProductSurfaceIdSchemaZ,
      icon: SemanticIconIdSchemaZ,
      label: z18.string().min(1).max(160),
      kind: SurfaceKindSchemaZ,
      area: z18.enum(["workspace-canvas", "bottom-dock"]),
      order: z18.number().int().nonnegative(),
      owningMode: PrimaryWorkspaceModeIdSchemaZ,
      shortcut: z18.string().min(1).max(32),
      activation: SurfaceCommandTemplateSchemaZ
    }).strict().superRefine((surface, ctx) => {
      if (surface.kind === "primary-mode" && surface.activation.id !== APPLICATION_SHELL_COMMAND_IDS.activateMode) {
        ctx.addIssue({
          code: "custom",
          message: "primary modes require a mode activation command",
          path: ["activation", "id"]
        });
      }
      if (surface.kind === "dock-tool" && surface.activation.id !== APPLICATION_SHELL_COMMAND_IDS.activateDockTool) {
        ctx.addIssue({
          code: "custom",
          message: "dock tools require a dock activation command",
          path: ["activation", "id"]
        });
      }
    });
    modeCommand = (mode) => deepFreezeData({
      id: APPLICATION_SHELL_COMMAND_IDS.activateMode,
      args: { mode }
    });
    dockCommand = (tool) => deepFreezeData({
      id: APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
      args: { tool }
    });
    CANONICAL_SURFACE_REGISTRY = deepFreezeData(
      ProductSurfaceDefinitionSchemaZ.array().parse([
        {
          id: "home",
          icon: "home",
          label: "Home",
          kind: "primary-mode",
          area: "workspace-canvas",
          order: 0,
          owningMode: "home",
          shortcut: "F1",
          activation: modeCommand("home")
        },
        {
          id: "terminals",
          icon: "terminals",
          label: "Terminals",
          kind: "primary-mode",
          area: "workspace-canvas",
          order: 1,
          owningMode: "terminals",
          shortcut: "F2",
          activation: modeCommand("terminals")
        },
        {
          id: "files",
          icon: "files",
          label: "Files",
          kind: "dock-tool",
          area: "bottom-dock",
          order: 0,
          owningMode: "terminals",
          shortcut: "F3",
          activation: dockCommand("files")
        },
        {
          id: "changes",
          icon: "changes",
          label: "Changes",
          kind: "dock-tool",
          area: "bottom-dock",
          order: 1,
          owningMode: "terminals",
          shortcut: "F4",
          activation: dockCommand("changes")
        },
        {
          id: "missions",
          icon: "missions",
          label: "Missions",
          kind: "dock-tool",
          area: "bottom-dock",
          order: 2,
          owningMode: "terminals",
          shortcut: "F6",
          activation: dockCommand("missions")
        },
        {
          id: "activity",
          icon: "activity",
          label: "Activity",
          kind: "dock-tool",
          area: "bottom-dock",
          order: 3,
          owningMode: "terminals",
          shortcut: "F9",
          activation: dockCommand("activity")
        }
      ])
    );
    surfaceById = new Map(CANONICAL_SURFACE_REGISTRY.map((surface) => [surface.id, surface]));
    for (const surface of CANONICAL_SURFACE_REGISTRY) {
      SemanticIconIdSchemaZ.parse(surface.icon);
    }
  }
});

// packages/contracts/src/focus-overlay.ts
import { z as z19 } from "zod";
function resolveSemanticInputLayer(state) {
  const parsed = FocusOverlayStateV1SchemaZ.parse(state);
  let winner = null;
  for (const overlay of parsed.overlays) {
    if (!winner || overlayPriority[overlay.kind] >= overlayPriority[winner.kind]) winner = overlay;
  }
  if (winner) return { kind: winner.kind, overlayId: winner.id };
  if (parsed.terminalInputPaneId !== null && parsed.focusZone === "terminal") {
    return { kind: "terminal", paneId: parsed.terminalInputPaneId };
  }
  return { kind: "app", zone: parsed.focusZone };
}
var FocusZoneSchemaZ, SemanticFocusTargetSchemaZ, OverlayKindSchemaZ, SemanticOverlaySchemaZ, FocusOverlayStateV1SchemaZ, overlayPriority;
var init_focus_overlay = __esm({
  "packages/contracts/src/focus-overlay.ts"() {
    "use strict";
    init_experience_shell();
    init_pane_appearance();
    FocusZoneSchemaZ = z19.enum([
      "application-bar",
      "sidebar",
      "primary-navigation",
      "canvas",
      "dock-tabs",
      "dock-body",
      "status-strip",
      "terminal"
    ]);
    SemanticFocusTargetSchemaZ = z19.discriminatedUnion("kind", [
      z19.object({ kind: z19.literal("zone"), zone: FocusZoneSchemaZ }).strict(),
      z19.object({
        kind: z19.literal("pane"),
        paneId: SemanticProductIdSchemaZ,
        input: z19.enum(["chrome", "terminal"])
      }).strict(),
      z19.object({ kind: z19.literal("dock-tool"), tool: DockToolIdSchemaZ }).strict(),
      z19.object({
        kind: z19.literal("control"),
        controlId: SemanticProductIdSchemaZ,
        zone: FocusZoneSchemaZ
      }).strict()
    ]);
    OverlayKindSchemaZ = z19.enum(["modal-dialog", "command-palette", "context-menu"]);
    SemanticOverlaySchemaZ = z19.object({
      id: SemanticProductIdSchemaZ,
      kind: OverlayKindSchemaZ,
      focusReturnTarget: SemanticFocusTargetSchemaZ
    }).strict();
    FocusOverlayStateV1SchemaZ = z19.object({
      windowActivity: z19.enum(["active", "inactive"]),
      focusZone: FocusZoneSchemaZ,
      appFocusedPaneId: SemanticProductIdSchemaZ.nullable(),
      terminalInputPaneId: SemanticProductIdSchemaZ.nullable(),
      layoutSelectedPaneId: SemanticProductIdSchemaZ.nullable(),
      overlays: z19.array(SemanticOverlaySchemaZ).max(16)
    }).strict().superRefine((state, ctx) => {
      const ids = state.overlays.map((overlay) => overlay.id);
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: z19.ZodIssueCode.custom,
          message: "overlay ids must be unique",
          path: ["overlays"]
        });
      }
      if (state.terminalInputPaneId !== null && state.appFocusedPaneId !== state.terminalInputPaneId) {
        ctx.addIssue({
          code: z19.ZodIssueCode.custom,
          message: "terminal input owner must also be the app-focused pane",
          path: ["terminalInputPaneId"]
        });
      }
    });
    overlayPriority = {
      "context-menu": 1,
      "command-palette": 2,
      "modal-dialog": 3
    };
  }
});

// packages/contracts/src/visual-tokens.ts
import { z as z20 } from "zod";
function color(hex) {
  const normalized = hex.replace(/^#/u, "");
  return {
    space: "srgb",
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
    alpha: 255
  };
}
function mixSrgbColors(left, right, rightWeight) {
  const weight = Math.max(0, Math.min(1, rightWeight));
  const channel = (a, b) => Math.round(a * (1 - weight) + b * weight);
  return {
    space: "srgb",
    red: channel(left.red, right.red),
    green: channel(left.green, right.green),
    blue: channel(left.blue, right.blue),
    alpha: channel(left.alpha, right.alpha)
  };
}
function deriveFocusedHeader(header, focus) {
  return mixSrgbColors(header, focus, 0.16);
}
function baseTokens(appearance) {
  const dark = appearance === "dark";
  const header = color(dark ? "17171f" : "ececf1");
  const focus = color(dark ? "68a8ff" : "1769d2");
  return VisualTokensV1SchemaZ.parse({
    surfaces: {
      canvas: color(dark ? "0e0e12" : "f5f5f7"),
      panel: color(dark ? "13131a" : "ffffff"),
      panelRaised: color(dark ? "1b1b24" : "ffffff"),
      terminal: color(dark ? "0b0b10" : "fbfbfd"),
      header,
      headerActive: deriveFocusedHeader(header, focus),
      command: color(dark ? "181821" : "ffffff")
    },
    text: {
      primary: color(dark ? "dedee6" : "202027"),
      secondary: color(dark ? "a5a5b3" : "555563"),
      muted: color(dark ? "7b7b8a" : "72727f"),
      bright: color(dark ? "ffffff" : "09090d"),
      inverse: color(dark ? "101015" : "ffffff"),
      link: color(dark ? "62d9e8" : "006c7a")
    },
    borders: {
      subtle: color(dark ? "242430" : "dedee5"),
      default: color(dark ? "343445" : "c3c3ce"),
      focused: focus,
      selected: color(dark ? "d77cff" : "7d35a8"),
      attention: color(dark ? "f0bd5c" : "8d5c00"),
      danger: color(dark ? "ff6475" : "b42334")
    },
    statusTone: {
      neutral: color(dark ? "8b8b99" : "61616c"),
      info: color(dark ? "62b9ff" : "1769d2"),
      warning: color(dark ? "f0bd5c" : "8d5c00"),
      danger: color(dark ? "ff6475" : "b42334"),
      success: color(dark ? "62d49a" : "18764b")
    },
    selection: {
      selection: color(dark ? "315f89" : "cce4ff"),
      selectionText: color(dark ? "ffffff" : "172334"),
      hover: color(dark ? "222b38" : "e8eef6"),
      pressed: color(dark ? "2c394a" : "dbe5f1"),
      disabled: color(dark ? "1a1a20" : "ececf0")
    },
    density: {
      cellHeight: rhythm(1),
      headerHeight: rhythm(1),
      statusHeight: rhythm(1),
      inlineGap: rhythm(0.33),
      sectionGap: rhythm(1),
      controlPadding: rhythm(0.45)
    },
    shape: {
      dockedRadius: rhythm(0),
      floatingRadius: rhythm(0.33),
      controlRadius: rhythm(0.22),
      statusRadius: rhythm(0.44)
    },
    elevation: {
      floating: { level: 1, intent: "raised" },
      palette: { level: 3, intent: "overlay" },
      windowMode: { level: 2, intent: "overlay" }
    },
    motion: {
      instant: duration(0),
      fast: duration(90),
      standard: duration(150),
      emphasized: duration(220),
      easing: { standard: "standard", emphasized: "decelerate" }
    },
    typography: {
      workspace: {
        family: "monospace",
        weight: "regular",
        lineHeight: ratio(1.5),
        truncation: "ellipsis"
      },
      label: {
        family: "monospace",
        weight: "medium",
        lineHeight: ratio(1.35),
        truncation: "ellipsis"
      },
      title: {
        family: "monospace",
        weight: "semibold",
        lineHeight: ratio(1.35),
        truncation: "ellipsis"
      },
      metadata: {
        family: "monospace",
        weight: "regular",
        lineHeight: ratio(1.35),
        truncation: "ellipsis"
      },
      code: {
        family: "monospace",
        weight: "regular",
        lineHeight: ratio(1.5),
        truncation: "clip"
      }
    },
    focus: {
      outline: rhythm(0.12),
      outlineOffset: rhythm(0.05),
      focusContrast: ratio(4.5),
      highContrastOutline: color(dark ? "ffffff" : "000000")
    },
    windowActivity: {
      active: { opacity: ratio(1), contrast: ratio(1) },
      inactive: { opacity: ratio(0.82), contrast: ratio(0.88) }
    }
  });
}
var VISUAL_THEME_VERSION, DENSITY_TOKEN_ROLES, SHAPE_TOKEN_ROLES, ELEVATION_TOKEN_ROLES, MOTION_DURATION_ROLES, TYPOGRAPHY_TOKEN_ROLES, WINDOW_ACTIVITY_TOKEN_ROLES, RendererNeutralColorSchemaZ, RhythmValueSchemaZ, RatioValueSchemaZ, DurationValueSchemaZ, ElevationValueSchemaZ, TypographyValueSchemaZ, MotionEasingSchemaZ, WindowActivityValueSchemaZ, SurfacesSchemaZ, TextSchemaZ, BordersSchemaZ, StatusToneSchemaZ, SelectionSchemaZ, DensitySchemaZ, ShapeSchemaZ, ElevationSchemaZ, MotionSchemaZ, TypographySchemaZ, FocusSchemaZ, WindowActivitySchemaZ, VisualTokensV1SchemaZ, VisualTokenOverridesV1SchemaZ, ThemeIdSchemaZ, ThemeNameSchemaZ, ThemeAppearanceSchemaZ, VisualThemeDocumentV1SchemaZ, VisualThemeDocumentV0SchemaZ, ThemeAccessibilityPreferencesSchemaZ, groupSchemas, rhythm, ratio, duration, BUILTIN_VISUAL_THEMES;
var init_visual_tokens = __esm({
  "packages/contracts/src/visual-tokens.ts"() {
    "use strict";
    VISUAL_THEME_VERSION = 1;
    DENSITY_TOKEN_ROLES = [
      "cellHeight",
      "headerHeight",
      "statusHeight",
      "inlineGap",
      "sectionGap",
      "controlPadding"
    ];
    SHAPE_TOKEN_ROLES = [
      "dockedRadius",
      "floatingRadius",
      "controlRadius",
      "statusRadius"
    ];
    ELEVATION_TOKEN_ROLES = ["floating", "palette", "windowMode"];
    MOTION_DURATION_ROLES = ["instant", "fast", "standard", "emphasized"];
    TYPOGRAPHY_TOKEN_ROLES = ["workspace", "label", "title", "metadata", "code"];
    WINDOW_ACTIVITY_TOKEN_ROLES = ["active", "inactive"];
    RendererNeutralColorSchemaZ = z20.object({
      space: z20.literal("srgb"),
      red: z20.number().int().min(0).max(255),
      green: z20.number().int().min(0).max(255),
      blue: z20.number().int().min(0).max(255),
      alpha: z20.number().int().min(0).max(255)
    }).strict();
    RhythmValueSchemaZ = z20.object({ unit: z20.literal("rhythm"), value: z20.number().finite().min(0).max(16) }).strict();
    RatioValueSchemaZ = z20.object({ unit: z20.literal("ratio"), value: z20.number().finite().min(0).max(20) }).strict();
    DurationValueSchemaZ = z20.object({ unit: z20.literal("ms"), value: z20.number().finite().min(0).max(1e4) }).strict();
    ElevationValueSchemaZ = z20.object({
      level: z20.number().int().min(0).max(4),
      intent: z20.enum(["flat", "raised", "overlay"])
    }).strict();
    TypographyValueSchemaZ = z20.object({
      family: z20.enum(["monospace", "system"]),
      weight: z20.enum(["regular", "medium", "semibold", "bold"]),
      lineHeight: RatioValueSchemaZ,
      truncation: z20.enum(["ellipsis", "clip", "wrap"])
    }).strict();
    MotionEasingSchemaZ = z20.object({
      standard: z20.enum(["linear", "standard", "decelerate"]),
      emphasized: z20.enum(["linear", "standard", "decelerate"])
    }).strict();
    WindowActivityValueSchemaZ = z20.object({ opacity: RatioValueSchemaZ, contrast: RatioValueSchemaZ }).strict();
    SurfacesSchemaZ = z20.object({
      canvas: RendererNeutralColorSchemaZ,
      panel: RendererNeutralColorSchemaZ,
      panelRaised: RendererNeutralColorSchemaZ,
      terminal: RendererNeutralColorSchemaZ,
      header: RendererNeutralColorSchemaZ,
      headerActive: RendererNeutralColorSchemaZ,
      command: RendererNeutralColorSchemaZ
    }).strict();
    TextSchemaZ = z20.object({
      primary: RendererNeutralColorSchemaZ,
      secondary: RendererNeutralColorSchemaZ,
      muted: RendererNeutralColorSchemaZ,
      bright: RendererNeutralColorSchemaZ,
      inverse: RendererNeutralColorSchemaZ,
      link: RendererNeutralColorSchemaZ
    }).strict();
    BordersSchemaZ = z20.object({
      subtle: RendererNeutralColorSchemaZ,
      default: RendererNeutralColorSchemaZ,
      focused: RendererNeutralColorSchemaZ,
      selected: RendererNeutralColorSchemaZ,
      attention: RendererNeutralColorSchemaZ,
      danger: RendererNeutralColorSchemaZ
    }).strict();
    StatusToneSchemaZ = z20.object({
      neutral: RendererNeutralColorSchemaZ,
      info: RendererNeutralColorSchemaZ,
      warning: RendererNeutralColorSchemaZ,
      danger: RendererNeutralColorSchemaZ,
      success: RendererNeutralColorSchemaZ
    }).strict();
    SelectionSchemaZ = z20.object({
      selection: RendererNeutralColorSchemaZ,
      selectionText: RendererNeutralColorSchemaZ,
      hover: RendererNeutralColorSchemaZ,
      pressed: RendererNeutralColorSchemaZ,
      disabled: RendererNeutralColorSchemaZ
    }).strict();
    DensitySchemaZ = z20.object({
      cellHeight: RhythmValueSchemaZ,
      headerHeight: RhythmValueSchemaZ,
      statusHeight: RhythmValueSchemaZ,
      inlineGap: RhythmValueSchemaZ,
      sectionGap: RhythmValueSchemaZ,
      controlPadding: RhythmValueSchemaZ
    }).strict();
    ShapeSchemaZ = z20.object({
      dockedRadius: RhythmValueSchemaZ,
      floatingRadius: RhythmValueSchemaZ,
      controlRadius: RhythmValueSchemaZ,
      statusRadius: RhythmValueSchemaZ
    }).strict();
    ElevationSchemaZ = z20.object({
      floating: ElevationValueSchemaZ,
      palette: ElevationValueSchemaZ,
      windowMode: ElevationValueSchemaZ
    }).strict();
    MotionSchemaZ = z20.object({
      instant: DurationValueSchemaZ,
      fast: DurationValueSchemaZ,
      standard: DurationValueSchemaZ,
      emphasized: DurationValueSchemaZ,
      easing: MotionEasingSchemaZ
    }).strict();
    TypographySchemaZ = z20.object({
      workspace: TypographyValueSchemaZ,
      label: TypographyValueSchemaZ,
      title: TypographyValueSchemaZ,
      metadata: TypographyValueSchemaZ,
      code: TypographyValueSchemaZ
    }).strict();
    FocusSchemaZ = z20.object({
      outline: RhythmValueSchemaZ,
      outlineOffset: RhythmValueSchemaZ,
      focusContrast: RatioValueSchemaZ,
      highContrastOutline: RendererNeutralColorSchemaZ
    }).strict();
    WindowActivitySchemaZ = z20.object({ active: WindowActivityValueSchemaZ, inactive: WindowActivityValueSchemaZ }).strict();
    VisualTokensV1SchemaZ = z20.object({
      surfaces: SurfacesSchemaZ,
      text: TextSchemaZ,
      borders: BordersSchemaZ,
      statusTone: StatusToneSchemaZ,
      selection: SelectionSchemaZ,
      density: DensitySchemaZ,
      shape: ShapeSchemaZ,
      elevation: ElevationSchemaZ,
      motion: MotionSchemaZ,
      typography: TypographySchemaZ,
      focus: FocusSchemaZ,
      windowActivity: WindowActivitySchemaZ
    }).strict();
    VisualTokenOverridesV1SchemaZ = z20.object({
      surfaces: SurfacesSchemaZ.partial().optional(),
      text: TextSchemaZ.partial().optional(),
      borders: BordersSchemaZ.partial().optional(),
      statusTone: StatusToneSchemaZ.partial().optional(),
      selection: SelectionSchemaZ.partial().optional(),
      density: DensitySchemaZ.partial().optional(),
      shape: ShapeSchemaZ.partial().optional(),
      elevation: ElevationSchemaZ.partial().optional(),
      motion: MotionSchemaZ.partial().optional(),
      typography: TypographySchemaZ.partial().optional(),
      focus: FocusSchemaZ.partial().optional(),
      windowActivity: WindowActivitySchemaZ.partial().optional()
    }).strict();
    ThemeIdSchemaZ = z20.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9._-]*$/u);
    ThemeNameSchemaZ = z20.string().min(1).max(120);
    ThemeAppearanceSchemaZ = z20.enum(["dark", "light"]);
    VisualThemeDocumentV1SchemaZ = z20.object({
      version: z20.literal(VISUAL_THEME_VERSION),
      id: ThemeIdSchemaZ,
      name: ThemeNameSchemaZ,
      appearance: ThemeAppearanceSchemaZ.optional(),
      overrides: VisualTokenOverridesV1SchemaZ
    }).strict();
    VisualThemeDocumentV0SchemaZ = z20.object({
      version: z20.literal(0),
      id: ThemeIdSchemaZ,
      name: ThemeNameSchemaZ,
      appearance: ThemeAppearanceSchemaZ.optional(),
      tokens: VisualTokenOverridesV1SchemaZ
    }).strict();
    ThemeAccessibilityPreferencesSchemaZ = z20.object({ reducedMotion: z20.boolean(), increasedContrast: z20.boolean() }).strict();
    groupSchemas = {
      surfaces: {
        canvas: RendererNeutralColorSchemaZ,
        panel: RendererNeutralColorSchemaZ,
        panelRaised: RendererNeutralColorSchemaZ,
        terminal: RendererNeutralColorSchemaZ,
        header: RendererNeutralColorSchemaZ,
        headerActive: RendererNeutralColorSchemaZ,
        command: RendererNeutralColorSchemaZ
      },
      text: {
        primary: RendererNeutralColorSchemaZ,
        secondary: RendererNeutralColorSchemaZ,
        muted: RendererNeutralColorSchemaZ,
        bright: RendererNeutralColorSchemaZ,
        inverse: RendererNeutralColorSchemaZ,
        link: RendererNeutralColorSchemaZ
      },
      borders: {
        subtle: RendererNeutralColorSchemaZ,
        default: RendererNeutralColorSchemaZ,
        focused: RendererNeutralColorSchemaZ,
        selected: RendererNeutralColorSchemaZ,
        attention: RendererNeutralColorSchemaZ,
        danger: RendererNeutralColorSchemaZ
      },
      statusTone: {
        neutral: RendererNeutralColorSchemaZ,
        info: RendererNeutralColorSchemaZ,
        warning: RendererNeutralColorSchemaZ,
        danger: RendererNeutralColorSchemaZ,
        success: RendererNeutralColorSchemaZ
      },
      selection: {
        selection: RendererNeutralColorSchemaZ,
        selectionText: RendererNeutralColorSchemaZ,
        hover: RendererNeutralColorSchemaZ,
        pressed: RendererNeutralColorSchemaZ,
        disabled: RendererNeutralColorSchemaZ
      },
      density: Object.fromEntries(DENSITY_TOKEN_ROLES.map((role) => [role, RhythmValueSchemaZ])),
      shape: Object.fromEntries(SHAPE_TOKEN_ROLES.map((role) => [role, RhythmValueSchemaZ])),
      elevation: Object.fromEntries(ELEVATION_TOKEN_ROLES.map((role) => [role, ElevationValueSchemaZ])),
      motion: {
        ...Object.fromEntries(MOTION_DURATION_ROLES.map((role) => [role, DurationValueSchemaZ])),
        easing: MotionEasingSchemaZ
      },
      typography: Object.fromEntries(
        TYPOGRAPHY_TOKEN_ROLES.map((role) => [role, TypographyValueSchemaZ])
      ),
      focus: {
        outline: RhythmValueSchemaZ,
        outlineOffset: RhythmValueSchemaZ,
        focusContrast: RatioValueSchemaZ,
        highContrastOutline: RendererNeutralColorSchemaZ
      },
      windowActivity: Object.fromEntries(
        WINDOW_ACTIVITY_TOKEN_ROLES.map((role) => [role, WindowActivityValueSchemaZ])
      )
    };
    rhythm = (value) => ({ unit: "rhythm", value });
    ratio = (value) => ({ unit: "ratio", value });
    duration = (value) => ({ unit: "ms", value });
    BUILTIN_VISUAL_THEMES = Object.freeze({ dark: baseTokens("dark"), light: baseTokens("light") });
  }
});

// packages/contracts/src/cohesion-fixture.ts
import { z as z21 } from "zod";
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
var COHESION_FIXTURE_VERSION, LabelSchemaZ, OptionalLabelSchemaZ, ReadinessSchemaZ, SessionSidebarItemSchemaZ, AgentSidebarItemSchemaZ, PaneActionSchemaZ, PaneFixtureSchemaZ, DockToolDataSchemaZ, DockToolFixtureSchemaZ, ConnectionRecoverySchemaZ, CohesionFixtureV1SchemaZ, paneActions, COHESION_FIXTURE_V1_INPUT, COHESION_FIXTURE_V1;
var init_cohesion_fixture = __esm({
  "packages/contracts/src/cohesion-fixture.ts"() {
    "use strict";
    init_commands();
    init_experience_shell();
    init_experience_identifiers();
    init_focus_overlay();
    init_pane_appearance();
    init_visual_tokens();
    COHESION_FIXTURE_VERSION = 1;
    LabelSchemaZ = z21.string().min(1).max(160);
    OptionalLabelSchemaZ = z21.string().min(1).max(240).nullable();
    ReadinessSchemaZ = z21.object({
      state: z21.enum(["ready", "warning", "blocked"]),
      facts: z21.array(LabelSchemaZ).max(24),
      warnings: z21.array(LabelSchemaZ).max(24)
    }).strict();
    SessionSidebarItemSchemaZ = z21.object({
      id: SemanticProductIdSchemaZ,
      label: LabelSchemaZ,
      state: z21.enum(["connected", "reconnecting", "disconnected"]),
      active: z21.boolean()
    }).strict();
    AgentSidebarItemSchemaZ = z21.object({
      id: SemanticProductIdSchemaZ,
      name: LabelSchemaZ,
      harness: z21.enum(["codex", "claude-code", "custom"]),
      activity: AgentActivitySchemaZ,
      paneId: SemanticProductIdSchemaZ.nullable(),
      attention: z21.boolean()
    }).strict();
    PaneActionSchemaZ = z21.object({
      id: z21.enum([
        "focus-terminal",
        "split",
        "duplicate",
        "float-toggle",
        "maximize-toggle",
        "detach"
      ]),
      icon: SemanticIconIdSchemaZ,
      label: LabelSchemaZ,
      commandId: CommandIdSchemaZ,
      available: z21.boolean(),
      disabledReason: OptionalLabelSchemaZ
    }).strict().refine((action) => action.available === (action.disabledReason === null), {
      message: "available actions must not have a disabled reason and unavailable actions must",
      path: ["disabledReason"]
    });
    PaneFixtureSchemaZ = z21.object({
      id: SemanticProductIdSchemaZ,
      role: PaneRoleIdSchemaZ,
      title: LabelSchemaZ,
      subtitle: OptionalLabelSchemaZ,
      terminalSourceId: SemanticProductIdSchemaZ.nullable(),
      agentId: SemanticProductIdSchemaZ.nullable(),
      state: PaneVisualStateV1SchemaZ,
      actions: z21.array(PaneActionSchemaZ).min(1).max(6)
    }).strict().superRefine((pane, ctx) => {
      const expectedOrder = [
        "focus-terminal",
        "split",
        "duplicate",
        "float-toggle",
        "maximize-toggle",
        "detach"
      ];
      let last = -1;
      for (const [index, action] of pane.actions.entries()) {
        const order = expectedOrder.indexOf(action.id);
        if (order <= last) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "pane actions must follow canonical action order",
            path: ["actions", index, "id"]
          });
        }
        last = order;
      }
    });
    DockToolDataSchemaZ = z21.discriminatedUnion("kind", [
      z21.object({
        kind: z21.literal("files"),
        selectedResourceId: SemanticProductIdSchemaZ.nullable(),
        fileCount: z21.number().int().nonnegative()
      }).strict(),
      z21.object({
        kind: z21.literal("changes"),
        selectedResourceId: SemanticProductIdSchemaZ.nullable(),
        changeCount: z21.number().int().nonnegative()
      }).strict(),
      z21.object({
        kind: z21.literal("missions"),
        missionId: SemanticProductIdSchemaZ,
        title: LabelSchemaZ,
        status: CanonicalDomainStatusSchemaZ,
        goalCount: z21.number().int().nonnegative(),
        taskCount: z21.number().int().nonnegative()
      }).strict(),
      z21.object({
        kind: z21.literal("activity"),
        eventCount: z21.number().int().nonnegative(),
        latestEventLabel: OptionalLabelSchemaZ
      }).strict()
    ]);
    DockToolFixtureSchemaZ = z21.object({
      id: DockToolIdSchemaZ,
      label: LabelSchemaZ,
      shortcut: LabelSchemaZ,
      unreadCount: z21.number().int().nonnegative(),
      disabledReason: OptionalLabelSchemaZ,
      data: DockToolDataSchemaZ
    }).strict().refine((tool) => tool.id === tool.data.kind, {
      message: "dock tool data kind must match its canonical tool id",
      path: ["data", "kind"]
    });
    ConnectionRecoverySchemaZ = z21.object({
      state: z21.enum(["connected", "reconnecting", "disconnected", "recovering"]),
      message: LabelSchemaZ,
      safeState: LabelSchemaZ,
      nextAction: LabelSchemaZ
    }).strict();
    CohesionFixtureV1SchemaZ = z21.object({
      version: z21.literal(COHESION_FIXTURE_VERSION),
      project: z21.object({
        id: SemanticProductIdSchemaZ,
        name: LabelSchemaZ,
        rootLabel: LabelSchemaZ,
        readiness: ReadinessSchemaZ
      }).strict(),
      workspace: z21.object({
        id: SemanticProductIdSchemaZ,
        name: LabelSchemaZ,
        activeMode: PrimaryWorkspaceModeIdSchemaZ,
        session: SessionSidebarItemSchemaZ,
        sidebar: z21.object({
          sessions: z21.array(SessionSidebarItemSchemaZ).min(1).max(32),
          agents: z21.array(AgentSidebarItemSchemaZ).max(64)
        }).strict()
      }).strict(),
      panes: z21.array(PaneFixtureSchemaZ).min(1).max(32),
      dock: z21.object({
        mode: z21.enum(["collapsed", "open", "maximized"]),
        activeTool: DockToolIdSchemaZ,
        tools: z21.array(DockToolFixtureSchemaZ).length(4)
      }).strict(),
      focus: FocusOverlayStateV1SchemaZ,
      theme: z21.object({
        user: VisualThemeDocumentV1SchemaZ.nullable(),
        project: VisualThemeDocumentV1SchemaZ.nullable(),
        accessibility: ThemeAccessibilityPreferencesSchemaZ
      }).strict(),
      connection: ConnectionRecoverySchemaZ
    }).strict().superRefine((fixture, ctx) => {
      const paneIds = fixture.panes.map((pane) => pane.id);
      const paneIdSet = new Set(paneIds);
      if (paneIdSet.size !== paneIds.length) {
        ctx.addIssue({
          code: z21.ZodIssueCode.custom,
          message: "pane ids must be unique",
          path: ["panes"]
        });
      }
      const agentIds = fixture.workspace.sidebar.agents.map((agent) => agent.id);
      if (new Set(agentIds).size !== agentIds.length) {
        ctx.addIssue({
          code: z21.ZodIssueCode.custom,
          message: "agent ids must be unique",
          path: ["workspace", "sidebar", "agents"]
        });
      }
      const sessionIds = fixture.workspace.sidebar.sessions.map((session) => session.id);
      if (new Set(sessionIds).size !== sessionIds.length) {
        ctx.addIssue({
          code: z21.ZodIssueCode.custom,
          message: "session ids must be unique",
          path: ["workspace", "sidebar", "sessions"]
        });
      }
      if (!fixture.workspace.sidebar.sessions.some(
        (session) => session.id === fixture.workspace.session.id
      )) {
        ctx.addIssue({
          code: z21.ZodIssueCode.custom,
          message: "active session must be present in the sidebar",
          path: ["workspace", "session", "id"]
        });
      }
      for (const [index, agent] of fixture.workspace.sidebar.agents.entries()) {
        if (agent.paneId !== null && !paneIdSet.has(agent.paneId)) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "agent pane must exist in fixture panes",
            path: ["workspace", "sidebar", "agents", index, "paneId"]
          });
        }
      }
      const focusReferences = [
        fixture.focus.appFocusedPaneId,
        fixture.focus.terminalInputPaneId,
        fixture.focus.layoutSelectedPaneId
      ];
      for (const paneId of focusReferences) {
        if (paneId !== null && !paneIdSet.has(paneId)) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "focus state references an unknown pane",
            path: ["focus"]
          });
        }
      }
      for (const [index, pane] of fixture.panes.entries()) {
        const shouldBeFocused = pane.id === fixture.focus.appFocusedPaneId;
        const shouldOwnTerminal = pane.id === fixture.focus.terminalInputPaneId;
        const shouldBeSelected = pane.id === fixture.focus.layoutSelectedPaneId;
        if (pane.state.applicationFocus.pane !== shouldBeFocused) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "pane focus channel must match canonical focus state",
            path: ["panes", index, "state", "applicationFocus", "pane"]
          });
        }
        if (pane.state.applicationFocus.terminalInput !== shouldOwnTerminal) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "terminal input channel must match canonical focus state",
            path: ["panes", index, "state", "applicationFocus", "terminalInput"]
          });
        }
        if (pane.state.layoutInteraction.selected !== shouldBeSelected) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "layout selection channel must match canonical focus state",
            path: ["panes", index, "state", "layoutInteraction", "selected"]
          });
        }
        if (pane.state.applicationFocus.windowActive !== (fixture.focus.windowActivity === "active")) {
          ctx.addIssue({
            code: z21.ZodIssueCode.custom,
            message: "pane window activity must match canonical focus state",
            path: ["panes", index, "state", "applicationFocus", "windowActive"]
          });
        }
      }
      const expectedDockOrder = CANONICAL_SURFACE_REGISTRY.filter(
        (surface) => surface.kind === "dock-tool"
      ).map((surface) => surface.id);
      const actualDockOrder = fixture.dock.tools.map((tool) => tool.id);
      if (actualDockOrder.some((tool, index) => tool !== expectedDockOrder[index])) {
        ctx.addIssue({
          code: z21.ZodIssueCode.custom,
          message: "dock tools must use canonical identity and order",
          path: ["dock", "tools"]
        });
      }
    });
    paneActions = (canSplit) => [
      {
        id: "focus-terminal",
        icon: "terminals",
        label: "Focus terminal",
        commandId: "pane.terminal.focus",
        available: true,
        disabledReason: null
      },
      {
        id: "split",
        icon: "split-right",
        label: "Split pane",
        commandId: "pane.split",
        available: canSplit,
        disabledReason: canSplit ? null : "This pane cannot be split while recovering"
      },
      {
        id: "duplicate",
        icon: "duplicate",
        label: "Duplicate pane",
        commandId: "pane.duplicate",
        available: canSplit,
        disabledReason: canSplit ? null : "This pane cannot be duplicated while recovering"
      },
      {
        id: "float-toggle",
        icon: "float",
        label: "Float or dock",
        commandId: "pane.float.toggle",
        available: true,
        disabledReason: null
      },
      {
        id: "maximize-toggle",
        icon: "maximize",
        label: "Maximize or restore",
        commandId: "pane.maximize.toggle",
        available: true,
        disabledReason: null
      },
      {
        id: "detach",
        icon: "pop-out",
        label: "Detach pane",
        commandId: "pane.detach",
        available: true,
        disabledReason: null
      }
    ];
    COHESION_FIXTURE_V1_INPUT = CohesionFixtureV1SchemaZ.parse({
      version: COHESION_FIXTURE_VERSION,
      project: {
        id: "project.tmux-ide",
        name: "tmux-ide",
        rootLabel: "tmux-ide",
        readiness: {
          state: "warning",
          facts: ["pnpm workspace detected", "Codex and Claude Code are available"],
          warnings: ["Desktop terminal attachment is reconnecting"]
        }
      },
      workspace: {
        id: "workspace.product",
        name: "Product workspace",
        activeMode: "terminals",
        session: { id: "session.product", label: "Product", state: "reconnecting", active: true },
        sidebar: {
          sessions: [
            { id: "session.product", label: "Product", state: "reconnecting", active: true },
            { id: "session.docs", label: "Documentation", state: "connected", active: false }
          ],
          agents: [
            {
              id: "agent.pm",
              name: "Fable",
              harness: "claude-code",
              activity: "waiting",
              paneId: "pane.pm",
              attention: true
            },
            {
              id: "agent.implementer",
              name: "Codex",
              harness: "codex",
              activity: "running",
              paneId: "pane.implementer",
              attention: false
            },
            {
              id: "agent.reviewer",
              name: "Review",
              harness: "codex",
              activity: "complete",
              paneId: "pane.reviewer",
              attention: false
            },
            {
              id: "agent.recovery",
              name: "Recovery",
              harness: "custom",
              activity: "disconnected",
              paneId: "pane.recovery",
              attention: true
            }
          ]
        }
      },
      panes: [
        {
          id: "pane.pm",
          role: "terminal",
          title: "Project manager",
          subtitle: "Fable",
          terminalSourceId: "terminal.pm",
          agentId: "agent.pm",
          state: {
            structure: "docked",
            applicationFocus: { pane: false, terminalInput: false, windowActive: true },
            agentActivity: "waiting",
            domainStatus: "blocked",
            attention: "requested",
            layoutInteraction: {
              editable: true,
              selected: false,
              dragging: false,
              resizing: false,
              previewing: false
            },
            controlInteraction: {
              hover: false,
              focusVisible: false,
              pressed: false,
              disabled: false,
              loading: false
            }
          },
          actions: paneActions(true)
        },
        {
          id: "pane.implementer",
          role: "terminal",
          title: "Implementer",
          subtitle: "Codex",
          terminalSourceId: "terminal.implementer",
          agentId: "agent.implementer",
          state: {
            structure: "maximized",
            applicationFocus: { pane: true, terminalInput: true, windowActive: true },
            agentActivity: "running",
            domainStatus: "running",
            attention: "unread",
            layoutInteraction: {
              editable: false,
              selected: false,
              dragging: false,
              resizing: false,
              previewing: false
            },
            controlInteraction: {
              hover: true,
              focusVisible: true,
              pressed: true,
              disabled: false,
              loading: false
            }
          },
          actions: paneActions(true)
        },
        {
          id: "pane.reviewer",
          role: "terminal",
          title: "Reviewer",
          subtitle: "Completed review",
          terminalSourceId: "terminal.reviewer",
          agentId: "agent.reviewer",
          state: {
            structure: "floating",
            applicationFocus: { pane: false, terminalInput: false, windowActive: true },
            agentActivity: "complete",
            domainStatus: "review",
            attention: "none",
            layoutInteraction: {
              editable: true,
              selected: true,
              dragging: false,
              resizing: false,
              previewing: true
            },
            controlInteraction: {
              hover: false,
              focusVisible: false,
              pressed: false,
              disabled: false,
              loading: false
            }
          },
          actions: paneActions(true)
        },
        {
          id: "pane.recovery",
          role: "terminal",
          title: "Recovery",
          subtitle: "Connection lost",
          terminalSourceId: "terminal.recovery",
          agentId: "agent.recovery",
          state: {
            structure: "docked",
            applicationFocus: { pane: false, terminalInput: false, windowActive: true },
            agentActivity: "disconnected",
            domainStatus: "recovering",
            attention: "recovery",
            layoutInteraction: {
              editable: false,
              selected: false,
              dragging: false,
              resizing: false,
              previewing: false
            },
            controlInteraction: {
              hover: false,
              focusVisible: true,
              pressed: true,
              disabled: true,
              loading: true
            }
          },
          actions: paneActions(false)
        }
      ],
      dock: {
        mode: "open",
        activeTool: "missions",
        tools: [
          {
            id: "files",
            label: "Files",
            shortcut: "F3",
            unreadCount: 0,
            disabledReason: null,
            data: { kind: "files", selectedResourceId: "src.index", fileCount: 214 }
          },
          {
            id: "changes",
            label: "Changes",
            shortcut: "F4",
            unreadCount: 4,
            disabledReason: null,
            data: { kind: "changes", selectedResourceId: "src.chrome", changeCount: 4 }
          },
          {
            id: "missions",
            label: "Missions",
            shortcut: "F6",
            unreadCount: 1,
            disabledReason: null,
            data: {
              kind: "missions",
              missionId: "mission.m31",
              title: "Native agent workbench",
              status: "running",
              goalCount: 4,
              taskCount: 22
            }
          },
          {
            id: "activity",
            label: "Activity",
            shortcut: "F9",
            unreadCount: 2,
            disabledReason: null,
            data: { kind: "activity", eventCount: 18, latestEventLabel: "Reviewer completed" }
          }
        ]
      },
      focus: {
        windowActivity: "active",
        focusZone: "terminal",
        appFocusedPaneId: "pane.implementer",
        terminalInputPaneId: "pane.implementer",
        layoutSelectedPaneId: "pane.reviewer",
        overlays: [
          {
            id: "overlay.palette",
            kind: "command-palette",
            focusReturnTarget: {
              kind: "pane",
              paneId: "pane.implementer",
              input: "terminal"
            }
          }
        ]
      },
      theme: {
        user: {
          version: 1,
          id: "tmux-ide-dark",
          name: "tmux-ide Dark",
          appearance: "dark",
          overrides: {}
        },
        project: null,
        accessibility: { reducedMotion: false, increasedContrast: false }
      },
      connection: {
        state: "recovering",
        message: "Desktop terminal attachment is reconnecting",
        safeState: "The tmux session and agent processes remain active",
        nextAction: "Retry the attachment or open recovery details"
      }
    });
    COHESION_FIXTURE_V1 = deepFreeze(COHESION_FIXTURE_V1_INPUT);
  }
});

// packages/contracts/src/application-shell.ts
import { z as z22 } from "zod";
function deepFreeze2(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze2(child);
  return Object.freeze(value);
}
function applyFocusTarget(focus, target) {
  if (target.kind === "pane") {
    return {
      ...focus,
      focusZone: target.input === "terminal" ? "terminal" : "canvas",
      appFocusedPaneId: target.paneId,
      terminalInputPaneId: target.input === "terminal" ? target.paneId : null
    };
  }
  if (target.kind === "dock-tool") {
    return { ...focus, focusZone: "dock-tabs", terminalInputPaneId: null };
  }
  return {
    ...focus,
    focusZone: target.zone,
    terminalInputPaneId: null
  };
}
function replaceResourceSelection(selections, next) {
  const order = new Map(CANONICAL_SURFACE_REGISTRY.map((surface, index) => [surface.id, index]));
  return [...selections.filter(({ surface }) => surface !== next.surface), next].sort(
    (left, right) => order.get(left.surface) - order.get(right.surface)
  );
}
function applyApplicationShellInvocationV1(state, rawInvocation) {
  const current = ApplicationShellReplayStateV1SchemaZ.parse(state);
  const invocation = ApplicationShellCommandInvocationSchemaZ.parse(rawInvocation);
  const inputLayer = resolveSemanticInputLayer(current.focus);
  const overlayOwnsInput = inputLayer.kind === "modal-dialog" || inputLayer.kind === "command-palette" || inputLayer.kind === "context-menu";
  if (overlayOwnsInput) {
    if (invocation.id !== APPLICATION_SHELL_COMMAND_IDS.closePalette || inputLayer.kind !== "command-palette" || inputLayer.overlayId !== invocation.args.overlayId) {
      throw new Error(`semantic input is owned by overlay: ${inputLayer.overlayId}`);
    }
  } else if (invocation.id === APPLICATION_SHELL_COMMAND_IDS.closePalette) {
    throw new Error(`cannot close absent command palette: ${invocation.args.overlayId}`);
  }
  let next;
  switch (invocation.id) {
    case APPLICATION_SHELL_COMMAND_IDS.activateMode:
      next = { ...current, activeMode: invocation.args.mode };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.activateDockTool:
      next = { ...current, activeDockTool: invocation.args.tool };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.setDockMode:
      next = { ...current, dockMode: invocation.args.mode };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.moveFocus:
      next = { ...current, focus: applyFocusTarget(current.focus, invocation.args.target) };
      break;
    case APPLICATION_SHELL_COMMAND_IDS.openPalette: {
      const overlay = {
        id: invocation.args.overlayId,
        kind: "command-palette",
        focusReturnTarget: invocation.args.focusReturnTarget
      };
      next = {
        ...current,
        focus: { ...current.focus, overlays: [...current.focus.overlays, overlay] }
      };
      break;
    }
    case APPLICATION_SHELL_COMMAND_IDS.closePalette: {
      const overlay = current.focus.overlays.find(({ id }) => id === invocation.args.overlayId);
      if (!overlay || overlay.kind !== "command-palette") {
        throw new Error(`command palette overlay is not open: ${invocation.args.overlayId}`);
      }
      const withoutClosed = {
        ...current.focus,
        overlays: current.focus.overlays.filter(({ id }) => id !== overlay.id)
      };
      next = { ...current, focus: applyFocusTarget(withoutClosed, overlay.focusReturnTarget) };
      break;
    }
    case APPLICATION_SHELL_COMMAND_IDS.selectResource:
      next = {
        ...current,
        selectedResources: replaceResourceSelection(current.selectedResources, invocation.args)
      };
      break;
  }
  return deepFreeze2(ApplicationShellReplayStateV1SchemaZ.parse(next));
}
function replayInvocations(initialState, invocations) {
  return invocations.reduce(
    (state, invocation) => applyApplicationShellInvocationV1(state, invocation),
    deepFreeze2(ApplicationShellReplayStateV1SchemaZ.parse(initialState))
  );
}
var APPLICATION_SHELL_PROJECTION_VERSION, APPLICATION_SHELL_TRACE_VERSION, ApplicationShellProjectionInputV1SchemaZ, WorkspaceFixtureSchemaZ, ApplicationShellSurfaceProjectionSchemaZ, ApplicationShellProjectionV1SchemaZ, ApplicationShellActivateModeArgumentsSchemaZ, ApplicationShellActivateDockToolArgumentsSchemaZ, ApplicationShellSetDockModeArgumentsSchemaZ, ApplicationShellMoveFocusArgumentsSchemaZ, ApplicationShellOpenPaletteArgumentsSchemaZ, ApplicationShellClosePaletteArgumentsSchemaZ, ApplicationShellSelectResourceArgumentsSchemaZ, APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS, ApplicationShellCommandInvocationSchemaZ, descriptor, APPLICATION_SHELL_COMMAND_DESCRIPTORS, descriptorById, APPLICATION_SHELL_COMMAND_DEFINITIONS, ApplicationShellResourceSelectionSchemaZ, ApplicationShellReplayStateV1SchemaZ, ApplicationShellActionTraceV1BaseSchemaZ, ApplicationShellActionTraceV1SchemaZ;
var init_application_shell = __esm({
  "packages/contracts/src/application-shell.ts"() {
    "use strict";
    init_cohesion_fixture();
    init_commands();
    init_experience_shell();
    init_experience_identifiers();
    init_focus_overlay();
    init_pane_appearance();
    APPLICATION_SHELL_PROJECTION_VERSION = 1;
    APPLICATION_SHELL_TRACE_VERSION = 1;
    ApplicationShellProjectionInputV1SchemaZ = z22.object({
      project: CohesionFixtureV1SchemaZ.shape.project,
      workspace: CohesionFixtureV1SchemaZ.shape.workspace,
      dock: CohesionFixtureV1SchemaZ.shape.dock,
      focus: FocusOverlayStateV1SchemaZ,
      connection: CohesionFixtureV1SchemaZ.shape.connection
    }).strict();
    WorkspaceFixtureSchemaZ = CohesionFixtureV1SchemaZ.shape.workspace;
    ApplicationShellSurfaceProjectionSchemaZ = z22.object({
      id: ProductSurfaceIdSchemaZ,
      icon: SemanticIconIdSchemaZ,
      label: z22.string().min(1).max(160),
      kind: z22.enum(["primary-mode", "dock-tool"]),
      area: z22.enum(["workspace-canvas", "bottom-dock"]),
      order: z22.number().int().nonnegative(),
      owningMode: PrimaryWorkspaceModeIdSchemaZ,
      shortcut: z22.string().min(1).max(32),
      activation: SurfaceCommandTemplateSchemaZ,
      active: z22.boolean(),
      attention: z22.boolean(),
      disabledReason: z22.string().min(1).max(240).nullable()
    }).strict();
    ApplicationShellProjectionV1SchemaZ = z22.object({
      version: z22.literal(APPLICATION_SHELL_PROJECTION_VERSION),
      project: CohesionFixtureV1SchemaZ.shape.project,
      workspace: z22.object({
        id: SemanticProductIdSchemaZ,
        name: z22.string().min(1).max(160)
      }).strict(),
      sidebar: z22.object({
        activeSessionId: SemanticProductIdSchemaZ,
        sessions: WorkspaceFixtureSchemaZ.shape.sidebar.shape.sessions,
        agents: WorkspaceFixtureSchemaZ.shape.sidebar.shape.agents
      }).strict(),
      primaryNavigation: z22.object({
        activeMode: PrimaryWorkspaceModeIdSchemaZ,
        items: z22.array(ApplicationShellSurfaceProjectionSchemaZ)
      }).strict(),
      workspaceCanvas: z22.object({ activeMode: PrimaryWorkspaceModeIdSchemaZ }).strict(),
      bottomDock: z22.object({
        mode: ApplicationShellDockModeSchemaZ,
        activeTool: DockToolIdSchemaZ,
        tools: z22.array(ApplicationShellSurfaceProjectionSchemaZ)
      }).strict(),
      statusStrip: CohesionFixtureV1SchemaZ.shape.connection,
      focus: z22.object({
        windowActivity: z22.enum(["active", "inactive"]),
        zone: FocusZoneSchemaZ,
        appFocusedPaneId: SemanticProductIdSchemaZ.nullable(),
        terminalInputPaneId: SemanticProductIdSchemaZ.nullable(),
        layoutSelectedPaneId: SemanticProductIdSchemaZ.nullable(),
        overlays: z22.array(SemanticOverlaySchemaZ).max(16),
        palette: z22.object({
          open: z22.boolean(),
          overlayId: SemanticProductIdSchemaZ.nullable(),
          focusReturnTarget: SemanticFocusTargetSchemaZ.nullable()
        }).strict()
      }).strict()
    }).strict();
    ApplicationShellActivateModeArgumentsSchemaZ = z22.object({ mode: PrimaryWorkspaceModeIdSchemaZ }).strict();
    ApplicationShellActivateDockToolArgumentsSchemaZ = z22.object({ tool: DockToolIdSchemaZ }).strict();
    ApplicationShellSetDockModeArgumentsSchemaZ = z22.object({ mode: ApplicationShellDockModeSchemaZ }).strict();
    ApplicationShellMoveFocusArgumentsSchemaZ = z22.object({ target: SemanticFocusTargetSchemaZ }).strict();
    ApplicationShellOpenPaletteArgumentsSchemaZ = z22.object({
      overlayId: SemanticProductIdSchemaZ,
      focusReturnTarget: SemanticFocusTargetSchemaZ
    }).strict();
    ApplicationShellClosePaletteArgumentsSchemaZ = z22.object({ overlayId: SemanticProductIdSchemaZ }).strict();
    ApplicationShellSelectResourceArgumentsSchemaZ = z22.object({
      surface: ProductSurfaceIdSchemaZ,
      resourceId: SemanticProductIdSchemaZ
    }).strict();
    APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS = Object.freeze({
      [APPLICATION_SHELL_COMMAND_IDS.activateMode]: ApplicationShellActivateModeArgumentsSchemaZ,
      [APPLICATION_SHELL_COMMAND_IDS.activateDockTool]: ApplicationShellActivateDockToolArgumentsSchemaZ,
      [APPLICATION_SHELL_COMMAND_IDS.setDockMode]: ApplicationShellSetDockModeArgumentsSchemaZ,
      [APPLICATION_SHELL_COMMAND_IDS.moveFocus]: ApplicationShellMoveFocusArgumentsSchemaZ,
      [APPLICATION_SHELL_COMMAND_IDS.openPalette]: ApplicationShellOpenPaletteArgumentsSchemaZ,
      [APPLICATION_SHELL_COMMAND_IDS.closePalette]: ApplicationShellClosePaletteArgumentsSchemaZ,
      [APPLICATION_SHELL_COMMAND_IDS.selectResource]: ApplicationShellSelectResourceArgumentsSchemaZ
    });
    ApplicationShellCommandInvocationSchemaZ = z22.discriminatedUnion("id", [
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.activateMode),
        source: CommandSourceSchemaZ,
        args: ApplicationShellActivateModeArgumentsSchemaZ
      }).strict(),
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.activateDockTool),
        source: CommandSourceSchemaZ,
        args: ApplicationShellActivateDockToolArgumentsSchemaZ
      }).strict(),
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.setDockMode),
        source: CommandSourceSchemaZ,
        args: ApplicationShellSetDockModeArgumentsSchemaZ
      }).strict(),
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.moveFocus),
        source: CommandSourceSchemaZ,
        args: ApplicationShellMoveFocusArgumentsSchemaZ
      }).strict(),
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.openPalette),
        source: CommandSourceSchemaZ,
        args: ApplicationShellOpenPaletteArgumentsSchemaZ
      }).strict(),
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.closePalette),
        source: CommandSourceSchemaZ,
        args: ApplicationShellClosePaletteArgumentsSchemaZ
      }).strict(),
      z22.object({
        version: z22.literal(COMMAND_PROTOCOL_VERSION),
        id: z22.literal(APPLICATION_SHELL_COMMAND_IDS.selectResource),
        source: CommandSourceSchemaZ,
        args: ApplicationShellSelectResourceArgumentsSchemaZ
      }).strict()
    ]);
    descriptor = (id, label, category) => deepFreeze2(
      CommandDescriptorSchemaZ.parse({
        version: COMMAND_PROTOCOL_VERSION,
        id,
        owner: "renderer",
        label,
        category,
        schemas: { input: `${id}.input.v1` },
        dangerous: false,
        confirmation: "none"
      })
    );
    APPLICATION_SHELL_COMMAND_DESCRIPTORS = deepFreeze2([
      descriptor(APPLICATION_SHELL_COMMAND_IDS.activateMode, "Activate workspace mode", "workspace"),
      descriptor(APPLICATION_SHELL_COMMAND_IDS.activateDockTool, "Activate dock tool", "workspace"),
      descriptor(APPLICATION_SHELL_COMMAND_IDS.setDockMode, "Set dock mode", "workspace"),
      descriptor(APPLICATION_SHELL_COMMAND_IDS.moveFocus, "Move workspace focus", "workspace"),
      descriptor(APPLICATION_SHELL_COMMAND_IDS.openPalette, "Open command palette", "application"),
      descriptor(APPLICATION_SHELL_COMMAND_IDS.closePalette, "Close command palette", "application"),
      descriptor(
        APPLICATION_SHELL_COMMAND_IDS.selectResource,
        "Select workspace resource",
        "workspace"
      )
    ]);
    descriptorById = new Map(
      APPLICATION_SHELL_COMMAND_DESCRIPTORS.map((item) => [item.id, item])
    );
    APPLICATION_SHELL_COMMAND_DEFINITIONS = Object.freeze(
      APPLICATION_SHELL_COMMAND_DESCRIPTORS.map(
        (item) => Object.freeze({
          descriptor: item,
          inputSchema: APPLICATION_SHELL_COMMAND_ARGUMENT_SCHEMAS[item.id]
        })
      )
    );
    ApplicationShellResourceSelectionSchemaZ = z22.object({ surface: ProductSurfaceIdSchemaZ, resourceId: SemanticProductIdSchemaZ }).strict();
    ApplicationShellReplayStateV1SchemaZ = z22.object({
      activeMode: PrimaryWorkspaceModeIdSchemaZ,
      dockMode: ApplicationShellDockModeSchemaZ,
      activeDockTool: DockToolIdSchemaZ,
      focus: FocusOverlayStateV1SchemaZ,
      selectedResources: z22.array(ApplicationShellResourceSelectionSchemaZ)
    }).strict().superRefine((state, ctx) => {
      const surfaces = state.selectedResources.map(({ surface }) => surface);
      if (new Set(surfaces).size !== surfaces.length) {
        ctx.addIssue({
          code: "custom",
          message: "selected resources must be unique by surface",
          path: ["selectedResources"]
        });
      }
    });
    ApplicationShellActionTraceV1BaseSchemaZ = z22.object({
      version: z22.literal(APPLICATION_SHELL_TRACE_VERSION),
      initialState: ApplicationShellReplayStateV1SchemaZ,
      invocations: z22.array(ApplicationShellCommandInvocationSchemaZ),
      finalState: ApplicationShellReplayStateV1SchemaZ
    }).strict();
    ApplicationShellActionTraceV1SchemaZ = ApplicationShellActionTraceV1BaseSchemaZ.superRefine((trace, ctx) => {
      try {
        const replayed = replayInvocations(trace.initialState, trace.invocations);
        if (JSON.stringify(replayed) !== JSON.stringify(trace.finalState)) {
          ctx.addIssue({
            code: "custom",
            message: "final state does not match sequential command replay",
            path: ["finalState"]
          });
        }
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "command replay failed",
          path: ["invocations"]
        });
      }
    });
  }
});

// packages/contracts/src/visual-recipes.ts
var VISUAL_RECIPE_REGISTRY;
var init_visual_recipes = __esm({
  "packages/contracts/src/visual-recipes.ts"() {
    "use strict";
    VISUAL_RECIPE_REGISTRY = Object.freeze(
      {
        "application-bar": {
          id: "application-bar",
          surface: "header",
          text: "bright",
          border: "subtle",
          typography: "label",
          shape: "dockedRadius",
          elevation: null
        },
        sidebar: {
          id: "sidebar",
          surface: "panel",
          text: "secondary",
          border: "subtle",
          typography: "metadata",
          shape: "dockedRadius",
          elevation: null
        },
        "primary-navigation": {
          id: "primary-navigation",
          surface: "header",
          text: "primary",
          border: "subtle",
          typography: "label",
          shape: "controlRadius",
          elevation: null
        },
        "context-actions": {
          id: "context-actions",
          surface: "header",
          text: "secondary",
          border: "subtle",
          typography: "label",
          shape: "controlRadius",
          elevation: null
        },
        "workspace-canvas": {
          id: "workspace-canvas",
          surface: "canvas",
          text: "primary",
          border: "subtle",
          typography: "workspace",
          shape: "dockedRadius",
          elevation: null
        },
        "bottom-dock": {
          id: "bottom-dock",
          surface: "panel",
          text: "primary",
          border: "default",
          typography: "workspace",
          shape: "dockedRadius",
          elevation: null
        },
        "status-strip": {
          id: "status-strip",
          surface: "header",
          text: "muted",
          border: "subtle",
          typography: "metadata",
          shape: "statusRadius",
          elevation: null
        },
        "pane-docked": {
          id: "pane-docked",
          surface: "terminal",
          text: "primary",
          border: "default",
          typography: "workspace",
          shape: "dockedRadius",
          elevation: null
        },
        "pane-floating": {
          id: "pane-floating",
          surface: "panelRaised",
          text: "primary",
          border: "default",
          typography: "workspace",
          shape: "floatingRadius",
          elevation: "floating"
        },
        "command-palette": {
          id: "command-palette",
          surface: "command",
          text: "primary",
          border: "focused",
          typography: "workspace",
          shape: "floatingRadius",
          elevation: "palette"
        }
      }
    );
  }
});

// packages/contracts/src/daemon-wire.ts
import { z as z23 } from "zod";
function isDaemonWireProtocolCompatible(protocolVersion) {
  return protocolVersion === DAEMON_WIRE_PROTOCOL_VERSION;
}
var DAEMON_WIRE_PROTOCOL_VERSION, DaemonWireProtocolVersionSchema, DaemonInstanceIdSchema, CanonicalDaemonInfoSchema, DaemonHealthSchema, DaemonHealthzSchema, DaemonIdentitySchema;
var init_daemon_wire = __esm({
  "packages/contracts/src/daemon-wire.ts"() {
    "use strict";
    DAEMON_WIRE_PROTOCOL_VERSION = 1;
    DaemonWireProtocolVersionSchema = z23.number().int().positive();
    DaemonInstanceIdSchema = z23.uuid();
    CanonicalDaemonInfoSchema = z23.object({
      pid: z23.number().int().positive(),
      port: z23.number().int().min(1).max(65535),
      protocolVersion: DaemonWireProtocolVersionSchema,
      productVersion: z23.string().trim().min(1),
      instanceId: DaemonInstanceIdSchema,
      startedAt: z23.iso.datetime({ offset: true }),
      bindHostname: z23.string().trim().min(1),
      authToken: z23.string().min(1).nullable()
    });
    DaemonHealthSchema = z23.object({
      ok: z23.literal(true),
      protocolVersion: DaemonWireProtocolVersionSchema,
      productVersion: z23.string().trim().min(1),
      uptime: z23.number().nonnegative()
    });
    DaemonHealthzSchema = z23.object({
      ok: z23.literal(true),
      protocolVersion: DaemonWireProtocolVersionSchema,
      productVersion: z23.string().trim().min(1),
      uptimeMs: z23.number().nonnegative()
    });
    DaemonIdentitySchema = z23.object({
      ok: z23.literal(true),
      pid: z23.number().int().positive(),
      protocolVersion: DaemonWireProtocolVersionSchema,
      productVersion: z23.string().trim().min(1),
      instanceId: DaemonInstanceIdSchema,
      startedAt: z23.iso.datetime({ offset: true })
    });
  }
});

// packages/contracts/src/index.ts
var init_src = __esm({
  "packages/contracts/src/index.ts"() {
    "use strict";
    init_auth();
    init_hq();
    init_ide_config();
    init_domain();
    init_mission_projections();
    init_tmux();
    init_workspace();
    init_workspace_state();
    init_app_window_state();
    init_workspace_config();
    init_actions_contract();
    init_actions_errors();
    init_terminals();
    init_control();
    init_commands();
    init_desktop_host();
    init_experience_identifiers();
    init_experience_shell();
    init_application_shell();
    init_visual_tokens();
    init_visual_recipes();
    init_pane_appearance();
    init_focus_overlay();
    init_cohesion_fixture();
    init_daemon_wire();
  }
});

// packages/daemon/src/lib/project-resolver.ts
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
function safeExists(path2, io) {
  try {
    return io.exists(path2);
  } catch {
    return false;
  }
}
function canonicalize(path2, io) {
  const absolute = resolve(path2);
  try {
    return io.realpath(absolute);
  } catch {
    return absolute;
  }
}
function canonicalizeGitPath(path2, io) {
  try {
    return io.realpath(resolve(path2));
  } catch {
    return null;
  }
}
function isWithin(path2, root) {
  const fromRoot = relative(root, path2);
  return fromRoot === "" || fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}
async function resolveGitPath(args, cwd, allowRelative, io) {
  let output;
  try {
    output = await io.runGit(args, cwd);
  } catch {
    return null;
  }
  if (!output) return null;
  const path2 = output.trim();
  if (path2.length === 0 || path2.includes("\0") || /[\r\n]/.test(path2)) return null;
  if (!isAbsolute(path2) && !allowRelative) return null;
  return canonicalizeGitPath(isAbsolute(path2) ? path2 : resolve(cwd, path2), io);
}
function discoverConfigs(inputDir, gitProjectRoot, io) {
  let current = inputDir;
  let workspacePath = null;
  let legacyPath = null;
  let hasLegacyAtInput = false;
  while (true) {
    const workspaceCandidate = join(current, ".tmux-ide", "workspace.yml");
    const legacyCandidate = join(current, "ide.yml");
    if (!workspacePath && safeExists(workspaceCandidate, io)) {
      workspacePath = canonicalize(workspaceCandidate, io);
    }
    if (!legacyPath && safeExists(legacyCandidate, io)) {
      legacyPath = canonicalize(legacyCandidate, io);
      hasLegacyAtInput = current === inputDir;
    }
    if (workspacePath && legacyPath) break;
    if (gitProjectRoot && current === gitProjectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    if (gitProjectRoot && !isWithin(parent, gitProjectRoot)) break;
    current = parent;
  }
  return { workspacePath, legacyPath, hasLegacyAtInput };
}
function explicitConfigSource(explicitPath, inputDir, io) {
  const absolute = isAbsolute(explicitPath) ? explicitPath : resolve(inputDir, explicitPath);
  const path2 = canonicalize(absolute, io);
  return {
    kind: basename(path2) === "ide.yml" ? "legacy" : "workspace",
    path: path2,
    explicit: true
  };
}
function chooseConfig(explicitPath, inputDir, discovered, io) {
  if (explicitPath && explicitPath.trim().length > 0) {
    return explicitConfigSource(explicitPath, inputDir, io);
  }
  if (discovered.workspacePath) {
    return { kind: "workspace", path: discovered.workspacePath, explicit: false };
  }
  if (discovered.legacyPath) {
    return { kind: "legacy", path: discovered.legacyPath, explicit: false };
  }
  return { kind: "none", path: null, explicit: false };
}
function configProjectRoot(config2, inputDir) {
  if (config2.kind === "none") return inputDir;
  const configDir = dirname(config2.path);
  if (config2.kind === "workspace" && basename(configDir) === ".tmux-ide") {
    return dirname(configDir);
  }
  return configDir;
}
function hintedProjectRoot(hint, inputDir, io) {
  if (!hint || hint.trim().length === 0) return null;
  const root = canonicalize(isAbsolute(hint) ? hint : resolve(inputDir, hint), io);
  if (!isWithin(inputDir, root)) {
    throw new Error(`Project root hint "${root}" does not contain input directory "${inputDir}"`);
  }
  return root;
}
function markedProjectRoot(inputDir, io) {
  let current = inputDir;
  let nearestPackageRoot = null;
  while (true) {
    if (WORKSPACE_ROOT_MARKERS.some((marker) => safeExists(join(current, marker), io))) {
      return current;
    }
    if (nearestPackageRoot === null && PACKAGE_ROOT_MARKERS.some((marker) => safeExists(join(current, marker), io))) {
      nearestPackageRoot = current;
    }
    const parent = dirname(current);
    if (parent === current) return nearestPackageRoot;
    current = parent;
  }
}
function projectIdentityKey(source, anchor) {
  const prefix = source === "git-common-dir" ? "git" : "path";
  const digest = createHash("sha256").update(source).update("\0").update(anchor).digest("hex");
  return `${prefix}-${digest}`;
}
async function resolveProject(dir, options = {}) {
  const io = { ...defaultProjectResolverIo, ...options.io };
  const inputDir = canonicalize(dir, io);
  const gitTopLevel = await resolveGitPath(["rev-parse", "--show-toplevel"], inputDir, false, io);
  const gitProjectRoot = gitTopLevel && isWithin(inputDir, gitTopLevel) ? gitTopLevel : null;
  const gitCommonDir = gitProjectRoot ? await resolveGitPath(["rev-parse", "--git-common-dir"], gitProjectRoot, true, io) : null;
  const discovered = discoverConfigs(inputDir, gitProjectRoot, io);
  const config2 = chooseConfig(options.explicitConfigPath, inputDir, discovered, io);
  const configuredRoot = config2.kind === "none" ? null : configProjectRoot(config2, inputDir);
  const inferredRoot = gitProjectRoot || configuredRoot ? null : hintedProjectRoot(options.projectRootHint, inputDir, io) ?? markedProjectRoot(inputDir, io);
  const projectRoot = gitProjectRoot ?? configuredRoot ?? inferredRoot ?? inputDir;
  const identitySource = gitCommonDir ? "git-common-dir" : "canonical-realpath";
  const identityAnchor = gitCommonDir ?? projectRoot;
  return {
    inputDir,
    projectRoot,
    identityKey: projectIdentityKey(identitySource, identityAnchor),
    identitySource,
    identityAnchor,
    config: config2,
    workspaceConfigPath: discovered.workspacePath,
    legacyConfigPath: discovered.legacyPath,
    hasLegacyConfigAtInput: discovered.hasLegacyAtInput
  };
}
var GIT_TIMEOUT_MS, WORKSPACE_ROOT_MARKERS, PACKAGE_ROOT_MARKERS, PROJECT_ROOT_MARKERS, defaultProjectResolverIo;
var init_project_resolver = __esm({
  "packages/daemon/src/lib/project-resolver.ts"() {
    "use strict";
    GIT_TIMEOUT_MS = 2e3;
    WORKSPACE_ROOT_MARKERS = [
      ".tmux-ide",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "yarn.lock",
      "package-lock.json",
      "bun.lock",
      "bun.lockb",
      "uv.lock",
      "go.work",
      "Cargo.lock",
      "settings.gradle",
      "settings.gradle.kts"
    ];
    PACKAGE_ROOT_MARKERS = [
      "deno.json",
      "deno.jsonc",
      "package.json",
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "Gemfile",
      "composer.json",
      "mix.exs",
      "Package.swift",
      "pom.xml"
    ];
    PROJECT_ROOT_MARKERS = [...WORKSPACE_ROOT_MARKERS, ...PACKAGE_ROOT_MARKERS];
    defaultProjectResolverIo = {
      exists: existsSync,
      realpath: realpathSync,
      runGit: (args, cwd) => new Promise((resolveResult) => {
        execFile(
          "git",
          ["-C", cwd, ...args],
          {
            encoding: "utf-8",
            maxBuffer: 64 * 1024,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true
          },
          (error, stdout) => {
            if (error) {
              resolveResult(null);
              return;
            }
            resolveResult(stdout.trim());
          }
        );
      })
    };
  }
});

// packages/daemon/src/lib/workspace-config-loader.ts
import { existsSync as existsSync2, readFileSync, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname2, join as join2 } from "node:path";
import yaml from "js-yaml";
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function defineValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}
function assertAcyclicWorkspaceValue(value, ancestors = /* @__PURE__ */ new Set(), visited = /* @__PURE__ */ new WeakSet(), path2 = []) {
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  const container = value;
  if (ancestors.has(container)) throw new WorkspaceConfigMergeError(path2);
  if (visited.has(container)) return;
  ancestors.add(container);
  if (Array.isArray(value)) {
    for (const [index, nestedValue] of value.entries()) {
      assertAcyclicWorkspaceValue(nestedValue, ancestors, visited, [...path2, index]);
    }
  } else {
    for (const [key, nestedValue] of Object.entries(value)) {
      assertAcyclicWorkspaceValue(nestedValue, ancestors, visited, [...path2, key]);
    }
  }
  ancestors.delete(container);
  visited.add(container);
}
function cloneWorkspaceConfigValue(value) {
  if (Array.isArray(value)) return value.map(cloneWorkspaceConfigValue);
  if (!isPlainObject(value)) return value;
  const clone = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    defineValue(clone, key, cloneWorkspaceConfigValue(nestedValue));
  }
  return clone;
}
function mergeAcyclicWorkspaceConfigValues(base, overlay) {
  if (!isPlainObject(overlay)) return cloneWorkspaceConfigValue(overlay);
  const merged = {};
  if (isPlainObject(base)) {
    for (const [key, baseValue] of Object.entries(base)) {
      defineValue(merged, key, cloneWorkspaceConfigValue(baseValue));
    }
  }
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = isPlainObject(base) ? base[key] : void 0;
    defineValue(merged, key, mergeAcyclicWorkspaceConfigValues(baseValue, overlayValue));
  }
  return merged;
}
function mergeWorkspaceConfigValues(base, overlay) {
  assertAcyclicWorkspaceValue(base);
  assertAcyclicWorkspaceValue(overlay);
  return mergeAcyclicWorkspaceConfigValues(base, overlay);
}
function errorDetail(error) {
  return error instanceof Error ? error.message : String(error);
}
function readText(path2, stage, io) {
  try {
    return io.readFile(path2);
  } catch (cause) {
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_READ_FAILED" : "LOCAL_READ_FAILED",
      stage,
      path: path2,
      message: `Cannot read ${stage} workspace config at ${path2}: ${errorDetail(cause)}`,
      cause
    });
  }
}
function parseMapping(raw, path2, stage) {
  let document;
  try {
    document = yaml.load(raw);
  } catch (cause) {
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_YAML_INVALID" : "LOCAL_YAML_INVALID",
      stage,
      path: path2,
      message: `Invalid YAML in ${stage} workspace config at ${path2}: ${errorDetail(cause)}`,
      cause
    });
  }
  if (!isPlainObject(document)) {
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_NOT_MAPPING" : "LOCAL_NOT_MAPPING",
      stage,
      path: path2,
      message: `The ${stage} workspace config at ${path2} must contain a YAML mapping`
    });
  }
  try {
    assertAcyclicWorkspaceValue(document);
  } catch (cause) {
    if (!(cause instanceof WorkspaceConfigMergeError)) throw cause;
    throw new WorkspaceConfigLoadError({
      code: stage === "base" ? "BASE_CYCLIC_REFERENCE" : "LOCAL_CYCLIC_REFERENCE",
      stage,
      path: path2,
      message: `The ${stage} workspace config at ${path2} contains a recursive YAML alias at ${cause.path.join(".") || "<root>"}`,
      cause
    });
  }
  return document;
}
function assertBaseVersion(document, path2) {
  if (document.version !== 1) {
    throw new WorkspaceConfigLoadError({
      code: "BASE_VERSION_INVALID",
      stage: "base",
      path: path2,
      message: `The base workspace config at ${path2} must declare version: 1`
    });
  }
}
function assertLocalVersion(document, path2) {
  if (Object.hasOwn(document, "version") && document.version !== 1) {
    throw new WorkspaceConfigLoadError({
      code: "LOCAL_VERSION_INVALID",
      stage: "local",
      path: path2,
      message: `The local workspace config at ${path2} cannot change version from 1`
    });
  }
}
function safeExists2(path2, io) {
  try {
    return io.exists(path2);
  } catch {
    return false;
  }
}
function canonicalizeExisting(path2, io) {
  try {
    return io.realpath(path2);
  } catch {
    return path2;
  }
}
function validationIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => typeof part === "symbol" ? part.toString() : part),
    code: issue.code,
    message: issue.message
  }));
}
async function loadWorkspaceConfig(dir, options = {}) {
  const io = { ...defaultLoaderIo, ...options.io };
  let resolution;
  try {
    resolution = await io.resolveProject(dir, {
      explicitConfigPath: options.explicitConfigPath,
      io: options.resolverIo
    });
  } catch (cause) {
    throw new WorkspaceConfigLoadError({
      code: "RESOLUTION_FAILED",
      stage: "resolution",
      message: `Cannot resolve a workspace config for ${dir}: ${errorDetail(cause)}`,
      cause
    });
  }
  if (resolution.config.kind !== "workspace") {
    const message = resolution.config.kind === "legacy" ? `Found legacy config at ${resolution.config.path}; this loader requires .tmux-ide/workspace.yml` : `No .tmux-ide/workspace.yml config was found for ${resolution.inputDir}`;
    throw new WorkspaceConfigLoadError({
      code: "WORKSPACE_CONFIG_REQUIRED",
      stage: "resolution",
      path: resolution.config.path,
      message
    });
  }
  const basePath = resolution.config.path;
  const baseDocument = parseMapping(readText(basePath, "base", io), basePath, "base");
  assertBaseVersion(baseDocument, basePath);
  const localCandidate = join2(dirname2(basePath), "workspace.local.yml");
  let localPath = null;
  let effectiveValue = cloneWorkspaceConfigValue(baseDocument);
  if (safeExists2(localCandidate, io)) {
    localPath = canonicalizeExisting(localCandidate, io);
    const localDocument = parseMapping(readText(localPath, "local", io), localPath, "local");
    assertLocalVersion(localDocument, localPath);
    effectiveValue = mergeWorkspaceConfigValues(baseDocument, localDocument);
  }
  const validated = WorkspaceConfigV1SchemaZ.safeParse(effectiveValue);
  if (!validated.success) {
    const issues2 = validationIssues(validated.error);
    throw new WorkspaceConfigLoadError({
      code: "FINAL_VALIDATION_FAILED",
      stage: "validation",
      path: basePath,
      issues: issues2,
      message: `Effective workspace config is invalid: ${issues2.slice(0, 3).map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`
    });
  }
  return {
    config: validated.data,
    source: { basePath, localPath, resolution }
  };
}
var WorkspaceConfigLoadError, WorkspaceConfigMergeError, defaultLoaderIo;
var init_workspace_config_loader = __esm({
  "packages/daemon/src/lib/workspace-config-loader.ts"() {
    "use strict";
    init_src();
    init_project_resolver();
    WorkspaceConfigLoadError = class extends Error {
      code;
      stage;
      path;
      issues;
      constructor(input) {
        super(input.message, input.cause === void 0 ? void 0 : { cause: input.cause });
        this.name = "WorkspaceConfigLoadError";
        this.code = input.code;
        this.stage = input.stage;
        this.path = input.path ?? null;
        this.issues = input.issues ?? [];
      }
    };
    WorkspaceConfigMergeError = class extends Error {
      code = "CYCLIC_VALUE";
      path;
      constructor(path2) {
        const location = path2.length > 0 ? path2.join(".") : "<root>";
        super(`Workspace config value contains a cyclic reference at ${location}`);
        this.name = "WorkspaceConfigMergeError";
        this.path = [...path2];
      }
    };
    defaultLoaderIo = {
      exists: existsSync2,
      readFile: (path2) => readFileSync(path2, "utf-8"),
      realpath: realpathSync2,
      resolveProject
    };
  }
});

// packages/tmux-bridge/src/errors.ts
var TmuxError;
var init_errors = __esm({
  "packages/tmux-bridge/src/errors.ts"() {
    "use strict";
    TmuxError = class extends Error {
      code;
      exitCode;
      constructor(message, code, options = {}) {
        super(message, { cause: options.cause });
        this.name = "TmuxError";
        this.code = code;
        this.exitCode = options.exitCode ?? 1;
      }
      toJSON() {
        const out = {
          error: this.message,
          code: this.code
        };
        if (this.cause) out.cause = this.cause.message;
        return out;
      }
    };
  }
});

// packages/tmux-bridge/src/runner.ts
import { execFileSync, spawn } from "node:child_process";
function _setExecutor(fn) {
  const prev = _executor;
  _executor = fn;
  return () => {
    _executor = prev;
  };
}
function _setSpawner(fn) {
  const prev = _spawner;
  _spawner = fn;
  return () => {
    _spawner = prev;
  };
}
function _getSpawner() {
  return _spawner;
}
function runTmux(args, options = {}) {
  if (DEBUG || globalThis.__tmuxIdeVerbose) {
    console.error(`  [tmux] ${args.join(" ")}`);
  }
  const execOptions = {
    stdio: ["ignore", "pipe", "pipe"],
    ...options
  };
  try {
    return _executor("tmux", args, execOptions);
  } catch (error) {
    throw classifyTmuxError(error);
  }
}
function classifyTmuxError(error) {
  const detail = getErrorDetail(error).toLowerCase();
  if (SESSION_NOT_FOUND_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux session was not found", "SESSION_NOT_FOUND", {
      cause: error
    });
  }
  if (TMUX_UNAVAILABLE_PATTERNS.some((pattern) => detail.includes(pattern))) {
    return new TmuxError("tmux is unavailable or its socket is inaccessible", "TMUX_UNAVAILABLE", {
      cause: error
    });
  }
  return new TmuxError("tmux command failed", "TMUX_ERROR", {
    cause: error
  });
}
function getErrorDetail(error) {
  const stderr = error?.stderr;
  if (typeof stderr === "string" && stderr.length > 0) return stderr;
  if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString("utf-8");
  return error?.message ?? "";
}
var DEBUG, SESSION_NOT_FOUND_PATTERNS, TMUX_UNAVAILABLE_PATTERNS, _executor, _spawner;
var init_runner = __esm({
  "packages/tmux-bridge/src/runner.ts"() {
    "use strict";
    init_errors();
    DEBUG = process.env.TMUX_IDE_DEBUG === "1";
    SESSION_NOT_FOUND_PATTERNS = ["can't find session", "can't find window", "unknown target"];
    TMUX_UNAVAILABLE_PATTERNS = [
      "failed to connect to server",
      "no server running",
      "error connecting to",
      "connection refused"
    ];
    _executor = execFileSync;
    _spawner = spawn;
  }
});

// packages/tmux-bridge/src/sessions.ts
function getSessionState(session) {
  try {
    runTmux(["has-session", "-t", session]);
    return { running: true, reason: null };
  } catch (error) {
    if (error instanceof TmuxError) {
      if (error.code === "SESSION_NOT_FOUND") {
        return { running: false, reason: "SESSION_NOT_FOUND" };
      }
      if (error.code === "TMUX_UNAVAILABLE") {
        return { running: false, reason: "TMUX_UNAVAILABLE" };
      }
    }
    throw error;
  }
}
function attachSession(session) {
  runTmux(["attach", "-t", session], { stdio: "inherit" });
}
function hasSession(session) {
  try {
    runTmux(["has-session", "-t", session]);
    return true;
  } catch (error) {
    if (error instanceof TmuxError && (error.code === "SESSION_NOT_FOUND" || error.code === "TMUX_UNAVAILABLE")) {
      return false;
    }
    throw error;
  }
}
function getSessionCwd(session) {
  try {
    const raw = runTmux(["display-message", "-p", "-t", session, "#{pane_current_path}"], {
      encoding: "utf-8"
    });
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
function killSession(session) {
  try {
    runTmux(["kill-session", "-t", session]);
    return { stopped: true, reason: null };
  } catch (error) {
    if (error instanceof TmuxError) {
      if (error.code === "SESSION_NOT_FOUND") {
        return { stopped: false, reason: "SESSION_NOT_FOUND" };
      }
      if (error.code === "TMUX_UNAVAILABLE") {
        return { stopped: false, reason: "TMUX_UNAVAILABLE" };
      }
    }
    throw error;
  }
}
function createDetachedSession(session, cwd, { cols, lines } = {}) {
  return runTmux(
    [
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-s",
      session,
      "-c",
      cwd,
      "-x",
      String(cols ?? 200),
      "-y",
      String(lines ?? 50)
    ],
    { encoding: "utf-8" }
  ).trim();
}
function setSessionEnvironment(session, key, value) {
  runTmux(["set-environment", "-t", session, key, String(value)]);
}
function getSessionVariable(session, name) {
  try {
    const raw = runTmux(["show-option", "-qvt", session, name], {
      encoding: "utf-8"
    });
    return raw.trim() || null;
  } catch {
    return null;
  }
}
function setSessionVariable(session, name, value) {
  runTmux(["set-option", "-t", session, name, value]);
}
function runSessionCommand(args) {
  runTmux(args, { stdio: "inherit" });
}
var init_sessions = __esm({
  "packages/tmux-bridge/src/sessions.ts"() {
    "use strict";
    init_errors();
    init_runner();
  }
});

// packages/tmux-bridge/src/panes.ts
function listPanes(session) {
  const raw = runTmux(
    [
      "list-panes",
      "-t",
      session,
      "-F",
      "#{pane_index}|#{pane_title}|#{pane_width}|#{pane_height}|#{pane_active}"
    ],
    { encoding: "utf-8" }
  ).trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [index, title, width, height, active2] = line.split("|");
    return {
      index: Number.parseInt(index, 10),
      title,
      width: Number.parseInt(width, 10),
      height: Number.parseInt(height, 10),
      active: active2 === "1"
    };
  });
}
function splitPane(targetPane, direction, cwd, percent) {
  return runTmux(
    [
      "split-window",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      targetPane,
      direction === "vertical" ? "-v" : "-h",
      "-c",
      cwd,
      "-p",
      String(percent)
    ],
    { encoding: "utf-8" }
  ).trim();
}
function sendLiteral(targetPane, text) {
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
}
function sendKeys(targetPane, text, options = {}) {
  const { enter = true } = options;
  runTmux(["send-keys", "-t", targetPane, "-l", "--", text], { stdio: "inherit" });
  if (enter) {
    runTmux(["send-keys", "-t", targetPane, "Enter"], { stdio: "inherit" });
  }
}
function capturePane(targetPane, options = {}) {
  const args = ["capture-pane", "-t", targetPane, "-p", "-J"];
  if (typeof options.scrollback === "number") {
    args.push("-S", `-${options.scrollback}`);
  } else if (typeof options.lines === "number") {
    args.push("-S", `-${options.lines}`);
  }
  return runTmux(args, { encoding: "utf-8" }).replace(/\n+$/, "");
}
function captureRecent(targetPane, lines = 50) {
  return capturePane(targetPane, { lines });
}
function getPaneCurrentCommand(targetPane) {
  return runTmux(["display-message", "-p", "-t", targetPane, "#{pane_current_command}"], {
    encoding: "utf-8"
  }).trim();
}
function selectPane(targetPane) {
  runTmux(["select-pane", "-t", targetPane], { stdio: "inherit" });
}
function setPaneTitle(targetPane, title) {
  runTmux(["select-pane", "-t", targetPane, "-T", title], { stdio: "inherit" });
}
function setPaneOption(targetPane, option, value) {
  runTmux(["set-option", "-pqt", targetPane, option, value]);
}
var init_panes = __esm({
  "packages/tmux-bridge/src/panes.ts"() {
    "use strict";
    init_runner();
  }
});

// packages/tmux-bridge/src/monitor.ts
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function startSessionMonitor(session, monitorScript, port) {
  try {
    const existingPid = runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
      encoding: "utf-8"
    }).trim();
    if (existingPid) {
      const pid = parseInt(existingPid, 10);
      if (isProcessAlive(pid)) {
        stopSessionMonitor(session);
        let attempts = 0;
        while (isProcessAlive(pid) && attempts < 10) {
          const { Atomics: Atomics2, SharedArrayBuffer: SharedArrayBuffer2 } = globalThis;
          Atomics2.wait(new Int32Array(new SharedArrayBuffer2(4)), 0, 0, 100);
          attempts++;
        }
      }
    }
  } catch {
  }
  const child = _getSpawner()("tsx", [monitorScript, session, String(port ?? 0)], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd()
  });
  child.unref();
  runTmux(["set-option", "-t", session, "@monitor_pid", String(child.pid)]);
}
function stopSessionMonitor(session) {
  try {
    const pid = runTmux(["show-option", "-qvt", session, "@monitor_pid"], {
      encoding: "utf-8"
    }).trim();
    if (pid) {
      const numPid = parseInt(pid, 10);
      try {
        process.kill(-numPid, "SIGTERM");
      } catch {
        try {
          process.kill(numPid, "SIGTERM");
        } catch {
        }
      }
    }
  } catch {
  }
}
var init_monitor = __esm({
  "packages/tmux-bridge/src/monitor.ts"() {
    "use strict";
    init_runner();
  }
});

// packages/tmux-bridge/src/targeting.ts
function resolveTarget(panes, target, session) {
  switch (target.kind) {
    case "byId": {
      if (target.id.startsWith("%")) {
        return {
          target: target.id,
          pane: panes[0] ?? {
            index: -1,
            title: void 0,
            width: 0,
            height: 0,
            active: false
          }
        };
      }
      const numeric = Number.parseInt(target.id, 10);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid pane id: ${target.id}`);
      }
      const found = panes.find((p) => p.index === numeric);
      if (!found) {
        throw new Error(`Pane not found by id: ${target.id}`);
      }
      return { target: paneTarget(session, found.index), pane: found };
    }
    case "byIndex": {
      const found = panes.find((p) => p.index === target.index);
      if (!found) {
        throw new Error(`Pane not found by index: ${target.index}`);
      }
      return { target: paneTarget(session, found.index), pane: found };
    }
    case "byTitle": {
      const matches = panes.filter((p) => p.title === target.title);
      if (matches.length === 0) {
        throw new Error(`Pane not found by title: ${target.title}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous pane title "${target.title}" matches ${matches.length} panes`);
      }
      return {
        target: paneTarget(session, matches[0].index),
        pane: matches[0]
      };
    }
    case "byRole":
      throw new Error(
        `byRole targets must be resolved at the daemon layer before reaching the bridge (got role="${target.role}")`
      );
  }
}
function paneTarget(session, index) {
  return session ? `${session}.${index}` : String(index);
}
var init_targeting = __esm({
  "packages/tmux-bridge/src/targeting.ts"() {
    "use strict";
  }
});

// packages/tmux-bridge/src/index.ts
var src_exports = {};
__export(src_exports, {
  TmuxError: () => TmuxError,
  _getSpawner: () => _getSpawner,
  _setExecutor: () => _setExecutor,
  _setSpawner: () => _setSpawner,
  attachSession: () => attachSession,
  capturePane: () => capturePane,
  captureRecent: () => captureRecent,
  createDetachedSession: () => createDetachedSession,
  getPaneCurrentCommand: () => getPaneCurrentCommand,
  getSessionCwd: () => getSessionCwd,
  getSessionState: () => getSessionState,
  getSessionVariable: () => getSessionVariable,
  hasSession: () => hasSession,
  isProcessAlive: () => isProcessAlive,
  killSession: () => killSession,
  listPanes: () => listPanes,
  resolveTarget: () => resolveTarget,
  runSessionCommand: () => runSessionCommand,
  runTmux: () => runTmux,
  selectPane: () => selectPane,
  sendKeys: () => sendKeys,
  sendLiteral: () => sendLiteral,
  setPaneOption: () => setPaneOption,
  setPaneTitle: () => setPaneTitle,
  setSessionEnvironment: () => setSessionEnvironment,
  setSessionVariable: () => setSessionVariable,
  splitPane: () => splitPane,
  startSessionMonitor: () => startSessionMonitor,
  stopSessionMonitor: () => stopSessionMonitor
});
var init_src2 = __esm({
  "packages/tmux-bridge/src/index.ts"() {
    "use strict";
    init_errors();
    init_runner();
    init_sessions();
    init_panes();
    init_monitor();
    init_targeting();
  }
});

// packages/daemon/src/lib/errors.ts
var IdeError, ConfigError, DaemonStartupError, DaemonShutdownError;
var init_errors2 = __esm({
  "packages/daemon/src/lib/errors.ts"() {
    "use strict";
    init_src2();
    IdeError = class extends Error {
      code;
      exitCode;
      constructor(message, { code, exitCode = 1, cause } = {}) {
        super(message, { cause });
        this.name = "IdeError";
        this.code = code;
        this.exitCode = exitCode;
      }
      toJSON() {
        const obj = {
          error: this.message,
          code: this.code
        };
        if (this.cause) obj.cause = this.cause.message;
        return obj;
      }
    };
    ConfigError = class extends IdeError {
      constructor(message, code, { cause } = {}) {
        super(message, { code, exitCode: 1, cause });
        this.name = "ConfigError";
      }
    };
    DaemonStartupError = class extends IdeError {
      reason;
      constructor(message, reason, { cause } = {}) {
        super(message, { code: `DAEMON_${reason.toUpperCase()}`, exitCode: 1, cause });
        this.name = "DaemonStartupError";
        this.reason = reason;
      }
    };
    DaemonShutdownError = class extends IdeError {
      constructor(message, { cause } = {}) {
        super(message, { code: "DAEMON_SHUTDOWN_FAILED", exitCode: 1, cause });
        this.name = "DaemonShutdownError";
      }
    };
  }
});

// packages/daemon/src/schemas/ide-config.ts
var init_ide_config2 = __esm({
  "packages/daemon/src/schemas/ide-config.ts"() {
    "use strict";
    init_src();
  }
});

// packages/daemon/src/lib/legacy-config-adapter.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import { resolve as resolve2 } from "node:path";
import yaml2 from "js-yaml";
function legacyConfigPath(dir) {
  return resolve2(dir, "ide.yml");
}
function hasLegacyConfigAt(dir) {
  return existsSync3(legacyConfigPath(dir));
}
function readLegacyConfigFile(path2) {
  const raw = readFileSync2(path2, "utf-8");
  return { raw, config: IdeConfigSchema.parse(yaml2.load(raw)) };
}
function readLegacyConfigAt(dir) {
  const configPath = legacyConfigPath(dir);
  const { raw, config: config2 } = readLegacyConfigFile(configPath);
  return { config: config2, configPath, raw };
}
var init_legacy_config_adapter = __esm({
  "packages/daemon/src/lib/legacy-config-adapter.ts"() {
    "use strict";
    init_ide_config2();
  }
});

// packages/daemon/src/lib/legacy-config-migration.ts
import yaml3 from "js-yaml";
function pushDiagnostic(diagnostics, code, path2, message) {
  diagnostics.push({ code, path: path2, message });
}
function cloneTerminalPane(pane) {
  const result = {};
  if (pane.id !== void 0) result.id = pane.id;
  if (pane.title !== void 0) result.title = pane.title;
  if (pane.command !== void 0) result.command = pane.command;
  if (pane.type !== void 0) result.type = pane.type;
  if (pane.target !== void 0) result.target = pane.target;
  if (pane.dir !== void 0) result.dir = pane.dir;
  if (pane.size !== void 0) result.size = pane.size;
  if (pane.focus !== void 0) result.focus = pane.focus;
  if (pane.env !== void 0) {
    result.env = { ...pane.env };
  }
  return result;
}
function convertLegacyConfigToWorkspace(legacy) {
  const diagnostics = [];
  const rows = legacy.rows.map((row, rowIndex) => ({
    ...row.size === void 0 ? {} : { size: row.size },
    panes: row.panes.map((pane, paneIndex) => {
      for (const [key, code, message] of PANE_UNSUPPORTED) {
        if (pane[key] !== void 0) {
          pushDiagnostic(diagnostics, code, `rows.${rowIndex}.panes.${paneIndex}.${key}`, message);
        }
      }
      return cloneTerminalPane(pane);
    })
  }));
  for (const [key, code, message] of ROOT_UNSUPPORTED) {
    if (legacy[key] !== void 0) pushDiagnostic(diagnostics, code, String(key), message);
  }
  const candidate = {
    version: 1,
    ...legacy.name === void 0 ? {} : { name: legacy.name },
    ...legacy.before === void 0 ? {} : { before: legacy.before },
    terminal: {
      rows,
      ...legacy.theme === void 0 ? {} : { theme: { ...legacy.theme } }
    },
    app: {
      views: [
        { id: "home", title: "Home", panel: "home" },
        { id: "terminals", title: "Terminals", panel: "terminals" },
        { id: "files", title: "Files", panel: "files" },
        { id: "diff", title: "Diff", panel: "diff" },
        { id: "missions", title: "Missions", panel: "missions" }
      ]
    }
  };
  const parsed = WorkspaceConfigV1SchemaZ.parse(candidate);
  return { workspace: parsed, diagnostics };
}
function workspaceConfigToLegacyProjection(workspace) {
  return {
    ...workspace.name === void 0 ? {} : { name: workspace.name },
    ...workspace.before === void 0 ? {} : { before: workspace.before },
    rows: (workspace.terminal?.rows ?? [{ panes: [{ title: "Shell" }] }]).map((row) => ({
      ...row.size === void 0 ? {} : { size: row.size },
      panes: row.panes.map((pane) => ({
        ...pane.id === void 0 ? {} : { id: pane.id },
        ...pane.title === void 0 ? {} : { title: pane.title },
        ...pane.command === void 0 ? {} : { command: pane.command },
        ...pane.type === void 0 ? {} : { type: pane.type },
        ...pane.target === void 0 ? {} : { target: pane.target },
        ...pane.dir === void 0 ? {} : { dir: pane.dir },
        ...pane.size === void 0 ? {} : { size: pane.size },
        ...pane.focus === void 0 ? {} : { focus: pane.focus },
        ...pane.env === void 0 ? {} : { env: { ...pane.env } }
      }))
    })),
    ...workspace.terminal?.theme === void 0 ? {} : { theme: { ...workspace.terminal.theme } }
  };
}
function workspaceConfigToYaml(workspace) {
  return yaml3.dump(workspace, { lineWidth: -1, noRefs: true, quotingType: '"' });
}
var ROOT_UNSUPPORTED, PANE_UNSUPPORTED;
var init_legacy_config_migration = __esm({
  "packages/daemon/src/lib/legacy-config-migration.ts"() {
    "use strict";
    init_src();
    ROOT_UNSUPPORTED = [
      ["team", "UNSUPPORTED_TEAM", "agent team metadata is compatibility-only in ide.yml"],
      [
        "orchestrator",
        "UNSUPPORTED_ORCHESTRATOR",
        "retired orchestrator settings are not WorkspaceConfigV1"
      ],
      ["command_center", "UNSUPPORTED_COMMAND_CENTER", "command-center settings are runtime state"],
      ["dashboard", "UNSUPPORTED_DASHBOARD", "dashboard settings are retired"],
      ["auth", "UNSUPPORTED_AUTH", "auth settings are not part of WorkspaceConfigV1"],
      ["tunnel", "UNSUPPORTED_TUNNEL", "tunnel settings are not part of WorkspaceConfigV1"],
      ["hq", "UNSUPPORTED_HQ", "HQ settings are not part of WorkspaceConfigV1"],
      ["sidebar", "UNSUPPORTED_SIDEBAR", "sidebar sugar is not part of WorkspaceConfigV1"]
    ];
    PANE_UNSUPPORTED = [
      ["role", "UNSUPPORTED_PANE_ROLE", "agent pane role metadata is not migrated"],
      ["task", "UNSUPPORTED_PANE_TASK", "agent pane task metadata is not migrated"],
      ["specialty", "UNSUPPORTED_PANE_SPECIALTY", "agent pane specialty metadata is not migrated"],
      ["skill", "UNSUPPORTED_PANE_SKILL", "agent pane skill metadata is not migrated"]
    ];
  }
});

// packages/daemon/src/lib/resolved-config.ts
var resolved_config_exports = {};
__export(resolved_config_exports, {
  UnsupportedLegacyConfigMutationError: () => UnsupportedLegacyConfigMutationError,
  WorkspaceConfigWriteError: () => WorkspaceConfigWriteError,
  canonicalConfigPath: () => canonicalConfigPath,
  createWorkspaceConfig: () => createWorkspaceConfig,
  getSessionNameCompatSync: () => getSessionNameCompatSync,
  hasLaunchConfig: () => hasLaunchConfig,
  hasLegacyConfig: () => hasLegacyConfig,
  hasWorkspaceConfig: () => hasWorkspaceConfig,
  readConfigCompatSync: () => readConfigCompatSync,
  resolveConfig: () => resolveConfig,
  workspaceConfigPath: () => workspaceConfigPath,
  workspaceLocalConfigPath: () => workspaceLocalConfigPath,
  writeLaunchProjectionConfig: () => writeLaunchProjectionConfig,
  writeWorkspaceConfig: () => writeWorkspaceConfig
});
import {
  existsSync as existsSync4,
  linkSync,
  mkdirSync,
  readFileSync as readFileSync3,
  realpathSync as realpathSync3,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename as basename2, dirname as dirname3, join as join3, resolve as resolve3 } from "node:path";
import yaml4 from "js-yaml";
function loadedWorkspaceToResolved(loaded) {
  const launchConfig = workspaceConfigToLegacyProjection(loaded.config);
  return {
    kind: "workspace",
    path: loaded.source.basePath,
    localPath: loaded.source.localPath,
    provenance: loaded.source.resolution.config.explicit ? "explicit" : "workspace",
    resolution: loaded.source.resolution,
    workspace: loaded.config,
    legacy: null,
    launchConfig,
    diagnostics: [],
    migrationHint: null
  };
}
function configReadError(message, cause) {
  return new ConfigError(message, "READ_ERROR", {
    cause: cause instanceof Error ? cause : new Error(String(cause))
  });
}
function configInvalidError(message, cause) {
  return new ConfigError(message, "INVALID_CONFIG", {
    cause: cause instanceof Error ? cause : new Error(String(cause))
  });
}
function mapWorkspaceLoadError(error) {
  if (error.code.endsWith("_READ_FAILED") || error.code === "RESOLUTION_FAILED") {
    return configReadError(error.message, error);
  }
  return configInvalidError(error.message, error);
}
function readLegacyConfigForResolution(path2) {
  try {
    return readLegacyConfigFile(path2);
  } catch (cause) {
    const name = cause.name;
    if (name === "YAMLException") {
      throw configInvalidError(
        `Invalid legacy ide.yml YAML at ${path2}: ${cause.message}. Run "tmux-ide validate" for details.`,
        cause
      );
    }
    if (name === "ZodError") {
      throw configInvalidError(
        `Invalid legacy ide.yml at ${path2}: ${cause.message}. Run "tmux-ide validate" for details.`,
        cause
      );
    }
    throw configReadError(
      `Cannot read legacy ide.yml at ${path2}: ${cause.message}`,
      cause
    );
  }
}
async function resolveConfig(dir, options = {}) {
  const resolution = await resolveProject(dir, {
    explicitConfigPath: options.explicitConfigPath ?? options.resolveOptions?.explicitConfigPath,
    projectRootHint: options.resolveOptions?.projectRootHint,
    io: options.resolverIo ?? options.resolveOptions?.io
  });
  if (resolution.config.kind === "workspace") {
    let loaded;
    try {
      loaded = await loadWorkspaceConfig(dir, {
        explicitConfigPath: resolution.config.explicit ? resolution.config.path : null,
        resolverIo: options.resolverIo ?? options.resolveOptions?.io,
        io: options.io
      });
    } catch (error) {
      if (error instanceof WorkspaceConfigLoadError) throw mapWorkspaceLoadError(error);
      throw error;
    }
    return loadedWorkspaceToResolved(loaded);
  }
  if (resolution.config.kind === "legacy") {
    const { config: legacy } = readLegacyConfigForResolution(resolution.config.path);
    const migration = convertLegacyConfigToWorkspace(legacy);
    return {
      kind: "legacy",
      path: resolution.config.path,
      localPath: null,
      provenance: resolution.config.explicit ? "explicit" : "legacy",
      resolution,
      workspace: migration.workspace,
      legacy,
      launchConfig: legacy,
      diagnostics: migration.diagnostics,
      migrationHint: "Legacy ide.yml is supported for compatibility. Run `tmux-ide migrate --dry-run` to preview .tmux-ide/workspace.yml."
    };
  }
  return {
    kind: "none",
    path: null,
    localPath: null,
    provenance: "none",
    resolution,
    workspace: null,
    legacy: null,
    launchConfig: null,
    diagnostics: [],
    migrationHint: null
  };
}
function workspaceConfigPath(dir) {
  return resolve3(dir, ".tmux-ide", "workspace.yml");
}
function workspaceLocalConfigPath(dir) {
  return resolve3(dir, ".tmux-ide", "workspace.local.yml");
}
function writeWorkspaceConfig(dir, workspace) {
  const parsed = WorkspaceConfigV1SchemaZ.parse(workspace);
  const configPath = workspaceConfigPath(dir);
  const configDir = dirname3(configPath);
  const tempPath = join3(
    configDir,
    `.workspace.yml.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(tempPath, workspaceConfigToYaml(parsed), { encoding: "utf-8", flag: "wx" });
    renameSync(tempPath, configPath);
  } catch (cause) {
    try {
      unlinkSync(tempPath);
    } catch {
    }
    throw new WorkspaceConfigWriteError(
      `Failed to write workspace config at ${configPath}`,
      "WORKSPACE_WRITE_FAILED",
      configPath,
      cause
    );
  }
  return configPath;
}
function createWorkspaceConfig(dir, workspace) {
  const parsed = WorkspaceConfigV1SchemaZ.parse(workspace);
  const configPath = workspaceConfigPath(dir);
  const configDir = dirname3(configPath);
  const tempPath = join3(
    configDir,
    `.workspace.yml.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(tempPath, workspaceConfigToYaml(parsed), { encoding: "utf-8", flag: "wx" });
    linkSync(tempPath, configPath);
    unlinkSync(tempPath);
  } catch (cause) {
    try {
      unlinkSync(tempPath);
    } catch {
    }
    if (cause?.code === "EEXIST" && existsSync4(configPath)) {
      throw new WorkspaceConfigWriteError(
        `Workspace config already exists at ${configPath}`,
        "CONFIG_EXISTS",
        configPath,
        cause
      );
    }
    throw new WorkspaceConfigWriteError(
      `Failed to create workspace config at ${configPath}`,
      "WORKSPACE_WRITE_FAILED",
      configPath,
      cause
    );
  }
  return configPath;
}
function readWorkspaceBaseConfig(dir) {
  const workspacePath = workspaceConfigPath(dir);
  if (!existsSync4(workspacePath)) return null;
  return WorkspaceConfigV1SchemaZ.parse(yaml4.load(readFileSync3(workspacePath, "utf-8")));
}
function unsupportedOutputDiagnostics(config2) {
  const diagnostics = [];
  for (const key of Object.keys(config2)) {
    if (!LAUNCH_CONFIG_KEYS.has(key)) {
      diagnostics.push({
        code: "UNSUPPORTED_UNKNOWN_FIELD",
        path: key,
        message: "unknown top-level config field cannot be represented in WorkspaceConfigV1"
      });
    }
  }
  config2.rows?.forEach((row, rowIndex) => {
    for (const key of Object.keys(row)) {
      if (!ROW_KEYS.has(key)) {
        diagnostics.push({
          code: "UNSUPPORTED_UNKNOWN_FIELD",
          path: `rows.${rowIndex}.${key}`,
          message: "unknown row config field cannot be represented in WorkspaceConfigV1"
        });
      }
    }
    row.panes?.forEach((pane, paneIndex) => {
      for (const key of Object.keys(pane)) {
        if (!PANE_KEYS.has(key)) {
          diagnostics.push({
            code: "UNSUPPORTED_UNKNOWN_FIELD",
            path: `rows.${rowIndex}.panes.${paneIndex}.${key}`,
            message: "unknown pane config field cannot be represented in WorkspaceConfigV1"
          });
        }
      }
    });
  });
  return diagnostics;
}
function writeLaunchProjectionConfig(dir, config2) {
  const converted = convertLegacyConfigToWorkspace(config2);
  const unsupportedOutput = unsupportedOutputDiagnostics(config2);
  const existing = readWorkspaceBaseConfig(dir);
  if (!existing && hasLegacyConfig(dir)) {
    const legacy = readLegacyConfigAt(dir).config;
    const legacyDiagnostics = convertLegacyConfigToWorkspace(legacy).diagnostics;
    if (legacyDiagnostics.length > 0) {
      throw new UnsupportedLegacyConfigMutationError(legacyDiagnostics);
    }
  }
  if (unsupportedOutput.length > 0 || converted.diagnostics.length > 0) {
    throw new UnsupportedLegacyConfigMutationError(
      [...unsupportedOutput, ...converted.diagnostics],
      existing ? "Config mutation introduced legacy-only fields that cannot be represented in WorkspaceConfigV1." : "New workspace config contains legacy-only fields that cannot be represented in WorkspaceConfigV1."
    );
  }
  if (!existing) return writeWorkspaceConfig(dir, converted.workspace);
  return writeWorkspaceConfig(dir, {
    ...existing,
    ...converted.workspace.name === void 0 ? { name: void 0 } : { name: converted.workspace.name },
    ...converted.workspace.before === void 0 ? { before: void 0 } : { before: converted.workspace.before },
    terminal: converted.workspace.terminal
  });
}
function readConfigCompatSync(dir) {
  const workspacePath = workspaceConfigPath(dir);
  if (existsSync4(workspacePath)) {
    const parsed = WorkspaceConfigV1SchemaZ.parse(yaml4.load(readFileSync3(workspacePath, "utf-8")));
    return { config: workspaceConfigToLegacyProjection(parsed), configPath: workspacePath };
  }
  const { config: config2, configPath } = readLegacyConfigAtCompat(dir);
  return { config: config2, configPath };
}
function getSessionNameCompatSync(dir) {
  try {
    const { config: config2 } = readConfigCompatSync(dir);
    return { name: config2.name ?? basename2(dir), source: config2.name ? "config" : "fallback" };
  } catch {
    return { name: basename2(dir), source: "fallback" };
  }
}
function hasWorkspaceConfig(dir) {
  return existsSync4(workspaceConfigPath(dir));
}
function hasLegacyConfig(dir) {
  return hasLegacyConfigAt(dir);
}
function hasLaunchConfig(dir) {
  return hasWorkspaceConfig(dir) || hasLegacyConfig(dir);
}
function canonicalConfigPath(path2) {
  try {
    return realpathSync3(path2);
  } catch {
    return path2;
  }
}
function readLegacyConfigAtCompat(dir) {
  const configPath = legacyConfigPath(dir);
  const { config: config2 } = readLegacyConfigFile(configPath);
  return { config: config2, configPath };
}
var WorkspaceConfigWriteError, UnsupportedLegacyConfigMutationError, LAUNCH_CONFIG_KEYS, ROW_KEYS, PANE_KEYS;
var init_resolved_config = __esm({
  "packages/daemon/src/lib/resolved-config.ts"() {
    "use strict";
    init_src();
    init_workspace_config_loader();
    init_errors2();
    init_project_resolver();
    init_legacy_config_adapter();
    init_legacy_config_migration();
    WorkspaceConfigWriteError = class extends IdeError {
      path;
      constructor(message, code, path2, cause) {
        super(message, {
          code,
          exitCode: 1,
          cause: cause instanceof Error ? cause : cause === void 0 ? void 0 : new Error(String(cause))
        });
        this.name = "WorkspaceConfigWriteError";
        this.path = path2;
      }
    };
    UnsupportedLegacyConfigMutationError = class extends IdeError {
      constructor(diagnostics, message = `Legacy ide.yml contains unsupported fields that would be dropped by config mutation. Run \`tmux-ide migrate --dry-run\` and move to .tmux-ide/workspace.yml first.`) {
        super(message, { code: "LEGACY_CONFIG_MUTATION_UNSUPPORTED", exitCode: 1 });
        this.diagnostics = diagnostics;
        this.name = "UnsupportedLegacyConfigMutationError";
      }
    };
    LAUNCH_CONFIG_KEYS = /* @__PURE__ */ new Set([
      "name",
      "before",
      "rows",
      "theme",
      "team",
      "orchestrator",
      "command_center",
      "dashboard",
      "auth",
      "tunnel",
      "hq",
      "sidebar"
    ]);
    ROW_KEYS = /* @__PURE__ */ new Set(["size", "panes"]);
    PANE_KEYS = /* @__PURE__ */ new Set([
      "id",
      "title",
      "command",
      "type",
      "target",
      "dir",
      "size",
      "focus",
      "env",
      "role",
      "task",
      "specialty",
      "skill"
    ]);
  }
});

// packages/daemon/src/lib/config-context.ts
import { basename as basename3, dirname as dirname4, resolve as resolve4 } from "node:path";
function configWriteRootForResolved(resolved2, projectRoot) {
  if (!resolved2.path) return projectRoot;
  if (resolved2.kind === "legacy") return dirname4(resolved2.path);
  if (resolved2.kind === "workspace") {
    const configDir = dirname4(resolved2.path);
    return basename3(configDir) === ".tmux-ide" ? dirname4(configDir) : configDir;
  }
  return projectRoot;
}
async function resolveProjectConfigContext(targetDir, options = {}) {
  const inputDir = resolve4(targetDir);
  const resolved2 = await resolveConfig(inputDir, options);
  const projectRoot = resolved2.resolution.projectRoot;
  const configWriteRoot = configWriteRootForResolved(resolved2, projectRoot);
  const configName = resolved2.launchConfig?.name ?? void 0;
  return {
    inputDir,
    projectRoot,
    configWriteRoot,
    sessionName: configName ?? basename3(projectRoot),
    sessionNameSource: configName ? "config" : "fallback",
    resolved: resolved2,
    configExists: resolved2.kind !== "none",
    hasWorkspaceConfig: resolved2.kind === "workspace" || resolved2.resolution.workspaceConfigPath !== null,
    hasIdeYml: resolved2.kind === "legacy" || resolved2.resolution.legacyConfigPath !== null,
    configKind: resolved2.kind,
    configPath: resolved2.path,
    ideConfigPath: resolved2.resolution.legacyConfigPath
  };
}
var init_config_context = __esm({
  "packages/daemon/src/lib/config-context.ts"() {
    "use strict";
    init_resolved_config();
  }
});

// packages/daemon/src/lib/sizes.ts
function computeSizes(items) {
  let claimed = 0;
  let unclaimed = 0;
  for (const item of items) {
    if (item.size) {
      claimed += parseFloat(item.size);
    } else {
      unclaimed++;
    }
  }
  const remaining = Math.max(0, 100 - claimed);
  const defaultSize = unclaimed > 0 ? remaining / unclaimed : 0;
  return items.map((item) => item.size ? parseFloat(item.size) : defaultSize);
}
function toSplitPercents(sizes) {
  const percents = [];
  for (let i = 1; i < sizes.length; i++) {
    const remaining = sizes.slice(i - 1).reduce((a, b) => a + b, 0);
    const topShare = sizes[i - 1];
    percents.push(Math.round((remaining - topShare) / remaining * 100));
  }
  return percents;
}
var init_sizes = __esm({
  "packages/daemon/src/lib/sizes.ts"() {
    "use strict";
  }
});

// packages/daemon/src/lib/output.ts
function printLayout(config2) {
  const INNER = 40;
  const rows = config2.rows ?? [];
  if (rows.length === 0) return;
  for (let r = 0; r < rows.length; r++) {
    const panes = rows[r].panes ?? [];
    const count = panes.length || 1;
    const widths = [];
    let remaining = INNER;
    for (let i = 0; i < count; i++) {
      const w = i < count - 1 ? Math.floor(INNER / count) : remaining;
      widths.push(w);
      remaining -= w;
    }
    if (r === 0) {
      let top = "  \u250C";
      for (let i = 0; i < count; i++) {
        top += "\u2500".repeat(widths[i]);
        top += i < count - 1 ? "\u252C" : "\u2510";
      }
      console.log(top);
    } else {
      console.log("  \u251C" + "\u2500".repeat(INNER + count - 1) + "\u2524");
    }
    const sizeLabel = rows[r].size ?? "";
    let line = "  \u2502";
    for (let i = 0; i < count; i++) {
      const title = panes[i]?.title ?? "";
      const w = widths[i];
      const pad = Math.max(0, w - title.length);
      const left = Math.floor(pad / 2);
      const right = pad - left;
      line += " ".repeat(left) + title + " ".repeat(right) + "\u2502";
    }
    if (sizeLabel) line += "  " + sizeLabel;
    console.log(line);
    if (r === rows.length - 1) {
      let bot = "  \u2514";
      for (let i = 0; i < count; i++) {
        bot += "\u2500".repeat(widths[i]);
        bot += i < count - 1 ? "\u2534" : "\u2518";
      }
      console.log(bot);
    }
  }
}
function outputError(message, code, { exitCode = 1 } = {}) {
  throw new IdeError(message, { code, exitCode });
}
function printCommandError(error, { json: json2 = false } = {}) {
  if (json2) {
    console.error(JSON.stringify(error.toJSON(), null, 2));
  } else {
    console.error(error.message);
  }
  process.exit(error.exitCode ?? 1);
}
var init_output = __esm({
  "packages/daemon/src/lib/output.ts"() {
    "use strict";
    init_errors2();
  }
});

// packages/daemon/src/lib/shell.ts
function shellEscape(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
var init_shell = __esm({
  "packages/daemon/src/lib/shell.ts"() {
    "use strict";
  }
});

// packages/daemon/src/lib/launch-plan.ts
import { resolve as resolve5 } from "node:path";
import { createHash as createHash2 } from "node:crypto";
function semanticPaneIdForPane(pane) {
  if (pane.id) return pane.id;
  const metadata = JSON.stringify({
    title: pane.title ?? null,
    command: pane.command ?? null,
    type: pane.type ?? null,
    target: pane.target ?? null,
    dir: pane.dir ?? null,
    role: pane.role ?? null,
    env: Object.entries(pane.env ?? {}).sort(
      ([left], [right]) => left < right ? -1 : left > right ? 1 : 0
    )
  });
  const digest = createHash2("sha256").update(metadata).digest("hex").slice(0, 16);
  const label = paneIdentityLabel(pane);
  return `pane-${label}-${digest}`;
}
function paneIdentityOptions(action) {
  return [
    [WORKSPACE_SEMANTIC_PANE_OPTION, action.semanticPaneId],
    ["@ide_role", action.paneRole ?? "shell"],
    ["@ide_name", action.title ?? ""],
    ["@ide_type", action.paneType ?? "shell"]
  ];
}
function buildPaneCommand(pane) {
  if (!pane.command) return null;
  return pane.command;
}
function collectPaneStartupPlan(rows, paneMap, firstPanesOfRows, dir) {
  let focusPane = paneMap[0][0];
  const paneActions2 = [];
  const diagnostics = [];
  const paneIdentities = assignPaneIdentities(rows, diagnostics);
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];
    for (let paneIdx = 0; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx];
      const tmuxPane = paneMap[rowIdx][paneIdx];
      let paneRole;
      if (pane.role === "lead") {
        paneRole = "lead";
      } else if (pane.role === "teammate" || pane.role === "planner") {
        paneRole = "teammate";
      } else if (pane.type) {
        paneRole = "widget";
      } else {
        paneRole = "shell";
      }
      let paneType;
      if (pane.type) {
        paneType = pane.type;
      } else if (pane.command && /claude|codex/i.test(pane.command)) {
        paneType = "agent";
      } else {
        paneType = "shell";
      }
      const action = {
        targetPane: tmuxPane,
        semanticPaneId: paneIdentities[rowIdx][paneIdx],
        title: pane.title ?? null,
        chdir: null,
        exports: [],
        command: null,
        widgetType: pane.type ?? null,
        widgetTarget: pane.target ?? null,
        paneRole,
        paneType
      };
      if (pane.dir && firstPanesOfRows.has(tmuxPane)) {
        action.chdir = resolve5(dir, pane.dir);
      }
      if (pane.env && typeof pane.env === "object") {
        action.exports = Object.entries(pane.env).map(
          ([key, value]) => `export ${shellEscape(key)}=${shellEscape(String(value))}`
        );
      }
      let command2 = buildPaneCommand(pane);
      if (command2 && pane.title && /claude|codex/i.test(command2) && !command2.includes("--name")) {
        command2 = `${command2} --name ${shellEscape(pane.title)}`;
      }
      if (command2) {
        action.command = command2;
      }
      if (pane.focus) {
        focusPane = tmuxPane;
      }
      paneActions2.push(action);
    }
  }
  return { focusPane, paneActions: paneActions2, diagnostics };
}
function assignPaneIdentities(rows, diagnostics) {
  const bases = rows.map((row) => row.panes.map(semanticPaneIdForPane));
  const implicitCounts = /* @__PURE__ */ new Map();
  const explicitIds = /* @__PURE__ */ new Set();
  for (const [rowIndex, row] of rows.entries()) {
    for (const [paneIndex, pane] of row.panes.entries()) {
      const base = bases[rowIndex][paneIndex];
      if (pane.id) {
        if (explicitIds.has(base)) throw new Error(`duplicate explicit pane id "${base}"`);
        explicitIds.add(base);
      } else {
        implicitCounts.set(base, (implicitCounts.get(base) ?? 0) + 1);
      }
    }
  }
  const occurrences = /* @__PURE__ */ new Map();
  const assigned = new Set(explicitIds);
  return rows.map(
    (row, rowIndex) => row.panes.map((pane, paneIndex) => {
      const base = bases[rowIndex][paneIndex];
      if (pane.id) return base;
      const total = implicitCounts.get(base) ?? 1;
      const occurrence = (occurrences.get(base) ?? 0) + 1;
      occurrences.set(base, occurrence);
      const candidate = total === 1 ? base : `${base}-${occurrence}`;
      if (assigned.has(candidate)) {
        throw new Error(
          `explicit pane id "${candidate}" collides with a derived pane identity; choose another explicit id`
        );
      }
      assigned.add(candidate);
      if (total > 1 && occurrence === 1) {
        diagnostics.push({
          code: "AMBIGUOUS_IMPLICIT_PANE_ID",
          message: `${total} panes produce the same implicit identity fingerprint. Assigned occurrence suffixes for compatibility; add explicit pane ids to preserve their individual identity across insert/delete.`
        });
      }
      return candidate;
    })
  );
}
function paneIdentityLabel(pane) {
  const raw = pane.title ?? pane.type ?? pane.role ?? pane.command?.trim().split(/\s+/u)[0] ?? "shell";
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 32);
  return slug || "pane";
}
var init_launch_plan = __esm({
  "packages/daemon/src/lib/launch-plan.ts"() {
    "use strict";
    init_src();
    init_shell();
  }
});

// packages/daemon/src/lib/session-options.ts
function buildSessionOptions(session, { theme = {} } = {}) {
  return [
    ...themeOptions(session, theme),
    ...borderOptions(session, theme),
    ...behaviorOptions(session),
    ...statusBarOptions(session, theme),
    ...keyBindings()
  ];
}
function themeOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const bg = theme.bg ?? "colour235";
  const fg = theme.fg ?? "colour248";
  return [
    ["set-option", "-t", session, "status-style", `bg=${bg},fg=${fg}`],
    ["set-option", "-t", session, "pane-border-style", `fg=${border}`],
    ["set-option", "-t", session, "pane-active-border-style", `fg=${accent}`]
  ];
}
function borderOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const fg = theme.fg ?? "colour248";
  return [
    ["set-option", "-t", session, "pane-border-status", "top"],
    [
      "set-option",
      "-t",
      session,
      "pane-border-format",
      ` #{?pane_active,#[fg=${accent}#,bold]\u25B8 #T  #[fg=${fg}]#{pane_current_path},#[fg=${border}]\xB7 #T  #{pane_current_path}} `
    ]
  ];
}
function behaviorOptions(session) {
  return [
    ["set-option", "-t", session, "mouse", "on"],
    ["set-option", "-t", session, "escape-time", "0"],
    ["set-option", "-t", session, "status-interval", "1"]
  ];
}
function statusBarOptions(session, theme) {
  const accent = theme.accent ?? "colour75";
  const border = theme.border ?? "colour238";
  const fg = theme.fg ?? "colour248";
  const agentIndicator = [
    `#{?#{==:#{@agent_busy},1},#[fg=${accent}]\u23FA ,`,
    `#{?#{==:#{@agent_idle},1},#[fg=${border}]\u25CF ,}}`
  ].join("");
  const portIndicator = `#{?#{==:#{@has_port},1},#[fg=green]\u23FA ,}`;
  const paneStyle = `#{?pane_active,#[fg=${accent}],#[fg=${border}]}`;
  const paneTab = `${agentIndicator}${portIndicator}${paneStyle}#[range=pane|#{pane_id}] #T #[norange]#[default]`;
  const separator = `#{?loop_last_flag,,#[fg=${border}]\u2502}`;
  return [
    [
      "set-option",
      "-t",
      session,
      "status-left",
      `#[fg=colour0,bg=${accent},bold]  ${session.toUpperCase()} IDE #[default] `
    ],
    ["set-option", "-t", session, "status-left-length", "30"],
    [
      "set-option",
      "-t",
      session,
      "status-right",
      `#[fg=colour243]%H:%M #[fg=${accent}]\u2502 #[fg=${fg}]%b %d `
    ],
    ["set-option", "-t", session, "status-justify", "centre"],
    ["set-option", "-t", session, "window-status-current-format", `#[fg=${accent},bold]\u25CF`],
    ["set-option", "-t", session, "window-status-format", `#[fg=${border}]\u25CB`],
    ["set-option", "-t", session, "status", "2"],
    ["set-option", "-t", session, "status-format[1]", `  #{P:${paneTab}${separator}}`]
  ];
}
function keyBindings() {
  return [["bind-key", "-n", "MouseDown1StatusDefault", "select-pane", "-t", "="]];
}
var init_session_options = __esm({
  "packages/daemon/src/lib/session-options.ts"() {
    "use strict";
  }
});

// packages/daemon/src/validate.ts
import { resolve as resolve6 } from "node:path";
function validateConfig(config2) {
  if (config2 == null || typeof config2 !== "object" || Array.isArray(config2)) {
    return ["config must be an object"];
  }
  const result = IdeConfigSchema.safeParse(config2);
  if (!result.success) {
    return result.error.issues.map((issue) => mapZodIssue(issue, config2));
  }
  const errors = [];
  const cfg = result.data;
  const rowSizes = cfg.rows.filter((r) => r.size !== void 0).map((r) => parseInt(r.size, 10));
  const rowSum = rowSizes.reduce((a, b) => a + b, 0);
  if (rowSum > 100) {
    errors.push(`Row sizes sum to ${rowSum}%, which exceeds 100%`);
  }
  for (let i = 0; i < cfg.rows.length; i++) {
    const row = cfg.rows[i];
    const paneSizes = row.panes.filter((p) => p.size !== void 0).map((p) => parseInt(p.size, 10));
    const paneSum = paneSizes.reduce((a, b) => a + b, 0);
    if (paneSum > 100) {
      errors.push(`Row ${i} pane sizes sum to ${paneSum}%, which exceeds 100%`);
    }
    const focusCount = row.panes.filter((p) => p.focus === true).length;
    if (focusCount > 1) {
      errors.push(`Row ${i} has ${focusCount} panes with focus: true (max 1)`);
    }
    for (let j = 0; j < row.panes.length; j++) {
      const pane = row.panes[j];
      if (pane.type !== void 0 && pane.command !== void 0) {
        errors.push(`rows[${i}].panes[${j}] cannot have both 'type' and 'command'`);
      }
    }
  }
  return errors;
}
function formatPath(path2) {
  let result = "";
  for (let i = 0; i < path2.length; i++) {
    const seg = path2[i];
    if (typeof seg === "number") {
      result += `[${seg}]`;
    } else if (i === 0) {
      result += seg;
    } else {
      result += `.${seg}`;
    }
  }
  return result;
}
function shouldQuote(path2) {
  if (path2.length === 1 && typeof path2[0] === "string") return true;
  if (path2[0] === "team") return true;
  return false;
}
function isSizePath(path2) {
  return path2[path2.length - 1] === "size";
}
function isEnvValuePath(path2) {
  const envIdx = path2.indexOf("env");
  return envIdx >= 0 && envIdx < path2.length - 1;
}
function getValueAtPath(obj, path2) {
  let current = obj;
  for (const seg of path2) {
    if (current == null || typeof current !== "object") return void 0;
    current = current[String(seg)];
  }
  return current;
}
function typeDesc(path2, expected) {
  const base = expected.replace(/\s*\|\s*undefined/g, "").trim();
  let desc;
  if (base === "string") desc = "a string";
  else if (base === "boolean") desc = "a boolean";
  else if (base === "number") desc = "a number";
  else if (base === "array") desc = "an array";
  else if (base === "object" || base === "record") desc = "an object";
  else desc = base;
  const field = path2[path2.length - 1];
  if (path2[0] === "orchestrator" && typeof field === "string" && MS_FIELDS.has(field)) {
    return `${desc} (ms)`;
  }
  return desc;
}
function mapZodIssue(issue, config2) {
  const path2 = issue.path ?? [];
  const code = issue.code ?? "";
  const rawPath = formatPath(path2);
  const display = shouldQuote(path2) ? `'${rawPath}'` : rawPath;
  const lastSeg = path2[path2.length - 1];
  if (isEnvValuePath(path2)) {
    return `${formatPath(path2)} must be a string or number`;
  }
  if (isSizePath(path2) && code !== "invalid_type") {
    if (code === "custom") {
      return `${rawPath} must not exceed 100%`;
    }
    const val = getValueAtPath(config2, path2);
    return `${rawPath} "${val}" must be a percentage (e.g. "50%")`;
  }
  if (code === "too_small") {
    return `${display} must not be empty`;
  }
  if (code === "invalid_value" && lastSeg === "type" && path2.includes("panes")) {
    return `${rawPath} must be one of: explorer, changes, preview, tasks, costs, config, mission-control`;
  }
  if (code === "invalid_value" && lastSeg === "role") {
    return `${rawPath} must be "lead", "teammate", or "planner"`;
  }
  if (code === "invalid_value" && lastSeg === "dispatch_mode") {
    return `${rawPath} must be "tasks" or "goals"`;
  }
  if (path2.length === 2 && path2[0] === "team" && path2[1] === "name") {
    if (issue.received === "undefined") {
      return "'team.name' is required when team is specified";
    }
  }
  if (code === "invalid_type") {
    return `${display} must be ${typeDesc(path2, issue.expected ?? "")}`;
  }
  return `${display}: ${issue.message ?? "invalid value"}`;
}
async function validate(targetDir, { json: json2 } = {}) {
  const dir = resolve6(targetDir ?? ".");
  const resolved2 = await resolveConfig(dir);
  const config2 = resolved2.launchConfig;
  if (!config2) {
    outputError("Cannot read workspace config: no config found", "READ_ERROR");
    return;
  }
  const errors = validateConfig(config2);
  const valid = errors.length === 0;
  if (json2) {
    console.log(
      JSON.stringify(
        {
          valid,
          errors,
          configKind: resolved2.kind,
          configPath: resolved2.path,
          legacyDiagnostics: resolved2.diagnostics
        },
        null,
        2
      )
    );
    return;
  }
  if (valid) {
    console.log(`\u2713 ${resolved2.kind === "legacy" ? "legacy ide.yml" : "workspace config"} is valid`);
    if (resolved2.migrationHint) console.log(resolved2.migrationHint);
  } else {
    console.log("\u2717 workspace config has errors:");
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
    process.exitCode = 1;
  }
}
var MS_FIELDS;
var init_validate = __esm({
  "packages/daemon/src/validate.ts"() {
    "use strict";
    init_output();
    init_ide_config2();
    init_resolved_config();
    MS_FIELDS = /* @__PURE__ */ new Set(["stall_timeout", "poll_interval"]);
  }
});

// packages/daemon/src/tui/detect/manifest.ts
function resolveRegion(snapshot, region) {
  switch (region) {
    case "text":
      return snapshot.text;
    case "title":
      return snapshot.title ?? "";
    case "bottom":
    default:
      return snapshot.bottomNonEmpty.join("\n");
  }
}
function safeRegex(source, caseInsensitive) {
  try {
    return new RegExp(source, caseInsensitive ? "i" : "");
  } catch {
    return void 0;
  }
}
function matchMatcher(snapshot, matcher) {
  const haystack = resolveRegion(snapshot, matcher.region ?? "bottom");
  if (matcher.contains !== void 0) {
    if (matcher.caseInsensitive) {
      return haystack.toLowerCase().includes(matcher.contains.toLowerCase());
    }
    return haystack.includes(matcher.contains);
  }
  if (matcher.regex !== void 0) {
    const re = safeRegex(matcher.regex, matcher.caseInsensitive);
    return re ? re.test(haystack) : false;
  }
  return false;
}
function matchRule(snapshot, rule) {
  const hasAll = rule.all !== void 0 && rule.all.length > 0;
  const hasAny = rule.any !== void 0 && rule.any.length > 0;
  if (!hasAll && !hasAny) return false;
  if (hasAll && !rule.all.every((m) => matchMatcher(snapshot, m))) return false;
  if (hasAny && !rule.any.some((m) => matchMatcher(snapshot, m))) return false;
  return true;
}
function evaluateManifest(snapshot, manifest) {
  for (const state of PRECEDENCE) {
    const rule = manifest.states[state];
    if (rule && matchRule(snapshot, rule)) {
      const matcher = firstMatchingMatcher(snapshot, rule);
      return matcher ? { state, matched: { state, matcher } } : { state };
    }
  }
  return { state: null };
}
function firstMatchingMatcher(snapshot, rule) {
  const matchers = [...rule.all ?? [], ...rule.any ?? []];
  return matchers.find((m) => matchMatcher(snapshot, m));
}
function explain(snapshot, manifest) {
  const checked = PRECEDENCE.map((state) => {
    const rule = manifest.states[state];
    return { state, matched: rule ? matchRule(snapshot, rule) : false };
  });
  const winner = checked.find((c) => c.matched);
  return { state: winner ? winner.state : null, checked };
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function containsSegment(haystack, needle) {
  if (!haystack.includes(needle)) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(needle)}([^a-z0-9]|$)`).test(haystack);
}
function pickManifest(command2, manifests) {
  const cmd = command2.trim().toLowerCase();
  if (cmd.length === 0) return void 0;
  const exact = manifests.find((m) => m.commands.some((c) => c.toLowerCase() === cmd));
  if (exact) return exact;
  return manifests.find(
    (m) => m.commands.some((c) => {
      const name = c.toLowerCase();
      return containsSegment(cmd, name) || containsSegment(name, cmd);
    })
  );
}
var PRECEDENCE;
var init_manifest = __esm({
  "packages/daemon/src/tui/detect/manifest.ts"() {
    "use strict";
    PRECEDENCE = ["blocked", "working", "done"];
  }
});

// packages/daemon/src/tui/detect/manifests.ts
var BRAILLE_SPINNER, CLAUDE, CODEX, OPENCODE, GEMINI, AIDER, COPILOT, CURSOR, GOOSE, AMP, DEVIN, KIMI, PI, GROK, KIRO, CLINE, DROID, KILO, SHELL, BUNDLED_MANIFESTS;
var init_manifests = __esm({
  "packages/daemon/src/tui/detect/manifests.ts"() {
    "use strict";
    BRAILLE_SPINNER = "[\u280B\u2819\u2839\u2838\u283C\u2834\u2826\u2827\u2807\u280F]";
    CLAUDE = {
      id: "claude",
      commands: ["claude"],
      confidence: "tuned",
      states: {
        // Approval / confirmation prompts — Claude is waiting on the user.
        // Claude's approval UI is a bordered box asking a "Do you want …?" question
        // with a numbered arrow menu ("❯ 1. Yes" / "3. No, and tell Claude …").
        // These phrases are approval-specific and never appear in the idle chrome
        // (a bare "❯ " input box) or the "How is Claude doing this session?" survey
        // (which uses "1: Bad" colon-style options, not "❯ 1.").
        blocked: {
          any: [
            // seen (approval dialogs): "Do you want to proceed?" / "Do you want to
            // make this edit to …"
            { region: "bottom", contains: "Do you want" },
            // seen: the highlighted first option of the numbered approval menu.
            { region: "bottom", contains: "\u276F 1." },
            // seen: "2. Yes, and don't ask again this session"
            { region: "bottom", contains: "Yes, and" },
            // seen: "3. No, and tell Claude what to do differently"
            { region: "bottom", contains: "No, and tell Claude" }
          ]
        },
        // Streaming / thinking indicators. While Claude works the bottom line shows
        // a spinner + gerund + the interrupt hint, e.g.
        //   "✳ Cerebrating… (esc to interrupt · ctrl+t to hide todos)".
        working: {
          any: [
            // seen: the interrupt hint is present for the entire duration of a turn
            // — the single most reliable "working" invariant.
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            // seen: the animated status verb ("Thinking…", "Cerebrating…").
            { region: "bottom", contains: "Thinking" },
            { region: "bottom", contains: "Cerebrating" },
            // The leading braille spinner glyph, in the body or (rarely) the title.
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
        // done: intentionally omitted — inferred by the classifier's seen-tracking.
        // NOTE (seen, NOT used): idle Claude shows a bordered "❯ " input box with a
        // "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents" or
        // "? for shortcuts · ← for agents" footer, and finished turns leave a
        // "✻ Brewed for 9s" summary — none of these are working/blocked evidence,
        // so they are deliberately absent and fall through to idle.
      }
    };
    CODEX = {
      id: "codex",
      commands: ["codex", "codex.exe"],
      confidence: "tuned",
      states: {
        // TUNED against real captures (codex-cli v0.142.5, driven through a turn).
        // The command-approval dialog and the directory-trust prompt are the two
        // "blocked" screens. Codex's approval menu uses a "› 1." numbered arrow —
        // note the arrow is "›" (U+203A), NOT claude's "❯".
        blocked: {
          any: [
            // seen (command approval): "Would you like to run the following
            // command?" above a "$ <cmd>" preview and the numbered menu.
            { region: "bottom", contains: "Would you like to run", caseInsensitive: true },
            // seen: the highlighted approval option "› 1. Yes, proceed".
            { region: "bottom", contains: "Yes, proceed" },
            // seen: "3. No, and tell Codex what to do differently (esc)".
            { region: "bottom", contains: "No, and tell Codex" },
            // seen: the confirm footer under the approval menu.
            { region: "bottom", contains: "Press enter to confirm", caseInsensitive: true },
            // seen (directory-trust prompt on first launch in an untrusted dir):
            // "Do you trust the contents of this directory?" + "1. Yes, continue".
            { region: "bottom", contains: "Do you trust the contents", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            // seen (verbatim): the working status line is
            //   "• Working (6s • esc to interrupt)".
            // Both the "Working (" prefix and the shared "esc to interrupt" hint
            // are present for the whole turn.
            { region: "bottom", regex: "Working \\(\\d" },
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
        // done: omitted. NOTE (seen, NOT used): a finished turn leaves the agent's
        // answer above the idle "›" input box (placeholder "Find and fix a bug in
        // @filename") and a "gpt-5.5 xhigh · <cwd>" status line; older builds also
        // showed "Goal achieved (5m)". None are working/blocked evidence, so codex
        // correctly falls through to idle and the classifier infers done.
      }
    };
    OPENCODE = {
      id: "opencode",
      commands: ["opencode", "opencode.exe"],
      confidence: "conservative",
      states: {
        // conservative — a live capture was attempted (opencode v1.17.10) but its
        // local auth DB errored ("no such column: name") and the TUI rendered
        // blank, so these stay best-effort. High-precision only.
        blocked: {
          any: [
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "[y/n]", caseInsensitive: true },
            { region: "bottom", contains: "Do you want" }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    GEMINI = {
      id: "gemini",
      commands: ["gemini"],
      confidence: "conservative",
      states: {
        // conservative — gemini-cli needs a Google account/API key to reach a
        // working state, so no live capture was taken. High-precision only.
        blocked: {
          any: [
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "Apply this change", caseInsensitive: true },
            { region: "bottom", contains: "Allow execution", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            // gemini-cli shows an "(esc to cancel)" hint during a turn.
            { region: "bottom", contains: "esc to cancel", caseInsensitive: true },
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    AIDER = {
      id: "aider",
      commands: ["aider"],
      confidence: "tuned",
      states: {
        // TUNED from aider's installed source (v0.86.2). Every confirmation renders
        // through `io.confirm_ask` (io.py), which appends the literal option string
        // " (Y)es/(N)o" (plus "/(A)ll/(S)kip all" or "/(D)on't ask again") and a
        // "[Yes]:"/"[No]:" default — so "(Y)es/(N)o" is aider's exact, universal
        // blocked marker. The specific questions below are verbatim from
        // base_coder.py / commands.py.
        blocked: {
          any: [
            { region: "bottom", contains: "(Y)es/(N)o", caseInsensitive: true },
            { region: "bottom", contains: "Add file to the chat", caseInsensitive: true },
            { region: "bottom", contains: "Allow edits to file", caseInsensitive: true },
            { region: "bottom", contains: "Add command output to the chat", caseInsensitive: true },
            { region: "bottom", contains: "Run pip install", caseInsensitive: true }
          ]
        },
        // TUNED: while a turn runs aider shows a `WaitingSpinner` (waiting.py)
        // rendered as "[░█   ] Waiting for <model>" — the text is literally
        // "Waiting for LLM" or "Waiting for " + the model name (base_coder.py:1440).
        // aider's spinner uses a "░█" scanner, NOT braille, so "Waiting for " is the
        // real invariant; the braille probe is kept only as a harmless fallback.
        working: {
          any: [
            { region: "bottom", contains: "Waiting for ", caseInsensitive: false },
            { region: "bottom", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    COPILOT = {
      id: "copilot",
      commands: ["copilot", "github-copilot", "github-copilot-cli"],
      confidence: "conservative",
      states: {
        // conservative — github-copilot-cli needs a GitHub account, so no live
        // capture was taken. High-precision only.
        blocked: {
          any: [
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "Select an option", caseInsensitive: true },
            { region: "bottom", contains: "Allow", caseInsensitive: false }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    CURSOR = {
      id: "cursor",
      commands: ["cursor-agent", "cursor"],
      confidence: "conservative",
      states: {
        // conservative — cursor-agent (Cursor CLI) was launched live but sits on a
        // "Press any key to log in…" pre-auth screen without an account, so no
        // working/blocked turn could be captured. The pre-auth splash ("Cursor
        // Agent" / "Press any key to log in") is idle chrome and deliberately NOT
        // matched here. Markers below are high-precision guesses from public
        // knowledge of its approval/streaming UI. NOTE: cursor-agent runs under
        // `node`, so it resolves via the process-tree (argv0 basename), not the
        // pane's `current_command`.
        blocked: {
          any: [
            { region: "bottom", contains: "Do you want", caseInsensitive: false },
            { region: "bottom", contains: "Run this command", caseInsensitive: true },
            { region: "bottom", contains: "Apply this edit", caseInsensitive: true },
            { region: "bottom", contains: "(y/n)", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    GOOSE = {
      id: "goose",
      commands: ["goose"],
      confidence: "conservative",
      states: {
        // conservative — Block's goose CLI needs a configured provider, so no live
        // capture was taken. High-precision only; markers are best-effort from
        // public knowledge of its confirmation/streaming UI.
        blocked: {
          any: [
            { region: "bottom", contains: "Do you want", caseInsensitive: false },
            { region: "bottom", contains: "Allow this tool", caseInsensitive: true },
            { region: "bottom", contains: "(y/n)", caseInsensitive: true },
            { region: "bottom", contains: "[y/n]", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    AMP = {
      id: "amp",
      commands: ["amp"],
      confidence: "conservative",
      states: {
        // conservative — Sourcegraph's amp CLI needs an account, so no live capture
        // was taken. High-precision only; markers are best-effort from public
        // knowledge of its approval/streaming UI.
        blocked: {
          any: [
            { region: "bottom", contains: "Do you want", caseInsensitive: false },
            { region: "bottom", contains: "Allow", caseInsensitive: false },
            { region: "bottom", contains: "(y/n)", caseInsensitive: true }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    DEVIN = {
      id: "devin",
      commands: ["devin"],
      confidence: "conservative",
      states: {
        // conservative — Devin CLI (Cognition; closed-source native Rust binary,
        // needs an account). Blocked markers are VERBATIM from docs.devin.ai
        // (cli/changelog + essential-commands via llms-full.txt): the plan-mode
        // approval menu and the always-allow option. Devin has NO verified working
        // text (its spinner is unlabeled; docs say interrupt is Ctrl+C, not esc),
        // so working keeps only the shared spinner probe.
        blocked: {
          any: [
            // seen (docs): "Yes, implement plan and accept edits" / "…and bypass
            // permissions" — the shared prefix covers both.
            { region: "bottom", contains: "Yes, implement plan and" },
            { region: "bottom", contains: "No, plan needs changes" },
            { region: "bottom", contains: "Yes, always allow" }
          ]
        },
        working: {
          any: [
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    KIMI = {
      id: "kimi",
      commands: ["kimi"],
      confidence: "conservative",
      states: {
        // conservative — kimi CLI (MoonshotAI/kimi-cli, Python/prompt_toolkit).
        // Blocked markers are VERBATIM from its source (_approval_panel.py): the
        // approval panel's "<tool> is requesting approval to …" header and its
        // option labels. Its working spinner is a text-less moon animation (not
        // braille), so working may under-detect until tuned — the braille probe is
        // kept only as the shared fallback. ("Thinking"/"Thought for" deliberately
        // NOT matched: they persist in the transcript after the turn.)
        blocked: {
          any: [
            { region: "bottom", contains: " is requesting approval to " },
            { region: "bottom", contains: "Approve for this session" },
            { region: "bottom", contains: "Reject, tell the model" }
          ]
        },
        working: {
          any: [
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    PI = {
      id: "pi",
      commands: ["pi"],
      confidence: "conservative",
      states: {
        // conservative — pi (@mariozechner/pi-coding-agent, node). Working marker
        // is VERBATIM from its source (interactive-mode.ts): the status line is
        // `Working... (esc to interrupt)`, with `(esc to cancel)` retry/compacting
        // variants. Its core has NO distinctive approval wording (generic Yes/No
        // via extensions), so blocked is deliberately ABSENT — authority
        // self-reporting or the classifier's fallback carry it.
        working: {
          any: [
            { region: "bottom", contains: "Working... (esc to interrupt)" },
            { region: "bottom", contains: "(esc to cancel)" },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    GROK = {
      id: "grok",
      commands: ["grok"],
      confidence: "conservative",
      states: {
        // conservative — the community grok CLI (@vibe-kit/grok-cli /
        // superagent-ai/grok-cli, node/OpenTUI). Working markers are VERBATIM from
        // its source (app.tsx / headless output.ts): the mid-turn placeholder
        // carries "(esc to interrupt)" and headless prints "⏳ Processing...".
        // Its ConfirmationDialog wording could not be verified, so blocked keeps
        // only a high-precision generic. NOTE: xAI's separate official
        // `grok-build` binary substring-matches this manifest but has no verified
        // strings — it will simply read idle until evidence exists.
        blocked: {
          any: [{ region: "bottom", contains: "(y/n)", caseInsensitive: true }]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", contains: "\u23F3 Processing" },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    KIRO = {
      id: "kiro",
      commands: ["kiro-cli", "kiro"],
      confidence: "conservative",
      states: {
        // conservative — Kiro CLI (AWS; the rebranded Amazon Q Developer CLI, a
        // native Rust binary). Markers are VERBATIM from the open-source
        // predecessor (aws/amazon-q-developer-cli chat-cli/src/cli/chat/mod.rs):
        // the tool-approval question and the Spinners::Dots "Thinking..." status.
        // The closed Kiro build may drift — same lineage, pending live capture.
        // NOTE: the predecessor's 1-char `q` binary is deliberately NOT a command
        // token (a single letter substring-matches far too much).
        blocked: {
          any: [
            { region: "bottom", contains: "Allow this action?" },
            { region: "bottom", contains: "to trust (always allow) this tool" }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "Thinking..." },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    CLINE = {
      id: "cline",
      commands: ["cline"],
      confidence: "conservative",
      states: {
        // conservative — cline CLI (cline.bot; CLI 2.0 ships prebuilt platform
        // binaries, OpenTUI). Markers are VERBATIM from its source: the approval
        // dialog's "Cline needs permission" title + "Approve tool call?" header
        // (tui/components/dialogs/tool-approval.tsx) and the streaming
        // "Thinking... (esc to cancel)" status (chat-message-list.tsx).
        blocked: {
          any: [
            { region: "bottom", contains: "Cline needs permission" },
            { region: "bottom", contains: "Approve tool call?" },
            { region: "bottom", contains: "[y] Approve" }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to cancel", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    DROID = {
      id: "droid",
      commands: ["droid"],
      confidence: "conservative",
      states: {
        // conservative — droid (Factory CLI) was launched live (v0.114.1) but sits
        // on an auth-gated login menu without a Factory account, so only the login
        // splash could be captured (it reads IDLE and is deliberately not matched:
        // "Please login with your Factory account to continue." / "> Login").
        // Verified live: droid runs as its OWN process (`pane_current_command` =
        // "droid"), so command matching needs no process-tree help.
        // Blocked markers are docs-derived (docs.factory.ai auto-run levels,
        // corroborated third-party walkthrough) — the Spec-mode proceed menu names
        // its autonomy levels verbatim. Pending live-capture confirmation.
        blocked: {
          any: [
            { region: "bottom", contains: "Proceed, manual approval" },
            { region: "bottom", contains: "Proceed, allow safe commands" },
            { region: "bottom", contains: "Proceed, allow all commands" }
          ]
        },
        working: {
          any: [
            { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    KILO = {
      id: "kilo",
      commands: ["kilo", ".kilo", "kilocode"],
      confidence: "conservative",
      states: {
        // conservative, but the blocked markers are VERBATIM from the shipped
        // @kilocode/cli binary (v7.4.5, strings-extracted — no account to drive a
        // live capture): the permission dialog renders a "△ Permission required"
        // header over an "Allow once" / "Allow always" / "Reject" option list.
        // NOTE: the CLI's npm launcher (`bin/kilo`, node) execs the platform
        // binary installed as `bin/.kilo`, hence the ".kilo" command token.
        blocked: {
          any: [
            { region: "bottom", contains: "Permission required" },
            { region: "bottom", contains: "Allow once" },
            { region: "bottom", contains: "Allow always" }
          ]
        },
        // No working-state string was found in the binary (its status UI renders
        // from dynamic parts) — only the shared spinner probe, so kilo may read
        // idle while working until a live capture tunes it.
        working: {
          any: [
            { region: "bottom", regex: BRAILLE_SPINNER },
            { region: "title", regex: BRAILLE_SPINNER }
          ]
        }
      }
    };
    SHELL = {
      id: "shell",
      commands: ["bash", "zsh", "sh", "fish", "nu"],
      confidence: "conservative",
      states: {
        // Catch-all: a raw shell is almost always idle. We only flag an explicit
        // interactive confirmation as blocked; "working" is unreliable to read
        // from a shell snapshot, so it stays absent (idle by default).
        blocked: {
          any: [
            { region: "bottom", contains: "[y/n]", caseInsensitive: true },
            { region: "bottom", contains: "(yes/no)", caseInsensitive: true }
          ]
        }
      }
    };
    BUNDLED_MANIFESTS = [
      CLAUDE,
      CODEX,
      OPENCODE,
      GEMINI,
      AIDER,
      COPILOT,
      CURSOR,
      GOOSE,
      AMP,
      DEVIN,
      KIMI,
      PI,
      GROK,
      KIRO,
      CLINE,
      DROID,
      KILO,
      SHELL
    ];
  }
});

// packages/daemon/src/tui/detect/classify.ts
var classify_exports = {};
__export(classify_exports, {
  AGENT_TEXT_MAX: () => AGENT_TEXT_MAX,
  classifyInstant: () => classifyInstant,
  classifyPaneCommand: () => classifyPaneCommand,
  createStatusTracker: () => createStatusTracker,
  parseAuthority: () => parseAuthority,
  parseAuthorityEpoch: () => parseAuthorityEpoch,
  sanitizeAgentText: () => sanitizeAgentText
});
function parseAuthority(raw, nowSec) {
  if (!raw) return null;
  const sep3 = raw.lastIndexOf(":");
  if (sep3 === -1) return null;
  const state = raw.slice(0, sep3);
  const epoch = Number(raw.slice(sep3 + 1));
  if (!AUTHORITY_STATES.has(state) || !Number.isFinite(epoch)) return null;
  if ((state === "working" || state === "blocked") && nowSec - epoch > AUTHORITY_STALE_SECONDS) {
    return null;
  }
  return state;
}
function sanitizeAgentText(raw) {
  if (!raw) return void 0;
  const cleaned = raw.replace(/\x1b\[[0-9;?]*[ -/]*[\x40-\x7e]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return void 0;
  if (cleaned.length <= AGENT_TEXT_MAX) return cleaned;
  return cleaned.slice(0, AGENT_TEXT_MAX - 1) + "\u2026";
}
function parseAuthorityEpoch(raw) {
  if (!raw) return null;
  const sep3 = raw.lastIndexOf(":");
  if (sep3 === -1) return null;
  const epoch = Number(raw.slice(sep3 + 1));
  return Number.isFinite(epoch) ? epoch : null;
}
function classifyInstant(snapshot, manifest) {
  if (!manifest) return "unknown";
  const { state } = evaluateManifest(snapshot, manifest);
  switch (state) {
    case "blocked":
      return "blocked";
    case "working":
      return "working";
    // "done" (instantaneous) and null both fall through to idle.
    default:
      return "idle";
  }
}
function classifyPaneCommand(snapshot, command2, manifests = BUNDLED_MANIFESTS) {
  return classifyInstant(snapshot, pickManifest(command2, manifests));
}
function createStatusTracker() {
  const states = /* @__PURE__ */ new Map();
  function get(paneId) {
    let s = states.get(paneId);
    if (!s) {
      s = { wasWorking: false, doneUnseen: false };
      states.set(paneId, s);
    }
    return s;
  }
  return {
    update(paneId, instant, opts) {
      const seen = opts?.seen === true;
      const s = get(paneId);
      switch (instant) {
        case "working":
          s.doneUnseen = false;
          s.wasWorking = true;
          return "working";
        case "blocked":
          s.doneUnseen = false;
          s.wasWorking = false;
          return "blocked";
        case "idle": {
          if (s.wasWorking) s.doneUnseen = true;
          s.wasWorking = false;
          if (seen) {
            s.doneUnseen = false;
            return "idle";
          }
          return s.doneUnseen ? "done" : "idle";
        }
        case "unknown":
        default:
          s.wasWorking = false;
          if (seen) s.doneUnseen = false;
          return "unknown";
      }
    },
    markSeen(paneId) {
      const s = states.get(paneId);
      if (s) s.doneUnseen = false;
    },
    forget(paneId) {
      states.delete(paneId);
    }
  };
}
var AUTHORITY_STALE_SECONDS, AUTHORITY_STATES, AGENT_TEXT_MAX;
var init_classify = __esm({
  "packages/daemon/src/tui/detect/classify.ts"() {
    "use strict";
    init_manifest();
    init_manifests();
    AUTHORITY_STALE_SECONDS = 600;
    AUTHORITY_STATES = /* @__PURE__ */ new Set(["working", "blocked", "done", "idle"]);
    AGENT_TEXT_MAX = 32;
  }
});

// packages/daemon/src/tui/detect/manifest-loader.ts
import { readdirSync, readFileSync as readFileSync4 } from "node:fs";
import { homedir } from "node:os";
import { join as join4 } from "node:path";
function overrideDir() {
  const home = process.env.TMUX_IDE_HOME ?? join4(homedir(), ".tmux-ide");
  return join4(home, "agent-detection");
}
function packFile(dir = overrideDir()) {
  return join4(dir, "pack", "manifest-pack.json");
}
function validateManifestShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = value;
  if (typeof m.id !== "string" || m.id.trim().length === 0) return false;
  if (!Array.isArray(m.commands) || m.commands.length === 0) return false;
  if (!m.commands.every((c) => typeof c === "string" && c.length > 0)) return false;
  if (typeof m.states !== "object" || m.states === null) return false;
  const states = m.states;
  for (const key of ["blocked", "working", "done"]) {
    if (!(key in states)) continue;
    if (!isRuleShape(states[key])) return false;
  }
  return true;
}
function isRuleShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const r = value;
  for (const key of ["all", "any"]) {
    if (!(key in r)) continue;
    const arr = r[key];
    if (!Array.isArray(arr) || !arr.every(isMatcherShape)) return false;
  }
  return true;
}
function isMatcherShape(value) {
  if (typeof value !== "object" || value === null) return false;
  const m = value;
  return typeof m.contains === "string" || typeof m.regex === "string";
}
function mergeManifests(bundled, overrides) {
  const byId = /* @__PURE__ */ new Map();
  for (const o of overrides) byId.set(o.id, o);
  const result = [];
  const consumed = /* @__PURE__ */ new Set();
  for (const b of bundled) {
    const override = byId.get(b.id);
    if (override) {
      result.push(override);
      consumed.add(b.id);
    } else {
      result.push(b);
    }
  }
  for (const o of overrides) {
    if (!consumed.has(o.id)) {
      result.push(byId.get(o.id));
      consumed.add(o.id);
    }
  }
  return result;
}
function readOverrideManifests(dir = overrideDir()) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const overrides = [];
  for (const file of files.sort()) {
    const path2 = join4(dir, file);
    try {
      const parsed = JSON.parse(readFileSync4(path2, "utf8"));
      if (validateManifestShape(parsed)) {
        overrides.push(normalizeStates(parsed));
      } else {
        warnOnce(path2, "not a valid AgentManifest (need id, commands[], states)");
      }
    } catch (err) {
      warnOnce(path2, err instanceof Error ? err.message : String(err));
    }
  }
  return overrides;
}
function normalizeStates(m) {
  const states = {};
  if (m.states.blocked) states.blocked = m.states.blocked;
  if (m.states.working) states.working = m.states.working;
  if (m.states.done) states.done = m.states.done;
  const confidence = m.confidence === "tuned" ? "tuned" : "conservative";
  return { id: m.id, commands: m.commands, states, confidence };
}
function warnOnce(path2, reason) {
  if (warned.has(path2)) return;
  warned.add(path2);
  process.stderr.write(`tmux-ide: skipping agent-detection override ${path2}: ${reason}
`);
}
function readPackManifests(dir = overrideDir()) {
  const path2 = packFile(dir);
  let raw;
  try {
    raw = readFileSync4(path2, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    const manifests = parsed?.manifests;
    if (!Array.isArray(manifests)) {
      warnOnce(path2, "not a manifest pack (missing manifests[])");
      return [];
    }
    const valid = [];
    for (const entry of manifests) {
      if (validateManifestShape(entry)) valid.push(normalizeStates(entry));
      else warnOnce(path2, "pack entry is not a valid AgentManifest \u2014 entry skipped");
    }
    return valid;
  } catch (err) {
    warnOnce(path2, err instanceof Error ? err.message : String(err));
    return [];
  }
}
function loadManifests() {
  const withPack = mergeManifests(BUNDLED_MANIFESTS, readPackManifests());
  return mergeManifests(withPack, readOverrideManifests());
}
function getManifests() {
  if (!cache) cache = loadManifests();
  return cache;
}
var warned, cache;
var init_manifest_loader = __esm({
  "packages/daemon/src/tui/detect/manifest-loader.ts"() {
    "use strict";
    init_manifests();
    warned = /* @__PURE__ */ new Set();
  }
});

// packages/daemon/src/tui/detect/process-tree.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function parsePsOutput(raw) {
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/^\s+/, "");
    if (trimmed.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command2 = match[3] ?? "";
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || command2.length === 0) continue;
    entries.push({ pid, ppid, command: command2 });
  }
  return entries;
}
function subtreeCommands(entries, rootPid, maxDepth = 6) {
  return subtreeEntries(entries, rootPid, maxDepth).map((entry) => entry.command);
}
function subtreeEntries(entries, rootPid, maxDepth = 6) {
  const childrenByParent = /* @__PURE__ */ new Map();
  const byPid = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    byPid.set(entry.pid, entry);
    const siblings = childrenByParent.get(entry.ppid) ?? [];
    siblings.push(entry);
    childrenByParent.set(entry.ppid, siblings);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  const out = [];
  const visited = /* @__PURE__ */ new Set();
  const walk = (pid, depth) => {
    if (depth > maxDepth || visited.has(pid)) return;
    visited.add(pid);
    for (const child of childrenByParent.get(pid) ?? []) {
      walk(child.pid, depth + 1);
    }
    const self = byPid.get(pid);
    if (self) out.push(self);
  };
  walk(rootPid, 0);
  return out;
}
function describeSubtree(entries, rootPid, limit = 8) {
  const seen = [];
  for (const command2 of subtreeCommands(entries, rootPid)) {
    for (const token of commandTokens(command2)) {
      if (!seen.includes(token)) seen.push(token);
      if (seen.length >= limit) return seen;
    }
  }
  return seen;
}
function readProcessTable() {
  try {
    const raw = execFileSync2("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    return parsePsOutput(raw);
  } catch {
    return [];
  }
}
function commandTokens(command2) {
  const parts = command2.trim().split(/\s+/).filter(Boolean);
  const tokens = [];
  const argv0 = parts[0];
  if (argv0) tokens.push(basename4(argv0));
  const argv1 = parts[1];
  if (argv1 && !argv1.startsWith("-")) tokens.push(basename4(argv1));
  return tokens;
}
function basename4(pathLike) {
  const segments = pathLike.split("/");
  return segments[segments.length - 1] ?? pathLike;
}
function resolveAgentCommand(paneCmd, panePid, table, opts = {}) {
  const manifests = opts.manifests ?? getManifests();
  const hint = opts.hint?.trim();
  if (hint) {
    const hinted = pickManifest(hint, manifests);
    if (hinted) return { manifest: hinted, matchedCommand: hint, source: "hint" };
  }
  const fast = pickManifest(paneCmd, manifests);
  if (fast) return { manifest: fast, matchedCommand: paneCmd, source: "fast" };
  let best;
  for (const command2 of subtreeCommands(table, panePid)) {
    for (const token of commandTokens(command2)) {
      const hit = pickManifest(token, manifests);
      if (!hit) continue;
      const rank = manifests.indexOf(hit);
      if (!best || rank < best.rank) best = { manifest: hit, matchedCommand: token, rank };
      if (best.rank === 0)
        return { manifest: best.manifest, matchedCommand: best.matchedCommand, source: "tree" };
    }
  }
  return best ? { manifest: best.manifest, matchedCommand: best.matchedCommand, source: "tree" } : { manifest: void 0, matchedCommand: "", source: "none" };
}
var init_process_tree = __esm({
  "packages/daemon/src/tui/detect/process-tree.ts"() {
    "use strict";
    init_manifest();
    init_manifest_loader();
  }
});

// packages/daemon/src/tui/detect/snapshot.ts
function stripAnsi(input) {
  return input.replace(ANSI, "");
}
function parseSnapshot(raw, opts = {}) {
  const lines = opts.lines ?? DEFAULT_LINES;
  const text = stripAnsi(raw ?? "");
  const nonEmpty = text.split("\n").map((line) => line.replace(/\s+$/, "")).filter((line) => line.length > 0);
  const bottomNonEmpty = lines > 0 ? nonEmpty.slice(-lines) : [];
  return { bottomNonEmpty, text, raw: raw ?? "" };
}
function readPaneSnapshot(target, opts = {}) {
  const lines = opts.lines ?? DEFAULT_LINES;
  try {
    const raw = captureRecent(target, lines);
    return parseSnapshot(raw, { lines });
  } catch {
    return { bottomNonEmpty: [], text: "", raw: "" };
  }
}
var ANSI, DEFAULT_LINES;
var init_snapshot = __esm({
  "packages/daemon/src/tui/detect/snapshot.ts"() {
    "use strict";
    init_src2();
    ANSI = /[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
    DEFAULT_LINES = 20;
  }
});

// packages/daemon/src/tui/team/sessions.ts
var sessions_exports = {};
__export(sessions_exports, {
  SIDEBAR_PANE_OPTION: () => SIDEBAR_PANE_OPTION,
  agentMetadataFor: () => agentMetadataFor,
  buildAgentEntry: () => buildAgentEntry,
  excludeSidebarPanes: () => excludeSidebarPanes,
  isListableSession: () => isListableSession,
  listTeamSessions: () => listTeamSessions,
  rollupStatus: () => rollupStatus,
  rollupWindows: () => rollupWindows
});
import { execFileSync as execFileSync3 } from "node:child_process";
function buildAgentEntry(input) {
  const { manifest, pane } = input;
  if (!manifest || manifest.id === "shell") return null;
  return {
    paneId: pane.id,
    windowIndex: pane.windowIndex,
    session: input.sessionName,
    kind: manifest.id,
    state: input.state,
    confidence: manifest.confidence ?? "conservative",
    since: input.since,
    title: pane.title,
    command: pane.cmd,
    dir: pane.dir,
    ...input.statusText !== void 0 ? { statusText: input.statusText } : {},
    ...input.displayName !== void 0 ? { displayName: input.displayName } : {}
  };
}
function agentMetadataFor(pane, authorityFresh) {
  if (!authorityFresh) return {};
  const statusText = sanitizeAgentText(pane.statusTextRaw);
  const displayName = sanitizeAgentText(pane.displayNameRaw);
  return {
    ...statusText !== void 0 ? { statusText } : {},
    ...displayName !== void 0 ? { displayName } : {}
  };
}
function excludeSidebarPanes(panes) {
  return panes.filter((pane) => !pane.sidebar);
}
function isListableSession(name) {
  return !name.startsWith("_") && !name.startsWith("zz-");
}
function tmux(args) {
  try {
    return execFileSync3("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function listTeamSessions(tracker, opts = {}) {
  const raw = tmux([
    "list-sessions",
    "-F",
    "#{session_name}	#{session_attached}	#{session_windows}"
  ]);
  if (!raw) return [];
  const panesBySession = collectPanes();
  const processTable = readProcessTable();
  return raw.split("\n").filter(Boolean).filter((line) => isListableSession(line.split("	")[0] ?? "")).map((line) => {
    const [name = "", attached = "", windows = "0"] = line.split("	");
    const panes = excludeSidebarPanes(panesBySession.get(name) ?? []);
    const seen = opts.viewed === name;
    const nowSec = Math.floor(Date.now() / 1e3);
    const agents = [];
    const statuses = panes.map((pane) => {
      const authority = parseAuthority(pane.authority, nowSec);
      let status2;
      let manifest;
      let since = null;
      if (authority !== null) {
        since = parseAuthorityEpoch(pane.authority);
        if (authority === "done" && seen) {
          ackDone(pane.id, nowSec);
          status2 = "idle";
        } else {
          status2 = authority;
        }
        manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
          hint: pane.hint
        }).manifest;
      } else {
        manifest = resolveAgentCommand(pane.cmd, pane.pid, processTable, {
          hint: pane.hint
        }).manifest;
        const instant = manifest ? classifyInstant({ ...readPaneSnapshot(pane.id), title: pane.title }, manifest) : "unknown";
        status2 = tracker.update(pane.id, instant, { seen });
      }
      opts.onPane?.({
        sessionName: name,
        paneId: pane.id,
        agent: manifest && manifest.id !== "shell" ? manifest.id : null,
        status: status2,
        windowIndex: pane.windowIndex,
        pid: pane.pid,
        dir: pane.dir,
        sessionId: pane.sessionId.length > 0 ? pane.sessionId : null
      });
      const entry = buildAgentEntry({
        sessionName: name,
        pane,
        manifest,
        state: status2,
        since,
        ...agentMetadataFor(pane, authority !== null)
      });
      if (entry) agents.push(entry);
      return status2;
    });
    return {
      name,
      attached: attached === "1",
      windows: Number(windows) || 0,
      panes: panes.length,
      status: rollupStatus(statuses),
      // `panes` and `statuses` are parallel (statuses = panes.map(...)), so
      // the pure rollup can group each pane's window with its resolved status.
      windowList: rollupWindows(panes, statuses),
      agents
    };
  });
}
function collectPanes() {
  const raw = tmux([
    "list-panes",
    "-a",
    "-F",
    // Window fields + pane_current_path sit before pane_title so the (tab-safe)
    // title stays the trailing catch-all — window names/paths don't contain tabs
    // in practice. pane_current_path rides this SAME list-panes call (no extra
    // tmux round-trip) so per-pane agent entries can carry a working dir.
    // @agent_status_text/@agent_display_name ride the same caveat: the contract
    // (skill/SKILL.md) says plain text; a stamped tab would shift this one
    // pane's fields (sanitizeAgentText strips control chars AFTER the split).
    `#{session_name}	#{pane_id}	#{pane_pid}	#{pane_current_command}	#{@agent_state}	#{@agent_hint}	#{@agent_session_id}	#{@agent_status_text}	#{@agent_display_name}	#{${SIDEBAR_PANE_OPTION}}	#{window_index}	#{window_name}	#{window_active}	#{pane_current_path}	#{pane_title}`
  ]);
  const bySession = /* @__PURE__ */ new Map();
  for (const line of raw.split("\n").filter(Boolean)) {
    const [
      session = "",
      id = "",
      pid = "",
      cmd = "",
      authority = "",
      hint = "",
      sessionId = "",
      statusTextRaw = "",
      displayNameRaw = "",
      sidebar = "",
      windowIndex = "0",
      windowName = "",
      windowActive = "0",
      dir = "",
      ...titleParts
    ] = line.split("	");
    if (!session) continue;
    const list = bySession.get(session) ?? [];
    list.push({
      id,
      pid: Number(pid) || 0,
      cmd,
      authority,
      hint,
      sessionId,
      statusTextRaw,
      displayNameRaw,
      sidebar: sidebar === "1",
      windowIndex: Number(windowIndex) || 0,
      windowName,
      windowActive: windowActive === "1",
      dir,
      title: titleParts.join("	")
    });
    bySession.set(session, list);
  }
  return bySession;
}
function ackDone(paneId, nowSec) {
  tmux(["set-option", "-p", "-t", paneId, "@agent_state", `idle:${nowSec}`]);
}
function rollupStatus(statuses) {
  if (statuses.length === 0) return "idle";
  const present = new Set(statuses);
  for (const status2 of SEVERITY) {
    if (present.has(status2)) return status2;
  }
  return "unknown";
}
function rollupWindows(panes, statuses) {
  const byIndex = /* @__PURE__ */ new Map();
  panes.forEach((pane, i) => {
    let entry = byIndex.get(pane.windowIndex);
    if (!entry) {
      entry = { name: pane.windowName, active: false, statuses: [] };
      byIndex.set(pane.windowIndex, entry);
    }
    if (pane.windowActive) entry.active = true;
    const status2 = statuses[i];
    if (status2) entry.statuses.push(status2);
  });
  return [...byIndex.entries()].sort(([a], [b]) => a - b).map(([index, entry]) => ({
    index,
    name: entry.name,
    active: entry.active,
    panes: entry.statuses.length,
    status: rollupStatus(entry.statuses)
  }));
}
var SIDEBAR_PANE_OPTION, SEVERITY;
var init_sessions2 = __esm({
  "packages/daemon/src/tui/team/sessions.ts"() {
    "use strict";
    init_classify();
    init_process_tree();
    init_snapshot();
    SIDEBAR_PANE_OPTION = "@tmux_ide_sidebar";
    SEVERITY = ["blocked", "working", "done", "idle", "unknown"];
  }
});

// packages/daemon/src/lib/legacy-theme-compat.ts
function legacyThemeOverrideProvenance(explicitIds = /* @__PURE__ */ new Set()) {
  return Object.freeze(
    Object.fromEntries(LEGACY_THEME_OVERRIDE_IDS.map((id) => [id, explicitIds.has(id)]))
  );
}
var LEGACY_THEME_OVERRIDE_IDS, LEGACY_THEME_OVERRIDE_PROVENANCE;
var init_legacy_theme_compat = __esm({
  "packages/daemon/src/lib/legacy-theme-compat.ts"() {
    "use strict";
    LEGACY_THEME_OVERRIDE_IDS = [
      "accent",
      "muted",
      "fg",
      "status.blocked",
      "status.working",
      "status.done",
      "status.idle",
      "status.unknown",
      "glyphs.active",
      "glyphs.inactive"
    ];
    LEGACY_THEME_OVERRIDE_PROVENANCE = /* @__PURE__ */ Symbol.for(
      "tmux-ide.legacy-theme-override-provenance"
    );
  }
});

// packages/daemon/src/lib/app-config.ts
var app_config_exports = {};
__export(app_config_exports, {
  DEFAULT_APP_CONFIG: () => DEFAULT_APP_CONFIG,
  DEFAULT_KEYS: () => DEFAULT_KEYS,
  DEFAULT_THEME: () => DEFAULT_THEME,
  _resetForTests: () => _resetForTests,
  appConfigPath: () => appConfigPath,
  getAppConfig: () => getAppConfig,
  loadAppConfig: () => loadAppConfig,
  loadRawAppConfig: () => loadRawAppConfig,
  mergeConfigPatch: () => mergeConfigPatch,
  parseAppConfig: () => parseAppConfig,
  updateAppConfig: () => updateAppConfig
});
import { existsSync as existsSync5, mkdirSync as mkdirSync2, readFileSync as readFileSync5, renameSync as renameSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname5, join as join5 } from "node:path";
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function pickString(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function pickPosInt(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
function pickNonNegInt(value, fallback) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}
function pickChoice(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}
function isExplicitString(value) {
  return typeof value === "string" && value.length > 0;
}
function appThemeOverrideProvenance(theme, status2, glyphs) {
  const explicit = /* @__PURE__ */ new Set();
  if (isExplicitString(theme.accent)) explicit.add("accent");
  if (isExplicitString(theme.muted)) explicit.add("muted");
  if (isExplicitString(theme.fg)) explicit.add("fg");
  for (const id of ["blocked", "working", "done", "idle", "unknown"]) {
    if (isExplicitString(status2[id])) explicit.add(`status.${id}`);
  }
  for (const id of ["active", "inactive"]) {
    if (isExplicitString(glyphs[id])) explicit.add(`glyphs.${id}`);
  }
  return legacyThemeOverrideProvenance(explicit);
}
function parseAppConfig(input) {
  const D = DEFAULT_APP_CONFIG;
  const root = asObject(input);
  const keys = asObject(root.keys);
  const panels = asObject(keys.panels);
  const theme = asObject(root.theme);
  const status2 = asObject(theme.status);
  const glyphs = asObject(theme.glyphs);
  const updater = asObject(root.updater);
  const notifications = asObject(root.notifications);
  const restore2 = asObject(root.restore);
  const updates = asObject(root.updates);
  const welcome = asObject(root.welcome);
  const integrations = asObject(root.integrations);
  const worktrees = asObject(root.worktrees);
  const app = asObject(root.app);
  return {
    keys: {
      popup: pickString(keys.popup, D.keys.popup),
      home: pickString(keys.home, D.keys.home),
      cheatsheet: pickString(keys.cheatsheet, D.keys.cheatsheet),
      menu: pickString(keys.menu, D.keys.menu),
      sidebar: pickString(keys.sidebar, D.keys.sidebar),
      panels: {
        explorer: pickString(panels.explorer, D.keys.panels.explorer),
        changes: pickString(panels.changes, D.keys.panels.changes),
        config: pickString(panels.config, D.keys.panels.config)
      }
    },
    theme: {
      mode: pickChoice(theme.mode, ["dark", "light", "system"], D.theme.mode),
      accent: pickString(theme.accent, D.theme.accent),
      muted: pickString(theme.muted, D.theme.muted),
      fg: pickString(theme.fg, D.theme.fg),
      status: {
        blocked: pickString(status2.blocked, D.theme.status.blocked),
        working: pickString(status2.working, D.theme.status.working),
        done: pickString(status2.done, D.theme.status.done),
        idle: pickString(status2.idle, D.theme.status.idle),
        unknown: pickString(status2.unknown, D.theme.status.unknown)
      },
      glyphs: {
        active: pickString(glyphs.active, D.theme.glyphs.active),
        inactive: pickString(glyphs.inactive, D.theme.glyphs.inactive)
      },
      [LEGACY_THEME_OVERRIDE_PROVENANCE]: appThemeOverrideProvenance(theme, status2, glyphs)
    },
    updater: {
      tickMs: pickPosInt(updater.tickMs, D.updater.tickMs),
      snapshotEvery: pickPosInt(updater.snapshotEvery, D.updater.snapshotEvery)
    },
    notifications: {
      toast: pickBool(notifications.toast, D.notifications.toast),
      macos: pickBool(notifications.macos, D.notifications.macos),
      terminal: pickBool(notifications.terminal, D.notifications.terminal),
      delaySeconds: pickNonNegInt(notifications.delaySeconds, D.notifications.delaySeconds),
      sound: pickChoice(notifications.sound, ["blocked", "all", "none"], D.notifications.sound)
    },
    restore: { resumeAgents: pickBool(restore2.resumeAgents, D.restore.resumeAgents) },
    updates: {
      check: pickBool(updates.check, D.updates.check),
      manifests: pickBool(updates.manifests, D.updates.manifests)
    },
    welcome: { show: pickBool(welcome.show, D.welcome.show) },
    integrations: { offer: pickBool(integrations.offer, D.integrations.offer) },
    worktrees: { dir: pickString(worktrees.dir, D.worktrees.dir) },
    app: {
      frontDoor: pickBool(app.frontDoor, D.app.frontDoor),
      detachable: pickBool(app.detachable, D.app.detachable),
      dragSelect: pickChoice(app.dragSelect, ["agents", "always", "never"], D.app.dragSelect),
      newAgentCwd: pickChoice(app.newAgentCwd, ["pane", "session"], D.app.newAgentCwd),
      kittyKeys: pickBool(app.kittyKeys, D.app.kittyKeys)
    }
  };
}
function appConfigPath() {
  return process.env.TMUX_IDE_CONFIG ?? join5(homedir2(), ".tmux-ide", "config.json");
}
function loadAppConfig() {
  const path2 = appConfigPath();
  if (!existsSync5(path2)) return parseAppConfig(void 0);
  try {
    return parseAppConfig(JSON.parse(readFileSync5(path2, "utf-8")));
  } catch {
    return parseAppConfig(void 0);
  }
}
function getAppConfig() {
  if (!cached) cached = loadAppConfig();
  return cached;
}
function _resetForTests() {
  cached = null;
}
function loadRawAppConfig() {
  const path2 = appConfigPath();
  if (!existsSync5(path2)) return {};
  try {
    const parsed = JSON.parse(readFileSync5(path2, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function isPlainObject2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function mergeConfigPatch(raw, patch) {
  const out = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === void 0) {
      delete out[key];
    } else if (isPlainObject2(value) && isPlainObject2(out[key])) {
      out[key] = mergeConfigPatch(out[key], value);
    } else if (isPlainObject2(value)) {
      out[key] = mergeConfigPatch({}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
function updateAppConfig(patch) {
  const path2 = appConfigPath();
  const merged = mergeConfigPatch(loadRawAppConfig(), patch);
  mkdirSync2(dirname5(path2), { recursive: true });
  const tmp = `${path2}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync2(tmp, `${JSON.stringify(merged, null, 2)}
`, "utf-8");
  renameSync2(tmp, path2);
  cached = null;
  return parseAppConfig(merged);
}
var DEFAULT_APP_CONFIG, DEFAULT_THEME, DEFAULT_KEYS, cached;
var init_app_config = __esm({
  "packages/daemon/src/lib/app-config.ts"() {
    "use strict";
    init_legacy_theme_compat();
    DEFAULT_APP_CONFIG = {
      keys: {
        popup: "M-p",
        home: "M-h",
        cheatsheet: "M-k",
        menu: "M-m",
        sidebar: "M-b",
        panels: { explorer: "M-e", changes: "M-g", config: "M-," }
      },
      theme: {
        mode: "dark",
        accent: "colour75",
        muted: "colour240",
        fg: "colour250",
        status: {
          blocked: "colour203",
          working: "colour221",
          done: "colour111",
          idle: "colour114",
          unknown: "colour244"
        },
        glyphs: { active: "\u25CF", inactive: "\u25CB" },
        [LEGACY_THEME_OVERRIDE_PROVENANCE]: legacyThemeOverrideProvenance()
      },
      updater: { tickMs: 2e3, snapshotEvery: 15 },
      notifications: { toast: true, macos: false, terminal: true, delaySeconds: 2, sound: "blocked" },
      restore: { resumeAgents: false },
      updates: { check: true, manifests: false },
      welcome: { show: true },
      integrations: { offer: true },
      worktrees: { dir: "" },
      app: {
        frontDoor: false,
        detachable: false,
        dragSelect: "agents",
        newAgentCwd: "pane",
        kittyKeys: true
      }
    };
    DEFAULT_THEME = DEFAULT_APP_CONFIG.theme;
    DEFAULT_KEYS = DEFAULT_APP_CONFIG.keys;
    cached = null;
  }
});

// packages/daemon/src/lib/manifest-pack.ts
var manifest_pack_exports = {};
__export(manifest_pack_exports, {
  MANIFEST_PACK_ASSET: () => MANIFEST_PACK_ASSET,
  MANIFEST_PACK_SCHEMA: () => MANIFEST_PACK_SCHEMA,
  MANIFEST_PACK_URL_ENV: () => MANIFEST_PACK_URL_ENV,
  fetchManifestPack: () => fetchManifestPack,
  installManifestPack: () => installManifestPack,
  isAllowedPackUrl: () => isAllowedPackUrl,
  manifestPackUrl: () => manifestPackUrl,
  maybeRefreshManifestPack: () => maybeRefreshManifestPack,
  packDir: () => packDir,
  packPath: () => packPath,
  updateManifestPack: () => updateManifestPack,
  validateManifestPack: () => validateManifestPack
});
import { mkdirSync as mkdirSync3, readFileSync as readFileSync6, renameSync as renameSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname6, join as join6 } from "node:path";
import { fileURLToPath } from "node:url";
function manifestPackUrl(version = getCurrentVersion()) {
  const v = version.startsWith("v") ? version.slice(1) : version;
  return `https://github.com/${RELEASE_REPO}/releases/download/v${v}/${MANIFEST_PACK_ASSET}`;
}
function isAllowedPackUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:" || parsed.protocol === "file:") return true;
  if (parsed.protocol === "http:") {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  }
  return false;
}
function validateManifestPack(value) {
  if (typeof value !== "object" || value === null) return { ok: false, reason: "not an object" };
  const v = value;
  if (v.schema !== MANIFEST_PACK_SCHEMA) {
    return {
      ok: false,
      reason: `unsupported schema ${JSON.stringify(v.schema)} (want ${MANIFEST_PACK_SCHEMA})`
    };
  }
  if (typeof v.pack !== "string" || v.pack.trim().length === 0) {
    return { ok: false, reason: "missing pack version string" };
  }
  if (!Array.isArray(v.manifests) || v.manifests.length === 0) {
    return { ok: false, reason: "manifests must be a non-empty array" };
  }
  for (let i = 0; i < v.manifests.length; i++) {
    if (!validateManifestShape(v.manifests[i])) {
      return {
        ok: false,
        reason: `manifests[${i}] is not a valid AgentManifest (need id, commands[], states)`
      };
    }
  }
  return {
    ok: true,
    pack: { schema: MANIFEST_PACK_SCHEMA, pack: v.pack, manifests: v.manifests }
  };
}
function packDir() {
  return join6(overrideDir(), "pack");
}
function packPath() {
  return join6(packDir(), "manifest-pack.json");
}
async function fetchManifestPack(url, timeoutMs = 5e3) {
  if (!isAllowedPackUrl(url)) {
    throw new Error(
      `refusing manifest-pack URL ${url} \u2014 https only (file:// and loopback http are allowed for local testing)`
    );
  }
  let body;
  if (url.startsWith("file:")) {
    body = readFileSync6(fileURLToPath(url), "utf8");
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(
          `manifest-pack download failed (${url} \u2192 HTTP ${res.status} ${res.statusText})`
        );
      }
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`manifest pack at ${url} is not valid JSON`);
  }
  const verdict = validateManifestPack(parsed);
  if (!verdict.ok) {
    throw new Error(`manifest pack at ${url} rejected: ${verdict.reason}`);
  }
  return verdict.pack;
}
function installManifestPack(pack, dest = packPath()) {
  mkdirSync3(dirname6(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync3(tmp, JSON.stringify(pack, null, 2));
  renameSync3(tmp, dest);
  return dest;
}
async function updateManifestPack(opts = {}) {
  const log = opts.log ?? (() => {
  });
  const url = opts.url ?? process.env[MANIFEST_PACK_URL_ENV] ?? manifestPackUrl();
  log(`fetching manifest pack from ${url}`);
  const pack = await fetchManifestPack(url);
  const path2 = installManifestPack(pack);
  log(`installed pack ${pack.pack} (${pack.manifests.length} manifests) \u2192 ${path2}`);
  return { path: path2, packVersion: pack.pack, count: pack.manifests.length };
}
async function maybeRefreshManifestPack() {
  try {
    if (!getAppConfig().updates.manifests) return;
    await updateManifestPack();
  } catch {
  }
}
var MANIFEST_PACK_SCHEMA, MANIFEST_PACK_ASSET, MANIFEST_PACK_URL_ENV;
var init_manifest_pack = __esm({
  "packages/daemon/src/lib/manifest-pack.ts"() {
    "use strict";
    init_manifest_loader();
    init_app_config();
    init_update_check();
    init_tui_binary();
    MANIFEST_PACK_SCHEMA = 1;
    MANIFEST_PACK_ASSET = "agent-manifests.json";
    MANIFEST_PACK_URL_ENV = "TMUX_IDE_MANIFEST_PACK_URL";
  }
});

// packages/daemon/src/lib/update-check.ts
var update_check_exports = {};
__export(update_check_exports, {
  CHECK_INTERVAL_MS: () => CHECK_INTERVAL_MS,
  REGISTRY_URL: () => REGISTRY_URL,
  compareSemver: () => compareSemver,
  deriveStatus: () => deriveStatus,
  fetchLatestVersion: () => fetchLatestVersion,
  getCurrentVersion: () => getCurrentVersion,
  getUpdateStatus: () => getUpdateStatus,
  isNewer: () => isNewer,
  markUpdateNotified: () => markUpdateNotified,
  maybeCheckForUpdate: () => maybeCheckForUpdate,
  parseRegistryResponse: () => parseRegistryResponse,
  readUpdateCache: () => readUpdateCache,
  runUpdateCheck: () => runUpdateCheck,
  shouldCheck: () => shouldCheck,
  updateCachePath: () => updateCachePath,
  writeUpdateCache: () => writeUpdateCache
});
import { existsSync as existsSync6, mkdirSync as mkdirSync4, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname7, join as join7 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
function parseSemver(version) {
  const core = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const dash = core.indexOf("-");
  const main = dash === -1 ? core : core.slice(0, dash);
  const pre = dash === -1 ? "" : core.slice(dash + 1);
  const parts = main.split(".");
  const num = (i) => {
    const n = Number.parseInt(parts[i] ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return { nums: [num(0), num(1), num(2)], pre };
}
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
function isNewer(latest, current) {
  return compareSemver(latest, current) === 1;
}
function shouldCheck(lastCheckedAt, nowMs) {
  if (lastCheckedAt === null) return true;
  return nowMs - lastCheckedAt >= CHECK_INTERVAL_MS;
}
function parseRegistryResponse(json2) {
  try {
    const parsed = JSON.parse(json2);
    if (!parsed || typeof parsed !== "object") return null;
    const version = parsed.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
function deriveStatus(latest, currentVersion) {
  return {
    latest,
    updateAvailable: latest !== null && isNewer(latest, currentVersion)
  };
}
function updateCachePath() {
  const home = process.env.TMUX_IDE_HOME ?? join7(homedir3(), ".tmux-ide");
  return join7(home, "update-check.json");
}
function readUpdateCache() {
  const path2 = updateCachePath();
  if (!existsSync6(path2)) return null;
  try {
    const parsed = JSON.parse(readFileSync7(path2, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed;
    const lastCheckedAt = typeof obj.lastCheckedAt === "number" ? obj.lastCheckedAt : null;
    const latest = typeof obj.latest === "string" && obj.latest.length > 0 ? obj.latest : null;
    const notified = Array.isArray(obj.notified) ? obj.notified.filter((v) => typeof v === "string") : void 0;
    return { lastCheckedAt, latest, ...notified ? { notified } : {} };
  } catch {
    return null;
  }
}
function writeUpdateCache(cache3) {
  const path2 = updateCachePath();
  try {
    mkdirSync4(dirname7(path2), { recursive: true });
    writeFileSync4(path2, JSON.stringify(cache3));
  } catch {
  }
}
async function fetchLatestVersion(timeoutMs = 3e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    return parseRegistryResponse(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function getCurrentVersion() {
  const here = dirname7(fileURLToPath2(import.meta.url));
  const candidates = [
    join7(here, "../package.json"),
    // bundled bin/cli.js → repo root
    join7(here, "../../../../package.json")
    // dev src/lib → repo root
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync7(candidate, "utf-8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
    } catch {
    }
  }
  return "0.0.0";
}
function getUpdateStatus({
  currentVersion = getCurrentVersion()
} = {}) {
  const cache3 = readUpdateCache();
  return deriveStatus(cache3?.latest ?? null, currentVersion);
}
async function runUpdateCheck({ now = Date.now() } = {}) {
  const cache3 = readUpdateCache();
  if (!shouldCheck(cache3?.lastCheckedAt ?? null, now)) return;
  void Promise.resolve().then(() => (init_manifest_pack(), manifest_pack_exports)).then((m) => m.maybeRefreshManifestPack()).catch(() => {
  });
  const fetched = await fetchLatestVersion();
  writeUpdateCache({
    lastCheckedAt: now,
    latest: fetched ?? cache3?.latest ?? null,
    ...cache3?.notified ? { notified: cache3.notified } : {}
  });
}
function maybeCheckForUpdate({
  enabled,
  now = Date.now(),
  currentVersion = getCurrentVersion()
}) {
  if (!enabled) return { latest: null, updateAvailable: false };
  const status2 = getUpdateStatus({ now, currentVersion });
  void runUpdateCheck({ now }).catch(() => {
  });
  return status2;
}
function markUpdateNotified(version) {
  const cache3 = readUpdateCache() ?? { lastCheckedAt: null, latest: null };
  const notified = cache3.notified ?? [];
  if (notified.includes(version)) return false;
  writeUpdateCache({ ...cache3, notified: [...notified, version] });
  return true;
}
var REGISTRY_URL, CHECK_INTERVAL_MS;
var init_update_check = __esm({
  "packages/daemon/src/lib/update-check.ts"() {
    "use strict";
    REGISTRY_URL = "https://registry.npmjs.org/tmux-ide/latest";
    CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
  }
});

// packages/daemon/src/lib/tui-binary.ts
var tui_binary_exports = {};
__export(tui_binary_exports, {
  MIN_TUI_BINARY_BYTES: () => MIN_TUI_BINARY_BYTES,
  RELEASE_REPO: () => RELEASE_REPO,
  bunTargetForTag: () => bunTargetForTag,
  downloadTuiBinary: () => downloadTuiBinary,
  downloadedTuiPath: () => downloadedTuiPath,
  findDownloadedTui: () => findDownloadedTui,
  normalizeVersion: () => normalizeVersion,
  releaseAssetName: () => releaseAssetName,
  releaseAssetUrl: () => releaseAssetUrl,
  tuiPlatformTag: () => tuiPlatformTag,
  tuiStateHome: () => tuiStateHome
});
import { chmodSync, existsSync as existsSync7, mkdirSync as mkdirSync5, renameSync as renameSync4, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { dirname as dirname8, join as join8 } from "node:path";
import { gunzipSync } from "node:zlib";
function tuiPlatformTag(platform = process.platform, arch = process.arch) {
  return SUPPORTED[`${platform}-${arch}`] ?? null;
}
function bunTargetForTag(tag) {
  return `bun-${tag}`;
}
function releaseAssetName(tag) {
  return `tmux-ide-tui-${tag}.gz`;
}
function normalizeVersion(version) {
  return version.startsWith("v") ? version.slice(1) : version;
}
function releaseAssetUrl(version, tag) {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${normalizeVersion(version)}/${releaseAssetName(tag)}`;
}
function downloadedTuiPath(home, tag, version) {
  return join8(home, "bin", `tmux-ide-tui-${tag}-${normalizeVersion(version)}`);
}
function tuiStateHome() {
  return process.env.TMUX_IDE_HOME ?? join8(homedir4(), ".tmux-ide");
}
function findDownloadedTui(version = getCurrentVersion()) {
  const tag = tuiPlatformTag();
  if (!tag) return null;
  const path2 = downloadedTuiPath(tuiStateHome(), tag, version);
  return existsSync7(path2) ? path2 : null;
}
async function downloadTuiBinary(opts = {}) {
  const log = opts.log ?? (() => {
  });
  const version = normalizeVersion(opts.version ?? getCurrentVersion());
  const tag = tuiPlatformTag();
  if (!tag) {
    throw new Error(
      `no prebuilt TUI binary is published for ${process.platform}-${process.arch} \u2014 install bun (https://bun.sh) to run the TUI surfaces from source instead`
    );
  }
  const url = releaseAssetUrl(version, tag);
  const dest = downloadedTuiPath(tuiStateHome(), tag, version);
  mkdirSync5(dirname8(dest), { recursive: true });
  log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `could not download the TUI binary (${url} \u2192 HTTP ${res.status} ${res.statusText}). Check that release v${version} exists and published its assets.`
    );
  }
  const gz = Buffer.from(await res.arrayBuffer());
  const bin = gunzipSync(gz);
  if (bin.byteLength < MIN_TUI_BINARY_BYTES) {
    throw new Error(
      `the downloaded TUI binary is only ${bin.byteLength} bytes (expected >10MB) \u2014 treating it as corrupt and leaving the previous binary (if any) in place`
    );
  }
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync5(tmp, bin, { mode: 493 });
  chmodSync(tmp, 493);
  renameSync4(tmp, dest);
  const mb = (bin.byteLength / 1024 / 1024).toFixed(1);
  log(`installed ${dest} (${mb} MB)`);
  return { path: dest, bytes: bin.byteLength };
}
var RELEASE_REPO, MIN_TUI_BINARY_BYTES, SUPPORTED;
var init_tui_binary = __esm({
  "packages/daemon/src/lib/tui-binary.ts"() {
    "use strict";
    init_update_check();
    RELEASE_REPO = "wavyrai/tmux-ide";
    MIN_TUI_BINARY_BYTES = 10 * 1024 * 1024;
    SUPPORTED = {
      "darwin-arm64": "darwin-arm64",
      "darwin-x64": "darwin-x64",
      "linux-x64": "linux-x64",
      "linux-arm64": "linux-arm64"
    };
  }
});

// packages/daemon/src/tui/compiled.ts
import { existsSync as existsSync8 } from "node:fs";
import { dirname as dirname9, resolve as resolve7 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { execFileSync as execFileSync4 } from "node:child_process";
function resolveTuiLaunch(input) {
  if (input.checkoutExists && input.bunAvailable) {
    return { mode: "bun", bin: "bun", argv: [input.scriptPath, ...input.args] };
  }
  if (input.compiledBinary) {
    return { mode: "binary", bin: input.compiledBinary, argv: [input.surface, ...input.args] };
  }
  const reasons = [];
  if (!input.checkoutExists) {
    reasons.push(
      "the TUI widget sources are absent (reinstall tmux-ide \u2014 releases since v2.6.1 ship them)"
    );
  }
  if (!input.bunAvailable) {
    reasons.push("the `bun` runtime is not installed (https://bun.sh)");
  }
  reasons.push(
    "no compiled `tmux-ide-tui` binary was found (build one with `pnpm build:tui`, download it with `tmux-ide update --tui-binary`, or reinstall a release that ships it)"
  );
  return { mode: "unavailable", reasons };
}
function findCompiledTui() {
  const override = process.env.TMUX_IDE_TUI_BIN;
  if (override) return existsSync8(override) ? override : null;
  const anchors = [];
  if (process.argv[1]) anchors.push(dirname9(process.argv[1]));
  anchors.push(__dirname);
  for (const anchor of anchors) {
    for (const rel of BINARY_RELS) {
      const candidate = resolve7(anchor, rel);
      if (existsSync8(candidate)) return candidate;
    }
  }
  return findDownloadedTui();
}
function isBunAvailable() {
  try {
    execFileSync4("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
var __dirname, BINARY_RELS;
var init_compiled = __esm({
  "packages/daemon/src/tui/compiled.ts"() {
    "use strict";
    init_tui_binary();
    __dirname = dirname9(fileURLToPath3(import.meta.url));
    BINARY_RELS = [
      "../packages/daemon/dist/tui/tmux-ide-tui",
      "../../dist/tui/tmux-ide-tui",
      "../dist/tui/tmux-ide-tui",
      "dist/tui/tmux-ide-tui",
      "tmux-ide-tui"
    ];
  }
});

// packages/daemon/src/tui/chrome/sidebar.ts
var sidebar_exports = {};
__export(sidebar_exports, {
  DEFAULT_SIDEBAR_WIDTH: () => DEFAULT_SIDEBAR_WIDTH,
  SIDEBAR_KEY: () => SIDEBAR_KEY,
  SIDEBAR_PANE_OPTION: () => SIDEBAR_PANE_OPTION,
  closeSidebarPane: () => closeSidebarPane,
  findSidebarPane: () => findSidebarPane,
  openSidebarPane: () => openSidebarPane,
  parseSidebarWidth: () => parseSidebarWidth,
  resolveSidebarConfig: () => resolveSidebarConfig,
  sidebarSplitCommand: () => sidebarSplitCommand,
  sidebarToggleBindCommand: () => sidebarToggleBindCommand,
  sidebarToggleUnbindCommand: () => sidebarToggleUnbindCommand,
  sidebarWidgetCommand: () => sidebarWidgetCommand,
  sidebarWidgetScript: () => sidebarWidgetScript
});
import { existsSync as existsSync9 } from "node:fs";
import { dirname as dirname10, resolve as resolve8 } from "node:path";
import { fileURLToPath as fileURLToPath4 } from "node:url";
function sidebarWidgetScript() {
  const candidates = [
    resolve8(__dirname2, "../../widgets/sidebar/index.tsx"),
    resolve8(__dirname2, "../packages/daemon/src/widgets/sidebar/index.tsx")
  ];
  return candidates.find((p) => existsSync9(p)) ?? candidates[0];
}
function sidebarWidgetCommand(scriptPath, session, dir, theme) {
  const args = [`--session=${session}`, `--dir=${dir}`];
  if (theme) args.push(`--theme=${JSON.stringify(theme)}`);
  const launch2 = resolveTuiLaunch({
    surface: "sidebar",
    scriptPath,
    args,
    checkoutExists: existsSync9(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    return `cd ${shellEscape(dir)} && bun ${shellEscape(scriptPath)} ${args.map(shellEscape).join(" ")}`;
  }
  const escaped = launch2.argv.map(shellEscape).join(" ");
  return `cd ${shellEscape(dir)} && ${shellEscape(launch2.bin)} ${escaped}`;
}
function resolveSidebarConfig(raw) {
  if (raw === true) return { enabled: true, width: DEFAULT_SIDEBAR_WIDTH };
  if (!raw || typeof raw !== "object") return { enabled: false, width: DEFAULT_SIDEBAR_WIDTH };
  const width = parseSidebarWidth(raw.width);
  return { enabled: true, width };
}
function parseSidebarWidth(value) {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(10, Math.floor(n));
}
function sidebarToggleBindCommand(cli = "tmux-ide sidebar-toggle", key = SIDEBAR_KEY) {
  return ["bind-key", "-n", key, "run-shell", `${cli} --session '#{session_name}'`];
}
function sidebarToggleUnbindCommand(key = SIDEBAR_KEY) {
  return ["unbind-key", "-n", key];
}
function sidebarSplitCommand(session, dir, width, widgetCmd) {
  return [
    "split-window",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    session,
    "-h",
    "-b",
    "-f",
    "-l",
    String(width),
    "-c",
    dir,
    widgetCmd
  ];
}
function findSidebarPane(session) {
  try {
    const raw = runTmux(
      ["list-panes", "-t", session, "-F", `#{pane_id}	#{${SIDEBAR_PANE_OPTION}}`],
      { encoding: "utf-8" }
    ).toString().trim();
    for (const line of raw.split("\n").filter(Boolean)) {
      const [id = "", flag = ""] = line.split("	");
      if (flag === "1" && id) return id;
    }
  } catch {
  }
  return null;
}
function openSidebarPane(session, dir, width, theme) {
  const widgetCmd = sidebarWidgetCommand(sidebarWidgetScript(), session, dir, theme);
  const paneId = runTmux(sidebarSplitCommand(session, dir, width, widgetCmd), {
    encoding: "utf-8"
  }).toString().trim();
  runTmux(["set-option", "-pqt", paneId, SIDEBAR_PANE_OPTION, "1"]);
  runTmux(["select-pane", "-t", paneId, "-T", "sidebar"]);
  return paneId;
}
function closeSidebarPane(paneId) {
  runTmux(["kill-pane", "-t", paneId]);
}
var __dirname2, SIDEBAR_KEY, DEFAULT_SIDEBAR_WIDTH;
var init_sidebar = __esm({
  "packages/daemon/src/tui/chrome/sidebar.ts"() {
    "use strict";
    init_src2();
    init_shell();
    init_sessions2();
    init_compiled();
    __dirname2 = dirname10(fileURLToPath4(import.meta.url));
    SIDEBAR_KEY = "M-b";
    DEFAULT_SIDEBAR_WIDTH = 30;
  }
});

// packages/daemon/src/widgets/resolve.ts
var resolve_exports = {};
__export(resolve_exports, {
  WIDGET_TYPES: () => WIDGET_TYPES,
  resolveWidgetCommand: () => resolveWidgetCommand,
  resolveWidgetSpawn: () => resolveWidgetSpawn
});
import { resolve as resolve9, dirname as dirname11 } from "node:path";
import { existsSync as existsSync10 } from "node:fs";
import { fileURLToPath as fileURLToPath5 } from "node:url";
function widgetEntryPath(entry) {
  const sibling = resolve9(__dirname3, entry);
  if (existsSync10(sibling)) return sibling;
  return resolve9(__dirname3, "../packages/daemon/src/widgets", entry);
}
function widgetArgs(opts) {
  const args = [`--session=${opts.session}`, `--dir=${opts.dir}`];
  if (opts.target) args.push(`--target=${opts.target}`);
  if (opts.theme) args.push(`--theme=${JSON.stringify(opts.theme)}`);
  return args;
}
function resolveWidgetCommand(type, opts) {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);
  const scriptPath = widgetEntryPath(entry);
  const launch2 = resolveTuiLaunch({
    surface: type,
    scriptPath,
    args: widgetArgs(opts),
    checkoutExists: existsSync10(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new Error(`Cannot launch ${type} widget: ${launch2.reasons.join("; ")}`);
  }
  const escapedArgs = launch2.argv.map(shellEscape).join(" ");
  if (launch2.mode === "bun") {
    return `cd ${shellEscape(REPO_ROOT)} && bun ${escapedArgs}`;
  }
  return `cd ${shellEscape(opts.dir)} && ${shellEscape(launch2.bin)} ${escapedArgs}`;
}
function resolveWidgetSpawn(type, opts) {
  const entry = WIDGET_ENTRY_POINTS[type];
  if (!entry) throw new Error(`Unknown widget type: ${type}`);
  const scriptPath = widgetEntryPath(entry);
  const launch2 = resolveTuiLaunch({
    surface: type,
    scriptPath,
    args: widgetArgs(opts),
    checkoutExists: existsSync10(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new Error(`Cannot launch ${type} widget: ${launch2.reasons.join("; ")}`);
  }
  const cwd = launch2.mode === "bun" ? REPO_ROOT : opts.dir;
  return { cwd, cmd: [launch2.bin, ...launch2.argv] };
}
var __dirname3, WIDGET_ENTRY_POINTS, REPO_ROOT, WIDGET_TYPES;
var init_resolve = __esm({
  "packages/daemon/src/widgets/resolve.ts"() {
    "use strict";
    init_shell();
    init_compiled();
    __dirname3 = dirname11(fileURLToPath5(import.meta.url));
    WIDGET_ENTRY_POINTS = {
      explorer: "explorer/index.tsx",
      changes: "changes/index.tsx",
      preview: "preview/index.tsx",
      setup: "setup/index.tsx",
      config: "config/index.tsx",
      sidebar: "sidebar/index.tsx"
    };
    REPO_ROOT = existsSync10(resolve9(__dirname3, "explorer/index.tsx")) ? resolve9(__dirname3, "../../../..") : resolve9(__dirname3, "..");
    WIDGET_TYPES = Object.keys(WIDGET_ENTRY_POINTS);
  }
});

// packages/daemon/src/tui/team/keymap.ts
import { existsSync as existsSync11, readFileSync as readFileSync8 } from "node:fs";
import { homedir as homedir5 } from "node:os";
import { join as join9 } from "node:path";
var ACTION_ORDER, DEFAULT_KEYMAP;
var init_keymap = __esm({
  "packages/daemon/src/tui/team/keymap.ts"() {
    "use strict";
    ACTION_ORDER = [
      "up",
      "down",
      "enter",
      "launch",
      "new",
      "rename",
      "split",
      "register",
      "unregister",
      "kill",
      "filter",
      "refresh",
      "help",
      "quit"
    ];
    DEFAULT_KEYMAP = {
      up: { keys: ["up", "k"], description: "move up" },
      down: { keys: ["down", "j"], description: "move down" },
      enter: { keys: ["return"], description: "launch / attach" },
      launch: { keys: ["l"], description: "launch project" },
      new: { keys: ["n"], description: "new session" },
      rename: { keys: ["R"], description: "rename session" },
      split: { keys: ["s"], description: "split pane" },
      register: { keys: ["a"], description: "add project" },
      unregister: { keys: ["d"], description: "unregister project" },
      kill: { keys: ["x"], description: "kill (confirm)" },
      filter: { keys: ["/"], description: "fuzzy filter" },
      refresh: { keys: ["r"], description: "refresh" },
      help: { keys: ["?"], description: "toggle help" },
      quit: { keys: ["q"], description: "quit" }
    };
  }
});

// packages/daemon/src/widgets/lib/grammar.ts
var GRAMMAR_HELP;
var init_grammar = __esm({
  "packages/daemon/src/widgets/lib/grammar.ts"() {
    "use strict";
    GRAMMAR_HELP = [
      { keys: "j / \u2193", label: "move down" },
      { keys: "k / \u2191", label: "move up" },
      { keys: "enter", label: "activate / open" },
      { keys: "/", label: "filter list" },
      { keys: "esc", label: "close filter \u2192 detail \u2192 widget" },
      { keys: "q", label: "quit" },
      { keys: "?", label: "toggle this help" }
    ];
  }
});

// packages/daemon/src/tui/chrome/panels.ts
var panels_exports = {};
__export(panels_exports, {
  PANEL_POPUPS: () => PANEL_POPUPS,
  POPUP_WIDGETS: () => POPUP_WIDGETS,
  panelKey: () => panelKey,
  panelPopupBindCommand: () => panelPopupBindCommand,
  panelPopupCli: () => panelPopupCli,
  panelPopupCommand: () => panelPopupCommand,
  panelPopupUnbindCommand: () => panelPopupUnbindCommand
});
function panelPopupCli(widget) {
  return `tmux-ide popup ${widget}`;
}
function panelKey(panel, keys) {
  return keys[panel.widget];
}
function panelPopupCommand(panel, cli = panelPopupCli(panel.widget)) {
  return `display-popup -E -d '#{pane_current_path}' -w ${panel.width} -h ${panel.height} "${cli}"`;
}
function panelPopupBindCommand(panel, key, cli = panelPopupCli(panel.widget)) {
  return [
    "bind-key",
    "-n",
    key,
    "display-popup",
    "-E",
    "-d",
    "#{pane_current_path}",
    "-w",
    panel.width,
    "-h",
    panel.height,
    cli
  ];
}
function panelPopupUnbindCommand(key) {
  return ["unbind-key", "-n", key];
}
var PANEL_POPUPS, POPUP_WIDGETS;
var init_panels = __esm({
  "packages/daemon/src/tui/chrome/panels.ts"() {
    "use strict";
    PANEL_POPUPS = [
      { widget: "explorer", label: "\u229E Files", width: "60%", height: "85%" },
      { widget: "changes", label: "\xB1 Changes", width: "85%", height: "90%" },
      { widget: "config", label: "\u2699 Config", width: "80%", height: "85%" }
    ];
    POPUP_WIDGETS = PANEL_POPUPS.map((p) => p.widget);
  }
});

// packages/daemon/src/tui/chrome/cheatsheet.ts
var cheatsheet_exports = {};
__export(cheatsheet_exports, {
  CHEATSHEET_KEY: () => CHEATSHEET_KEY,
  buildCheatsheet: () => buildCheatsheet,
  cheatsheetBindCommand: () => cheatsheetBindCommand,
  cheatsheetPopupCommand: () => cheatsheetPopupCommand,
  cheatsheetUnbindCommand: () => cheatsheetUnbindCommand
});
function tokenCode(token) {
  const m = /^colou?r(\d+)$/.exec(token);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
}
function legendMark(token, glyph) {
  const code = tokenCode(token);
  return code === null ? dim(glyph) : color2(code, glyph);
}
function renderKey(tmuxKey) {
  return tmuxKey.replace(/M-/g, "\u2325").replace(/C-/g, "^").replace(/S-/g, "\u21E7");
}
function clip(line, width) {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1B") {
      const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (visible >= width) break;
    out += line[i];
    visible++;
    i++;
  }
  return `${out}\x1B[0m`;
}
function visibleWidth(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function buildCheatsheet(opts) {
  const width = Math.max(20, opts.width);
  const keys = opts.keys ?? DEFAULT_KEYS;
  const theme = opts.theme ?? DEFAULT_THEME;
  const lines = [];
  const pad = (s) => `  ${s}`;
  lines.push(`${head(" tmux-ide")}  ${dim("cheat sheet \u2014 press any key to close")}`);
  lines.push("");
  lines.push(head("dock"));
  lines.push(
    pad(
      `${bold(renderKey(keys.home))} home cockpit   ${bold(renderKey(keys.popup))} switcher popup   ${bold(renderKey(keys.cheatsheet))} this sheet   ${bold(renderKey(keys.menu))} actions menu   ${bold(renderKey(keys.sidebar))} sidebar`
    )
  );
  lines.push(
    pad(
      dim(
        `bar: click a project tab = switch there \xB7 [ \u2302 home ${renderKey(keys.home)} ] = home \xB7 [ \u29C9 switch ${renderKey(keys.popup)} ] = switcher \xB7 right-click anywhere = menu`
      )
    )
  );
  const active2 = theme.glyphs.active;
  const legend = `${legendMark(theme.status.blocked, active2)} blocked  ${legendMark(theme.status.working, active2)} working  ${legendMark(theme.status.done, active2)} done  ${legendMark(theme.status.idle, active2)} idle  ${dim("\xB7")} unknown  ${dim(theme.glyphs.inactive)} stopped`;
  lines.push(pad(legend));
  lines.push("");
  lines.push(head("prefix keys (always work)"));
  lines.push(
    pad(
      `${bold("prefix h")} home  ${bold("prefix j")} switcher  ${bold("prefix k")} keys  ${bold("prefix u")} menu  ${bold("prefix b")} sidebar  ${bold("prefix e")} files  ${bold("prefix g")} changes  ${bold("prefix v")} config`
    )
  );
  lines.push(
    pad(dim(`prefix = your tmux prefix (usually C-b) \u2014 use these when Alt keys don't reach tmux`))
  );
  lines.push("");
  lines.push(head("panels"));
  const panelHints = PANEL_POPUPS.map(
    (p) => `${bold(renderKey(panelKey(p, keys.panels)))} ${p.label}`
  ).join("   ");
  lines.push(pad(`${panelHints}   ${dim("esc/q closes any panel")}`));
  lines.push("");
  lines.push(head("in panels & sidebar"));
  const gKeyW = Math.max(...GRAMMAR_HELP.map((r) => r.keys.length));
  for (const row of GRAMMAR_HELP) {
    lines.push(pad(`${bold(row.keys.padEnd(gKeyW))}  ${dim(row.label)}`));
  }
  lines.push("");
  lines.push(head(`picker  ${dim(`(inside the ${renderKey(keys.popup)} popup)`)}`));
  lines.push(
    pad(`${bold("\u21B5")} switch   ${bold("l")} launch   ${bold("/")} find   ${bold("esc")} close`)
  );
  lines.push("");
  lines.push(head("team app"));
  const cells = ACTION_ORDER.map((action) => {
    const binding = DEFAULT_KEYMAP[action];
    return { keys: binding.keys.join("/"), desc: binding.description };
  });
  const keyW = Math.max(...cells.map((c) => c.keys.length));
  const descW = Math.max(...cells.map((c) => c.desc.length));
  const cellW = keyW + 2 + descW;
  const renderCell = (c) => {
    const text = `${bold(c.keys.padEnd(keyW))}  ${dim(c.desc)}`;
    return text + " ".repeat(Math.max(0, cellW - visibleWidth(text)));
  };
  const twoCols = width >= cellW * 2 + 4;
  if (twoCols) {
    const half = Math.ceil(cells.length / 2);
    for (let i = 0; i < half; i++) {
      const left = cells[i];
      const right = cells[i + half];
      const rendered = left ? renderCell(left) : "";
      lines.push(pad(right ? `${rendered}  ${renderCell(right)}` : rendered));
    }
  } else {
    for (const c of cells) lines.push(pad(renderCell(c)));
  }
  lines.push("");
  lines.push(head("tmux essentials"));
  lines.push(
    pad(
      `${bold("prefix d")} detach   ${bold("prefix z")} zoom pane   ${bold("prefix [")} copy mode`
    )
  );
  lines.push(
    pad(
      `${bold("prefix c")} new window   ${bold("prefix n/p")} next/prev   ${bold('prefix % / "')} splits`
    )
  );
  lines.push("");
  lines.push(head("cli"));
  lines.push(pad(cyan("tmux-ide team --json")));
  lines.push(pad(cyan("tmux-ide wait agent-status <s> --status done")));
  lines.push(pad(cyan("tmux-ide adopt/unadopt <session>")));
  lines.push(pad(cyan("tmux-ide worktree create <branch>") + dim("   (\u2387 in the menu)")));
  return lines.map((line) => clip(line, width)).join("\n");
}
function cheatsheetPopupCommand(cheatsheetCmd = "tmux-ide cheatsheet") {
  return `display-popup -E -w 90% -h 80% "${cheatsheetCmd}"`;
}
function cheatsheetBindCommand(cheatsheetCmd = "tmux-ide cheatsheet", key = CHEATSHEET_KEY) {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "90%", "-h", "80%", cheatsheetCmd];
}
function cheatsheetUnbindCommand(key = CHEATSHEET_KEY) {
  return ["unbind-key", "-n", key];
}
var CHEATSHEET_KEY, bold, dim, cyan, head, color2;
var init_cheatsheet = __esm({
  "packages/daemon/src/tui/chrome/cheatsheet.ts"() {
    "use strict";
    init_app_config();
    init_keymap();
    init_grammar();
    init_panels();
    CHEATSHEET_KEY = "M-k";
    bold = (s) => `\x1B[1m${s}\x1B[22m`;
    dim = (s) => `\x1B[2m${s}\x1B[22m`;
    cyan = (s) => `\x1B[36m${s}\x1B[39m`;
    head = (s) => `\x1B[1;36m${s}\x1B[0m`;
    color2 = (code, s) => `\x1B[38;5;${code}m${s}\x1B[39m`;
  }
});

// packages/daemon/src/tui/chrome/menu.ts
var menu_exports = {};
__export(menu_exports, {
  MENU_KEY: () => MENU_KEY,
  MENU_PANE_KEY: () => MENU_PANE_KEY,
  MENU_STATUS_KEY: () => MENU_STATUS_KEY,
  buildMenu: () => buildMenu,
  menuBindCommand: () => menuBindCommand,
  menuPaneBindCommand: () => menuPaneBindCommand,
  menuPaneUnbindCommand: () => menuPaneUnbindCommand,
  menuPositionArgs: () => menuPositionArgs,
  menuQuoteName: () => menuQuoteName,
  menuStatusBindCommand: () => menuStatusBindCommand,
  menuStatusUnbindCommand: () => menuStatusUnbindCommand,
  menuUnbindCommand: () => menuUnbindCommand
});
function menuGlyph(status2, theme) {
  const glyph = status2 === "idle" ? theme.glyphs.inactive : status2 === "unknown" ? "\xB7" : theme.glyphs.active;
  return { glyph, colour: theme.status[status2] };
}
function menuQuoteName(name) {
  return `'${name.replace(/'/g, `'\\''`)}'`;
}
function sessionLabel(session, theme) {
  const g = menuGlyph(session.status, theme);
  return `#[fg=${g.colour}]${g.glyph}#[default] ${session.name}`;
}
function buildMenu(sessions, theme = DEFAULT_THEME, update) {
  const updateItems = update?.updateAvailable && update.latest ? [`#[fg=${theme.accent}]\u2B06 Update available (v${update.latest})`, "u", updatePopupCommand()] : [];
  const header = [
    "\u2302 Home cockpit",
    "h",
    homePopupCommand(),
    "\u29C9 Switch session\u2026",
    "s",
    switcherPopupCommand(),
    "? Cheat sheet",
    "k",
    cheatsheetPopupCommand(),
    "\u258F Toggle sidebar",
    "b",
    // run-shell format-expands #{session_name}, so the toggle targets whatever
    // session the opening client is viewing (bind args don't expand; run-shell
    // does — the same trick the menu bind itself uses).
    `run-shell "tmux-ide sidebar-toggle --session '#{session_name}'"`
  ];
  const panelItems = [];
  PANEL_POPUPS.forEach((panel, i) => {
    panelItems.push(panel.label, PANEL_MENU_KEYS[i] ?? "", panelPopupCommand(panel));
  });
  const sessionItems = [];
  sessions.slice(0, MAX_SESSION_ITEMS).forEach((session, i) => {
    sessionItems.push(
      sessionLabel(session, theme),
      String(i + 1),
      `switch-client -t ${menuQuoteName(session.name)}`
    );
  });
  const footer = [
    "\uFF0B New session\u2026",
    "n",
    `command-prompt -p "new session name:" "new-session -d -s '%%' ; switch-client -t '%%'"`,
    "\u2387 New worktree\u2026",
    "w",
    // Prompt for a branch, then create a git worktree + session for it. The
    // command-prompt template is SINGLE-quoted so the inner run-shell arg can be
    // DOUBLE-quoted — run-shell only format-expands #{session_name} inside double
    // quotes (single quotes suppress it). `%%` is command-prompt's branch
    // substitution; --session carries the current session so the CLI resolves the
    // repo from its cwd (run-shell's own cwd is the tmux server's, not the pane's).
    // Quoting verified live on tmux 3.6 with branch `feat/x-1`.
    `command-prompt -p "worktree branch:" 'run-shell "tmux-ide worktree create %% --session #{session_name}"'`,
    "\u2715 Kill this session",
    "x",
    `confirm-before -p "kill session #S? (y/n)" kill-session`
  ];
  const items = [];
  for (const group of [updateItems, header, panelItems, sessionItems, footer]) {
    if (group.length === 0) continue;
    if (items.length > 0) items.push("");
    items.push(...group);
  }
  return ["-T", "tmux-ide", ...items];
}
function menuRunShellArgs(menuCmd) {
  return ["run-shell", "-b", `${menuCmd} --client '#{client_name}'`];
}
function menuPaneMouseRunShellArgs(menuCmd) {
  return [
    "run-shell",
    "-b",
    `${menuCmd} --client '#{client_name}' --x '#{e|+:#{pane_left},#{mouse_x}}' --y '#{e|+:#{pane_top},#{mouse_y}}'`
  ];
}
function menuStatusMouseRunShellArgs(menuCmd) {
  return [
    "run-shell",
    "-b",
    `${menuCmd} --client '#{client_name}' --x '#{mouse_x}' --y '#{client_height}'`
  ];
}
function menuPositionArgs(x, y) {
  const nx = parseCoord(x);
  const ny = parseCoord(y);
  if (nx === null || ny === null) return [];
  return ["-x", String(nx), "-y", String(Math.max(0, ny - 1))];
}
function parseCoord(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}
function menuBindCommand(menuCmd = "tmux-ide menu", key = MENU_KEY) {
  return ["bind-key", "-n", key, ...menuRunShellArgs(menuCmd)];
}
function menuStatusBindCommand(menuCmd = "tmux-ide menu") {
  return ["bind-key", "-n", MENU_STATUS_KEY, ...menuStatusMouseRunShellArgs(menuCmd)];
}
function menuPaneBindCommand(menuCmd = "tmux-ide menu") {
  return ["bind-key", "-n", MENU_PANE_KEY, ...menuPaneMouseRunShellArgs(menuCmd)];
}
function menuUnbindCommand(key = MENU_KEY) {
  return ["unbind-key", "-n", key];
}
function menuStatusUnbindCommand() {
  return ["unbind-key", "-n", MENU_STATUS_KEY];
}
function menuPaneUnbindCommand() {
  return ["unbind-key", "-n", MENU_PANE_KEY];
}
var PANEL_MENU_KEYS, MAX_SESSION_ITEMS;
var init_menu = __esm({
  "packages/daemon/src/tui/chrome/menu.ts"() {
    "use strict";
    init_app_config();
    init_statusline();
    init_cheatsheet();
    init_panels();
    PANEL_MENU_KEYS = ["e", "g", ","];
    MAX_SESSION_ITEMS = 8;
  }
});

// packages/daemon/src/tui/chrome/welcome.ts
var welcome_exports = {};
__export(welcome_exports, {
  buildWelcomeText: () => buildWelcomeText,
  markWelcomed: () => markWelcomed,
  maybeShowWelcomePopup: () => maybeShowWelcomePopup,
  shouldShowWelcome: () => shouldShowWelcome,
  welcomeMarkerPath: () => welcomeMarkerPath
});
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync12, mkdirSync as mkdirSync6, writeFileSync as writeFileSync6 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { dirname as dirname12, join as join10 } from "node:path";
function renderKey2(tmuxKey) {
  return tmuxKey.replace(/M-/g, "\u2325").replace(/C-/g, "^").replace(/S-/g, "\u21E7");
}
function welcomeMarkerPath() {
  const home = process.env.TMUX_IDE_HOME ?? join10(homedir6(), ".tmux-ide");
  return join10(home, "welcomed");
}
function shouldShowWelcome() {
  return !existsSync12(welcomeMarkerPath()) && getAppConfig().welcome.show;
}
function markWelcomed() {
  const path2 = welcomeMarkerPath();
  try {
    mkdirSync6(dirname12(path2), { recursive: true });
    writeFileSync6(path2, (/* @__PURE__ */ new Date()).toISOString());
  } catch {
  }
}
function buildWelcomeText(keys = DEFAULT_KEYS) {
  const lines = [
    head2(" You're in tmux-ide"),
    dim2(" your terminal, now a fleet you can see and steer."),
    "",
    " Four keys unlock everything:",
    `   ${bold2("right-click")}   the actions menu \u2014 anywhere`,
    `   ${bold2(renderKey2(keys.home).padEnd(11))}   the home cockpit`,
    `   ${bold2(renderKey2(keys.popup).padEnd(11))}   switch session`,
    `   ${bold2(renderKey2(keys.cheatsheet).padEnd(11))}   all keys (the cheat sheet)`,
    "",
    dim2(" This card shows once \u2014 press any key to close.")
  ];
  return lines.join("\n");
}
function maybeShowWelcomePopup() {
  if (!shouldShowWelcome()) return;
  if (!process.env.TMUX) return;
  try {
    const child = spawn2(
      "tmux",
      ["display-popup", "-E", "-w", "60", "-h", "12", "tmux-ide welcome"],
      { stdio: "ignore", detached: true }
    );
    child.unref();
  } catch {
  }
  markWelcomed();
}
var bold2, dim2, head2;
var init_welcome = __esm({
  "packages/daemon/src/tui/chrome/welcome.ts"() {
    "use strict";
    init_app_config();
    bold2 = (s) => `\x1B[1m${s}\x1B[22m`;
    dim2 = (s) => `\x1B[2m${s}\x1B[22m`;
    head2 = (s) => `\x1B[1;36m${s}\x1B[0m`;
  }
});

// packages/daemon/src/tui/integrations/claude.ts
var claude_exports = {};
__export(claude_exports, {
  EVENT_STATES: () => EVENT_STATES,
  HOOK_SCRIPT: () => HOOK_SCRIPT,
  HOOK_SCRIPT_RELPATH: () => HOOK_SCRIPT_RELPATH,
  claudeIntegrationStatus: () => claudeIntegrationStatus,
  claudeSettingsPath: () => claudeSettingsPath,
  hookScriptPath: () => hookScriptPath,
  installClaudeIntegration: () => installClaudeIntegration,
  isInstalled: () => isInstalled,
  mergeHooks: () => mergeHooks,
  removeHooks: () => removeHooks,
  uninstallClaudeIntegration: () => uninstallClaudeIntegration
});
import {
  chmodSync as chmodSync2,
  copyFileSync,
  existsSync as existsSync13,
  mkdirSync as mkdirSync7,
  readFileSync as readFileSync9,
  writeFileSync as writeFileSync7
} from "node:fs";
import { homedir as homedir7 } from "node:os";
import { dirname as dirname13, join as join11 } from "node:path";
function hookScriptPath() {
  return join11(homedir7(), HOOK_SCRIPT_RELPATH);
}
function claudeSettingsPath() {
  return process.env.TMUX_IDE_CLAUDE_SETTINGS ?? join11(homedir7(), ".claude", "settings.json");
}
function isOurs(group) {
  return group.hooks?.some((h) => h.command?.includes(HOOK_SCRIPT_RELPATH)) ?? false;
}
function mergeHooks(settings, scriptPath) {
  const next = { ...settings, hooks: { ...settings.hooks ?? {} } };
  const hooks = next.hooks;
  for (const { event, state, matcher } of EVENT_STATES) {
    const existing = (hooks[event] ?? []).filter((g) => !isOurs(g));
    const group = {
      ...matcher !== void 0 ? { matcher } : {},
      hooks: [{ type: "command", command: `${scriptPath} ${state}` }]
    };
    hooks[event] = [...existing, group];
  }
  return next;
}
function removeHooks(settings) {
  if (!settings.hooks) return { ...settings };
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length > 0) hooks[event] = kept;
  }
  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}
function isInstalled(settings) {
  return Object.values(settings.hooks ?? {}).some((groups) => groups.some(isOurs));
}
function readSettings(path2) {
  if (!existsSync13(path2)) return {};
  try {
    return JSON.parse(readFileSync9(path2, "utf8"));
  } catch {
    throw new Error(`${path2} is not valid JSON \u2014 fix or move it, then retry`);
  }
}
function installClaudeIntegration() {
  const script = hookScriptPath();
  mkdirSync7(dirname13(script), { recursive: true });
  writeFileSync7(script, HOOK_SCRIPT, "utf8");
  chmodSync2(script, 493);
  const settingsPath = claudeSettingsPath();
  mkdirSync7(dirname13(settingsPath), { recursive: true });
  const settings = readSettings(settingsPath);
  const backup = `${settingsPath}.tmux-ide.bak`;
  if (existsSync13(settingsPath) && !existsSync13(backup)) copyFileSync(settingsPath, backup);
  writeFileSync7(settingsPath, `${JSON.stringify(mergeHooks(settings, script), null, 2)}
`, "utf8");
  return { scriptPath: script, settingsPath };
}
function uninstallClaudeIntegration() {
  const settingsPath = claudeSettingsPath();
  const settings = readSettings(settingsPath);
  const wasInstalled = isInstalled(settings);
  if (wasInstalled) {
    writeFileSync7(settingsPath, `${JSON.stringify(removeHooks(settings), null, 2)}
`, "utf8");
  }
  return { settingsPath, wasInstalled };
}
function claudeIntegrationStatus() {
  return {
    installed: isInstalled(readSettings(claudeSettingsPath())),
    scriptExists: existsSync13(hookScriptPath())
  };
}
var HOOK_SCRIPT_RELPATH, HOOK_SCRIPT, EVENT_STATES;
var init_claude = __esm({
  "packages/daemon/src/tui/integrations/claude.ts"() {
    "use strict";
    HOOK_SCRIPT_RELPATH = ".tmux-ide/hooks/claude-state.sh";
    HOOK_SCRIPT = `#!/bin/sh
# tmux-ide agent-state hook (installed by: tmux-ide integration install claude)
# $1 = state to report: working | blocked | done | idle
state="\${1:-idle}"
payload="$(cat 2>/dev/null || true)"
[ -n "$TMUX_PANE" ] || exit 0
tmux set-option -p -t "$TMUX_PANE" @agent_state "\${state}:$(date +%s)" 2>/dev/null || exit 0
sid="$(printf '%s' "$payload" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1)"
[ -n "$sid" ] && tmux set-option -p -t "$TMUX_PANE" @agent_session_id "$sid" 2>/dev/null
exit 0
`;
    EVENT_STATES = [
      { event: "UserPromptSubmit", state: "working" },
      { event: "PreToolUse", state: "working", matcher: "*" },
      { event: "Notification", state: "blocked" },
      { event: "Stop", state: "done" },
      { event: "SessionEnd", state: "idle" }
    ];
  }
});

// packages/daemon/src/tui/integrations/offer.ts
var offer_exports = {};
__export(offer_exports, {
  buildOfferText: () => buildOfferText,
  integrationOfferMarkerPath: () => integrationOfferMarkerPath,
  markIntegrationOffered: () => markIntegrationOffered,
  maybeOfferIntegrationPopup: () => maybeOfferIntegrationPopup,
  shouldOfferIntegration: () => shouldOfferIntegration
});
import { execFileSync as execFileSync5, spawn as spawn3 } from "node:child_process";
import { existsSync as existsSync14, mkdirSync as mkdirSync8, writeFileSync as writeFileSync8 } from "node:fs";
import { homedir as homedir8 } from "node:os";
import { dirname as dirname14, join as join12 } from "node:path";
function integrationOfferMarkerPath() {
  const home = process.env.TMUX_IDE_HOME ?? join12(homedir8(), ".tmux-ide");
  return join12(home, "integration-offered");
}
function shouldOfferIntegration(input) {
  return input.claudeOnPath && !input.integrationInstalled && !input.markerPresent && input.offerEnabled;
}
function markIntegrationOffered() {
  const path2 = integrationOfferMarkerPath();
  try {
    mkdirSync8(dirname14(path2), { recursive: true });
    writeFileSync8(path2, (/* @__PURE__ */ new Date()).toISOString());
  } catch {
  }
}
function buildOfferText() {
  const bold4 = (s) => `\x1B[1m${s}\x1B[22m`;
  const dim4 = (s) => `\x1B[2m${s}\x1B[22m`;
  const head3 = (s) => `\x1B[1;36m${s}\x1B[0m`;
  return [
    head3(" Claude Code detected"),
    "",
    " Install the tmux-ide integration for ground-truth agent status?",
    dim4(" It hooks Claude Code's lifecycle so pane state is exact, not guessed."),
    "",
    ` ${bold4("[y]")} install    ${bold4("[N]")} skip (any other key)`,
    dim4(" Asked once \u2014 press a key.")
  ].join("\n");
}
function maybeOfferIntegrationPopup() {
  let offer;
  try {
    const status2 = claudeIntegrationStatus();
    offer = shouldOfferIntegration({
      claudeOnPath: claudeOnPath(),
      integrationInstalled: status2.installed,
      markerPresent: existsSync14(integrationOfferMarkerPath()),
      offerEnabled: getAppConfig().integrations.offer
    });
  } catch {
    return;
  }
  if (!offer) return;
  if (!process.env.TMUX) return;
  try {
    const child = spawn3(
      "tmux",
      ["display-popup", "-E", "-w", "64", "-h", "12", "tmux-ide integration offer"],
      { stdio: "ignore", detached: true }
    );
    child.unref();
  } catch {
  }
  markIntegrationOffered();
}
function claudeOnPath() {
  try {
    execFileSync5("which", ["claude"], { stdio: "ignore", timeout: 2e3 });
    return true;
  } catch {
    return false;
  }
}
var init_offer = __esm({
  "packages/daemon/src/tui/integrations/offer.ts"() {
    "use strict";
    init_app_config();
    init_claude();
  }
});

// packages/daemon/src/tui/chrome/kitty-keys.ts
function kittyEscapeFor(key) {
  const m = /^M-(.)$/.exec(key);
  const ch = m?.[1];
  if (ch === void 0) return null;
  const code = ch.toLowerCase().codePointAt(0);
  if (code === void 0) return null;
  return `\x1B[${code};3:1u`;
}
function kittyUserKeyIndex(slot) {
  return 100 + slot;
}
function kittyUserKeyName(slot) {
  return `User${kittyUserKeyIndex(slot)}`;
}
var init_kitty_keys = __esm({
  "packages/daemon/src/tui/chrome/kitty-keys.ts"() {
    "use strict";
  }
});

// packages/daemon/src/tui/chrome/front-door.ts
function updaterProbeArgv() {
  return ["has-session", "-t", `=${UPDATER_SESSION}`];
}
function updaterSpawnArgv() {
  return ["new-session", "-d", "-s", UPDATER_SESSION, "exec tmux-ide chrome-updater"];
}
var ADOPTED_OPTION, UPDATER_SESSION;
var init_front_door = __esm({
  "packages/daemon/src/tui/chrome/front-door.ts"() {
    "use strict";
    ADOPTED_OPTION = "@tmux_ide_adopted";
    UPDATER_SESSION = "_tmux-ide-chrome";
  }
});

// packages/daemon/src/tui/detect/session-id.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
import { readdirSync as readdirSync2, readFileSync as readFileSync10, readlinkSync, statSync } from "node:fs";
import { homedir as homedir9 } from "node:os";
import { join as join13 } from "node:path";
function codexIdFromOpenFiles(paths) {
  for (const path2 of paths) {
    const match = CODEX_ROLLOUT_RE.exec(path2);
    if (match?.[1]) return match[1];
  }
  return null;
}
function cursorIdFromOpenFiles(paths) {
  for (const path2 of paths) {
    const match = CURSOR_STORE_RE.exec(path2);
    if (match?.[1] && SAFE_SESSION_ID.test(match[1])) return match[1];
  }
  return null;
}
function parseEtimeSeconds(raw) {
  const trimmed = raw.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (minutes >= 60 || seconds >= 60 || match[2] !== void 0 && hours >= 24) return null;
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}
function agentPidsInSubtree(table, panePid, bins) {
  const wanted = new Set(bins);
  const pids = [];
  for (const entry of subtreeEntries(table, panePid)) {
    if (commandTokens(entry.command).some((token) => wanted.has(token))) pids.push(entry.pid);
  }
  return pids;
}
function parseCodexRolloutName(name) {
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$/.exec(
    name
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, id] = match;
  const tsMs = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  ).getTime();
  return Number.isFinite(tsMs) && id ? { tsMs, id } : null;
}
function codexIdFromStateDir(root, paneCwd, startMs, io, nowMs = Date.now()) {
  const cutoff = startMs - START_SLACK_MS;
  const candidates = [];
  for (let offset = 0; offset <= MAX_SCAN_DAYS; offset++) {
    const day = new Date(nowMs - offset * 864e5);
    if (day.getTime() < cutoff - 864e5) break;
    const dir = join13(
      root,
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0")
    );
    for (const name of io.listDir(dir)) {
      const parsed = parseCodexRolloutName(name);
      if (parsed && parsed.tsMs >= cutoff && parsed.tsMs <= nowMs + START_SLACK_MS) {
        candidates.push({ tsMs: parsed.tsMs, path: join13(dir, name), id: parsed.id });
      }
    }
  }
  candidates.sort((a, b) => b.tsMs - a.tsMs);
  for (const candidate of candidates) {
    const line = io.readFirstLine(candidate.path);
    if (!line) continue;
    let meta;
    try {
      meta = JSON.parse(line).payload;
    } catch {
      continue;
    }
    if (!meta || meta.cwd !== paneCwd) continue;
    if (meta.thread_source === "subagent") continue;
    if (typeof meta.source === "object" && meta.source !== null && "subagent" in meta.source) {
      continue;
    }
    return candidate.id;
  }
  return null;
}
function cursorIdFromStateDir(chatsRoot, paneCwd, startMs, io) {
  const hashed = join13(chatsRoot, createHash3("md5").update(paneCwd).digest("hex"));
  const cutoff = startMs - START_SLACK_MS;
  let best = null;
  for (const name of io.listDir(hashed)) {
    if (!SAFE_SESSION_ID.test(name)) continue;
    const mtime = io.mtimeMs(join13(hashed, name));
    if (mtime === null || mtime < cutoff) continue;
    if (!best || mtime > best.mtime) best = { name, mtime };
  }
  return best?.name ?? null;
}
function probeKind(pane, kind, io) {
  const table = io.processTable();
  const pids = agentPidsInSubtree(table, pane.pid, KIND_BINS[kind]);
  if (pids.length === 0) return null;
  const fromOpen = kind === "codex" ? codexIdFromOpenFiles : cursorIdFromOpenFiles;
  for (const pid of pids) {
    const id = fromOpen(io.openFiles(pid));
    if (id) return id;
  }
  const startMs = io.processStartMs(pids[0]);
  if (startMs === null) return null;
  return kind === "codex" ? codexIdFromStateDir(io.codexSessionsRoot(), pane.dir, startMs, io.stateDir, io.now()) : cursorIdFromStateDir(io.cursorChatsRoot(), pane.dir, startMs, io.stateDir);
}
function createSessionIdCapturer(deps2) {
  const every = deps2.everyTicks ?? CAPTURE_EVERY_TICKS;
  const probe = deps2.probe ?? ((pane) => defaultProbe(pane));
  const stampedByUs = /* @__PURE__ */ new Set();
  let ticks = 0;
  return {
    onTick(panes) {
      ticks++;
      if (every <= 0 || ticks % every !== 0) return;
      for (const pane of panes) {
        if (!pane.agent || pane.sessionId || stampedByUs.has(pane.paneId)) continue;
        const kindProbe = CAPTURE_PROBES[pane.agent];
        if (!kindProbe) continue;
        let id;
        try {
          id = probe(pane);
        } catch {
          continue;
        }
        if (!id || !SAFE_SESSION_ID.test(id)) continue;
        try {
          deps2.stamp(pane.paneId, id);
          stampedByUs.add(pane.paneId);
        } catch {
        }
      }
    }
  };
}
function readOpenFiles(pid) {
  try {
    const fdDir = `/proc/${pid}/fd`;
    const names = readdirSync2(fdDir);
    const paths = [];
    for (const name of names) {
      try {
        const target = readlinkSync(join13(fdDir, name));
        if (target.startsWith("/")) paths.push(target);
      } catch {
      }
    }
    return paths;
  } catch {
  }
  try {
    const raw = execFileSync6("lsof", ["-p", String(pid), "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3e3
    });
    return raw.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
  } catch {
    return [];
  }
}
function processStartMs(pid, nowMs = Date.now()) {
  try {
    const raw = execFileSync6("ps", ["-o", "etime=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    const seconds = parseEtimeSeconds(raw);
    return seconds === null ? null : nowMs - seconds * 1e3;
  } catch {
    return null;
  }
}
function liveProbeIo() {
  return {
    processTable: readProcessTable,
    openFiles: readOpenFiles,
    processStartMs: (pid) => processStartMs(pid),
    stateDir: liveStateDirIo,
    codexSessionsRoot: () => process.env.TMUX_IDE_CODEX_SESSIONS ?? join13(homedir9(), ".codex", "sessions"),
    cursorChatsRoot: () => process.env.TMUX_IDE_CURSOR_CHATS ?? join13(homedir9(), ".cursor", "chats"),
    now: () => Date.now()
  };
}
function defaultProbe(pane) {
  const kindProbe = pane.agent ? CAPTURE_PROBES[pane.agent] : void 0;
  return kindProbe ? kindProbe(pane, liveProbeIo()) : null;
}
var SAFE_SESSION_ID, CODEX_ROLLOUT_RE, CURSOR_STORE_RE, START_SLACK_MS, MAX_SCAN_DAYS, KIND_BINS, CAPTURE_PROBES, PROBED_KINDS, CAPTURE_EVERY_TICKS, liveStateDirIo;
var init_session_id = __esm({
  "packages/daemon/src/tui/detect/session-id.ts"() {
    "use strict";
    init_process_tree();
    SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
    CODEX_ROLLOUT_RE = /\/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$/;
    CURSOR_STORE_RE = /\/\.cursor\/chats\/[0-9a-f]{32}\/([A-Za-z0-9-]+)\/store\.db$/;
    START_SLACK_MS = 12e4;
    MAX_SCAN_DAYS = 7;
    KIND_BINS = {
      codex: ["codex", "codex.exe"],
      cursor: ["cursor-agent", "cursor"]
    };
    CAPTURE_PROBES = {
      codex: (pane, io) => probeKind(pane, "codex", io),
      cursor: (pane, io) => probeKind(pane, "cursor", io)
    };
    PROBED_KINDS = Object.keys(CAPTURE_PROBES);
    CAPTURE_EVERY_TICKS = 5;
    liveStateDirIo = {
      listDir: (path2) => {
        try {
          return readdirSync2(path2);
        } catch {
          return [];
        }
      },
      mtimeMs: (path2) => {
        try {
          return statSync(path2).mtimeMs;
        } catch {
          return null;
        }
      },
      readFirstLine: (path2) => {
        try {
          const fd = readFileSync10(path2, { encoding: "utf8", flag: "r" });
          const newline = fd.indexOf("\n");
          return newline === -1 ? fd : fd.slice(0, newline);
        } catch {
          return null;
        }
      }
    };
  }
});

// packages/daemon/src/schemas/registry.ts
import { z as z24 } from "zod";
var RegisteredProjectSchemaZ, RegisterProjectRequestSchemaZ, InitProjectRequestSchemaZ, ProjectTemplateSchemaZ;
var init_registry = __esm({
  "packages/daemon/src/schemas/registry.ts"() {
    "use strict";
    RegisteredProjectSchemaZ = z24.object({
      /** Unique registry key. Defaults to `basename(dir)`; collisions resolved by appending `-2`, `-3`, … */
      name: z24.string(),
      /** Absolute path to the project directory. */
      dir: z24.string(),
      /** Whether `<dir>/ide.yml` exists; refreshed on register and on `probe()`. */
      hasIdeYml: z24.boolean(),
      /** Whether `.tmux-ide/workspace.yml` exists or wins discovery. */
      hasWorkspaceConfig: z24.boolean().optional(),
      /** Generalized winning config kind. Added without replacing `hasIdeYml`. */
      configKind: z24.enum(["workspace", "legacy", "none"]).optional(),
      /** Generalized winning config path. */
      configPath: z24.string().nullable().optional(),
      /** Legacy config path when an `ide.yml` is present. */
      ideConfigPath: z24.string().nullable().optional(),
      /** Git remote origin URL, or `null` if not a git repo / no origin / probe failed. */
      gitOrigin: z24.string().nullable(),
      /** Current git branch, or `null` if not a git repo / detached HEAD / probe failed. */
      gitBranch: z24.string().nullable(),
      /** ISO-8601 timestamp the project was first registered. */
      registeredAt: z24.string()
    });
    RegisterProjectRequestSchemaZ = z24.object({
      dir: z24.string().min(1),
      name: z24.string().min(1).optional()
    });
    InitProjectRequestSchemaZ = z24.object({
      dir: z24.string().min(1),
      template: z24.string().min(1).optional()
    });
    ProjectTemplateSchemaZ = z24.object({
      id: z24.string(),
      label: z24.string(),
      description: z24.string()
    });
  }
});

// packages/daemon/src/lib/project-probe.ts
import { basename as basename5, isAbsolute as isAbsolute2, resolve as resolve10 } from "node:path";
function sanitizeName(raw) {
  return raw.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^-+|-+$/g, "");
}
async function probeProject(dir, io = realIo) {
  const absoluteDir = isAbsolute2(dir) ? dir : resolve10(dir);
  const resolution = await resolveProject(dir, {
    // Existing injected ProbeIo values predate canonicalization. Treat their
    // paths as canonical unless they explicitly provide a realpath operation,
    // so the probe remains a fully injected seam rather than touching real fs.
    io: { ...io, realpath: io.realpath ?? ((path2) => path2) }
  });
  const rawName = basename5(absoluteDir);
  const sanitized = sanitizeName(rawName);
  const name = sanitized.length > 0 ? sanitized : "project";
  const [gitOrigin, gitBranch] = await Promise.all([
    runGitSafely(io, ["config", "--get", "remote.origin.url"], absoluteDir),
    runGitSafely(io, ["branch", "--show-current"], absoluteDir)
  ]);
  return {
    name,
    // Preserve the public probe/command-center contract: this is the absolute
    // caller path, while canonical roots live on ProjectResolution.
    dir: absoluteDir,
    hasIdeYml: resolution.hasLegacyConfigAtInput,
    hasWorkspaceConfig: resolution.config.kind === "workspace",
    configKind: resolution.config.kind,
    configPath: resolution.config.path,
    ideConfigPath: resolution.legacyConfigPath,
    // Treat empty string as null — branch --show-current returns "" on a
    // detached HEAD.
    gitOrigin: gitOrigin && gitOrigin.length > 0 ? gitOrigin : null,
    gitBranch: gitBranch && gitBranch.length > 0 ? gitBranch : null
  };
}
async function runGitSafely(io, args, cwd) {
  try {
    return await io.runGit(args, cwd);
  } catch {
    return null;
  }
}
var realIo;
var init_project_probe = __esm({
  "packages/daemon/src/lib/project-probe.ts"() {
    "use strict";
    init_project_resolver();
    realIo = defaultProjectResolverIo;
  }
});

// packages/daemon/src/lib/project-registry.ts
import { EventEmitter } from "node:events";
import { existsSync as existsSync15, mkdirSync as mkdirSync9, readFileSync as readFileSync11, renameSync as renameSync5, writeFileSync as writeFileSync9 } from "node:fs";
import { homedir as homedir10 } from "node:os";
import { dirname as dirname15, isAbsolute as isAbsolute3, join as join14, resolve as resolve11 } from "node:path";
import { z as z25 } from "zod";
function applyAction(state, action) {
  switch (action.type) {
    case "register":
      return [...state, action.project];
    case "unregister":
      return state.filter((p) => p.name !== action.name);
    case "replace":
      return state.map((p) => p.name === action.project.name ? action.project : p);
  }
}
function resolveUniqueName(state, desired) {
  const used = new Set(state.map((p) => p.name));
  if (!used.has(desired)) return desired;
  let counter = 2;
  while (used.has(`${desired}-${counter}`)) counter++;
  return `${desired}-${counter}`;
}
function buildRegisteredProject(probe, name, registeredAt) {
  return {
    name,
    dir: probe.dir,
    hasIdeYml: probe.hasIdeYml,
    hasWorkspaceConfig: probe.hasWorkspaceConfig,
    configKind: probe.configKind,
    configPath: probe.configPath,
    ideConfigPath: probe.ideConfigPath,
    gitOrigin: probe.gitOrigin,
    gitBranch: probe.gitBranch,
    registeredAt
  };
}
function registryDir() {
  const override = process.env[REGISTRY_DIR_ENV];
  if (override && override.length > 0) return override;
  return join14(homedir10(), ".tmux-ide");
}
function registryPath() {
  return join14(registryDir(), "projects.json");
}
function readDisk() {
  const path2 = registryPath();
  if (!existsSync15(path2)) return [];
  const raw = readFileSync11(path2, "utf-8");
  if (raw.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[project-registry] %s contains invalid JSON; ignoring", path2);
    return [];
  }
  const result = RegistryFileSchemaZ.safeParse(parsed);
  if (!result.success) {
    console.warn(
      "[project-registry] %s failed schema validation; ignoring (%s)",
      path2,
      result.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    );
    return [];
  }
  return result.data.projects;
}
function writeDisk(projects) {
  const path2 = registryPath();
  const dir = dirname15(path2);
  mkdirSync9(dir, { recursive: true });
  const file = { version: 1, projects };
  const tmpPath = `${path2}.tmp`;
  writeFileSync9(tmpPath, JSON.stringify(file, null, 2) + "\n");
  renameSync5(tmpPath, path2);
}
function ensureCache() {
  if (cache2 !== null) return cache2;
  cache2 = readDisk();
  return cache2;
}
function commit(next) {
  cache2 = next;
  writeDisk(next);
  projectRegistryEmitter.emit("change");
}
function listProjects() {
  return [...ensureCache()];
}
function getProject(name) {
  return ensureCache().find((p) => p.name === name) ?? null;
}
async function registerProject(input) {
  const exists = input.exists ?? existsSync15;
  const absoluteDir = isAbsolute3(input.dir) ? input.dir : resolve11(input.dir);
  if (!exists(absoluteDir)) {
    throw new ProjectDirNotFoundError(absoluteDir);
  }
  const probe = await probeProject(absoluteDir, input.io);
  const state = ensureCache();
  const desired = input.name ? sanitizeName(input.name) : probe.name;
  const cleaned = desired.length > 0 ? desired : probe.name;
  let resolvedName;
  if (input.name) {
    if (state.some((p) => p.name === cleaned)) {
      throw new ProjectAlreadyRegisteredError(cleaned, resolveUniqueName(state, cleaned));
    }
    resolvedName = cleaned;
  } else {
    resolvedName = resolveUniqueName(state, cleaned);
  }
  const dupDir = state.find((p) => p.dir === probe.dir);
  if (dupDir) {
    throw new ProjectAlreadyRegisteredError(dupDir.name, dupDir.name);
  }
  const now = (input.now ?? (() => /* @__PURE__ */ new Date()))();
  const project = buildRegisteredProject(probe, resolvedName, now.toISOString());
  commit(applyAction(state, { type: "register", project }));
  return project;
}
function unregisterProject(name) {
  const state = ensureCache();
  if (!state.some((p) => p.name === name)) {
    throw new ProjectNotFoundError(name);
  }
  commit(applyAction(state, { type: "unregister", name }));
}
async function refreshProject(name, options = {}) {
  const state = ensureCache();
  const existing = state.find((p) => p.name === name);
  if (!existing) throw new ProjectNotFoundError(name);
  const probe = await probeProject(existing.dir, options.io);
  const refreshed = buildRegisteredProject(probe, existing.name, existing.registeredAt);
  commit(applyAction(state, { type: "replace", project: refreshed }));
  return refreshed;
}
var REGISTRY_DIR_ENV, RegistryFileSchemaZ, ProjectRegistryError, ProjectAlreadyRegisteredError, ProjectNotFoundError, ProjectDirNotFoundError, projectRegistryEmitter, cache2;
var init_project_registry = __esm({
  "packages/daemon/src/lib/project-registry.ts"() {
    "use strict";
    init_registry();
    init_project_probe();
    REGISTRY_DIR_ENV = "TMUX_IDE_REGISTRY_DIR";
    RegistryFileSchemaZ = z25.object({
      version: z25.literal(1),
      projects: z25.array(RegisteredProjectSchemaZ)
    });
    ProjectRegistryError = class extends Error {
      code;
      constructor(message, code) {
        super(message);
        this.name = "ProjectRegistryError";
        this.code = code;
      }
    };
    ProjectAlreadyRegisteredError = class extends ProjectRegistryError {
      suggestion;
      constructor(name, suggestion) {
        super(`Project "${name}" is already registered`, "ALREADY_REGISTERED");
        this.name = "ProjectAlreadyRegisteredError";
        this.suggestion = suggestion;
      }
    };
    ProjectNotFoundError = class extends ProjectRegistryError {
      constructor(name) {
        super(`Project "${name}" not found in registry`, "NOT_FOUND");
        this.name = "ProjectNotFoundError";
      }
    };
    ProjectDirNotFoundError = class extends ProjectRegistryError {
      constructor(dir) {
        super(`Directory "${dir}" does not exist`, "DIR_NOT_FOUND");
        this.name = "ProjectDirNotFoundError";
      }
    };
    projectRegistryEmitter = new EventEmitter();
    projectRegistryEmitter.setMaxListeners(0);
    cache2 = null;
  }
});

// packages/daemon/src/tui/team/projects.ts
var projects_exports = {};
__export(projects_exports, {
  groupSessions: () => groupSessions,
  listTeamProjects: () => listTeamProjects
});
function normalizeDir(dir) {
  if (dir.length > 1 && dir.endsWith("/")) return dir.slice(0, -1);
  return dir;
}
function isInside(cwd, dir) {
  const base = normalizeDir(dir);
  const path2 = normalizeDir(cwd);
  if (path2 === base) return true;
  return path2.startsWith(base === "/" ? "/" : `${base}/`);
}
function groupSessions(projectsIn, sessionsIn, sessionCwd) {
  const projects = projectsIn.filter((p) => !p.name.startsWith("_"));
  const sessions = sessionsIn.filter((s) => !s.name.startsWith("_"));
  const buckets = /* @__PURE__ */ new Map();
  for (const p of projects) buckets.set(p.name, []);
  const matched = /* @__PURE__ */ new Set();
  const byName = new Map(projects.map((p) => [p.name, p]));
  for (const session of sessions) {
    if (byName.has(session.name)) {
      buckets.get(session.name).push(session);
      matched.add(session);
    }
  }
  for (const session of sessions) {
    if (matched.has(session)) continue;
    const cwd = sessionCwd(session.name);
    if (!cwd) continue;
    let best;
    for (const p of projects) {
      if (!isInside(cwd, p.dir)) continue;
      if (!best || normalizeDir(p.dir).length > normalizeDir(best.dir).length) best = p;
    }
    if (best) {
      buckets.get(best.name).push(session);
      matched.add(session);
    }
  }
  const registered = projects.slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
    const own = buckets.get(p.name) ?? [];
    return {
      name: p.name,
      dir: p.dir,
      hasIdeYml: p.hasIdeYml ?? false,
      hasWorkspaceConfig: p.hasWorkspaceConfig,
      configKind: p.configKind,
      configPath: p.configPath ?? null,
      gitBranch: p.gitBranch ?? null,
      registered: true,
      running: own.length > 0,
      status: rollupStatus(own.map((s) => s.status)),
      sessions: own
    };
  });
  const adhoc = sessions.filter((s) => !matched.has(s)).map((s) => ({
    name: s.name,
    dir: sessionCwd(s.name) ?? null,
    hasIdeYml: false,
    hasWorkspaceConfig: false,
    configKind: "none",
    configPath: null,
    gitBranch: null,
    registered: false,
    running: true,
    status: rollupStatus([s.status]),
    sessions: [s]
  }));
  return [...registered, ...adhoc];
}
function listTeamProjects(tracker, opts = {}) {
  let projects;
  try {
    projects = listProjects();
  } catch {
    projects = [];
  }
  let sessions;
  try {
    sessions = listTeamSessions(tracker, opts);
  } catch {
    sessions = [];
  }
  const cwd = (name) => {
    try {
      return getSessionCwd(name);
    } catch {
      return null;
    }
  };
  return groupSessions(projects, sessions, cwd);
}
var init_projects = __esm({
  "packages/daemon/src/tui/team/projects.ts"() {
    "use strict";
    init_src2();
    init_project_registry();
    init_sessions2();
  }
});

// packages/daemon/src/tui/chrome/chip.ts
function paneChip(agent, status2, theme = DEFAULT_THEME) {
  if (!agent) return "";
  return `${statusStyle(status2, theme)}${agent} \xB7 ${status2}#[default]`;
}
var init_chip = __esm({
  "packages/daemon/src/tui/chrome/chip.ts"() {
    "use strict";
    init_app_config();
    init_statusline();
  }
});

// packages/daemon/src/lib/state-home.ts
import { homedir as homedir11 } from "node:os";
import { join as join15 } from "node:path";
function stateHome() {
  return process.env.TMUX_IDE_HOME ?? join15(homedir11(), ".tmux-ide");
}
var init_state_home = __esm({
  "packages/daemon/src/lib/state-home.ts"() {
    "use strict";
  }
});

// packages/daemon/src/tui/chrome/events.ts
var events_exports = {};
__export(events_exports, {
  EVENTS_MAX_BYTES: () => EVENTS_MAX_BYTES,
  appendEvents: () => appendEvents,
  diffFleet: () => diffFleet,
  eventsPath: () => eventsPath,
  formatEventLine: () => formatEventLine,
  shouldRotate: () => shouldRotate
});
import { appendFileSync, existsSync as existsSync16, mkdirSync as mkdirSync10, renameSync as renameSync6, statSync as statSync2 } from "node:fs";
import { join as join16 } from "node:path";
function diffFleet(prev, next) {
  const state = /* @__PURE__ */ new Map();
  const events = [];
  for (const { name, status: status2 } of next) {
    const before = prev.has(name) ? prev.get(name) : null;
    state.set(name, status2);
    if (before === null) {
      events.push({ session: name, from: null, to: status2 });
    } else if (before !== status2) {
      events.push({ session: name, from: before, to: status2 });
    }
  }
  return { events, state };
}
function shouldRotate(sizeBytes) {
  return sizeBytes > EVENTS_MAX_BYTES;
}
function isoTime(ts) {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : ts;
}
function formatEventLine(ev, paint = (_s, t) => t) {
  const from = ev.from === null ? "\xB7" : paint(ev.from, ev.from);
  return `${isoTime(ev.ts)} ${ev.session} ${from} \u2192 ${paint(ev.to, ev.to)}`;
}
function eventsPath() {
  return join16(stateHome(), "events.jsonl");
}
function appendEvents(events, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  if (events.length === 0) return;
  const path2 = eventsPath();
  try {
    mkdirSync10(stateHome(), { recursive: true });
    if (existsSync16(path2) && shouldRotate(statSync2(path2).size)) {
      renameSync6(path2, `${path2}.1`);
    }
    const ts = now();
    const lines = events.map((e) => `${JSON.stringify({ ts, ...e })}
`).join("");
    appendFileSync(path2, lines);
  } catch {
  }
}
var EVENTS_MAX_BYTES;
var init_events = __esm({
  "packages/daemon/src/tui/chrome/events.ts"() {
    "use strict";
    init_state_home();
    EVENTS_MAX_BYTES = 1024 * 1024;
  }
});

// packages/daemon/src/tui/mirror/hosted.ts
function wantsHostedApp(input) {
  if (input.hostedEnv) return false;
  return input.flagDetachable || input.flagHosted || input.configDetachable;
}
function shellQuote(word) {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
function hostedEnvVars(base) {
  const env = {
    [HOSTED_ENV]: "1",
    TMUX_IDE_CWD: base.cwd,
    TMUX_IDE_CLI: base.cli
  };
  if (base.path) env.PATH = base.path;
  if (base.home) env.TMUX_IDE_HOME = base.home;
  if (base.config) env.TMUX_IDE_CONFIG = base.config;
  if (base.tuiBin) env.TMUX_IDE_TUI_BIN = base.tuiBin;
  return env;
}
function hostedCommandLine(bin, argv, env) {
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ["exec", "env", ...assigns, shellQuote(bin), ...argv.map(shellQuote)].join(" ");
}
function hostExistsArgv() {
  return ["has-session", "-t", `=${APP_HOST_SESSION}`];
}
function hostCreateArgv(opts) {
  return ["new-session", "-d", "-s", APP_HOST_SESSION, "-c", opts.cwd, opts.commandLine];
}
function hostSetupArgvs() {
  const heal = `set-option -w -t ${APP_HOST_SESSION}: window-size latest`;
  return [
    ["set-option", "-t", APP_HOST_SESSION, "status", "off"],
    ["set-option", "-w", "-t", `${APP_HOST_SESSION}:`, "window-size", "latest"],
    ["set-option", "-s", "focus-events", "on"],
    ...HOST_RESIZE_HOOKS.map((hook) => ["set-hook", "-t", APP_HOST_SESSION, hook, heal])
  ];
}
function hostAttachArgv(insideTmux) {
  return insideTmux ? ["switch-client", "-t", `=${APP_HOST_SESSION}`] : ["attach-session", "-t", `=${APP_HOST_SESSION}`];
}
var APP_HOST_SESSION, HOSTED_ENV, HOST_RESIZE_HOOKS;
var init_hosted = __esm({
  "packages/daemon/src/tui/mirror/hosted.ts"() {
    "use strict";
    APP_HOST_SESSION = "_tmux-ide-app";
    HOSTED_ENV = "TMUX_IDE_HOSTED";
    HOST_RESIZE_HOOKS = [
      "client-attached",
      "client-focus-in",
      "client-session-changed"
    ];
  }
});

// packages/daemon/src/tui/mirror/selection.ts
function tmuxPassthrough(seq) {
  const doubled = seq.split("\x1B").join("\x1B\x1B");
  return `\x1BPtmux;${doubled}\x1B\\`;
}
var init_selection = __esm({
  "packages/daemon/src/tui/mirror/selection.ts"() {
    "use strict";
  }
});

// packages/daemon/src/tui/chrome/notify-prefs.ts
function parseHHMM(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
var init_notify_prefs = __esm({
  "packages/daemon/src/tui/chrome/notify-prefs.ts"() {
    "use strict";
  }
});

// packages/daemon/src/tui/chrome/notify.ts
import { execFileSync as execFileSync7, spawn as spawn4 } from "node:child_process";
import { dirname as dirname16, resolve as resolve12 } from "node:path";
import { fileURLToPath as fileURLToPath6 } from "node:url";
import {
  closeSync,
  constants as fsConstants,
  existsSync as existsSync17,
  openSync,
  readFileSync as readFileSync12,
  writeSync
} from "node:fs";
function statusPhrase(to) {
  return to === "blocked" ? "needs input" : "finished";
}
function notifyMessage(ev) {
  const agent = ev.agent && ev.agent.length > 0 ? ev.agent : "agent";
  const where = ev.location && ev.location.length > 0 ? ev.location : ev.session;
  const text = `${agent} ${ev.to} \xB7 ${where} \u2014 ${statusPhrase(ev.to)}`;
  return text.length > NOTIFY_MAX_LEN ? `${text.slice(0, NOTIFY_MAX_LEN - 1)}\u2026` : text;
}
function enabledStates(prefs) {
  const states = /* @__PURE__ */ new Set();
  if (prefs.onBlocked) states.add("blocked");
  if (prefs.onDone) states.add("done");
  return states;
}
function notifyDebounceKey(ev) {
  return `${ev.paneId ?? ev.session}:${ev.to}`;
}
function suppressToastFor(client, ev) {
  if (client.session === APP_HOST_SESSION) return true;
  if (client.session !== ev.session) return false;
  if (ev.windowIndex === void 0 || ev.windowIndex === null) return true;
  if (client.windowIndex === void 0 || client.windowIndex === null) return true;
  return client.windowIndex === ev.windowIndex;
}
function decideNotifications(events, clients, lastNotified, nowMs, states = NOTIFY_STATES, appFocus = null) {
  const nextLastNotified = new Map(lastNotified);
  const toasts = [];
  const system = [];
  for (const ev of events) {
    if (ev.from === null) continue;
    if (!states.has(ev.to)) continue;
    const key = notifyDebounceKey(ev);
    const last = nextLastNotified.get(key);
    if (last !== void 0 && nowMs - last < NOTIFY_DEBOUNCE_MS) continue;
    if (appFocus?.attached && ev.paneId && appFocus.panes.includes(ev.paneId)) continue;
    nextLastNotified.set(key, nowMs);
    const message = notifyMessage(ev);
    for (const c of clients) {
      if (suppressToastFor(c, ev)) continue;
      toasts.push({ client: c.client, message });
    }
    system.push({
      message,
      session: ev.session,
      state: ev.to,
      paneId: ev.paneId ?? null,
      windowIndex: ev.windowIndex ?? null
    });
  }
  return { toasts, system, nextLastNotified };
}
function parseClients(lines) {
  const out = [];
  for (const line of lines) {
    const [client = "", session = "", win = "", tty = "", termname = ""] = line.split("	");
    if (!client || !session) continue;
    const n = Number.parseInt(win, 10);
    out.push({
      client,
      session,
      windowIndex: Number.isInteger(n) ? n : null,
      tty: tty || null,
      termname: termname || null
    });
  }
  return out;
}
function listAttachedClients() {
  try {
    const raw = runTmux([
      "list-clients",
      "-F",
      "#{client_name}	#{session_name}	#{window_index}	#{client_tty}	#{client_termname}"
    ]).toString().trim();
    return raw ? parseClients(raw.split("\n")) : [];
  } catch {
    return [];
  }
}
function parseAppFocus(raw, nowMs) {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const ts = typeof o.ts === "number" ? o.ts : null;
    if (ts === null || nowMs - ts > APP_FOCUS_STALE_MS) return null;
    return {
      ts,
      attached: o.attached === true,
      session: typeof o.session === "string" ? o.session : "",
      panes: Array.isArray(o.panes) ? o.panes.filter((p) => typeof p === "string") : []
    };
  } catch {
    return null;
  }
}
function readAppFocus(nowMs = Date.now()) {
  try {
    const raw = runTmux(["show-option", "-s", "-v", APP_FOCUS_OPTION]).toString().trim();
    return parseAppFocus(raw, nowMs);
  } catch {
    return null;
  }
}
function sendToasts(toasts) {
  for (const { client, message } of toasts) {
    try {
      runTmux(["display-message", "-c", client, "-d", "3000", message]);
    } catch {
    }
  }
}
function osc9Notification(text) {
  return `\x1B]9;${text}\x07`;
}
function osc99Notification(text, urgent) {
  return `\x1B]99;${urgent ? "u=2" : ""};${text}\x1B\\`;
}
function terminalNotifyEscape(termname, text, urgent) {
  const t = termname ?? "";
  if (t.includes("kitty")) return osc99Notification(text, urgent);
  if (t.startsWith("tmux") || t.startsWith("screen")) {
    return tmuxPassthrough(osc9Notification(text));
  }
  return osc9Notification(text);
}
function soundEligible(state, sound) {
  if (sound === "none") return false;
  if (sound === "all") return state === "blocked" || state === "done";
  return state === "blocked";
}
function belEligible(state, sound) {
  return state === "blocked" && sound !== "none";
}
function decideTtyWrites(n, clients, prefs) {
  const asEvent = {
    session: n.session,
    from: null,
    to: n.state,
    paneId: n.paneId,
    windowIndex: n.windowIndex
  };
  const bel = belEligible(n.state, prefs.sound) ? "\x07" : "";
  const out = [];
  for (const c of clients) {
    if (!c.tty) continue;
    if (suppressToastFor(c, asEvent)) continue;
    const escape = prefs.terminal ? terminalNotifyEscape(c.termname, n.message, n.state === "blocked") : "";
    const data = escape + bel;
    if (data) out.push({ tty: c.tty, data });
  }
  return out;
}
function writeClientTty(write) {
  let fd = null;
  try {
    fd = openSync(write.tty, fsConstants.O_WRONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
    writeSync(fd, write.data);
  } catch {
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
function writeTtys(writes) {
  for (const w of writes) writeClientTty(w);
}
function soundArgv(platform) {
  if (platform === "darwin") return ["afplay", DARWIN_SOUND_FILE];
  if (platform === "linux") return ["paplay", LINUX_SOUND_FILE];
  return null;
}
function playPingSound(platform = process.platform) {
  const argv = soundArgv(platform);
  if (!argv || !existsSync17(argv[1])) return;
  try {
    const child = spawn4(argv[0], argv.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function binaryPath(name) {
  try {
    const path2 = execFileSync7("which", [name], { encoding: "utf8" }).trim();
    return path2.startsWith("/") ? path2 : null;
  } catch {
    return null;
  }
}
function hasBinary(name) {
  return binaryPath(name) !== null;
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function notifierExecuteCommand(session) {
  const target = shellSingleQuote(session);
  const host = shellSingleQuote(`=${APP_HOST_SESSION}`);
  return `if tmux has-session -t ${host} 2>/dev/null; then tmux set-option -t ${shellSingleQuote(APP_HOST_SESSION)} ${APP_JUMP_OPTION} ${target}; tmux switch-client -t ${host}; else tmux switch-client -t ${target}; fi`;
}
function resolveNativeMacosNotifierPath(io = {}) {
  const exists = io.exists ?? existsSync17;
  const cliPath = io.cliPath === void 0 ? process.env.TMUX_IDE_CLI : io.cliPath;
  const modulePath = io.modulePath ?? fileURLToPath6(import.meta.url);
  const anchors = [cliPath, modulePath].filter((path2) => Boolean(path2)).map((path2) => dirname16(resolve12(path2)));
  const visited = /* @__PURE__ */ new Set();
  for (const anchor of anchors) {
    let directory = anchor;
    while (!visited.has(directory)) {
      visited.add(directory);
      const candidate = resolve12(directory, NATIVE_MACOS_NOTIFIER_RELATIVE_PATH);
      if (exists(resolve12(candidate, NATIVE_MACOS_NOTIFIER_EXECUTABLE))) return candidate;
      const parent = dirname16(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return null;
}
function parseTmuxSocketPath(value) {
  if (!value) return null;
  const normalized = value.trim();
  const path2 = (/^(.*),\d+,\d+$/.exec(normalized)?.[1] ?? normalized).trim();
  return path2.startsWith("/") ? path2 : null;
}
function nativeMacosNotifierArgs(appPath, n, tmuxPath, socketPath) {
  const args = [
    "-g",
    "-n",
    appPath,
    "--args",
    "--title",
    "tmux-ide",
    "--message",
    n.message,
    "--session",
    n.session,
    "--host-session",
    APP_HOST_SESSION,
    "--jump-option",
    APP_JUMP_OPTION
  ];
  if (tmuxPath) args.push("--tmux-path", tmuxPath);
  if (socketPath) args.push("--socket-path", socketPath);
  return args;
}
function terminalNotifierArgs(n) {
  return [
    "-title",
    "tmux-ide",
    "-message",
    n.message,
    "-execute",
    notifierExecuteCommand(n.session)
  ];
}
function notifySendArgs(n) {
  const args = ["--app-name=tmux-ide"];
  if (n.state === "blocked") args.push("--urgency=critical");
  args.push("tmux-ide", n.message);
  return args;
}
function sendSystemNotification(n, io = {}) {
  const platform = io.platform ?? process.platform;
  const exec = io.exec ?? ((cmd, args) => execFileSync7(cmd, args, { stdio: "ignore" }));
  const has = io.hasBinary ?? hasBinary;
  try {
    if (platform === "darwin") {
      const appPath = io.nativeNotifierPath === void 0 ? resolveNativeMacosNotifierPath() : io.nativeNotifierPath;
      if (appPath) {
        const env = io.env ?? process.env;
        const tmuxPath = io.tmuxPath === void 0 ? binaryPath("tmux") : io.tmuxPath;
        try {
          exec(
            "/usr/bin/open",
            nativeMacosNotifierArgs(appPath, n, tmuxPath, parseTmuxSocketPath(env.TMUX))
          );
          return;
        } catch {
        }
      }
      if (has("terminal-notifier")) {
        exec("terminal-notifier", terminalNotifierArgs(n));
        return;
      }
      const escaped = n.message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      exec("osascript", ["-e", `display notification "${escaped}" with title "tmux-ide"`]);
      return;
    }
    if (platform === "linux") {
      const env = io.env ?? process.env;
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return;
      if (!has("notify-send")) return;
      exec("notify-send", notifySendArgs(n));
    }
  } catch {
  }
}
function asObject2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function pickBool2(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}
function inQuietHours(now, quiet) {
  if (!quiet) return false;
  const start2 = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start2 === null || end === null || start2 === end) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return start2 < end ? nowMin >= start2 && nowMin < end : nowMin >= start2 || nowMin < end;
}
function parseQuietHours(value) {
  const o = asObject2(value);
  const start2 = typeof o.start === "string" ? o.start : null;
  const end = typeof o.end === "string" ? o.end : null;
  if (start2 === null || end === null) return null;
  if (parseHHMM(start2) === null || parseHHMM(end) === null) return null;
  return { start: start2, end };
}
function parseNotificationPrefs(rawConfig) {
  const base = parseAppConfig(rawConfig).notifications;
  const n = asObject2(asObject2(rawConfig).notifications);
  return {
    enabled: pickBool2(n.enabled, DEFAULT_NOTIFICATION_PREFS.enabled),
    toast: base.toast,
    macos: base.macos,
    terminal: base.terminal,
    delaySeconds: base.delaySeconds,
    sound: base.sound,
    onBlocked: pickBool2(n.onBlocked, DEFAULT_NOTIFICATION_PREFS.onBlocked),
    onDone: pickBool2(n.onDone, DEFAULT_NOTIFICATION_PREFS.onDone),
    quietHours: parseQuietHours(n.quietHours)
  };
}
function applyKillSwitch(prefs, envValue) {
  return envValue === "0" ? { ...prefs, enabled: false, toast: false, macos: false, terminal: false, sound: "none" } : prefs;
}
function readRawConfig() {
  const path2 = appConfigPath();
  if (!existsSync17(path2)) return void 0;
  try {
    return JSON.parse(readFileSync12(path2, "utf-8"));
  } catch {
    return void 0;
  }
}
function readNotificationPrefs() {
  return applyKillSwitch(parseNotificationPrefs(readRawConfig()), process.env.TMUX_IDE_NOTIFY);
}
var NOTIFY_STATES, NOTIFY_DEBOUNCE_MS, NOTIFY_MAX_LEN, APP_FOCUS_OPTION, APP_FOCUS_STALE_MS, DARWIN_SOUND_FILE, LINUX_SOUND_FILE, APP_JUMP_OPTION, NATIVE_MACOS_NOTIFIER_RELATIVE_PATH, NATIVE_MACOS_NOTIFIER_EXECUTABLE, DEFAULT_NOTIFICATION_PREFS;
var init_notify = __esm({
  "packages/daemon/src/tui/chrome/notify.ts"() {
    "use strict";
    init_src2();
    init_app_config();
    init_hosted();
    init_selection();
    init_notify_prefs();
    NOTIFY_STATES = /* @__PURE__ */ new Set(["blocked", "done"]);
    NOTIFY_DEBOUNCE_MS = 3e4;
    NOTIFY_MAX_LEN = 120;
    APP_FOCUS_OPTION = "@tmux_ide_app_focus";
    APP_FOCUS_STALE_MS = 15e3;
    DARWIN_SOUND_FILE = "/System/Library/Sounds/Tink.aiff";
    LINUX_SOUND_FILE = "/usr/share/sounds/freedesktop/stereo/complete.oga";
    APP_JUMP_OPTION = "@tmux_ide_app_jump";
    NATIVE_MACOS_NOTIFIER_RELATIVE_PATH = "packages/daemon/dist/native/TmuxIdeNotifier.app";
    NATIVE_MACOS_NOTIFIER_EXECUTABLE = "Contents/MacOS/tmux-ide-notifier";
    DEFAULT_NOTIFICATION_PREFS = {
      enabled: true,
      toast: true,
      macos: false,
      terminal: true,
      delaySeconds: 2,
      sound: "blocked",
      onBlocked: true,
      onDone: true,
      quietHours: null
    };
  }
});

// packages/daemon/src/tui/chrome/notify-state.ts
import { existsSync as existsSync18, mkdirSync as mkdirSync11, readFileSync as readFileSync13, writeFileSync as writeFileSync10 } from "node:fs";
import { join as join17 } from "node:path";
function notifyStatePath() {
  return join17(stateHome(), "notify-state.json");
}
function serializeLastNotified(map, nowMs) {
  const lastNotified = {};
  for (const [key, ts] of map) {
    if (nowMs - ts < NOTIFY_DEBOUNCE_MS) lastNotified[key] = ts;
  }
  return JSON.stringify({ lastNotified });
}
function parseLastNotified(json2, nowMs) {
  const out = /* @__PURE__ */ new Map();
  try {
    const parsed = JSON.parse(json2);
    const raw = parsed?.lastNotified;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, ts] of Object.entries(raw)) {
      if (typeof ts !== "number") continue;
      if (nowMs - ts >= NOTIFY_DEBOUNCE_MS) continue;
      if (ts - nowMs > NOTIFY_DEBOUNCE_MS) continue;
      out.set(key, ts);
    }
  } catch {
  }
  return out;
}
function loadLastNotified(nowMs = Date.now()) {
  const path2 = notifyStatePath();
  if (!existsSync18(path2)) return /* @__PURE__ */ new Map();
  try {
    return parseLastNotified(readFileSync13(path2, "utf-8"), nowMs);
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function saveLastNotified(map, nowMs = Date.now()) {
  try {
    mkdirSync11(stateHome(), { recursive: true });
    writeFileSync10(notifyStatePath(), serializeLastNotified(map, nowMs));
  } catch {
  }
}
var init_notify_state = __esm({
  "packages/daemon/src/tui/chrome/notify-state.ts"() {
    "use strict";
    init_state_home();
    init_notify();
  }
});

// packages/daemon/src/tui/chrome/snapshot.ts
import { existsSync as existsSync19, mkdirSync as mkdirSync12, readFileSync as readFileSync14, renameSync as renameSync7, writeFileSync as writeFileSync11 } from "node:fs";
import { homedir as homedir12 } from "node:os";
import { dirname as dirname17, join as join18 } from "node:path";
import { z as z26 } from "zod";
function isBareShell(cmd) {
  return /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh|nu)$/.test(cmd.trim());
}
function resolvePaneCommand(cmd, pid, hint, table) {
  const { manifest } = resolveAgentCommand(cmd, pid, table, { hint: hint || void 0 });
  if (manifest && manifest.id !== "shell") {
    return { agent: manifest.id, command: manifest.id };
  }
  if (isBareShell(cmd)) return { agent: null, command: null };
  return { agent: null, command: cmd };
}
function nullable(value) {
  return value.length > 0 ? value : null;
}
function buildSnapshot(rawPanes, rawSessions, table, savedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  const adopted = /* @__PURE__ */ new Set();
  for (const line of rawSessions) {
    const [name = "", flag = ""] = line.split("	");
    if (name && flag === "1") adopted.add(name);
  }
  const sessions = /* @__PURE__ */ new Map();
  for (const line of rawPanes) {
    if (line.length === 0) continue;
    const [
      session = "",
      windowIndex = "0",
      windowName = "",
      windowActive = "0",
      layout = "",
      paneIndex = "0",
      cwd = "",
      cmd = "",
      pid = "0",
      agentSessionId = "",
      agentState = "",
      hint = "",
      ...titleParts
    ] = line.split("	");
    if (!session || !isListableSession(session)) continue;
    let windows = sessions.get(session);
    if (!windows) {
      windows = /* @__PURE__ */ new Map();
      sessions.set(session, windows);
    }
    const wIndex = Number(windowIndex) || 0;
    let win = windows.get(wIndex);
    if (!win) {
      win = {
        index: wIndex,
        name: windowName,
        active: windowActive === "1",
        layout,
        panes: []
      };
      windows.set(wIndex, win);
    }
    const { agent, command: command2 } = resolvePaneCommand(cmd, Number(pid) || 0, hint, table);
    win.panes.push({
      index: Number(paneIndex) || 0,
      cwd,
      command: command2,
      agent,
      agentSessionId: nullable(agentSessionId),
      agentState: nullable(agentState),
      title: titleParts.join("	")
    });
  }
  const out = [];
  for (const [name, windows] of sessions) {
    const windowList = [...windows.values()].sort((a, b) => a.index - b.index).map((w) => ({
      index: w.index,
      name: w.name,
      active: w.active,
      layout: w.layout,
      panes: w.panes.slice().sort((a, b) => a.index - b.index)
    }));
    const cwd = windowList[0]?.panes[0]?.cwd ?? "";
    out.push({ name, cwd, adopted: adopted.has(name), windows: windowList });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { version: 1, savedAt, sessions: out };
}
function snapshotFingerprint(snapshot) {
  const structural = {
    sessions: snapshot.sessions.map((s) => ({
      name: s.name,
      cwd: s.cwd,
      adopted: s.adopted,
      windows: s.windows.map((w) => ({
        index: w.index,
        name: w.name,
        active: w.active,
        layout: w.layout,
        panes: w.panes.map((p) => ({
          index: p.index,
          cwd: p.cwd,
          command: p.command,
          agent: p.agent,
          agentSessionId: p.agentSessionId,
          title: p.title
          // agentState deliberately omitted — it churns every tick.
        }))
      }))
    }))
  };
  return JSON.stringify(structural);
}
function collectFleetSnapshot(io = defaultIo) {
  const rawPanes = io.listPanes().split("\n").filter(Boolean);
  const rawSessions = io.listSessions().split("\n").filter(Boolean);
  return buildSnapshot(rawPanes, rawSessions, io.processTable());
}
function snapshotPath() {
  return join18(homedir12(), ".tmux-ide", "snapshot.json");
}
function writeSnapshot(snapshot) {
  const path2 = snapshotPath();
  try {
    mkdirSync12(dirname17(path2), { recursive: true });
    const tmp = `${path2}.tmp`;
    writeFileSync11(tmp, JSON.stringify(snapshot, null, 2) + "\n");
    if (existsSync19(path2)) {
      try {
        renameSync7(path2, `${path2}.1`);
      } catch {
      }
    }
    renameSync7(tmp, path2);
  } catch {
  }
}
function readSnapshot() {
  const path2 = snapshotPath();
  try {
    if (!existsSync19(path2)) return null;
    const raw = readFileSync14(path2, "utf-8");
    if (raw.trim().length === 0) return null;
    const result = FleetSnapshotSchemaZ.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
function createSnapshotter(deps2) {
  let ticks = 0;
  let seeded = false;
  let lastFingerprint = null;
  return {
    onTick() {
      ticks++;
      if (deps2.every <= 0 || ticks % deps2.every !== 0) return;
      if (!seeded) {
        const existing = deps2.read();
        lastFingerprint = existing ? snapshotFingerprint(existing) : null;
        seeded = true;
      }
      const snapshot = deps2.collect();
      const fingerprint = snapshotFingerprint(snapshot);
      if (fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      deps2.write(snapshot);
    }
  };
}
var PaneSnapshotSchemaZ, WindowSnapshotSchemaZ, SessionSnapshotSchemaZ, FleetSnapshotSchemaZ, SNAPSHOT_PANE_FORMAT, SNAPSHOT_SESSION_FORMAT, defaultIo;
var init_snapshot2 = __esm({
  "packages/daemon/src/tui/chrome/snapshot.ts"() {
    "use strict";
    init_src2();
    init_process_tree();
    init_sessions2();
    PaneSnapshotSchemaZ = z26.object({
      index: z26.number(),
      cwd: z26.string(),
      command: z26.string().nullable(),
      agent: z26.string().nullable(),
      agentSessionId: z26.string().nullable(),
      agentState: z26.string().nullable(),
      title: z26.string()
    });
    WindowSnapshotSchemaZ = z26.object({
      index: z26.number(),
      name: z26.string(),
      active: z26.boolean(),
      layout: z26.string(),
      panes: z26.array(PaneSnapshotSchemaZ)
    });
    SessionSnapshotSchemaZ = z26.object({
      name: z26.string(),
      cwd: z26.string(),
      adopted: z26.boolean(),
      windows: z26.array(WindowSnapshotSchemaZ)
    });
    FleetSnapshotSchemaZ = z26.object({
      version: z26.literal(1),
      savedAt: z26.string(),
      sessions: z26.array(SessionSnapshotSchemaZ)
    });
    SNAPSHOT_PANE_FORMAT = [
      "#{session_name}",
      "#{window_index}",
      "#{window_name}",
      "#{window_active}",
      "#{window_layout}",
      "#{pane_index}",
      "#{pane_current_path}",
      "#{pane_current_command}",
      "#{pane_pid}",
      "#{@agent_session_id}",
      "#{@agent_state}",
      "#{@agent_hint}",
      "#{pane_title}"
    ].join("	");
    SNAPSHOT_SESSION_FORMAT = ["#{session_name}", "#{@tmux_ide_adopted}"].join("	");
    defaultIo = {
      listPanes: () => runTmux(["list-panes", "-a", "-F", SNAPSHOT_PANE_FORMAT]).toString(),
      listSessions: () => runTmux(["list-sessions", "-F", SNAPSHOT_SESSION_FORMAT]).toString(),
      processTable: () => readProcessTable()
    };
  }
});

// packages/daemon/src/tui/chrome/updater.ts
var updater_exports = {};
__export(updater_exports, {
  ADOPTED_OPTION: () => ADOPTED_OPTION,
  CHIP_OPTION: () => CHIP_OPTION,
  STATUS_OPTION: () => STATUS_OPTION,
  TICK_MS: () => TICK_MS,
  UPDATER_PID_OPTION: () => UPDATER_PID_OPTION,
  UPDATER_SESSION: () => UPDATER_SESSION,
  UPDATER_UNREACHABLE_EXIT_TICKS: () => UPDATER_UNREACHABLE_EXIT_TICKS,
  adoptedSessionsFrom: () => adoptedSessionsFrom,
  createUnreachableCounter: () => createUnreachableCounter,
  diffPaneTransitions: () => diffPaneTransitions,
  fleetStatuses: () => fleetStatuses,
  listAdoptedSessions: () => listAdoptedSessions,
  paneLocation: () => paneLocation,
  runUpdaterLoop: () => runUpdaterLoop,
  runUpdaterTick: () => runUpdaterTick,
  seedSessionStatus: () => seedSessionStatus,
  startUpdaterIfNeeded: () => startUpdaterIfNeeded,
  stopUpdater: () => stopUpdater,
  updateSegment: () => updateSegment,
  updaterProbeArgv: () => updaterProbeArgv,
  updaterRunning: () => updaterRunning,
  updaterSpawnArgv: () => updaterSpawnArgv
});
function adoptedSessionsFrom(lines) {
  const out = [];
  for (const line of lines) {
    const [name = "", flag = ""] = line.split("	");
    if (name && flag === "1") out.push(name);
  }
  return out;
}
function listAdoptedSessions() {
  try {
    const raw = runTmux(["list-sessions", "-F", `#{session_name}	#{${ADOPTED_OPTION}}`]).toString().trim();
    return raw ? adoptedSessionsFrom(raw.split("\n")) : [];
  } catch {
    return [];
  }
}
function writeSessionStatus(session, value) {
  runTmux(["set-option", "-t", session, STATUS_OPTION, value]);
}
function writePaneChip(paneId, value) {
  runTmux(["set-option", "-p", "-t", paneId, CHIP_OPTION, value]);
}
function updateSegment(status2, theme) {
  if (!status2.updateAvailable || !status2.latest) return "";
  return `#[range=user|update]#[fg=${theme.accent}]\u2B06 v${status2.latest}#[default]#[norange]`;
}
function fleetStatuses(projects) {
  return projects.flatMap((p) => p.sessions.map((s) => ({ name: s.name, status: s.status })));
}
function runUpdaterTick(deps2) {
  const adopted = deps2.listAdopted();
  if (adopted.length === 0) return;
  const theme = deps2.theme ?? DEFAULT_THEME;
  const panes = [];
  const projects = deps2.computeProjects((pane) => panes.push(pane));
  const update = deps2.maybeCheckForUpdate?.();
  const extra = update ? updateSegment(update, theme) : "";
  for (const session of adopted) {
    deps2.writeStatus(session, buildStatusline(projects, session, 12, theme, extra));
  }
  writeChips(deps2, adopted, panes, theme);
  deps2.captureSessionIds?.(panes);
  if (update?.updateAvailable && update.latest) dispatchUpdateToast(deps2, update.latest);
  if (deps2.prevState && deps2.appendEvents) {
    const { events, state } = diffFleet(deps2.prevState, fleetStatuses(projects));
    deps2.prevState.clear();
    for (const [name, status2] of state) deps2.prevState.set(name, status2);
    if (events.length > 0) deps2.appendEvents(events);
  }
  if (deps2.prevPaneState) {
    firePendingOsPings(deps2, panes);
    const events = diffPaneTransitions(deps2.prevPaneState, panes, deps2.locatePane);
    if (events.length > 0) dispatchNotifications(deps2, events);
  }
}
function writeChips(deps2, adopted, panes, theme) {
  const { writeChip, chipCache } = deps2;
  if (!writeChip || !chipCache) return;
  const adoptedSet = new Set(adopted);
  for (const pane of panes) {
    if (!adoptedSet.has(pane.sessionName)) continue;
    const chip = paneChip(pane.agent, pane.status, theme);
    if (chipCache.get(pane.paneId) === chip) continue;
    chipCache.set(pane.paneId, chip);
    writeChip(pane.paneId, chip);
  }
}
function diffPaneTransitions(prev, panes, locate) {
  const events = [];
  const next = /* @__PURE__ */ new Map();
  for (const pane of panes) {
    const before = prev.has(pane.paneId) ? prev.get(pane.paneId) : null;
    next.set(pane.paneId, pane.status);
    if (before === pane.status) continue;
    const notifiable = before !== null && (pane.status === "blocked" || pane.status === "done");
    events.push({
      session: pane.sessionName,
      from: before,
      to: pane.status,
      paneId: pane.paneId,
      windowIndex: pane.windowIndex,
      agent: pane.agent,
      location: notifiable && locate ? locate(pane.paneId) : pane.sessionName
    });
  }
  prev.clear();
  for (const [paneId, status2] of next) prev.set(paneId, status2);
  return events;
}
function anyChannelOn(prefs) {
  return prefs.toast || prefs.macos || prefs.terminal || prefs.sound !== "none";
}
function dispatchNotifications(deps2, events) {
  const { listClients, lastNotified, now, prefs, sendToasts: toast } = deps2;
  if (!listClients || !lastNotified || !now || !prefs) return;
  if (!prefs.enabled) return;
  if (!anyChannelOn(prefs)) return;
  const nowMs = now();
  const decision = decideNotifications(
    events,
    listClients(),
    lastNotified,
    nowMs,
    enabledStates(prefs),
    deps2.appFocus?.() ?? null
  );
  lastNotified.clear();
  for (const [key, ts] of decision.nextLastNotified) lastNotified.set(key, ts);
  if (decision.system.length > 0) deps2.persistNotified?.(lastNotified);
  if (prefs.toast && toast) toast(decision.toasts);
  if (decision.system.length === 0) return;
  const delayMs = prefs.delaySeconds * 1e3;
  if (delayMs > 0 && deps2.pendingPings) {
    for (const n of decision.system) deps2.pendingPings.push({ ...n, dueAtMs: nowMs + delayMs });
  } else {
    fireOsChannels(deps2, prefs, decision.system, nowMs);
  }
}
function firePendingOsPings(deps2, panes) {
  const { pendingPings: pending, now, prefs } = deps2;
  if (!pending || pending.length === 0 || !now || !prefs) return;
  const nowMs = now();
  const due = [];
  const keep = [];
  for (const p of pending) (p.dueAtMs <= nowMs ? due : keep).push(p);
  if (due.length === 0) return;
  pending.length = 0;
  for (const p of keep) pending.push(p);
  if (!prefs.enabled) return;
  const statusByPane = new Map(panes.map((p) => [p.paneId, p.status]));
  const focus = deps2.appFocus?.() ?? null;
  const confirmed = due.filter((p) => {
    if (p.paneId !== null && statusByPane.get(p.paneId) !== p.state) return false;
    if (focus?.attached && p.paneId !== null && focus.panes.includes(p.paneId)) return false;
    return true;
  });
  fireOsChannels(deps2, prefs, confirmed, nowMs);
}
function fireOsChannels(deps2, prefs, entries, nowMs) {
  if (entries.length === 0) return;
  if (inQuietHours(new Date(nowMs), prefs.quietHours)) return;
  if (prefs.macos && deps2.sendSystem) {
    for (const n of entries) deps2.sendSystem(n);
  }
  if ((prefs.terminal || prefs.sound !== "none") && deps2.sendTerminal && deps2.listClients) {
    const clients = deps2.listClients();
    const writes = entries.flatMap((n) => decideTtyWrites(n, clients, prefs));
    if (writes.length > 0) deps2.sendTerminal(writes);
  }
  if (deps2.playSound && entries.some((n) => soundEligible(n.state, prefs.sound))) {
    deps2.playSound();
  }
}
function paneLocation(paneId) {
  try {
    const raw = runTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}:#{window_index}.#{pane_index}"
    ]).toString().trim();
    return raw || paneId;
  } catch {
    return paneId;
  }
}
function dispatchUpdateToast(deps2, version) {
  const { markUpdateNotified: mark, listClients, sendToasts: toast, prefs } = deps2;
  if (!mark || !listClients || !toast) return;
  if (prefs && !prefs.toast) return;
  if (!mark(version)) return;
  const message = `\u2B06 tmux-ide v${version} available \u2014 run: tmux-ide update`;
  toast(listClients().map((c) => ({ client: c.client, message })));
}
function seedSessionStatus(session) {
  try {
    const projects = listTeamProjects(createStatusTracker());
    writeSessionStatus(session, buildStatusline(projects, session, 12, getAppConfig().theme));
  } catch {
  }
}
function updaterRunning() {
  try {
    return hasSession(UPDATER_SESSION);
  } catch {
    return false;
  }
}
function startUpdaterIfNeeded() {
  try {
    if (updaterRunning()) return;
    runTmux(updaterSpawnArgv());
  } catch {
  }
}
function stopUpdater() {
  try {
    if (updaterRunning()) runTmux(["kill-session", "-t", UPDATER_SESSION]);
  } catch {
  }
}
function readUpdaterPid() {
  try {
    const raw = runTmux(["show-option", "-s", "-v", UPDATER_PID_OPTION]).toString().trim();
    const pid = Number(raw);
    return raw && Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}
function claimUpdater() {
  const existing = readUpdaterPid();
  if (existing !== null && existing !== process.pid && isProcessAlive(existing)) return false;
  try {
    runTmux(["set-option", "-s", UPDATER_PID_OPTION, String(process.pid)]);
  } catch {
  }
  return true;
}
function releaseUpdater() {
  try {
    if (readUpdaterPid() === process.pid) runTmux(["set-option", "-s", "-u", UPDATER_PID_OPTION]);
  } catch {
  }
}
function createUnreachableCounter(threshold = UPDATER_UNREACHABLE_EXIT_TICKS) {
  let consecutive = 0;
  return (reachable) => {
    consecutive = reachable ? 0 : consecutive + 1;
    return consecutive >= threshold;
  };
}
function isServerReachable() {
  try {
    runTmux(["list-sessions", "-F", "#{session_name}"]);
    return true;
  } catch {
    return false;
  }
}
function runUpdaterLoop() {
  if (!claimUpdater()) return;
  const config2 = getAppConfig();
  const tracker = createStatusTracker();
  const prevState = /* @__PURE__ */ new Map();
  const prevPaneState = /* @__PURE__ */ new Map();
  const lastNotified = loadLastNotified();
  const pendingPings = [];
  const chipCache = /* @__PURE__ */ new Map();
  const capturer = createSessionIdCapturer({
    // Throwing is fine here — the capturer treats a failed stamp as "retry on
    // the next capture window".
    stamp: (paneId, id) => runTmux(["set-option", "-p", "-t", paneId, "@agent_session_id", id])
  });
  const snapshotter = createSnapshotter({
    collect: () => collectFleetSnapshot(),
    read: readSnapshot,
    write: writeSnapshot,
    every: config2.updater.snapshotEvery
  });
  const shouldGiveUp = createUnreachableCounter();
  const tick = () => {
    try {
      runUpdaterTick({
        listAdopted: listAdoptedSessions,
        computeProjects: (onPane) => listTeamProjects(tracker, { onPane }),
        writeStatus: writeSessionStatus,
        theme: config2.theme,
        writeChip: writePaneChip,
        chipCache,
        prevState,
        appendEvents,
        prevPaneState,
        listClients: listAttachedClients,
        lastNotified,
        now: () => Date.now(),
        prefs: readNotificationPrefs(),
        sendToasts,
        sendSystem: sendSystemNotification,
        sendTerminal: writeTtys,
        playSound: playPingSound,
        pendingPings,
        locatePane: paneLocation,
        appFocus: () => readAppFocus(),
        persistNotified: (map) => saveLastNotified(map),
        maybeCheckForUpdate: () => maybeCheckForUpdate({ enabled: config2.updates.check }),
        markUpdateNotified,
        captureSessionIds: (panes) => capturer.onTick(panes)
      });
    } catch {
    }
    try {
      snapshotter.onTick();
    } catch {
    }
    if (shouldGiveUp(isServerReachable())) {
      console.error(
        `tmux-ide chrome-updater: tmux server unreachable for ${UPDATER_UNREACHABLE_EXIT_TICKS} consecutive ticks \u2014 exiting`
      );
      shutdown();
    }
  };
  const timer = setInterval(tick, config2.updater.tickMs);
  const shutdown = () => {
    clearInterval(timer);
    releaseUpdater();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  tick();
}
var STATUS_OPTION, CHIP_OPTION, UPDATER_PID_OPTION, TICK_MS, UPDATER_UNREACHABLE_EXIT_TICKS;
var init_updater = __esm({
  "packages/daemon/src/tui/chrome/updater.ts"() {
    "use strict";
    init_src2();
    init_front_door();
    init_app_config();
    init_update_check();
    init_classify();
    init_session_id();
    init_projects();
    init_chip();
    init_events();
    init_notify();
    init_notify_state();
    init_snapshot2();
    init_statusline();
    init_front_door();
    STATUS_OPTION = "@tmux_ide_status";
    CHIP_OPTION = "@tmux_ide_chip";
    UPDATER_PID_OPTION = "@tmux_ide_updater_pid";
    TICK_MS = 2e3;
    UPDATER_UNREACHABLE_EXIT_TICKS = 5;
  }
});

// packages/daemon/src/tui/chrome/statusline.ts
var statusline_exports = {};
__export(statusline_exports, {
  HOME_KEY: () => HOME_KEY,
  MENU_KEY: () => MENU_KEY,
  MENU_PANE_KEY: () => MENU_PANE_KEY,
  MENU_STATUS_KEY: () => MENU_STATUS_KEY,
  POPUP_KEY: () => POPUP_KEY,
  STATUS_CLICK_KEY: () => STATUS_CLICK_KEY,
  adoptOptionCommands: () => adoptOptionCommands,
  adoptSession: () => adoptSession,
  adoptableSessionNames: () => adoptableSessionNames,
  altKeyBinds: () => altKeyBinds,
  buildStatusline: () => buildStatusline,
  homeBindCommand: () => homeBindCommand,
  homePopupCommand: () => homePopupCommand,
  homeUnbindCommand: () => homeUnbindCommand,
  isInternalName: () => isInternalName,
  popupBindCommand: () => popupBindCommand,
  popupUnbindCommand: () => popupUnbindCommand,
  prefixKeyBinds: () => prefixKeyBinds,
  statusClickBindCommand: () => statusClickBindCommand,
  statusClickUnbindCommand: () => statusClickUnbindCommand,
  statusGlyph: () => statusGlyph,
  statusStyle: () => statusStyle,
  switcherPopupCommand: () => switcherPopupCommand,
  unadoptOptionCommands: () => unadoptOptionCommands,
  unadoptSession: () => unadoptSession,
  updatePopupCommand: () => updatePopupCommand
});
function statusStyle(status2, theme) {
  const color3 = theme.status[status2];
  return status2 === "blocked" ? `#[fg=${color3},bold]` : `#[fg=${color3}]`;
}
function statusGlyph(status2, theme) {
  return status2 === "unknown" ? "\xB7" : theme.glyphs.active;
}
function isInternalName(name) {
  return name.startsWith("_");
}
function adoptableSessionNames(names) {
  return names.filter((name) => name.length > 0 && !isInternalName(name));
}
function buildStatusline(projects, active2, maxItems = 12, theme = DEFAULT_THEME, extraSegment = "") {
  const visible = projects.filter((p) => !isInternalName(p.name));
  const segments = [];
  for (const project of visible.slice(0, maxItems)) {
    const isActive = active2 !== null && (project.name === active2 || project.sessions.some((s) => s.name === active2));
    const glyph = project.running ? `${statusStyle(project.status, theme)}${statusGlyph(project.status, theme)}#[default]` : `#[fg=${theme.muted}]${theme.glyphs.inactive}#[default]`;
    const name = isActive ? `#[fg=colour231,bold,underscore]${project.name}#[default]` : project.running ? `#[fg=${theme.fg}]${project.name}#[default]` : `#[fg=${theme.muted}]${project.name}#[default]`;
    const label = `${glyph} ${name}`;
    const session = project.sessions[0]?.name;
    segments.push(
      project.running && session ? `#[range=user|sw${session}]${label}#[norange]` : label
    );
  }
  if (visible.length > maxItems) {
    segments.push(`#[fg=${theme.muted}]+${visible.length - maxItems}#[default]`);
  }
  const body = segments.join("  ");
  const extra = extraSegment ? `${extraSegment} ` : "";
  const keysTrigger = `#[range=user|keys]#[fg=colour244][ ? keys ^b k ]#[default]#[norange]`;
  const homeTrigger = `#[range=user|home]#[fg=colour244][ \u2302 home ^b h ]#[default]#[norange]`;
  const trigger = `#[range=user|switcher]#[fg=${theme.accent},bold][ \u29C9 switch ^b j ]#[default]#[norange]`;
  return `#[fg=${theme.accent},bold] tmux-ide #[default] ${body}#[align=right]${extra}${homeTrigger} ${keysTrigger} ${trigger} `;
}
function switcherPopupCommand(switcherCmd = "tmux-ide switcher") {
  return `display-popup -E -w 80% -h 60% "${switcherCmd}"`;
}
function popupBindCommand(switcherCmd = "tmux-ide switcher", key = POPUP_KEY) {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "80%", "-h", "60%", switcherCmd];
}
function popupUnbindCommand(key = POPUP_KEY) {
  return ["unbind-key", "-n", key];
}
function homePopupCommand(homeCmd = "tmux-ide team --popup") {
  return `display-popup -E -w 95% -h 95% "${homeCmd}"`;
}
function homeBindCommand(homeCmd = "tmux-ide team --popup", key = HOME_KEY) {
  return ["bind-key", "-n", key, "display-popup", "-E", "-w", "95%", "-h", "95%", homeCmd];
}
function homeUnbindCommand(key = HOME_KEY) {
  return ["unbind-key", "-n", key];
}
function updatePopupCommand(updateCmd = "tmux-ide update --dry-run") {
  const shell = `${updateCmd}; echo ''; echo '[ press Enter to close ]'; read _`;
  return `display-popup -E -w 70% -h 50% "${shell}"`;
}
function dq(cmd) {
  return `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function statusClickBindCommand(switcherCmd = "tmux-ide switcher", cheatsheetCmd = "tmux-ide cheatsheet") {
  const popup = switcherPopupCommand(switcherCmd);
  const cheatsheet = cheatsheetPopupCommand(cheatsheetCmd);
  const home = homePopupCommand();
  const update = updatePopupCommand();
  const switchClient = `run-shell "tmux switch-client -c '#{client_name}' -t '#{s/^sw//:mouse_status_range}'"`;
  const swBranch = `if-shell -F "#{m:sw*,#{mouse_status_range}}" ${dq(switchClient)} "select-window -t ="`;
  const keysBranch = `if-shell -F "#{==:#{mouse_status_range},keys}" ${dq(cheatsheet)} ${dq(swBranch)}`;
  const homeBranch = `if-shell -F "#{==:#{mouse_status_range},home}" ${dq(home)} ${dq(keysBranch)}`;
  const updateBranch = `if-shell -F "#{==:#{mouse_status_range},update}" ${dq(update)} ${dq(homeBranch)}`;
  return [
    "bind-key",
    "-n",
    STATUS_CLICK_KEY,
    "if-shell",
    "-F",
    "#{==:#{mouse_status_range},switcher}",
    popup,
    updateBranch
  ];
}
function statusClickUnbindCommand() {
  return ["unbind-key", "-n", STATUS_CLICK_KEY];
}
function adoptOptionCommands(session) {
  const format = `#[align=left]#{${STATUS_OPTION}}`;
  const borderFormat = ` #{?#{${CHIP_OPTION}},#{${CHIP_OPTION}},#{pane_title}} `;
  return [
    ["set-option", "-t", session, "status", "2"],
    ["set-option", "-t", session, "status-interval", "2"],
    ["set-option", "-t", session, "status-format[1]", format],
    // Status-line clicks need mouse mode ON. NOTE: this also changes scroll
    // behavior (the wheel enters copy-mode / scrolls pane history instead of the
    // terminal's native scrollback). Per-session (`-t`) so only adopted change.
    ["set-option", "-t", session, "mouse", "on"],
    // Per-pane agent chips on the bottom border (see borderFormat above).
    ["set-option", "-t", session, "pane-border-status", "bottom"],
    ["set-option", "-t", session, "pane-border-format", borderFormat],
    // Marker the updater enumerates by (readable in list-sessions -F formats).
    ["set-option", "-t", session, ADOPTED_OPTION, "1"]
  ];
}
function unadoptOptionCommands(session) {
  return [
    ["set-option", "-u", "-t", session, "status"],
    ["set-option", "-u", "-t", session, "status-interval"],
    ["set-option", "-u", "-t", session, "status-format[1]"],
    ["set-option", "-u", "-t", session, "mouse"],
    ["set-option", "-u", "-t", session, "pane-border-status"],
    ["set-option", "-u", "-t", session, "pane-border-format"],
    ["set-option", "-u", "-t", session, ADOPTED_OPTION],
    ["set-option", "-u", "-t", session, STATUS_OPTION]
  ];
}
function altKeyBinds(keys, switcherCmd = "tmux-ide switcher") {
  return [
    { key: keys.popup, bind: popupBindCommand(switcherCmd, keys.popup) },
    { key: keys.home, bind: homeBindCommand("tmux-ide team --popup", keys.home) },
    { key: keys.cheatsheet, bind: cheatsheetBindCommand("tmux-ide cheatsheet", keys.cheatsheet) },
    { key: keys.menu, bind: menuBindCommand("tmux-ide menu", keys.menu) },
    { key: keys.sidebar, bind: sidebarToggleBindCommand("tmux-ide sidebar-toggle", keys.sidebar) },
    ...PANEL_POPUPS.map((panel) => {
      const key = panelKey(panel, keys.panels);
      return { key, bind: panelPopupBindCommand(panel, key) };
    })
  ];
}
function prefixKeyBinds(keys, switcherCmd = "tmux-ide switcher") {
  const out = [];
  for (const { key, bind } of altKeyBinds(keys, switcherCmd)) {
    const remapped = PREFIX_REMAP[key];
    const letter = remapped ?? /^M-([a-z])$/.exec(key)?.[1];
    if (!letter || !remapped && PREFIX_TAKEN.has(letter)) continue;
    out.push({ pkey: letter, bind: ["bind-key", "-T", "prefix", letter, ...bind.slice(3)] });
  }
  return out;
}
function adoptSession(session, switcherCmd = "tmux-ide switcher") {
  for (const argv of adoptOptionCommands(session)) runTmux(argv);
  for (const legacy of LEGACY_BINDS) {
    try {
      runTmux(legacy);
    } catch {
    }
  }
  const keys = getAppConfig().keys;
  runTmux(statusClickBindCommand(switcherCmd));
  runTmux(menuStatusBindCommand());
  runTmux(menuPaneBindCommand());
  altKeyBinds(keys, switcherCmd).forEach(({ key, bind }, i) => {
    runTmux(bind);
    const escape = kittyEscapeFor(key);
    if (escape === null) return;
    const idx = kittyUserKeyIndex(i);
    runTmux(["set-option", "-s", `user-keys[${idx}]`, escape]);
    runTmux(["bind-key", "-n", kittyUserKeyName(i), ...bind.slice(3)]);
  });
  for (const { bind } of prefixKeyBinds(keys, switcherCmd)) runTmux(bind);
  seedSessionStatus(session);
  startUpdaterIfNeeded();
  maybeShowWelcomePopup();
  maybeOfferIntegrationPopup();
}
function unadoptSession(session) {
  for (const argv of unadoptOptionCommands(session)) runTmux(argv);
  const keys = getAppConfig().keys;
  for (const undo of [
    statusClickUnbindCommand(),
    menuStatusUnbindCommand(),
    menuPaneUnbindCommand()
  ]) {
    try {
      runTmux(undo);
    } catch {
    }
  }
  altKeyBinds(keys, "tmux-ide switcher").forEach(({ key }, i) => {
    try {
      runTmux(["unbind-key", "-n", key]);
    } catch {
    }
    if (kittyEscapeFor(key) === null) return;
    try {
      runTmux(["unbind-key", "-n", kittyUserKeyName(i)]);
    } catch {
    }
    try {
      runTmux(["set-option", "-su", `user-keys[${kittyUserKeyIndex(i)}]`]);
    } catch {
    }
  });
  for (const { pkey } of prefixKeyBinds(keys, "tmux-ide switcher")) {
    try {
      runTmux(["unbind-key", "-T", "prefix", pkey]);
    } catch {
    }
  }
  if (listAdoptedSessions().length === 0) stopUpdater();
}
var POPUP_KEY, HOME_KEY, MENU_KEY, MENU_STATUS_KEY, MENU_PANE_KEY, STATUS_CLICK_KEY, PREFIX_TAKEN, PREFIX_REMAP, LEGACY_BINDS;
var init_statusline = __esm({
  "packages/daemon/src/tui/chrome/statusline.ts"() {
    "use strict";
    init_src2();
    init_app_config();
    init_cheatsheet();
    init_menu();
    init_panels();
    init_sidebar();
    init_welcome();
    init_offer();
    init_kitty_keys();
    init_updater();
    POPUP_KEY = "M-p";
    HOME_KEY = "M-h";
    MENU_KEY = "M-m";
    MENU_STATUS_KEY = "MouseUp3Status";
    MENU_PANE_KEY = "MouseUp3Pane";
    STATUS_CLICK_KEY = "MouseDown1Status";
    PREFIX_TAKEN = /* @__PURE__ */ new Set([..."cdfilmnopqrstwxz"]);
    PREFIX_REMAP = {
      "M-m": "u",
      // menu — m is mark-pane
      "M-p": "j",
      // switcher — p is previous-window; j = "jump"
      "M-,": "v"
      // config panel — , is rename-window
    };
    LEGACY_BINDS = [
      ["unbind-key", "-n", "MouseDown3Status"],
      ["unbind-key", "-n", "MouseDown3Pane"]
    ];
  }
});

// packages/daemon/src/lib/canonical-daemon.ts
var canonical_daemon_exports = {};
__export(canonical_daemon_exports, {
  canonicalDaemonUrl: () => canonicalDaemonUrl,
  clearCanonicalDaemonInfoIfOwned: () => clearCanonicalDaemonInfoIfOwned,
  clearCanonicalDaemonInfoIfUnchanged: () => clearCanonicalDaemonInfoIfUnchanged,
  getCanonicalDaemonClaimPath: () => getCanonicalDaemonClaimPath,
  getCanonicalDaemonInfoPath: () => getCanonicalDaemonInfoPath,
  inspectCanonicalDaemonInfo: () => inspectCanonicalDaemonInfo,
  isCanonicalDaemonAlive: () => isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead: () => isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth: () => probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity: () => probeCanonicalDaemonIdentity,
  readCanonicalDaemonInfo: () => readCanonicalDaemonInfo,
  releaseCanonicalDaemonClaim: () => releaseCanonicalDaemonClaim,
  tryAcquireCanonicalDaemonClaim: () => tryAcquireCanonicalDaemonClaim,
  warnOnDaemonVersionSkew: () => warnOnDaemonVersionSkew,
  writeCanonicalDaemonInfo: () => writeCanonicalDaemonInfo
});
import {
  chmodSync as chmodSync3,
  closeSync as closeSync2,
  constants,
  fstatSync,
  linkSync as linkSync2,
  lstatSync,
  mkdirSync as mkdirSync13,
  openSync as openSync2,
  readFileSync as readFileSync15,
  renameSync as renameSync8,
  rmSync,
  writeFileSync as writeFileSync12
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir as homedir13 } from "node:os";
import { dirname as dirname18, join as join19 } from "node:path";
function nonEmptyEnvironmentValue(name) {
  const value = process.env[name];
  return value !== void 0 && value.length > 0 ? value : void 0;
}
function getCanonicalDaemonInfoPath() {
  const dir = nonEmptyEnvironmentValue(DAEMON_INFO_DIR_ENV) ?? nonEmptyEnvironmentValue(REGISTRY_DIR_ENV2) ?? join19(homedir13(), ".tmux-ide");
  return join19(dir, DAEMON_INFO_FILE);
}
function getCanonicalDaemonClaimPath() {
  return join19(dirname18(getCanonicalDaemonInfoPath()), DAEMON_CLAIM_DIR);
}
function observation(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}
function sameObservation(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
function invalidState(reason, detail, ownerPid = null, observed = null) {
  return { status: "invalid", reason, detail, ownerPid, observation: observed };
}
function ownerPidFromRaw(raw) {
  if (!raw || typeof raw !== "object" || !("pid" in raw)) return null;
  const pid = raw.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}
function inspectCanonicalDaemonInfoPath(path2) {
  let descriptor2;
  try {
    const pathStat = lstatSync(path2);
    const pathObservation = observation(pathStat);
    if (pathStat.isSymbolicLink()) {
      return invalidState(
        "symlink",
        "daemon.json must not be a symbolic link",
        null,
        pathObservation
      );
    }
    if (!pathStat.isFile()) {
      return invalidState(
        "not-regular-file",
        "daemon.json must be a regular file",
        null,
        pathObservation
      );
    }
    if (pathStat.size > MAX_DAEMON_INFO_BYTES) {
      return invalidState("oversized", "daemon.json exceeds the size limit", null, pathObservation);
    }
    if (typeof process.getuid === "function" && pathStat.uid !== process.getuid()) {
      return invalidState(
        "wrong-owner",
        "daemon.json is not owned by the current user",
        null,
        pathObservation
      );
    }
    if ((pathStat.mode & 63) !== 0) {
      return invalidState(
        "unsafe-permissions",
        "daemon.json must be readable and writable only by its owner",
        null,
        pathObservation
      );
    }
    descriptor2 = openSync2(path2, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = fstatSync(descriptor2);
    const openedObservation = observation(openedStat);
    if (!openedStat.isFile() || !sameObservation(pathObservation, openedObservation) || typeof process.getuid === "function" && openedStat.uid !== process.getuid() || (openedStat.mode & 63) !== 0) {
      return invalidState(
        "changed-while-opening",
        "daemon.json changed or became unsafe while it was opened",
        null,
        openedObservation
      );
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync15(descriptor2, "utf-8"));
    } catch (error) {
      return invalidState(
        "malformed-json",
        error instanceof Error ? error.message : "daemon.json is not valid JSON",
        null,
        openedObservation
      );
    }
    const parsed = CanonicalDaemonInfoSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidState(
        "invalid-schema",
        parsed.error.issues.map((issue) => issue.message).join("; "),
        ownerPidFromRaw(raw),
        openedObservation
      );
    }
    return { status: "valid", info: parsed.data, observation: openedObservation };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return invalidState(
      "unreadable",
      error instanceof Error ? error.message : "daemon.json could not be read"
    );
  } finally {
    if (descriptor2 !== void 0) closeSync2(descriptor2);
  }
}
function inspectCanonicalDaemonClaimPath(path2) {
  let descriptor2;
  try {
    const claimStat = lstatSync(path2);
    if (claimStat.isSymbolicLink() || !claimStat.isDirectory()) {
      return { status: "invalid", detail: "daemon claim must be a real directory" };
    }
    if (typeof process.getuid === "function" && claimStat.uid !== process.getuid()) {
      return { status: "invalid", detail: "daemon claim is owned by another user" };
    }
    if ((claimStat.mode & 63) !== 0) {
      return { status: "invalid", detail: "daemon claim directory is not owner-only" };
    }
    const ownerPath = join19(path2, DAEMON_CLAIM_OWNER_FILE);
    const ownerStat = lstatSync(ownerPath);
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
      return { status: "invalid", detail: "daemon claim owner must be a real file" };
    }
    if (ownerStat.size > MAX_DAEMON_CLAIM_BYTES) {
      return { status: "invalid", detail: "daemon claim owner exceeds the size limit" };
    }
    if (typeof process.getuid === "function" && ownerStat.uid !== process.getuid()) {
      return { status: "invalid", detail: "daemon claim owner is owned by another user" };
    }
    if ((ownerStat.mode & 63) !== 0) {
      return { status: "invalid", detail: "daemon claim owner is not owner-only" };
    }
    descriptor2 = openSync2(ownerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStat = fstatSync(descriptor2);
    if (!openedStat.isFile() || openedStat.dev !== ownerStat.dev || openedStat.ino !== ownerStat.ino || openedStat.size !== ownerStat.size) {
      return { status: "invalid", detail: "daemon claim changed while it was opened" };
    }
    const raw = JSON.parse(readFileSync15(descriptor2, "utf-8"));
    if (typeof raw.claimId !== "string" || !/^[0-9a-f-]{36}$/iu.test(raw.claimId) || typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0 || typeof raw.acquiredAt !== "string" || !Number.isFinite(Date.parse(raw.acquiredAt))) {
      return { status: "invalid", detail: "daemon claim owner has invalid metadata" };
    }
    return {
      status: "valid",
      claim: { claimId: raw.claimId, pid: raw.pid, acquiredAt: raw.acquiredAt }
    };
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing" };
    return {
      status: "invalid",
      detail: error instanceof Error ? error.message : "daemon claim could not be read"
    };
  } finally {
    if (descriptor2 !== void 0) closeSync2(descriptor2);
  }
}
function restoreCapturedFile(capturedPath, canonicalPath) {
  try {
    linkSync2(capturedPath, canonicalPath);
    rmSync(capturedPath, { force: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
function retireCanonicalClaimIfMatches(expected) {
  const path2 = getCanonicalDaemonClaimPath();
  const captured = `${path2}.${expected.claimId}.${randomUUID()}.retired`;
  try {
    renameSync8(path2, captured);
  } catch {
    return false;
  }
  const moved = inspectCanonicalDaemonClaimPath(captured);
  if (moved.status === "valid" && moved.claim.claimId === expected.claimId && moved.claim.pid === expected.pid) {
    rmSync(captured, { recursive: true, force: true });
    return true;
  }
  try {
    renameSync8(captured, path2);
  } catch {
  }
  return false;
}
function tryAcquireCanonicalDaemonClaim() {
  const path2 = getCanonicalDaemonClaimPath();
  const root = dirname18(path2);
  mkdirSync13(root, { recursive: true, mode: 448 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const claim = {
      claimId: randomUUID(),
      pid: process.pid,
      acquiredAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    const candidate = `${path2}.${claim.claimId}.candidate`;
    mkdirSync13(candidate, { mode: 448 });
    writeFileSync12(join19(candidate, DAEMON_CLAIM_OWNER_FILE), `${JSON.stringify(claim, null, 2)}
`, {
      encoding: "utf-8",
      mode: 384
    });
    try {
      renameSync8(candidate, path2);
      activeClaims.add(claim.claimId);
      return { status: "acquired", claim };
    } catch (error) {
      rmSync(candidate, { recursive: true, force: true });
      const existing = inspectCanonicalDaemonClaimPath(path2);
      if (existing.status === "missing") {
        if (attempt < 2) continue;
        return { status: "invalid", detail: "daemon claim changed during acquisition" };
      }
      if (existing.status === "invalid") return existing;
      if (pidLiveness(existing.claim.pid) !== "dead") {
        return { status: "busy", owner: existing.claim };
      }
      if (!retireCanonicalClaimIfMatches(existing.claim) && attempt === 2) {
        return { status: "invalid", detail: "stale daemon claim changed during recovery" };
      }
      if (error.code !== "EEXIST" && attempt === 2) throw error;
    }
  }
  return { status: "invalid", detail: "daemon claim could not be acquired" };
}
function assertCanonicalDaemonClaimHeld(claim) {
  if (!activeClaims.has(claim.claimId)) throw new Error("canonical daemon claim is not active");
  const current = inspectCanonicalDaemonClaimPath(getCanonicalDaemonClaimPath());
  if (current.status !== "valid" || current.claim.claimId !== claim.claimId || current.claim.pid !== claim.pid) {
    throw new Error("canonical daemon claim ownership was lost");
  }
}
function releaseCanonicalDaemonClaim(claim) {
  if (!activeClaims.has(claim.claimId)) return false;
  try {
    return retireCanonicalClaimIfMatches(claim);
  } finally {
    activeClaims.delete(claim.claimId);
  }
}
function writeCanonicalDaemonInfo(info, claim) {
  assertCanonicalDaemonClaimHeld(claim);
  const path2 = getCanonicalDaemonInfoPath();
  mkdirSync13(dirname18(path2), { recursive: true, mode: 448 });
  const tmpPath = `${path2}.${claim.claimId}.${randomUUID()}.tmp`;
  const persisted = {
    pid: info.pid,
    port: info.port,
    protocolVersion: info.protocolVersion,
    productVersion: info.productVersion,
    instanceId: info.instanceId,
    startedAt: info.startedAt,
    bindHostname: info.bindHostname,
    authToken: info.authToken
  };
  writeFileSync12(tmpPath, JSON.stringify(persisted, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 384
  });
  chmodSync3(tmpPath, 384);
  try {
    linkSync2(tmpPath, path2);
  } finally {
    rmSync(tmpPath, { force: true });
  }
}
function inspectCanonicalDaemonInfo() {
  return inspectCanonicalDaemonInfoPath(getCanonicalDaemonInfoPath());
}
function readCanonicalDaemonInfo() {
  const state = inspectCanonicalDaemonInfo();
  return state.status === "valid" ? state.info : null;
}
function captureCanonicalDaemonInfo(claim) {
  assertCanonicalDaemonClaimHeld(claim);
  const path2 = getCanonicalDaemonInfoPath();
  const captured = `${path2}.${claim.claimId}.${randomUUID()}.retired`;
  try {
    renameSync8(path2, captured);
    return captured;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function clearCanonicalDaemonInfoIfUnchanged(state, claim) {
  if (state.status === "missing" || !state.observation) return false;
  const path2 = getCanonicalDaemonInfoPath();
  const captured = captureCanonicalDaemonInfo(claim);
  if (!captured) return false;
  try {
    const current = observation(lstatSync(captured));
    if (sameObservation(state.observation, current)) {
      rmSync(captured, { recursive: true, force: true });
      return true;
    }
    restoreCapturedFile(captured, path2);
    return false;
  } catch (error) {
    restoreCapturedFile(captured, path2);
    throw error;
  }
}
function clearCanonicalDaemonInfoIfOwned(instanceId, claim) {
  const path2 = getCanonicalDaemonInfoPath();
  const captured = captureCanonicalDaemonInfo(claim);
  if (!captured) return false;
  const state = inspectCanonicalDaemonInfoPath(captured);
  if (state.status === "valid" && state.info.instanceId === instanceId) {
    rmSync(captured, { recursive: true, force: true });
    return true;
  }
  restoreCapturedFile(captured, path2);
  return false;
}
function pidLiveness(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}
async function isCanonicalDaemonAlive(info) {
  return pidLiveness(info.pid) !== "dead";
}
async function isCanonicalDaemonRecordOwnerProvenDead(state) {
  const pid = state.status === "valid" ? state.info.pid : state.ownerPid;
  return pid !== null && pidLiveness(pid) === "dead";
}
function connectHostname(bindHostname) {
  if (bindHostname === "0.0.0.0") return "127.0.0.1";
  if (bindHostname === "::") return "::1";
  return bindHostname;
}
function urlHostname(bindHostname) {
  const hostname2 = connectHostname(bindHostname).replace(/^\[|\]$/gu, "");
  if (/[/?#@]/u.test(hostname2)) throw new TypeError("Invalid daemon bind hostname");
  const escaped = hostname2.replace(/%/gu, "%25");
  return escaped.includes(":") ? `[${escaped}]` : escaped;
}
function canonicalDaemonUrl(protocol, bindHostname, port, path2 = "") {
  const suffix = path2.length === 0 ? "" : path2.startsWith("/") ? path2 : `/${path2}`;
  return `${protocol}://${urlHostname(bindHostname)}:${port}${suffix}`;
}
function timeoutSignal(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
function warnOnDaemonVersionSkew(info, expectedProductVersion) {
  if (info.productVersion === expectedProductVersion) return;
  console.warn(
    `[tmux-ide] canonical daemon product-version skew: daemon.json reports "${info.productVersion}" but this client expects "${expectedProductVersion}". Wire compatibility is governed independently by protocolVersion.`
  );
}
async function probeCanonicalDaemonHealth(info) {
  if (!await isCanonicalDaemonAlive(info)) return null;
  try {
    const res = await fetch(canonicalDaemonUrl("http", info.bindHostname, info.port, "/health"), {
      signal: timeoutSignal(750)
    });
    if (!res.ok) return null;
    const parsed = DaemonHealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
async function probeCanonicalDaemonIdentity(info) {
  if (!await isCanonicalDaemonAlive(info)) return null;
  try {
    const res = await fetch(canonicalDaemonUrl("http", info.bindHostname, info.port, "/identity"), {
      signal: timeoutSignal(750)
    });
    if (!res.ok) return null;
    const parsed = DaemonIdentitySchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
var DAEMON_INFO_DIR_ENV, REGISTRY_DIR_ENV2, DAEMON_INFO_FILE, DAEMON_CLAIM_DIR, DAEMON_CLAIM_OWNER_FILE, MAX_DAEMON_INFO_BYTES, MAX_DAEMON_CLAIM_BYTES, activeClaims;
var init_canonical_daemon = __esm({
  "packages/daemon/src/lib/canonical-daemon.ts"() {
    "use strict";
    init_src();
    DAEMON_INFO_DIR_ENV = "TMUX_IDE_DAEMON_INFO_DIR";
    REGISTRY_DIR_ENV2 = "TMUX_IDE_REGISTRY_DIR";
    DAEMON_INFO_FILE = "daemon.json";
    DAEMON_CLAIM_DIR = "daemon.claim";
    DAEMON_CLAIM_OWNER_FILE = "owner.json";
    MAX_DAEMON_INFO_BYTES = 64 * 1024;
    MAX_DAEMON_CLAIM_BYTES = 4 * 1024;
    activeClaims = /* @__PURE__ */ new Set();
  }
});

// packages/daemon/src/launch.ts
var launch_exports = {};
__export(launch_exports, {
  buildPaneMap: () => buildPaneMap,
  launch: () => launch,
  launchRuntimeDir: () => launchRuntimeDir,
  waitForPaneCommand: () => waitForPaneCommand
});
import { resolve as resolve13 } from "node:path";
import { execSync } from "node:child_process";
import { createHash as createHash4 } from "node:crypto";
function stripWidgetPanes(rows) {
  return rows.map((row) => ({
    ...row,
    panes: row.panes.filter((p) => !p.type)
  })).filter((row) => row.panes.length > 0);
}
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function configHash(config2) {
  return createHash4("sha256").update(JSON.stringify(config2)).digest("hex").slice(0, 12);
}
function waitForPaneCommand(targetPane, expectedCommands, {
  attempts = 20,
  delayMs = 100,
  getCurrentCommand = getPaneCurrentCommand,
  sleep: sleep2 = sleepMs
} = {}) {
  const allowed = new Set(expectedCommands.map((command2) => command2.toLowerCase()));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const current = getCurrentCommand(targetPane)?.trim().toLowerCase();
      if (current && allowed.has(current)) return true;
    } catch {
    }
    if (attempt < attempts - 1) {
      sleep2(delayMs);
    }
  }
  return false;
}
function buildPaneMap(rows, dir, rootPaneId, splitPaneFn) {
  const rowSizes = computeSizes(rows);
  const rowSplitPercents = toSplitPercents(rowSizes);
  const rowPaneIds = [rootPaneId];
  for (let rowIdx = 1; rowIdx < rows.length; rowIdx++) {
    const splitFrom = rowPaneIds[rowIdx - 1];
    const newPaneId = splitPaneFn({
      targetPane: splitFrom,
      direction: "vertical",
      cwd: dir,
      percent: rowSplitPercents[rowIdx - 1]
    });
    rowPaneIds.push(newPaneId);
  }
  const paneMap = [];
  const firstPanesOfRows = new Set(rowPaneIds);
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const panes = row.panes ?? [];
    const rowPaneId = rowPaneIds[rowIdx];
    const rowPanes = [rowPaneId];
    const paneSizes = computeSizes(panes);
    const paneSplitPercents = toSplitPercents(paneSizes);
    for (let paneIdx = 1; paneIdx < panes.length; paneIdx++) {
      const pane = panes[paneIdx];
      const targetPane = rowPanes[paneIdx - 1];
      const paneDir = pane.dir ? resolve13(dir, pane.dir) : dir;
      const newPaneId = splitPaneFn({
        targetPane,
        direction: "horizontal",
        cwd: paneDir,
        percent: paneSplitPercents[paneIdx - 1]
      });
      rowPanes.push(newPaneId);
    }
    paneMap.push(rowPanes);
  }
  return { paneMap, firstPanesOfRows };
}
async function loadLaunchConfig(context, json2) {
  const config2 = context.resolved?.launchConfig ?? null;
  if (!config2) {
    outputError(
      `No workspace config found in ${context.inputDir}. Run "tmux-ide init" or "tmux-ide detect --write" to create one.`,
      "CONFIG_NOT_FOUND"
    );
  }
  const errors = validateConfig(config2);
  if (errors.length > 0) {
    const configLocation = context.configPath ?? context.inputDir ?? context.projectRoot;
    outputError(
      `Invalid workspace config in ${configLocation}. Run "tmux-ide validate" for details.`,
      "INVALID_CONFIG"
    );
  }
  if (context.resolved?.migrationHint && !json2 && !process.env.TMUX_IDE_SUPPRESS_MIGRATION_HINT) {
    console.log(context.resolved.migrationHint);
  }
  return config2;
}
async function bestEffortAdopt(session) {
  try {
    const { adoptSession: adoptSession2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
    adoptSession2(session);
  } catch {
  }
}
function runBeforeHook(command2, dir) {
  if (!command2) return;
  console.log(`Running: ${command2}`);
  try {
    execSync(command2, { cwd: dir, stdio: "inherit", timeout: 6e4 });
  } catch {
    outputError(`The before hook failed: ${command2}`, "BEFORE_HOOK_FAILED");
  }
}
function launchRuntimeDir(context) {
  return context.configWriteRoot;
}
async function launch(targetDir, {
  json: json2 = false,
  attach: attach2 = true,
  sessionName
} = {}) {
  const inputDir = resolve13(targetDir ?? ".");
  const context = await resolveProjectConfigContext(inputDir);
  const dir = launchRuntimeDir(context);
  const config2 = await loadLaunchConfig(context, json2);
  const session = sessionName ?? config2.name ?? context.sessionName;
  const headless = config2.orchestrator?.widgets === false;
  const rows = headless ? stripWidgetPanes(config2.rows) : config2.rows;
  const theme = config2.theme ?? {};
  const team = config2.team ?? null;
  runBeforeHook(config2.before, dir);
  if (hasSession(session)) {
    const currentHash = configHash(config2);
    const storedHash = getSessionVariable(session, "@config_hash");
    const configChanged = Boolean(storedHash && currentHash !== storedHash);
    if (json2) {
      console.log(JSON.stringify({ session, running: true, configChanged }));
    } else if (configChanged) {
      console.log(`Session "${session}" is running but workspace config has changed.`);
      console.log(`Run "tmux-ide restart" to apply changes.`);
    } else {
      console.log(`Session "${session}" is already running. Attaching...`);
    }
    await bestEffortAdopt(session);
    if (attach2) {
      attachSession(session);
    }
    return;
  }
  const cols = process.stdout.columns ?? 200;
  const lines = process.stdout.rows ?? 50;
  const rootPaneId = createDetachedSession(session, dir, { cols, lines });
  if (team) {
    setSessionEnvironment(session, "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1");
  }
  const { paneMap, firstPanesOfRows } = buildPaneMap(
    rows,
    dir,
    rootPaneId,
    ({ targetPane, direction, cwd, percent }) => splitPane(targetPane, direction, cwd, percent)
  );
  const {
    focusPane,
    paneActions: paneActions2,
    diagnostics: launchDiagnostics
  } = collectPaneStartupPlan(rows, paneMap, firstPanesOfRows, dir);
  for (const diagnostic of launchDiagnostics) {
    console.error(`tmux-ide: warning: ${diagnostic.message}`);
  }
  for (const action of paneActions2) {
    if (action.title) {
      setPaneTitle(action.targetPane, action.title);
    }
    for (const [option, value] of paneIdentityOptions(action)) {
      setPaneOption(action.targetPane, option, value);
    }
    if (action.paneRole === "lead" || action.paneRole === "teammate") {
      setPaneOption(action.targetPane, "allow-rename", "off");
    }
    if (action.chdir) {
      sendLiteral(action.targetPane, `cd ${shellEscape(action.chdir)}`);
    }
    for (const exportCommand of action.exports) {
      sendLiteral(action.targetPane, exportCommand);
    }
    if (action.widgetType) {
      const widgetCmd = resolveWidgetCommand(action.widgetType, {
        session,
        dir,
        target: action.widgetTarget ?? null,
        theme: config2.theme ?? null
      });
      sendLiteral(action.targetPane, widgetCmd);
    } else if (action.command) {
      sendLiteral(action.targetPane, action.command);
    }
  }
  for (const command2 of buildSessionOptions(session, { theme })) {
    runSessionCommand(command2);
  }
  setSessionVariable(session, "@config_hash", configHash(config2));
  const sidebar = resolveSidebarConfig(config2.sidebar);
  if (sidebar.enabled) {
    try {
      const { openSidebarPane: openSidebarPane2 } = await Promise.resolve().then(() => (init_sidebar(), sidebar_exports));
      openSidebarPane2(session, dir, sidebar.width, config2.theme ?? null);
    } catch {
    }
  }
  selectPane(focusPane);
  const totalPanes = rows.reduce((sum, r) => sum + (r.panes?.length ?? 0), 0);
  console.log(
    `Starting "${session}" (${rows.length} row${rows.length === 1 ? "" : "s"}, ${totalPanes} pane${totalPanes === 1 ? "" : "s"})...`
  );
  try {
    const { canonicalDaemonUrl: canonicalDaemonUrl2, readCanonicalDaemonInfo: readCanonicalDaemonInfo2 } = await Promise.resolve().then(() => (init_canonical_daemon(), canonical_daemon_exports));
    const info = readCanonicalDaemonInfo2();
    if (info) {
      console.log(`Command center: ${canonicalDaemonUrl2("http", info.bindHostname, info.port)}/`);
    }
  } catch {
  }
  await bestEffortAdopt(session);
  if (attach2) {
    attachSession(session);
  }
}
var init_launch = __esm({
  "packages/daemon/src/launch.ts"() {
    "use strict";
    init_config_context();
    init_sizes();
    init_output();
    init_launch_plan();
    init_session_options();
    init_src2();
    init_validate();
    init_sidebar();
    init_resolve();
    init_shell();
  }
});

// packages/daemon/src/lib/yaml-io.ts
function readConfig(dir) {
  return readConfigCompatSync(dir);
}
function writeConfig(dir, config2) {
  return writeLaunchProjectionConfig(dir, config2);
}
var init_yaml_io = __esm({
  "packages/daemon/src/lib/yaml-io.ts"() {
    "use strict";
    init_resolved_config();
  }
});

// packages/daemon/src/detect.ts
import { resolve as resolve14, basename as basename6 } from "node:path";
import { readFileSync as readFileSync16, existsSync as existsSync20 } from "node:fs";
function fileExists(dir, name) {
  return existsSync20(resolve14(dir, name));
}
function readJson(dir, name) {
  try {
    return JSON.parse(readFileSync16(resolve14(dir, name), "utf-8"));
  } catch {
    return null;
  }
}
function detectStack(dir) {
  const detected = {
    packageManager: null,
    frameworks: [],
    devCommand: null,
    language: null,
    reasons: []
  };
  if (fileExists(dir, "pnpm-lock.yaml")) {
    detected.packageManager = "pnpm";
    detected.reasons.push('Detected pnpm from "pnpm-lock.yaml".');
  } else if (fileExists(dir, "bun.lockb") || fileExists(dir, "bun.lock")) {
    detected.packageManager = "bun";
    detected.reasons.push('Detected bun from "bun.lockb" or "bun.lock".');
  } else if (fileExists(dir, "yarn.lock")) {
    detected.packageManager = "yarn";
    detected.reasons.push('Detected yarn from "yarn.lock".');
  } else if (fileExists(dir, "package-lock.json")) {
    detected.packageManager = "npm";
    detected.reasons.push('Detected npm from "package-lock.json".');
  }
  const pkg = readJson(dir, "package.json");
  if (pkg) {
    detected.language = "javascript";
    detected.reasons.push('Detected JavaScript from "package.json".');
    const deps2 = {
      ...pkg.dependencies,
      ...pkg.devDependencies
    };
    if (deps2["next"]) pushFramework(detected, "next", 'Found dependency "next".');
    if (deps2["convex"]) pushFramework(detected, "convex", 'Found dependency "convex".');
    if (deps2["vite"]) pushFramework(detected, "vite", 'Found dependency "vite".');
    if (deps2["remix"] || deps2["@remix-run/node"])
      pushFramework(detected, "remix", "Found Remix dependency.");
    if (deps2["nuxt"]) pushFramework(detected, "nuxt", 'Found dependency "nuxt".');
    if (deps2["astro"]) pushFramework(detected, "astro", 'Found dependency "astro".');
    if (deps2["svelte"] || deps2["@sveltejs/kit"])
      pushFramework(detected, "svelte", "Found Svelte dependency.");
    const pm = detected.packageManager ?? "npm";
    const run = pm === "npm" ? "npm run" : pm;
    const scripts = pkg.scripts;
    if (scripts?.dev) {
      detected.devCommand = `${run} dev`;
      detected.reasons.push(
        `Using dev command "${detected.devCommand}" from package.json scripts.`
      );
    } else if (scripts?.start) {
      detected.devCommand = `${run} start`;
      detected.reasons.push(
        `Using start command "${detected.devCommand}" from package.json scripts.`
      );
    }
  }
  if (fileExists(dir, "pyproject.toml") || fileExists(dir, "requirements.txt")) {
    detected.language = detected.language ?? "python";
    detected.reasons.push('Detected Python from "pyproject.toml" or "requirements.txt".');
    try {
      const pyproject = readFileSync16(resolve14(dir, "pyproject.toml"), "utf-8");
      if (pyproject.includes("fastapi"))
        pushFramework(detected, "fastapi", 'Found "fastapi" in pyproject.toml.');
      else if (pyproject.includes("django"))
        pushFramework(detected, "django", 'Found "django" in pyproject.toml.');
      else if (pyproject.includes("flask"))
        pushFramework(detected, "flask", 'Found "flask" in pyproject.toml.');
    } catch {
    }
  }
  if (fileExists(dir, "Cargo.toml")) {
    detected.language = detected.language ?? "rust";
    detected.reasons.push('Detected Rust from "Cargo.toml".');
    pushFramework(detected, "cargo", 'Using Cargo workflow from "Cargo.toml".');
  }
  if (fileExists(dir, "go.mod")) {
    detected.language = detected.language ?? "go";
    detected.reasons.push('Detected Go from "go.mod".');
    pushFramework(detected, "go", 'Using Go workflow from "go.mod".');
  }
  if (fileExists(dir, "docker-compose.yml") || fileExists(dir, "docker-compose.yaml")) {
    pushFramework(
      detected,
      "docker",
      'Detected Docker from "docker-compose.yml" or "docker-compose.yaml".'
    );
  }
  if (detected.reasons.length === 0) {
    detected.reasons.push("No framework-specific signals found; using the generic layout.");
  }
  return detected;
}
function suggestConfig(dir, detected) {
  const name = basename6(dir);
  const pm = detected.packageManager ?? "npm";
  const run = pm === "npm" ? "npm run" : pm;
  const config2 = {
    name,
    rows: [
      {
        size: "70%",
        panes: [
          { id: "agent-1", title: "Claude 1", command: "claude" },
          { id: "agent-2", title: "Claude 2", command: "claude" }
        ]
      },
      {
        panes: []
      }
    ]
  };
  const bottom = config2.rows[1].panes;
  const frameworks = detected.frameworks;
  if (frameworks.length >= 2) {
    config2.rows[0].panes.push({ id: "agent-3", title: "Claude 3", command: "claude" });
  }
  if (frameworks.includes("next")) {
    bottom.push({ id: "dev", title: "Next.js", command: `${run} dev` });
  } else if (frameworks.includes("vite")) {
    bottom.push({ id: "dev", title: "Vite", command: `${run} dev` });
  } else if (frameworks.includes("nuxt")) {
    bottom.push({ id: "dev", title: "Nuxt", command: `${run} dev` });
  } else if (frameworks.includes("remix")) {
    bottom.push({ id: "dev", title: "Remix", command: `${run} dev` });
  } else if (frameworks.includes("astro")) {
    bottom.push({ id: "dev", title: "Astro", command: `${run} dev` });
  } else if (frameworks.includes("svelte")) {
    bottom.push({ id: "dev", title: "SvelteKit", command: `${run} dev` });
  } else if (frameworks.includes("fastapi")) {
    bottom.push({ id: "dev", title: "FastAPI", command: "uvicorn main:app --reload" });
  } else if (frameworks.includes("django")) {
    bottom.push({ id: "dev", title: "Django", command: "python manage.py runserver" });
  } else if (frameworks.includes("flask")) {
    bottom.push({ id: "dev", title: "Flask", command: "flask run --reload" });
  } else if (frameworks.includes("cargo")) {
    bottom.push({ id: "dev", title: "Cargo", command: "cargo watch -x run" });
  } else if (frameworks.includes("go")) {
    bottom.push({ id: "dev", title: "Go", command: "go run ." });
  } else if (detected.devCommand) {
    bottom.push({ id: "dev", title: "Dev Server", command: detected.devCommand });
  }
  if (frameworks.includes("convex")) {
    bottom.push({ id: "convex", title: "Convex", command: "npx convex dev" });
  }
  bottom.push({ id: "shell", title: "Shell" });
  return config2;
}
async function detect(targetDir, { json: json2, write } = {}) {
  const inputDir = resolve14(targetDir ?? ".");
  const context = write ? await resolveProjectConfigContext(inputDir) : null;
  const dir = context?.configWriteRoot ?? inputDir;
  const detected = detectStack(dir);
  const suggested = suggestConfig(dir, detected);
  if (write) {
    writeConfig(dir, suggested);
    if (json2) {
      console.log(JSON.stringify({ detected, suggestedConfig: suggested, written: true }, null, 2));
    } else {
      const desc = detected.frameworks.length > 0 ? detected.frameworks.join(" + ") : detected.language ?? "generic project";
      console.log(`Detected ${desc}. Created .tmux-ide/workspace.yml.`);
      console.log("\nWhy this layout:");
      for (const reason of detected.reasons) {
        console.log(`  - ${reason}`);
      }
    }
    return;
  }
  if (json2) {
    console.log(JSON.stringify({ detected, suggestedConfig: suggested }, null, 2));
    return;
  }
  console.log("Detected stack:");
  if (detected.packageManager) console.log(`  Package manager: ${detected.packageManager}`);
  if (detected.language) console.log(`  Language: ${detected.language}`);
  if (detected.frameworks.length) console.log(`  Frameworks: ${detected.frameworks.join(", ")}`);
  if (detected.devCommand) console.log(`  Dev command: ${detected.devCommand}`);
  console.log("\nReasoning:");
  for (const reason of detected.reasons) {
    console.log(`  - ${reason}`);
  }
  console.log(
    "\nRun with --write to create .tmux-ide/workspace.yml, or --json to see the suggested config."
  );
}
function pushFramework(detected, framework, reason) {
  if (!detected.frameworks.includes(framework)) {
    detected.frameworks.push(framework);
  }
  detected.reasons.push(reason);
}
var init_detect = __esm({
  "packages/daemon/src/detect.ts"() {
    "use strict";
    init_yaml_io();
    init_config_context();
  }
});

// packages/daemon/src/lib/skill-sync.ts
var skill_sync_exports = {};
__export(skill_sync_exports, {
  VERSION_MARKER_RE: () => VERSION_MARKER_RE,
  claudeDir: () => claudeDir,
  defaultSkillSource: () => defaultSkillSource,
  installedSkillVersion: () => installedSkillVersion,
  parseSkillVersion: () => parseSkillVersion,
  rewriteVersionMarker: () => rewriteVersionMarker,
  skillTargetDir: () => skillTargetDir,
  skillTargetFile: () => skillTargetFile,
  syncSkill: () => syncSkill,
  versionMarker: () => versionMarker
});
import { existsSync as existsSync22, mkdirSync as mkdirSync15, readFileSync as readFileSync18, writeFileSync as writeFileSync14 } from "node:fs";
import { homedir as homedir14 } from "node:os";
import { dirname as dirname20, join as join21 } from "node:path";
import { fileURLToPath as fileURLToPath8 } from "node:url";
function claudeDir() {
  return process.env.TMUX_IDE_CLAUDE_DIR ?? join21(homedir14(), ".claude");
}
function skillTargetDir() {
  return join21(claudeDir(), "skills", "tmux-ide");
}
function skillTargetFile() {
  return join21(skillTargetDir(), "SKILL.md");
}
function defaultSkillSource() {
  const here = dirname20(fileURLToPath8(import.meta.url));
  const candidates = [
    join21(here, "../skill/SKILL.md"),
    // bundled bin/cli.js → repo root
    join21(here, "../../../../skill/SKILL.md")
    // dev src/lib → repo root
  ];
  return candidates.find((c) => existsSync22(c)) ?? candidates[0];
}
function versionMarker(version) {
  return `<!-- tmux-ide-skill-version: ${version} -->`;
}
function parseSkillVersion(content) {
  const match = content.match(VERSION_MARKER_RE);
  return match ? match[1] : null;
}
function rewriteVersionMarker(content, version) {
  if (!VERSION_MARKER_RE.test(content)) return content;
  return content.replace(VERSION_MARKER_RE, versionMarker(version));
}
function installedSkillVersion(dir = skillTargetDir()) {
  const file = join21(dir, "SKILL.md");
  if (!existsSync22(file)) return null;
  try {
    return parseSkillVersion(readFileSync18(file, "utf-8"));
  } catch {
    return null;
  }
}
function syncSkill({
  source = defaultSkillSource(),
  version = getCurrentVersion()
} = {}) {
  const rendered = rewriteVersionMarker(readFileSync18(source, "utf-8"), version);
  const dir = skillTargetDir();
  const target = join21(dir, "SKILL.md");
  const existing = existsSync22(target) ? readFileSync18(target, "utf-8") : null;
  if (existing === rendered) {
    return { action: "unchanged", path: target, to: version };
  }
  mkdirSync15(dir, { recursive: true });
  writeFileSync14(target, rendered, "utf-8");
  if (existing === null) return { action: "installed", path: target, to: version };
  return { action: "updated", path: target, from: parseSkillVersion(existing), to: version };
}
var VERSION_MARKER_RE;
var init_skill_sync = __esm({
  "packages/daemon/src/lib/skill-sync.ts"() {
    "use strict";
    init_update_check();
    VERSION_MARKER_RE = /<!--\s*tmux-ide-skill-version:\s*([^\s]+)\s*-->/;
  }
});

// packages/daemon/src/tui/integrations/opencode.ts
var opencode_exports = {};
__export(opencode_exports, {
  PLUGIN_FILENAME: () => PLUGIN_FILENAME,
  PLUGIN_MARKER: () => PLUGIN_MARKER,
  PLUGIN_SOURCE: () => PLUGIN_SOURCE,
  installOpencodeIntegration: () => installOpencodeIntegration,
  isOurPlugin: () => isOurPlugin,
  opencodeIntegrationStatus: () => opencodeIntegrationStatus,
  opencodePluginPath: () => opencodePluginPath,
  uninstallOpencodeIntegration: () => uninstallOpencodeIntegration
});
import { existsSync as existsSync23, mkdirSync as mkdirSync16, readFileSync as readFileSync19, rmSync as rmSync2, writeFileSync as writeFileSync15 } from "node:fs";
import { homedir as homedir15 } from "node:os";
import { dirname as dirname21, join as join22 } from "node:path";
function opencodePluginPath() {
  const override = process.env.TMUX_IDE_OPENCODE_DIR;
  if (override) return join22(override, PLUGIN_FILENAME);
  const xdg = process.env.XDG_CONFIG_HOME;
  const configRoot = xdg && xdg.length > 0 ? xdg : join22(homedir15(), ".config");
  return join22(configRoot, "opencode", "plugin", PLUGIN_FILENAME);
}
function isOurPlugin(content) {
  return content.includes(PLUGIN_MARKER);
}
function installOpencodeIntegration() {
  const pluginPath = opencodePluginPath();
  mkdirSync16(dirname21(pluginPath), { recursive: true });
  writeFileSync15(pluginPath, PLUGIN_SOURCE, "utf8");
  return { pluginPath };
}
function uninstallOpencodeIntegration() {
  const pluginPath = opencodePluginPath();
  const wasInstalled = opencodeIntegrationStatus().installed;
  if (wasInstalled) rmSync2(pluginPath, { force: true });
  return { pluginPath, wasInstalled };
}
function opencodeIntegrationStatus() {
  const pluginPath = opencodePluginPath();
  try {
    if (!existsSync23(pluginPath)) return { installed: false };
    return { installed: isOurPlugin(readFileSync19(pluginPath, "utf8")) };
  } catch {
    return { installed: false };
  }
}
var PLUGIN_MARKER, PLUGIN_FILENAME, PLUGIN_SOURCE;
var init_opencode = __esm({
  "packages/daemon/src/tui/integrations/opencode.ts"() {
    "use strict";
    PLUGIN_MARKER = "installed by: tmux-ide integration install opencode";
    PLUGIN_FILENAME = "tmux-ide.js";
    PLUGIN_SOURCE = `/**
 * tmux-ide opencode plugin (${PLUGIN_MARKER})
 *
 * Stamps this pane's @agent_session_id tmux option with the opencode session
 * id so \`tmux-ide restore --resume-agents\` can revive the conversation via
 * \`opencode --session <id>\` after a tmux server death.
 *
 * Remove with: tmux-ide integration uninstall opencode
 */
export const TmuxIde = async () => {
  const pane = process.env.TMUX_PANE;
  if (!pane) return {}; // not inside tmux \u2014 inert
  const { execFile } = await import("node:child_process");
  let last = "";
  const stamp = (id) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id) || id === last) return;
    last = id;
    execFile("tmux", ["set-option", "-p", "-t", pane, "@agent_session_id", id], () => {});
  };
  return {
    event: async ({ event }) => {
      // session.updated fires on create + every update; info.id is the
      // resumable session id. Child sessions (subagents) carry parentID and
      // must never overwrite the pane's own conversation key.
      if (event && event.type === "session.updated") {
        const info = event.properties && event.properties.info;
        if (info && !info.parentID) stamp(info.id);
      }
    },
  };
};
`;
  }
});

// packages/daemon/src/lib/agent-discovery.ts
var agent_discovery_exports = {};
__export(agent_discovery_exports, {
  KNOWN_AGENTS: () => KNOWN_AGENTS,
  discoverAgents: () => discoverAgents,
  presentAgents: () => presentAgents
});
import { execFileSync as execFileSync8 } from "node:child_process";
function discoverAgents(which = defaultWhich, isInstalled2 = defaultIntegrationProbe) {
  return KNOWN_AGENTS.map((agent) => {
    const path2 = which(agent.bin);
    const present = path2 !== null;
    const installed = present && agent.integration ? isInstalled2(agent.id) : false;
    const captureActive = agent.capture === "probe" ? present : agent.capture !== null ? installed : false;
    return {
      id: agent.id,
      bin: agent.bin,
      integration: agent.integration,
      path: path2,
      installed,
      capture: agent.capture,
      captureActive
    };
  });
}
function presentAgents(agents) {
  return agents.filter((a) => a.path !== null);
}
var KNOWN_AGENTS, defaultWhich, defaultIntegrationProbe;
var init_agent_discovery = __esm({
  "packages/daemon/src/lib/agent-discovery.ts"() {
    "use strict";
    init_claude();
    init_opencode();
    KNOWN_AGENTS = [
      { id: "claude", bin: "claude", integration: true, capture: "hooks" },
      { id: "codex", bin: "codex", integration: false, capture: "probe" },
      { id: "opencode", bin: "opencode", integration: true, capture: "plugin" },
      { id: "gemini", bin: "gemini", integration: false, capture: null },
      { id: "aider", bin: "aider", integration: false, capture: null },
      { id: "cursor", bin: "cursor-agent", integration: false, capture: "probe" },
      { id: "copilot", bin: "copilot", integration: false, capture: null }
    ];
    defaultWhich = (bin) => {
      try {
        const out = execFileSync8("which", [bin], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3
        }).trim();
        if (out.length === 0) return null;
        return out.split("\n")[0].trim() || null;
      } catch {
        return null;
      }
    };
    defaultIntegrationProbe = (agentId) => {
      try {
        if (agentId === "claude") return claudeIntegrationStatus().installed;
        if (agentId === "opencode") return opencodeIntegrationStatus().installed;
        return false;
      } catch {
        return false;
      }
    };
  }
});

// packages/daemon/src/lib/dot-path.ts
function setByPath(obj, path2, value) {
  const keys = path2.split(".");
  const last = keys.pop();
  let i = 0;
  const target = keys.reduce((o, k) => {
    const nextKey = keys[i + 1] ?? last;
    if (o[k] === void 0) o[k] = /^\d+$/.test(nextKey) ? [] : {};
    i++;
    return o[k];
  }, obj);
  target[last] = value;
}
var init_dot_path = __esm({
  "packages/daemon/src/lib/dot-path.ts"() {
    "use strict";
  }
});

// packages/daemon/src/command-center/actions/contract.ts
var init_contract = __esm({
  "packages/daemon/src/command-center/actions/contract.ts"() {
    "use strict";
    init_src();
  }
});

// packages/daemon/src/lib/session-monitor.ts
import { execFileSync as execFileSync9 } from "node:child_process";
function getListeningPids() {
  try {
    const raw = execFileSync9("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    const pids = /* @__PURE__ */ new Set();
    let currentPid = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line.startsWith("n") && currentPid) {
        const match = line.match(/:(\d+)$/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= 1024 && port <= 2e4) pids.add(currentPid);
        }
      }
    }
    return pids;
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function getProcessTree() {
  try {
    const raw = execFileSync9("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    const tree = /* @__PURE__ */ new Map();
    for (const line of raw.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) tree.set(parts[0], parts[1]);
    }
    return tree;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function computePortPanes(panes, { listeners, tree } = {}) {
  const resolvedListeners = listeners ?? getListeningPids();
  const resolvedTree = tree ?? getProcessTree();
  if (resolvedListeners.size === 0) return /* @__PURE__ */ new Set();
  const panePids = new Map(panes.map((p) => [p.pid, p.id]));
  const result = /* @__PURE__ */ new Set();
  for (const listenerPid of resolvedListeners) {
    let pid = listenerPid;
    while (pid && pid !== "0") {
      if (panePids.has(pid)) {
        result.add(panePids.get(pid));
        break;
      }
      pid = resolvedTree.get(pid);
    }
  }
  return result;
}
function computeAgentStates(panes) {
  const states = /* @__PURE__ */ new Map();
  for (const pane of panes) {
    const role = pane.role ?? "";
    if (role === "lead" || role === "teammate") {
      states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
      continue;
    }
    const cmd = (pane.cmd ?? "").toLowerCase();
    if (!cmd.includes("claude") && !cmd.includes("codex")) {
      states.set(pane.id, null);
      continue;
    }
    states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
  }
  return states;
}
var SPINNERS;
var init_session_monitor = __esm({
  "packages/daemon/src/lib/session-monitor.ts"() {
    "use strict";
    SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒|/\\-] /;
  }
});

// packages/daemon/src/terminal/PtyAdapter.ts
var PtySpawnError;
var init_PtyAdapter = __esm({
  "packages/daemon/src/terminal/PtyAdapter.ts"() {
    "use strict";
    PtySpawnError = class extends Error {
      adapter;
      code;
      constructor(args) {
        super(args.message, args.cause !== void 0 ? { cause: args.cause } : void 0);
        this.name = "PtySpawnError";
        this.adapter = args.adapter;
        this.code = args.code;
      }
    };
  }
});

// packages/daemon/src/terminal/NodePtyAdapter.ts
import { chmodSync as chmodSync4, existsSync as existsSync25, statSync as statSync3 } from "node:fs";
import { dirname as dirname23, join as join23 } from "node:path";
import { createRequire } from "node:module";
import * as pty from "node-pty";
function candidateSpawnHelperPaths() {
  const requireForNodePty = createRequire(import.meta.url);
  let pkgJsonPath;
  try {
    pkgJsonPath = requireForNodePty.resolve("node-pty/package.json");
  } catch {
    return [];
  }
  const pkgDir = dirname23(pkgJsonPath);
  return [
    join23(pkgDir, "build", "Release", "spawn-helper"),
    join23(pkgDir, "build", "Debug", "spawn-helper"),
    join23(pkgDir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")
  ];
}
function ensureNodePtySpawnHelperExecutable(options = {}) {
  if (process.platform === "win32") return;
  if (!options.force && !options.explicitPath && helperEnsured) return;
  const candidates = options.explicitPath ? [options.explicitPath] : candidateSpawnHelperPaths();
  for (const candidate of candidates) {
    if (!existsSync25(candidate)) continue;
    try {
      chmodSync4(candidate, 493);
    } catch {
    }
  }
  if (!options.explicitPath) helperEnsured = true;
}
function assertValidCwd(cwd, statFn) {
  let stats;
  try {
    stats = statFn(cwd);
  } catch (err) {
    throw new PtySpawnError({
      adapter: ADAPTER_ID,
      code: "cwd_invalid",
      message: `cwd does not exist or cannot be stat'd: ${cwd}`,
      cause: err
    });
  }
  if (!stats.isDirectory()) {
    throw new PtySpawnError({
      adapter: ADAPTER_ID,
      code: "cwd_invalid",
      message: `cwd is not a directory: ${cwd}`
    });
  }
}
var ADAPTER_ID, helperEnsured, NodePtyProcess, NodePtyAdapter, defaultNodePtyAdapter;
var init_NodePtyAdapter = __esm({
  "packages/daemon/src/terminal/NodePtyAdapter.ts"() {
    "use strict";
    init_PtyAdapter();
    ADAPTER_ID = "node-pty";
    helperEnsured = false;
    NodePtyProcess = class {
      exited = false;
      child;
      dataListeners = /* @__PURE__ */ new Set();
      exitListeners = /* @__PURE__ */ new Set();
      constructor(child) {
        this.child = child;
        this.child.onData((data) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
          for (const listener of this.dataListeners) listener(buf);
        });
        this.child.onExit((evt) => {
          this.exited = true;
          const event = {
            exitCode: evt.exitCode ?? 0,
            signal: typeof evt.signal === "number" ? evt.signal : null
          };
          for (const listener of this.exitListeners) listener(event);
        });
      }
      get pid() {
        return this.child.pid;
      }
      write(data) {
        if (this.exited) return;
        if (typeof data === "string") this.child.write(data);
        else this.child.write(Buffer.from(data).toString("binary"));
      }
      resize(cols, rows) {
        if (this.exited) return;
        if (!Number.isInteger(cols) || cols <= 0)
          throw new RangeError("cols must be a positive integer");
        if (!Number.isInteger(rows) || rows <= 0)
          throw new RangeError("rows must be a positive integer");
        try {
          this.child.resize(cols, rows);
        } catch {
        }
      }
      kill(signal) {
        if (this.exited) return;
        try {
          this.child.kill(typeof signal === "number" ? String(signal) : signal);
        } catch {
          this.exited = true;
          for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null });
        }
      }
      onData(callback) {
        this.dataListeners.add(callback);
        return () => {
          this.dataListeners.delete(callback);
        };
      }
      onExit(callback) {
        if (this.exited) {
          return () => void 0;
        }
        this.exitListeners.add(callback);
        return () => {
          this.exitListeners.delete(callback);
        };
      }
    };
    NodePtyAdapter = class {
      id = ADAPTER_ID;
      spawnPty;
      statCwd;
      skipHelperEnsure;
      constructor(options = {}) {
        this.spawnPty = options.spawnPty ?? pty.spawn;
        this.statCwd = options.statCwd ?? statSync3;
        this.skipHelperEnsure = options.skipHelperEnsure ?? false;
      }
      async spawn(input) {
        if (!this.skipHelperEnsure) ensureNodePtySpawnHelperExecutable();
        return this.spawnSyncInternal(input);
      }
      spawnSync(input) {
        if (!this.skipHelperEnsure) ensureNodePtySpawnHelperExecutable();
        return this.spawnSyncInternal(input);
      }
      spawnSyncInternal(input) {
        assertValidCwd(input.cwd, this.statCwd);
        if (!Number.isInteger(input.cols) || input.cols <= 0) {
          throw new PtySpawnError({
            adapter: ADAPTER_ID,
            code: "unknown",
            message: `cols must be a positive integer (got ${input.cols})`
          });
        }
        if (!Number.isInteger(input.rows) || input.rows <= 0) {
          throw new PtySpawnError({
            adapter: ADAPTER_ID,
            code: "unknown",
            message: `rows must be a positive integer (got ${input.rows})`
          });
        }
        const env = {};
        for (const [key, value] of Object.entries(input.env)) {
          if (typeof value === "string") env[key] = value;
        }
        let child;
        try {
          child = this.spawnPty(input.shell, [...input.args ?? []], {
            name: input.name ?? "xterm-256color",
            cols: input.cols,
            rows: input.rows,
            cwd: input.cwd,
            env,
            encoding: input.encoding === "utf8" ? "utf8" : null
          });
        } catch (err) {
          const errno = err?.code;
          if (errno === "ENOENT") {
            throw new PtySpawnError({
              adapter: ADAPTER_ID,
              code: "shell_not_found",
              message: `shell not found in PATH: ${input.shell}`,
              cause: err
            });
          }
          if (errno === "EACCES" || errno === "EPERM") {
            throw new PtySpawnError({
              adapter: ADAPTER_ID,
              code: "permission_denied",
              message: `permission denied spawning ${input.shell}`,
              cause: err
            });
          }
          throw new PtySpawnError({
            adapter: ADAPTER_ID,
            code: "unknown",
            message: `node-pty spawn failed: ${err instanceof Error ? err.message : String(err)}`,
            cause: err
          });
        }
        return new NodePtyProcess(child);
      }
    };
    defaultNodePtyAdapter = new NodePtyAdapter();
  }
});

// packages/daemon/src/server/pty-bridge.ts
import { EventEmitter as EventEmitter2 } from "node:events";
import * as fs from "node:fs";
function assertValidCwd2(cwd, statCwd = fs.statSync) {
  let stats;
  try {
    stats = statCwd(cwd);
  } catch (err) {
    const errno = err?.code;
    if (errno === "ENOENT") {
      throw new TerminalCwdError({ cwd, reason: "notFound", cause: err });
    }
    throw new TerminalCwdError({ cwd, reason: "statFailed", cause: err });
  }
  if (!stats.isDirectory()) {
    throw new TerminalCwdError({ cwd, reason: "notDirectory" });
  }
}
function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== void 0) env[key] = value;
  }
  return env;
}
function outputToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return Buffer.from(String(data), "utf8");
}
function assertPositiveDimension(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}
function readPositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
var DEFAULT_RING_BUFFER_BYTES, TerminalCwdError, PtyBridge;
var init_pty_bridge = __esm({
  "packages/daemon/src/server/pty-bridge.ts"() {
    "use strict";
    init_NodePtyAdapter();
    DEFAULT_RING_BUFFER_BYTES = 256 * 1024;
    TerminalCwdError = class _TerminalCwdError extends Error {
      cwd;
      reason;
      constructor(args) {
        const message = _TerminalCwdError.formatMessage(args.cwd, args.reason);
        super(message, args.cause !== void 0 ? { cause: args.cause } : void 0);
        this.name = "TerminalCwdError";
        this.cwd = args.cwd;
        this.reason = args.reason;
      }
      static formatMessage(cwd, reason) {
        switch (reason) {
          case "notFound":
            return `cwd does not exist: ${cwd}`;
          case "notDirectory":
            return `cwd is not a directory: ${cwd}`;
          case "statFailed":
            return `cwd stat failed: ${cwd}`;
        }
      }
    };
    PtyBridge = class extends EventEmitter2 {
      ptyProcess = null;
      dataDispose = null;
      exitDispose = null;
      exitPoll = null;
      outputTimer = null;
      outputChunks = [];
      pausedOutputChunks = [];
      outputPaused = false;
      replayChunks = [];
      replayBytes = 0;
      lastCwd = null;
      options;
      adapter;
      ringBufferBytes;
      statCwd;
      constructor(options = {}) {
        super();
        this.options = options;
        if (options.ptyAdapter) {
          this.adapter = options.ptyAdapter;
        } else if (options.pty?.spawn) {
          this.adapter = new NodePtyAdapter({
            spawnPty: options.pty.spawn,
            statCwd: options.statCwd,
            skipHelperEnsure: true
          });
        } else {
          this.adapter = defaultNodePtyAdapter;
        }
        this.ringBufferBytes = options.ringBufferBytes ?? readPositiveIntEnv("TMUX_IDE_PTY_RING_BUFFER_BYTES", DEFAULT_RING_BUFFER_BYTES);
        this.statCwd = options.statCwd ?? fs.statSync;
      }
      /**
       * Returns the cwd used by the most recent spawn (or restart). `null`
       * if the bridge has never been spawned. Used by ws-route to detect
       * stale-cwd reuse and trigger a respawn.
       */
      getCwd() {
        return this.lastCwd;
      }
      get pid() {
        return this.ptyProcess?.pid ?? null;
      }
      // `cols`/`rows` aren't on the canonical PtyProcess shape — we mirror the
      // most recent value the bridge handed to the adapter so external readers
      // (status views) can still see the size without rummaging in the child.
      lastCols = null;
      lastRows = null;
      get cols() {
        return this.lastCols;
      }
      get rows() {
        return this.lastRows;
      }
      get running() {
        return this.ptyProcess !== null;
      }
      getReplayBuffer() {
        return Buffer.concat(this.replayChunks, this.replayBytes);
      }
      flushReplayBuffer() {
        this.replayChunks = [];
        this.replayBytes = 0;
      }
      spawn(cols, rows, spawnOptions = {}) {
        if (this.running) {
          throw new Error("PTY already spawned");
        }
        assertPositiveDimension("cols", cols);
        assertPositiveDimension("rows", rows);
        const defaultShell = this.options.shell ?? process.env.SHELL ?? "bash";
        let executable = spawnOptions.cmd?.[0] ?? defaultShell;
        let args = spawnOptions.cmd ? spawnOptions.cmd.slice(1) : this.options.args ?? ["-l"];
        if (executable === "__login_shell__" && args.length > 0) {
          const innerCmd = args.map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
          executable = defaultShell;
          args = ["-l", "-c", `exec ${innerCmd}`];
        }
        const cwd = spawnOptions.cwd ?? this.options.cwd ?? process.env.HOME ?? "/";
        assertValidCwd2(cwd, this.statCwd);
        const env = this.options.env ?? cleanEnv();
        const spawnInput = {
          shell: executable,
          args,
          cwd,
          cols,
          rows,
          env,
          name: this.options.name ?? "xterm-256color",
          encoding: null
        };
        let child;
        try {
          child = this.adapter.spawnSync(spawnInput);
        } catch (err) {
          if (err.code === "ENOENT" && executable === "tmux-ide") {
            throw new Error("tmux-ide not found in PATH", { cause: err });
          }
          throw err;
        }
        this.ptyProcess = child;
        this.lastCwd = cwd;
        this.lastCols = cols;
        this.lastRows = rows;
        this.exitDispose = child.onExit(({ exitCode, signal }) => {
          this.emitExit({ code: exitCode, signal: signal ?? null });
        });
        this.dataDispose = child.onData((data) => {
          this.enqueueOutput(outputToBuffer(data));
        });
        this.startExitPoll(child);
      }
      /**
       * Stop the currently-running PTY process synchronously. Drops listeners
       * and clears replay so a follow-up spawn starts from a clean slate.
       * Idempotent — no-op when no process is running.
       *
       * Used by {@link restartWith} to swap out a sticky bridge whose cwd no
       * longer matches the client request.
       */
      stopProcess(signal = "SIGTERM") {
        if (!this.ptyProcess) return;
        const child = this.ptyProcess;
        this.disposeListeners();
        this.ptyProcess = null;
        this.lastCwd = null;
        this.flushReplayBuffer();
        try {
          child.kill(signal);
        } catch {
        }
      }
      /**
       * Stop the running process (if any) and spawn a new one with the
       * supplied options. Preserves bridge identity (id, registry slot) but
       * resets the replay buffer — the prior process is gone, there is no
       * meaningful output to replay. Used when a reconnect requests a new
       * cwd; modeled on t3code's `stopProcess + spawn` pattern.
       */
      restartWith(cols, rows, spawnOptions = {}) {
        this.stopProcess("SIGTERM");
        this.spawn(cols, rows, spawnOptions);
      }
      pause() {
        this.outputPaused = true;
      }
      resume() {
        if (!this.outputPaused) return;
        this.flushCoalescedOutput();
        this.outputPaused = false;
        this.flushPausedOutput();
      }
      write(bytes) {
        if (!this.ptyProcess) {
          throw new Error("PTY is not running");
        }
        this.ptyProcess.write(typeof bytes === "string" ? bytes : Buffer.from(bytes));
      }
      resize(cols, rows) {
        assertPositiveDimension("cols", cols);
        assertPositiveDimension("rows", rows);
        if (!this.ptyProcess) {
          throw new Error("PTY is not running");
        }
        this.ptyProcess.resize(cols, rows);
        this.lastCols = cols;
        this.lastRows = rows;
      }
      kill(signal = "SIGTERM") {
        if (!this.ptyProcess) return;
        try {
          this.ptyProcess.kill(signal);
        } catch {
        }
      }
      dispose() {
        this.disposeListeners();
        this.kill("SIGTERM");
        this.flushReplayBuffer();
      }
      disposeListeners() {
        this.flushAllOutput();
        this.dataDispose?.();
        this.exitDispose?.();
        if (this.exitPoll) {
          clearInterval(this.exitPoll);
          this.exitPoll = null;
        }
        this.dataDispose = null;
        this.exitDispose = null;
      }
      enqueueOutput(bytes) {
        if (bytes.byteLength === 0) return;
        const coalesceMs = this.options.coalesceMs ?? 8;
        if (coalesceMs <= 0) {
          this.deliverOutput(bytes);
          return;
        }
        this.outputChunks.push(bytes);
        if (this.outputTimer) return;
        this.outputTimer = setTimeout(() => {
          this.outputTimer = null;
          this.flushCoalescedOutput();
        }, coalesceMs);
        this.outputTimer.unref?.();
      }
      flushCoalescedOutput() {
        if (this.outputTimer) {
          clearTimeout(this.outputTimer);
          this.outputTimer = null;
        }
        if (this.outputChunks.length === 0) return;
        const chunks = this.outputChunks;
        this.outputChunks = [];
        this.deliverOutput(Buffer.concat(chunks));
      }
      deliverOutput(bytes) {
        this.appendReplay(bytes);
        if (this.outputPaused) {
          this.pausedOutputChunks.push(bytes);
          return;
        }
        this.emit("output", bytes);
      }
      flushPausedOutput() {
        if (this.pausedOutputChunks.length === 0) return;
        const chunks = this.pausedOutputChunks;
        this.pausedOutputChunks = [];
        this.emit("output", Buffer.concat(chunks));
      }
      flushAllOutput() {
        if (this.outputTimer) {
          clearTimeout(this.outputTimer);
          this.outputTimer = null;
        }
        if (this.outputChunks.length > 0) this.appendReplay(Buffer.concat(this.outputChunks));
        const chunks = [...this.pausedOutputChunks, ...this.outputChunks];
        this.pausedOutputChunks = [];
        this.outputChunks = [];
        if (chunks.length > 0) {
          const bytes = Buffer.concat(chunks);
          this.emit("output", bytes);
        }
      }
      appendReplay(bytes) {
        if (this.ringBufferBytes <= 0 || bytes.byteLength === 0) return;
        if (bytes.byteLength >= this.ringBufferBytes) {
          const tail = bytes.subarray(bytes.byteLength - this.ringBufferBytes);
          this.replayChunks = [Buffer.from(tail)];
          this.replayBytes = tail.byteLength;
          return;
        }
        this.replayChunks.push(Buffer.from(bytes));
        this.replayBytes += bytes.byteLength;
        while (this.replayBytes > this.ringBufferBytes && this.replayChunks.length > 0) {
          const first = this.replayChunks[0];
          const overflow = this.replayBytes - this.ringBufferBytes;
          if (first.byteLength <= overflow) {
            this.replayChunks.shift();
            this.replayBytes -= first.byteLength;
          } else {
            this.replayChunks[0] = first.subarray(overflow);
            this.replayBytes -= overflow;
          }
        }
      }
      startExitPoll(child) {
        this.exitPoll = setInterval(() => {
          if (this.ptyProcess !== child) {
            this.disposeListeners();
            return;
          }
          try {
            process.kill(child.pid, 0);
          } catch (err) {
            if (err.code === "ESRCH") {
              this.emitExit({ code: 0, signal: null });
            }
          }
        }, 100);
        this.exitPoll.unref?.();
      }
      emitExit(exit) {
        if (!this.ptyProcess) return;
        this.flushAllOutput();
        this.disposeListeners();
        this.ptyProcess = null;
        this.lastCwd = null;
        this.flushReplayBuffer();
        this.emit("exit", exit);
      }
    };
  }
});

// packages/daemon/src/server/ws-route.ts
function isPositiveInteger(value) {
  return Number.isInteger(value) && Number(value) > 0;
}
function rawDataToBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
function rawDataToText(data) {
  return typeof data === "string" ? data : rawDataToBuffer(data).toString("utf8");
}
function isJsonControlFrame(data, isBinary) {
  return !isBinary && rawDataToText(data).startsWith("{");
}
function parseJsonObject(data) {
  const parsed = JSON.parse(rawDataToText(data));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("control frame must be a JSON object");
  }
  return parsed;
}
function parseInitFrame(data) {
  const frame = parseJsonObject(data);
  if (frame.type !== "init") {
    throw new Error("first frame must be init");
  }
  if (!isPositiveInteger(frame.cols) || !isPositiveInteger(frame.rows)) {
    throw new Error("init requires positive integer cols and rows");
  }
  if (frame.cwd !== void 0 && typeof frame.cwd !== "string") {
    throw new Error("init cwd must be a string");
  }
  if (frame.cmd !== void 0 && (!Array.isArray(frame.cmd) || frame.cmd.length === 0 || !frame.cmd.every((part) => typeof part === "string"))) {
    throw new Error("init cmd must be a non-empty string array");
  }
  return {
    type: "init",
    cols: frame.cols,
    rows: frame.rows,
    ...frame.cwd !== void 0 ? { cwd: frame.cwd } : {},
    ...frame.cmd !== void 0 ? { cmd: frame.cmd } : {}
  };
}
function parseResizeFrame(data) {
  const frame = parseJsonObject(data);
  if (frame.type !== "resize") {
    throw new Error(`unsupported control frame: ${String(frame.type)}`);
  }
  if (!isPositiveInteger(frame.cols) || !isPositiveInteger(frame.rows)) {
    throw new Error("resize requires positive integer cols and rows");
  }
  return { type: "resize", cols: frame.cols, rows: frame.rows };
}
function sendError(ws, message, extras) {
  if (ws.readyState !== WS_OPEN) return;
  const frame = { type: "error", message };
  if (extras?.reason !== void 0) frame.reason = extras.reason;
  if (extras?.cwd !== void 0) frame.cwd = extras.cwd;
  ws.send(JSON.stringify(frame));
}
function sendCwdError(ws, err) {
  sendError(ws, err.message, {
    reason: CWD_ERROR_WIRE_REASON[err.reason],
    cwd: err.cwd
  });
}
function closeWs(ws) {
  if (ws.readyState === WS_OPEN) {
    ws.close();
  }
}
function backpressureBytes() {
  const parsed = Number.parseInt(process.env.TMUX_IDE_PTY_BACKPRESSURE_BYTES ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKPRESSURE_BYTES;
}
function bridgeIdleMs(options) {
  if (options?.idleMs !== void 0) return options.idleMs;
  const parsed = Number.parseInt(process.env.TMUX_IDE_BRIDGE_IDLE_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BRIDGE_IDLE_MS;
}
function shutdownPtyBridges() {
  defaultPtyBridgeRegistry.shutdown();
}
function handlePtyWebSocket(ws, id, options = {}) {
  const socket = ws;
  let bridge = null;
  let initialized = false;
  let ptyExited = false;
  let killTimer = null;
  let drainTimer = null;
  let releaseBridge = null;
  let outputListener = null;
  let exitListener = null;
  const backpressureThreshold = backpressureBytes();
  const resumeThreshold = Math.floor(backpressureThreshold / 2);
  const clearKillTimer = () => {
    if (!killTimer) return;
    clearTimeout(killTimer);
    killTimer = null;
  };
  const clearDrainTimer = () => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = null;
  };
  const scheduleDrainCheck = () => {
    if (drainTimer || !bridge) return;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (!bridge || socket.readyState !== WS_OPEN) return;
      if ((socket.bufferedAmount ?? 0) <= resumeThreshold) {
        bridge.resume();
        return;
      }
      scheduleDrainCheck();
    }, DRAIN_POLL_MS);
    drainTimer.unref?.();
  };
  const maybePauseForBackpressure = () => {
    if (!bridge || (socket.bufferedAmount ?? 0) <= backpressureThreshold) return;
    bridge.pause();
    scheduleDrainCheck();
  };
  const closeWithError = (message) => {
    sendError(socket, message);
    closeWs(socket);
  };
  const closeWithCwdError = (err) => {
    sendCwdError(socket, err);
    closeWs(socket);
  };
  const attachBridgeEvents = (ptyBridge) => {
    outputListener = (bytes) => {
      if (socket.readyState === WS_OPEN) {
        maybePauseForBackpressure();
        socket.send(bytes, { binary: true });
        maybePauseForBackpressure();
      }
    };
    exitListener = (exit) => {
      ptyExited = true;
      clearKillTimer();
      clearDrainTimer();
      if (socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({ type: "exit", code: exit.code, signal: exit.signal }));
        socket.close();
      }
    };
    ptyBridge.on("output", outputListener);
    ptyBridge.on("exit", exitListener);
  };
  const detachBridgeEvents = () => {
    if (bridge && outputListener) bridge.off("output", outputListener);
    if (bridge && exitListener) bridge.off("exit", exitListener);
    outputListener = null;
    exitListener = null;
  };
  socket.on("message", (data, isBinary) => {
    if (!initialized) {
      if (!isJsonControlFrame(data, isBinary)) {
        closeWithError("init frame required before input");
        return;
      }
      let init2;
      try {
        init2 = parseInitFrame(data);
      } catch (err) {
        closeWithError(err instanceof Error ? err.message : String(err));
        return;
      }
      const registry = options.registry ?? defaultPtyBridgeRegistry;
      const acquired = registry.acquire(
        id,
        options.createBridge ?? ((bridgeId) => new PtyBridge({ id: bridgeId })),
        {
          idleMs: options.idleMs
        }
      );
      bridge = acquired.bridge;
      releaseBridge = acquired.release;
      attachBridgeEvents(bridge);
      try {
        const spawnOptions = {};
        if (init2.cwd !== void 0) spawnOptions.cwd = init2.cwd;
        if (init2.cmd !== void 0) spawnOptions.cmd = init2.cmd;
        const currentCwd = bridge.getCwd?.() ?? null;
        const cwdChanged = init2.cwd !== void 0 && currentCwd !== null && currentCwd !== init2.cwd;
        if (!acquired.reused) {
          bridge.spawn(init2.cols, init2.rows, spawnOptions);
        } else if (cwdChanged && bridge.restartWith) {
          bridge.restartWith(init2.cols, init2.rows, spawnOptions);
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify({ type: "replay-end", bytes: 0 }));
          }
        } else {
          try {
            bridge.resize(init2.cols, init2.rows);
          } catch {
          }
          const replay = bridge.getReplayBuffer?.() ?? Buffer.alloc(0);
          if (replay.byteLength > 0 && socket.readyState === WS_OPEN) {
            socket.send(replay, { binary: true });
          }
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify({ type: "replay-end", bytes: replay.byteLength }));
          }
        }
        initialized = true;
      } catch (err) {
        detachBridgeEvents();
        releaseBridge?.();
        if (err instanceof TerminalCwdError) {
          closeWithCwdError(err);
        } else {
          closeWithError(`spawn failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    if (isJsonControlFrame(data, isBinary)) {
      try {
        const resize = parseResizeFrame(data);
        bridge?.resize(resize.cols, resize.rows);
      } catch (err) {
        closeWithError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    try {
      bridge?.write(rawDataToBuffer(data));
    } catch (err) {
      closeWithError(err instanceof Error ? err.message : String(err));
    }
  });
  socket.on("close", () => {
    clearDrainTimer();
    detachBridgeEvents();
    if (!bridge || ptyExited) return;
    releaseBridge?.();
  });
  socket.on("error", () => {
    closeWs(socket);
  });
  return {
    getBridge: () => bridge
  };
}
var WS_OPEN, DEFAULT_BACKPRESSURE_BYTES, DRAIN_POLL_MS, DEFAULT_BRIDGE_IDLE_MS, CWD_ERROR_WIRE_REASON, PtyBridgeRegistry, defaultPtyBridgeRegistry;
var init_ws_route = __esm({
  "packages/daemon/src/server/ws-route.ts"() {
    "use strict";
    init_pty_bridge();
    WS_OPEN = 1;
    DEFAULT_BACKPRESSURE_BYTES = 1 << 20;
    DRAIN_POLL_MS = 16;
    DEFAULT_BRIDGE_IDLE_MS = 3e5;
    CWD_ERROR_WIRE_REASON = {
      notFound: "cwd-not-found",
      notDirectory: "cwd-not-directory",
      statFailed: "cwd-stat-failed"
    };
    PtyBridgeRegistry = class {
      entries = /* @__PURE__ */ new Map();
      acquire(id, createBridge, options = {}) {
        let entry = this.entries.get(id);
        const reused = !!entry && entry.bridge.running !== false;
        if (!entry || entry.bridge.running === false) {
          entry = { bridge: createBridge(id), clients: 0, idleTimer: null };
          this.entries.set(id, entry);
          entry.bridge.on("exit", () => {
            this.entries.delete(id);
          });
        }
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        entry.clients++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          const current = this.entries.get(id);
          if (!current) return;
          current.clients = Math.max(0, current.clients - 1);
          if (current.clients > 0 || current.bridge.running === false) return;
          const idleMs = bridgeIdleMs(options);
          current.idleTimer = setTimeout(() => {
            const latest = this.entries.get(id);
            if (!latest || latest.clients > 0) return;
            latest.bridge.kill("SIGTERM");
            this.entries.delete(id);
          }, idleMs);
          current.idleTimer.unref?.();
        };
        return { bridge: entry.bridge, reused, release };
      }
      /**
       * Look up a bridge by id without acquiring it. Returns `null` when no
       * bridge is registered for the id. Used by server-side action handlers
       * (terminal.respawn, terminal.stop) that need to operate on an existing
       * bridge — they should not bump the client refcount.
       */
      peek(id) {
        const entry = this.entries.get(id);
        if (!entry) return null;
        if (entry.bridge.running === false) return null;
        return entry.bridge;
      }
      /**
       * Drop the bridge for `id`, killing it synchronously. Used by the
       * terminal.stop action handler to release a sticky bridge whose owner
       * has explicitly asked to terminate it.
       */
      delete(id) {
        const entry = this.entries.get(id);
        if (!entry) return false;
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = null;
        }
        try {
          entry.bridge.kill("SIGTERM");
        } catch {
        }
        this.entries.delete(id);
        return true;
      }
      shutdown() {
        for (const entry of this.entries.values()) {
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          entry.bridge.kill("SIGTERM");
        }
        this.entries.clear();
      }
      size() {
        return this.entries.size;
      }
    };
    defaultPtyBridgeRegistry = new PtyBridgeRegistry();
  }
});

// packages/daemon/src/widgets/lib/pane-comms.ts
import { execFileSync as execFileSync10 } from "node:child_process";
function tmux2(...args) {
  try {
    return _executor2("tmux", args, {
      stdio: ["pipe", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString() ?? "";
    if (stderr.includes("no server running") || stderr.includes("can't find session")) {
      return "";
    }
    throw error;
  }
}
function listSessionPanes(session) {
  const format = [
    "#{pane_id}",
    "#{pane_index}",
    "#{pane_title}",
    "#{pane_current_command}",
    "#{pane_width}",
    "#{pane_height}",
    "#{pane_active}",
    "#{@ide_role}",
    "#{@ide_name}",
    "#{@ide_type}"
  ].join("	");
  const output = tmux2("list-panes", "-t", session, "-F", format);
  if (!output) return [];
  return output.split("\n").filter(Boolean).map((line) => {
    const [id, index, title, cmd, width, height, active2, role, name, type] = line.split("	");
    return {
      id,
      index: parseInt(index, 10),
      title,
      currentCommand: cmd,
      width: parseInt(width, 10),
      height: parseInt(height, 10),
      active: active2 === "1",
      role: role || null,
      name: name || null,
      type: type || null
    };
  });
}
function getPaneBusyStatus(session, paneId) {
  const panes = listSessionPanes(session);
  const pane = panes.find((p) => p.id === paneId);
  if (!pane) return "busy";
  const cmd = pane.currentCommand.toLowerCase();
  if (cmd.startsWith("claude") || cmd.startsWith("codex")) return "agent";
  if (SHELL_COMMANDS.has(cmd)) return "idle";
  return "busy";
}
function sendText(session, paneId, text) {
  tmux2("send-keys", "-t", paneId, "-l", "--", text);
}
function sendLiteralToPane(_session, paneId, text) {
  tmux2("send-keys", "-t", paneId, "-l", "--", text);
}
function sendEnterToPane(_session, paneId) {
  tmux2("send-keys", "-t", paneId, "Enter");
}
function sleepMs2(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sendCommand(session, paneId, command2) {
  const status2 = getPaneBusyStatus(session, paneId);
  try {
    tmux2("send-keys", "-t", paneId, "-l", "--", command2);
  } catch {
    return false;
  }
  if (status2 === "agent") {
    if (command2.length < 200) {
      sleepMs2(150);
    } else {
      sleepMs2(5e3);
      tmux2("send-keys", "-t", paneId, "Enter");
      sleepMs2(2e3);
    }
    tmux2("send-keys", "-t", paneId, "Enter");
    return true;
  }
  tmux2("send-keys", "-t", paneId, "Enter");
  return true;
}
var _executor2, SHELL_COMMANDS;
var init_pane_comms = __esm({
  "packages/daemon/src/widgets/lib/pane-comms.ts"() {
    "use strict";
    _executor2 = (cmd, args, options) => execFileSync10(cmd, args, { encoding: "utf-8", ...options }).toString();
    SHELL_COMMANDS = /* @__PURE__ */ new Set(["zsh", "bash", "sh", "fish"]);
  }
});

// packages/daemon/src/lib/workspace-registry.ts
import { EventEmitter as EventEmitter3 } from "node:events";
import { existsSync as existsSync26, mkdirSync as mkdirSync17, readFileSync as readFileSync20, renameSync as renameSync9, writeFileSync as writeFileSync16 } from "node:fs";
import { homedir as homedir16 } from "node:os";
import { dirname as dirname24, join as join24 } from "node:path";
import { z as z27 } from "zod";
function getDefaultWorkspaceRegistry() {
  if (!_default) _default = new WorkspaceRegistry();
  return _default;
}
function defaultListSessions() {
  const { execFileSync: execFileSync17 } = __require("node:child_process");
  try {
    const raw = execFileSync17("tmux", ["list-sessions", "-F", "#{session_name}"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
var REGISTRY_DIR_ENV3, RegistryFileSchemaZ2, WorkspaceAlreadyExistsError, WorkspaceNotFoundError, WorkspaceRegistry, _default;
var init_workspace_registry = __esm({
  "packages/daemon/src/lib/workspace-registry.ts"() {
    "use strict";
    init_src();
    REGISTRY_DIR_ENV3 = "TMUX_IDE_REGISTRY_DIR";
    RegistryFileSchemaZ2 = z27.object({
      version: z27.literal(1),
      workspaces: z27.array(WorkspaceSchemaZ)
    });
    WorkspaceAlreadyExistsError = class extends Error {
      code = "ALREADY_EXISTS";
      constructor(name) {
        super(`Workspace "${name}" already exists`);
        this.name = "WorkspaceAlreadyExistsError";
      }
    };
    WorkspaceNotFoundError = class extends Error {
      code = "NOT_FOUND";
      constructor(name) {
        super(`Workspace "${name}" not found`);
        this.name = "WorkspaceNotFoundError";
      }
    };
    WorkspaceRegistry = class {
      dir;
      listSessions;
      emitter = new EventEmitter3();
      workspaces = [];
      loaded = false;
      constructor(options = {}) {
        this.dir = options.dir ?? process.env[REGISTRY_DIR_ENV3] ?? join24(homedir16(), ".tmux-ide");
        this.listSessions = options.listSessions ?? defaultListSessions;
        this.emitter.setMaxListeners(0);
      }
      /**
       * Load workspaces from disk and reconcile against live tmux sessions.
       * Drops entries whose tmux session is gone (silently — they were
       * persisted by a prior daemon invocation that may have crashed).
       *
       * Safe to call repeatedly; subsequent calls re-reconcile.
       */
      async load() {
        const fromDisk = this.readDisk();
        let live;
        try {
          live = new Set(this.listSessions());
        } catch {
          live = new Set(fromDisk.map((w) => w.sessionName));
        }
        const reconciled = fromDisk.filter((w) => live.has(w.sessionName));
        this.workspaces = reconciled;
        this.loaded = true;
        if (reconciled.length !== fromDisk.length) {
          this.writeDisk();
        }
      }
      list() {
        return [...this.workspaces];
      }
      get(name) {
        return this.workspaces.find((w) => w.name === name) ?? null;
      }
      has(name) {
        return this.workspaces.some((w) => w.name === name);
      }
      add(input) {
        if (this.has(input.name)) {
          throw new WorkspaceAlreadyExistsError(input.name);
        }
        const now = (input.now ?? (() => /* @__PURE__ */ new Date()))();
        const workspace = {
          name: input.name,
          sessionName: input.sessionName ?? input.name,
          projectDir: input.projectDir,
          ideConfigPath: input.ideConfigPath ?? null,
          configKind: input.configKind,
          configPath: input.configPath,
          hasWorkspaceConfig: input.hasWorkspaceConfig,
          addedAt: now.toISOString()
        };
        this.workspaces = [...this.workspaces, workspace];
        this.writeDisk();
        this.emitter.emit("workspace.added", workspace);
        return workspace;
      }
      remove(name) {
        if (!this.has(name)) {
          throw new WorkspaceNotFoundError(name);
        }
        this.workspaces = this.workspaces.filter((w) => w.name !== name);
        this.writeDisk();
        this.emitter.emit("workspace.removed", name);
      }
      /** Subscribe to workspace.added | workspace.removed events. */
      on(event, handler) {
        this.emitter.on(event, handler);
        return () => this.emitter.off(event, handler);
      }
      // ----------------- io -----------------
      filePath() {
        return join24(this.dir, "workspaces.json");
      }
      readDisk() {
        const path2 = this.filePath();
        if (!existsSync26(path2)) return [];
        let parsed;
        try {
          parsed = JSON.parse(readFileSync20(path2, "utf-8"));
        } catch {
          return [];
        }
        const result = RegistryFileSchemaZ2.safeParse(parsed);
        if (!result.success) return [];
        return result.data.workspaces;
      }
      writeDisk() {
        const path2 = this.filePath();
        mkdirSync17(dirname24(path2), { recursive: true });
        const file = { version: 1, workspaces: this.workspaces };
        const tmp = `${path2}.tmp`;
        writeFileSync16(tmp, JSON.stringify(file, null, 2) + "\n");
        renameSync9(tmp, path2);
      }
      /** @internal Test-only: assert the registry is loaded. */
      _isLoaded() {
        return this.loaded;
      }
    };
    _default = null;
  }
});

// packages/daemon/src/command-center/discovery.ts
import { execFileSync as execFileSync11 } from "node:child_process";
function tmuxSilent(args) {
  try {
    return _tmuxRunner(args);
  } catch {
    return "";
  }
}
function listTmuxSessions() {
  const raw = tmuxSilent(["list-sessions", "-F", "#{session_name}"]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}
function getSessionCwd2(session) {
  return tmuxSilent(["display-message", "-t", session, "-p", "#{pane_current_path}"]);
}
function discoverSessions() {
  const sessionNames = listTmuxSessions();
  const results = [];
  const registry = getDefaultWorkspaceRegistry();
  const enforceRegistry = registry._isLoaded();
  for (const name of sessionNames) {
    if (enforceRegistry && !registry.has(name)) continue;
    const dir = getSessionCwd2(name);
    if (!dir) continue;
    let panes = [];
    try {
      panes = listSessionPanes(name);
    } catch {
    }
    results.push({ name, dir, panes });
  }
  return results;
}
function buildOverviews(sessions) {
  return sessions.map((s) => ({ name: s.name, dir: s.dir }));
}
function buildProjectDetail(info) {
  return {
    session: info.name,
    dir: info.dir,
    panes: info.panes
  };
}
var _tmuxRunner;
var init_discovery = __esm({
  "packages/daemon/src/command-center/discovery.ts"() {
    "use strict";
    init_pane_comms();
    init_workspace_registry();
    _tmuxRunner = (args) => execFileSync11("tmux", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  }
});

// packages/daemon/src/command-center/ws-events.ts
function snapshotSessionsHash() {
  try {
    return JSON.stringify(
      discoverSessions().map((s) => s.name).sort()
    );
  } catch {
    return "";
  }
}
function ensureSessionsPoller() {
  if (sessionsPollTimer) return;
  lastSessionsHash = snapshotSessionsHash();
  sessionsPollTimer = setInterval(() => {
    const hash = snapshotSessionsHash();
    if (hash === lastSessionsHash) return;
    lastSessionsHash = hash;
    for (const client of allClients) client.broadcastSessionsChanged();
  }, SESSIONS_POLL_MS);
  sessionsPollTimer.unref?.();
}
function maybeStopSessionsPoller() {
  if (allClients.size > 0 || !sessionsPollTimer) return;
  clearInterval(sessionsPollTimer);
  sessionsPollTimer = null;
}
function ensureProjectRegistryListener() {
  if (projectRegistryListener) return;
  const listener = () => {
    for (const client of allClients) client.broadcastProjectsChanged();
  };
  projectRegistryListener = listener;
  projectRegistryEmitter.on("change", listener);
}
function maybeStopProjectRegistryListener() {
  if (allClients.size > 0 || !projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
}
function broadcastInitOutput(jobId, chunk, done) {
  for (const client of allClients) client.broadcastInitOutput(jobId, chunk, done);
}
function broadcastInitError(jobId, message) {
  for (const client of allClients) client.broadcastInitError(jobId, message);
}
function broadcastActionComplete(name, result) {
  for (const client of allClients) client.broadcastActionComplete(name, result);
}
function broadcastConfigChanged(sessionName) {
  for (const client of allClients) client.broadcastConfigChanged(sessionName);
}
function broadcastTerminalsChanged(sessionName) {
  for (const client of allClients) client.broadcastTerminalsChanged(sessionName);
}
function rawDataToText2(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
function buildSessionSnapshot(sessionName) {
  const session = discoverSessions().find((s) => s.name === sessionName);
  if (!session) return null;
  return { project: buildProjectDetail(session) };
}
function handleWsEventsConnection(socket) {
  const ws = socket;
  const subscriptions = /* @__PURE__ */ new Set();
  let closed = false;
  const send2 = (frame) => {
    if (closed || ws.readyState !== WS_OPEN2) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
    }
  };
  const broadcastSessionsChanged = () => {
    send2({ type: "sessions.changed" });
  };
  const broadcastProjectsChanged = () => {
    send2({ type: "projects.changed" });
  };
  const broadcastInitOutputForClient = (jobId, chunk, done) => {
    const frame = done === void 0 ? { type: "init.output", jobId, chunk } : { type: "init.output", jobId, chunk, done };
    send2(frame);
  };
  const broadcastInitErrorForClient = (jobId, message) => {
    send2({ type: "init.error", jobId, message });
  };
  const broadcastActionCompleteForClient = (name, result) => {
    send2({ type: "action.complete", name, result });
  };
  const broadcastConfigChangedForClient = (sessionName) => {
    send2({ type: "config.changed", sessionName });
  };
  const broadcastTerminalsChangedForClient = (sessionName) => {
    send2({ type: "terminals.changed", sessionName });
  };
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  const unsubWorkspaceAdded = workspaceRegistry.on(
    "workspace.added",
    (workspace) => send2({ type: "workspace.added", workspace })
  );
  const unsubWorkspaceRemoved = workspaceRegistry.on(
    "workspace.removed",
    (name) => send2({ type: "workspace.removed", name })
  );
  const clientHandle = {
    broadcastSessionsChanged,
    broadcastProjectsChanged,
    broadcastInitOutput: broadcastInitOutputForClient,
    broadcastInitError: broadcastInitErrorForClient,
    broadcastActionComplete: broadcastActionCompleteForClient,
    broadcastConfigChanged: broadcastConfigChangedForClient,
    broadcastTerminalsChanged: broadcastTerminalsChangedForClient
  };
  allClients.add(clientHandle);
  ensureSessionsPoller();
  ensureProjectRegistryListener();
  const keepalive = setInterval(() => {
    send2({ type: "pong" });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();
  const subscribe = (sessionName) => {
    if (subscriptions.has(sessionName)) return;
    const session = discoverSessions().find((s) => s.name === sessionName);
    subscriptions.add(sessionName);
    if (session) {
      const data = buildSessionSnapshot(sessionName);
      if (data) {
        send2({ type: "snapshot", sessionName, data });
      }
    }
  };
  const unsubscribe = (sessionName) => {
    subscriptions.delete(sessionName);
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    allClients.delete(clientHandle);
    subscriptions.clear();
    unsubWorkspaceAdded();
    unsubWorkspaceRemoved();
    maybeStopSessionsPoller();
    maybeStopProjectRegistryListener();
  };
  ws.on("message", (data) => {
    if (closed) return;
    let parsed = null;
    try {
      const obj = JSON.parse(rawDataToText2(data));
      if (obj && typeof obj === "object" && typeof obj.type === "string") {
        parsed = obj;
      }
    } catch {
      return;
    }
    if (!parsed) return;
    if (parsed.type === "subscribe") {
      for (const name of parsed.sessions) subscribe(name);
      return;
    }
    if (parsed.type === "unsubscribe") {
      for (const name of parsed.sessions) unsubscribe(name);
      return;
    }
    if (parsed.type === "ping") {
      send2({ type: "pong" });
      return;
    }
  });
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  try {
    const sessions = discoverSessions();
    send2({ type: "hello", sessions: buildOverviews(sessions) });
  } catch {
    send2({ type: "hello", sessions: [] });
  }
}
var WS_OPEN2, KEEPALIVE_INTERVAL_MS, SESSIONS_POLL_MS, allClients, sessionsPollTimer, lastSessionsHash, projectRegistryListener;
var init_ws_events = __esm({
  "packages/daemon/src/command-center/ws-events.ts"() {
    "use strict";
    init_discovery();
    init_project_registry();
    init_workspace_registry();
    WS_OPEN2 = 1;
    KEEPALIVE_INTERVAL_MS = 25e3;
    SESSIONS_POLL_MS = 2e3;
    allClients = /* @__PURE__ */ new Set();
    sessionsPollTimer = null;
    lastSessionsHash = "";
    projectRegistryListener = null;
  }
});

// packages/daemon/src/lib/auth-token.ts
import { randomBytes } from "node:crypto";
function generateAuthToken() {
  return randomBytes(32).toString("base64url");
}
var init_auth_token = __esm({
  "packages/daemon/src/lib/auth-token.ts"() {
    "use strict";
  }
});

// packages/daemon/src/lib/app-settings.ts
import { existsSync as existsSync27, mkdirSync as mkdirSync18, readFileSync as readFileSync21, renameSync as renameSync10, writeFileSync as writeFileSync17 } from "node:fs";
import { dirname as dirname25, join as join25 } from "node:path";
import { homedir as homedir17 } from "node:os";
function settingsDir() {
  return process.env.TMUX_IDE_SETTINGS_DIR ?? join25(homedir17(), ".tmux-ide");
}
function appSettingsPath() {
  return join25(settingsDir(), "app-settings.json");
}
function normalizeSettings(value) {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SETTINGS);
  const remote = value.remoteAccess;
  if (!remote || typeof remote !== "object") return structuredClone(DEFAULT_SETTINGS);
  const enabled = remote.enabled === true;
  const rawToken = remote.token;
  const token = typeof rawToken === "string" && rawToken.length > 0 ? rawToken : null;
  return { remoteAccess: { enabled, token } };
}
function readAppSettings() {
  const path2 = appSettingsPath();
  if (!existsSync27(path2)) return structuredClone(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(readFileSync21(path2, "utf-8")));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}
function writeAppSettings(next) {
  const path2 = appSettingsPath();
  mkdirSync18(dirname25(path2), { recursive: true });
  const tmp = `${path2}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync17(tmp, `${JSON.stringify(normalizeSettings(next), null, 2)}
`, "utf-8");
  renameSync10(tmp, path2);
}
var DEFAULT_SETTINGS;
var init_app_settings = __esm({
  "packages/daemon/src/lib/app-settings.ts"() {
    "use strict";
    DEFAULT_SETTINGS = {
      remoteAccess: {
        enabled: false,
        token: null
      }
    };
  }
});

// packages/daemon/src/command-center/actions/handlers/app-set-remote-access.ts
import { hostname, networkInterfaces } from "node:os";
function setRemoteAccessRestartBackend(backend2) {
  remoteAccessRestartBackend = backend2;
}
function currentPort(deps2) {
  const envPort = Number(process.env.TMUX_IDE_DAEMON_PORT);
  return deps2.port ?? (Number.isInteger(envPort) && envPort > 0 ? envPort : 6060);
}
function primaryLanHost() {
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return hostname();
}
function buildUrl(host, port) {
  return `http://${host}:${port}`;
}
function defaultDeferRestart(restart2) {
  setImmediate(restart2);
}
async function appSetRemoteAccessHandler(input, deps2 = {}) {
  const readSettings2 = deps2.readSettings ?? readAppSettings;
  const writeSettings = deps2.writeSettings ?? writeAppSettings;
  const nextEnabled = input.enabled;
  const current = readSettings2();
  const token = nextEnabled ? current.remoteAccess.token ?? (deps2.generateToken ?? generateAuthToken)() : null;
  const next = {
    ...current,
    remoteAccess: { enabled: nextEnabled, token }
  };
  writeSettings(next);
  const port = currentPort(deps2);
  const request = {
    enabled: nextEnabled,
    bindHostname: nextEnabled ? "0.0.0.0" : "127.0.0.1",
    token,
    port
  };
  const restartDaemon = deps2.restartDaemon ?? remoteAccessRestartBackend;
  if (restartDaemon) {
    (deps2.deferRestart ?? defaultDeferRestart)(() => {
      void Promise.resolve(restartDaemon(request)).catch((err) => {
        console.error(
          `[actions] Failed to restart daemon for remote access: ${err.message ?? String(err)}`
        );
      });
    });
  }
  if (!nextEnabled) {
    return { enabled: false, url: null, token: null, qrPayload: null };
  }
  const host = deps2.host ?? primaryLanHost();
  const url = buildUrl(host, port);
  return {
    enabled: true,
    url,
    token,
    qrPayload: `${url}?token=${encodeURIComponent(token ?? "")}`
  };
}
var remoteAccessRestartBackend;
var init_app_set_remote_access = __esm({
  "packages/daemon/src/command-center/actions/handlers/app-set-remote-access.ts"() {
    "use strict";
    init_auth_token();
    init_app_settings();
    remoteAccessRestartBackend = null;
  }
});

// packages/daemon/src/command-center/actions/errors.ts
function actionErrorFromCwdError(err) {
  return new ActionError({
    code: CWD_REASON_TO_CODE[err.reason],
    message: err.message,
    details: { cwd: err.cwd, reason: err.reason },
    cause: err
  });
}
function wrapInternalError(err) {
  if (err instanceof ActionError) return err;
  if (err instanceof TerminalCwdError) return actionErrorFromCwdError(err);
  const message = err instanceof Error ? err.message : String(err);
  return new ActionError({ code: "internal", message, cause: err });
}
var ActionError, CWD_REASON_TO_CODE;
var init_errors3 = __esm({
  "packages/daemon/src/command-center/actions/errors.ts"() {
    "use strict";
    init_pty_bridge();
    ActionError = class extends Error {
      code;
      details;
      constructor(args) {
        super(
          args.message,
          args.cause !== void 0 ? { cause: args.cause } : void 0
        );
        this.name = "ActionError";
        this.code = args.code;
        this.details = args.details;
      }
      toEnvelope() {
        return this.details !== void 0 ? { code: this.code, message: this.message, details: this.details } : { code: this.code, message: this.message };
      }
    };
    CWD_REASON_TO_CODE = {
      notFound: "cwd_not_found",
      notDirectory: "cwd_not_directory",
      statFailed: "cwd_stat_failed"
    };
  }
});

// packages/daemon/src/command-center/actions/handlers/daemon-shutdown.ts
function setDaemonShutdownBackend(backend2, instanceId = null) {
  shutdownBackend = backend2;
  daemonInstanceId = backend2 ? instanceId : null;
  if (!backend2) shutdownInProgress = false;
}
function daemonShutdownHandler(input, deps2 = {}) {
  const expectedInstanceId = input.expectedInstanceId;
  const currentInstanceId = deps2.instanceId ?? daemonInstanceId;
  if (expectedInstanceId && expectedInstanceId !== currentInstanceId) {
    throw new ActionError({
      code: "daemon_instance_mismatch",
      message: "Daemon instance changed before shutdown"
    });
  }
  if (shutdownInProgress) {
    throw new ActionError({
      code: "shutdown_already_in_progress",
      message: "Daemon shutdown is already in progress"
    });
  }
  shutdownInProgress = true;
  const shutdown = deps2.shutdown ?? shutdownBackend;
  process.nextTick(() => {
    void Promise.resolve(shutdown?.(input.reason ?? null)).catch((err) => {
      console.error("[daemon] shutdown action failed:", err);
    });
  });
  return { stopping: true };
}
var shutdownBackend, daemonInstanceId, shutdownInProgress;
var init_daemon_shutdown = __esm({
  "packages/daemon/src/command-center/actions/handlers/daemon-shutdown.ts"() {
    "use strict";
    init_errors3();
    shutdownBackend = null;
    daemonInstanceId = null;
    shutdownInProgress = false;
  }
});

// packages/daemon/src/lib/active-projects.ts
function setActivationBackend(next) {
  backend = next;
  active.clear();
}
async function activateProject(name, options = {}) {
  if (active.has(name) && !options.orchestrate) return;
  if (!backend) {
    throw new Error("No active-project backend is registered");
  }
  await backend.activateProject(name, options);
  active.add(name);
}
var backend, active;
var init_active_projects = __esm({
  "packages/daemon/src/lib/active-projects.ts"() {
    "use strict";
    backend = null;
    active = /* @__PURE__ */ new Set();
  }
});

// packages/daemon/src/send.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { resolve as resolve21, join as join26 } from "node:path";
import { existsSync as existsSync28, mkdirSync as mkdirSync19, writeFileSync as writeFileSync18 } from "node:fs";
function writeDispatchFile(dir, paneId, message) {
  if (message.length <= LONG_MESSAGE_THRESHOLD) return null;
  const dispatchDir = join26(dir, ".tasks", "dispatch");
  if (!existsSync28(dispatchDir)) mkdirSync19(dispatchDir, { recursive: true });
  const paneSlug = paneId.replace("%", "");
  const filename = `send-${paneSlug}-${Date.now()}-${randomUUID2().slice(0, 8)}.md`;
  const filePath = join26(dispatchDir, filename);
  writeFileSync18(filePath, message);
  return { filePath, triggerCmd: `Read and execute: .tasks/dispatch/${filename}` };
}
function resolvePane(panes, target) {
  if (target.startsWith("%")) {
    return panes.find((p) => p.id === target) ?? null;
  }
  const byName = panes.find((p) => p.name === target);
  if (byName) return byName;
  const byTitle = panes.find((p) => p.title === target);
  if (byTitle) return byTitle;
  const lower = target.toLowerCase();
  if (["lead", "teammate", "planner"].includes(lower)) {
    const byRole = panes.find((p) => p.role === lower);
    if (byRole) return byRole;
  }
  const byPattern = panes.find((p) => p.title.toLowerCase().includes(lower));
  if (byPattern) return byPattern;
  return null;
}
function prepareMessage(message, busyStatus) {
  if (busyStatus === "agent") {
    return message.replace(/\n+/g, " ").trim();
  }
  return message;
}
function deliverMessage(opts) {
  const { session, target, noEnter, dir } = opts;
  const state = getSessionState(session);
  if (!state.running) {
    throw new IdeError(`Session "${session}" is not running`, {
      code: "SESSION_NOT_FOUND"
    });
  }
  const panes = listSessionPanes(session);
  const pane = resolvePane(panes, target);
  if (!pane) {
    const available = panes.map((p) => {
      const label = p.name ?? p.title;
      return `  ${p.id}  ${label}${p.role ? ` (${p.role})` : ""}`;
    }).join("\n");
    throw new IdeError(`Pane "${target}" not found.

Available panes:
${available}`, {
      code: "PANE_NOT_FOUND"
    });
  }
  const busyStatus = getPaneBusyStatus(session, pane.id);
  const message = prepareMessage(opts.message, busyStatus);
  let sentViaFile = false;
  if (noEnter) {
    sendText(session, pane.id, message);
  } else {
    const dispatch = dir ? writeDispatchFile(dir, pane.id, message) : null;
    if (dispatch) {
      sendCommand(session, pane.id, dispatch.triggerCmd);
      sentViaFile = true;
    } else {
      sendCommand(session, pane.id, message);
    }
  }
  return {
    ok: true,
    session,
    target: {
      paneId: pane.id,
      name: pane.name,
      title: pane.title,
      role: pane.role
    },
    message,
    busyStatus,
    sentViaFile,
    ...busyStatus === "agent" ? { warning: "agent_busy" } : {}
  };
}
async function send(targetDir, opts) {
  const dir = resolve21(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);
  const { json: json2, to: target, message: rawMessage, noEnter } = opts;
  if (!target) {
    throw new IdeError("Missing target. Usage: tmux-ide send <target> <message>", {
      code: "USAGE"
    });
  }
  if (!rawMessage) {
    throw new IdeError("Missing message. Usage: tmux-ide send <target> <message>", {
      code: "USAGE"
    });
  }
  const result = deliverMessage({ session, target, message: rawMessage, noEnter, dir });
  const { message, busyStatus } = result;
  const pane = result.target;
  if (json2) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = pane.name ?? pane.title;
  const preview = message.length > 60 ? message.slice(0, 60) + "..." : message;
  console.log(`Sent to "${label}" (${pane.paneId}): ${preview}`);
  if (busyStatus === "agent") {
    console.log("Warning: agent appears busy. Message sent anyway.");
  }
}
var LONG_MESSAGE_THRESHOLD;
var init_send = __esm({
  "packages/daemon/src/send.ts"() {
    "use strict";
    init_src2();
    init_pane_comms();
    init_errors2();
    init_config_context();
    LONG_MESSAGE_THRESHOLD = 150;
  }
});

// packages/daemon/src/lib/log.ts
function getLogBuffer() {
  return logBuffer.slice();
}
function subscribeLogs(handler) {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}
function writeStructuredLog(level, component, message, data) {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    component,
    msg: message,
    ...data ? { data } : {}
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  for (const sub of subscribers) {
    try {
      sub(entry);
    } catch (err) {
      process.stderr.write(
        `[log.ts] subscriber threw: ${err instanceof Error ? err.message : String(err)}
`
      );
    }
  }
  const wire = {
    ts: entry.ts,
    level: entry.level,
    component: entry.component,
    msg: entry.msg
  };
  if (data) Object.assign(wire, data);
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(wire) + "\n");
}
var LEVEL_RANK, minLevel, LOG_BUFFER_SIZE, logBuffer, subscribers, logger;
var init_log = __esm({
  "packages/daemon/src/lib/log.ts"() {
    "use strict";
    LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
    minLevel = process.env.LOG_LEVEL ?? "info";
    LOG_BUFFER_SIZE = 1e3;
    logBuffer = [];
    subscribers = /* @__PURE__ */ new Set();
    logger = {
      debug: (component, msg, data) => writeStructuredLog("debug", component, msg, data),
      info: (component, msg, data) => writeStructuredLog("info", component, msg, data),
      warn: (component, msg, data) => writeStructuredLog("warn", component, msg, data),
      error: (component, msg, data) => writeStructuredLog("error", component, msg, data)
    };
  }
});

// packages/daemon/src/command-center/schemas.ts
import { z as z28 } from "zod";
var updateTaskSchema, createTaskSchema, savePlanSchema, savePlanContentSchema, sendCommandSchema, createMilestoneSchema, updateMilestoneSchema, updateAssertionSchema, triggerResearchSchema, launchSchema, stopSchema, skillNameRegex, createSkillSchema, updateSkillSchema;
var init_schemas = __esm({
  "packages/daemon/src/command-center/schemas.ts"() {
    "use strict";
    updateTaskSchema = z28.object({
      status: z28.enum(["todo", "in-progress", "review", "done"]).optional(),
      assignee: z28.string().optional(),
      title: z28.string().optional(),
      description: z28.string().optional(),
      priority: z28.number().optional()
    });
    createTaskSchema = z28.object({
      title: z28.string().trim().min(1, "Title is required"),
      description: z28.string().optional(),
      priority: z28.number().optional(),
      goal: z28.string().optional(),
      tags: z28.array(z28.string()).optional()
    });
    savePlanSchema = z28.object({
      content: z28.string().max(1e6, "Plan content is too large")
    });
    savePlanContentSchema = z28.object({
      content: z28.string().max(1e6, "Plan content is too large")
    });
    sendCommandSchema = z28.object({
      target: z28.string().min(1, "Target pane is required"),
      message: z28.string().min(1, "Message is required"),
      noEnter: z28.boolean().optional()
    });
    createMilestoneSchema = z28.object({
      title: z28.string().trim().min(1, "Title is required"),
      sequence: z28.number().int().positive(),
      description: z28.string().optional()
    });
    updateMilestoneSchema = z28.object({
      status: z28.enum(["locked", "active", "done", "validating"]).optional(),
      title: z28.string().optional(),
      description: z28.string().optional()
    });
    updateAssertionSchema = z28.object({
      status: z28.enum(["pending", "passing", "failing", "blocked"]),
      evidence: z28.string().optional(),
      verifiedBy: z28.string().optional()
    });
    triggerResearchSchema = z28.object({
      type: z28.string().trim().min(1, "Research type is required")
    });
    launchSchema = z28.object({
      attach: z28.boolean().optional()
    }).optional();
    stopSchema = z28.object({}).optional();
    skillNameRegex = /^[A-Za-z0-9._ -]+$/;
    createSkillSchema = z28.object({
      name: z28.string().trim().min(1, "Skill name is required").regex(
        skillNameRegex,
        "Skill name may only contain letters, digits, dot, dash, underscore, or space"
      ),
      role: z28.string().trim().optional(),
      description: z28.string().optional(),
      specialties: z28.array(z28.string()).optional(),
      body: z28.string().optional()
    });
    updateSkillSchema = z28.object({
      role: z28.string().trim().optional(),
      description: z28.string().optional(),
      specialties: z28.array(z28.string()).optional(),
      body: z28.string().optional()
    });
  }
});

// packages/daemon/src/lib/terminals-store.ts
import { existsSync as existsSync29, mkdirSync as mkdirSync20, readFileSync as readFileSync22, renameSync as renameSync11, writeFileSync as writeFileSync19 } from "node:fs";
import { dirname as dirname26, join as join27 } from "node:path";
function path(dir) {
  return join27(dir, TERMINALS_FILE);
}
function ensureDir(dir) {
  mkdirSync20(dirname26(path(dir)), { recursive: true });
}
function loadTerminals(dir) {
  const file = path(dir);
  if (!existsSync29(file)) return [];
  try {
    const body = readFileSync22(file, "utf-8");
    const parsed = JSON.parse(body);
    if (!parsed.terminals || !Array.isArray(parsed.terminals)) return [];
    return parsed.terminals.filter((t) => isTerminal(t)).map((t) => ({ ...t }));
  } catch {
    return [];
  }
}
function isTerminal(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return typeof v.id === "string" && SAFE_ID.test(v.id) && typeof v.projectId === "string" && typeof v.scopeId === "string" && typeof v.name === "string" && (v.kind === "shell" || v.kind === "setup" || v.kind === "run" || v.kind === "teardown") && typeof v.createdAt === "string" && typeof v.updatedAt === "string";
}
function writeAtomic(dir, terminals) {
  ensureDir(dir);
  const file = path(dir);
  const tmp = `${file}.tmp`;
  writeFileSync19(tmp, JSON.stringify({ terminals }, null, 2) + "\n");
  renameSync11(tmp, file);
}
function upsertTerminal(dir, input) {
  if (!SAFE_ID.test(input.id)) {
    throw new Error(`invalid terminal id "${input.id}"`);
  }
  const existing = loadTerminals(dir);
  const idx = existing.findIndex((t) => t.id === input.id);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const next = {
    id: input.id,
    projectId: input.projectId,
    scopeId: input.scopeId,
    name: input.name,
    kind: input.kind,
    createdAt: existing[idx]?.createdAt ?? now,
    updatedAt: now,
    ...input.scripted ? { scripted: true } : {}
  };
  if (idx === -1) existing.push(next);
  else existing[idx] = next;
  writeAtomic(dir, existing);
  return next;
}
function renameTerminal(dir, id, name) {
  const all = loadTerminals(dir);
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  const next = {
    ...all[idx],
    name: trimmed,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  all[idx] = next;
  writeAtomic(dir, all);
  return next;
}
function deleteTerminal(dir, id) {
  const all = loadTerminals(dir);
  const next = all.filter((t) => t.id !== id);
  if (next.length === all.length) return false;
  writeAtomic(dir, next);
  return true;
}
var TERMINALS_FILE, SAFE_ID;
var init_terminals_store = __esm({
  "packages/daemon/src/lib/terminals-store.ts"() {
    "use strict";
    TERMINALS_FILE = ".tmux-ide/terminals.json";
    SAFE_ID = /^[A-Za-z0-9_-]+$/u;
  }
});

// packages/daemon/src/lib/auth/auth-service.ts
var auth_service_exports = {};
__export(auth_service_exports, {
  AuthService: () => AuthService
});
import * as crypto2 from "node:crypto";
import { readFileSync as readFileSync23, existsSync as existsSync30 } from "node:fs";
import { join as join28 } from "node:path";
import { homedir as homedir18 } from "node:os";
function base64url(buf) {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64url");
}
function decodeBase64url(str) {
  return Buffer.from(str, "base64url");
}
function signJwt(payload, secret, expiresInSec) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1e3);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const segments = [base64url(JSON.stringify(header)), base64url(JSON.stringify(body))];
  const sigInput = segments.join(".");
  const sig = crypto2.createHmac("sha256", secret).update(sigInput).digest();
  segments.push(base64url(sig));
  return segments.join(".");
}
function verifyJwt(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false };
  const sigInput = parts[0] + "." + parts[1];
  const expected = crypto2.createHmac("sha256", secret).update(sigInput).digest();
  const actual = decodeBase64url(parts[2]);
  if (expected.length !== actual.length || !crypto2.timingSafeEqual(expected, actual)) {
    return { valid: false };
  }
  try {
    const payload = JSON.parse(decodeBase64url(parts[1]).toString());
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1e3)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}
var TOKEN_EXPIRY_SEC, CHALLENGE_TIMEOUT_MS, AuthService;
var init_auth_service = __esm({
  "packages/daemon/src/lib/auth/auth-service.ts"() {
    "use strict";
    init_log();
    TOKEN_EXPIRY_SEC = 24 * 60 * 60;
    CHALLENGE_TIMEOUT_MS = 5 * 60 * 1e3;
    AuthService = class {
      challenges = /* @__PURE__ */ new Map();
      jwtSecret;
      cleanupTimer;
      constructor(secret) {
        this.jwtSecret = secret ?? process.env.JWT_SECRET ?? crypto2.randomBytes(64).toString("hex");
        this.cleanupTimer = setInterval(() => this.cleanupExpiredChallenges(), 6e4);
      }
      dispose() {
        clearInterval(this.cleanupTimer);
      }
      cleanupExpiredChallenges() {
        const now = Date.now();
        for (const [id, ch] of this.challenges) {
          if (now - ch.timestamp > CHALLENGE_TIMEOUT_MS) {
            this.challenges.delete(id);
          }
        }
      }
      // ---- JWT ----------------------------------------------------------------
      generateToken(userId) {
        return signJwt({ userId }, this.jwtSecret, TOKEN_EXPIRY_SEC);
      }
      verifyToken(token) {
        const result = verifyJwt(token, this.jwtSecret);
        if (!result.valid) return { valid: false };
        return { valid: true, userId: result.payload.userId };
      }
      // ---- SSH challenge-response --------------------------------------------
      createChallenge(userId) {
        const challengeId = crypto2.randomUUID();
        const challenge = crypto2.randomBytes(32);
        this.challenges.set(challengeId, {
          challengeId,
          challenge,
          timestamp: Date.now(),
          userId
        });
        return { challengeId, challenge: challenge.toString("base64") };
      }
      async authenticateWithSSHKey(auth) {
        const challenge = this.challenges.get(auth.challengeId);
        if (!challenge) {
          return { success: false, error: "Invalid or expired challenge" };
        }
        const sigBuf = Buffer.from(auth.signature, "base64");
        if (!this.verifySSHSignature(challenge.challenge, sigBuf, auth.publicKey)) {
          return { success: false, error: "Invalid SSH key signature" };
        }
        const authorized = this.checkSSHKeyAuthorization(challenge.userId, auth.publicKey);
        if (!authorized) {
          return { success: false, error: "SSH key not authorized for this user" };
        }
        this.challenges.delete(auth.challengeId);
        const token = this.generateToken(challenge.userId);
        return { success: true, userId: challenge.userId, token };
      }
      // ---- SSH helpers -------------------------------------------------------
      verifySSHSignature(challenge, signature, publicKeyStr) {
        try {
          const parts = publicKeyStr.trim().split(" ");
          if (parts.length < 2) return false;
          const keyType = parts[0];
          const keyData = parts[1];
          if (keyType !== "ssh-ed25519") {
            logger.warn("auth", `Unsupported key type: ${keyType}`);
            return false;
          }
          if (signature.length !== 64) return false;
          const sshBuf = Buffer.from(keyData, "base64");
          let offset = 0;
          const algLen = sshBuf.readUInt32BE(offset);
          offset += 4 + algLen;
          const keyLen = sshBuf.readUInt32BE(offset);
          offset += 4;
          if (keyLen !== 32) return false;
          const rawPub = sshBuf.subarray(offset, offset + 32);
          const pubKey = crypto2.createPublicKey({
            key: Buffer.concat([
              Buffer.from([48, 42]),
              Buffer.from([48, 5]),
              Buffer.from([6, 3, 43, 101, 112]),
              Buffer.from([3, 33, 0]),
              rawPub
            ]),
            format: "der",
            type: "spki"
          });
          return crypto2.verify(null, challenge, pubKey, signature);
        } catch (err) {
          logger.error("auth", "SSH signature verification failed", {
            error: String(err)
          });
          return false;
        }
      }
      checkSSHKeyAuthorization(userId, publicKey) {
        try {
          const home = userId === process.env.USER ? homedir18() : `/home/${userId}`;
          const authKeysPath = join28(home, ".ssh", "authorized_keys");
          if (!existsSync30(authKeysPath)) return false;
          const authorizedKeys = readFileSync23(authKeysPath, "utf-8");
          const parts = publicKey.trim().split(" ");
          const keyData = parts.length > 1 ? parts[1] : parts[0];
          return authorizedKeys.includes(keyData);
        } catch {
          return false;
        }
      }
      getCurrentUser() {
        return process.env.USER ?? process.env.USERNAME ?? "unknown";
      }
    };
  }
});

// packages/daemon/src/lib/auth/middleware.ts
function authMiddleware(authService, config2) {
  return async (c, next) => {
    if (config2.method === "none") {
      return next();
    }
    const path2 = new URL(c.req.url).pathname;
    if (path2 === "/health" || path2 === "/healthz" || path2 === "/identity" || path2.startsWith("/api/auth/")) {
      return next();
    }
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }
    const token = authHeader.slice(7);
    const result = authService.verifyToken(token);
    if (!result.valid) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    c.set("userId", result.userId);
    return next();
  };
}
var init_middleware = __esm({
  "packages/daemon/src/lib/auth/middleware.ts"() {
    "use strict";
  }
});

// packages/daemon/src/command-center/actions/handlers/_resolve-project.ts
function resolveProject2(name, deps2 = {}) {
  const lookup = deps2.getProject ?? getProject;
  const project = lookup(name);
  if (project) {
    return {
      name: project.name,
      dir: project.dir,
      sessionName: project.name,
      fromLiveSession: false
    };
  }
  const hasSession2 = deps2.hasSession ?? hasSession;
  if (hasSession2(name)) {
    const cwd = (deps2.getSessionCwd ?? getSessionCwd)(name);
    if (cwd) {
      return { name, dir: cwd, sessionName: name, fromLiveSession: true };
    }
  }
  throw new ActionError({
    code: "project_not_found",
    message: `Project "${name}" not found in registry or as a live tmux session`,
    details: { name }
  });
}
var init_resolve_project = __esm({
  "packages/daemon/src/command-center/actions/handlers/_resolve-project.ts"() {
    "use strict";
    init_project_registry();
    init_src2();
    init_errors3();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-open-terminal.ts
function defaultTerminalTabId(sessionName) {
  return `${TERMINAL_TAB_ID_PREFIX}:${sessionName}:${TERMINAL_TAB_ID_SUFFIX}`;
}
async function projectOpenTerminalHandler(input, deps2 = {}) {
  const project = resolveProject2(input.name, deps2);
  const activateProject2 = deps2.activateProject ?? activateProject;
  await activateProject2(project.name);
  try {
    assertValidCwd2(project.dir, deps2.statCwd);
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw err;
  }
  const hasSession2 = deps2.hasSession ?? hasSession;
  const launch2 = deps2.launch ?? launch;
  let launched = false;
  if (!hasSession2(project.sessionName)) {
    try {
      await launch2(project.dir, { json: false, attach: false });
      launched = true;
    } catch (err) {
      throw new ActionError({
        code: "launch_failed",
        message: `Failed to launch session "${project.sessionName}": ${err.message ?? String(err)}`,
        details: { sessionName: project.sessionName, dir: project.dir },
        cause: err
      });
    }
  }
  return {
    sessionName: project.sessionName,
    cwd: project.dir,
    terminalTabId: defaultTerminalTabId(project.sessionName),
    launched
  };
}
var TERMINAL_TAB_ID_PREFIX, TERMINAL_TAB_ID_SUFFIX;
var init_project_open_terminal = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-open-terminal.ts"() {
    "use strict";
    init_src2();
    init_launch();
    init_active_projects();
    init_pty_bridge();
    init_errors3();
    init_resolve_project();
    TERMINAL_TAB_ID_PREFIX = "terminal";
    TERMINAL_TAB_ID_SUFFIX = "default";
  }
});

// packages/daemon/src/command-center/actions/handlers/project-activate.ts
async function projectActivateHandler(input, deps2 = {}) {
  const project = resolveProject2(input.name, deps2);
  const activateProject2 = deps2.activateProject ?? activateProject;
  try {
    await activateProject2(project.name);
  } catch (err) {
    throw new ActionError({
      code: "internal",
      message: `Failed to activate project "${project.name}": ${err.message ?? String(err)}`,
      details: { projectName: project.name },
      cause: err
    });
  }
  return { active: true, projectName: project.name };
}
var init_project_activate = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-activate.ts"() {
    "use strict";
    init_active_projects();
    init_errors3();
    init_resolve_project();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-launch.ts
async function ensureWorkspaceRegistered(name, sessionName, dir) {
  const reg = getDefaultWorkspaceRegistry();
  if (reg.has(name)) return;
  try {
    const facts = await resolveProjectConfigContext(dir);
    reg.add({
      name,
      sessionName,
      projectDir: dir,
      ideConfigPath: facts.ideConfigPath,
      configKind: facts.configKind,
      configPath: facts.configPath,
      hasWorkspaceConfig: facts.hasWorkspaceConfig
    });
  } catch {
  }
}
async function projectLaunchHandler(input, deps2 = {}) {
  const project = resolveProject2(input.name, deps2);
  const hasSession2 = deps2.hasSession ?? hasSession;
  if (hasSession2(project.sessionName)) {
    await ensureWorkspaceRegistered(project.name, project.sessionName, project.dir);
    return { sessionName: project.sessionName, started: false };
  }
  const launch2 = deps2.launch ?? launch;
  try {
    await launch2(project.dir, { json: false, attach: false });
  } catch (err) {
    throw new ActionError({
      code: "launch_failed",
      message: `Failed to launch session "${project.sessionName}": ${err.message ?? String(err)}`,
      details: { sessionName: project.sessionName, dir: project.dir },
      cause: err
    });
  }
  await ensureWorkspaceRegistered(project.name, project.sessionName, project.dir);
  return { sessionName: project.sessionName, started: true };
}
var init_project_launch = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-launch.ts"() {
    "use strict";
    init_src2();
    init_launch();
    init_errors3();
    init_resolve_project();
    init_workspace_registry();
    init_config_context();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-stop.ts
function defaultKillOrphanDaemons(_session) {
}
async function projectStopHandler(input, deps2 = {}) {
  const project = resolveProject2(input.name, deps2);
  const hasSession2 = deps2.hasSession ?? hasSession;
  if (!hasSession2(project.sessionName)) {
    return { sessionName: project.sessionName, stopped: false };
  }
  const stopSessionMonitor2 = deps2.stopSessionMonitor ?? stopSessionMonitor;
  const killSession2 = deps2.killSession ?? killSession;
  const killOrphanDaemons = deps2.killOrphanDaemons ?? defaultKillOrphanDaemons;
  try {
    stopSessionMonitor2(project.sessionName);
    killOrphanDaemons(project.sessionName);
    const result = killSession2(project.sessionName);
    return { sessionName: project.sessionName, stopped: result.stopped };
  } catch (err) {
    throw new ActionError({
      code: "stop_failed",
      message: `Failed to stop session "${project.sessionName}": ${err.message ?? String(err)}`,
      details: { sessionName: project.sessionName },
      cause: err
    });
  }
}
var init_project_stop = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-stop.ts"() {
    "use strict";
    init_src2();
    init_errors3();
    init_resolve_project();
  }
});

// packages/daemon/src/restart.ts
import { resolve as resolve22 } from "node:path";
async function restart(targetDir, { json: json2, attach: attach2 } = {}) {
  const dir = resolve22(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);
  stopSessionMonitor(session);
  const result = killSession(session);
  if (result.stopped) {
    console.log(`Stopped session "${session}"`);
  }
  await launch(dir, { json: json2, attach: attach2 });
}
var init_restart = __esm({
  "packages/daemon/src/restart.ts"() {
    "use strict";
    init_config_context();
    init_launch();
    init_src2();
  }
});

// packages/daemon/src/command-center/actions/handlers/project-restart.ts
async function projectRestartHandler(input, deps2 = {}) {
  const project = resolveProject2(input.name, deps2);
  const restart2 = deps2.restart ?? restart;
  try {
    await restart2(project.dir, { json: false, attach: false });
  } catch (err) {
    throw new ActionError({
      code: "launch_failed",
      message: `Failed to restart session "${project.sessionName}": ${err.message ?? String(err)}`,
      details: { sessionName: project.sessionName, dir: project.dir },
      cause: err
    });
  }
  return { sessionName: project.sessionName, restarted: true };
}
var init_project_restart = __esm({
  "packages/daemon/src/command-center/actions/handlers/project-restart.ts"() {
    "use strict";
    init_restart();
    init_errors3();
    init_resolve_project();
  }
});

// packages/daemon/src/command-center/actions/handlers/terminal-respawn.ts
function terminalRespawnHandler(input, deps2 = {}) {
  const registry = deps2.registry ?? defaultPtyBridgeRegistry;
  const bridge = registry.peek(input.terminalId);
  if (!bridge) {
    throw new ActionError({
      code: "terminal_not_found",
      message: `No running terminal bridge for id "${input.terminalId}"`,
      details: { terminalId: input.terminalId, sessionName: input.sessionName }
    });
  }
  if (!bridge.restartWith) {
    throw new ActionError({
      code: "internal",
      message: "Bridge does not support restartWith",
      details: { terminalId: input.terminalId }
    });
  }
  const cwd = resolveRespawnCwd(input, bridge, deps2.statCwd);
  const cols = deps2.cols ?? bridge.cols ?? DEFAULT_RESPAWN_COLS;
  const rows = deps2.rows ?? bridge.rows ?? DEFAULT_RESPAWN_ROWS;
  try {
    bridge.restartWith(cols, rows, { cwd });
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw new ActionError({
      code: "internal",
      message: `Failed to respawn terminal "${input.terminalId}": ${err.message ?? String(err)}`,
      details: { terminalId: input.terminalId },
      cause: err
    });
  }
  return { respawned: true, cwd };
}
function resolveRespawnCwd(input, bridge, statCwd) {
  if (input.cwd) {
    try {
      assertValidCwd2(input.cwd, statCwd);
    } catch (err) {
      if (err instanceof TerminalCwdError) {
        throw actionErrorFromCwdError(err);
      }
      throw err;
    }
    return input.cwd;
  }
  const last = bridge.getCwd?.() ?? null;
  if (!last) {
    throw new ActionError({
      code: "internal",
      message: "Cannot respawn terminal without an explicit cwd: bridge has no recorded cwd",
      details: { terminalId: input.terminalId }
    });
  }
  try {
    assertValidCwd2(last, statCwd);
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw err;
  }
  return last;
}
var DEFAULT_RESPAWN_COLS, DEFAULT_RESPAWN_ROWS;
var init_terminal_respawn = __esm({
  "packages/daemon/src/command-center/actions/handlers/terminal-respawn.ts"() {
    "use strict";
    init_ws_route();
    init_pty_bridge();
    init_errors3();
    DEFAULT_RESPAWN_COLS = 80;
    DEFAULT_RESPAWN_ROWS = 24;
  }
});

// packages/daemon/src/command-center/actions/handlers/terminal-stop.ts
function terminalStopHandler(input, deps2 = {}) {
  const registry = deps2.registry ?? defaultPtyBridgeRegistry;
  const ok2 = registry.delete(input.terminalId);
  if (!ok2) {
    throw new ActionError({
      code: "terminal_not_found",
      message: `No terminal bridge for id "${input.terminalId}"`,
      details: { terminalId: input.terminalId, sessionName: input.sessionName }
    });
  }
  return { stopped: true };
}
var init_terminal_stop = __esm({
  "packages/daemon/src/command-center/actions/handlers/terminal-stop.ts"() {
    "use strict";
    init_ws_route();
    init_errors3();
  }
});

// packages/daemon/src/command-center/actions/handlers/_project-context.ts
async function resolveProjectContext(input, deps2 = {}) {
  if (input.projectName) {
    const project = resolveProject2(input.projectName, deps2);
    return { dir: project.dir, sessionName: project.sessionName };
  }
  const dir = deps2.cwd ?? process.cwd();
  const { sessionName } = await resolveProjectConfigContext(dir);
  return { dir, sessionName };
}
var init_project_context = __esm({
  "packages/daemon/src/command-center/actions/handlers/_project-context.ts"() {
    "use strict";
    init_resolve_project();
    init_config_context();
  }
});

// packages/daemon/src/command-center/actions/handlers/config-actions.ts
function workspaceWriteActionErrorCode(code) {
  if (code === "CONFIG_EXISTS") return "config_exists";
  if (code === "WORKSPACE_WRITE_FAILED") return "workspace_write_failed";
  return "config_validation_failed";
}
async function mutateConfigAction(input, deps2, fn) {
  const context = await resolveProjectContext(input, deps2);
  const configContext = await resolveProjectConfigContext(context.dir);
  if (!configContext.configExists) {
    throw new ActionError({
      code: "config_missing",
      message: "workspace config was not found",
      details: { dir: context.dir }
    });
  }
  try {
    const result = fn(configContext.configWriteRoot);
    (deps2.broadcastConfigChanged ?? broadcastConfigChanged)(context.sessionName);
    return result;
  } catch (err) {
    if (err instanceof UnsupportedLegacyConfigMutationError) {
      throw new ActionError({
        code: "legacy_config_mutation_unsupported",
        message: err.message,
        details: { diagnostics: err.diagnostics },
        cause: err
      });
    }
    if (err instanceof WorkspaceConfigWriteError) {
      throw new ActionError({
        code: workspaceWriteActionErrorCode(err.code),
        message: err.message,
        details: { path: err.path },
        cause: err
      });
    }
    const message = err.message ?? String(err);
    throw new ActionError({
      code: message.toLowerCase().includes("path") ? "config_path_invalid" : "config_validation_failed",
      message,
      cause: err
    });
  }
}
async function configSetHandler(input, deps2 = {}) {
  const config2 = await mutateConfigAction(
    input,
    deps2,
    (dir) => configSetValue(dir, input.path, input.value)
  );
  return { config: config2 };
}
async function configAddPaneHandler(input, deps2 = {}) {
  const pane = {
    title: input.title,
    command: input.command,
    type: input.type,
    target: input.target,
    dir: input.dir,
    size: input.size,
    focus: input.focus,
    env: input.env,
    role: input.role,
    task: input.task,
    specialty: input.specialty,
    skill: input.skill
  };
  const config2 = await mutateConfigAction(
    input,
    deps2,
    (dir) => configAddPane(dir, input.rowIndex, pane)
  );
  return { config: config2 };
}
async function configRemovePaneHandler(input, deps2 = {}) {
  const config2 = (await mutateConfigAction(
    input,
    deps2,
    (dir) => configRemovePane(dir, input.rowIndex, input.paneIndex)
  )).config;
  return { config: config2 };
}
async function configAddRowHandler(input, deps2 = {}) {
  const config2 = await mutateConfigAction(input, deps2, (dir) => configAddRow(dir, input.size));
  return { config: config2 };
}
async function configEnableTeamHandler(input, deps2 = {}) {
  const config2 = await mutateConfigAction(input, deps2, (dir) => configEnableTeam(dir, input.name));
  return { config: config2 };
}
async function configDisableTeamHandler(input, deps2 = {}) {
  const config2 = await mutateConfigAction(input, deps2, (dir) => configDisableTeam(dir));
  return { config: config2 };
}
var init_config_actions = __esm({
  "packages/daemon/src/command-center/actions/handlers/config-actions.ts"() {
    "use strict";
    init_config();
    init_ws_events();
    init_errors3();
    init_project_context();
    init_resolved_config();
    init_config_context();
  }
});

// packages/daemon/src/command-center/actions/registry.ts
function getLooseActionEntry(name) {
  return actionRegistry[name];
}
var actionRegistry;
var init_registry2 = __esm({
  "packages/daemon/src/command-center/actions/registry.ts"() {
    "use strict";
    init_contract();
    init_project_open_terminal();
    init_project_activate();
    init_project_launch();
    init_project_stop();
    init_project_restart();
    init_terminal_respawn();
    init_terminal_stop();
    init_config_actions();
    init_app_set_remote_access();
    init_daemon_shutdown();
    actionRegistry = {
      "project.openTerminal": {
        inputSchema: ActionContractsZ["project.openTerminal"].input,
        resultSchema: ActionContractsZ["project.openTerminal"].result,
        handler: projectOpenTerminalHandler
      },
      "project.launch": {
        inputSchema: ActionContractsZ["project.launch"].input,
        resultSchema: ActionContractsZ["project.launch"].result,
        handler: projectLaunchHandler
      },
      "project.stop": {
        inputSchema: ActionContractsZ["project.stop"].input,
        resultSchema: ActionContractsZ["project.stop"].result,
        handler: projectStopHandler
      },
      "project.restart": {
        inputSchema: ActionContractsZ["project.restart"].input,
        resultSchema: ActionContractsZ["project.restart"].result,
        handler: projectRestartHandler
      },
      "project.activate": {
        inputSchema: ActionContractsZ["project.activate"].input,
        resultSchema: ActionContractsZ["project.activate"].result,
        handler: projectActivateHandler
      },
      "terminal.respawn": {
        inputSchema: ActionContractsZ["terminal.respawn"].input,
        resultSchema: ActionContractsZ["terminal.respawn"].result,
        handler: terminalRespawnHandler
      },
      "terminal.stop": {
        inputSchema: ActionContractsZ["terminal.stop"].input,
        resultSchema: ActionContractsZ["terminal.stop"].result,
        handler: terminalStopHandler
      },
      "config.set": {
        inputSchema: ActionContractsZ["config.set"].input,
        resultSchema: ActionContractsZ["config.set"].result,
        handler: configSetHandler
      },
      "config.addPane": {
        inputSchema: ActionContractsZ["config.addPane"].input,
        resultSchema: ActionContractsZ["config.addPane"].result,
        handler: configAddPaneHandler
      },
      "config.removePane": {
        inputSchema: ActionContractsZ["config.removePane"].input,
        resultSchema: ActionContractsZ["config.removePane"].result,
        handler: configRemovePaneHandler
      },
      "config.addRow": {
        inputSchema: ActionContractsZ["config.addRow"].input,
        resultSchema: ActionContractsZ["config.addRow"].result,
        handler: configAddRowHandler
      },
      "config.enableTeam": {
        inputSchema: ActionContractsZ["config.enableTeam"].input,
        resultSchema: ActionContractsZ["config.enableTeam"].result,
        handler: configEnableTeamHandler
      },
      "config.disableTeam": {
        inputSchema: ActionContractsZ["config.disableTeam"].input,
        resultSchema: ActionContractsZ["config.disableTeam"].result,
        handler: configDisableTeamHandler
      },
      "app.setRemoteAccess": {
        inputSchema: ActionContractsZ["app.setRemoteAccess"].input,
        resultSchema: ActionContractsZ["app.setRemoteAccess"].result,
        handler: appSetRemoteAccessHandler
      },
      "daemon.shutdown": {
        inputSchema: ActionContractsZ["daemon.shutdown"].input,
        resultSchema: ActionContractsZ["daemon.shutdown"].result,
        handler: daemonShutdownHandler
      }
    };
  }
});

// packages/daemon/src/lib/command-registry.ts
function issues(error) {
  return JSON.parse(JSON.stringify({ issues: error.issues }));
}
function recoverCommandId(value) {
  if (!value || typeof value !== "object" || !("id" in value)) return void 0;
  const id = value.id;
  const parsed = CommandIdSchemaZ.safeParse(id);
  return parsed.success ? parsed.data : void 0;
}
function immutableDescriptor(rawDescriptor) {
  const descriptor2 = CommandDescriptorSchemaZ.parse(rawDescriptor);
  return Object.freeze({
    ...descriptor2,
    schemas: Object.freeze({ ...descriptor2.schemas })
  });
}
var CommandRegistry;
var init_command_registry = __esm({
  "packages/daemon/src/lib/command-registry.ts"() {
    "use strict";
    init_src();
    CommandRegistry = class {
      definitions = /* @__PURE__ */ new Map();
      constructor(definitions = []) {
        for (const definition of definitions) this.register(definition);
      }
      register(definition) {
        const descriptor2 = immutableDescriptor(definition.descriptor);
        if (this.definitions.has(descriptor2.id)) {
          throw new Error(`duplicate command id: ${descriptor2.id}`);
        }
        this.definitions.set(descriptor2.id, {
          ...definition,
          descriptor: Object.freeze(descriptor2)
        });
      }
      has(id) {
        return this.definitions.has(id);
      }
      descriptors() {
        return Object.freeze([...this.definitions.values()].map((definition) => definition.descriptor));
      }
      resolve(rawInvocation, context) {
        const invocationResult = CommandInvocationSchemaZ.safeParse(rawInvocation);
        if (!invocationResult.success) {
          const commandId = recoverCommandId(rawInvocation);
          return {
            ok: false,
            error: {
              code: "invalid-invocation",
              message: "Command invocation failed envelope validation",
              ...commandId ? { commandId } : {},
              details: issues(invocationResult.error)
            }
          };
        }
        const invocation = invocationResult.data;
        const definition = this.definitions.get(invocation.id);
        if (!definition) {
          return {
            ok: false,
            error: {
              code: "unknown-command",
              commandId: invocation.id,
              message: `Unknown command: ${invocation.id}`
            }
          };
        }
        const inputResult = definition.inputSchema.safeParse(invocation.args);
        if (!inputResult.success) {
          return {
            ok: false,
            error: {
              code: "invalid-input",
              commandId: invocation.id,
              message: "Command input failed schema validation",
              details: issues(inputResult.error)
            }
          };
        }
        const availability = CommandAvailabilitySchemaZ.parse(
          definition.availability?.(context, inputResult.data) ?? { available: true }
        );
        if (!availability.available) {
          return {
            ok: false,
            error: {
              code: "unavailable",
              commandId: invocation.id,
              message: availability.reason
            }
          };
        }
        return {
          ok: true,
          command: {
            descriptor: definition.descriptor,
            invocation,
            input: inputResult.data,
            resultSchema: definition.resultSchema
          }
        };
      }
    };
  }
});

// packages/daemon/src/command-center/actions/command-definitions.ts
function actionDescriptor(name) {
  const metadata = ACTION_COMMAND_METADATA[name];
  return Object.freeze({
    version: COMMAND_PROTOCOL_VERSION,
    id: name,
    owner: "daemon",
    label: metadata.label,
    category: metadata.category,
    schemas: Object.freeze({
      input: `${name}.input.v1`,
      result: `${name}.result.v1`
    }),
    dangerous: metadata.dangerous === true,
    // Existing HTTP/CLI compatibility paths do not add interactive prompts.
    confirmation: "none"
  });
}
var ACTION_COMMAND_METADATA, DAEMON_ACTION_COMMAND_DEFINITIONS, daemonActionCommandRegistry;
var init_command_definitions = __esm({
  "packages/daemon/src/command-center/actions/command-definitions.ts"() {
    "use strict";
    init_src();
    init_command_registry();
    ACTION_COMMAND_METADATA = {
      "project.openTerminal": { label: "Open project terminal", category: "project" },
      "project.launch": { label: "Launch project", category: "project" },
      "project.stop": { label: "Stop project", category: "project", dangerous: true },
      "project.restart": { label: "Restart project", category: "project", dangerous: true },
      "project.activate": { label: "Activate project", category: "project" },
      "terminal.respawn": { label: "Respawn terminal", category: "terminal" },
      "terminal.stop": { label: "Stop terminal", category: "terminal", dangerous: true },
      "config.set": { label: "Set configuration value", category: "configuration" },
      "config.addPane": { label: "Add configuration pane", category: "configuration" },
      "config.removePane": {
        label: "Remove configuration pane",
        category: "configuration",
        dangerous: true
      },
      "config.addRow": { label: "Add configuration row", category: "configuration" },
      "config.enableTeam": { label: "Enable legacy team configuration", category: "compatibility" },
      "config.disableTeam": {
        label: "Disable legacy team configuration",
        category: "compatibility"
      },
      "app.setRemoteAccess": { label: "Set remote access", category: "application" },
      "daemon.shutdown": { label: "Shut down daemon", category: "daemon", dangerous: true }
    };
    DAEMON_ACTION_COMMAND_DEFINITIONS = Object.freeze(
      ACTION_NAMES.map(
        (name) => Object.freeze({
          descriptor: actionDescriptor(name),
          inputSchema: ActionContractsZ[name].input,
          resultSchema: ActionContractsZ[name].result
        })
      )
    );
    daemonActionCommandRegistry = new CommandRegistry(DAEMON_ACTION_COMMAND_DEFINITIONS);
  }
});

// packages/daemon/src/command-center/actions/dispatcher.ts
function errorEnvelope(err) {
  return { ok: false, error: err.toEnvelope() };
}
function zodErrorEnvelope(err) {
  return {
    ok: false,
    error: {
      code: "validation_failed",
      message: "Input failed schema validation",
      details: { issues: err.issues }
    }
  };
}
function outputZodErrorEnvelope(err) {
  console.error("[actions] handler output failed schema validation", err.issues);
  return {
    ok: false,
    error: {
      code: "internal",
      message: "Handler returned an invalid result",
      details: { issues: err.issues }
    }
  };
}
function createActionDispatcher(deps2 = {}) {
  const broadcast = deps2.broadcast ?? broadcastActionComplete;
  return async function dispatcher(c) {
    const name = c.req.param("name");
    if (!name || !isActionName(name)) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Unknown action: ${name}`,
            details: { name }
          }
        },
        404
      );
    }
    let body;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json(
        {
          ok: false,
          error: {
            code: "validation_failed",
            message: `Invalid JSON body: ${err.message ?? String(err)}`
          }
        },
        400
      );
    }
    const actionName = name;
    const entry = getLooseActionEntry(actionName);
    const inputParsed = entry.inputSchema.safeParse(body);
    if (!inputParsed.success) {
      return c.json(zodErrorEnvelope(inputParsed.error), 200);
    }
    const commandResolution = daemonActionCommandRegistry.resolve(
      {
        version: COMMAND_PROTOCOL_VERSION,
        id: actionName,
        source: { kind: "http" },
        args: inputParsed.data
      },
      void 0
    );
    if (!commandResolution.ok) {
      console.error("[actions] command adapter rejected action-schema-validated input", {
        actionName,
        error: commandResolution.error
      });
      return c.json(
        {
          ok: false,
          error: {
            code: "internal",
            message: "Action command adapter rejected validated input"
          }
        },
        200
      );
    }
    let result;
    try {
      result = await entry.handler(commandResolution.command.input);
    } catch (err) {
      const wrapped = wrapInternalError(err);
      return c.json(errorEnvelope(wrapped), 200);
    }
    const outputParsed = (commandResolution.command.resultSchema ?? entry.resultSchema).safeParse(
      result
    );
    if (!outputParsed.success) {
      return c.json(outputZodErrorEnvelope(outputParsed.error), 200);
    }
    try {
      broadcast(actionName, outputParsed.data);
    } catch (err) {
      console.error("[actions] broadcast failed:", err);
    }
    return c.json({ ok: true, result: outputParsed.data }, 200);
  };
}
var init_dispatcher = __esm({
  "packages/daemon/src/command-center/actions/dispatcher.ts"() {
    "use strict";
    init_contract();
    init_errors3();
    init_registry2();
    init_ws_events();
    init_command_definitions();
  }
});

// packages/daemon/src/lib/project-init-runner.ts
import { spawn as spawn6 } from "node:child_process";
function lineStreamer(onChunk) {
  let pending = "";
  return {
    push(text) {
      pending += text;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        onChunk(line);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending.length === 0) return;
      onChunk(pending.replace(/\r$/, ""));
      pending = "";
    }
  };
}
async function runInit(options) {
  const spawnFn = options.spawnFn ?? spawn6;
  const command2 = options.command ?? "tmux-ide";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["init"];
  if (options.template) args.push("--template", options.template);
  const child = spawnFn(command2, args, { cwd: options.cwd });
  const stderrStreamer = lineStreamer(options.onChunk);
  const stdoutStreamer = lineStreamer(options.onChunk);
  let stderrBuffer = "";
  child.stdout.setEncoding?.("utf-8");
  child.stderr.setEncoding?.("utf-8");
  child.stdout.on("data", (data) => {
    stdoutStreamer.push(typeof data === "string" ? data : data.toString("utf-8"));
  });
  child.stderr.on("data", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    stderrBuffer += text;
    stderrStreamer.push(text);
  });
  return new Promise((resolveResult, reject) => {
    let timer = null;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdoutStreamer.flush();
      stderrStreamer.flush();
      fn();
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      settle(() => reject(new ProjectInitTimeoutError(timeoutMs)));
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => {
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(() => resolveResult({ ok: true }));
      } else {
        settle(() => reject(new ProjectInitFailedError(code, stderrBuffer.trim())));
      }
    });
  });
}
var DEFAULT_TIMEOUT_MS, ProjectInitTimeoutError, ProjectInitFailedError;
var init_project_init_runner = __esm({
  "packages/daemon/src/lib/project-init-runner.ts"() {
    "use strict";
    DEFAULT_TIMEOUT_MS = 3e4;
    ProjectInitTimeoutError = class extends Error {
      timeoutMs;
      constructor(timeoutMs) {
        super(`tmux-ide init timed out after ${timeoutMs}ms`);
        this.name = "ProjectInitTimeoutError";
        this.timeoutMs = timeoutMs;
      }
    };
    ProjectInitFailedError = class extends Error {
      exitCode;
      stderr;
      constructor(exitCode, stderr) {
        super(`tmux-ide init exited with code ${exitCode ?? "(killed)"}: ${stderr || "no stderr"}`);
        this.name = "ProjectInitFailedError";
        this.exitCode = exitCode;
        this.stderr = stderr;
      }
    };
  }
});

// packages/daemon/src/schemas/inspect.ts
import { z as z29 } from "zod";
var ProjectInspectDetectedSchemaZ, ProjectInspectSchemaZ, InspectFilesystemRequestSchemaZ, OnboardProjectRequestSchemaZ;
var init_inspect = __esm({
  "packages/daemon/src/schemas/inspect.ts"() {
    "use strict";
    ProjectInspectDetectedSchemaZ = z29.object({
      /** Detected package manager from lockfile, or `null`. */
      packageManager: z29.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
      /** Detected frameworks (e.g. `["next", "convex"]`). Empty array when none. */
      frameworks: z29.array(z29.string()),
      /** Suggested dev command (e.g. `pnpm dev`). `null` if no dev script found. */
      devCommand: z29.string().nullable(),
      /** Suggested test command (e.g. `pnpm test`). `null` if no test script found. */
      testCommand: z29.string().nullable()
    });
    ProjectInspectSchemaZ = z29.object({
      /** Sanitized basename of the directory — safe to use as a tmux session name. */
      name: z29.string(),
      /** Absolute, canonical path to the directory. */
      dir: z29.string(),
      /** Whether `<dir>/ide.yml` exists. Legacy compatibility fact. */
      hasIdeYml: z29.boolean(),
      /** Whether `.tmux-ide/workspace.yml` exists or wins discovery. */
      hasWorkspaceConfig: z29.boolean().optional(),
      /** Generalized winning config kind. Added without replacing `hasIdeYml`. */
      configKind: z29.enum(["workspace", "legacy", "none"]).optional(),
      /** Generalized winning config path. Added without replacing legacy path facts. */
      configPath: z29.string().nullable().optional(),
      /** Legacy config path when an `ide.yml` is present. */
      ideConfigPath: z29.string().nullable().optional(),
      /** Git remote origin URL, or `null` if not a git repo / no origin / probe failed. */
      gitOrigin: z29.string().nullable(),
      /** Current git branch, or `null` if not a git repo / detached HEAD / probe failed. */
      gitBranch: z29.string().nullable(),
      /** Detected stack signals (reuses `tmux-ide detect` logic). */
      detected: ProjectInspectDetectedSchemaZ
    });
    InspectFilesystemRequestSchemaZ = z29.object({
      dir: z29.string().min(1)
    });
    OnboardProjectRequestSchemaZ = z29.object({
      dir: z29.string().min(1),
      /** Optional override for the project name — defaults to inspect.name. */
      name: z29.string().min(1).optional(),
      /** 1, 2, or 3 — how many Claude panes to scaffold in the top row. */
      agents: z29.number().int().min(1).max(3),
      /**
       * Optional per-agent pane titles. When provided, length must equal
       * `agents`; the server uses these as `title:` for the Claude panes
       * instead of the canonical `Lead`/`Teammate N`/`Claude N` defaults.
       */
      agentNames: z29.array(z29.string().min(1)).optional(),
      /** Dev server command (e.g. `pnpm dev`). Omit / null to skip the dev pane. */
      devCommand: z29.string().min(1).nullable().optional(),
      /** Test command (e.g. `pnpm test`). Currently informational; stored for later. */
      testCommand: z29.string().min(1).nullable().optional(),
      /** Lint command (e.g. `pnpm lint`). Currently informational; stored for later. */
      lintCommand: z29.string().min(1).nullable().optional()
    });
  }
});

// packages/daemon/src/lib/filesystem-browser.ts
import { realpathSync as realpathSync4, readdirSync as readdirSync4, statSync as statSync5 } from "node:fs";
import { homedir as homedir19 } from "node:os";
import { isAbsolute as isAbsolute4, join as join29, resolve as resolve23, sep as sep2 } from "node:path";
function isUnderRoot(canonical, root) {
  if (canonical === root) return true;
  const prefix = root.endsWith(sep2) ? root : root + sep2;
  return canonical.startsWith(prefix);
}
function assertInsideSandbox(canonical, home) {
  if (isUnderRoot(canonical, home)) return;
  for (const root of ALLOWED_PLATFORM_ROOTS) {
    if (isUnderRoot(canonical, root)) return;
  }
  throw new SandboxViolationError(canonical);
}
var ALLOWED_PLATFORM_ROOTS, SandboxViolationError;
var init_filesystem_browser = __esm({
  "packages/daemon/src/lib/filesystem-browser.ts"() {
    "use strict";
    ALLOWED_PLATFORM_ROOTS = ["/Users", "/home", "/Volumes"];
    SandboxViolationError = class extends Error {
      code = "outside-sandbox";
      constructor(path2) {
        super(`Path "${path2}" is outside the allowed sandbox`);
        this.name = "SandboxViolationError";
      }
    };
  }
});

// packages/daemon/src/lib/project-inspect.ts
import { existsSync as existsSync31 } from "node:fs";
import { isAbsolute as isAbsolute5, resolve as resolve24 } from "node:path";
function narrowPackageManager(raw) {
  if (!raw) return null;
  return KNOWN_PACKAGE_MANAGERS.has(raw) ? raw : null;
}
function inferTestCommand(packageManager) {
  if (!packageManager) return null;
  return packageManager === "npm" ? "npm test" : `${packageManager} test`;
}
async function inspectProject(dir, io = {}) {
  const exists = io.exists ?? existsSync31;
  const absoluteDir = isAbsolute5(dir) ? dir : resolve24(dir);
  if (!exists(absoluteDir)) {
    throw new InspectDirNotFoundError(absoluteDir);
  }
  const probe = await probeProject(absoluteDir, io.probeIo);
  const stack = detectStack(absoluteDir);
  const detected = {
    packageManager: narrowPackageManager(stack.packageManager),
    frameworks: stack.frameworks,
    devCommand: stack.devCommand,
    testCommand: inferTestCommand(stack.packageManager)
  };
  return {
    name: probe.name,
    dir: probe.dir,
    hasIdeYml: probe.hasIdeYml,
    hasWorkspaceConfig: probe.hasWorkspaceConfig,
    configKind: probe.configKind,
    configPath: probe.configPath,
    ideConfigPath: probe.ideConfigPath,
    gitOrigin: probe.gitOrigin,
    gitBranch: probe.gitBranch,
    detected
  };
}
var InspectDirNotFoundError, KNOWN_PACKAGE_MANAGERS;
var init_project_inspect = __esm({
  "packages/daemon/src/lib/project-inspect.ts"() {
    "use strict";
    init_detect();
    init_project_probe();
    InspectDirNotFoundError = class extends Error {
      code = "DIR_NOT_FOUND";
      constructor(dir) {
        super(`Directory "${dir}" does not exist`);
        this.name = "InspectDirNotFoundError";
      }
    };
    KNOWN_PACKAGE_MANAGERS = /* @__PURE__ */ new Set(["pnpm", "npm", "yarn", "bun"]);
  }
});

// packages/daemon/src/lib/project-onboard.ts
import yaml5 from "js-yaml";
function composeIdeYmlConfig(input) {
  if (!Number.isInteger(input.agents) || input.agents < 1 || input.agents > 3) {
    throw new OnboardInvalidInputError(
      `agents must be an integer between 1 and 3 (got ${input.agents})`
    );
  }
  const cleanName = input.name.trim();
  if (!cleanName) {
    throw new OnboardInvalidInputError("name must be a non-empty string");
  }
  const agentsCount = input.agents;
  const customNames = input.agentNames;
  if (customNames !== void 0) {
    if (customNames.length !== agentsCount) {
      throw new OnboardInvalidInputError(
        `agentNames length (${customNames.length}) must equal agents (${agentsCount})`
      );
    }
    for (const name of customNames) {
      if (typeof name !== "string" || name.trim() === "") {
        throw new OnboardInvalidInputError("agentNames entries must be non-empty strings");
      }
    }
  }
  const topPanes = [];
  for (let i = 0; i < agentsCount; i++) {
    const fallback = agentsCount > 1 ? i === 0 ? "Lead" : `Teammate ${i}` : `Claude ${i + 1}`;
    const customTitle = customNames?.[i]?.trim();
    const pane = {
      id: `agent-${i + 1}`,
      title: customTitle && customTitle.length > 0 ? customTitle : fallback,
      command: "claude"
    };
    if (i === 0) {
      pane.focus = true;
    }
    topPanes.push(pane);
  }
  const bottomPanes = [];
  const devCommand = input.devCommand?.trim();
  if (devCommand) {
    bottomPanes.push({ id: "dev", title: "Dev", command: devCommand });
  }
  bottomPanes.push({ id: "shell", title: "Shell" });
  const rows = [{ size: "70%", panes: topPanes }, { panes: bottomPanes }];
  const config2 = {
    name: cleanName,
    rows
  };
  return config2;
}
async function assertNoExistingIdeYml(dir, resolver = resolveProject) {
  const resolution = await resolver(dir);
  if (resolution.config.kind === "legacy") {
    throw new OnboardConflictError(resolution.config.path, "IDE_YML_EXISTS");
  }
  if (resolution.config.kind === "workspace") {
    throw new OnboardConflictError(resolution.config.path, "WORKSPACE_CONFIG_EXISTS");
  }
}
var OnboardConflictError, OnboardInvalidInputError;
var init_project_onboard = __esm({
  "packages/daemon/src/lib/project-onboard.ts"() {
    "use strict";
    init_project_resolver();
    OnboardConflictError = class extends Error {
      code;
      constructor(path2, code = "IDE_YML_EXISTS") {
        super(`project config already exists at ${path2}`);
        this.name = "OnboardConflictError";
        this.code = code;
      }
    };
    OnboardInvalidInputError = class extends Error {
      code = "INVALID_INPUT";
      constructor(message) {
        super(message);
        this.name = "OnboardInvalidInputError";
      }
    };
  }
});

// packages/daemon/src/command-center/server.ts
var server_exports = {};
__export(server_exports, {
  attachWsEvents: () => attachWsEvents,
  createApp: () => createApp,
  getSseMetrics: () => getSseMetrics
});
import { execFile as execFile2 } from "node:child_process";
import { promisify } from "node:util";
import { existsSync as existsSync32, readdirSync as readdirSync5 } from "node:fs";
import { join as join30, dirname as dirname27, basename as basename8 } from "node:path";
import { fileURLToPath as fileURLToPath10 } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import { zValidator } from "@hono/zod-validator";
import { realpathSync as realpathSync5 } from "node:fs";
import { homedir as homedir20 } from "node:os";
import { isAbsolute as isAbsolute6, resolve as pathResolve } from "node:path";
import { randomUUID as randomUUID4 } from "node:crypto";
import { WebSocketServer } from "ws";
function bearerToken(authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}
function requireAuth(token, localBypassToken) {
  return async (c, next) => {
    if (!token) return next();
    const url = new URL(c.req.url);
    const suppliedToken = bearerToken(c.req.header("Authorization")) ?? url.searchParams.get("token");
    if (suppliedToken === token || localBypassToken && suppliedToken === localBypassToken) {
      return next();
    }
    return c.json({ error: "Remote access token required" }, 401);
  };
}
function remoteAccessAuth(options) {
  const bindHostname = options.remoteAccess?.bindHostname ?? "127.0.0.1";
  const loopback = bindHostname === "127.0.0.1" || bindHostname === "::1" || bindHostname === "localhost";
  return {
    token: loopback ? null : options.remoteAccess?.token ?? null,
    localBypassToken: options.remoteAccess?.localBypassToken ?? null
  };
}
function getSseMetrics() {
  return { ...sseMetrics };
}
function matchLogChannel(channel) {
  switch (channel) {
    case "daemon":
      return () => true;
    case "hq":
      return (entry) => entry.component.startsWith("hq") || entry.component.startsWith("remote");
    case "watchdog":
      return (entry) => entry.component.startsWith("watchdog");
    default:
      return null;
  }
}
function freezePayload(payload) {
  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload)) {
      freezePayload(value);
    }
    Object.freeze(payload);
  }
  return payload;
}
function buildProjectStreamSnapshot(session) {
  return {
    project: buildProjectDetail(session)
  };
}
function sandboxResolveDir(rawDir) {
  const trimmed = rawDir.trim();
  if (!trimmed) return { error: "invalid-path", message: "Path must not be empty", status: 400 };
  if (trimmed.includes("\0")) {
    return { error: "invalid-path", message: "Path contains a null byte", status: 400 };
  }
  const home = process.env.TMUX_IDE_HOME_OVERRIDE && process.env.TMUX_IDE_HOME_OVERRIDE.trim().length > 0 ? process.env.TMUX_IDE_HOME_OVERRIDE : homedir20();
  let candidate = trimmed;
  if (candidate === "~") {
    candidate = home;
  } else if (candidate.startsWith("~/")) {
    candidate = `${home.replace(/\/+$/, "")}/${candidate.slice(2)}`;
  }
  if (!isAbsolute6(candidate)) {
    return { error: "invalid-path", message: "Path must be absolute", status: 400 };
  }
  const resolved2 = pathResolve(candidate);
  let canonical;
  try {
    canonical = realpathSync5(resolved2);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        error: "not-found",
        message: `Path "${resolved2}" does not exist`,
        status: 404
      };
    }
    throw err;
  }
  try {
    assertInsideSandbox(canonical, home);
  } catch (err) {
    if (err instanceof SandboxViolationError) {
      return { error: "outside-sandbox", message: err.message, status: 403 };
    }
    throw err;
  }
  return { canonical };
}
function createApp(options = {}) {
  const authConfig = options.authConfig ?? { method: "none", token_expiry: 86400 };
  const authService = options.authService ?? new AuthService();
  const daemonIdentity = options.daemonIdentity ?? {
    productVersion: "0.0.0",
    instanceId: randomUUID4(),
    startedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const healthBootedAt = Date.now();
  const app = new Hono();
  app.use("/*", cors());
  const remoteAuth = remoteAccessAuth(options);
  app.use("/api/*", requireAuth(remoteAuth.token, remoteAuth.localBypassToken));
  app.use("/*", authMiddleware(authService, authConfig));
  app.onError((err, c) => {
    console.error("[command-center]", err.message);
    return c.json({ error: err.message }, 500);
  });
  app.post("/api/auth/challenge", async (c) => {
    const body = await c.req.json();
    const userId = body.userId ?? authService.getCurrentUser();
    const challenge = authService.createChallenge(userId);
    return c.json(challenge);
  });
  app.post("/api/auth/verify", async (c) => {
    const body = await c.req.json();
    const result = await authService.authenticateWithSSHKey({
      publicKey: body.publicKey,
      signature: body.signature,
      challengeId: body.challengeId
    });
    if (!result.success) {
      return c.json({ error: result.error }, 401);
    }
    return c.json({ token: result.token, userId: result.userId });
  });
  app.post("/api/auth/token", async (c) => {
    if (authConfig.method !== "none") {
      return c.json({ error: "Direct token generation requires auth method 'none'" }, 403);
    }
    const body = await c.req.json();
    const userId = body.userId ?? authService.getCurrentUser();
    const token = authService.generateToken(userId);
    return c.json({ token, userId });
  });
  app.post("/api/v2/action/:name", createActionDispatcher());
  app.get("/api/widget/:name/spawn", async (c) => {
    const { resolveWidgetSpawn: resolveWidgetSpawn2, WIDGET_TYPES: WIDGET_TYPES2 } = await Promise.resolve().then(() => (init_resolve(), resolve_exports));
    const name = c.req.param("name");
    if (!WIDGET_TYPES2.includes(name)) {
      return c.json({ error: `unknown widget: ${name}`, available: WIDGET_TYPES2 }, 404);
    }
    const session = c.req.query("session");
    const dir = c.req.query("dir");
    if (!session || !dir) {
      return c.json({ error: "session and dir query params are required" }, 400);
    }
    const target = c.req.query("target") ?? null;
    const themeRaw = c.req.query("theme");
    let theme = null;
    if (themeRaw) {
      try {
        theme = JSON.parse(themeRaw);
      } catch {
        return c.json({ error: "theme must be valid JSON" }, 400);
      }
    }
    try {
      const spec = resolveWidgetSpawn2(name, {
        session,
        dir,
        target,
        theme
      });
      return c.json(spec);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: daemonIdentity.productVersion,
      uptimeMs: Date.now() - healthBootedAt
    });
  });
  app.get("/identity", (c) => {
    return c.json({
      ok: true,
      pid: process.pid,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: daemonIdentity.productVersion,
      instanceId: daemonIdentity.instanceId,
      startedAt: daemonIdentity.startedAt
    });
  });
  app.get("/api/sessions", (c) => {
    const sessions = discoverSessions();
    const overviews = buildOverviews(sessions);
    return c.json({ sessions: overviews });
  });
  app.get("/api/workspaces", (c) => {
    const registry = getDefaultWorkspaceRegistry();
    return c.json({ workspaces: registry.list() });
  });
  app.get("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    const workspace = registry.get(name);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    return c.json({ workspace });
  });
  app.post("/api/workspaces", zValidator("json", AddWorkspaceRequestSchemaZ), async (c) => {
    const body = c.req.valid("json");
    const registry = getDefaultWorkspaceRegistry();
    const name = body.name ?? basename8(body.projectDir);
    if (!name || name.length === 0) {
      return c.json({ error: "Cannot derive workspace name from projectDir" }, 400);
    }
    const facts = await resolveProjectConfigContext(body.projectDir);
    try {
      const workspace = registry.add({
        name,
        sessionName: body.sessionName,
        projectDir: body.projectDir,
        ideConfigPath: body.ideConfigPath ?? facts.ideConfigPath,
        configKind: body.configKind ?? facts.configKind,
        configPath: body.configPath ?? facts.configPath,
        hasWorkspaceConfig: body.hasWorkspaceConfig ?? facts.hasWorkspaceConfig
      });
      return c.json({ workspace }, 201);
    } catch (err) {
      if (err instanceof WorkspaceAlreadyExistsError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  });
  app.delete("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    try {
      registry.remove(name);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });
  app.get("/api/project/:name", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const detail = buildProjectDetail(session);
    return c.json({ ...detail });
  });
  app.get("/api/project/:name/panes", (c) => {
    const name = c.req.param("name");
    let panes;
    try {
      panes = listSessionPanes(name);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
    if (panes.length === 0) {
      const sessions = discoverSessions();
      if (!sessions.find((s) => s.name === name)) {
        return c.json({ error: "Session not found" }, 404);
      }
    }
    return c.json({
      panes: panes.map((p) => ({
        id: p.id,
        index: p.index,
        title: p.title,
        currentCommand: p.currentCommand,
        width: p.width,
        height: p.height,
        active: p.active,
        role: p.role,
        name: p.name,
        type: p.type
      }))
    });
  });
  app.get("/api/project/:name/terminals", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const records = loadTerminals(session.dir);
    const terminals = records.map((t) => {
      const bridge = defaultPtyBridgeRegistry.peek(t.id);
      let runtime = { running: false };
      if (bridge) {
        const cols = typeof bridge.cols === "number" ? bridge.cols : void 0;
        const rows = typeof bridge.rows === "number" ? bridge.rows : void 0;
        const replay = typeof bridge.getReplayBuffer === "function" ? bridge.getReplayBuffer().byteLength : void 0;
        runtime = {
          running: bridge.running !== false,
          ...cols !== void 0 ? { cols } : {},
          ...rows !== void 0 ? { rows } : {},
          ...replay !== void 0 ? { replayBytes: replay } : {}
        };
      }
      return { ...t, runtime };
    });
    return c.json({ terminals });
  });
  app.post(
    "/api/project/:name/terminals",
    zValidator("json", terminalCreateRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      let id = body.id;
      let scripted = false;
      const kind = body.kind ?? "shell";
      if (!id && body.script) {
        id = await createScriptTerminalId({
          projectId: name,
          scopeId: body.scopeId,
          kind,
          script: body.script
        });
        scripted = true;
      }
      if (!id) id = randomUUID4();
      try {
        const upsertInput = {
          id,
          projectId: name,
          scopeId: body.scopeId,
          name: body.name,
          kind
        };
        if (scripted) upsertInput.scripted = true;
        const record = upsertTerminal(session.dir, upsertInput);
        broadcastTerminalsChanged(name);
        return c.json({ ok: true, terminal: record });
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }
    }
  );
  app.post(
    "/api/project/:name/terminals/:id/rename",
    zValidator("json", terminalRenameRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const id = c.req.param("id");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      try {
        const record = renameTerminal(session.dir, id, c.req.valid("json").name);
        if (!record) return c.json({ error: "Terminal not found" }, 404);
        broadcastTerminalsChanged(name);
        return c.json({ ok: true, terminal: record });
      } catch (err) {
        return c.json({ error: err.message }, 400);
      }
    }
  );
  app.delete("/api/project/:name/terminals/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const removedRecord = deleteTerminal(session.dir, id);
    const killed = defaultPtyBridgeRegistry.delete(id);
    if (!removedRecord && !killed) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    broadcastTerminalsChanged(name);
    return c.json({ ok: true });
  });
  app.get("/api/project/:name/events", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ events: [] });
  });
  app.get("/api/project/:name/stream", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return streamSSE(c, async (stream) => {
      projectStreamConnections += 1;
      sseMetrics.connections = projectStreamConnections;
      let closed = false;
      let previousSnapshotHash = "";
      let lastPing = Date.now();
      function writeSse(event, payload) {
        sseMetrics.messagesSent += 1;
        void stream.writeSSE({ event, data: JSON.stringify(freezePayload(payload)) });
      }
      function writeChanges(currentSession) {
        const snapshot = buildProjectStreamSnapshot(currentSession);
        const snapshotHash = JSON.stringify(snapshot);
        if (snapshotHash !== previousSnapshotHash) {
          writeSse("snapshot", snapshot);
          previousSnapshotHash = snapshotHash;
        }
      }
      try {
        stream.onAbort(() => {
          closed = true;
        });
        writeChanges(session);
        while (!closed) {
          await stream.sleep(250);
          const current = discoverSessions().find((candidate) => candidate.name === name);
          if (!current) break;
          writeChanges(current);
          const now = Date.now();
          if (now - lastPing >= 25e3) {
            writeSse("ping", { at: (/* @__PURE__ */ new Date()).toISOString() });
            lastPing = now;
          }
        }
      } finally {
        projectStreamConnections = Math.max(0, projectStreamConnections - 1);
        sseMetrics.connections = projectStreamConnections;
      }
    });
  });
  app.post("/api/project/:name/inject", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid request body" }, 400);
    }
    const text = body.text;
    const paneId = body.paneId;
    const sendEnter = body.sendEnter;
    if (typeof text !== "string" || text.trim().length === 0) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (paneId !== void 0 && (typeof paneId !== "string" || !/^%\d+$/.test(paneId))) {
      return c.json({ error: "paneId must match /^%\\d+$/" }, 400);
    }
    if (sendEnter !== void 0 && typeof sendEnter !== "boolean") {
      return c.json({ error: "sendEnter must be a boolean" }, 400);
    }
    const panes = listSessionPanes(name);
    const pane = paneId ? panes.find((candidate) => candidate.id === paneId) : panes.find((p) => p.active);
    if (!pane) {
      return c.json({ error: "Pane not found" }, 404);
    }
    sendLiteralToPane(name, pane.id, text);
    if (sendEnter) sendEnterToPane(name, pane.id);
    return c.json({ ok: true });
  });
  app.post("/api/project/:name/send", zValidator("json", sendCommandSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const { target, message, noEnter } = c.req.valid("json");
    const panes = listSessionPanes(name);
    const pane = resolvePane(panes, target);
    if (!pane) {
      const available = panes.map((p) => ({
        id: p.id,
        title: p.title,
        name: p.name,
        role: p.role
      }));
      return c.json({ error: "Pane not found", target, available }, 404);
    }
    const busyStatus = getPaneBusyStatus(name, pane.id);
    const prepared = busyStatus === "agent" ? message.replace(/\n+/g, " ").trim() : message;
    if (noEnter) {
      sendText(name, pane.id, prepared);
    } else {
      sendCommand(name, pane.id, prepared);
    }
    return c.json({
      ok: true,
      session: name,
      target: {
        paneId: pane.id,
        name: pane.name,
        title: pane.title,
        role: pane.role
      },
      busyStatus
    });
  });
  app.get("/api/project/:name/config", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const resolved2 = await resolveConfig(session.dir);
      if (!resolved2.launchConfig || !resolved2.path) {
        return c.json({ error: "Config not found" }, 404);
      }
      return c.json({
        ok: true,
        config: resolved2.launchConfig,
        configPath: resolved2.path,
        configKind: resolved2.kind,
        hasWorkspaceConfig: resolved2.kind === "workspace",
        hasIdeYml: resolved2.resolution.legacyConfigPath !== null,
        ideConfigPath: resolved2.resolution.legacyConfigPath
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to read workspace config", detail: message }, 500);
    }
  });
  app.post("/api/project/:name/config", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = IdeConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid config", details: parsed.error.issues }, 400);
    }
    try {
      const context = await resolveProjectConfigContext(session.dir);
      const configPath = writeConfig(context.configWriteRoot, parsed.data);
      const resolved2 = await resolveConfig(session.dir);
      return c.json({
        ok: true,
        config: parsed.data,
        configPath,
        configKind: resolved2.kind,
        hasWorkspaceConfig: resolved2.kind === "workspace",
        hasIdeYml: resolved2.resolution.legacyConfigPath !== null,
        ideConfigPath: resolved2.resolution.legacyConfigPath
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to write workspace config", detail: message }, 500);
    }
  });
  const execFileAsync = promisify(execFile2);
  app.post("/api/project/:name/restart", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      await execFileAsync("tmux-ide", ["restart", "--json"], {
        cwd: session.dir,
        timeout: 3e4,
        env: { ...process.env, TMUX: "" }
      });
      return c.json({ ok: true, session: name, status: "restarted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Restart failed", detail: message }, 500);
    }
  });
  app.post("/api/project/:name/launch", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const state = getSessionState(name);
    if (state.running) {
      return c.json({ ok: true, session: name, status: "already_running" });
    }
    try {
      await execFileAsync("tmux-ide", ["--json"], {
        cwd: session.dir,
        timeout: 3e4,
        env: { ...process.env, TMUX: "" }
        // Clear TMUX to avoid nesting
      });
      return c.json({ ok: true, session: name, status: "launched" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Launch failed", detail: message }, 500);
    }
  });
  app.post("/api/project/:name/stop", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const state = getSessionState(name);
    if (!state.running) {
      return c.json({ ok: true, session: name, status: "not_running" });
    }
    stopSessionMonitor(name);
    const result = killSession(name);
    if (result.stopped) {
      return c.json({ ok: true, session: name, status: "stopped" });
    }
    return c.json({ error: "Stop failed", reason: result.reason }, 500);
  });
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let prevOverviews = [];
      const poll = () => {
        const sessions = discoverSessions();
        const overviews = buildOverviews(sessions);
        const prevNames = new Set(prevOverviews.map((s) => s.name));
        const currNames = new Set(overviews.map((s) => s.name));
        for (const overview of overviews) {
          if (!prevNames.has(overview.name)) {
            stream.writeSSE({ event: "session_added", data: JSON.stringify(overview) });
          }
        }
        for (const prev of prevOverviews) {
          if (!currNames.has(prev.name)) {
            stream.writeSSE({
              event: "session_removed",
              data: JSON.stringify({ name: prev.name })
            });
          }
        }
        prevOverviews = overviews;
      };
      poll();
      while (true) {
        await stream.sleep(2e3);
        poll();
      }
    });
  });
  app.get("/api/logs/:channel", (c) => {
    const channel = c.req.param("channel");
    const match = matchLogChannel(channel);
    if (!match) {
      return c.json({ error: `Unknown log channel: ${channel}` }, 404);
    }
    return streamSSE(c, async (stream) => {
      const backfill = getLogBuffer().filter(match);
      for (const entry of backfill) {
        await stream.writeSSE({ event: "entry", data: JSON.stringify(entry) });
      }
      await stream.writeSSE({ event: "bookmark", data: String(backfill.length) });
      const queue = [];
      let cancelled = false;
      const unsub = subscribeLogs((entry) => {
        if (cancelled) return;
        if (match(entry)) queue.push(entry);
      });
      try {
        while (!cancelled) {
          if (queue.length === 0) {
            await stream.sleep(500);
            continue;
          }
          const drained = queue.splice(0, queue.length);
          for (const entry of drained) {
            await stream.writeSSE({ event: "entry", data: JSON.stringify(entry) });
          }
        }
      } finally {
        cancelled = true;
        unsub();
      }
    });
  });
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      uptime: Math.round(process.uptime()),
      productVersion: daemonIdentity.productVersion
    });
  });
  app.get("/api/projects", (c) => {
    return c.json({ projects: listProjects() });
  });
  app.get("/api/projects/templates", (c) => {
    return c.json({ templates: listAvailableTemplates() });
  });
  app.post("/api/projects", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = RegisterProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    try {
      const project = await registerProject({
        dir: parsed.data.dir,
        name: parsed.data.name
      });
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      if (err instanceof ProjectAlreadyRegisteredError) {
        return c.json({ error: err.message, code: err.code, suggestion: err.suggestion }, 409);
      }
      throw err;
    }
  });
  app.delete("/api/projects/:name", (c) => {
    const name = c.req.param("name");
    try {
      unregisterProject(name);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });
  app.post("/api/projects/:name/probe", async (c) => {
    const name = c.req.param("name");
    if (!getProject(name)) {
      return c.json({ error: `Project "${name}" not found in registry`, code: "NOT_FOUND" }, 404);
    }
    try {
      const project = await refreshProject(name);
      return c.json({ project });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });
  app.post("/api/projects/init", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = InitProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    if (!existsSync32(parsed.data.dir)) {
      return c.json({ error: `Directory "${parsed.data.dir}" does not exist` }, 400);
    }
    const jobId = randomUUID4();
    const command2 = process.env.TMUX_IDE_INIT_COMMAND ?? "tmux-ide";
    void (async () => {
      try {
        await runInit({
          cwd: parsed.data.dir,
          template: parsed.data.template,
          command: command2,
          onChunk: (chunk) => {
            broadcastInitOutput(jobId, chunk);
          }
        });
        broadcastInitOutput(jobId, "", true);
        try {
          await registerProject({ dir: parsed.data.dir });
        } catch (err) {
          if (!(err instanceof ProjectAlreadyRegisteredError) && !(err instanceof ProjectDirNotFoundError)) {
            broadcastInitError(jobId, err.message);
          }
        }
      } catch (err) {
        if (err instanceof ProjectInitTimeoutError) {
          broadcastInitError(jobId, err.message);
        } else if (err instanceof ProjectInitFailedError) {
          broadcastInitError(jobId, err.message);
        } else {
          broadcastInitError(jobId, err.message);
        }
      }
    })();
    return c.json({ jobId }, 202);
  });
  app.post("/api/projects/onboard", async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = OnboardProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const sandboxResult = sandboxResolveDir(parsed.data.dir);
    if ("error" in sandboxResult) {
      return c.json(
        { error: sandboxResult.error, message: sandboxResult.message },
        sandboxResult.status
      );
    }
    const dir = sandboxResult.canonical;
    let inspect2;
    try {
      inspect2 = await inspectProject(dir);
    } catch (err) {
      if (err instanceof InspectDirNotFoundError) {
        return c.json({ error: "not-found", message: err.message }, 404);
      }
      throw err;
    }
    try {
      await assertNoExistingIdeYml(dir);
    } catch (err) {
      if (err instanceof OnboardConflictError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
    const finalName = parsed.data.name?.trim() || inspect2.name;
    let config2;
    try {
      config2 = composeIdeYmlConfig({
        name: finalName,
        agents: parsed.data.agents,
        agentNames: parsed.data.agentNames,
        devCommand: parsed.data.devCommand ?? null,
        testCommand: parsed.data.testCommand ?? null,
        lintCommand: parsed.data.lintCommand ?? null
      });
    } catch (err) {
      if (err instanceof OnboardInvalidInputError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
    writeConfig(dir, config2);
    try {
      const project = await registerProject({ dir, name: finalName });
      return c.json({ project }, 201);
    } catch (err) {
      if (err instanceof ProjectAlreadyRegisteredError) {
        return c.json({ error: err.message, code: err.code, suggestion: err.suggestion }, 409);
      }
      if (err instanceof ProjectDirNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
  });
  return app;
}
function listAvailableTemplates() {
  const __filename = fileURLToPath10(import.meta.url);
  const __dir = dirname27(__filename);
  const templatesDir = join30(__dir, "..", "..", "..", "..", "templates");
  if (!existsSync32(templatesDir)) return [];
  const labels = {
    default: { label: "Default", description: "Single Claude pane + dev/shell row" },
    nextjs: {
      label: "Next.js",
      description: "Two Claude panes + Next.js dev server + shell"
    },
    vite: { label: "Vite", description: "Vite dev server + Claude + shell" },
    convex: {
      label: "Convex",
      description: "Convex dev + Next.js + Claude pane"
    },
    python: { label: "Python", description: "Python project with Claude + tests" },
    go: { label: "Go", description: "Go project with Claude + tests + shell" },
    "agent-team": {
      label: "Agent Team",
      description: "Lead + teammate Claude panes for coordinated multi-agent work"
    },
    "agent-team-nextjs": {
      label: "Agent Team \u2014 Next.js",
      description: "Agent team layout tuned for a Next.js app"
    },
    "agent-team-monorepo": {
      label: "Agent Team \u2014 Monorepo",
      description: "Agent team layout for monorepos with multiple apps"
    },
    missions: {
      label: "Missions",
      description: "Mission-driven layout with planner, validator, and researcher"
    }
  };
  const entries = readdirSync5(templatesDir).filter((f) => f.endsWith(".yml"));
  return entries.map((file) => {
    const id = file.replace(/\.yml$/, "");
    const meta = labels[id];
    return {
      id,
      label: meta?.label ?? id,
      description: meta?.description ?? `Template: ${id}`
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function attachWsEvents(server) {
  const wss = new WebSocketServer({ noServer: true });
  const upgradeListener = (req, socket, head3) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    if (pathname !== "/ws/events") return;
    wss.handleUpgrade(req, socket, head3, (ws) => {
      handleWsEventsConnection(ws);
    });
  };
  server.on("upgrade", upgradeListener);
  return {
    close: () => {
      server.off("upgrade", upgradeListener);
      wss.close();
    }
  };
}
var projectStreamConnections, sseMetrics;
var init_server = __esm({
  "packages/daemon/src/command-center/server.ts"() {
    "use strict";
    init_discovery();
    init_pane_comms();
    init_send();
    init_src2();
    init_yaml_io();
    init_resolved_config();
    init_config_context();
    init_ide_config2();
    init_log();
    init_workspace_registry();
    init_src();
    init_schemas();
    init_src();
    init_terminals_store();
    init_ws_route();
    init_ws_events();
    init_auth_service();
    init_middleware();
    init_ws_events();
    init_dispatcher();
    init_project_registry();
    init_project_init_runner();
    init_registry();
    init_inspect();
    init_filesystem_browser();
    init_project_inspect();
    init_project_onboard();
    projectStreamConnections = 0;
    sseMetrics = {
      connections: 0,
      messagesSent: 0
    };
  }
});

// packages/daemon/src/lib/auth/types.ts
var types_exports = {};
__export(types_exports, {
  AuthConfigSchema: () => AuthConfigSchema
});
var init_types = __esm({
  "packages/daemon/src/lib/auth/types.ts"() {
    "use strict";
    init_src();
  }
});

// packages/daemon/src/lib/daemon-embed.ts
import { execFileSync as execFileSync12 } from "node:child_process";
import { randomBytes as randomBytes3, randomUUID as randomUUID5 } from "node:crypto";
import { createServer } from "node:http";
import { createRequire as createRequire2 } from "node:module";
import { WebSocket, WebSocketServer as WebSocketServer2 } from "ws";
function loadBundledPackage() {
  return requireFromHere("../../package.json");
}
function resolveDaemonProductVersion(explicit, loadPackage = loadBundledPackage) {
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  try {
    const pkg = loadPackage();
    if (pkg && typeof pkg === "object" && "version" in pkg) {
      const version = pkg.version;
      if (typeof version === "string" && version.trim().length > 0) return version.trim();
    }
  } catch {
  }
  return "0.0.0";
}
function tmux3(...args) {
  return execFileSync12("tmux", args, {
    encoding: "utf-8",
    // Pipe stdio explicitly. Inheriting (the default) inherits the parent's
    // file descriptors; when the daemon is launched detached (nohup, disown,
    // launchd, etc.) the controlling terminal's fds can be invalid, and the
    // child spawn fails with EBADF. The visible symptom is sessionExists()
    // returning false → stopSelf → ghost daemon.
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
function tmuxSilent2(...args) {
  try {
    return tmux3(...args);
  } catch {
    return "";
  }
}
function assertTmuxSession(sessionName) {
  try {
    tmux3("has-session", "-t", sessionName);
  } catch (err) {
    throw new DaemonStartupError(
      `tmux session "${sessionName}" does not exist`,
      "tmux_session_missing",
      { cause: err }
    );
  }
}
function validatePort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DaemonStartupError(`Invalid daemon port: ${port}`, "port_invalid");
  }
}
async function pickFreePort(hostname2) {
  const probe = createServer();
  return await new Promise((resolve29, reject) => {
    probe.once("error", reject);
    probe.listen(0, hostname2, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => {
        if (port) resolve29(port);
        else reject(new DaemonStartupError("Could not allocate daemon port", "bind_failed"));
      });
    });
  });
}
function sessionExists(sessionName) {
  try {
    tmux3("has-session", "-t", sessionName);
    return "yes";
  } catch (err) {
    const msg = err.message ?? "";
    const code = err.code;
    if (code === "EBADF" || code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || msg.includes("EBADF") || msg.includes("EAGAIN")) {
      console.error("[daemon] sessionExists transient spawn error:", msg);
      return "unknown";
    }
    return "no";
  }
}
function hasClients() {
  return tmuxSilent2("list-clients").length > 0;
}
function listPanes2(sessionName) {
  const raw = tmuxSilent2(
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_id}	#{pane_pid}	#{pane_current_command}	#{pane_title}	#{@ide_role}	#{@ide_type}	#{@ide_name}"
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [id, pid, cmd, title, role, type, name] = line.split("	");
    return {
      id,
      pid,
      cmd,
      title,
      role: role || void 0,
      type: type || void 0,
      name: name || void 0
    };
  });
}
function bearerToken2(authHeader) {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}
function requestToken(req) {
  const headerToken = bearerToken2(req.headers.authorization);
  if (headerToken) return headerToken;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}
function isLoopbackRequest(req) {
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1" || remote.startsWith("127.");
}
function isLoopbackBind(bindHostname) {
  return bindHostname === "127.0.0.1" || bindHostname === "::1" || bindHostname === "localhost";
}
function isUpgradeAuthorized(req, token, localBypassToken, bindHostname) {
  if (!token) return true;
  if (isLoopbackBind(bindHostname) && isLoopbackRequest(req)) return true;
  const supplied = requestToken(req);
  return supplied === token || localBypassToken != null && supplied === localBypassToken;
}
function rejectUpgradeWithPolicy(wss, req, socket, head3) {
  wss.handleUpgrade(req, socket, head3, (ws) => {
    ws.close(1008, "Remote access token required");
  });
}
function attachWebSockets(server, opts = {}) {
  const eventsWss = new WebSocketServer2({ noServer: true });
  const ptyWss = new WebSocketServer2({ noServer: true });
  const clients = /* @__PURE__ */ new Set();
  const track = (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  };
  const upgradeListener = (req, socket, head3) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if ((pathname === "/ws/events" || pathname.startsWith("/ws/pty/")) && !isUpgradeAuthorized(req, opts.authToken, opts.localBypassToken, opts.bindHostname)) {
      rejectUpgradeWithPolicy(pathname === "/ws/events" ? eventsWss : ptyWss, req, socket, head3);
      return;
    }
    if (pathname === "/ws/events") {
      eventsWss.handleUpgrade(req, socket, head3, (ws) => {
        track(ws);
        handleWsEventsConnection(ws);
      });
      return;
    }
    const ptyMatch = pathname.match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      const id = decodeURIComponent(ptyMatch[1]);
      ptyWss.handleUpgrade(req, socket, head3, (ws) => {
        track(ws);
        handlePtyWebSocket(ws, id);
      });
      return;
    }
  };
  server.on("upgrade", upgradeListener);
  return {
    closeClients: () => {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          closeWsGoingAway(ws);
        }
      }
    },
    closeServers: async () => {
      server.off("upgrade", upgradeListener);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
          ws.terminate();
        }
      }
      const closeWss = (wss) => Promise.race([new Promise((resolve29) => wss.close(() => resolve29())), delay(100)]);
      await Promise.all([closeWss(eventsWss), closeWss(ptyWss)]);
    }
  };
}
function waitForServerClose(server) {
  return new Promise((resolve29, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve29();
    });
  });
}
function delay(ms) {
  return new Promise((resolve29) => setTimeout(resolve29, ms));
}
function generateLocalBypassToken() {
  return randomBytes3(32).toString("base64url");
}
function timeoutSignal2(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
function sameCanonicalInstance(left, right) {
  return left.pid === right.pid && left.port === right.port && left.protocolVersion === right.protocolVersion && left.instanceId === right.instanceId && left.startedAt === right.startedAt && left.bindHostname === right.bindHostname;
}
async function requestValidatedDaemonShutdown(info) {
  const identity = await probeCanonicalDaemonIdentity(info);
  if (!identity || identity.pid !== info.pid || identity.protocolVersion !== info.protocolVersion || identity.protocolVersion !== DAEMON_WIRE_PROTOCOL_VERSION || identity.instanceId !== info.instanceId || identity.startedAt !== info.startedAt) {
    throw new DaemonStartupError(
      "Canonical daemon identity changed before takeover",
      "canonical_takeover_identity_mismatch"
    );
  }
  const health = await probeCanonicalDaemonHealth(info);
  if (!health || health.protocolVersion !== info.protocolVersion || health.protocolVersion !== DAEMON_WIRE_PROTOCOL_VERSION) {
    throw new DaemonStartupError(
      "Canonical daemon protocol or health is incompatible with takeover",
      "canonical_takeover_refused"
    );
  }
  const current = inspectCanonicalDaemonInfo();
  if (current.status !== "valid" || !sameCanonicalInstance(current.info, info)) {
    throw new DaemonStartupError(
      "Canonical daemon generation changed before takeover",
      "canonical_takeover_identity_mismatch"
    );
  }
  const headers = { "Content-Type": "application/json" };
  if (info.authToken) headers.Authorization = `Bearer ${info.authToken}`;
  let response;
  try {
    response = await fetch(
      canonicalDaemonUrl("http", info.bindHostname, info.port, "/api/v2/action/daemon.shutdown"),
      {
        method: "POST",
        headers,
        body: JSON.stringify({ reason: "takeover", expectedInstanceId: info.instanceId }),
        signal: timeoutSignal2(TAKEOVER_REQUEST_TIMEOUT_MS)
      }
    );
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new DaemonStartupError(
        "Canonical daemon did not answer the takeover request in time",
        "canonical_takeover_timeout",
        { cause: error }
      );
    }
    throw new DaemonStartupError(
      "Canonical daemon did not accept the takeover request",
      "canonical_takeover_refused",
      { cause: error }
    );
  }
  const envelope = await response.json().catch(() => null);
  if (envelope?.error?.code === "daemon_instance_mismatch") {
    throw new DaemonStartupError(
      "Canonical daemon generation changed before shutdown",
      "canonical_takeover_identity_mismatch"
    );
  }
  if (!response.ok || envelope?.ok !== true || envelope.result?.stopping !== true) {
    throw new DaemonStartupError(
      `Canonical daemon refused takeover (HTTP ${response.status})`,
      "canonical_takeover_refused"
    );
  }
}
async function waitForTakeoverQuiescence(info, deadline) {
  while (Date.now() < deadline) {
    const current = inspectCanonicalDaemonInfo();
    if (current.status === "valid" && !sameCanonicalInstance(current.info, info)) {
      throw new DaemonStartupError(
        "Another daemon generation won the takeover race",
        "canonical_already_running"
      );
    }
    const recordOwnerGone = current.status === "missing" || await isCanonicalDaemonRecordOwnerProvenDead(current);
    const [identity, health] = await Promise.all([
      probeCanonicalDaemonIdentity(info),
      probeCanonicalDaemonHealth(info)
    ]);
    if (recordOwnerGone && identity === null && health === null) return;
    await delay(TAKEOVER_POLL_MS);
  }
  throw new DaemonStartupError(
    "Canonical daemon retained its generation after accepting takeover",
    "canonical_takeover_timeout"
  );
}
async function acquireCanonicalDaemonClaimAfterTakeover(info) {
  const deadline = Date.now() + TAKEOVER_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = inspectCanonicalDaemonInfo();
    if (current.status === "valid" && !sameCanonicalInstance(current.info, info)) {
      throw new DaemonStartupError(
        "Another daemon generation won the takeover race",
        "canonical_already_running"
      );
    }
    const attempt = tryAcquireCanonicalDaemonClaim();
    if (attempt.status === "acquired") {
      try {
        await waitForTakeoverQuiescence(info, deadline);
        return attempt.claim;
      } catch (error) {
        releaseCanonicalDaemonClaim(attempt.claim);
        throw error;
      }
    }
    if (attempt.status === "invalid") {
      throw new DaemonStartupError(
        `Canonical daemon claim is invalid: ${attempt.detail}`,
        "canonical_record_invalid"
      );
    }
    await delay(TAKEOVER_POLL_MS);
  }
  throw new DaemonStartupError(
    "Canonical daemon did not release its startup claim after accepting takeover",
    "canonical_takeover_timeout"
  );
}
function acquireCanonicalDaemonClaim() {
  const attempt = tryAcquireCanonicalDaemonClaim();
  if (attempt.status === "busy") {
    throw new DaemonStartupError(
      `Canonical daemon startup is owned by PID ${attempt.owner.pid}`,
      "canonical_claim_busy"
    );
  }
  if (attempt.status === "invalid") {
    throw new DaemonStartupError(
      `Canonical daemon claim is invalid: ${attempt.detail}`,
      "canonical_record_invalid"
    );
  }
  return attempt.claim;
}
function closeWsGoingAway(ws) {
  const reason = Buffer.from("going away");
  const payload = Buffer.allocUnsafe(2 + reason.length);
  payload.writeUInt16BE(1001, 0);
  reason.copy(payload, 2);
  const frame = Buffer.concat([Buffer.from([136, payload.length]), payload]);
  const socket = ws._socket;
  if (socket && !socket.destroyed && socket.writable) {
    socket.end(frame);
    return;
  }
  ws.close(1001, reason);
}
async function startHttpServer({
  sessionName,
  requestedPort,
  bindHostname,
  dir,
  authToken,
  localBypassToken,
  silent,
  readProjectAuth,
  daemonIdentity
}) {
  const { createApp: createApp3 } = await Promise.resolve().then(() => (init_server(), server_exports));
  const { getRequestListener: getRequestListener3 } = await import(requireFromHere.resolve("@hono/node-server"));
  const { AuthService: AuthService2 } = await Promise.resolve().then(() => (init_auth_service(), auth_service_exports));
  const { AuthConfigSchema: AuthConfigSchema2 } = await Promise.resolve().then(() => (init_types(), types_exports));
  let authConfig = AuthConfigSchema2.parse({});
  if (readProjectAuth !== false) {
    try {
      const { resolveConfig: resolveConfig2 } = await Promise.resolve().then(() => (init_resolved_config(), resolved_config_exports));
      const { launchConfig } = await resolveConfig2(dir);
      if (launchConfig?.auth) authConfig = AuthConfigSchema2.parse(launchConfig.auth);
    } catch {
    }
  }
  const authService = new AuthService2(authConfig.secret);
  const app = createApp3({
    authService,
    authConfig,
    remoteAccess: {
      bindHostname,
      token: authToken ?? null,
      localBypassToken: localBypassToken ?? null
    },
    daemonIdentity
  });
  app.get("/api/daemon/health", (c) => {
    return c.json({ ok: true, session: sessionName });
  });
  const server = createServer(getRequestListener3(app.fetch));
  const sockets = /* @__PURE__ */ new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const { closeClients, closeServers: closeWsServers } = attachWebSockets(server, {
    authToken,
    localBypassToken,
    bindHostname
  });
  await new Promise((resolve29, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new DaemonStartupError(`Port ${requestedPort} is already in use`, "port_in_use", {
            cause: err
          })
        );
      } else {
        reject(
          new DaemonStartupError(`Failed to bind daemon on port ${requestedPort}`, "bind_failed", {
            cause: err
          })
        );
      }
    };
    const onListening = () => {
      server.off("error", onError);
      if (!silent) {
        console.log(
          `[daemon] Command Center on http://${bindHostname}:${requestedPort} (session: ${sessionName})`
        );
      }
      resolve29();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, bindHostname);
  });
  return {
    server,
    sockets,
    closeClients,
    closeWsServers
  };
}
async function startEmbeddedDaemon(opts) {
  const sessionName = opts.sessionName ?? EMBEDDED_SESSION_NAME;
  const sessionless = opts.sessionName == null;
  const appSettings = readAppSettings();
  const persistedRemoteAccess = appSettings.remoteAccess.enabled && appSettings.remoteAccess.token ? appSettings.remoteAccess : null;
  const bindHostname = opts.bindHostname ?? opts.hostname ?? (persistedRemoteAccess ? "0.0.0.0" : DEFAULT_HOSTNAME);
  const authToken = Object.prototype.hasOwnProperty.call(opts, "authToken") ? opts.authToken ?? null : persistedRemoteAccess?.token ?? null;
  const localBypassToken = opts.localBypassToken ?? generateLocalBypassToken();
  let takeoverTarget = null;
  if (opts.takeoverIfRunning) {
    const state = inspectCanonicalDaemonInfo();
    if (state.status === "valid" && await isCanonicalDaemonAlive(state.info)) {
      await requestValidatedDaemonShutdown(state.info);
      takeoverTarget = state.info;
    }
  }
  const claim = takeoverTarget ? await acquireCanonicalDaemonClaimAfterTakeover(takeoverTarget) : acquireCanonicalDaemonClaim();
  try {
    const existingCanonical = inspectCanonicalDaemonInfo();
    if (existingCanonical.status === "invalid") {
      if (await isCanonicalDaemonRecordOwnerProvenDead(existingCanonical)) {
        if (!clearCanonicalDaemonInfoIfUnchanged(existingCanonical, claim)) {
          throw new DaemonStartupError(
            "Canonical daemon metadata changed while stale state was being removed",
            "canonical_record_invalid"
          );
        }
      } else {
        throw new DaemonStartupError(
          `Canonical daemon metadata is ${existingCanonical.reason}: ${existingCanonical.detail}. Refusing to start another owner.`,
          "canonical_record_invalid"
        );
      }
    } else if (existingCanonical.status === "valid") {
      if (await isCanonicalDaemonAlive(existingCanonical.info)) {
        throw new DaemonStartupError(
          `Canonical daemon is already running on port ${existingCanonical.info.port}`,
          "canonical_already_running"
        );
      } else {
        if (!clearCanonicalDaemonInfoIfUnchanged(existingCanonical, claim)) {
          throw new DaemonStartupError(
            "Canonical daemon metadata changed while stale state was being removed",
            "canonical_already_running"
          );
        }
      }
    }
    if (!sessionless) assertTmuxSession(sessionName);
    const port = opts.port ?? await pickFreePort(bindHostname);
    validatePort(port);
    const dir = process.cwd();
    const productVersion = resolveDaemonProductVersion(opts.productVersion);
    const instanceId = randomUUID5();
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const workspaceRegistry = getDefaultWorkspaceRegistry();
    await workspaceRegistry.load();
    const legacySession = process.env.TMUX_IDE_SESSION;
    if (legacySession && !workspaceRegistry.has(legacySession)) {
      try {
        workspaceRegistry.add({
          name: legacySession,
          sessionName: legacySession,
          projectDir: dir
        });
      } catch {
      }
    }
    if (!sessionless && sessionName !== EMBEDDED_SESSION_NAME && !workspaceRegistry.has(sessionName)) {
      try {
        workspaceRegistry.add({
          name: sessionName,
          sessionName,
          projectDir: dir
        });
      } catch {
      }
    }
    const { server, sockets, closeClients, closeWsServers } = await startHttpServer({
      sessionName,
      requestedPort: port,
      bindHostname,
      dir,
      authToken,
      localBypassToken,
      silent: opts.silent,
      readProjectAuth: !sessionless,
      daemonIdentity: { productVersion, instanceId, startedAt }
    });
    const abortStartedServer = async () => {
      closeClients();
      const closePromise = waitForServerClose(server).catch(() => void 0);
      for (const socket of sockets) socket.destroy();
      await Promise.race([closePromise, delay(100)]);
      await closeWsServers().catch(() => void 0);
    };
    try {
      writeCanonicalDaemonInfo(
        {
          pid: process.pid,
          port,
          protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
          productVersion,
          instanceId,
          startedAt,
          bindHostname,
          authToken
        },
        claim
      );
      const published = inspectCanonicalDaemonInfo();
      if (published.status !== "valid" || published.info.instanceId !== instanceId || published.info.pid !== process.pid || published.info.port !== port) {
        throw new DaemonStartupError(
          "Canonical daemon publication does not belong to the started server",
          "canonical_publication_lost"
        );
      }
    } catch (error) {
      await abortStartedServer();
      throw error;
    }
    let lastState = "";
    let stopped = false;
    let stopping = null;
    let stopSelf = null;
    const activeProjectStops = /* @__PURE__ */ new Map();
    const activateProjectOnDaemon = async (projectName, _options = {}) => {
      if (!activeProjectStops.has(projectName)) {
        activeProjectStops.set(projectName, { stop: () => void 0 });
      }
      return {
        stop: async () => {
          const current = activeProjectStops.get(projectName);
          if (!current) return;
          activeProjectStops.delete(projectName);
          current.stop();
        }
      };
    };
    setActivationBackend({
      activateProject: async (name, options) => {
        await activateProjectOnDaemon(name, options);
      },
      deactivateProject: async (name) => {
        const stop2 = activeProjectStops.get(name);
        if (!stop2) return;
        activeProjectStops.delete(name);
        stop2.stop();
      }
    });
    const tick = () => {
      if (sessionless) return;
      const session = sessionExists(sessionName);
      if (session === "no") {
        stopSelf?.();
        return;
      }
      if (session === "unknown") {
        return;
      }
      if (!hasClients()) return;
      const panes = listPanes2(sessionName);
      if (panes.length === 0) return;
      const portPanes = computePortPanes(panes);
      const agentStates = computeAgentStates(panes);
      const stateKey = panes.map((pane) => {
        const portState = portPanes.has(pane.id) ? "1" : "0";
        const agent = agentStates.get(pane.id) ?? "-";
        const titleDrift = pane.name && pane.title !== pane.name ? "d" : "ok";
        return `${pane.id}:${portState}:${agent}:${titleDrift}`;
      }).join("|");
      if (stateKey === lastState) return;
      for (const pane of panes) {
        const hasPort = portPanes.has(pane.id) ? "1" : "0";
        const agent = agentStates.get(pane.id);
        tmuxSilent2("set-option", "-pqt", pane.id, "@has_port", hasPort);
        tmuxSilent2("set-option", "-pqt", pane.id, "@agent_busy", agent === "busy" ? "1" : "0");
        tmuxSilent2("set-option", "-pqt", pane.id, "@agent_idle", agent === "idle" ? "1" : "0");
        if (pane.name && pane.title !== pane.name) {
          tmuxSilent2("select-pane", "-t", pane.id, "-T", pane.name);
        }
      }
      tmuxSilent2("refresh-client", "-S");
      lastState = stateKey;
    };
    const monitorInterval = setInterval(tick, MONITOR_INTERVAL_MS);
    const apiBaseUrl = canonicalDaemonUrl("http", bindHostname, port);
    const wsUrl = canonicalDaemonUrl("ws", bindHostname, port, "/ws/events");
    const handle = {
      instanceId,
      pid: process.pid,
      port,
      apiBaseUrl,
      wsUrl,
      localBypassToken,
      stop: async ({ gracefulMs = DEFAULT_GRACEFUL_MS } = {}) => {
        if (stopping) return stopping;
        if (stopped) return;
        stopping = (async () => {
          try {
            stopped = true;
            setActivationBackend(null);
            clearInterval(monitorInterval);
            const closePromise = waitForServerClose(server);
            closeClients();
            for (const stop2 of activeProjectStops.values()) {
              stop2.stop();
            }
            activeProjectStops.clear();
            shutdownPtyBridges();
            await Promise.race([closePromise, delay(gracefulMs)]);
            for (const socket of sockets) socket.destroy();
            await Promise.race([closePromise.catch(() => void 0), delay(100)]);
            await closeWsServers();
            setRemoteAccessRestartBackend(null);
            setDaemonShutdownBackend(null);
          } catch (err) {
            throw new DaemonShutdownError("Daemon shutdown failed", { cause: err });
          } finally {
            try {
              clearCanonicalDaemonInfoIfOwned(instanceId, claim);
            } finally {
              releaseCanonicalDaemonClaim(claim);
            }
          }
        })();
        return stopping;
      },
      activateProject: activateProjectOnDaemon
    };
    setDaemonShutdownBackend(async () => {
      await handle.stop({ gracefulMs: 500 });
    }, instanceId);
    setRemoteAccessRestartBackend((request) => {
      setTimeout(() => {
        void (async () => {
          const restartPort = request.port ?? port;
          try {
            await handle.stop({ gracefulMs: 500 });
          } catch (err) {
            console.error("[daemon] Remote access stop before restart failed:", err);
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const nextHandle = await startEmbeddedDaemon({
                sessionName: sessionless ? void 0 : sessionName,
                port: restartPort,
                bindHostname: request.bindHostname,
                authToken: request.token,
                localBypassToken
              });
              const mutableHandle = handle;
              mutableHandle.stop = nextHandle.stop;
              mutableHandle.activateProject = nextHandle.activateProject;
              return;
            } catch (err) {
              if (err instanceof DaemonStartupError && err.reason === "port_in_use" && attempt === 0) {
                await delay(150);
                continue;
              }
              throw err;
            }
          }
        })().catch((err) => {
          console.error("[daemon] Remote access restart failed:", err);
        });
      }, 50).unref?.();
      return { port };
    });
    stopSelf = () => void handle.stop();
    tick();
    return handle;
  } catch (error) {
    releaseCanonicalDaemonClaim(claim);
    throw error;
  }
}
var requireFromHere, DEFAULT_HOSTNAME, DEFAULT_GRACEFUL_MS, MONITOR_INTERVAL_MS, EMBEDDED_SESSION_NAME, TAKEOVER_REQUEST_TIMEOUT_MS, TAKEOVER_RELEASE_TIMEOUT_MS, TAKEOVER_POLL_MS;
var init_daemon_embed = __esm({
  "packages/daemon/src/lib/daemon-embed.ts"() {
    "use strict";
    init_src();
    init_session_monitor();
    init_errors2();
    init_ws_route();
    init_ws_events();
    init_app_set_remote_access();
    init_daemon_shutdown();
    init_app_settings();
    init_workspace_registry();
    init_active_projects();
    init_canonical_daemon();
    requireFromHere = createRequire2(import.meta.url);
    DEFAULT_HOSTNAME = "127.0.0.1";
    DEFAULT_GRACEFUL_MS = 2e3;
    MONITOR_INTERVAL_MS = 1e3;
    EMBEDDED_SESSION_NAME = "__embedded__";
    TAKEOVER_REQUEST_TIMEOUT_MS = 1e3;
    TAKEOVER_RELEASE_TIMEOUT_MS = 1e4;
    TAKEOVER_POLL_MS = 50;
  }
});

// packages/daemon/src/lib/cli-action-bridge.ts
import { createRequire as createRequire3 } from "node:module";
import { z as z30 } from "zod";
function timeoutSignal3(ms) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}
async function isDaemonAlive(port) {
  try {
    const res = await deps.fetch(`http://127.0.0.1:${port}/health`, {
      signal: timeoutSignal3(500)
    });
    return res.ok;
  } catch {
    return false;
  }
}
function daemonBaseUrl(info) {
  return canonicalDaemonUrl("http", info.bindHostname, info.port);
}
function expectedDaemonVersion() {
  try {
    const pkg = requireFromHere2("../../package.json");
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
async function resolveCanonicalDaemon() {
  const existing = deps.readCanonicalDaemonInfo();
  if (existing) {
    if (await deps.isCanonicalDaemonAlive(existing)) {
      warnOnDaemonVersionSkew(existing, expectedDaemonVersion());
      return { baseUrl: daemonBaseUrl(existing), transientHandle: null, restoreCwd: null };
    }
  }
  if (process.env.TMUX_IDE_CLI_NO_AUTOSTART) {
    return null;
  }
  const dir = deps.cwd();
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const handle = await deps.startEmbeddedDaemon({
      sessionName: void 0,
      bindHostname: "127.0.0.1",
      silent: true
    });
    if (!await isDaemonAlive(handle.port)) {
      await handle.stop();
      process.chdir(previousCwd);
      return null;
    }
    return { baseUrl: handle.apiBaseUrl, transientHandle: handle, restoreCwd: previousCwd };
  } catch {
    process.chdir(previousCwd);
    return null;
  }
}
async function stopTransientDaemon(daemon) {
  if (daemon.transientHandle) await daemon.transientHandle.stop().catch(() => void 0);
  if (daemon.restoreCwd) process.chdir(daemon.restoreCwd);
}
async function tryDispatchAction(name, input, options = {}) {
  const dir = options.cwd ?? deps.cwd();
  const previousDeps = deps;
  deps = { ...deps, cwd: () => dir };
  const daemon = await resolveCanonicalDaemon();
  deps = previousDeps;
  if (!daemon) return null;
  const contract = ActionContractsZ[name];
  const parsedInput = contract.input.parse(input);
  let response;
  try {
    response = await deps.fetch(`${daemon.baseUrl}/api/v2/action/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsedInput),
      signal: timeoutSignal3(2e3)
    });
  } catch {
    await stopTransientDaemon(daemon);
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    await stopTransientDaemon(daemon);
    return null;
  }
  await stopTransientDaemon(daemon);
  const failure = FailureEnvelopeZ.safeParse(body);
  if (failure.success) {
    throw new CliActionInvocationError({
      code: failure.data.error.code,
      message: failure.data.error.message,
      details: failure.data.error.details
    });
  }
  const success = z30.object({ ok: z30.literal(true), result: contract.result }).safeParse(body);
  if (!success.success) return null;
  return success.data.result;
}
var FailureEnvelopeZ, deps, CliActionInvocationError, requireFromHere2;
var init_cli_action_bridge = __esm({
  "packages/daemon/src/lib/cli-action-bridge.ts"() {
    "use strict";
    init_contract();
    init_canonical_daemon();
    init_daemon_embed();
    FailureEnvelopeZ = z30.object({
      ok: z30.literal(false),
      error: z30.object({
        code: z30.string(),
        message: z30.string(),
        details: z30.unknown().optional()
      })
    });
    deps = {
      fetch,
      cwd: () => process.cwd(),
      readCanonicalDaemonInfo,
      isCanonicalDaemonAlive,
      startEmbeddedDaemon
    };
    CliActionInvocationError = class extends Error {
      code;
      details;
      constructor(error) {
        super(error.message);
        this.name = "CliActionInvocationError";
        this.code = error.code;
        this.details = error.details ?? null;
      }
    };
    requireFromHere2 = createRequire3(import.meta.url);
  }
});

// packages/daemon/src/config.ts
import { resolve as resolve25 } from "node:path";
function readConfigSafe(dir) {
  let cfg;
  try {
    ({ config: cfg } = readConfig(dir));
  } catch (e) {
    outputError(`Cannot read project config: ${e.message}`, "READ_ERROR");
    return;
  }
  return cfg;
}
function withConfig(dir, mutator) {
  const cfg = readConfigSafe(dir);
  if (cfg === void 0) return;
  if (!isConfigObject(cfg)) {
    outputError("Invalid project config: config root must be an object", "INVALID_CONFIG");
    return;
  }
  const result = mutator(cfg);
  const validation = IdeConfigSchema.safeParse(cfg);
  if (!validation.success) {
    const issues2 = validation.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    outputError(`Invalid config after mutation:
${issues2}`, "INVALID_CONFIG");
    return;
  }
  writeConfig(dir, cfg);
  return result;
}
function mutateConfig(dir, mutator) {
  const { config: cfg } = readConfig(dir);
  if (!isConfigObject(cfg)) {
    throw new Error("Invalid project config: config root must be an object");
  }
  const result = mutator(cfg);
  const validation = IdeConfigSchema.safeParse(cfg);
  if (!validation.success) {
    const issues2 = validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config after mutation: ${issues2}`);
  }
  writeConfig(dir, cfg);
  return { config: cfg, result };
}
function assertDotPath(path2) {
  const parts = path2.split(".");
  if (!path2.trim() || parts.some((part) => !part) || parts.some((part) => part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error(`Invalid config path "${path2}"`);
  }
}
function configSetValue(dir, path2, value) {
  assertDotPath(path2);
  return mutateConfig(dir, (cfg) => {
    setByPath(cfg, path2, value);
  }).config;
}
function configAddPane(dir, rowIndex, pane) {
  return mutateConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      throw new Error("Invalid project config: 'rows' must be an array");
    }
    if (!cfg.rows[rowIndex]) {
      throw new Error(`Row ${rowIndex} does not exist`);
    }
    if (!Array.isArray(cfg.rows[rowIndex].panes)) {
      throw new Error(`Invalid project config: row ${rowIndex} panes must be an array`);
    }
    cfg.rows[rowIndex].panes.push(pane);
  }).config;
}
function configRemovePane(dir, rowIndex, paneIndex) {
  const updated = mutateConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      throw new Error("Invalid project config: 'rows' must be an array");
    }
    if (!Array.isArray(cfg.rows[rowIndex]?.panes)) {
      throw new Error(`Invalid project config: row ${rowIndex} panes must be an array`);
    }
    const removed = cfg.rows[rowIndex].panes[paneIndex];
    if (!removed) {
      throw new Error(`Pane ${paneIndex} in row ${rowIndex} does not exist`);
    }
    cfg.rows[rowIndex].panes.splice(paneIndex, 1);
    return removed;
  });
  return { config: updated.config, removed: updated.result };
}
function configAddRow(dir, size) {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid project config: 'rows' must be an array");
    }
    const row = { panes: [{ title: "Shell" }] };
    if (size) row.size = size;
    cfg.rows = cfg.rows ?? [];
    cfg.rows.push(row);
  }).config;
}
function configEnableTeam(dir, name) {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid project config: 'rows' must be an array");
    }
    cfg.team = { name: name ?? cfg.name ?? "my-team" };
    let leadAssigned = false;
    for (const row of cfg.rows ?? []) {
      for (const pane of row.panes ?? []) {
        if (pane.command === "claude" || pane.role === "lead" || pane.role === "teammate") {
          pane.role = leadAssigned ? "teammate" : "lead";
          leadAssigned = true;
        }
      }
    }
    if (!leadAssigned) {
      delete cfg.team;
      throw new Error("Cannot enable agent team: no Claude panes found");
    }
  }).config;
}
function configDisableTeam(dir) {
  return mutateConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      throw new Error("Invalid project config: 'rows' must be an array");
    }
    delete cfg.team;
    for (const row of cfg.rows ?? []) {
      if (!Array.isArray(row?.panes)) continue;
      for (const pane of row.panes) {
        delete pane.role;
        delete pane.task;
      }
    }
  }).config;
}
async function config(targetDir, { json: json2, action, args } = {}) {
  const dir = resolve25(targetDir ?? ".");
  if (await tryDispatchConfigAction(dir, { json: json2, action, args: args ?? [] })) return;
  const configContext = await resolveProjectConfigContext(dir);
  if (!configContext.configExists) {
    outputError(
      `No workspace config found in ${configContext.projectRoot}. Run "tmux-ide init" first.`,
      "CONFIG_NOT_FOUND"
    );
  }
  const configDir = configContext.configWriteRoot;
  switch (action) {
    case "dump":
      return dumpConfig(configDir, { json: json2 });
    case "set":
      return setConfig(configDir, args ?? [], { json: json2 });
    case "add-pane":
      return addPane(configDir, args ?? [], { json: json2 });
    case "remove-pane":
      return removePane(configDir, args ?? [], { json: json2 });
    case "add-row":
      return addRow(configDir, args ?? [], { json: json2 });
    case "enable-team":
      return enableTeam(configDir, args ?? [], { json: json2 });
    case "disable-team":
      return disableTeam(configDir, { json: json2 });
    default:
      return dumpConfig(configDir, { json: json2 });
  }
}
function dumpConfig(dir, { json: json2 }) {
  const cfg = readConfigSafe(dir);
  if (cfg === void 0) return;
  if (json2) {
    console.log(JSON.stringify(cfg, null, 2));
  } else {
    console.log(JSON.stringify(cfg, null, 2));
  }
}
function printConfigActionError(err) {
  if (err instanceof CliActionInvocationError) {
    outputError(err.message, err.code.toUpperCase());
  }
  throw err;
}
function coerceConfigValue(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return parseInt(raw);
  return raw;
}
async function tryDispatchConfigAction(dir, { json: json2, action, args }) {
  try {
    if (action === "set") {
      const [dotpath, ...rest] = args;
      if (!dotpath || rest.length === 0) return false;
      const value = coerceConfigValue(rest.join(" "));
      const result = await tryDispatchAction("config.set", { path: dotpath, value }, { cwd: dir });
      if (!result) return false;
      if (json2) console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
      else console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
      return true;
    }
    if (action === "add-pane") {
      const { row, title, command: command2, size } = parseNamedArgs(args);
      if (row === void 0) return false;
      const rowIndex = parseIndex(row);
      if (rowIndex == null) return false;
      const result = await tryDispatchAction(
        "config.addPane",
        { rowIndex, title, command: command2, size },
        { cwd: dir }
      );
      if (!result) return false;
      const pane = { title, command: command2, size };
      if (json2) console.log(JSON.stringify({ ok: true, row: rowIndex, pane }, null, 2));
      else console.log(`Added pane "${title ?? "untitled"}" to row ${rowIndex}`);
      return true;
    }
    if (action === "remove-pane") {
      const { row, pane } = parseNamedArgs(args);
      if (row === void 0 || pane === void 0) return false;
      const rowIndex = parseIndex(row);
      const paneIndex = parseIndex(pane);
      if (rowIndex == null || paneIndex == null) return false;
      const before = readConfigSafe(dir);
      const removed = before?.rows[rowIndex]?.panes[paneIndex] ?? null;
      const result = await tryDispatchAction(
        "config.removePane",
        { rowIndex, paneIndex },
        { cwd: dir }
      );
      if (!result) return false;
      if (json2) {
        console.log(JSON.stringify({ ok: true, row: rowIndex, pane: paneIndex, removed }, null, 2));
      } else {
        console.log(`Removed pane ${paneIndex} from row ${rowIndex}`);
      }
      return true;
    }
    if (action === "add-row") {
      const { size } = parseNamedArgs(args);
      const result = await tryDispatchAction("config.addRow", { size }, { cwd: dir });
      if (!result) return false;
      const row = result.config.rows.length - 1;
      if (json2) console.log(JSON.stringify({ ok: true, row, size: size ?? null }, null, 2));
      else console.log(`Added row ${row}${size ? ` (${size})` : ""}`);
      return true;
    }
    if (action === "enable-team") {
      const { name } = parseNamedArgs(args);
      const result = await tryDispatchAction("config.enableTeam", { name }, { cwd: dir });
      if (!result) return false;
      const teamName = result.config.team?.name ?? name ?? result.config.name ?? "my-team";
      if (json2) console.log(JSON.stringify({ ok: true, team: result.config.team }, null, 2));
      else console.log(`Enabled agent team "${teamName}"`);
      return true;
    }
    if (action === "disable-team") {
      const result = await tryDispatchAction("config.disableTeam", {}, { cwd: dir });
      if (!result) return false;
      if (json2) console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
      else console.log("Disabled agent team");
      return true;
    }
  } catch (err) {
    printConfigActionError(err);
  }
  return false;
}
function setConfig(dir, args, { json: json2 }) {
  const [dotpath, ...rest] = args;
  if (!dotpath || rest.length === 0) {
    outputError("Usage: tmux-ide config set <dotpath> <value>", "USAGE");
    return;
  }
  const value = coerceConfigValue(rest.join(" "));
  withConfig(dir, (cfg) => {
    setByPath(cfg, dotpath, value);
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, path: dotpath, value }, null, 2));
  } else {
    console.log(`Set ${dotpath} = ${JSON.stringify(value)}`);
  }
}
function addPane(dir, args, { json: json2 }) {
  const { row, title, command: command2, size } = parseNamedArgs(args);
  if (row === void 0) {
    outputError(
      "Usage: tmux-ide config add-pane --row <N> --title <T> [--command <C>] [--size <S>]",
      "USAGE"
    );
    return;
  }
  const rowIdx = parseIndex(row);
  if (rowIdx == null) {
    outputError(`Invalid row index "${row}"`, "USAGE");
    return;
  }
  const pane = {};
  if (title) pane.title = title;
  if (command2) pane.command = command2;
  if (size) pane.size = size;
  withConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      outputError("Invalid project config: 'rows' must be an array", "INVALID_CONFIG");
    }
    if (!cfg.rows[rowIdx]) {
      outputError(`Row ${rowIdx} does not exist`, "INVALID_ROW");
    }
    if (!Array.isArray(cfg.rows[rowIdx].panes)) {
      outputError(`Invalid project config: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    }
    cfg.rows[rowIdx].panes.push(pane);
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane }, null, 2));
  } else {
    console.log(`Added pane "${title ?? "untitled"}" to row ${rowIdx}`);
  }
}
function removePane(dir, args, { json: json2 }) {
  const { row, pane } = parseNamedArgs(args);
  if (row === void 0 || pane === void 0) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }
  const rowIdx = parseIndex(row);
  const paneIdx = parseIndex(pane);
  if (rowIdx == null || paneIdx == null) {
    outputError("Usage: tmux-ide config remove-pane --row <N> --pane <M>", "USAGE");
    return;
  }
  let removed;
  withConfig(dir, (cfg) => {
    if (!Array.isArray(cfg.rows)) {
      outputError("Invalid project config: 'rows' must be an array", "INVALID_CONFIG");
    }
    if (!Array.isArray(cfg.rows[rowIdx]?.panes)) {
      outputError(`Invalid project config: row ${rowIdx} panes must be an array`, "INVALID_CONFIG");
    }
    if (!cfg.rows[rowIdx].panes[paneIdx]) {
      outputError(`Pane ${paneIdx} in row ${rowIdx} does not exist`, "INVALID_PANE");
    }
    removed = cfg.rows[rowIdx].panes.splice(paneIdx, 1)[0];
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, pane: paneIdx, removed }, null, 2));
  } else {
    console.log(`Removed pane ${paneIdx} ("${removed?.title ?? "untitled"}") from row ${rowIdx}`);
  }
}
function addRow(dir, args, { json: json2 }) {
  const { size } = parseNamedArgs(args);
  let rowIdx;
  withConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      outputError("Invalid project config: 'rows' must be an array", "INVALID_CONFIG");
    }
    const row = { panes: [{ title: "Shell" }] };
    if (size) row.size = size;
    cfg.rows = cfg.rows ?? [];
    cfg.rows.push(row);
    rowIdx = cfg.rows.length - 1;
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, row: rowIdx, size: size ?? null }, null, 2));
  } else {
    console.log(`Added row ${rowIdx}${size ? ` (${size})` : ""}`);
  }
}
function enableTeam(dir, args, { json: json2 }) {
  const { name } = parseNamedArgs(args);
  let teamName;
  let result;
  withConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      outputError("Invalid project config: 'rows' must be an array", "INVALID_CONFIG");
    }
    teamName = name ?? cfg.name ?? "my-team";
    cfg.team = { name: teamName };
    let leadAssigned = false;
    for (const row of cfg.rows ?? []) {
      for (const pane of row.panes ?? []) {
        if (pane.command === "claude" || pane.role === "lead" || pane.role === "teammate") {
          if (!leadAssigned) {
            pane.role = "lead";
            leadAssigned = true;
          } else {
            pane.role = "teammate";
          }
        }
      }
    }
    if (!leadAssigned) {
      delete cfg.team;
      outputError("Cannot enable agent team: no Claude panes found", "INVALID_CONFIG");
    }
    result = { team: cfg.team, roles: summarizeRoles(cfg) };
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(`Enabled agent team "${teamName}"`);
  }
}
function disableTeam(dir, { json: json2 }) {
  withConfig(dir, (cfg) => {
    if (cfg.rows !== void 0 && !Array.isArray(cfg.rows)) {
      outputError("Invalid project config: 'rows' must be an array", "INVALID_CONFIG");
    }
    delete cfg.team;
    for (const row of cfg.rows ?? []) {
      if (!Array.isArray(row?.panes)) continue;
      for (const pane of row.panes) {
        delete pane.role;
        delete pane.task;
      }
    }
  });
  if (json2) {
    console.log(JSON.stringify({ ok: true, disabled: true }, null, 2));
  } else {
    console.log("Disabled agent team");
  }
}
function summarizeRoles(cfg) {
  const roles = [];
  for (let i = 0; i < (cfg.rows ?? []).length; i++) {
    for (let j = 0; j < (cfg.rows[i].panes ?? []).length; j++) {
      const p = cfg.rows[i].panes[j];
      if (p.role) {
        roles.push({ row: i, pane: j, title: p.title ?? null, role: p.role });
      }
    }
  }
  return roles;
}
function parseNamedArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length) {
      const key = args[i].slice(2);
      result[key] = args[i + 1];
      i++;
    }
  }
  return result;
}
function isConfigObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
function parseIndex(value) {
  if (!/^\d+$/.test(String(value))) return null;
  return Number.parseInt(value, 10);
}
var init_config = __esm({
  "packages/daemon/src/config.ts"() {
    "use strict";
    init_yaml_io();
    init_dot_path();
    init_output();
    init_ide_config2();
    init_cli_action_bridge();
    init_config_context();
  }
});

// package.json
var require_package = __commonJS({
  "package.json"(exports, module) {
    module.exports = {
      name: "tmux-ide",
      version: "2.8.0",
      description: "Turn any project into a tmux-powered terminal IDE with .tmux-ide/workspace.yml",
      type: "module",
      bin: {
        "tmux-ide": "bin/cli.js"
      },
      files: [
        "bin",
        "scripts",
        "skill",
        "templates",
        "packages/daemon/dist",
        "!packages/daemon/dist/tui",
        "packages/daemon/src",
        "bunfig.toml",
        "packages/contracts/src",
        "packages/tmux-bridge/src",
        "packages/tmux-bridge/package.json",
        "packages/contracts/package.json"
      ],
      scripts: {
        build: "pnpm build:cli",
        "build:cli": "node scripts/build-cli.mjs",
        "build:macos-notifier": "node scripts/build-macos-notifier.mjs",
        "build:tui": "bun scripts/build-tui.mjs",
        prepublishOnly: "pnpm build:cli && pnpm check && node scripts/prepublish-check.mjs",
        typecheck: 'echo "root typecheck deferred to per-package turbo run"',
        dev: "node bin/cli.js",
        test: "pnpm -r --filter @tmux-ide/daemon --filter @tmux-ide/contracts --filter @tmux-ide/desktop-renderer --filter @tmux-ide/electron-shell run test",
        "test:unit": "pnpm -r --filter @tmux-ide/daemon --filter @tmux-ide/contracts --filter @tmux-ide/desktop-renderer --filter @tmux-ide/electron-shell run test",
        "test:daemon-bun": "bun test ./packages/daemon/src/lib/canonical-daemon.test.ts ./packages/daemon/src/lib/auth/middleware.test.ts ./packages/daemon/src/command-center/actions/handlers/daemon-shutdown.test.ts",
        lint: "eslint bin scripts packages/contracts/src packages/tmux-bridge/src packages/daemon/src",
        "lint:workspace": "turbo run lint",
        format: "prettier --write .",
        "format:check": "prettier --check .",
        "build:workspace": "turbo run build",
        "build:workbench-dock-web": "pnpm --filter @tmux-ide/daemon run build:workbench-dock-web",
        "test:workbench-dock-package": "pnpm --filter @tmux-ide/daemon run test:workbench-dock-package",
        "typecheck:workspace": "turbo run typecheck",
        "docs:build": "turbo run build --filter=@tmux-ide/docs",
        "pack:check": "npm pack --dry-run --cache /tmp/tmux-ide-npm-cache > /dev/null",
        "test:pack-installed": "node scripts/pack-check-run.mjs",
        "check:native-deps": "node packages/daemon/scripts/check-native-deps.mjs",
        check: "pnpm run lint:workspace && pnpm run format:check && pnpm run typecheck:workspace && pnpm run test:unit && pnpm run test:daemon-bun && pnpm run test:tui-renderer && pnpm run test:workbench-dock-package && pnpm run docs:build && pnpm run pack:check && pnpm run test:pack-installed && pnpm run check:native-deps",
        postinstall: "node scripts/postinstall.js",
        docs: "turbo run dev --filter=@tmux-ide/docs",
        "test:tui-renderer": "bun test --preload @opentui/solid/preload ./packages/daemon/src/tui/mirror/missions-surface-renderer.test.tsx ./packages/daemon/src/tui/mirror/recipes-gallery-renderer.test.tsx ./packages/daemon/src/tui/mirror/shell-chrome-renderer.test.tsx ./packages/daemon/src/tui/mirror/home-files-surface-renderer.test.tsx ./packages/daemon/src/tui/mirror/changes-terminal-surface-renderer.test.tsx ./packages/daemon/src/tui/mirror/activity-surface-renderer.test.tsx ./packages/daemon/src/tui/mirror/workspace/application-shell-renderer.test.tsx ./packages/daemon/src/tui/mirror/workspace/pane-frame-renderer.test.tsx ./packages/daemon/src/tui/mirror/workspace/workbench-shell-renderer.test.tsx ./packages/daemon/src/tui/mirror/workspace/workbench-dock-dual-host-renderer.test.tsx ./packages/daemon/src/tui/mirror/workspace/agent-terminal-canvas-renderer.test.tsx ./packages/daemon/src/tui/mirror/workspace/command-palette-surface-renderer.test.tsx",
        "test:tui-smoke": "node scripts/smoke-tui-missions.mjs"
      },
      keywords: [
        "tmux",
        "ide",
        "terminal",
        "workspace",
        "developer-tools"
      ],
      engines: {
        node: ">=20"
      },
      repository: {
        type: "git",
        url: "git+https://github.com/wavyrai/tmux-ide.git"
      },
      homepage: "https://github.com/wavyrai/tmux-ide#readme",
      bugs: {
        url: "https://github.com/wavyrai/tmux-ide/issues"
      },
      license: "MIT",
      packageManager: "pnpm@10.21.0",
      dependencies: {
        "@hono/node-server": "^1.19.11",
        "@hono/zod-validator": "^0.7.6",
        "@opentui/core": "^0.4.3",
        "@opentui/solid": "^0.4.3",
        "@parcel/watcher": "^2.5.6",
        "@types/ws": "^8.18.1",
        hono: "^4.12.8",
        ignore: "^7.0.5",
        "js-yaml": "^4.1.1",
        "node-pty": "1.2.0-beta.12",
        "solid-js": "1.9.12",
        ws: "^8.20.0",
        zod: "^4.3.6"
      },
      pnpm: {
        onlyBuiltDependencies: [
          "@parcel/watcher",
          "esbuild",
          "node-pty"
        ],
        overrides: {
          zod: "^4.3.6"
        }
      },
      devDependencies: {
        "@eslint/js": "^10.0.1",
        "@tsconfig/bun": "^1.0.10",
        "@types/node": "^25.5.0",
        "@typescript-eslint/eslint-plugin": "^8.57.1",
        "@typescript-eslint/parser": "^8.57.1",
        "@vitest/coverage-v8": "^4.1.6",
        esbuild: "0.27.4",
        eslint: "^10.0.3",
        globals: "^17.4.0",
        prettier: "^3.8.1",
        turbo: "^2.3.3",
        typescript: "^5.9.3",
        vitest: "^4.1.0"
      },
      optionalDependencies: {
        "@opentui/core-darwin-arm64": "^0.4.3"
      }
    };
  }
});

// packages/daemon/src/tui/team/report.ts
var report_exports = {};
__export(report_exports, {
  findSessionStatus: () => findSessionStatus,
  toFleetJson: () => toFleetJson
});
function toFleetJson(projects) {
  return {
    projects: projects.map((p) => ({
      name: p.name,
      dir: p.dir,
      registered: p.registered,
      running: p.running,
      status: p.status,
      sessions: p.sessions.map((s) => ({
        name: s.name,
        status: s.status,
        panes: s.panes,
        attached: s.attached,
        windows: (s.windowList ?? []).map((w) => ({
          index: w.index,
          name: w.name,
          active: w.active,
          panes: w.panes,
          status: w.status
        })),
        // A pre-agents TeamSession (older constructor/test) yields `[]` — the
        // contract always exposes the array.
        agents: s.agents ?? []
      }))
    }))
  };
}
function findSessionStatus(sessions, name) {
  const match = sessions.find((s) => s.name === name);
  return match ? match.status : null;
}
var init_report = __esm({
  "packages/daemon/src/tui/team/report.ts"() {
    "use strict";
  }
});

// packages/daemon/src/control/frames.ts
function encodeFrame(message) {
  return `${JSON.stringify(message)}
`;
}
function createFrameSplitter() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    if (buffer.length > MAX_FRAME_BYTES) {
      buffer = "";
      throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes without a newline`);
    }
    return parts.filter((line) => line.trim().length > 0);
  };
}
var MAX_FRAME_BYTES;
var init_frames = __esm({
  "packages/daemon/src/control/frames.ts"() {
    "use strict";
    MAX_FRAME_BYTES = 4 * 1024 * 1024;
  }
});

// packages/daemon/src/control/dispatch.ts
function extractId(value) {
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = value.id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}
async function dispatchLine(line, handlers, ctx) {
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail(null, "bad-request", "frame is not valid JSON");
  }
  const parsed = controlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      extractId(raw),
      "bad-request",
      `invalid request envelope (need {v:${CONTROL_PROTOCOL_VERSION}, id, verb})`
    );
  }
  const { id, verb, params } = parsed.data;
  const handler = handlers[verb];
  if (!handler) {
    return fail(id, "unknown-verb", `unknown verb "${verb}"`);
  }
  try {
    return ok(id, await handler(params ?? {}, ctx));
  } catch (err) {
    if (err instanceof ControlVerbError) return fail(id, err.code, err.message);
    if (err instanceof IdeError) {
      const code = err.code === "USAGE" ? "bad-request" : "not-found";
      return fail(id, code, err.message);
    }
    return fail(id, "internal", err?.message ?? "internal error");
  }
}
var ControlVerbError, ok, fail;
var init_dispatch = __esm({
  "packages/daemon/src/control/dispatch.ts"() {
    "use strict";
    init_src();
    init_errors2();
    ControlVerbError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
    ok = (id, data) => ({
      v: CONTROL_PROTOCOL_VERSION,
      id,
      ok: true,
      data
    });
    fail = (id, code, message) => ({
      v: CONTROL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: { code, message }
    });
  }
});

// packages/daemon/src/control/fanout.ts
function createFanout(edges = {}) {
  const sinks = /* @__PURE__ */ new Set();
  const remove = (sink) => {
    if (!sinks.delete(sink)) return;
    if (sinks.size === 0) edges.onLast?.();
  };
  return {
    add(sink) {
      sinks.add(sink);
      if (sinks.size === 1) edges.onFirst?.();
      return () => remove(sink);
    },
    emit(event) {
      for (const sink of [...sinks]) {
        try {
          sink(event);
        } catch {
          remove(sink);
        }
      }
    },
    size: () => sinks.size
  };
}
var init_fanout = __esm({
  "packages/daemon/src/control/fanout.ts"() {
    "use strict";
  }
});

// packages/daemon/src/agent-explain.ts
var agent_explain_exports = {};
__export(agent_explain_exports, {
  agentExplain: () => agentExplain,
  buildReport: () => buildReport,
  renderReport: () => renderReport
});
import { execFileSync as execFileSync14 } from "node:child_process";
function tmux4(args) {
  try {
    return execFileSync14("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function readPaneInfo(target) {
  const fmt = "#{pane_id}	#{pane_pid}	#{pane_current_command}	#{@agent_state}	#{@agent_hint}	#{pane_title}";
  const raw = tmux4(["display-message", "-p", "-t", target, "-F", fmt]);
  if (!raw) return null;
  const [id = "", pid = "", cmd = "", authorityRaw = "", hintRaw = "", ...titleParts] = raw.split("	");
  if (!id) return null;
  return {
    id,
    pid: Number(pid) || 0,
    cmd,
    authorityRaw,
    hintRaw,
    title: titleParts.join("	")
  };
}
function buildReport(target) {
  const info = readPaneInfo(target);
  if (!info) {
    throw new IdeError(
      `No pane found for "${target}". Pass a pane id (%N) or a live session name.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  const nowSec = Math.floor(Date.now() / 1e3);
  const authRaw = info.authorityRaw || null;
  let authState = null;
  let authEpoch = null;
  let ageSeconds = null;
  let stale = false;
  if (authRaw) {
    const sep3 = authRaw.lastIndexOf(":");
    if (sep3 !== -1) {
      authState = authRaw.slice(0, sep3);
      const epoch = Number(authRaw.slice(sep3 + 1));
      if (Number.isFinite(epoch)) {
        authEpoch = epoch;
        ageSeconds = nowSec - epoch;
        stale = (authState === "working" || authState === "blocked") && ageSeconds > AUTHORITY_STALE_SECONDS2;
      }
    }
  }
  const verdict = parseAuthority(info.authorityRaw, nowSec);
  const manifests = getManifests();
  const table = readProcessTable();
  const resolved2 = resolveAgentCommand(info.cmd, info.pid, table, {
    manifests,
    hint: info.hintRaw
  });
  const manifest = resolved2.manifest;
  const subtree = manifest ? [] : describeSubtree(table, info.pid);
  const snapshot = { ...readPaneSnapshot(info.id), title: info.title };
  const explained = manifest ? explain(snapshot, manifest) : {
    state: null,
    checked: []
  };
  const instant = classifyInstant(snapshot, manifest);
  const classification = verdict ?? instant;
  return {
    pane: { id: info.id, cmd: info.cmd, pid: info.pid, title: info.title },
    authority: {
      raw: authRaw,
      state: authState,
      epoch: authEpoch,
      ageSeconds,
      stale,
      verdict
    },
    hint: { raw: info.hintRaw || null, applied: resolved2.source === "hint" },
    resolution: {
      manifestId: manifest?.id ?? null,
      matchedCommand: resolved2.matchedCommand,
      source: resolved2.source,
      confidence: manifest ? manifest.confidence ?? "conservative" : null,
      subtree
    },
    states: explained.checked,
    winner: explained.state,
    instant,
    classification,
    bottomLines: snapshot.bottomNonEmpty.slice(-5)
  };
}
function renderReport(r, opts = {}) {
  const color3 = opts.color ?? !("NO_COLOR" in process.env);
  const c = (code, s) => color3 ? `${code}${s}\x1B[0m` : s;
  const bold4 = (s) => c("\x1B[1m", s);
  const dim4 = (s) => c("\x1B[2m", s);
  const label = (s) => c("\x1B[36m", s);
  const status2 = (s) => c(STATUS_COLOR[s] ?? "", s);
  const yesno = (v) => v ? c("\x1B[32m", "yes") : dim4("no");
  const out = [];
  out.push(bold4(`agent explain \u2014 ${r.pane.id}`));
  out.push(`  ${label("command")}   ${r.pane.cmd}  ${dim4(`(pid ${r.pane.pid})`)}`);
  if (r.pane.title) out.push(`  ${label("title")}     ${r.pane.title}`);
  if (r.authority.raw) {
    const age = r.authority.ageSeconds !== null ? ` ${dim4(`(${r.authority.ageSeconds}s ago)`)}` : "";
    const staleTag = r.authority.stale ? " " + c("\x1B[31m", "[STALE \u2192 ignored]") : "";
    const verdict = r.authority.verdict ? status2(r.authority.verdict) : dim4("none (stale/malformed)");
    out.push(`  ${label("authority")} ${r.authority.raw}${age}${staleTag} \u2192 ${verdict}`);
  } else {
    out.push(`  ${label("authority")} ${dim4("(unset \u2014 falling back to scraping)")}`);
  }
  if (r.hint.raw) {
    out.push(
      `  ${label("hint")}      @agent_hint=${r.hint.raw} \u2192 ${yesno(r.hint.applied)} applied`
    );
  } else {
    out.push(`  ${label("hint")}      ${dim4("(unset)")}`);
  }
  if (r.resolution.manifestId) {
    const conf = r.resolution.confidence === "tuned" ? c("\x1B[32m", "tuned") : dim4(r.resolution.confidence ?? "conservative");
    out.push(
      `  ${label("manifest")}  ${r.resolution.manifestId}  ${dim4(`via ${r.resolution.source}` + (r.resolution.matchedCommand ? ` "${r.resolution.matchedCommand}"` : ""))}  [${conf}]`
    );
  } else {
    const saw = r.resolution.subtree.length > 0 ? r.resolution.subtree.join(", ") : r.pane.cmd || "(nothing)";
    out.push(`  ${label("manifest")}  ${dim4("none matched")} \u2014 ${dim4(`process-tree saw: ${saw}`)}`);
    out.push(`            ${dim4("set `tmux set-option -p @agent_hint <agent>` to force one")}`);
  }
  out.push("");
  out.push(bold4("  state rules"));
  if (r.states.length === 0) {
    out.push(`    ${dim4("(no manifest resolved \u2014 nothing to evaluate)")}`);
  } else {
    for (const s of r.states) {
      const mark = s.matched ? c("\x1B[32m", "\u2713 matched") : dim4("\xB7 no match");
      const win = r.winner === s.state ? "  " + c("\x1B[1m", "\u2190 winner") : "";
      out.push(`    ${s.state.padEnd(8)} ${mark}${win}`);
    }
  }
  out.push("");
  out.push(
    `  ${bold4("classification")}  ${status2(r.classification)}  ${dim4(`(instant: ${r.instant})`)}`
  );
  out.push("");
  out.push(bold4("  bottom 5 lines judged"));
  if (r.bottomLines.length === 0) {
    out.push(`    ${dim4("(empty capture)")}`);
  } else {
    for (const line of r.bottomLines) out.push(`    ${dim4("\u2502")} ${line}`);
  }
  return out.join("\n");
}
function agentExplain(target, opts = {}) {
  const report = buildReport(target);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }
}
var AUTHORITY_STALE_SECONDS2, STATUS_COLOR;
var init_agent_explain = __esm({
  "packages/daemon/src/agent-explain.ts"() {
    "use strict";
    init_manifest();
    init_classify();
    init_manifest_loader();
    init_process_tree();
    init_snapshot();
    init_errors2();
    AUTHORITY_STALE_SECONDS2 = 600;
    STATUS_COLOR = {
      blocked: "\x1B[31m",
      // red
      working: "\x1B[33m",
      // yellow
      done: "\x1B[32m",
      // green
      idle: "\x1B[36m",
      // cyan
      unknown: "\x1B[90m"
      // grey
    };
  }
});

// packages/daemon/src/tui/team/wait.ts
var wait_exports = {};
__export(wait_exports, {
  WAIT_DEFAULT_TIMEOUT_MS: () => WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_OUTPUT_POLL_MS: () => WAIT_OUTPUT_POLL_MS,
  WAIT_STATUS_POLL_MS: () => WAIT_STATUS_POLL_MS,
  matchOutput: () => matchOutput,
  waitForAgentStatus: () => waitForAgentStatus,
  waitForOutputMatch: () => waitForOutputMatch
});
function matchOutput(text, pattern) {
  const lines = text.split("\n");
  for (const line of lines) {
    if (new RegExp(pattern).test(line)) return line;
  }
  if (new RegExp(pattern).test(text)) return lines[lines.length - 1] ?? "";
  return null;
}
async function waitForAgentStatus(session, want, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? WAIT_STATUS_POLL_MS;
  const tracker = opts.tracker ?? createStatusTracker();
  const list = opts.listSessions ?? listTeamSessions;
  const now = opts.now ?? Date.now;
  const sleep2 = opts.sleep ?? sleepMs3;
  const started = now();
  for (; ; ) {
    const status2 = findSessionStatus(list(tracker), session);
    if (status2 === want) return { ok: true, session, want, status: status2 };
    if (now() - started >= timeoutMs) {
      return { ok: false, session, want, status: status2, timedOutAfterMs: timeoutMs };
    }
    await sleep2(pollMs);
  }
}
async function waitForOutputMatch(target, pattern, opts = {}) {
  new RegExp(pattern);
  const timeoutMs = opts.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? WAIT_OUTPUT_POLL_MS;
  const capture = opts.capture ?? defaultCapture;
  const now = opts.now ?? Date.now;
  const sleep2 = opts.sleep ?? sleepMs3;
  const started = now();
  for (; ; ) {
    let text = "";
    try {
      text = capture(target);
    } catch {
    }
    const matched = matchOutput(text, pattern);
    if (matched !== null) return { ok: true, target, pattern, matched };
    if (now() - started >= timeoutMs) {
      return { ok: false, target, pattern, matched: null, timedOutAfterMs: timeoutMs };
    }
    await sleep2(pollMs);
  }
}
function defaultCapture(target) {
  return capturePane(target, { lines: 200 });
}
var WAIT_DEFAULT_TIMEOUT_MS, WAIT_STATUS_POLL_MS, WAIT_OUTPUT_POLL_MS, sleepMs3;
var init_wait = __esm({
  "packages/daemon/src/tui/team/wait.ts"() {
    "use strict";
    init_src2();
    init_classify();
    init_report();
    init_sessions2();
    WAIT_DEFAULT_TIMEOUT_MS = 6e4;
    WAIT_STATUS_POLL_MS = 750;
    WAIT_OUTPUT_POLL_MS = 500;
    sleepMs3 = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// packages/daemon/src/tui/team/home.ts
var ROLLUP_ORDER;
var init_home = __esm({
  "packages/daemon/src/tui/team/home.ts"() {
    "use strict";
    init_grammar();
    init_panels();
    ROLLUP_ORDER = ["blocked", "working", "done", "idle"];
  }
});

// packages/daemon/src/tui/mirror/agent-rows.ts
var STATE_RANK;
var init_agent_rows = __esm({
  "packages/daemon/src/tui/mirror/agent-rows.ts"() {
    "use strict";
    init_home();
    STATE_RANK = (() => {
      const rank = {};
      ROLLUP_ORDER.forEach((s, i) => rank[s] = i);
      rank.unknown = ROLLUP_ORDER.length;
      return rank;
    })();
  }
});

// packages/daemon/src/tui/mirror/agent-lifecycle.ts
function launchCommandFor(kind, manifests) {
  const mapped = AGENT_LAUNCH_COMMANDS[kind];
  if (mapped) return mapped;
  const m = manifests.find((x) => x.id === kind);
  return m?.commands[0] ?? kind;
}
function spawnAgentArgs(placement, target, dir, command2) {
  const cd = dir ? ["-c", dir] : [];
  if (placement === "window") {
    return ["new-window", "-t", `${target.session}:`, ...PRINT_PANE_ID, ...cd, command2];
  }
  const flag = placement === "split-h" ? "-h" : "-v";
  return [
    "split-window",
    flag,
    "-t",
    target.paneId ?? `${target.session}:`,
    ...PRINT_PANE_ID,
    ...cd,
    command2
  ];
}
function spawnSessionArgs(name, dir, command2) {
  return ["new-session", "-d", "-s", name, ...PRINT_PANE_ID, ...dir ? ["-c", dir] : [], command2];
}
function isShellCommand(command2, manifests) {
  const name = command2.replace(/^-/, "").split("/").pop() ?? command2;
  const shell = manifests.find((m) => m.id === "shell");
  return [...shell?.commands ?? [], ...EXTRA_SHELLS].includes(name);
}
function paneHostsShell(startCommand, manifests) {
  const first = startCommand.trim().split(/\s+/)[0] ?? "";
  if (first.length === 0) return true;
  return isShellCommand(first, manifests);
}
function respawnArgs(paneId, command2, dir) {
  return ["respawn-pane", "-k", "-t", paneId, ...dir ? ["-c", dir] : [], command2];
}
function interruptArgs(paneId) {
  return ["send-keys", "-t", paneId, "C-c"];
}
function relaunchArgs(paneId, command2) {
  return [
    ["send-keys", "-t", paneId, "-l", command2],
    ["send-keys", "-t", paneId, "Enter"]
  ];
}
function clearAuthorityArgs(paneId) {
  return [
    ["set-option", "-p", "-t", paneId, "-u", "@agent_state"],
    ["set-option", "-p", "-t", paneId, "-u", "@agent_session_id"]
  ];
}
var AGENT_LAUNCH_COMMANDS, PRINT_PANE_ID, EXTRA_SHELLS, INTERRUPT_TAP_GAP_MS, RESTART_GRACE_MS;
var init_agent_lifecycle = __esm({
  "packages/daemon/src/tui/mirror/agent-lifecycle.ts"() {
    "use strict";
    init_agent_rows();
    AGENT_LAUNCH_COMMANDS = {
      claude: "claude",
      codex: "codex",
      opencode: "opencode",
      gemini: "gemini",
      aider: "aider",
      copilot: "copilot",
      cursor: "cursor-agent",
      goose: "goose",
      amp: "amp",
      // M25.4 breadth — real installable CLIs only (spawn-picker honesty), each
      // verified against an installer/package: devin (curl cli.devin.ai), kimi
      // (curl code.kimi.com), pi (npm @mariozechner/pi-coding-agent), grok (npm
      // @vibe-kit/grok-cli), kiro (curl cli.kiro.dev → kiro-cli), cline (npm
      // cline), droid (verified live — Factory CLI, own process), kilo (npm
      // @kilocode/cli; the manifest matches its ".kilo" platform binary too).
      devin: "devin",
      kimi: "kimi",
      pi: "pi",
      grok: "grok",
      kiro: "kiro-cli",
      cline: "cline",
      droid: "droid",
      kilo: "kilo"
    };
    PRINT_PANE_ID = ["-P", "-F", "#{pane_id}"];
    EXTRA_SHELLS = ["dash", "ksh", "tcsh", "csh"];
    INTERRUPT_TAP_GAP_MS = 250;
    RESTART_GRACE_MS = 1e3;
  }
});

// packages/daemon/src/control/lifecycle.ts
import { execFile as execFile3 } from "node:child_process";
function tmuxRun(args) {
  return new Promise((resolve29, reject) => {
    execFile3("tmux", args, (err, stdout) => err ? reject(err) : resolve29(stdout.trimEnd()));
  });
}
async function tmuxTry(args) {
  await tmuxRun(args).catch(() => {
  });
}
function resolveLaunchCommand(params) {
  if (params.command) return params.command;
  return launchCommandFor(params.kind, getManifests());
}
async function spawnAgent(params) {
  const dir = params.dir ?? null;
  const argv = params.session ? spawnAgentArgs(
    params.placement ?? "window",
    { session: params.session, paneId: params.paneId },
    dir,
    params.command
  ) : spawnSessionArgs(params.sessionName, dir, params.command);
  const [subcommand, ...rest] = argv;
  let paneId;
  try {
    paneId = await tmuxRun([subcommand, "-P", "-F", "#{pane_id}", ...rest]);
  } catch (err) {
    throw new ControlVerbError("not-found", `tmux refused to spawn: ${err.message}`);
  }
  const session = params.session ?? params.sessionName;
  if (!params.session) await tmuxTry(["set-environment", "-t", session, "TMUX_IDE", "1"]);
  return {
    paneId,
    session,
    command: params.command,
    placement: params.session ? params.placement ?? "window" : "new-session"
  };
}
async function interruptAgent(paneId) {
  await tmuxTry(interruptArgs(paneId));
  await sleep(INTERRUPT_TAP_GAP_MS);
  await tmuxTry(interruptArgs(paneId));
}
async function clearAgentAuthority(paneId) {
  for (const args of clearAuthorityArgs(paneId)) await tmuxTry(args);
}
function paneStartAndPath(paneId) {
  return tmuxRun(["display", "-p", "-t", paneId, "#{pane_start_command}	#{pane_current_path}"]).then((out) => {
    const [start2 = "", path2 = ""] = out.split("	");
    return { start: start2, path: path2 };
  }).catch(() => null);
}
async function stopAgent(paneId) {
  const live = await paneStartAndPath(paneId);
  if (!live) throw new ControlVerbError("not-found", `no pane "${paneId}"`);
  await interruptAgent(paneId);
  await clearAgentAuthority(paneId);
  return { paneId, stopped: true };
}
async function restartAgent(paneId, command2) {
  const live = await paneStartAndPath(paneId);
  if (!live) throw new ControlVerbError("not-found", `no pane "${paneId}"`);
  if (paneHostsShell(live.start, getManifests())) {
    await interruptAgent(paneId);
    await clearAgentAuthority(paneId);
    await sleep(RESTART_GRACE_MS);
    for (const args of relaunchArgs(paneId, command2)) await tmuxTry(args);
    return { paneId, command: command2, strategy: "relaunch" };
  }
  await clearAgentAuthority(paneId);
  await tmuxTry(respawnArgs(paneId, command2, live.path || null));
  return { paneId, command: command2, strategy: "respawn" };
}
var sleep;
var init_lifecycle = __esm({
  "packages/daemon/src/control/lifecycle.ts"() {
    "use strict";
    init_agent_lifecycle();
    init_manifest_loader();
    init_dispatch();
    sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  }
});

// packages/daemon/src/control/verbs.ts
function parse(schema, params) {
  const result = schema.safeParse(params);
  if (!result.success) {
    const issue = result.error.issues[0];
    const at = issue?.path?.length ? ` at ${issue.path.join(".")}` : "";
    throw new ControlVerbError("bad-request", `invalid params${at}: ${issue?.message ?? "?"}`);
  }
  return result.data;
}
function createVerbHandlers(ctx) {
  return {
    fleet: () => toFleetJson(listTeamProjects(ctx.tracker)),
    agents: (params) => {
      const p = parse(agentsParamsSchema, params);
      const sessions = listTeamSessions(ctx.tracker);
      const scoped = p.session ? sessions.filter((s) => s.name === p.session) : sessions;
      if (p.session && scoped.length === 0) {
        throw new ControlVerbError("not-found", `no session "${p.session}"`);
      }
      return { agents: scoped.flatMap((s) => s.agents ?? []) };
    },
    send: (params) => {
      const p = parse(sendParamsSchema, params);
      return deliverMessage(p);
    },
    wait: async (params) => {
      const p = parse(waitParamsSchema, params);
      if (p.kind === "output") {
        try {
          new RegExp(p.match);
        } catch (err) {
          throw new ControlVerbError(
            "bad-request",
            `invalid match regex: ${err.message}`
          );
        }
      }
      const result = p.kind === "agent-status" ? await waitForAgentStatus(p.session, p.status, { timeoutMs: p.timeoutMs }) : await waitForOutputMatch(p.target, p.match, { timeoutMs: p.timeoutMs });
      if (!result.ok) {
        const what = p.kind === "agent-status" ? `"${p.session}" to reach status "${p.status}"` : `${p.target} output to match /${p.match}/`;
        throw new ControlVerbError(
          "timeout",
          `timed out after ${result.timedOutAfterMs}ms waiting for ${what}`
        );
      }
      return result;
    },
    spawn: (params) => {
      const p = parse(spawnParamsSchema, params);
      return spawnAgent({ ...p, command: resolveLaunchCommand(p) });
    },
    "restart-agent": (params) => {
      const p = parse(restartAgentParamsSchema, params);
      return restartAgent(p.paneId, resolveLaunchCommand(p));
    },
    "stop-agent": (params) => {
      const p = parse(stopAgentParamsSchema, params);
      return stopAgent(p.paneId);
    },
    explain: (params) => {
      const p = parse(explainParamsSchema, params);
      return buildReport(p.target);
    },
    subscribe: (_params, verbCtx) => {
      verbCtx.subscribe();
      return { subscribed: true, events: ["agent-status"] };
    }
  };
}
var init_verbs = __esm({
  "packages/daemon/src/control/verbs.ts"() {
    "use strict";
    init_src();
    init_agent_explain();
    init_send();
    init_report();
    init_projects();
    init_sessions2();
    init_wait();
    init_dispatch();
    init_lifecycle();
  }
});

// packages/daemon/src/control/server.ts
var server_exports2 = {};
__export(server_exports2, {
  defaultControlSocketPath: () => defaultControlSocketPath,
  startControlServer: () => startControlServer
});
import { chmodSync as chmodSync5, existsSync as existsSync33, mkdirSync as mkdirSync21, statSync as statSync6, unlinkSync as unlinkSync2 } from "node:fs";
import { createServer as createServer2, connect } from "node:net";
import { dirname as dirname29, join as join31 } from "node:path";
function defaultControlSocketPath() {
  return join31(tuiStateHome(), "control.sock");
}
async function claimSocketPath(path2) {
  if (!existsSync33(path2)) return;
  if (!statSync6(path2).isSocket()) {
    throw new IdeError(
      `${path2} exists and is not a socket \u2014 refusing to remove it. Pass a different --socket path.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  const alive = await new Promise((resolve29) => {
    const probe = connect(path2);
    const done = (result) => {
      probe.destroy();
      resolve29(result);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(500, () => done(false));
  });
  if (alive) {
    throw new IdeError(`another server is already listening on ${path2}`, {
      code: "USAGE",
      exitCode: 1
    });
  }
  unlinkSync2(path2);
}
async function startControlServer(opts = {}) {
  const socketPath = opts.socketPath ?? defaultControlSocketPath();
  const log = opts.log ?? (() => {
  });
  const tickMs = opts.tickMs ?? TICK_MS;
  mkdirSync21(dirname29(socketPath), { recursive: true });
  await claimSocketPath(socketPath);
  const tracker = createStatusTracker();
  const handlers = createVerbHandlers({ tracker });
  const prevState = /* @__PURE__ */ new Map();
  let timer = null;
  const tick = () => {
    try {
      const { events, state } = diffFleet(prevState, fleetStatuses(listTeamProjects(tracker)));
      prevState.clear();
      for (const [name, status2] of state) prevState.set(name, status2);
      const ts = (/* @__PURE__ */ new Date()).toISOString();
      for (const ev of events) fanout.emit({ ts, ...ev });
    } catch (err) {
      log(`event tick failed: ${err.message}`);
    }
  };
  const fanout = createFanout({
    onFirst: () => {
      tick();
      timer = setInterval(tick, tickMs);
    },
    onLast: () => {
      if (timer) clearInterval(timer);
      timer = null;
      prevState.clear();
    }
  });
  const connections = /* @__PURE__ */ new Set();
  const server = createServer2((conn) => {
    connections.add(conn);
    conn.setEncoding("utf8");
    const split = createFrameSplitter();
    let unsubscribe = null;
    const push = (ev) => {
      conn.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, event: "agent-status", data: ev }));
    };
    const ctx = {
      subscribe: () => {
        unsubscribe ??= fanout.add(push);
      }
    };
    conn.on("data", (chunk) => {
      let lines;
      try {
        lines = split(chunk);
      } catch {
        conn.destroy();
        return;
      }
      for (const line of lines) {
        void dispatchLine(line, handlers, ctx).then((response) => {
          if (!conn.destroyed) conn.write(encodeFrame(response));
        });
      }
    });
    conn.on("close", () => {
      unsubscribe?.();
      connections.delete(conn);
    });
    conn.on("error", () => {
    });
  });
  await new Promise((resolve29, reject) => {
    server.once("error", (err) => {
      if ((err.code === "EINVAL" || err.code === "ENAMETOOLONG") && socketPath.length > 100) {
        reject(
          new IdeError(
            `socket path is too long for a Unix socket (${socketPath.length} chars; the OS caps it around 104): ${socketPath}
Pass a shorter path: tmux-ide serve --socket /tmp/tmux-ide-control.sock`,
            { code: "USAGE", exitCode: 1 }
          )
        );
        return;
      }
      reject(err);
    });
    server.listen(socketPath, () => {
      server.removeAllListeners("error");
      resolve29();
    });
  });
  chmodSync5(socketPath, 384);
  log(`listening on ${socketPath}`);
  return {
    socketPath,
    close: () => new Promise((resolve29) => {
      if (timer) clearInterval(timer);
      timer = null;
      for (const conn of connections) conn.destroy();
      server.close(() => {
        try {
          unlinkSync2(socketPath);
        } catch {
        }
        resolve29();
      });
    })
  };
}
var init_server2 = __esm({
  "packages/daemon/src/control/server.ts"() {
    "use strict";
    init_src();
    init_errors2();
    init_tui_binary();
    init_classify();
    init_events();
    init_updater();
    init_projects();
    init_dispatch();
    init_fanout();
    init_frames();
    init_verbs();
  }
});

// packages/daemon/src/control/client.ts
var client_exports = {};
__export(client_exports, {
  ControlRequestError: () => ControlRequestError,
  connectControl: () => connectControl
});
import { connect as connect2 } from "node:net";
function connectControl(opts = {}) {
  const path2 = opts.socketPath ?? defaultControlSocketPath();
  return new Promise((resolve29, reject) => {
    const socket = connect2(path2);
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.removeListener("error", reject);
      resolve29(wrap(socket));
    });
  });
}
function wrap(socket) {
  socket.setEncoding("utf8");
  const split = createFrameSplitter();
  const pending = /* @__PURE__ */ new Map();
  const eventSinks = [];
  let nextId = 1;
  let markDone;
  const done = new Promise((r) => {
    markDone = r;
  });
  socket.on("data", (chunk) => {
    for (const line of split(chunk)) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const event = controlEventSchema.safeParse(raw);
      if (event.success) {
        for (const sink of eventSinks) sink(event.data);
        continue;
      }
      const response = controlResponseSchema.safeParse(raw);
      if (!response.success || response.data.id === null) continue;
      const waiter = pending.get(response.data.id);
      if (!waiter) continue;
      pending.delete(response.data.id);
      if (response.data.ok) waiter.resolve(response.data.data);
      else {
        waiter.reject(
          new ControlRequestError(response.data.error.code, response.data.error.message)
        );
      }
    }
  });
  const teardown = () => {
    for (const { reject } of pending.values()) {
      reject(new ControlRequestError("disconnected", "control socket closed"));
    }
    pending.clear();
    markDone();
  };
  socket.on("close", teardown);
  socket.on("error", () => {
  });
  const request = (verb, params) => {
    const id = nextId++;
    return new Promise((resolve29, reject) => {
      if (socket.destroyed) {
        reject(new ControlRequestError("disconnected", "control socket closed"));
        return;
      }
      pending.set(id, { resolve: resolve29, reject });
      socket.write(encodeFrame({ v: CONTROL_PROTOCOL_VERSION, id, verb, params }));
    });
  };
  return {
    request,
    subscribe: async (onEvent) => {
      eventSinks.push(onEvent);
      await request("subscribe");
    },
    close: () => socket.destroy(),
    done
  };
}
var ControlRequestError;
var init_client = __esm({
  "packages/daemon/src/control/client.ts"() {
    "use strict";
    init_src();
    init_frames();
    init_server2();
    ControlRequestError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    };
  }
});

// packages/daemon/src/lib/worktree.ts
var worktree_exports = {};
__export(worktree_exports, {
  WorktreeError: () => WorktreeError,
  _setGitRunnerForTests: () => _setGitRunnerForTests,
  createWorktree: () => createWorktree,
  defaultWorktreeBaseDir: () => defaultWorktreeBaseDir,
  listWorktrees: () => listWorktrees,
  mapWorktreeError: () => mapWorktreeError,
  parseWorktreeList: () => parseWorktreeList,
  removeWorktree: () => removeWorktree,
  worktreePath: () => worktreePath,
  worktreeSessionName: () => worktreeSessionName
});
import { execFileSync as execFileSync15 } from "node:child_process";
import { basename as basename9, dirname as dirname30, isAbsolute as isAbsolute7, join as join32, resolve as resolve27 } from "node:path";
function sanitizeForTmux(part) {
  return part.replace(/[.:/\s]+/g, "-");
}
function worktreeSessionName(project, branch) {
  return `${sanitizeForTmux(project)}@${sanitizeForTmux(branch)}`;
}
function defaultWorktreeBaseDir(repoDir) {
  const abs = resolve27(repoDir);
  return join32(dirname30(abs), `${basename9(abs)}-worktrees`);
}
function worktreePath(repoDir, branch, configuredDir) {
  const base = configuredDir && configuredDir.length > 0 ? isAbsolute7(configuredDir) ? configuredDir : resolve27(repoDir, configuredDir) : defaultWorktreeBaseDir(repoDir);
  return join32(base, branch);
}
function parseWorktreeList(porcelain) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }
  flush();
  return entries;
}
function mapWorktreeError(stderr, fallbackMessage) {
  const text = stderr.trim();
  const lower = text.toLowerCase();
  if (lower.includes("not a git repository")) {
    return new WorktreeError(
      "Not a git repository. Run `tmux-ide worktree` from inside a git repo.",
      "NOT_A_GIT_REPO"
    );
  }
  if (lower.includes("already exists") && lower.includes("branch")) {
    return new WorktreeError(
      `${text}
Use \`tmux-ide worktree create <branch>\` without --from to check out the existing branch, or pick a new name.`,
      "BRANCH_EXISTS"
    );
  }
  if (lower.includes("is already checked out") || lower.includes("already used by worktree")) {
    return new WorktreeError(text, "ALREADY_CHECKED_OUT");
  }
  if (lower.includes("already exists")) {
    return new WorktreeError(text, "WORKTREE_EXISTS");
  }
  if ((lower.includes("invalid reference") || lower.includes("not a valid ref")) && !lower.includes("already")) {
    return new WorktreeError(text, "BRANCH_NOT_FOUND");
  }
  if (lower.includes("contains modified or untracked files") || lower.includes("use --force") || lower.includes("use 'remove -f'")) {
    return new WorktreeError(
      `${text}
Re-run with --force to discard those changes.`,
      "WORKTREE_DIRTY"
    );
  }
  if (lower.includes("is not a working tree") || lower.includes("not a working tree")) {
    return new WorktreeError(text, "WORKTREE_NOT_FOUND");
  }
  return new WorktreeError(text.length > 0 ? text : fallbackMessage, "GIT_FAILED");
}
function _setGitRunnerForTests(fn) {
  const prev = gitRunner;
  gitRunner = fn;
  return () => {
    gitRunner = prev;
  };
}
function runGit(repoDir, args, fallbackMessage) {
  try {
    return gitRunner(repoDir, args);
  } catch (error) {
    const stderr = error.stderr;
    const text = stderr ? stderr.toString() : "";
    throw mapWorktreeError(text, fallbackMessage);
  }
}
function createWorktree(repoDir, branch, worktreeAbsPath, options = {}) {
  const args = ["worktree", "add"];
  if (options.newBranch) {
    args.push("-b", branch, worktreeAbsPath);
    if (options.from && options.from.length > 0) args.push(options.from);
  } else {
    args.push(worktreeAbsPath, branch);
  }
  runGit(repoDir, args, `Failed to create worktree for ${branch}`);
  return worktreeAbsPath;
}
function removeWorktree(repoDir, worktreeAbsPath, options = {}) {
  const args = ["worktree", "remove"];
  if (options.force) args.push("--force");
  args.push(worktreeAbsPath);
  runGit(repoDir, args, `Failed to remove worktree ${worktreeAbsPath}`);
}
function listWorktrees(repoDir) {
  const out = runGit(repoDir, ["worktree", "list", "--porcelain"], "Failed to list worktrees");
  return parseWorktreeList(out);
}
var WorktreeError, gitRunner;
var init_worktree = __esm({
  "packages/daemon/src/lib/worktree.ts"() {
    "use strict";
    init_errors2();
    WorktreeError = class extends IdeError {
      constructor(message, code) {
        super(message, { code, exitCode: 1 });
        this.name = "WorktreeError";
      }
    };
    gitRunner = (repoDir, args) => execFileSync15("git", args, {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  }
});

// packages/daemon/src/lib/update.ts
var update_exports = {};
__export(update_exports, {
  UPDATE_COMMANDS: () => UPDATE_COMMANDS,
  detectPackageManager: () => detectPackageManager,
  findGitCheckoutRoot: () => findGitCheckoutRoot,
  planUpdate: () => planUpdate,
  renderPlan: () => renderPlan,
  runUpdate: () => runUpdate
});
import { execSync as execSync4 } from "node:child_process";
import { existsSync as existsSync34 } from "node:fs";
import { dirname as dirname31, join as join33 } from "node:path";
function detectPackageManager(cliPath) {
  const p = cliPath.toLowerCase();
  if (/(^|\/)\.?bun(\/|$)/.test(p)) return "bun";
  if (p.includes("pnpm")) return "pnpm";
  return "npm";
}
function planUpdate(input) {
  if (input.gitRoot) {
    return { method: "dev", command: null, reason: `git checkout at ${input.gitRoot}` };
  }
  const pm = detectPackageManager(input.cliPath);
  return {
    method: pm,
    command: UPDATE_COMMANDS[pm],
    reason: `global ${pm} install (${input.cliPath})`
  };
}
function renderPlan(plan, { current, latest, dryRun }) {
  const lines = [];
  if (latest && isNewer(latest, current)) {
    lines.push(`tmux-ide v${current} \u2192 v${latest} available`);
  } else if (latest) {
    lines.push(`tmux-ide v${current} is up to date (registry: v${latest})`);
  } else {
    lines.push(`tmux-ide v${current} (latest version unknown \u2014 run \`tmux-ide doctor\`)`);
  }
  lines.push("");
  if (plan.method === "dev") {
    lines.push("Detected a cloned checkout \u2014 update with git:");
    lines.push("  git pull");
    lines.push(`  (${plan.reason})`);
  } else {
    const verb = dryRun ? "Would run" : "Running";
    lines.push(`Detected a global ${plan.method} install \u2014 ${verb}:`);
    lines.push(`  ${plan.command}`);
  }
  lines.push("");
  lines.push("After updating, refresh the dock so it runs the new code:");
  lines.push("  tmux kill-session -t _tmux-ide-chrome   # stop the old updater");
  lines.push("  tmux-ide adopt <session>                # re-adopt to relaunch it");
  return lines.join("\n");
}
function findGitCheckoutRoot(startDir) {
  let dir = startDir;
  for (; ; ) {
    if (existsSync34(join33(dir, ".git"))) return dir;
    const parent = dirname31(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
function runUpdate({ cliDir, dryRun }) {
  const current = getCurrentVersion();
  const { latest } = getUpdateStatus({ currentVersion: current });
  const gitRoot = findGitCheckoutRoot(cliDir);
  const plan = planUpdate({ cliPath: cliDir, gitRoot });
  console.log(renderPlan(plan, { current, latest, dryRun }));
  if (!dryRun && plan.command) {
    console.log("");
    execSync4(plan.command, { stdio: "inherit" });
  }
  return plan;
}
var UPDATE_COMMANDS;
var init_update = __esm({
  "packages/daemon/src/lib/update.ts"() {
    "use strict";
    init_update_check();
    UPDATE_COMMANDS = {
      npm: "npm install -g tmux-ide@latest",
      pnpm: "pnpm add -g tmux-ide@latest",
      bun: "bun add -g tmux-ide@latest"
    };
  }
});

// packages/daemon/src/command-center/index.ts
var command_center_exports = {};
__export(command_center_exports, {
  startCommandCenter: () => startCommandCenter
});
import { createServer as createServer3 } from "node:http";
import { getRequestListener } from "@hono/node-server";
async function startCommandCenter(options = {}) {
  const port = options.port ?? 6060;
  const hostname2 = options.hostname ?? "0.0.0.0";
  const appOpts = {};
  if (options.authService) appOpts.authService = options.authService;
  if (options.authConfig) appOpts.authConfig = options.authConfig;
  const app = createApp(appOpts);
  const listener = getRequestListener(app.fetch);
  const server = createServer3(listener);
  return new Promise((resolve29) => {
    server.listen(port, hostname2, () => {
      console.log(`Command Center API on http://${hostname2}:${port}`);
      resolve29(server);
    });
  });
}
var init_command_center = __esm({
  "packages/daemon/src/command-center/index.ts"() {
    "use strict";
    init_server();
  }
});

// packages/daemon/src/server/index.ts
var server_exports3 = {};
__export(server_exports3, {
  createApp: () => createApp2,
  resolvePort: () => resolvePort,
  start: () => start
});
import { createServer as createServer4 } from "node:http";
import { parse as parse2 } from "node:url";
import { Hono as Hono2 } from "hono";
import { getRequestListener as getRequestListener2 } from "@hono/node-server";
import { WebSocketServer as WebSocketServer3 } from "ws";
function resolvePort(port) {
  const raw = port ?? Number.parseInt(process.env.TMUX_IDE_PORT ?? String(DEFAULT_PORT), 10);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`Invalid server port: ${String(port ?? process.env.TMUX_IDE_PORT)}`);
  }
  return raw;
}
function createApp2() {
  const app = new Hono2();
  app.get("/", (c) => c.text("tmux-ide server"));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}
async function start(port) {
  const resolvedPort = resolvePort(port);
  const app = createApp2();
  const server = createServer4(getRequestListener2(app.fetch));
  const ptyWss = new WebSocketServer3({ noServer: true });
  server.on("upgrade", (req, socket, head3) => {
    const { pathname } = parse2(req.url ?? "/", true);
    const match = pathname?.match(/^\/ws\/pty\/([^/]+)$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    ptyWss.handleUpgrade(req, socket, head3, (ws) => {
      handlePtyWebSocket(ws, id);
    });
  });
  await new Promise((resolve29, reject) => {
    server.once("error", reject);
    server.listen(resolvedPort, "0.0.0.0", () => {
      server.off("error", reject);
      resolve29();
    });
  });
  console.log(`tmux-ide server listening on http://0.0.0.0:${resolvedPort}`);
  return {
    port: resolvedPort,
    server,
    close: () => new Promise((resolve29, reject) => {
      shutdownPtyBridges();
      ptyWss.close();
      server.close((err) => err ? reject(err) : resolve29());
    })
  };
}
var DEFAULT_PORT;
var init_server3 = __esm({
  "packages/daemon/src/server/index.ts"() {
    "use strict";
    init_ws_route();
    DEFAULT_PORT = 6070;
  }
});

// bin/cli.ts
init_launch();
import { parseArgs } from "node:util";
import { resolve as resolve28, dirname as dirname32 } from "node:path";
import { execFileSync as execFileSync16 } from "node:child_process";
import { existsSync as existsSync35 } from "node:fs";
import { fileURLToPath as fileURLToPath11 } from "node:url";

// packages/daemon/src/tui/team/entry.ts
function resolveEntry(opts) {
  if (opts.teamFlag) return "cockpit";
  if (opts.configKind === "workspace" || opts.configKind === "legacy") return "project";
  if (opts.hasWorkspaceConfig || opts.hasIdeYml) return "project";
  return opts.frontDoor ? "app" : "cockpit";
}

// bin/cli.ts
init_app_config();
init_resolved_config();
init_config_context();
init_compiled();

// packages/daemon/src/init.ts
init_detect();
init_output();
init_yaml_io();
init_legacy_config_migration();
init_config_context();
init_src();
import {
  existsSync as existsSync21,
  readFileSync as readFileSync17,
  writeFileSync as writeFileSync13,
  mkdirSync as mkdirSync14,
  readdirSync as readdirSync3,
  copyFileSync as copyFileSync2
} from "node:fs";
import { resolve as resolve15, join as join20, basename as basename7, dirname as dirname19 } from "node:path";
import { fileURLToPath as fileURLToPath7 } from "node:url";
var __dirname4 = dirname19(fileURLToPath7(import.meta.url));
function copyTemplateSkills(targetDir) {
  const created = [];
  const templateSkillsDir = resolve15(__dirname4, "..", "..", "..", "templates", "skills");
  if (!existsSync21(templateSkillsDir)) return created;
  mkdirSync14(targetDir, { recursive: true });
  for (const file of readdirSync3(templateSkillsDir)) {
    if (!file.endsWith(".md")) continue;
    const destination = join20(targetDir, file);
    copyFileSync2(join20(templateSkillsDir, file), destination);
    created.push(destination);
  }
  return created;
}
function scaffoldLibraryStubs(dir) {
  const created = [];
  const libraryDir = join20(dir, ".tmux-ide", "library");
  if (!existsSync21(libraryDir)) {
    mkdirSync14(libraryDir, { recursive: true });
    created.push(libraryDir);
  }
  const archPath = join20(libraryDir, "architecture.md");
  if (!existsSync21(archPath)) {
    writeFileSync13(
      archPath,
      "# Architecture\n\n<!-- Describe your project's architecture here. This context is injected into agent dispatch prompts. -->\n"
    );
    created.push(archPath);
  }
  const learningsPath = join20(libraryDir, "learnings.md");
  if (!existsSync21(learningsPath)) {
    writeFileSync13(
      learningsPath,
      "# Learnings\n\n<!-- Task summaries are automatically appended here by the orchestrator. -->\n"
    );
    created.push(learningsPath);
  }
  return created;
}
function scaffoldValidationContract(dir) {
  const created = [];
  const tasksDir = join20(dir, ".tasks");
  if (!existsSync21(tasksDir)) {
    mkdirSync14(tasksDir, { recursive: true });
  }
  const contractPath = join20(tasksDir, "validation-contract.md");
  if (!existsSync21(contractPath)) {
    writeFileSync13(
      contractPath,
      "# Validation Contract\n\n<!-- Define assertions that the validator agent will verify. Example: -->\n<!-- - VAL-001: All tests pass -->\n<!-- - VAL-002: No TypeScript errors -->\n<!-- - VAL-003: Lint passes with zero warnings -->\n"
    );
    created.push(contractPath);
  }
  return created;
}
function scaffoldAgentsMd(dir, name) {
  const created = [];
  const agentsTemplatePath = resolve15(__dirname4, "..", "..", "..", "templates", "AGENTS.md");
  if (existsSync21(agentsTemplatePath)) {
    const agentsPath = join20(dir, "AGENTS.md");
    if (!existsSync21(agentsPath)) {
      const content = readFileSync17(agentsTemplatePath, "utf-8").replace(/{{name}}/g, name);
      writeFileSync13(agentsPath, content);
      created.push(agentsPath);
    }
  }
  return created;
}
function isTeamTemplate(templateName) {
  return templateName === "missions" || templateName.startsWith("agent-team");
}
function scaffoldTeamWorkspace(dir, name) {
  const created = [];
  created.push(...scaffoldLibraryStubs(dir));
  created.push(...scaffoldValidationContract(dir));
  created.push(...scaffoldAgentsMd(dir, name));
  return created;
}
function scaffoldMissionsWorkspace(dir, name) {
  const created = [];
  const skillsDir = join20(dir, ".tmux-ide", "skills");
  created.push(...copyTemplateSkills(skillsDir));
  created.push(...scaffoldTeamWorkspace(dir, name));
  return created;
}
async function init({
  template,
  json: json2
} = {}) {
  const inputDir = process.cwd();
  const context = await resolveProjectConfigContext(inputDir);
  const dir = context.configWriteRoot;
  if (context.configExists) {
    outputError(`workspace config already exists at ${context.configPath}`, "EXISTS");
  }
  if (template) {
    const templatePath = resolve15(__dirname4, "..", "..", "..", "templates", `${template}.yml`);
    if (!existsSync21(templatePath)) {
      outputError(`Template "${template}" not found`, "NOT_FOUND");
    }
    let content = readFileSync17(templatePath, "utf-8");
    const name2 = basename7(dir);
    content = content.replace(/^name: .+/m, `name: ${name2}`);
    const yaml6 = (await import("js-yaml")).default;
    const workspace = WorkspaceConfigV1SchemaZ.parse(yaml6.load(content));
    const config2 = workspaceConfigToLegacyProjection(workspace);
    writeConfig(dir, config2);
    let created;
    if (template === "missions") {
      created = scaffoldMissionsWorkspace(dir, name2);
    } else if (isTeamTemplate(template)) {
      created = [
        ...copyTemplateSkills(join20(dir, ".tmux-ide", "skills")),
        ...scaffoldTeamWorkspace(dir, name2)
      ];
    } else {
      created = copyTemplateSkills(join20(dir, ".tmux-ide", "skills"));
    }
    if (json2) {
      console.log(JSON.stringify({ created: true, template, name: name2, paths: created }));
    } else {
      console.log(`Created .tmux-ide/workspace.yml from "${template}" template for "${name2}"`);
      printLayout(config2);
      for (const createdPath of created) {
        console.log(`Created ${createdPath.replace(dir + "/", "")}`);
      }
    }
    return;
  }
  const detected = detectStack(dir);
  const name = basename7(dir);
  if (detected.frameworks.length > 0) {
    const config2 = suggestConfig(dir, detected);
    writeConfig(dir, config2);
    const desc = detected.frameworks.join(" + ");
    if (json2) {
      console.log(JSON.stringify({ created: true, detected: detected.frameworks, name }));
    } else {
      console.log(`Detected ${desc}. Created .tmux-ide/workspace.yml for "${name}".`);
      printLayout(config2);
      console.log("Edit it to customize, then run: tmux-ide");
    }
  } else {
    const templatePath = resolve15(__dirname4, "..", "..", "..", "templates", "default.yml");
    let content = readFileSync17(templatePath, "utf-8");
    content = content.replace(/^name: .+/m, `name: ${name}`);
    const yaml6 = (await import("js-yaml")).default;
    const workspace = WorkspaceConfigV1SchemaZ.parse(yaml6.load(content));
    const config2 = workspaceConfigToLegacyProjection(workspace);
    writeConfig(dir, config2);
    if (json2) {
      console.log(JSON.stringify({ created: true, template: "default", name }));
    } else {
      console.log(`Created .tmux-ide/workspace.yml for "${name}"`);
      printLayout(config2);
      console.log("Edit it to configure your workspace, then run: tmux-ide");
    }
  }
  const skillsDir = join20(dir, ".tmux-ide", "skills");
  if (!existsSync21(skillsDir)) {
    const created = copyTemplateSkills(skillsDir);
    if (created.length > 0 && !json2) {
      console.log("Copied built-in skill templates to .tmux-ide/skills/");
    }
  }
}

// packages/daemon/src/stop.ts
init_output();
init_src2();
init_config_context();
import { resolve as resolve16 } from "node:path";
async function stop(targetDir, { json: json2 } = {}) {
  const dir = resolve16(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);
  stopSessionMonitor(session);
  const result = killSession(session);
  if (result.stopped) {
    if (json2) {
      console.log(JSON.stringify({ stopped: session }));
    } else {
      console.log(`Stopped session "${session}"`);
    }
    return;
  }
  outputError(`No active session "${session}" found`, "NOT_RUNNING");
}

// packages/daemon/src/attach.ts
init_output();
init_src2();
init_config_context();
import { resolve as resolve17 } from "node:path";
async function attach(targetDir, { json: _json } = {}) {
  const dir = resolve17(targetDir ?? ".");
  const { sessionName: session } = await resolveProjectConfigContext(dir);
  const state = getSessionState(session);
  if (!state.running) {
    outputError(`Session "${session}" is not running. Start it with: tmux-ide`, "NOT_RUNNING");
    return;
  }
  attachSession(session);
}

// packages/daemon/src/ls.ts
import { execSync as execSync2 } from "node:child_process";
async function ls({ json: json2 } = {}) {
  let raw;
  try {
    raw = execSync2(
      'tmux list-sessions -F "#{session_name}|#{session_created}|#{session_attached}"',
      { encoding: "utf-8" }
    ).trim();
  } catch {
    if (json2) {
      console.log(JSON.stringify({ sessions: [] }));
    } else {
      console.log("No tmux sessions running.");
    }
    return;
  }
  const sessions = raw.split("\n").map((line) => {
    const [name, created, attached] = line.split("|");
    return {
      name,
      created: new Date(parseInt(created) * 1e3).toISOString(),
      attached: attached !== "0"
    };
  });
  if (json2) {
    console.log(JSON.stringify({ sessions }, null, 2));
    return;
  }
  console.log("SESSION".padEnd(24) + "CREATED".padEnd(22) + "ATTACHED");
  console.log("\u2500".repeat(54));
  for (const s of sessions) {
    const date = new Date(s.created).toLocaleString();
    console.log(s.name.padEnd(24) + date.padEnd(22) + (s.attached ? "yes" : "no"));
  }
}

// packages/daemon/src/doctor.ts
init_update_check();
init_skill_sync();
init_agent_discovery();
init_compiled();
init_claude();
init_notify();
init_resolved_config();
import { execSync as execSync3 } from "node:child_process";
import { accessSync, constants as constants2, existsSync as existsSync24 } from "node:fs";
import { resolve as resolve18, dirname as dirname22 } from "node:path";
import { fileURLToPath as fileURLToPath9 } from "node:url";
function agentIntegrationRows(agents) {
  return presentAgents(agents).map((agent) => {
    const label = `agent: ${agent.id}`;
    if (agent.integration) {
      const benefit = agent.capture === "hooks" ? "for ground-truth status" : "to record session ids for restore --resume-agents";
      return agent.installed ? { label, pass: true, detail: "integration installed \u2713", optional: true } : {
        label,
        pass: false,
        detail: `found on PATH \u2014 run \`tmux-ide integration install ${agent.id}\` ${benefit}`,
        optional: true
      };
    }
    return {
      label,
      pass: true,
      detail: "found \u2014 screen-manifest detection active (no lifecycle integration yet)",
      optional: true
    };
  });
}
function hooksTargetRow(facts) {
  const label = "Claude hooks target writable";
  if (facts.writable) {
    return {
      label,
      pass: true,
      detail: facts.fileExists ? facts.settingsPath : `${facts.settingsPath} (will be created)`,
      optional: true
    };
  }
  return {
    label,
    pass: false,
    detail: `cannot write ${facts.settingsPath} \u2014 fix its permissions (chown/chmod), or point TMUX_IDE_CLAUDE_SETTINGS at a writable path`,
    optional: true
  };
}
function notifierRow(present) {
  const label = "native macOS notifications";
  if (present) {
    return {
      label,
      pass: true,
      detail: "bundled \u2014 branded banners and click-to-jump are ready",
      optional: true
    };
  }
  return {
    label,
    pass: false,
    detail: "native helper missing \u2014 reinstall tmux-ide; unbranded AppleScript banners remain available",
    optional: true
  };
}
function check(label, fn, { optional = false } = {}) {
  try {
    const result = fn();
    return { label, pass: true, detail: result, optional };
  } catch (e) {
    return { label, pass: false, detail: e.message, optional };
  }
}
async function doctor({
  json: json2
} = {}) {
  const checks = [];
  checks.push(
    check("tmux installed", () => {
      try {
        execSync3("which tmux", { stdio: "ignore" });
      } catch {
        throw new Error(
          "not found on PATH \u2014 install it (macOS: `brew install tmux`; Debian/Ubuntu: `sudo apt install tmux`)"
        );
      }
      return "found";
    })
  );
  checks.push(
    check("tmux version \u2265 3.0", () => {
      const version = execSync3("tmux -V", { encoding: "utf-8" }).trim();
      const num = parseFloat(version.replace(/[^0-9.]/g, ""));
      if (num < 3) throw new Error(`${version} (need \u2265 3.0)`);
      return version;
    })
  );
  checks.push(
    check("Node.js \u2265 18", () => {
      const major = parseInt(process.versions.node.split(".")[0]);
      if (major < 18) throw new Error(`Node ${process.versions.node} (need \u2265 18)`);
      return `v${process.versions.node}`;
    })
  );
  checks.push(
    check(
      "256-color terminal",
      () => {
        const term = process.env.TERM ?? "";
        if (!term.includes("256color") && !term.includes("ghostty") && !term.includes("kitty") && term !== "tmux-256color") {
          throw new Error(`$TERM is "${term}"`);
        }
        return term;
      },
      { optional: true }
    )
  );
  checks.push(
    await (async () => {
      try {
        const resolved2 = await resolveConfig(resolve18("."));
        if (resolved2.kind === "none") throw new Error("not found in current directory");
        return {
          label: "workspace config exists",
          pass: true,
          detail: resolved2.kind === "legacy" ? "legacy ide.yml compatibility" : "found",
          optional: false
        };
      } catch (e) {
        return {
          label: "workspace config exists",
          pass: false,
          detail: e.message,
          optional: false
        };
      }
    })()
  );
  checks.push(
    check(
      "TUI surfaces (cockpit / widgets)",
      () => {
        const here = dirname22(fileURLToPath9(import.meta.url));
        const checkoutEntry = [
          resolve18(here, "../packages/daemon/src/tui/team/index.tsx"),
          resolve18(here, "tui/team/index.tsx")
        ].find(existsSync24);
        const binary = findCompiledTui();
        if (checkoutEntry && isBunAvailable()) return "dev checkout (bun)";
        if (binary) return `compiled binary (${binary})`;
        throw new Error(
          "no dev checkout+bun and no compiled binary \u2014 build one with `pnpm build:tui` or install a release that ships it"
        );
      },
      { optional: true }
    )
  );
  checks.push(
    check(
      "Claude Code agent teams",
      () => {
        if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS !== "1") {
          throw new Error("not set (enable with CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)");
        }
        return "enabled";
      },
      { optional: true }
    )
  );
  const tunnelCli = (label, cmd) => check(
    label,
    () => {
      try {
        return execSync3(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim().split("\n")[0];
      } catch {
        throw new Error("not found (optional \u2014 used for remote access tunnels)");
      }
    },
    { optional: true }
  );
  checks.push(tunnelCli("tailscale CLI", "tailscale version"));
  checks.push(tunnelCli("ngrok CLI", "ngrok version"));
  checks.push(tunnelCli("cloudflared CLI", "cloudflared --version"));
  checks.push(
    (() => {
      const settingsPath = claudeSettingsPath();
      const fileExists2 = existsSync24(settingsPath);
      let probe = fileExists2 ? settingsPath : dirname22(settingsPath);
      while (!existsSync24(probe)) {
        const parent = dirname22(probe);
        if (parent === probe) break;
        probe = parent;
      }
      let writable = false;
      try {
        accessSync(probe, constants2.W_OK);
        writable = true;
      } catch {
      }
      return hooksTargetRow({ settingsPath, fileExists: fileExists2, writable });
    })()
  );
  checks.push(
    check(
      "tmux-ide up to date",
      () => {
        const current = getCurrentVersion();
        const { latest, updateAvailable } = getUpdateStatus({ currentVersion: current });
        if (updateAvailable) {
          throw new Error(`v${current} \u2014 v${latest} available (run \`tmux-ide update\`)`);
        }
        return latest ? `v${current} (latest)` : `v${current} (latest unknown)`;
      },
      { optional: true }
    )
  );
  checks.push(
    check(
      "Claude Code skill",
      () => {
        const installed = installedSkillVersion();
        const current = getCurrentVersion();
        if (installed === null) {
          throw new Error("not installed \u2014 run `tmux-ide skill-sync`");
        }
        if (installed !== current) {
          throw new Error(`v${installed} (CLI v${current}) \u2014 run \`tmux-ide skill-sync\``);
        }
        return `in sync (v${installed})`;
      },
      { optional: true }
    )
  );
  if (process.platform === "darwin" && readNotificationPrefs().macos) {
    checks.push(notifierRow(resolveNativeMacosNotifierPath() !== null));
  }
  checks.push(...agentIntegrationRows(discoverAgents()));
  const allPass = checks.every((c) => c.pass || c.optional);
  if (json2) {
    console.log(JSON.stringify({ ok: allPass, checks }, null, 2));
    return;
  }
  for (const c of checks) {
    const icon = c.pass ? "\u2713" : c.optional ? "\u25CB" : "\u2717";
    const color3 = c.pass ? "\x1B[32m" : c.optional ? "\x1B[33m" : "\x1B[31m";
    console.log(`${color3}${icon}\x1B[0m ${c.label} \u2014 ${c.detail}`);
  }
  if (!allPass) process.exitCode = 1;
}

// packages/daemon/src/status.ts
init_src2();
init_canonical_daemon();
init_config_context();
import { resolve as resolve19 } from "node:path";
async function status(targetDir, { json: json2 } = {}) {
  const dir = resolve19(targetDir ?? ".");
  const context = await resolveProjectConfigContext(dir);
  const session = context.sessionName;
  const state = getSessionState(session);
  const running = state.running;
  let panes = [];
  if (running) panes = listPanes(session);
  const daemonInfo = readCanonicalDaemonInfo();
  const healthy = daemonInfo ? await probeCanonicalDaemonHealth(daemonInfo) !== null : false;
  const data = {
    session,
    running,
    configExists: context.configExists,
    hasWorkspaceConfig: context.hasWorkspaceConfig,
    hasIdeYml: context.hasIdeYml,
    configKind: context.configKind,
    configPath: context.configPath,
    panes,
    daemon: {
      pid: daemonInfo?.pid ?? null,
      alive: daemonInfo ? isProcessAlive(daemonInfo.pid) : false,
      port: daemonInfo?.port ?? null,
      healthy
    }
  };
  if (json2) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Session: ${session}`);
  console.log(`Running: ${running ? "yes" : "no"}`);
  console.log(
    `Config:  ${context.configExists ? `${context.configKind} config found` : "no config"}`
  );
  if (running) {
    console.log(
      `Daemon:  ${data.daemon.alive ? "running" : "not running"}${data.daemon.port ? ` (port ${data.daemon.port})` : ""}`
    );
  }
  if (panes.length > 0) {
    console.log(`
Panes:`);
    for (const p of panes) {
      const active2 = p.active ? " (active)" : "";
      console.log(`  ${p.index}: ${p.title} [${p.width}x${p.height}]${active2}`);
    }
  }
}

// packages/daemon/src/inspect.ts
init_validate();
init_output();
init_errors2();
init_src2();
init_config_context();
import { resolve as resolve20 } from "node:path";
function buildInspection(dir, {
  config: config2,
  configPath,
  running,
  panes,
  configKind,
  ideConfigPath,
  session
}) {
  const errors = validateConfig(config2);
  const rows = Array.isArray(config2?.rows) ? config2.rows : [];
  const resolvedRows = rows.map((row, rowIndex) => ({
    index: rowIndex,
    size: row.size ?? null,
    panes: (Array.isArray(row?.panes) ? row.panes : []).map((pane, paneIndex) => ({
      index: paneIndex,
      title: pane.title ?? null,
      command: pane.command ?? null,
      dir: pane.dir ?? ".",
      size: pane.size ?? null,
      focus: pane.focus === true,
      role: pane.role ?? null,
      task: pane.task ?? null,
      env: pane.env ?? {}
    }))
  }));
  const focusPane = resolvedRows.flatMap((row) => row.panes.map((pane) => ({ row: row.index, pane }))).find(({ pane }) => pane.focus) ?? null;
  return {
    dir,
    configPath,
    configKind,
    ideConfigPath,
    valid: errors.length === 0,
    errors,
    session,
    before: config2?.before ?? null,
    summary: {
      rows: resolvedRows.length,
      panes: resolvedRows.reduce((sum, row) => sum + row.panes.length, 0),
      focus: focusPane ? `rows.${focusPane.row}.panes.${focusPane.pane.index}` : null
    },
    team: config2?.team ?? null,
    theme: config2?.theme ?? null,
    focus: focusPane ? {
      row: focusPane.row,
      pane: focusPane.pane.index,
      title: focusPane.pane.title
    } : null,
    rows: resolvedRows,
    rawConfig: config2,
    tmux: {
      running,
      panes
    }
  };
}
async function inspect(targetDir, { json: json2 } = {}) {
  const dir = resolve20(targetDir ?? ".");
  let config2;
  let configPath;
  let configKind;
  let session;
  try {
    const context = await resolveProjectConfigContext(dir);
    const resolved2 = context.resolved;
    if (!resolved2?.launchConfig || !resolved2.path) {
      outputError("Cannot read workspace config: no config found", "READ_ERROR");
      return;
    }
    config2 = resolved2.launchConfig;
    configPath = resolved2.path;
    configKind = resolved2.kind;
    session = context.sessionName;
  } catch (error) {
    if (error instanceof ConfigError) {
      outputError(error.message, error.code ?? "READ_ERROR");
      return;
    }
    outputError(`Cannot read workspace config: ${error.message}`, "READ_ERROR");
    return;
  }
  const state = getSessionState(session);
  const panes = state.running ? listPanes(session) : [];
  const data = buildInspection(dir, {
    config: config2,
    configPath,
    configKind,
    ideConfigPath: configKind === "legacy" ? configPath : null,
    session,
    running: state.running,
    panes
  });
  if (json2) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(`Directory: ${data.dir}`);
  console.log(`Config:    ${data.configPath}`);
  console.log(`Kind:      ${data.configKind}`);
  console.log(`Valid:     ${data.valid ? "yes" : "no"}`);
  console.log(`Session:   ${data.session}`);
  console.log(`Running:   ${data.tmux.running ? "yes" : "no"}`);
  console.log(`Rows:      ${data.summary.rows}`);
  console.log(`Panes:     ${data.summary.panes}`);
  console.log(`Team:      ${data.team ? data.team.name : "disabled"}`);
  if (data.focus) {
    console.log(
      `Focus:     row ${data.focus.row}, pane ${data.focus.pane}${data.focus.title ? ` (${data.focus.title})` : ""}`
    );
  }
  if (!data.valid) {
    console.log("\nValidation Errors:");
    for (const error of data.errors) {
      console.log(`  - ${error}`);
    }
  }
  console.log("\nResolved Layout:");
  for (const row of data.rows) {
    console.log(`  Row ${row.index}${row.size ? ` (${row.size})` : ""}`);
    for (const pane of row.panes) {
      const parts = [];
      if (pane.title) parts.push(pane.title);
      if (pane.command) parts.push(`cmd=${pane.command}`);
      if (pane.dir && pane.dir !== ".") parts.push(`dir=${pane.dir}`);
      if (pane.role) parts.push(`role=${pane.role}`);
      if (pane.focus) parts.push("focus");
      console.log(`    - pane ${pane.index}: ${parts.join(" | ") || "shell"}`);
    }
  }
  if (data.tmux.running && data.tmux.panes.length > 0) {
    console.log("\nLive Panes:");
    for (const pane of data.tmux.panes) {
      const active2 = pane.active ? " (active)" : "";
      console.log(`  ${pane.index}: ${pane.title} [${pane.width}x${pane.height}]${active2}`);
    }
  }
}

// bin/cli.ts
init_validate();
init_detect();
init_config();

// packages/daemon/src/migrate.ts
init_output();
init_legacy_config_migration();
init_resolved_config();
init_legacy_config_adapter();
init_project_resolver();
init_errors2();
import { execFileSync as execFileSync13 } from "node:child_process";
import { dirname as dirname28, resolve as resolve26 } from "node:path";
function gitIgnoresWorkspace(dir) {
  try {
    execFileSync13("git", ["-C", dir, "check-ignore", "-q", ".tmux-ide/workspace.yml"], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}
function migrationWarnings(dir) {
  if (!gitIgnoresWorkspace(dir)) return [];
  return [
    {
      code: "TMUX_IDE_DIR_IGNORED",
      message: "Git ignores .tmux-ide/workspace.yml. Track .tmux-ide/workspace.yml and ignore only .tmux-ide/workspace.local.yml for machine-local overrides."
    }
  ];
}
function readLegacyForMigration(legacyPath) {
  try {
    return readLegacyConfigFile(legacyPath);
  } catch (error) {
    const name = error.name;
    if (name === "YAMLException") {
      outputError(
        `Invalid legacy ide.yml YAML: ${error.message}`,
        "LEGACY_YAML_INVALID"
      );
    }
    if (name === "ZodError") {
      outputError(
        `Invalid legacy ide.yml schema: ${error.message}`,
        "LEGACY_SCHEMA_INVALID"
      );
    }
    outputError(`Cannot read legacy ide.yml: ${error.message}`, "LEGACY_READ_FAILED");
  }
}
async function migrate(targetDir, {
  json: json2,
  dryRun,
  write,
  onAfterRead
} = {}) {
  const dir = resolve26(targetDir ?? ".");
  if (!dryRun && !write) dryRun = true;
  if (dryRun && write) outputError("Use either --dry-run or --write, not both", "USAGE");
  try {
    const resolution = await resolveProject(dir);
    if (resolution.config.kind === "workspace") {
      outputError(`Workspace config already exists at ${resolution.config.path}`, "CONFIG_EXISTS");
    }
    if (resolution.config.kind !== "legacy" || !resolution.config.path) {
      outputError("No resolved legacy ide.yml found to migrate", "CONFIG_NOT_FOUND");
    }
    const legacyPath = resolution.config.path;
    const writeRoot = dirname28(legacyPath);
    const workspacePath = workspaceConfigPath(writeRoot);
    const { raw, config: config2 } = readLegacyForMigration(legacyPath);
    await onAfterRead?.();
    const result = convertLegacyConfigToWorkspace(config2);
    const workspaceYaml = workspaceConfigToYaml(result.workspace);
    const warnings = migrationWarnings(writeRoot);
    if (raw !== readLegacyForMigration(legacyPath).raw) {
      outputError("Legacy ide.yml changed during migration", "CONFIG_CHANGED");
    }
    const writtenPath = write ? createWorkspaceConfig(writeRoot, result.workspace) : null;
    const payload = {
      ok: true,
      mode: write ? "write" : "dry-run",
      legacyPath,
      workspacePath,
      written: writtenPath,
      diagnostics: result.diagnostics,
      warnings,
      workspace: result.workspace,
      workspaceYaml
    };
    if (json2) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    if (write) console.log(`Created ${workspacePath}`);
    else console.log(workspaceYaml.trimEnd());
    for (const diagnostic of result.diagnostics) {
      console.log(`warning ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    }
    for (const warning of warnings) {
      console.log(`warning ${warning.code}: ${warning.message}`);
    }
  } catch (error) {
    if (error instanceof IdeError) throw error;
    if (error instanceof Error && error.name === "ZodError") {
      outputError(`Invalid legacy ide.yml: ${error.message}`, "INVALID_CONFIG");
    }
    throw error;
  }
}

// bin/cli.ts
init_restart();

// packages/daemon/src/restore.ts
init_src2();
init_app_config();
init_errors2();
init_project_registry();
init_statusline();
init_snapshot2();
function buildRestorePlan(snapshot, liveSessionNames, ideProjects = /* @__PURE__ */ new Map()) {
  const live = new Set(liveSessionNames);
  const actions = [];
  let paneCount = 0;
  for (const session of snapshot.sessions) {
    if (live.has(session.name)) {
      actions.push({ kind: "skip", session: session.name });
      continue;
    }
    const dir = ideProjects.get(session.name);
    if (dir) {
      actions.push({ kind: "launch", session: session.name, dir });
      continue;
    }
    actions.push({ kind: "rebuild", session });
    for (const window of session.windows) paneCount += window.panes.length;
  }
  return { actions, paneCount };
}
var SAFE_SESSION_ID2 = /^[A-Za-z0-9_-]+$/;
var AGENT_RESUME_COMMANDS = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  opencode: (id) => `opencode --session ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  copilot: (id) => `copilot --resume=${id}`
};
function paneResumeCommand(pane, opts) {
  if (!opts.resumeAgents) return null;
  const resume = pane.agent ? AGENT_RESUME_COMMANDS[pane.agent] : void 0;
  if (!resume) return null;
  const id = pane.agentSessionId;
  if (!id || !SAFE_SESSION_ID2.test(id)) return null;
  return resume(id);
}
function countResumableAgents(session, resumeAgents) {
  let n = 0;
  for (const window of session.windows) {
    for (const pane of window.panes) {
      if (paneResumeCommand(pane, { resumeAgents })) n++;
    }
  }
  return n;
}
function readRestorePrefs() {
  return loadAppConfig().restore;
}
function tmuxCapture(args) {
  return runTmux(args, { encoding: "utf-8" }).toString().trim();
}
function rebuildSession(session, opts) {
  const { runCommands, resumeAgents } = opts;
  const resumedTitles = [];
  const windows = session.windows;
  if (windows.length === 0) {
    runTmux(["new-session", "-d", "-s", session.name, "-c", session.cwd]);
    return resumedTitles;
  }
  windows.forEach((window, w) => {
    const windowCwd = window.panes[0]?.cwd || session.cwd;
    const windowId = w === 0 ? tmuxCapture([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-s",
      session.name,
      "-c",
      windowCwd
    ]) : tmuxCapture([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      `${session.name}:`,
      "-c",
      windowCwd
    ]);
    const paneIds = [tmuxCapture(["display-message", "-p", "-t", windowId, "#{pane_id}"])];
    for (let p = 1; p < window.panes.length; p++) {
      const paneCwd = window.panes[p].cwd || windowCwd;
      paneIds.push(
        tmuxCapture([
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          paneIds[p - 1],
          "-c",
          paneCwd
        ])
      );
    }
    if (window.layout) runTmux(["select-layout", "-t", windowId, window.layout]);
    if (window.name) runTmux(["rename-window", "-t", windowId, window.name]);
    window.panes.forEach((pane, p) => {
      const paneId = paneIds[p];
      if (!paneId) return;
      if (pane.title) runTmux(["select-pane", "-t", paneId, "-T", pane.title]);
      if (pane.agentSessionId) {
        runTmux(["set-option", "-p", "-t", paneId, "@agent_session_id", pane.agentSessionId]);
      }
      if (pane.agent) {
        runTmux(["set-option", "-p", "-t", paneId, "@agent_hint", pane.agent]);
      }
      const resumeCmd = paneResumeCommand(pane, { resumeAgents });
      if (resumeCmd) {
        runTmux(["send-keys", "-t", paneId, "-l", "--", resumeCmd]);
        runTmux(["send-keys", "-t", paneId, "Enter"]);
        resumedTitles.push(pane.title || paneId);
      } else if (runCommands && pane.command) {
        runTmux(["send-keys", "-t", paneId, "-l", "--", pane.command]);
        runTmux(["send-keys", "-t", paneId, "Enter"]);
      }
    });
  });
  const activeIndex = windows.findIndex((w) => w.active);
  if (activeIndex >= 0) {
    runTmux(["select-window", "-t", `${session.name}:${windows[activeIndex].index}`]);
  }
  return resumedTitles;
}
function ideBackedProjects() {
  const map = /* @__PURE__ */ new Map();
  try {
    for (const project of listProjects()) {
      const hasProjectConfig = project.configKind === "workspace" || project.configKind === "legacy" || project.hasWorkspaceConfig || project.hasIdeYml;
      if (hasProjectConfig && project.dir) map.set(project.name, project.dir);
    }
  } catch {
  }
  return map;
}
function liveSessions() {
  try {
    const raw = tmuxCapture(["list-sessions", "-F", "#{session_name}"]);
    return raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}
async function restore({
  json: json2 = false,
  dryRun = false,
  runCommands = false,
  resumeAgents = false
} = {}) {
  const snapshot = readSnapshot();
  if (!snapshot) {
    throw new IdeError(
      "no snapshot yet \u2014 the updater writes one every ~30s while any session is adopted",
      { code: "NO_SNAPSHOT", exitCode: 1 }
    );
  }
  const resume = resumeAgents || readRestorePrefs().resumeAgents;
  const plan = buildRestorePlan(snapshot, liveSessions(), ideBackedProjects());
  if (dryRun) {
    reportPlan(plan, snapshot, {
      json: json2,
      dryRun: true,
      restored: [],
      launched: [],
      resumed: [],
      resumeAgents: resume
    });
    return;
  }
  const restored = [];
  const launched = [];
  const resumed = [];
  const recordResumed = (session, panes) => {
    if (panes.length) resumed.push({ session, panes });
  };
  for (const action of plan.actions) {
    if (action.kind === "skip") continue;
    if (action.kind === "launch") {
      const ok2 = await launchProject(action.dir, json2);
      if (ok2) launched.push(action.session);
      else {
        const snap = snapshot.sessions.find((s) => s.name === action.session);
        if (snap) {
          recordResumed(snap.name, rebuildSession(snap, { runCommands, resumeAgents: resume }));
          if (snap.adopted) safeAdopt(snap.name);
          restored.push(action.session);
        }
      }
      continue;
    }
    recordResumed(
      action.session.name,
      rebuildSession(action.session, { runCommands, resumeAgents: resume })
    );
    if (action.session.adopted) safeAdopt(action.session.name);
    restored.push(action.session.name);
  }
  reportPlan(plan, snapshot, {
    json: json2,
    dryRun: false,
    restored,
    launched,
    resumed,
    resumeAgents: resume
  });
}
function safeAdopt(session) {
  try {
    adoptSession(session);
  } catch {
  }
}
async function launchProject(dir, json2) {
  const restoreLog = console.log;
  if (json2) console.log = () => {
  };
  try {
    const { launch: launch2 } = await Promise.resolve().then(() => (init_launch(), launch_exports));
    await launch2(dir, { attach: false });
    return true;
  } catch {
    return false;
  } finally {
    console.log = restoreLog;
  }
}
function reportPlan(plan, snapshot, { json: json2, dryRun, restored, launched, resumed, resumeAgents }) {
  const skipped = plan.actions.filter((a) => a.kind === "skip").map((a) => a.session);
  const willLaunch = plan.actions.filter((a) => a.kind === "launch").map((a) => a.session);
  const willRebuild = plan.actions.filter((a) => a.kind === "rebuild").map((a) => a.session.name);
  const resumedPanes = resumed.reduce((n, r) => n + r.panes.length, 0);
  if (json2) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          savedAt: snapshot.savedAt,
          skipped,
          launched: dryRun ? willLaunch : launched,
          restored: dryRun ? willRebuild : restored,
          panes: plan.paneCount,
          resumeAgents,
          resumedPanes,
          resumed
        },
        null,
        2
      )
    );
    return;
  }
  if (dryRun) {
    console.log(`Restore plan (snapshot from ${snapshot.savedAt}):`);
    for (const action of plan.actions) {
      if (action.kind === "skip") {
        console.log(`  skip     ${action.session} (already running)`);
      } else if (action.kind === "launch") {
        console.log(`  launch   ${action.session} (project config at ${action.dir})`);
      } else {
        const w = action.session.windows.length;
        const p = action.session.windows.reduce((n, win) => n + win.panes.length, 0);
        const wouldResume = countResumableAgents(action.session, resumeAgents);
        const resumeNote = wouldResume ? `, would resume ${wouldResume} agent${wouldResume === 1 ? "" : "s"}` : "";
        console.log(
          `  rebuild  ${action.session.name} (${w} window${w === 1 ? "" : "s"}, ${p} pane${p === 1 ? "" : "s"}${resumeNote})`
        );
      }
    }
    return;
  }
  const resumedBySession = new Map(resumed.map((r) => [r.session, r.panes.length]));
  const resumeSuffix = (name) => {
    const n = resumedBySession.get(name) ?? 0;
    return n ? ` (resumed ${n} agent${n === 1 ? "" : "s"})` : "";
  };
  const parts = [];
  if (restored.length)
    parts.push(`rebuilt ${restored.map((s) => `${s}${resumeSuffix(s)}`).join(", ")}`);
  if (launched.length) parts.push(`launched ${launched.join(", ")}`);
  if (skipped.length) parts.push(`skipped ${skipped.join(", ")} (already running)`);
  console.log(parts.length ? `Restored: ${parts.join("; ")}` : "Nothing to restore.");
}

// bin/cli.ts
init_send();
init_errors2();
init_output();

// packages/daemon/src/lib/headless-daemon.ts
init_canonical_daemon();
init_src();
init_daemon_embed();
init_errors2();
var defaultDependencies = {
  inspectCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  isCanonicalDaemonRecordOwnerProvenDead,
  probeCanonicalDaemonHealth,
  probeCanonicalDaemonIdentity,
  startEmbeddedDaemon,
  writeStdout: (line) => process.stdout.write(`${line}
`),
  onSignal: (signal, listener) => process.on(signal, listener),
  offSignal: (signal, listener) => process.off(signal, listener)
};
function parsePort(value) {
  if (value == null) return void 0;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new IdeError(`Invalid daemon port: ${String(value)}`, {
      code: "USAGE",
      exitCode: 2
    });
  }
  return port;
}
function emitStatus(deps2, json2, status2, info) {
  const apiBaseUrl = canonicalDaemonUrl("http", info.bindHostname, info.port);
  if (json2) {
    deps2.writeStdout(JSON.stringify({ status: status2, pid: info.pid, port: info.port, apiBaseUrl }));
    return;
  }
  if (status2 === "already-running") {
    deps2.writeStdout(`Canonical daemon already running: ${apiBaseUrl} (pid ${info.pid})`);
  } else {
    deps2.writeStdout(`Canonical daemon ready: ${apiBaseUrl} (pid ${info.pid})`);
  }
}
function assertProtocolCompatible(info, health) {
  if (info.protocolVersion !== health.protocolVersion) {
    throw new IdeError(
      `Canonical daemon protocol disagreement: daemon.json reports ${info.protocolVersion}, /health reports ${health.protocolVersion}. Refusing takeover.`,
      { code: "DAEMON_PROTOCOL_MISMATCH", exitCode: 2 }
    );
  }
  if (!isDaemonWireProtocolCompatible(info.protocolVersion)) {
    throw new IdeError(
      `Canonical daemon protocol ${info.protocolVersion} is incompatible with this CLI (expected ${DAEMON_WIRE_PROTOCOL_VERSION}). Refusing takeover.`,
      { code: "DAEMON_PROTOCOL_MISMATCH", exitCode: 2 }
    );
  }
}
function assertIdentityMatches(info, identity) {
  if (identity.instanceId !== info.instanceId || identity.pid !== info.pid || identity.protocolVersion !== info.protocolVersion || identity.startedAt !== info.startedAt) {
    throw new IdeError(
      "Canonical daemon identity probe does not match daemon.json. Refusing takeover or reuse.",
      { code: "DAEMON_IDENTITY_MISMATCH", exitCode: 2 }
    );
  }
  if (identity.productVersion !== info.productVersion) {
    console.warn(
      `[tmux-ide] canonical daemon product-version metadata differs: daemon.json reports "${info.productVersion}" but /identity reports "${identity.productVersion}". Product version is diagnostic; compatibility is governed by protocol and instance identity.`
    );
  }
}
async function assertAttachableDaemon(deps2, info, options) {
  const identity = await deps2.probeCanonicalDaemonIdentity(info);
  if (!identity) {
    throw new IdeError(
      `Canonical daemon PID ${info.pid} is alive but its identity endpoint is unavailable. Refusing takeover.`,
      { code: "DAEMON_IDENTITY_UNAVAILABLE", exitCode: 1 }
    );
  }
  assertIdentityMatches(info, identity);
  const health = await deps2.probeCanonicalDaemonHealth(info);
  if (!health) {
    throw new IdeError(
      `Canonical daemon PID ${info.pid} is alive but its health endpoint is unavailable. Refusing takeover.`,
      { code: "DAEMON_UNHEALTHY", exitCode: 1 }
    );
  }
  assertProtocolCompatible(info, health);
  if (options.expectedVersion) warnOnDaemonVersionSkew(info, options.expectedVersion);
  if (health.productVersion !== info.productVersion) {
    console.warn(
      `[tmux-ide] canonical daemon product-version metadata differs: daemon.json reports "${info.productVersion}" but /health reports "${health.productVersion}". Wire compatibility is governed independently by protocolVersion.`
    );
  }
}
async function findLiveCanonicalDaemon(deps2, options) {
  const existing = deps2.inspectCanonicalDaemonInfo();
  if (existing.status === "missing") return null;
  if (existing.status === "invalid") {
    if (await deps2.isCanonicalDaemonRecordOwnerProvenDead(existing)) {
      return null;
    }
    throw new IdeError(
      `Canonical daemon metadata is ${existing.reason}: ${existing.detail}. Its owner is not proven dead, so another daemon will not be started.`,
      { code: "DAEMON_INFO_INVALID", exitCode: 1 }
    );
  }
  if (!await deps2.isCanonicalDaemonAlive(existing.info)) {
    return null;
  }
  await assertAttachableDaemon(deps2, existing.info, options);
  return existing.info;
}
function delay2(ms) {
  return new Promise((resolve29) => setTimeout(resolve29, ms));
}
async function waitForCanonicalWinner(deps2, options, timeoutMs = 15e3) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const winner = await findLiveCanonicalDaemon(deps2, options);
      if (winner) return winner;
    } catch (error) {
      if (!(error instanceof IdeError) || error.code !== "DAEMON_IDENTITY_UNAVAILABLE" && error.code !== "DAEMON_UNHEALTHY") {
        throw error;
      }
    }
    await delay2(25);
  }
  return null;
}
async function runHeadlessDaemon(options = {}, deps2 = defaultDependencies) {
  const port = parsePort(options.port);
  let handle = null;
  let signalRequested = false;
  const requestStop = () => {
    signalRequested = true;
    if (handle) void handle.stop().catch(() => void 0);
  };
  deps2.onSignal("SIGINT", requestStop);
  deps2.onSignal("SIGTERM", requestStop);
  try {
    const existing = await findLiveCanonicalDaemon(deps2, options);
    if (existing) {
      emitStatus(deps2, options.json === true, "already-running", existing);
      return "already-running";
    }
    for (let startAttempt = 0; startAttempt < 2 && !handle; startAttempt += 1) {
      try {
        handle = await deps2.startEmbeddedDaemon({
          port,
          bindHostname: "127.0.0.1",
          authToken: null,
          silent: true,
          ...options.sessionName ? { sessionName: options.sessionName } : {},
          ...options.expectedVersion ? { productVersion: options.expectedVersion } : {}
        });
      } catch (error) {
        if (error instanceof DaemonStartupError && (error.reason === "canonical_already_running" || error.reason === "canonical_claim_busy")) {
          const winner = await waitForCanonicalWinner(deps2, options);
          if (winner) {
            emitStatus(deps2, options.json === true, "already-running", winner);
            return "already-running";
          }
          if (startAttempt === 0) continue;
        }
        throw error;
      }
    }
    if (!handle) {
      throw new IdeError("Canonical daemon startup claim did not produce an owner", {
        code: "DAEMON_STARTUP_TIMEOUT",
        exitCode: 1
      });
    }
    let resolveStopped;
    const stopped = new Promise((resolve29) => {
      resolveStopped = resolve29;
    });
    let stopFailure;
    const originalStop = handle.stop.bind(handle);
    const mutableHandle = handle;
    mutableHandle.stop = async (stopOptions) => {
      try {
        await originalStop(stopOptions);
      } catch (error) {
        stopFailure = error;
        throw error;
      } finally {
        resolveStopped();
      }
    };
    if (signalRequested) {
      await handle.stop();
      if (stopFailure) throw stopFailure;
      return "stopped";
    }
    const published = deps2.inspectCanonicalDaemonInfo();
    if (published.status !== "valid") {
      await handle.stop().catch(() => void 0);
      throw new IdeError("Canonical daemon started without publishing daemon.json", {
        code: "DAEMON_INFO_MISSING",
        exitCode: 1
      });
    }
    const info = published.info;
    if (info.instanceId !== handle.instanceId || info.pid !== handle.pid || info.port !== handle.port) {
      await handle.stop().catch(() => void 0);
      throw new IdeError("Started daemon handle does not own the canonical published instance", {
        code: "DAEMON_IDENTITY_MISMATCH",
        exitCode: 2
      });
    }
    try {
      await assertAttachableDaemon(deps2, info, options);
    } catch (error) {
      await handle.stop().catch(() => void 0);
      if (signalRequested) {
        if (stopFailure) throw stopFailure;
        return "stopped";
      }
      throw error;
    }
    emitStatus(deps2, options.json === true, "ready", info);
    await stopped;
    if (stopFailure) throw stopFailure;
    return "stopped";
  } finally {
    deps2.offSignal("SIGINT", requestStop);
    deps2.offSignal("SIGTERM", requestStop);
  }
}

// bin/cli.ts
init_hosted();
var __dirname5 = dirname32(fileURLToPath11(import.meta.url));
var selfPath = fileURLToPath11(import.meta.url);
var nodeCliPath = selfPath.endsWith(".js") ? selfPath : resolve28(__dirname5, "cli.js");
var { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean" },
    headless: { type: "boolean" },
    row: { type: "string" },
    pane: { type: "string" },
    title: { type: "string" },
    command: { type: "string" },
    size: { type: "string" },
    write: { type: "boolean" },
    template: { type: "string" },
    name: { type: "string" },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
    port: { type: "string" },
    // setup command flags
    edit: { type: "boolean" },
    wizard: { type: "boolean" },
    // send command flags
    to: { type: "string" },
    "no-enter": { type: "boolean" },
    // wait command flags
    status: { type: "string" },
    timeout: { type: "string" },
    match: { type: "string" },
    // events command flag
    follow: { type: "boolean" },
    // force the team cockpit instead of launching a project
    team: { type: "boolean" },
    // adopt every live (non-internal) session at once
    all: { type: "boolean" },
    // restore: print the plan without touching tmux
    "dry-run": { type: "boolean" },
    // restore: replay recorded pane commands (off by default for safety)
    "run-commands": { type: "boolean" },
    // restore: revive agent conversations via `claude --resume <id>`
    "resume-agents": { type: "boolean" },
    // statusline: the session whose bar is being rendered
    active: { type: "string" },
    // switcher: the tmux client the popup was invoked on (see `switcher` case)
    client: { type: "string" },
    // team --popup: run the home cockpit as a popup over a tmux client (M-h)
    popup: { type: "boolean" },
    // sidebar-toggle: the session whose nav column is toggled (see `sidebar-toggle`)
    session: { type: "string" },
    // menu: the click position (mouse binds forward #{mouse_x}/#{mouse_y}) so the
    // actions menu opens at the pointer instead of centered (see `menu` case)
    x: { type: "string" },
    y: { type: "string" },
    // app: host the cockpit in the internal `_tmux-ide-app` session and attach
    // to it (M23.2) — `--detachable` is the primary name, `--hosted` the alias
    detachable: { type: "boolean" },
    hosted: { type: "boolean" },
    // worktree: base ref for a new branch, the worktree checkout dir override,
    // skip creating a session, and force-remove a dirty worktree (see `worktree`)
    from: { type: "string" },
    dir: { type: "string" },
    "no-session": { type: "boolean" },
    force: { type: "boolean" }
  }
});
var knownCommands = /* @__PURE__ */ new Set([
  "start",
  "init",
  "stop",
  "attach",
  "restart",
  "restore",
  "ls",
  "doctor",
  "status",
  "inspect",
  "validate",
  "detect",
  "migrate",
  "config",
  "setup",
  "send",
  "settings",
  "team",
  "app",
  "switcher",
  "wait",
  "events",
  "statusline",
  "adopt",
  "unadopt",
  "agent",
  "integration",
  "chrome-updater",
  "cheatsheet",
  "welcome",
  "menu",
  "popup",
  "sidebar-toggle",
  "worktree",
  "update",
  "skill-sync",
  "serve",
  "command-center",
  "server",
  "help"
]);
if (values.version) {
  const pkg = await Promise.resolve().then(() => __toESM(require_package(), 1));
  console.log(`tmux-ide v${pkg.version}`);
  process.exit(0);
}
if (values.verbose) {
  globalThis.__tmuxIdeVerbose = true;
}
var firstPositional = positionals[0];
var resolved = firstPositional;
var hasKnownCommand = resolved ? knownCommands.has(resolved) : false;
var command = hasKnownCommand ? resolved : "start";
var startTargetDir = hasKnownCommand ? positionals[1] : firstPositional;
var json = values.json ?? false;
var noColor = "NO_COLOR" in process.env;
var bold3 = (s) => noColor ? s : `\x1B[1m${s}\x1B[22m`;
var cyan2 = (s) => noColor ? s : `\x1B[36m${s}\x1B[39m`;
var dim3 = (s) => noColor ? s : `\x1B[2m${s}\x1B[22m`;
if (values.help) {
  printHelp();
  process.exit(0);
}
function printHelp() {
  console.log(`${bold3("tmux-ide")} \u2014 Terminal IDE powered by tmux

${bold3("Usage:")}
  ${cyan2("tmux-ide")}                    ${dim3("Launch workspace config, or open the team cockpit if none")}
  ${cyan2("tmux-ide --headless")}         ${dim3("Run the canonical daemon in this foreground process")}
  ${cyan2("tmux-ide <path>")}             ${dim3("Launch from a specific directory (cockpit if no config)")}
  ${cyan2("tmux-ide setup")}              ${dim3("Interactive TUI setup wizard")}
  ${cyan2("tmux-ide setup --edit")}       ${dim3("Open config tree editor")}
  ${cyan2("tmux-ide settings")}           ${dim3("Interactive TUI config manager")}
  ${cyan2("tmux-ide init")} [--template]  ${dim3("Scaffold .tmux-ide/workspace.yml (auto-detects stack)")}
  ${cyan2("tmux-ide stop")}               ${dim3("Kill the current IDE session")}
  ${cyan2("tmux-ide restart")}            ${dim3("Stop and relaunch the IDE session")}
  ${cyan2("tmux-ide restore")} [--dry-run] [--run-commands] [--resume-agents] [--json]
                              ${dim3("Rebuild the fleet from the last snapshot after a tmux crash")}
                              ${dim3("(--resume-agents revives claude conversations via claude --resume)")}
  ${cyan2("tmux-ide attach")}             ${dim3("Reattach to a running session")}
  ${cyan2("tmux-ide team")} [--json]      ${dim3("TUI over all tmux sessions (--json prints fleet state)")}
  ${cyan2("tmux-ide app")} [session]      ${dim3("Unified app: fleet home + live session mirror (bare = home)")}
  ${cyan2("tmux-ide app --detachable")}   ${dim3("Host the app in tmux and attach \u2014 survives the terminal, ^q detaches")}
  ${cyan2("tmux-ide switcher")}           ${dim3("Compact session picker (opens in the M-p popup on adopted sessions)")}
  ${cyan2("tmux-ide wait agent-status")} <session> --status <s> [--timeout <ms>]
                              ${dim3("Block until a session reaches a status (exit 0 match / 1 timeout)")}
  ${cyan2("tmux-ide wait output")} <pane|session> --match <regex> [--timeout <ms>]
                              ${dim3("Block until a pane's output matches a regex (exit 0 match / 1 timeout)")}
  ${cyan2("tmux-ide events")} [--follow] [--json] [--socket]  ${dim3("Stream agent-status transitions (--socket: push from a running serve)")}
  ${cyan2("tmux-ide serve")} [--socket <path>]  ${dim3("Local control socket: NDJSON verbs + pushed events (~/.tmux-ide/control.sock)")}
  ${cyan2("tmux-ide adopt")} <session>    ${dim3("Add the live tmux-ide status bar to a session")}
  ${cyan2("tmux-ide adopt --all")}        ${dim3("Adopt every live (non-internal) session")}
  ${cyan2("tmux-ide unadopt")} <session>  ${dim3("Remove the status bar")}
  ${cyan2("tmux-ide integration install claude")}  ${dim3("Authoritative agent status via Claude Code hooks")}
  ${cyan2("tmux-ide agent explain")} <pane> [--json]  ${dim3("Debug how a pane's agent state is detected")}
  ${cyan2("tmux-ide cheatsheet")}         ${dim3("Print the key cheat sheet (\u2325k / [ ? keys ] popup)")}
  ${cyan2("tmux-ide menu")} [--client N]  ${dim3("Open the right-click actions menu (\u2325m / right-click any pane or the bar)")}
  ${cyan2("tmux-ide popup")} <widget>     ${dim3("Open a widget as a floating panel (explorer/changes/config; \u2325e/\u2325g/\u2325,)")}
  ${cyan2("tmux-ide sidebar-toggle")} [--session S]  ${dim3("Toggle the app nav column (\u2325b on adopted sessions)")}
  ${cyan2("tmux-ide worktree create")} <branch> [--from <ref>] [--dir <path>] [--no-session]
                              ${dim3("Add a git worktree (new branch) + open a session in it")}
  ${cyan2("tmux-ide worktree open")} <branch>    ${dim3("Open (or switch to) the session for an existing worktree")}
  ${cyan2("tmux-ide worktree list")} [--json]    ${dim3("List worktrees joined with their session status")}
  ${cyan2("tmux-ide worktree remove")} <branch> [--force]  ${dim3("Kill the worktree's session + remove the worktree")}
  ${cyan2("tmux-ide ls")}                 ${dim3("List all tmux sessions")}
  ${cyan2("tmux-ide status")} [--json]    ${dim3("Show session status")}
  ${cyan2("tmux-ide inspect")} [--json]   ${dim3("Show effective config and runtime state")}
  ${cyan2("tmux-ide doctor")}             ${dim3("Check system requirements")}
  ${cyan2("tmux-ide update")} [--dry-run] ${dim3("Update tmux-ide (detects dev checkout vs npm/pnpm/bun global)")}
  ${cyan2("tmux-ide update --manifests")} ${dim3("Fetch the latest agent-detection manifest pack (your overrides still win)")}
  ${cyan2("tmux-ide skill-sync")}         ${dim3("Refresh the bundled Claude Code skill in ~/.claude/skills/tmux-ide")}
  ${cyan2("tmux-ide validate")} [--json]  ${dim3("Validate workspace config")}
  ${cyan2("tmux-ide detect")} [--json]    ${dim3("Detect project stack")}
  ${cyan2("tmux-ide detect --write")}     ${dim3("Detect and write .tmux-ide/workspace.yml")}
  ${cyan2("tmux-ide migrate --dry-run")} [--json]  ${dim3("Preview ide.yml migration")}
  ${cyan2("tmux-ide migrate --write")} [--json]    ${dim3("Create .tmux-ide/workspace.yml")}
  ${cyan2("tmux-ide config")} [--json]    ${dim3("Dump config as JSON")}
  ${cyan2("tmux-ide config set")} <path> <value>
  ${cyan2("tmux-ide config add-pane")} --row <N> --title <T> [--command <C>]
  ${cyan2("tmux-ide config remove-pane")} --row <N> --pane <M>
  ${cyan2("tmux-ide config add-row")} [--size <percent>]

${bold3("Pane Messaging:")}
  ${cyan2("tmux-ide send")} <target> <message>     ${dim3("Send message to a pane")}
  ${cyan2("tmux-ide send")} --to <name> <message>   ${dim3("Target by name, title, role, or ID")}
  ${cyan2("tmux-ide send")} <target> --no-enter msg  ${dim3("Send text without pressing Enter")}

${bold3("Server:")}
  ${cyan2("tmux-ide command-center")} [--port N]    ${dim3("Start the command-center HTTP API")}
  ${cyan2("tmux-ide server")} [--port N]            ${dim3("Start HTTP + PTY WebSocket server")}

${bold3("Discover (in the TUI):")}
  ${dim3("Bare")} ${cyan2("tmux-ide")} ${dim3("with no project config opens the HOME cockpit \u2014 the fleet home screen.")}
  ${dim3("Once a session is adopted, the whole UI is one keystroke away:")}
  ${cyan2("\u2325h")}  ${dim3("home cockpit from anywhere    ")}${cyan2("\u2325p")}  ${dim3("switch session")}
  ${cyan2("\u2325k")}  ${dim3("cheat sheet (all keys)        ")}${cyan2("\u2325m")}  ${dim3("actions menu (or right-click any pane / the bar)")}
  ${cyan2("\u2325e \u2325g \u2325,")}  ${dim3("file / changes / config panels   ")}${cyan2("\u2325b")}  ${dim3("sidebar")}
  ${dim3("A first-run welcome card names these keys once. Run")} ${cyan2("tmux-ide cheatsheet")} ${dim3("to see the full sheet.")}

${bold3("Flags:")}
  ${cyan2("--json")}                      ${dim3("Output as JSON (all commands)")}
  ${cyan2("--headless")}                  ${dim3("Canonical daemon only; no tmux workspace or TUI")}
  ${cyan2("--template <name>")}           ${dim3("Use specific template for init")}
  ${cyan2("--write")}                     ${dim3("Write detected config to .tmux-ide/workspace.yml")}
  ${cyan2("--dry-run")}                   ${dim3("Preview migration/restore without writing")}
  ${cyan2("--verbose")}                   ${dim3("Log all tmux commands (or set TMUX_IDE_DEBUG=1)")}
  ${cyan2("-h, --help")}                  ${dim3("Show usage")}
  ${cyan2("-v, --version")}               ${dim3("Show version number")}`);
}
function execBunWidget(surface, scriptPath, args, commandLabel, extraEnv = {}) {
  const launch2 = resolveTuiLaunch({
    surface,
    scriptPath,
    args,
    checkoutExists: existsSync35(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new IdeError(
      `\`tmux-ide ${commandLabel}\` is unavailable because ${launch2.reasons.join(" and ")}.
Install bun (https://bun.sh) \u2014 the TUI surfaces run on it. Sources ship with the npm package since v2.6.1.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  const env = {
    ...process.env,
    TMUX_IDE_CWD: process.cwd(),
    TMUX_IDE_CLI: nodeCliPath,
    ...extraEnv
  };
  if (launch2.mode === "bun") {
    execFileSync16(launch2.bin, launch2.argv, {
      stdio: "inherit",
      cwd: resolve28(__dirname5, ".."),
      env
    });
    return;
  }
  execFileSync16(launch2.bin, launch2.argv, { stdio: "inherit", env });
}
function launchHostedApp(scriptPath, appArgs) {
  const launch2 = resolveTuiLaunch({
    surface: "app",
    scriptPath,
    args: appArgs,
    checkoutExists: existsSync35(scriptPath),
    bunAvailable: isBunAvailable(),
    compiledBinary: findCompiledTui()
  });
  if (launch2.mode === "unavailable") {
    throw new IdeError(
      `\`tmux-ide app --detachable\` is unavailable because ${launch2.reasons.join(" and ")}.
Install bun (https://bun.sh) \u2014 the TUI surfaces run on it. Sources ship with the npm package since v2.6.1.`,
      { code: "USAGE", exitCode: 1 }
    );
  }
  let exists = true;
  try {
    execFileSync16("tmux", hostExistsArgv(), { stdio: "ignore" });
  } catch {
    exists = false;
  }
  if (!exists) {
    const cwd = launch2.mode === "bun" ? resolve28(__dirname5, "..") : process.cwd();
    const commandLine = hostedCommandLine(
      launch2.bin,
      launch2.argv,
      hostedEnvVars({
        cwd: process.cwd(),
        cli: nodeCliPath,
        path: process.env.PATH,
        home: process.env.TMUX_IDE_HOME,
        config: process.env.TMUX_IDE_CONFIG,
        tuiBin: process.env.TMUX_IDE_TUI_BIN
      })
    );
    execFileSync16("tmux", hostCreateArgv({ cwd, commandLine }), { stdio: "ignore" });
  }
  for (const args of hostSetupArgvs()) execFileSync16("tmux", args, { stdio: "ignore" });
  execFileSync16("tmux", hostAttachArgv(Boolean(process.env.TMUX)), { stdio: "inherit" });
}
async function printFleetJson() {
  const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
  const { listTeamProjects: listTeamProjects2 } = await Promise.resolve().then(() => (init_projects(), projects_exports));
  const { toFleetJson: toFleetJson2 } = await Promise.resolve().then(() => (init_report(), report_exports));
  console.log(JSON.stringify(toFleetJson2(listTeamProjects2(createStatusTracker2())), null, 2));
}
var socketFlag = values.socket;
async function waitOverSocket(params) {
  if (!socketFlag) return null;
  const { connectControl: connectControl2, ControlRequestError: ControlRequestError2 } = await Promise.resolve().then(() => (init_client(), client_exports));
  let client;
  try {
    client = await connectControl2({
      socketPath: typeof socketFlag === "string" ? socketFlag : void 0
    });
  } catch {
    return null;
  }
  try {
    const data = await client.request("wait", params);
    return { timedOut: false, data };
  } catch (err) {
    if (err instanceof ControlRequestError2 && err.code === "timeout") return { timedOut: true };
    return null;
  } finally {
    client.close();
  }
}
var teamScriptPath = resolve28(__dirname5, "../packages/daemon/src/tui/team/index.tsx");
var appScriptPath = resolve28(__dirname5, "../packages/daemon/src/tui/mirror/app.tsx");
function launchTeamCockpit() {
  execBunWidget("team", teamScriptPath, [], "team");
}
function runApp(appArgs) {
  const hosted = wantsHostedApp({
    flagDetachable: values.detachable === true,
    flagHosted: values.hosted === true,
    configDetachable: loadAppConfig().app.detachable,
    hostedEnv: process.env[HOSTED_ENV] === "1"
  });
  if (hosted) launchHostedApp(appScriptPath, appArgs);
  else execBunWidget("app", appScriptPath, appArgs, "app");
}
function launchApp() {
  runApp([]);
}
try {
  if (values.headless) {
    if (positionals.length > 0) {
      throw new IdeError("--headless cannot be combined with a command or project path", {
        code: "USAGE",
        exitCode: 2
      });
    }
    const pkg = await Promise.resolve().then(() => __toESM(require_package(), 1));
    await runHeadlessDaemon({
      port: values.port,
      json,
      expectedVersion: pkg.version
    });
    await new Promise((resolveFlush) => process.stdout.write("", resolveFlush));
    process.exit(0);
  }
  switch (command) {
    case "start": {
      if (!json) {
        try {
          const { getUpdateStatus: getUpdateStatus2 } = await Promise.resolve().then(() => (init_update_check(), update_check_exports));
          const { latest, updateAvailable } = getUpdateStatus2();
          if (updateAvailable && latest) {
            process.stderr.write(
              dim3(`\u2B06 tmux-ide v${latest} available \u2014 run \`tmux-ide update\`
`)
            );
          }
        } catch {
        }
      }
      const targetDir = resolve28(startTargetDir || ".");
      if (startTargetDir && !existsSync35(targetDir)) {
        throw new IdeError(
          `No workspace config found in ${targetDir}. Run "tmux-ide init" or "tmux-ide detect --write" to create one.`,
          { code: "CONFIG_NOT_FOUND", exitCode: 1 }
        );
      }
      const configContext = await resolveProjectConfigContext(targetDir);
      const entry = resolveEntry({
        configKind: configContext.configKind,
        hasWorkspaceConfig: configContext.hasWorkspaceConfig,
        hasIdeYml: configContext.hasIdeYml,
        teamFlag: values.team === true,
        frontDoor: loadAppConfig().app.frontDoor
      });
      if (entry !== "project") {
        if (json) {
          await printFleetJson();
          break;
        }
        if (entry === "app") launchApp();
        else launchTeamCockpit();
        break;
      }
      await launch(startTargetDir, { json });
      break;
    }
    case "init":
      await init({ template: values.template, json });
      break;
    case "stop":
      await stop(positionals[1], { json });
      break;
    case "attach":
      await attach(positionals[1], { json });
      break;
    case "restart":
      await restart(positionals[1], { json });
      break;
    case "restore":
      await restore({
        json,
        dryRun: values["dry-run"] === true,
        runCommands: values["run-commands"] === true,
        resumeAgents: values["resume-agents"] === true
      });
      break;
    case "ls":
      await ls({ json });
      break;
    case "doctor":
      await doctor({ json });
      break;
    case "status":
      await status(positionals[1], { json });
      break;
    case "inspect":
      await inspect(positionals[1], { json });
      break;
    case "validate":
      await validate(positionals[1], { json });
      break;
    case "detect":
      await detect(positionals[1], { json, write: values.write });
      break;
    case "migrate":
      await migrate(positionals[1], { json, dryRun: values["dry-run"], write: values.write });
      break;
    case "config": {
      const sub = positionals[1];
      let action = "dump";
      let configArgs = [];
      if (sub === "set") {
        action = "set";
        configArgs = positionals.slice(2);
      } else if (sub === "add-pane") {
        action = "add-pane";
        configArgs = [];
        if (values.row !== void 0) configArgs.push("--row", values.row);
        if (values.title !== void 0) configArgs.push("--title", values.title);
        if (values.command !== void 0) configArgs.push("--command", values.command);
        if (values.size !== void 0) configArgs.push("--size", values.size);
      } else if (sub === "remove-pane") {
        action = "remove-pane";
        configArgs = [];
        if (values.row !== void 0) configArgs.push("--row", values.row);
        if (values.pane !== void 0) configArgs.push("--pane", values.pane);
      } else if (sub === "add-row") {
        action = "add-row";
        configArgs = [];
        if (values.size !== void 0) configArgs.push("--size", values.size);
      } else if (sub === "enable-team") {
        action = "enable-team";
        configArgs = [];
        if (values.name !== void 0) configArgs.push("--name", values.name);
      } else if (sub === "disable-team") {
        action = "disable-team";
        configArgs = [];
      } else if (sub === "edit") {
        const scriptPath = resolve28(__dirname5, "../packages/daemon/src/widgets/setup/index.tsx");
        execBunWidget(
          "setup",
          scriptPath,
          ["--dir=" + resolve28(startTargetDir || "."), "--edit"],
          "config edit"
        );
        break;
      }
      await config(null, { json, action, args: configArgs });
      break;
    }
    case "setup": {
      const scriptPath = resolve28(__dirname5, "../packages/daemon/src/widgets/setup/index.tsx");
      const setupArgs = ["--dir=" + resolve28(startTargetDir || ".")];
      if (positionals[1] === "--edit" || values.edit) setupArgs.push("--edit");
      if (positionals[1] === "--wizard" || values.wizard) setupArgs.push("--wizard");
      execBunWidget("setup", scriptPath, setupArgs, "setup");
      break;
    }
    case "send": {
      const target = values.to ?? positionals[1];
      const messageStart = values.to ? 1 : 2;
      let message = positionals.slice(messageStart).join(" ");
      if (!message && !process.stdin.isTTY) {
        const { readFileSync: readFileSync24 } = await import("node:fs");
        message = readFileSync24(0, "utf-8").trim();
      }
      await send(null, { json, to: target, message, noEnter: values["no-enter"] });
      break;
    }
    case "settings": {
      const scriptPath = resolve28(__dirname5, "../packages/daemon/src/widgets/config/index.tsx");
      execBunWidget("config", scriptPath, ["--dir=" + resolve28(startTargetDir || ".")], "settings");
      break;
    }
    case "team": {
      if (json) {
        await printFleetJson();
        break;
      }
      if (values.popup === true) {
        const clientArg = typeof values.client === "string" ? values.client : "";
        execBunWidget("team", teamScriptPath, [], "team --popup", {
          TMUX_IDE_POPUP_CLIENT: clientArg
        });
        break;
      }
      launchTeamCockpit();
      break;
    }
    case "app": {
      const session = positionals[1];
      const appArgs = session ? [`--target=${session}`] : [];
      runApp(appArgs);
      break;
    }
    case "switcher": {
      const clientArg = typeof values.client === "string" ? values.client : "";
      execBunWidget("team", teamScriptPath, [], "switcher", { TMUX_IDE_PICKER_CLIENT: clientArg });
      break;
    }
    case "wait": {
      const sub = positionals[1];
      if (sub === "output") {
        const target = positionals[2];
        const pattern = values.match;
        if (!target || typeof pattern !== "string" || pattern.length === 0) {
          console.error(
            "Usage: tmux-ide wait output <pane|session> --match <regex> [--timeout <ms>] [--socket[=path]]"
          );
          process.exit(1);
        }
        try {
          new RegExp(pattern);
        } catch (err) {
          console.error(`Invalid --match regex: ${err.message}`);
          process.exit(1);
        }
        const outTimeout = Number(values.timeout ?? "60000");
        const viaSocket2 = await waitOverSocket({
          kind: "output",
          target,
          match: pattern,
          timeoutMs: outTimeout
        });
        if (viaSocket2) {
          if (viaSocket2.timedOut) {
            console.error(
              `Timed out after ${outTimeout}ms waiting for ${target} output to match /${pattern}/`
            );
            process.exit(1);
          }
          const hit = viaSocket2.data.matched;
          if (json) console.log(JSON.stringify({ matched: hit }));
          else console.log(hit);
          process.exit(0);
        }
        const { waitForOutputMatch: waitForOutputMatch2 } = await Promise.resolve().then(() => (init_wait(), wait_exports));
        const result2 = await waitForOutputMatch2(target, pattern, { timeoutMs: outTimeout });
        if (!result2.ok) {
          console.error(
            `Timed out after ${outTimeout}ms waiting for ${target} output to match /${pattern}/`
          );
          process.exit(1);
        }
        if (json) console.log(JSON.stringify({ matched: result2.matched }));
        else console.log(result2.matched);
        process.exit(0);
      }
      const VALID = /* @__PURE__ */ new Set(["blocked", "working", "done", "idle", "unknown"]);
      const sessionName = positionals[2];
      const want = values.status;
      if (sub !== "agent-status" || !sessionName || typeof want !== "string" || !VALID.has(want)) {
        console.error(
          "Usage: tmux-ide wait agent-status <session> --status <blocked|working|done|idle|unknown> [--timeout <ms>] [--socket[=path]]"
        );
        process.exit(1);
      }
      const timeout = Number(values.timeout ?? "60000");
      const viaSocket = await waitOverSocket({
        kind: "agent-status",
        session: sessionName,
        status: want,
        timeoutMs: timeout
      });
      if (viaSocket) {
        if (viaSocket.timedOut) {
          console.error(
            `Timed out after ${timeout}ms waiting for ${sessionName} to reach status "${want}"`
          );
          process.exit(1);
        }
        if (json) console.log(JSON.stringify({ session: sessionName, status: want, ok: true }));
        else console.log(`${sessionName} reached status: ${want}`);
        process.exit(0);
      }
      const { waitForAgentStatus: waitForAgentStatus2 } = await Promise.resolve().then(() => (init_wait(), wait_exports));
      const result = await waitForAgentStatus2(
        sessionName,
        want,
        { timeoutMs: timeout }
      );
      if (!result.ok) {
        console.error(
          `Timed out after ${timeout}ms waiting for ${sessionName} to reach status "${want}" (last: ${result.status ?? "absent"})`
        );
        process.exit(1);
      }
      if (json) {
        console.log(JSON.stringify({ session: sessionName, status: result.status, ok: true }));
      } else {
        console.log(`${sessionName} reached status: ${result.status}`);
      }
      process.exit(0);
      break;
    }
    case "events": {
      const { readFileSync: readFileSync24, existsSync: existsSync36, statSync: statSync7, openSync: openSync3, readSync, closeSync: closeSync3 } = await import("node:fs");
      const { eventsPath: eventsPath2, formatEventLine: formatEventLine2 } = await Promise.resolve().then(() => (init_events(), events_exports));
      const path2 = eventsPath2();
      const paintStatus = (status2, text) => {
        if (noColor || status2 === null) return text;
        const code = status2 === "blocked" ? "203" : status2 === "working" ? "221" : status2 === "done" ? "111" : status2 === "idle" ? "114" : "244";
        return `\x1B[38;5;${code}m${text}\x1B[39m`;
      };
      const printLine = (raw) => {
        if (json) {
          console.log(raw);
          return;
        }
        try {
          const ev = JSON.parse(raw);
          console.log(formatEventLine2(ev, paintStatus));
        } catch {
        }
      };
      if (values.follow && socketFlag) {
        const { connectControl: connectControl2 } = await Promise.resolve().then(() => (init_client(), client_exports));
        const client = await connectControl2({
          socketPath: typeof socketFlag === "string" ? socketFlag : void 0
        }).catch(() => null);
        if (client) {
          if (existsSync36(path2)) {
            const backlog = readFileSync24(path2, "utf8").split("\n").filter((l) => l.trim().length > 0);
            for (const line of backlog.slice(-50)) printLine(line);
          }
          await client.subscribe((frame) => {
            if (frame.event === "agent-status") printLine(JSON.stringify(frame.data));
          });
          process.on("SIGINT", () => {
            client.close();
            process.exit(0);
          });
          await client.done;
          break;
        }
      }
      if (!existsSync36(path2)) {
        console.log("no events yet \u2014 is a session adopted? (the chrome updater writes events)");
        break;
      }
      const allLines = readFileSync24(path2, "utf8").split("\n").filter((l) => l.trim().length > 0);
      for (const line of allLines.slice(-50)) printLine(line);
      if (!values.follow) break;
      let offset = statSync7(path2).size;
      let leftover = "";
      const timer = setInterval(() => {
        let size;
        try {
          size = statSync7(path2).size;
        } catch {
          return;
        }
        if (size < offset) {
          offset = 0;
          leftover = "";
        }
        if (size <= offset) return;
        const fd = openSync3(path2, "r");
        try {
          const buf = Buffer.alloc(size - offset);
          readSync(fd, buf, 0, buf.length, offset);
          offset = size;
          const parts = (leftover + buf.toString("utf8")).split("\n");
          leftover = parts.pop() ?? "";
          for (const line of parts) if (line.trim().length > 0) printLine(line);
        } finally {
          closeSync3(fd);
        }
      }, 500);
      process.on("SIGINT", () => {
        clearInterval(timer);
        process.exit(0);
      });
      await new Promise(() => {
      });
      break;
    }
    case "statusline": {
      try {
        const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
        const { listTeamProjects: listTeamProjects2 } = await Promise.resolve().then(() => (init_projects(), projects_exports));
        const { buildStatusline: buildStatusline2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const projects = listTeamProjects2(createStatusTracker2());
        console.log(buildStatusline2(projects, values.active ?? null, 12, getAppConfig2().theme));
      } catch {
        console.log("#[fg=colour75,bold] tmux-ide #[default]");
      }
      break;
    }
    case "adopt": {
      const { adoptSession: adoptSession2, adoptableSessionNames: adoptableSessionNames2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
      if (values.all) {
        const raw = execFileSync16("tmux", ["list-sessions", "-F", "#{session_name}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
        const targets = raw ? adoptableSessionNames2(raw.split("\n")) : [];
        if (targets.length === 0) {
          console.log("no adoptable sessions");
          break;
        }
        for (const name of targets) {
          adoptSession2(name);
          console.log(`adopted ${name}`);
        }
        break;
      }
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide adopt <session> | tmux-ide adopt --all");
        process.exit(1);
      }
      adoptSession2(target);
      console.log(`adopted ${target} \u2014 chrome row active (unadopt to remove)`);
      break;
    }
    case "unadopt": {
      const { unadoptSession: unadoptSession2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
      const target = positionals[1];
      if (!target) {
        console.error("Usage: tmux-ide unadopt <session>");
        process.exit(1);
      }
      unadoptSession2(target);
      console.log(`unadopted ${target}`);
      break;
    }
    case "agent": {
      const sub = positionals[1];
      const target = positionals[2];
      if (sub !== "explain" || !target) {
        console.error(
          "Usage: tmux-ide agent explain <pane> [--json]\n  <pane>  a pane id (%N) or a session name (uses its active pane)\n  Prints how the fleet detector classifies the pane: authority,\n  hint, resolved manifest, per-state rule results, and the snapshot."
        );
        process.exit(1);
      }
      const { agentExplain: agentExplain2 } = await Promise.resolve().then(() => (init_agent_explain(), agent_explain_exports));
      agentExplain2(target, { json });
      break;
    }
    case "integration": {
      const sub = positionals[1];
      const agent = positionals[2];
      const needsAgent = sub === "install" || sub === "uninstall";
      const installable = agent === "claude" || agent === "opencode";
      if (!sub || needsAgent && !installable) {
        console.error(
          "Usage: tmux-ide integration <install|uninstall|status|offer> [claude|opencode]\n  install    claude: hook lifecycle events into tmux pane state\n             opencode: plugin that records the session id for restore --resume-agents\n  uninstall  remove exactly the tmux-ide entries for that agent\n  status     list discovered agents + integration/capture state\n  offer      one-time first-adopt install prompt (used by the popup)"
        );
        process.exit(1);
      }
      if (needsAgent && agent === "opencode") {
        const oc = await Promise.resolve().then(() => (init_opencode(), opencode_exports));
        if (sub === "install") {
          const { pluginPath } = oc.installOpencodeIntegration();
          console.log(`plugin: ${pluginPath}`);
          console.log(
            "installed \u2014 NEW opencode sessions record their session id into the pane\n(@agent_session_id), so `tmux-ide restore --resume-agents` can revive them."
          );
        } else {
          const { wasInstalled } = oc.uninstallOpencodeIntegration();
          console.log(wasInstalled ? "uninstalled \u2014 plugin removed" : "was not installed");
        }
        break;
      }
      const mod = await Promise.resolve().then(() => (init_claude(), claude_exports));
      if (sub === "install") {
        const { scriptPath, settingsPath } = mod.installClaudeIntegration();
        const { syncSkill: syncSkill2 } = await Promise.resolve().then(() => (init_skill_sync(), skill_sync_exports));
        const skill = syncSkill2();
        console.log(`hook script: ${scriptPath}`);
        console.log(`settings:    ${settingsPath} (backup written once as .tmux-ide.bak)`);
        console.log(`skill:       ${skill.action} \u2192 ${skill.path} (v${skill.to})`);
        console.log(
          "installed \u2014 NEW Claude Code sessions now report working/blocked/done authoritatively into the tmux-ide chrome."
        );
        const { getAppConfig: getAppConfig2, updateAppConfig: updateAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const forcedKey = process.env.TMUX_IDE_NOTIFY_KEY;
        const canAsk = forcedKey !== void 0 || process.stdin.isTTY === true;
        if (process.platform === "darwin" && !getAppConfig2().notifications.macos && canAsk) {
          const act = (key) => {
            if (key === "y" || key === "Y") {
              updateAppConfig2({ notifications: { macos: true } });
              console.log(
                "macOS notifications on \u2014 native branded banners will jump to the session when clicked."
              );
            } else {
              console.log(
                "skipped \u2014 turn banners on anytime: notifications.macos in ~/.tmux-ide/config.json."
              );
            }
          };
          process.stdout.write("\nAlso get a macOS notification when an agent needs you? [y/N] ");
          if (forcedKey !== void 0) {
            console.log(forcedKey);
            act(forcedKey);
          } else {
            const key = await new Promise((resolve29) => {
              try {
                process.stdin.setRawMode?.(true);
                process.stdin.resume();
                process.stdin.once("data", (data) => resolve29(data.toString()));
              } catch {
                resolve29("");
              }
            });
            try {
              process.stdin.setRawMode?.(false);
              process.stdin.pause();
            } catch {
            }
            console.log(/^[ -~]$/.test(key) ? key : "");
            act(key);
          }
        }
      } else if (sub === "uninstall") {
        const { wasInstalled } = mod.uninstallClaudeIntegration();
        console.log(wasInstalled ? "uninstalled \u2014 hook entries removed" : "was not installed");
      } else if (sub === "offer") {
        const offerMod = await Promise.resolve().then(() => (init_offer(), offer_exports));
        try {
          console.log(offerMod.buildOfferText());
        } catch {
          console.log("Claude Code detected \u2014 install the tmux-ide integration? [y/N]");
        }
        const act = (key) => {
          offerMod.markIntegrationOffered();
          if (key === "y" || key === "Y") {
            try {
              mod.installClaudeIntegration();
              console.log("\ninstalled \u2014 new Claude Code sessions now report state to tmux-ide.");
            } catch (e) {
              console.log(`
install failed: ${e.message}`);
            }
          } else {
            console.log("\nskipped \u2014 run `tmux-ide integration install claude` anytime.");
          }
        };
        const forced = process.env.TMUX_IDE_OFFER_KEY;
        if (forced !== void 0) {
          act(forced);
          process.exit(0);
        }
        const closeOffer = () => process.exit(0);
        const offerTimer = setTimeout(closeOffer, 6e4);
        offerTimer.unref?.();
        try {
          process.stdin.setRawMode?.(true);
          process.stdin.resume();
          process.stdin.once("data", (data) => {
            act(data.toString());
            console.log("\n[ press any key to close ]");
            process.stdin.once("data", closeOffer);
            process.stdin.once("end", closeOffer);
          });
          process.stdin.once("end", closeOffer);
        } catch {
          closeOffer();
        }
      } else {
        const { discoverAgents: discoverAgents2 } = await Promise.resolve().then(() => (init_agent_discovery(), agent_discovery_exports));
        const agents = discoverAgents2();
        if (json) {
          console.log(JSON.stringify({ agents }, null, 2));
          break;
        }
        for (const a of agents) {
          let state;
          if (a.path === null) state = "not found";
          else if (a.integration)
            state = a.installed ? "integration installed \u2713" : "on PATH \u2014 integration not installed";
          else state = "detected (no integration)";
          let capture = "";
          if (a.path !== null) {
            if (a.capture === "probe") capture = " \xB7 session-id capture: automatic";
            else if (a.capture !== null)
              capture = a.captureActive ? ` \xB7 session-id capture: ${a.capture} \u2713` : ` \xB7 session-id capture: ${a.capture} (install to enable)`;
            else capture = " \xB7 session-id capture: none";
          }
          console.log(`  ${a.id.padEnd(10)} ${state}${capture}`);
        }
      }
      break;
    }
    case "chrome-updater": {
      try {
        const { runUpdaterLoop: runUpdaterLoop2 } = await Promise.resolve().then(() => (init_updater(), updater_exports));
        runUpdaterLoop2();
      } catch {
        process.exit(0);
      }
      break;
    }
    case "cheatsheet": {
      try {
        const { buildCheatsheet: buildCheatsheet2 } = await Promise.resolve().then(() => (init_cheatsheet(), cheatsheet_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const cfg = getAppConfig2();
        console.log(
          buildCheatsheet2({
            width: process.stdout.columns ?? 100,
            keys: cfg.keys,
            theme: cfg.theme
          })
        );
      } catch {
        console.log("tmux-ide \u2014 press \u2325p for the switcher, \u2325k for this sheet. Any key closes.");
      }
      const close = () => process.exit(0);
      const timer = setTimeout(close, 6e4);
      timer.unref?.();
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", close);
        process.stdin.once("end", close);
      } catch {
        close();
      }
      break;
    }
    case "welcome": {
      try {
        const { buildWelcomeText: buildWelcomeText2 } = await Promise.resolve().then(() => (init_welcome(), welcome_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        console.log(buildWelcomeText2(getAppConfig2().keys));
      } catch {
        console.log(
          "Welcome to tmux-ide. Right-click for the menu \xB7 \u2325h home \xB7 \u2325p switch \xB7 \u2325k all keys."
        );
      }
      const closeWelcome = () => process.exit(0);
      const welcomeTimer = setTimeout(closeWelcome, 6e4);
      welcomeTimer.unref?.();
      try {
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", closeWelcome);
        process.stdin.once("end", closeWelcome);
      } catch {
        closeWelcome();
      }
      break;
    }
    case "menu": {
      try {
        const tmuxCap = {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3
        };
        const rawClient = typeof values.client === "string" ? values.client : "";
        let client = rawClient && !rawClient.includes("#{") ? rawClient : "";
        if (!client) {
          const raw = execFileSync16(
            "tmux",
            ["list-clients", "-F", "#{client_activity} #{client_name}"],
            tmuxCap
          ).trim();
          const newest = raw.split("\n").filter(Boolean).map((line) => {
            const sp = line.indexOf(" ");
            return { activity: Number(line.slice(0, sp)), name: line.slice(sp + 1) };
          }).sort((a, b) => b.activity - a.activity)[0];
          client = newest?.name ?? "";
        }
        if (!client) break;
        const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
        const { listTeamSessions: listTeamSessions2 } = await Promise.resolve().then(() => (init_sessions2(), sessions_exports));
        const { buildMenu: buildMenu2, menuPositionArgs: menuPositionArgs2 } = await Promise.resolve().then(() => (init_menu(), menu_exports));
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const { getUpdateStatus: getUpdateStatus2 } = await Promise.resolve().then(() => (init_update_check(), update_check_exports));
        const sessions = listTeamSessions2(createStatusTracker2()).map((s) => ({
          name: s.name,
          status: s.status
        }));
        const position = menuPositionArgs2(
          typeof values.x === "string" ? values.x : void 0,
          typeof values.y === "string" ? values.y : void 0
        );
        const args = [
          "display-menu",
          "-c",
          client,
          ...position,
          ...buildMenu2(sessions, getAppConfig2().theme, getUpdateStatus2())
        ];
        execFileSync16("tmux", args, { stdio: "ignore", timeout: 2e3 });
      } catch {
      }
      break;
    }
    case "popup": {
      const { POPUP_WIDGETS: POPUP_WIDGETS2 } = await Promise.resolve().then(() => (init_panels(), panels_exports));
      const widget = positionals[1];
      if (!widget || !POPUP_WIDGETS2.includes(widget)) {
        throw new IdeError(
          `Usage: tmux-ide popup <widget>
Known panels: ${POPUP_WIDGETS2.join(", ")}.`,
          { code: "USAGE", exitCode: 1 }
        );
      }
      const scriptPath = resolve28(__dirname5, "../packages/daemon/src/widgets", widget, "index.tsx");
      let popupSession = "";
      try {
        popupSession = execFileSync16("tmux", ["display-message", "-p", "#{session_name}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 2e3
        }).trim();
      } catch {
      }
      const popupArgs = [`--dir=${process.cwd()}`];
      if (popupSession) popupArgs.push(`--session=${popupSession}`);
      execBunWidget(widget, scriptPath, popupArgs, `popup ${widget}`);
      break;
    }
    case "sidebar-toggle": {
      try {
        const {
          findSidebarPane: findSidebarPane2,
          openSidebarPane: openSidebarPane2,
          closeSidebarPane: closeSidebarPane2,
          resolveSidebarConfig: resolveSidebarConfig2,
          DEFAULT_SIDEBAR_WIDTH: DEFAULT_SIDEBAR_WIDTH2
        } = await Promise.resolve().then(() => (init_sidebar(), sidebar_exports));
        let session = typeof values.session === "string" ? values.session.trim() : "";
        if (!session || session.includes("#{")) {
          try {
            session = execFileSync16("tmux", ["display-message", "-p", "#{session_name}"], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
              timeout: 2e3
            }).trim();
          } catch {
            session = "";
          }
        }
        if (!session) break;
        const existing = findSidebarPane2(session);
        if (existing) {
          closeSidebarPane2(existing);
          break;
        }
        const { getSessionCwd: getSessionCwd3 } = await Promise.resolve().then(() => (init_src2(), src_exports));
        let dir = process.cwd();
        try {
          dir = getSessionCwd3(session) ?? dir;
        } catch {
        }
        let width = DEFAULT_SIDEBAR_WIDTH2;
        let theme = null;
        try {
          const resolved2 = await resolveConfig(dir);
          const config2 = resolved2.launchConfig;
          theme = config2?.theme ?? null;
          const sb = resolveSidebarConfig2(config2?.sidebar);
          if (sb.enabled) width = sb.width;
        } catch {
        }
        openSidebarPane2(session, dir, width, theme);
      } catch {
      }
      break;
    }
    case "worktree": {
      let printSwitchHint = function(name, wtPath) {
        console.log(`Worktree ready: ${wtPath}`);
        console.log(`Session: ${name}`);
        if (process.env.TMUX) {
          console.log(`Switch to it:  tmux switch-client -t '${name}'`);
        } else {
          console.log(`Attach to it:  tmux attach -t '${name}'`);
        }
      };
      printSwitchHint2 = printSwitchHint;
      const sub = positionals[1];
      const KNOWN_SUBS = /* @__PURE__ */ new Set(["create", "open", "list", "remove"]);
      if (!sub || !KNOWN_SUBS.has(sub)) {
        throw new IdeError(
          "Usage: tmux-ide worktree <create|open|list|remove> <branch> [flags]\n  create <branch> [--from <ref>] [--dir <path>] [--no-session]\n  open <branch>\n  list [--json]\n  remove <branch> [--force]",
          { code: "USAGE", exitCode: 1 }
        );
      }
      const {
        worktreeSessionName: worktreeSessionName2,
        worktreePath: worktreePath2,
        listWorktrees: listWorktrees2,
        createWorktree: createWorktree2,
        removeWorktree: removeWorktree2,
        WorktreeError: WorktreeError2
      } = await Promise.resolve().then(() => (init_worktree(), worktree_exports));
      const { getSessionCwd: getSessionCwd3, hasSession: hasSession2, killSession: killSession2, createDetachedSession: createDetachedSession2 } = await Promise.resolve().then(() => (init_src2(), src_exports));
      let repoDir = process.cwd();
      const sessionArg = typeof values.session === "string" ? values.session.trim() : "";
      if (sessionArg && !sessionArg.includes("#{")) {
        try {
          const cwd = getSessionCwd3(sessionArg);
          if (cwd) repoDir = cwd;
        } catch {
        }
      }
      const worktrees = listWorktrees2(repoDir);
      const mainPath = worktrees[0]?.path ?? repoDir;
      const projectName = (await resolveProjectConfigContext(mainPath)).sessionName;
      async function openWorktreeSession(wtPath, name) {
        const worktreeContext = await resolveProjectConfigContext(wtPath);
        if (worktreeContext.configKind !== "none") {
          await launch(wtPath, { attach: false, sessionName: name });
        } else {
          if (!hasSession2(name)) createDetachedSession2(name, wtPath);
          const { adoptSession: adoptSession2 } = await Promise.resolve().then(() => (init_statusline(), statusline_exports));
          adoptSession2(name);
        }
      }
      if (sub === "create") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError(
            "Usage: tmux-ide worktree create <branch> [--from <ref>] [--dir <path>] [--no-session]",
            { code: "USAGE", exitCode: 1 }
          );
        }
        const { getAppConfig: getAppConfig2 } = await Promise.resolve().then(() => (init_app_config(), app_config_exports));
        const dirOverride = typeof values.dir === "string" && values.dir.length > 0 ? values.dir : getAppConfig2().worktrees.dir || null;
        const wtPath = worktreePath2(repoDir, branch, dirOverride);
        const from = typeof values.from === "string" ? values.from : null;
        try {
          createWorktree2(repoDir, branch, wtPath, { newBranch: true, from });
        } catch (err) {
          if (err instanceof WorktreeError2 && err.code === "BRANCH_EXISTS" && !from) {
            createWorktree2(repoDir, branch, wtPath, { newBranch: false });
          } else {
            throw err;
          }
        }
        const sessionName = worktreeSessionName2(projectName, branch);
        if (!values["no-session"]) {
          await openWorktreeSession(wtPath, sessionName);
        }
        if (json) {
          console.log(
            JSON.stringify({
              branch,
              path: wtPath,
              session: values["no-session"] ? null : sessionName
            })
          );
        } else if (values["no-session"]) {
          console.log(`Worktree ready: ${wtPath}`);
          console.log(`Open a session later:  tmux-ide worktree open '${branch}'`);
        } else {
          printSwitchHint(sessionName, wtPath);
        }
        break;
      }
      if (sub === "open") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError("Usage: tmux-ide worktree open <branch>", {
            code: "USAGE",
            exitCode: 1
          });
        }
        const entry = worktrees.find((w) => w.branch === branch);
        if (!entry) {
          throw new IdeError(
            `No worktree for branch "${branch}". Create one with: tmux-ide worktree create '${branch}'`,
            { code: "USAGE", exitCode: 1 }
          );
        }
        const sessionName = worktreeSessionName2(projectName, branch);
        const already = hasSession2(sessionName);
        if (!already) await openWorktreeSession(entry.path, sessionName);
        if (json) {
          console.log(
            JSON.stringify({ branch, path: entry.path, session: sessionName, created: !already })
          );
        } else {
          if (already) console.log(`Session already running.`);
          printSwitchHint(sessionName, entry.path);
        }
        break;
      }
      if (sub === "remove") {
        const branch = positionals[2];
        if (!branch) {
          throw new IdeError("Usage: tmux-ide worktree remove <branch> [--force]", {
            code: "USAGE",
            exitCode: 1
          });
        }
        const entry = worktrees.find((w) => w.branch === branch);
        if (!entry) {
          throw new IdeError(`No worktree for branch "${branch}".`, {
            code: "USAGE",
            exitCode: 1
          });
        }
        removeWorktree2(repoDir, entry.path, { force: values.force === true });
        const sessionName = worktreeSessionName2(projectName, branch);
        const killed = hasSession2(sessionName) ? killSession2(sessionName).stopped : false;
        if (json) {
          console.log(
            JSON.stringify({ branch, path: entry.path, sessionKilled: killed, removed: true })
          );
        } else {
          console.log(`Removed worktree ${entry.path}${killed ? ` (killed ${sessionName})` : ""}.`);
        }
        break;
      }
      const { createStatusTracker: createStatusTracker2 } = await Promise.resolve().then(() => (init_classify(), classify_exports));
      const { listTeamSessions: listTeamSessions2 } = await Promise.resolve().then(() => (init_sessions2(), sessions_exports));
      const sessions = listTeamSessions2(createStatusTracker2());
      const rows = worktrees.map((wt) => {
        const isPrimary = wt.path === mainPath;
        const candidates = [];
        if (isPrimary) candidates.push(projectName);
        if (wt.branch) candidates.push(worktreeSessionName2(projectName, wt.branch));
        const match = sessions.find((s) => candidates.includes(s.name)) ?? null;
        return {
          path: wt.path,
          branch: wt.branch,
          primary: isPrimary,
          session: match?.name ?? null,
          running: match !== null,
          status: match?.status ?? null
        };
      });
      if (json) {
        console.log(JSON.stringify({ repo: mainPath, worktrees: rows }, null, 2));
      } else if (rows.length === 0) {
        console.log("No worktrees.");
      } else {
        for (const r of rows) {
          const tag = r.primary ? " (primary)" : "";
          const state = r.running ? `${r.status} \xB7 ${r.session}` : "no session";
          console.log(`${r.branch ?? "(detached)"}${tag}  ${state}
    ${r.path}`);
        }
      }
      break;
    }
    case "update": {
      if (values["manifests"] === true) {
        const { updateManifestPack: updateManifestPack2 } = await Promise.resolve().then(() => (init_manifest_pack(), manifest_pack_exports));
        try {
          const r = await updateManifestPack2({ log: (m) => console.error(m) });
          if (json) {
            console.log(JSON.stringify({ ok: true, ...r }, null, 2));
          } else {
            console.log(
              `manifest pack ${r.packVersion} installed (${r.count} manifests): ${r.path}`
            );
            console.log(
              "your own agent-detection/*.json overrides still win \u2014 the pack merges beneath them"
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
          else console.error(`manifest pack NOT installed: ${message}`);
          process.exitCode = 1;
        }
        break;
      }
      if (values["tui-binary"] === true) {
        const { downloadTuiBinary: downloadTuiBinary2 } = await Promise.resolve().then(() => (init_tui_binary(), tui_binary_exports));
        const { path: path2 } = await downloadTuiBinary2({ log: (m) => console.error(m) });
        if (json) {
          console.log(JSON.stringify({ ok: true, path: path2 }, null, 2));
        } else {
          console.log(`TUI binary ready: ${path2}`);
        }
        break;
      }
      const { runUpdate: runUpdate2 } = await Promise.resolve().then(() => (init_update(), update_exports));
      const dryRun = values["dry-run"] === true;
      const plan = runUpdate2({ cliDir: __dirname5, dryRun });
      if (!dryRun) {
        const { syncSkill: syncSkill2 } = await Promise.resolve().then(() => (init_skill_sync(), skill_sync_exports));
        if (plan.method === "dev") {
          const result = syncSkill2();
          console.log("");
          console.log(`skill: ${result.action} \u2192 ${result.path} (v${result.to})`);
        } else {
          console.log("");
          console.log("skill: refreshed by the package postinstall (~/.claude/skills/tmux-ide)");
        }
      }
      break;
    }
    case "skill-sync": {
      const { syncSkill: syncSkill2 } = await Promise.resolve().then(() => (init_skill_sync(), skill_sync_exports));
      const result = syncSkill2();
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const detail = result.action === "updated" && result.from ? ` (v${result.from} \u2192 v${result.to})` : ` (v${result.to})`;
        console.log(`skill ${result.action}${detail}: ${result.path}`);
      }
      break;
    }
    case "serve": {
      const { startControlServer: startControlServer2, defaultControlSocketPath: defaultControlSocketPath2 } = await Promise.resolve().then(() => (init_server2(), server_exports2));
      const socketPath = typeof socketFlag === "string" ? socketFlag : positionals[1] ?? defaultControlSocketPath2();
      const server = await startControlServer2({
        socketPath,
        log: (m) => console.error(`[serve] ${m}`)
      });
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void server.close().then(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      await new Promise(() => {
      });
      break;
    }
    case "command-center": {
      const { startCommandCenter: startCommandCenter2 } = await Promise.resolve().then(() => (init_command_center(), command_center_exports));
      await startCommandCenter2({ port: parseInt(values.port ?? "4000") });
      break;
    }
    case "server": {
      if ("bun" in process.versions) {
        const scriptPath = resolve28(__dirname5, "../packages/daemon/src/server/standalone.ts");
        const serverArgs = ["--experimental-strip-types", scriptPath];
        if (values.port) serverArgs.push("--port", values.port);
        execFileSync16("node", serverArgs, { stdio: "inherit" });
      } else {
        const { start: start2 } = await Promise.resolve().then(() => (init_server3(), server_exports3));
        await start2(values.port ? parseInt(values.port, 10) : void 0);
      }
      break;
    }
    case "help":
      printHelp();
      break;
    default:
      throw new IdeError(`Unknown command: ${command}
Run "tmux-ide help" for usage.`, {
        code: "USAGE",
        exitCode: 1
      });
  }
} catch (error) {
  if (error instanceof IdeError) {
    printCommandError(error, { json });
  } else {
    throw error;
  }
}
var printSwitchHint2;
