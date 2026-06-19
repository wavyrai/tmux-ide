// Discover every Claude/codex CLI agent visible on this host's tmux server —
// not just the panes tmux-ide spawned. Panes living in a managed session are
// reported as `managed` (we can control them); panes in any other session are
// `tmux-unmanaged` (observe + best-effort send-keys).
import { execFileSync } from "node:child_process";
import type { AgentRecord, AgentTool, PaneInfo } from "@tmux-ide/contracts";
import { isAgentPane, isAgentBusy, agentIdentifier } from "./orchestrator.ts";

type TmuxExecutor = (cmd: string, args: string[], options?: object) => string;

let _executor: TmuxExecutor = (cmd, args, options) =>
  execFileSync(cmd, args, { encoding: "utf-8", ...options }).toString();

/** Swap the tmux executor (tests). Returns a restore function. */
export function _setExecutor(fn: TmuxExecutor): () => void {
  const prev = _executor;
  _executor = fn;
  return () => {
    _executor = prev;
  };
}

function tmux(...args: string[]): string {
  try {
    return _executor("tmux", args, { stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString() ?? "";
    if (stderr.includes("no server running") || stderr.includes("can't find session")) {
      return "";
    }
    throw error;
  }
}

export interface TmuxPane extends PaneInfo {
  session: string;
  cwd: string | null;
  pid: number | null;
}

const FIELDS = [
  "#{session_name}",
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_pid}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
  "#{@ide_role}",
  "#{@ide_name}",
  "#{@ide_type}",
];

/** List panes across every session on the tmux server (`list-panes -a`). */
export function listAllTmuxPanes(): TmuxPane[] {
  const output = tmux("list-panes", "-a", "-F", FIELDS.join("\t"));
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [session, id, index, title, cmd, cwd, pid, width, height, active, role, name, type] =
        line.split("\t");
      return {
        session: session!,
        id: id!,
        index: parseInt(index!, 10),
        title: title!,
        currentCommand: cmd!,
        cwd: cwd || null,
        pid: pid ? parseInt(pid, 10) : null,
        width: parseInt(width!, 10),
        height: parseInt(height!, 10),
        active: active === "1",
        role: (role || null) as PaneInfo["role"],
        name: name || null,
        type: type || null,
      } satisfies TmuxPane;
    });
}

/** Infer which CLI an agent pane is running from its command name. */
export function inferAgentTool(currentCommand: string): AgentTool {
  const cmd = currentCommand.toLowerCase();
  if (cmd.startsWith("codex")) return "codex";
  if (cmd.startsWith("claude")) return "claude";
  // Claude Code reports its version string (e.g. "2.1.80") as the command.
  if (/^\d+\.\d+/.test(cmd)) return "claude";
  return "unknown";
}

/**
 * Discover all tmux agents on this host. `managedSessions` are the session
 * names tmux-ide owns; panes in those are `managed`, everything else is
 * `tmux-unmanaged`.
 */
export function discoverTmuxAgents(managedSessions: Set<string>): AgentRecord[] {
  return listAllTmuxPanes()
    .filter((pane) => isAgentPane(pane))
    .map((pane) => {
      const managed = managedSessions.has(pane.session);
      return {
        id: `${pane.session}:${pane.id}`,
        kind: managed ? "managed" : "tmux-unmanaged",
        tool: inferAgentTool(pane.currentCommand),
        name: agentIdentifier(pane),
        status: isAgentBusy(pane) ? "busy" : "idle",
        session: pane.session,
        paneId: pane.id,
        paneTitle: pane.title,
        cwd: pane.cwd,
        taskId: null,
        taskTitle: null,
        pid: pane.pid,
        lastActivity: new Date().toISOString(),
        machineId: null,
        machineName: null,
      } satisfies AgentRecord;
    });
}
