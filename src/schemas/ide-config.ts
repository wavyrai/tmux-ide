import { z } from "zod";
import { AuthConfigSchema } from "../lib/auth/types.ts";
import { HQConfigSchema } from "../lib/hq/types.ts";

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
    .enum(["explorer", "changes", "preview", "tasks", "costs", "config", "mission-control"])
    .optional(),
  target: z.string().optional(),
  dir: z.string().optional(),
  size: sizeField.optional(),
  focus: z.boolean().optional(),
  env: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  role: z.enum(["lead", "teammate", "planner", "validator", "researcher"]).optional(),
  task: z.string().optional(),
  specialty: z.string().optional(),
  skill: z.string().optional(),
});

export const RowSchema = z.object({
  size: sizeField.optional(),
  panes: z.array(PaneSchema).min(1),
});

export const WebhookConfigSchema = z.object({
  url: z.string(),
  events: z.array(z.string()).optional(),
  secret: z.string().optional(),
});

export const OrchestratorYamlConfigSchema = z.object({
  enabled: z.boolean().optional(),
  port: z.number().int().positive().optional(),
  auto_dispatch: z.boolean().optional(),
  stall_timeout: z.number().optional(),
  poll_interval: z.number().min(100).optional(),
  master_pane: z.string().optional(),
  before_run: z.string().optional(),
  after_run: z.string().optional(),
  dispatch_mode: z.enum(["tasks", "goals", "missions"]).optional(),
  max_concurrent_agents: z.number().min(1).max(50).optional(),
  widgets: z.boolean().optional(),
  webhooks: z.array(WebhookConfigSchema).optional(),
  services: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        port: z.number().optional(),
        healthcheck: z.string().optional(),
      }),
    )
    .optional(),
  research: z
    .object({
      enabled: z.boolean().optional(),
      triggers: z
        .object({
          mission_start: z.boolean().optional(),
          milestone_progress: z.number().min(0).optional(),
          milestone_complete: z.boolean().optional(),
          periodic_minutes: z.number().min(0).optional(),
          retry_cluster: z.boolean().optional(),
          stall_detected: z.boolean().optional(),
          discovered_issue: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export const TunnelConfigSchema = z.object({
  provider: z.enum(["tailscale", "ngrok", "cloudflare"]),
  auto_start: z.boolean().optional(),
  port: z.number().int().positive().optional(),
  domain: z.string().optional(),
  authtoken: z.string().optional(),
});

export const CommandCenterConfigSchema = z.object({
  port: z.number().optional(),
  enabled: z.boolean().optional(),
});

export const DashboardConfigSchema = z.object({
  port: z.number().int().positive().optional(),
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
  command_center: CommandCenterConfigSchema.optional(),
  dashboard: DashboardConfigSchema.optional(),
  auth: AuthConfigSchema.optional(),
  tunnel: TunnelConfigSchema.optional(),
  hq: HQConfigSchema.optional(),
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
export type OrchestratorYamlConfig = z.infer<typeof OrchestratorYamlConfigSchema>;
export type CommandCenterConfig = z.infer<typeof CommandCenterConfigSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
export type IdeConfig = z.infer<typeof IdeConfigSchema>;
export type PaneAction = z.infer<typeof PaneActionSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;
