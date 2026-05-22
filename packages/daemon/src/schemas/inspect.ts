/**
 * Project inspect + onboard contracts. Used by the dashboard's "Add project"
 * dialog to inspect an arbitrary directory (without registering it) and to
 * onboard a directory that has no `ide.yml` yet (compose, write, register).
 *
 * The shape is FROZEN — the dashboard imports these via `@tmux-ide/schemas`.
 */

import { z } from "zod";

export const ProjectInspectDetectedSchemaZ = z.object({
  /** Detected package manager from lockfile, or `null`. */
  packageManager: z.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
  /** Detected frameworks (e.g. `["next", "convex"]`). Empty array when none. */
  frameworks: z.array(z.string()),
  /** Suggested dev command (e.g. `pnpm dev`). `null` if no dev script found. */
  devCommand: z.string().nullable(),
  /** Suggested test command (e.g. `pnpm test`). `null` if no test script found. */
  testCommand: z.string().nullable(),
});
export type ProjectInspectDetected = z.infer<typeof ProjectInspectDetectedSchemaZ>;

export const ProjectInspectSchemaZ = z.object({
  /** Sanitized basename of the directory — safe to use as a tmux session name. */
  name: z.string(),
  /** Absolute, canonical path to the directory. */
  dir: z.string(),
  /** Whether `<dir>/ide.yml` exists. */
  hasIdeYml: z.boolean(),
  /** Git remote origin URL, or `null` if not a git repo / no origin / probe failed. */
  gitOrigin: z.string().nullable(),
  /** Current git branch, or `null` if not a git repo / detached HEAD / probe failed. */
  gitBranch: z.string().nullable(),
  /** Detected stack signals (reuses `tmux-ide detect` logic). */
  detected: ProjectInspectDetectedSchemaZ,
});
export type ProjectInspect = z.infer<typeof ProjectInspectSchemaZ>;

// ---------------------------------------------------------------------------
// REST request bodies
// ---------------------------------------------------------------------------

export const InspectFilesystemRequestSchemaZ = z.object({
  dir: z.string().min(1),
});
export type InspectFilesystemRequest = z.infer<typeof InspectFilesystemRequestSchemaZ>;

export const OnboardProjectRequestSchemaZ = z.object({
  dir: z.string().min(1),
  /** Optional override for the project name — defaults to inspect.name. */
  name: z.string().min(1).optional(),
  /** 1, 2, or 3 — how many Claude panes to scaffold in the top row. */
  agents: z.number().int().min(1).max(3),
  /**
   * Optional per-agent pane titles. When provided, length must equal
   * `agents`; the server uses these as `title:` for the Claude panes
   * instead of the canonical `Lead`/`Teammate N`/`Claude N` defaults.
   */
  agentNames: z.array(z.string().min(1)).optional(),
  /** Dev server command (e.g. `pnpm dev`). Omit / null to skip the dev pane. */
  devCommand: z.string().min(1).nullable().optional(),
  /** Test command (e.g. `pnpm test`). Currently informational; stored for later. */
  testCommand: z.string().min(1).nullable().optional(),
  /** Lint command (e.g. `pnpm lint`). Currently informational; stored for later. */
  lintCommand: z.string().min(1).nullable().optional(),
});
export type OnboardProjectRequest = z.infer<typeof OnboardProjectRequestSchemaZ>;
