/**
 * Handler: `project.restart`.
 *
 * Programmatic version of `tmux-ide restart`. Stops the session monitor +
 * kills the existing tmux session (when present), then re-launches with
 * `attach: false`. Always reports `restarted: true` on success — the call
 * is meaningful whether or not a session was previously running.
 */

import { restart as restartDefault } from "../../../restart.ts";
import { ActionError } from "../errors.ts";
import { type ActionInput, type ActionResult } from "../contract.ts";
import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";

export interface ProjectRestartDeps extends ProjectResolverDeps {
  restart?: (dir: string, options: { json?: boolean; attach?: boolean }) => Promise<void>;
}

export async function projectRestartHandler(
  input: ActionInput<"project.restart">,
  deps: ProjectRestartDeps = {},
): Promise<ActionResult<"project.restart">> {
  const project = resolveProject(input.name, deps);
  const restart = deps.restart ?? restartDefault;

  try {
    await restart(project.dir, { json: false, attach: false });
  } catch (err) {
    throw new ActionError({
      code: "launch_failed",
      message: `Failed to restart session "${project.sessionName}": ${(err as Error).message ?? String(err)}`,
      details: { sessionName: project.sessionName, dir: project.dir },
      cause: err,
    });
  }

  return { sessionName: project.sessionName, restarted: true };
}
