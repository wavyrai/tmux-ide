import { execFileSync } from "node:child_process";
import { listSessionPanes } from "../widgets/lib/pane-comms.ts";
import type { PaneInfo } from "@tmux-ide/contracts";
import { getDefaultWorkspaceRegistry } from "../lib/workspace-registry.ts";

export interface SessionInfo {
  name: string;
  dir: string;
  panes: PaneInfo[];
}

export interface SessionOverview {
  name: string;
  dir: string;
}

export interface ProjectDetail {
  session: string;
  dir: string;
  panes: PaneInfo[];
}

type TmuxRunner = (args: string[]) => string;

let _tmuxRunner: TmuxRunner = (args) =>
  execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export function _setTmuxRunner(fn: TmuxRunner): () => void {
  const prev = _tmuxRunner;
  _tmuxRunner = fn;
  return () => {
    _tmuxRunner = prev;
  };
}

function tmuxSilent(args: string[]): string {
  try {
    return _tmuxRunner(args);
  } catch {
    return "";
  }
}

export function listTmuxSessions(): string[] {
  const raw = tmuxSilent(["list-sessions", "-F", "#{session_name}"]);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean);
}

export function getSessionCwd(session: string): string {
  return tmuxSilent(["display-message", "-t", session, "-p", "#{pane_current_path}"]);
}

export function discoverSessions(): SessionInfo[] {
  const sessionNames = listTmuxSessions();
  const results: SessionInfo[] = [];

  // Once the workspace registry is loaded (post daemon-embed startup),
  // discovery is gated by registry membership: only registered workspaces
  // are visible. Pre-load (e.g. unit tests that bypass daemon-embed) we
  // fall through to the legacy "any tmux session with a cwd" behavior.
  const registry = getDefaultWorkspaceRegistry();
  const enforceRegistry = registry._isLoaded();

  for (const name of sessionNames) {
    if (enforceRegistry && !registry.has(name)) continue;
    const dir = getSessionCwd(name);
    if (!dir) continue;

    let panes: PaneInfo[] = [];
    try {
      panes = listSessionPanes(name);
    } catch {
      // session may have vanished
    }

    results.push({ name, dir, panes });
  }

  return results;
}

export function buildOverviews(sessions: SessionInfo[]): SessionOverview[] {
  return sessions.map((s) => ({ name: s.name, dir: s.dir }));
}

export function buildProjectDetail(info: SessionInfo): ProjectDetail {
  return {
    session: info.name,
    dir: info.dir,
    panes: info.panes,
  };
}
