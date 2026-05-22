/**
 * Project registry contracts. The dashboard manages a list of projects the
 * user has registered with tmux-ide; this schema is the wire shape exchanged
 * over `/api/projects` and the `/ws/events` WebSocket channel.
 *
 * The shape is FROZEN — the dashboard imports these via `@tmux-ide/schemas`.
 * Add new fields by appending optional properties; do not rename existing
 * fields without bumping a major.
 */

import { z } from "zod";

export const RegisteredProjectSchemaZ = z.object({
  /** Unique registry key. Defaults to `basename(dir)`; collisions resolved by appending `-2`, `-3`, … */
  name: z.string(),
  /** Absolute path to the project directory. */
  dir: z.string(),
  /** Whether `<dir>/ide.yml` exists; refreshed on register and on `probe()`. */
  hasIdeYml: z.boolean(),
  /** Git remote origin URL, or `null` if not a git repo / no origin / probe failed. */
  gitOrigin: z.string().nullable(),
  /** Current git branch, or `null` if not a git repo / detached HEAD / probe failed. */
  gitBranch: z.string().nullable(),
  /** ISO-8601 timestamp the project was first registered. */
  registeredAt: z.string(),
});

export type RegisteredProject = z.infer<typeof RegisteredProjectSchemaZ>;

// ---------------------------------------------------------------------------
// REST request bodies
// ---------------------------------------------------------------------------

export const RegisterProjectRequestSchemaZ = z.object({
  dir: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type RegisterProjectRequest = z.infer<typeof RegisterProjectRequestSchemaZ>;

export const InitProjectRequestSchemaZ = z.object({
  dir: z.string().min(1),
  template: z.string().min(1).optional(),
});
export type InitProjectRequest = z.infer<typeof InitProjectRequestSchemaZ>;

// ---------------------------------------------------------------------------
// Template metadata (returned by GET /api/projects/templates)
// ---------------------------------------------------------------------------

export const ProjectTemplateSchemaZ = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
});
export type ProjectTemplate = z.infer<typeof ProjectTemplateSchemaZ>;
