import { z } from "zod";

/**
 * A workspace is a project the daemon is actively serving — identified by
 * its tmux session name and bound to a project directory.
 *
 * The workspace registry replaces the historical single-session
 * TMUX_IDE_SESSION env coupling, letting the daemon serve N projects in
 * one process. Goal 12 of the t3-style consolidation; see T065.
 */
export const WorkspaceSchemaZ = z.object({
  /** Stable workspace name (typically equal to tmux session name). */
  name: z.string().min(1),
  /** Tmux session this workspace maps to. */
  sessionName: z.string().min(1),
  /** Absolute project directory. */
  projectDir: z.string().min(1),
  /** Absolute path to the ide.yml driving this workspace. */
  ideConfigPath: z.string().nullable(),
  /** ISO timestamp of when the workspace was added. */
  addedAt: z.string(),
});
export type Workspace = z.infer<typeof WorkspaceSchemaZ>;

// ---------------------------------------------------------------------------
// HTTP request / response shapes for /api/workspaces
// ---------------------------------------------------------------------------

export const WorkspaceListResponseSchemaZ = z.object({
  workspaces: z.array(WorkspaceSchemaZ),
});
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchemaZ>;

export const AddWorkspaceRequestSchemaZ = z.object({
  /** Absolute path to the project directory. */
  projectDir: z.string().min(1),
  /** Optional explicit workspace name. Auto-derived from basename when absent. */
  name: z.string().min(1).optional(),
  /** Optional override for the tmux session name (defaults to `name`). */
  sessionName: z.string().min(1).optional(),
  /** Optional ide.yml path the workspace was launched with. */
  ideConfigPath: z.string().min(1).optional(),
});
export type AddWorkspaceRequest = z.infer<typeof AddWorkspaceRequestSchemaZ>;

export const AddWorkspaceResponseSchemaZ = z.object({
  workspace: WorkspaceSchemaZ,
});
export type AddWorkspaceResponse = z.infer<typeof AddWorkspaceResponseSchemaZ>;

// ---------------------------------------------------------------------------
// WebSocket event frames — fired on registry add/remove (including the
// auto-reconcile loop that drops dead sessions). Kept here so dashboard /
// daemon consumers share the exact discriminator strings.
// ---------------------------------------------------------------------------

export const WorkspaceAddedFrameSchemaZ = z.object({
  type: z.literal("workspace.added"),
  workspace: WorkspaceSchemaZ,
});
export type WorkspaceAddedFrame = z.infer<typeof WorkspaceAddedFrameSchemaZ>;

export const WorkspaceRemovedFrameSchemaZ = z.object({
  type: z.literal("workspace.removed"),
  name: z.string(),
});
export type WorkspaceRemovedFrame = z.infer<typeof WorkspaceRemovedFrameSchemaZ>;
