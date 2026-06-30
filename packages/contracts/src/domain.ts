import { z } from "zod";

// ---------------------------------------------------------------------------
// PaneInfo — live tmux pane metadata (from src/command-center/discovery.ts)
// ---------------------------------------------------------------------------

export const PaneInfoSchemaZ = z.object({
  id: z.string(),
  index: z.number(),
  title: z.string(),
  currentCommand: z.string(),
  width: z.number(),
  height: z.number(),
  active: z.boolean(),
  role: z
    .enum(["lead", "teammate", "planner", "validator", "researcher", "widget", "shell"])
    .nullable(),
  name: z.string().nullable(),
  type: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// SessionOverview — minimal session listing entry
// ---------------------------------------------------------------------------

export const SessionOverviewSchemaZ = z.object({
  name: z.string(),
  dir: z.string(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type PaneInfo = z.infer<typeof PaneInfoSchemaZ>;
export type SessionOverview = z.infer<typeof SessionOverviewSchemaZ>;
