// Discover every Claude/codex CLI agent visible on this host's tmux server —
// not just the panes tmux-ide spawned. Panes living in a managed session are
// reported as `managed` (we can control them); panes in any other session are
// `tmux-unmanaged` (observe + best-effort send-keys).
import type { AgentRecord, AgentTool, PaneInfo } from "@tmux-ide/contracts";
import { isAgentPane, isAgentBusy, agentIdentifier } from "./orchestrator.ts";
import { tmux, _setExecutor } from "./tmux-exec.ts";

// Re-exported so existing tests/callers can keep importing the executor seam
// from here.
export { _setExecutor };

export interface TmuxPane extends PaneInfo {
  session: string;
  cwd: string | null;
  pid: number | null;
}

// pane_title is free-text and can contain tabs, so it goes LAST — any overflow
// from the tab split is rejoined back into the title rather than corrupting the
// fields after it.
const FIELDS = [
  "#{session_name}",
  "#{pane_id}",
  "#{pane_index}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_pid}",
  "#{pane_width}",
  "#{pane_height}",
  "#{pane_active}",
  "#{@ide_role}",
  "#{@ide_name}",
  "#{@ide_type}",
  "#{pane_title}",
];
const FIXED_FIELDS = FIELDS.length - 1; // everything before the trailing title

/** List panes across every session on the tmux server (`list-panes -a`). */
export function listAllTmuxPanes(): TmuxPane[] {
  const output = tmux("list-panes", "-a", "-F", FIELDS.join("\t"));
  if (!output) return [];
  const panes: TmuxPane[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    // Skip malformed rows (a tmux format glitch shouldn't crash discovery).
    if (parts.length < FIXED_FIELDS) continue;
    const [session, id, index, cmd, cwd, pid, width, height, active, role, name, type] = parts;
    if (!session || !id) continue;
    panes.push({
      session,
      id,
      index: parseInt(index!, 10) || 0,
      title: parts.slice(FIXED_FIELDS).join("\t"),
      currentCommand: cmd ?? "",
      cwd: cwd || null,
      pid: pid ? parseInt(pid, 10) || null : null,
      width: parseInt(width!, 10) || 0,
      height: parseInt(height!, 10) || 0,
      active: active === "1",
      role: (role || null) as PaneInfo["role"],
      name: name || null,
      type: type || null,
    } satisfies TmuxPane);
  }
  return panes;
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
