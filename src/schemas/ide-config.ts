import { z } from "zod";

const sizeField = z
  .string()
  .regex(/^[1-9]\d*%$/)
  .refine((v) => parseInt(v) <= 100);

export const ThemeConfigSchema = z.object({
  accent: z.string().optional(),
  border: z.string().optional(),
  bg: z.string().optional(),
  fg: z.string().optional(),
});

export const PaneSchema = z.object({
  title: z.string().optional(),
  command: z.string().optional(),
  type: z
    .enum(["explorer", "changes", "preview", "tasks", "warroom", "costs"])
    .optional(),
  target: z.string().optional(),
  dir: z.string().optional(),
  size: sizeField.optional(),
  focus: z.boolean().optional(),
  env: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  role: z.enum(["lead", "teammate", "planner"]).optional(),
  task: z.string().optional(),
  specialty: z.string().optional(),
});

export const RowSchema = z.object({
  size: sizeField.optional(),
  panes: z.array(PaneSchema).min(1),
});

export const OrchestratorYamlConfigSchema = z.object({
  enabled: z.boolean().optional(),
  auto_dispatch: z.boolean().optional(),
  stall_timeout: z.number().optional(),
  poll_interval: z.number().optional(),
  worktree_root: z.string().optional(),
  master_pane: z.string().optional(),
  before_run: z.string().optional(),
  after_run: z.string().optional(),
  cleanup_on_done: z.boolean().optional(),
  dispatch_mode: z.enum(["tasks", "goals"]).optional(),
  max_concurrent_agents: z.number().optional(),
  widgets: z.boolean().optional(),
});

export const IdeConfigSchema = z.object({
  name: z.string().optional(),
  before: z.string().optional(),
  team: z
    .object({
      name: z.string(),
      model: z.string().optional(),
      permissions: z.array(z.string()).optional(),
    })
    .optional(),
  rows: z.array(RowSchema).min(1),
  theme: ThemeConfigSchema.optional(),
  orchestrator: OrchestratorYamlConfigSchema.optional(),
});

export const PaneActionSchema = z.object({
  targetPane: z.string(),
  title: z.string().nullable(),
  chdir: z.string().nullable(),
  exports: z.array(z.string()),
  command: z.string().nullable(),
  widgetType: z.string().nullable(),
  widgetTarget: z.string().nullable(),
  paneRole: z.string().nullable(),
  paneType: z.string().nullable(),
});

export const SessionStateSchema = z.object({
  running: z.boolean(),
  reason: z.string().nullable(),
});

export type ThemeConfig = z.infer<typeof ThemeConfigSchema>;
export type Pane = z.infer<typeof PaneSchema>;
export type Row = z.infer<typeof RowSchema>;
export type OrchestratorYamlConfig = z.infer<
  typeof OrchestratorYamlConfigSchema
>;
export type IdeConfig = z.infer<typeof IdeConfigSchema>;
export type PaneAction = z.infer<typeof PaneActionSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
