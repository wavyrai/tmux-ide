/**
 * Repository-scoped `.tmux-ide/workspace.yml` contract.
 *
 * This is intentionally separate from both the legacy `IdeConfigSchema` and
 * the daemon's runtime `WorkspaceSchemaZ` registry record. V1 describes
 * declarative workspace composition only; it has no runtime/task state and no
 * provider-specific harness or model enums.
 */

import { z } from "zod";
import { PaneSchema, RowSchema, ThemeConfigSchema } from "./ide-config.ts";

const NonEmptyStringSchema = z.string().min(1);
const ProfileNameSchema = z.string().min(1);

/** A shell command or an explicit executable/argv vector. */
export const WorkspaceCommandSchemaZ = z.union([
  NonEmptyStringSchema,
  z.array(NonEmptyStringSchema).min(1),
]);

/**
 * Reuse stable legacy terminal-pane validators without carrying agent-team
 * role/task/specialty/skill metadata into the new workspace contract.
 */
export const WorkspaceTerminalPaneSchemaZ = PaneSchema.pick({
  title: true,
  command: true,
  type: true,
  target: true,
  dir: true,
  size: true,
  focus: true,
  env: true,
}).strict();

export const WorkspaceTerminalRowSchemaZ = z.strictObject({
  size: RowSchema.shape.size,
  panes: z.array(WorkspaceTerminalPaneSchemaZ).min(1),
});

export const WorkspaceTerminalConfigSchemaZ = z.strictObject({
  rows: z.array(WorkspaceTerminalRowSchemaZ).min(1),
  theme: ThemeConfigSchema.strict().optional(),
});

export const WorkspacePanelKindSchemaZ = z.enum(["home", "terminals", "files", "diff", "missions"]);

const WorkspaceLayoutIdSchemaZ = NonEmptyStringSchema.max(128);

type WorkspaceAppLayoutNodeInput =
  | {
      type: "panel";
      id: string;
      panel: z.infer<typeof WorkspacePanelKindSchemaZ>;
      min_size?: number;
    }
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      children: WorkspaceAppLayoutNodeInput[];
      weights?: number[];
    }
  | {
      type: "tabs";
      id: string;
      children: WorkspaceAppLayoutNodeInput[];
      active?: string;
    };

export const WorkspaceAppLayoutNodeSchemaZ: z.ZodType<WorkspaceAppLayoutNodeInput> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("panel"),
      id: WorkspaceLayoutIdSchemaZ,
      panel: WorkspacePanelKindSchemaZ,
      min_size: z.number().int().positive().optional(),
    }),
    z.strictObject({
      type: z.literal("split"),
      id: WorkspaceLayoutIdSchemaZ,
      direction: z.enum(["horizontal", "vertical"]),
      children: z.array(WorkspaceAppLayoutNodeSchemaZ).min(2).max(4),
      weights: z.array(z.number().positive()).optional(),
    }),
    z.strictObject({
      type: z.literal("tabs"),
      id: WorkspaceLayoutIdSchemaZ,
      children: z.array(WorkspaceAppLayoutNodeSchemaZ).min(1).max(8),
      active: WorkspaceLayoutIdSchemaZ.optional(),
    }),
  ]),
);

export const WorkspaceFullPanelViewSchemaZ = z.strictObject({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema.optional(),
  panel: WorkspacePanelKindSchemaZ,
});

export const WorkspaceCompositeViewSchemaZ = z.strictObject({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema.optional(),
  layout: WorkspaceAppLayoutNodeSchemaZ,
});

export const WorkspaceAppViewSchemaZ = z.union([
  WorkspaceFullPanelViewSchemaZ,
  WorkspaceCompositeViewSchemaZ,
]);

export const WorkspaceAppConfigSchemaZ = z.strictObject({
  views: z.array(WorkspaceAppViewSchemaZ).min(1),
});

export const WorkspaceHarnessProfileSchemaZ = z.strictObject({
  adapter: NonEmptyStringSchema,
  command: WorkspaceCommandSchemaZ,
  env: z.record(NonEmptyStringSchema, z.string()).optional(),
});

export const WorkspaceAgentRoleSchemaZ = z.enum([
  "manager",
  "implementer",
  "reviewer",
  "researcher",
  "validator",
]);

export const WorkspaceAgentProfileSchemaZ = z.strictObject({
  harness: ProfileNameSchema,
  model: NonEmptyStringSchema.optional(),
  role: WorkspaceAgentRoleSchemaZ,
});

export const WorkspaceMissionDefaultsSchemaZ = z.strictObject({
  manager: ProfileNameSchema.optional(),
  workers: z.array(ProfileNameSchema).optional(),
  reviewer: ProfileNameSchema.optional(),
  isolation: z.enum(["shared", "worktree"]).optional(),
  max_concurrent_tasks: z.number().int().positive().optional(),
});

const WorkspaceConfigV1ObjectSchemaZ = z.strictObject({
  version: z.literal(1),
  name: NonEmptyStringSchema.optional(),
  before: z.string().optional(),
  terminal: WorkspaceTerminalConfigSchemaZ.optional(),
  app: WorkspaceAppConfigSchemaZ.optional(),
  harnesses: z.record(ProfileNameSchema, WorkspaceHarnessProfileSchemaZ).optional(),
  agents: z.record(ProfileNameSchema, WorkspaceAgentProfileSchemaZ).optional(),
  missions: WorkspaceMissionDefaultsSchemaZ.optional(),
});

