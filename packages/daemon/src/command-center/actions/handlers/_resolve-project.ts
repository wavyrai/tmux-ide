/**
 * Shared helper: resolve a registered project by name and project the
 * fields the action handlers actually consume.
 *
 * Lives in handlers/ so the registry stays the only public surface; tests
 * import from here directly.
 */

import { getProject as getRegisteredProject } from "../../../lib/project-registry.ts";
import {
  getSessionCwd as getSessionCwdDefault,
  hasSession as hasSessionDefault,
} from "@tmux-ide/tmux-bridge";
import type { RegisteredProject } from "../../../schemas/registry.ts";
import { ActionError } from "../errors.ts";

export interface ResolvedProject {
  name: string;
  dir: string;
  sessionName: string;
  /**
   * `true` when the project was resolved from a live tmux session
   * (rather than the registry). Useful for handlers that want to
   * auto-register on first action — out of scope for this slice but
   * makes the intent explicit at the boundary.
   */
  fromLiveSession: boolean;
}

export interface ProjectResolverDeps {
  /** Override for tests — must satisfy the same contract as `getProject`. */
  getProject?: (name: string) => RegisteredProject | null;
  /** Override the live-session existence probe. */
  hasSession?: (session: string) => boolean;
  /** Override the live-session cwd lookup. */
  getSessionCwd?: (session: string) => string | null;
}

/**
 * Resolve a project by name. The registry is the canonical source of
 * truth, but as a fallback we also accept a live tmux session by the
 * same name — the dashboard merges registered projects + live sessions
 * in its sidebar, so action handlers must accept either. Throws an
 * {@link ActionError} with code `project_not_found` when neither path
 * succeeds.
 *
 * Note: the registry does not currently persist a session name distinct
 * from the project name, so the session name returned here mirrors the
 * project name. If they diverge in the future, this is the only call site
 * that needs to change.
 */
export function resolveProject(name: string, deps: ProjectResolverDeps = {}): ResolvedProject {
  const lookup = deps.getProject ?? getRegisteredProject;
  const project = lookup(name);
  if (project) {
    return {
      name: project.name,
      dir: project.dir,
      sessionName: project.name,
      fromLiveSession: false,
    };
  }

  // Registry miss — fall back to a live tmux session of the same name.
  const hasSession = deps.hasSession ?? hasSessionDefault;
  if (hasSession(name)) {
    const cwd = (deps.getSessionCwd ?? getSessionCwdDefault)(name);
    if (cwd) {
      return { name, dir: cwd, sessionName: name, fromLiveSession: true };
    }
  }

  throw new ActionError({
    code: "project_not_found",
    message: `Project "${name}" not found in registry or as a live tmux session`,
    details: { name },
  });
}
