/**
 * Handler: `project.launch`.
 *
 * Idempotent programmatic launch. Resolves the project from the registry,
 * checks whether a session is already running, and returns
 * `{ started: false }` without invoking the launcher when so. Otherwise
 * delegates to `src/launch.ts` with `attach: false`.
 */

import { hasSession as hasSessionDefault } from "@tmux-ide/tmux-bridge";
import { launch as launchDefault } from "../../../launch.ts";
import { ActionError } from "../errors.ts";
import { type ActionInput, type ActionResult } from "../contract.ts";
import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";
import { getDefaultWorkspaceRegistry } from "../../../lib/workspace-registry.ts";
import { resolveProjectConfigContext } from "../../../lib/config-context.ts";

export interface ProjectLaunchDeps extends ProjectResolverDeps {
  hasSession?: (session: string) => boolean;
  launch?: (dir: string, options: { json: boolean; attach: boolean }) => Promise<void>;
}

/**
 * Ensure the workspace registry knows about this project. The project
 * registry (`registerProject`) only updates the project-list — but
 * `discoverSessions` / `/api/project/:name` consult the WORKSPACE registry
 * before returning anything. Without this sync, every dashboard fetch
 * 404s for projects that weren't passed as the daemon's primary sessionName.
 */
async function ensureWorkspaceRegistered(
  name: string,
  sessionName: string,
  dir: string,
): Promise<void> {
  const reg = getDefaultWorkspaceRegistry();
  if (reg.has(name)) return;
  try {
    const facts = await resolveProjectConfigContext(dir);
    reg.add({
      name,
      sessionName,
      projectDir: dir,
      ideConfigPath: facts.ideConfigPath,
      configKind: facts.configKind,
      configPath: facts.configPath,
      hasWorkspaceConfig: facts.hasWorkspaceConfig,
    });
  } catch {
    // ALREADY_EXISTS or persistence error — non-fatal; the next discover
    // pass will pick it up if persistence eventually succeeds.
  }
}

export async function projectLaunchHandler(
  input: ActionInput<"project.launch">,
  deps: ProjectLaunchDeps = {},
): Promise<ActionResult<"project.launch">> {
  const project = resolveProject(input.name, deps);
  const hasSession = deps.hasSession ?? hasSessionDefault;

  if (hasSession(project.sessionName)) {
    // Session already running — but the workspace registry may still be
    // stale (e.g. tmux session created via curl, or daemon restarted).
    // Sync before returning so /api/project/:name resolves.
    await ensureWorkspaceRegistered(project.name, project.sessionName, project.dir);
    return { sessionName: project.sessionName, started: false };
  }

  const launch = deps.launch ?? launchDefault;
  try {
    await launch(project.dir, { json: false, attach: false });
  } catch (err) {
    throw new ActionError({
      code: "launch_failed",
      message: `Failed to launch session "${project.sessionName}": ${(err as Error).message ?? String(err)}`,
      details: { sessionName: project.sessionName, dir: project.dir },
      cause: err,
    });
  }

  // Freshly launched — workspace registry definitely needs the entry.
  await ensureWorkspaceRegistered(project.name, project.sessionName, project.dir);
  return { sessionName: project.sessionName, started: true };
}