/**
 * Strict V1 workspace config plus references that can be checked using only
 * the loaded document. Installed binaries/models are deliberately not probed.
 */
export const WorkspaceConfigV1SchemaZ = WorkspaceConfigV1ObjectSchemaZ.superRefine(
  (config, context) => {
    const harnessNames = new Set(Object.keys(config.harnesses ?? {}));
    for (const [agentName, agent] of Object.entries(config.agents ?? {})) {
      if (!harnessNames.has(agent.harness)) {
        context.addIssue({
          code: "custom",
          path: ["agents", agentName, "harness"],
          message: `Unknown harness profile "${agent.harness}"`,
        });
      }
    }

    const agentNames = new Set(Object.keys(config.agents ?? {}));
    const checkAgentReference = (name: string | undefined, path: (string | number)[]) => {
      if (name !== undefined && !agentNames.has(name)) {
        context.addIssue({
          code: "custom",
          path,
          message: `Unknown agent profile "${name}"`,
        });
      }
    };

    checkAgentReference(config.missions?.manager, ["missions", "manager"]);
    checkAgentReference(config.missions?.reviewer, ["missions", "reviewer"]);
    for (const [index, worker] of (config.missions?.workers ?? []).entries()) {
      checkAgentReference(worker, ["missions", "workers", index]);
    }

    const viewIds = new Set<string>();
    for (const [index, view] of (config.app?.views ?? []).entries()) {
      if (viewIds.has(view.id)) {
        context.addIssue({
          code: "custom",
          path: ["app", "views", index, "id"],
          message: `Duplicate view id "${view.id}"`,
        });
      }
      viewIds.add(view.id);
      if ("layout" in view) {
        validateWorkspaceLayoutTree(view.layout, ["app", "views", index, "layout"], context);
      }
    }
  },
);

function validateWorkspaceLayoutTree(
  root: WorkspaceAppLayoutNodeInput,
  path: (string | number)[],
  context: z.RefinementCtx,
): void {
  const seen = new Map<string, (string | number)[]>();
  let count = 0;
  const walk = (
    node: WorkspaceAppLayoutNodeInput,
    nodePath: (string | number)[],
    depth: number,
  ) => {
    count += 1;
    if (count > 64) {
      context.addIssue({
        code: "custom",
        path,
        message: "Composite view layout must not exceed 64 nodes",
      });
      return;
    }
    if (depth > 8) {
      context.addIssue({
        code: "custom",
        path: nodePath,
        message: "Composite view layout must not be deeper than 8 nodes",
      });
    }
    const existing = seen.get(node.id);
    if (existing) {
      context.addIssue({
        code: "custom",
        path: [...nodePath, "id"],
        message: `Duplicate layout node id "${node.id}"`,
      });
    } else {
      seen.set(node.id, [...nodePath, "id"]);
    }

    if (node.type === "split") {
      if (node.weights !== undefined && node.weights.length !== node.children.length) {
        context.addIssue({
          code: "custom",
          path: [...nodePath, "weights"],
          message: "Split weights length must match children length",
        });
      }
      node.children.forEach((child, childIndex) =>
        walk(child, [...nodePath, "children", childIndex], depth + 1),
      );
    } else if (node.type === "tabs") {
      if (node.active && !node.children.some((child) => child.id === node.active)) {
        context.addIssue({
          code: "custom",
          path: [...nodePath, "active"],
          message: `Unknown active tab child "${node.active}"`,
        });
      }
      node.children.forEach((child, childIndex) =>
        walk(child, [...nodePath, "children", childIndex], depth + 1),
      );
    }
  };
  walk(root, path, 1);
}

export type WorkspaceCommand = z.infer<typeof WorkspaceCommandSchemaZ>;
export type WorkspaceTerminalPane = z.infer<typeof WorkspaceTerminalPaneSchemaZ>;
export type WorkspaceTerminalRow = z.infer<typeof WorkspaceTerminalRowSchemaZ>;
export type WorkspaceTerminalConfig = z.infer<typeof WorkspaceTerminalConfigSchemaZ>;
export type WorkspacePanelKind = z.infer<typeof WorkspacePanelKindSchemaZ>;
export type WorkspaceAppLayoutNode = z.infer<typeof WorkspaceAppLayoutNodeSchemaZ>;
export type WorkspaceFullPanelView = z.infer<typeof WorkspaceFullPanelViewSchemaZ>;
export type WorkspaceCompositeView = z.infer<typeof WorkspaceCompositeViewSchemaZ>;
export type WorkspaceAppView = z.infer<typeof WorkspaceAppViewSchemaZ>;
export type WorkspaceAppConfig = z.infer<typeof WorkspaceAppConfigSchemaZ>;
export type WorkspaceHarnessProfile = z.infer<typeof WorkspaceHarnessProfileSchemaZ>;
export type WorkspaceAgentRole = z.infer<typeof WorkspaceAgentRoleSchemaZ>;
export type WorkspaceAgentProfile = z.infer<typeof WorkspaceAgentProfileSchemaZ>;
export type WorkspaceMissionDefaults = z.infer<typeof WorkspaceMissionDefaultsSchemaZ>;
export type WorkspaceConfigV1 = z.infer<typeof WorkspaceConfigV1SchemaZ>;
