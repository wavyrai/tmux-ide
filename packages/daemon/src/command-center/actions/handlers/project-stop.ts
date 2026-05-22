/**
 * Handler: `project.stop`.
 *
 * Wraps the CLI `tmux-ide stop` flow programmatically: stop the session
 * monitor, then `killSession`. Idempotent —
 * returns `{ stopped: false }` when no session was running rather than
 * throwing, so the dashboard can call this freely.
 */

import {
  hasSession as hasSessionDefault,
  killSession as killSessionDefault,
  stopSessionMonitor as stopSessionMonitorDefault,
} from "@tmux-ide/tmux-bridge";
import { ActionError } from "../errors.ts";
import { type ActionInput, type ActionResult } from "../contract.ts";
import { resolveProject, type ProjectResolverDeps } from "./_resolve-project.ts";

export interface ProjectStopDeps extends ProjectResolverDeps {
  hasSession?: (session: string) => boolean;
  killSession?: (session: string) => { stopped: boolean; reason: string | null };
  stopSessionMonitor?: (session: string) => void;
  /**
   * Legacy hook retained for tests. Per-session daemon cleanup is no longer
   * needed because the canonical daemon is app/headless owned.
   */
  killOrphanDaemons?: (session: string) => void;
}

function defaultKillOrphanDaemons(_session: string): void {
  // No-op: per-session daemons are no longer spawned.
}

export async function projectStopHandler(
  input: ActionInput<"project.stop">,
  deps: ProjectStopDeps = {},
): Promise<ActionResult<"project.stop">> {
  const project = resolveProject(input.name, deps);
  const hasSession = deps.hasSession ?? hasSessionDefault;

  if (!hasSession(project.sessionName)) {
    return { sessionName: project.sessionName, stopped: false };
  }

  const stopSessionMonitor = deps.stopSessionMonitor ?? stopSessionMonitorDefault;
  const killSession = deps.killSession ?? killSessionDefault;
  const killOrphanDaemons = deps.killOrphanDaemons ?? defaultKillOrphanDaemons;

  try {
    stopSessionMonitor(project.sessionName);
    killOrphanDaemons(project.sessionName);
    const result = killSession(project.sessionName);
    return { sessionName: project.sessionName, stopped: result.stopped };
  } catch (err) {
    throw new ActionError({
      code: "stop_failed",
      message: `Failed to stop session "${project.sessionName}": ${(err as Error).message ?? String(err)}`,
      details: { sessionName: project.sessionName },
      cause: err,
    });
  }
}
