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
import {
  DaemonProjectTemplateSchemaZ,
  DaemonRegisteredProjectSchemaZ,
  type DaemonProjectTemplate,
  type DaemonRegisteredProject,
} from "@tmux-ide/contracts";

/** Compatibility names for the canonical browser-safe resource contract. */
export const RegisteredProjectSchemaZ = DaemonRegisteredProjectSchemaZ;
export type RegisteredProject = DaemonRegisteredProject;

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

export const ProjectTemplateSchemaZ = DaemonProjectTemplateSchemaZ;
export type ProjectTemplate = DaemonProjectTemplate;
