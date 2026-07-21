import { z } from "zod";
import { PaneInfoSchemaZ, SessionOverviewSchemaZ } from "./domain.ts";
import { WorkspaceSchemaZ } from "./workspace.ts";

/**
 * Browser-safe response contracts for the daemon's read-only REST resources.
 *
 * These schemas intentionally describe the wire boundary rather than daemon
 * implementation objects. Every object is strict so a renderer cannot
 * silently accept a misspelled or newer field and then make decisions from a
 * partially understood response.
 */

export const DaemonSessionOverviewSchemaZ = SessionOverviewSchemaZ.strict();
export type DaemonSessionOverview = z.infer<typeof DaemonSessionOverviewSchemaZ>;

export const DaemonPaneInfoSchemaZ = PaneInfoSchemaZ.strict();
export type DaemonPaneInfo = z.infer<typeof DaemonPaneInfoSchemaZ>;

export const DaemonSessionsResponseSchemaZ = z
  .object({
    sessions: z.array(DaemonSessionOverviewSchemaZ),
  })
  .strict();
export type DaemonSessionsResponse = z.infer<typeof DaemonSessionsResponseSchemaZ>;

/** GET /api/project/:name returns this resource without another wrapper. */
export const DaemonProjectResponseSchemaZ = z
  .object({
    session: z.string(),
    dir: z.string(),
    panes: z.array(DaemonPaneInfoSchemaZ),
  })
  .strict();
export type DaemonProjectResponse = z.infer<typeof DaemonProjectResponseSchemaZ>;

export const DaemonPanesResponseSchemaZ = z
  .object({
    panes: z.array(DaemonPaneInfoSchemaZ),
  })
  .strict();
export type DaemonPanesResponse = z.infer<typeof DaemonPanesResponseSchemaZ>;

export const DaemonWorkspaceSchemaZ = WorkspaceSchemaZ.strict();
export type DaemonWorkspace = z.infer<typeof DaemonWorkspaceSchemaZ>;

export const DaemonWorkspacesResponseSchemaZ = z
  .object({
    workspaces: z.array(DaemonWorkspaceSchemaZ),
  })
  .strict();
export type DaemonWorkspacesResponse = z.infer<typeof DaemonWorkspacesResponseSchemaZ>;

export const DaemonWorkspaceResponseSchemaZ = z
  .object({
    workspace: DaemonWorkspaceSchemaZ,
  })
  .strict();
export type DaemonWorkspaceResponse = z.infer<typeof DaemonWorkspaceResponseSchemaZ>;

/** Registry entry returned by GET /api/projects. */
export const DaemonRegisteredProjectSchemaZ = z
  .object({
    name: z.string(),
    dir: z.string(),
    hasIdeYml: z.boolean(),
    hasWorkspaceConfig: z.boolean().optional(),
    configKind: z.enum(["workspace", "legacy", "none"]).optional(),
    configPath: z.string().nullable().optional(),
    ideConfigPath: z.string().nullable().optional(),
    gitOrigin: z.string().nullable(),
    gitBranch: z.string().nullable(),
    registeredAt: z.string(),
  })
  .strict();
export type DaemonRegisteredProject = z.infer<typeof DaemonRegisteredProjectSchemaZ>;

export const DaemonProjectsResponseSchemaZ = z
  .object({
    projects: z.array(DaemonRegisteredProjectSchemaZ),
  })
  .strict();
export type DaemonProjectsResponse = z.infer<typeof DaemonProjectsResponseSchemaZ>;

export const DaemonRegisteredProjectResponseSchemaZ = z
  .object({
    project: DaemonRegisteredProjectSchemaZ,
  })
  .strict();
export type DaemonRegisteredProjectResponse = z.infer<
  typeof DaemonRegisteredProjectResponseSchemaZ
>;

export const DaemonProjectTemplateSchemaZ = z
  .object({
    id: z.string(),
    label: z.string(),
    description: z.string(),
  })
  .strict();
export type DaemonProjectTemplate = z.infer<typeof DaemonProjectTemplateSchemaZ>;

export const DaemonProjectTemplatesResponseSchemaZ = z
  .object({
    templates: z.array(DaemonProjectTemplateSchemaZ),
  })
  .strict();
export type DaemonProjectTemplatesResponse = z.infer<typeof DaemonProjectTemplatesResponseSchemaZ>;
