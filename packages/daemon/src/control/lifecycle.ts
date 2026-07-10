/**
 * Agent lifecycle io for the control socket — spawn / restart / stop.
 *
 * The MODEL (kind → launch command, exact tmux argv, the shell-vs-own-process
 * restart decision, interrupt timing) is the pure `tui/mirror/agent-lifecycle`
 * module the unified app already runs on; this file is only the async tmux
 * plumbing around it, so the socket drives the SAME lifecycle path as the app.
 */
import { execFile } from "node:child_process";
import {
  INTERRUPT_TAP_GAP_MS,
  RESTART_GRACE_MS,
  clearAuthorityArgs,
  interruptArgs,
  launchCommandFor,
  paneHostsShell,
  relaunchArgs,
  respawnArgs,
  spawnAgentArgs,
  spawnSessionArgs,
  type SpawnPlacement,
} from "../tui/mirror/agent-lifecycle.ts";
import { getManifests } from "../tui/detect/manifest-loader.ts";
import { ControlVerbError } from "./dispatch.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One tmux call; resolves stdout, rejects on a tmux error. */
function tmuxRun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("tmux", args, (err, stdout) => (err ? reject(err) : resolve(stdout.trimEnd())));
  });
}

/** Like {@link tmuxRun} but errors are swallowed — for best-effort steps
 *  (a dead pane target is a normal race, the fleet shows the truth later). */
async function tmuxTry(args: string[]): Promise<void> {
  await tmuxRun(args).catch(() => {});
}

/** Resolve `kind`/`command` params to the command that actually launches. */
export function resolveLaunchCommand(params: { kind?: string; command?: string }): string {
  if (params.command) return params.command;
  return launchCommandFor(params.kind!, getManifests());
}

export interface SpawnOutcome {
  paneId: string;
  session: string;
  command: string;
  placement: SpawnPlacement | "new-session";
}

/**
 * Spawn an agent. With `session` the shared placement argv is used (window /
 * split); without it a fresh detached session named `sessionName` starts in
 * `dir`. `-P -F #{pane_id}` is threaded right after the tmux subcommand so
 * the caller learns WHICH pane the agent got (the argv builders stay
 * untouched — the app's flows don't want the print).
 */
export async function spawnAgent(params: {
  command: string;
  session?: string;
  sessionName?: string;
  dir?: string;
  placement?: SpawnPlacement;
  paneId?: string;
}): Promise<SpawnOutcome> {
  const dir = params.dir ?? null;
  const argv = params.session
    ? spawnAgentArgs(
        params.placement ?? "window",
        { session: params.session, paneId: params.paneId },
        dir,
        params.command,
      )
    : spawnSessionArgs(params.sessionName!, dir, params.command);
  const [subcommand, ...rest] = argv;
  let paneId: string;
  try {
    paneId = await tmuxRun([subcommand!, "-P", "-F", "#{pane_id}", ...rest]);
  } catch (err) {
    throw new ControlVerbError("not-found", `tmux refused to spawn: ${(err as Error).message}`);
  }
  const session = params.session ?? params.sessionName!;
  // Mark a fresh session as ours (mirrors the app's spawn flow).
  if (!params.session) await tmuxTry(["set-environment", "-t", session, "TMUX_IDE", "1"]);
  return {
    paneId,
    session,
    command: params.command,
    placement: params.session ? (params.placement ?? "window") : "new-session",
  };
}

/** The double ctrl-c (see agent-lifecycle: one taps, the quick second exits). */
async function interruptAgent(paneId: string): Promise<void> {
  await tmuxTry(interruptArgs(paneId));
  await sleep(INTERRUPT_TAP_GAP_MS);
  await tmuxTry(interruptArgs(paneId));
}

/** Out-of-band stop hygiene: no hook fires, so unset the authority stamps. */
async function clearAgentAuthority(paneId: string): Promise<void> {
  for (const args of clearAuthorityArgs(paneId)) await tmuxTry(args);
}

/** The pane's root command + cwd, or null when the pane is gone. */
function paneStartAndPath(paneId: string): Promise<{ start: string; path: string } | null> {
  return tmuxRun(["display", "-p", "-t", paneId, "#{pane_start_command}\t#{pane_current_path}"])
    .then((out) => {
      const [start = "", path = ""] = out.split("\t");
      return { start, path };
    })
    .catch(() => null);
}

/** Stop the agent in `paneId`: interrupt + authority cleanup. The pane (and
 *  its shell, if any) stays open — `kill-pane` is deliberately NOT offered
 *  over the socket; that is a human, confirmed-destructive verb. */
export async function stopAgent(paneId: string): Promise<{ paneId: string; stopped: true }> {
  const live = await paneStartAndPath(paneId);
  if (!live) throw new ControlVerbError("not-found", `no pane "${paneId}"`);
  await interruptAgent(paneId);
  await clearAgentAuthority(paneId);
  return { paneId, stopped: true };
}

/**
 * Restart the agent in `paneId` running `command`, using the app's two
 * strategies: a SHELL-hosted agent is interrupted and relaunched via
 * send-keys (the shell survives to type into); an agent that IS the pane's
 * own process is respawned in place (ctrl-c would end the pane).
 */
export async function restartAgent(
  paneId: string,
  command: string,
): Promise<{ paneId: string; command: string; strategy: "relaunch" | "respawn" }> {
  const live = await paneStartAndPath(paneId);
  if (!live) throw new ControlVerbError("not-found", `no pane "${paneId}"`);
  if (paneHostsShell(live.start, getManifests())) {
    await interruptAgent(paneId);
    await clearAgentAuthority(paneId);
    await sleep(RESTART_GRACE_MS);
    for (const args of relaunchArgs(paneId, command)) await tmuxTry(args);
    return { paneId, command, strategy: "relaunch" };
  }
  await clearAgentAuthority(paneId);
  await tmuxTry(respawnArgs(paneId, command, live.path || null));
  return { paneId, command, strategy: "respawn" };
}
