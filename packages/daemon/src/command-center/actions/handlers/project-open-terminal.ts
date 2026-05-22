/**
 * Handler: `project.openTerminal`.
 *
 * Resolves the project's cwd from the registry, ensures the tmux session is
 * running (launching it if necessary), and asserts the resolved cwd is a
 * real directory. Returns the dashboard's stable terminal tab id together
 * with the resolved cwd so the dashboard does not need to stitch together
 * the registry / session / cwd paths itself.
 *
 * This is the action that swallows the seam where the dashboard previously
 * juggled `/api/projects` + `/api/project/:name` to figure out where to
 * open a terminal.
 */

import { hasSession as hasSessionDefault } from "@tmux-ide/tmux-bridge";
import { launch as launchDefault } from "../../../launch.ts";
import { activateProject as activateProjectDefault } from "../../../lib/active-projects.ts";
import { assertValidCwd, TerminalCwdError } from "../../../server/pty-bridge.ts";
import type { Stats } from "node:fs";
import { ActionError, actionErrorFromCwdError } from "../errors.ts";
import { type ActionInput, type ActionResult } from "../contract.ts";
import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";

const TERMINAL_TAB_ID_PREFIX = "terminal";
const TERMINAL_TAB_ID_SUFFIX = "default";

/**
 * Build the dashboard-facing terminal tab id for a session's default
 * terminal. Mirrors the layout state convention `terminal:<session>:default`.
 * Centralised here so both this handler and tests share the source of truth.
 */
export function defaultTerminalTabId(sessionName: string): string {
  return `${TERMINAL_TAB_ID_PREFIX}:${sessionName}:${TERMINAL_TAB_ID_SUFFIX}`;
}

export interface ProjectOpenTerminalDeps extends ProjectResolverDeps {
  hasSession?: (session: string) => boolean;
  launch?: (dir: string, options: { json: boolean; attach: boolean }) => Promise<void>;
  statCwd?: (cwd: string) => Stats;
  activateProject?: (name: string) => Promise<void>;
}

export async function projectOpenTerminalHandler(
  input: ActionInput<"project.openTerminal">,
  deps: ProjectOpenTerminalDeps = {},
): Promise<ActionResult<"project.openTerminal">> {
  const project = resolveProject(input.name, deps);
  const activateProject = deps.activateProject ?? activateProjectDefault;
  await activateProject(project.name);

  // Always validate cwd up-front. A missing/broken project dir is the most
  // common cause of the bugs this slice exists to eliminate.
  try {
    assertValidCwd(project.dir, deps.statCwd);
  } catch (err) {
    if (err instanceof TerminalCwdError) {
      throw actionErrorFromCwdError(err);
    }
    throw err;
  }

  const hasSession = deps.hasSession ?? hasSessionDefault;
  const launch = deps.launch ?? launchDefault;

  let launched = false;
  if (!hasSession(project.sessionName)) {
    try {
      // attach: false — we run inside the daemon HTTP server, not a TTY.
      await launch(project.dir, { json: false, attach: false });
      launched = true;
    } catch (err) {
      throw new ActionError({
        code: "launch_failed",
        message: `Failed to launch session "${project.sessionName}": ${(err as Error).message ?? String(err)}`,
        details: { sessionName: project.sessionName, dir: project.dir },
        cause: err,
      });
    }
  }

  return {
    sessionName: project.sessionName,
    cwd: project.dir,
    terminalTabId: defaultTerminalTabId(project.sessionName),
    launched,
  };
}
