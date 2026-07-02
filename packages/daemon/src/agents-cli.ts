import { AgentListSchemaZ, type AgentRecord } from "@tmux-ide/contracts";
import { hostnameForClient } from "./agent-hook.ts";
import { readCanonicalDaemonInfo, type CanonicalDaemonInfo } from "./lib/canonical-daemon.ts";
import { IdeError } from "./lib/errors.ts";

/**
 * `tmux-ide agents ...` — the central fleet surface. Lists every agent the
 * local canonical daemon can see (this machine, HQ-registered machines, and
 * SSH-tunneled remotes) and sends input to any of them from here.
 *
 * Distinct from `tmux-ide agent` (singular), the hook reporter that lets a
 * plain-terminal Claude/codex session report itself to the daemon.
 */

const NO_DAEMON_MESSAGE = "No tmux-ide daemon running — start one with `tmux-ide`";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const STATUS_GLYPHS: Record<AgentRecord["status"], string> = {
  busy: "●",
  idle: "○",
  offline: "◌",
};

/** Exact-match lookup — agent ids are opaque, never parsed or prefix-matched. */
export function findAgentById(agents: AgentRecord[], id: string): AgentRecord | undefined {
  return agents.find((agent) => agent.id === id);
}

/**
 * Resolve a send target from the fetched fleet list. The machineId is taken
 * verbatim from the matching record (null = this machine) — the id string is
 * never parsed to guess it.
 */
export function resolveSendTarget(
  agents: AgentRecord[],
  id: string,
): { agent: AgentRecord; machineId: string | null } {
  const agent = findAgentById(agents, id);
  if (!agent) {
    throw new IdeError(`Agent not found: ${id}. Run \`tmux-ide agents\` to list agent ids.`, {
      code: "AGENT_NOT_FOUND",
      exitCode: 1,
    });
  }
  return { agent, machineId: agent.machineId };
}

export interface AgentMachineGroup {
  machineId: string | null;
  machineName: string | null;
  agents: AgentRecord[];
}

/**
 * Group agents by machine for display. The local machine (machineId null)
 * always comes first; remote machines follow in first-seen order.
 */
export function groupAgentsByMachine(agents: AgentRecord[]): AgentMachineGroup[] {
  const groups = new Map<string, AgentMachineGroup>();
  for (const agent of agents) {
    const key = agent.machineId ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { machineId: agent.machineId, machineName: agent.machineName, agents: [] };
      groups.set(key, group);
    }
    group.agents.push(agent);
  }
  const ordered = [...groups.values()];
  ordered.sort((a, b) => Number(a.machineId !== null) - Number(b.machineId !== null));
  return ordered;
}

/** One display line per agent: glyph, name, tool, kind, location, task, id. */
export function formatAgentLine(agent: AgentRecord): string {
  const location =
    agent.session && agent.paneId ? `${agent.session}·${agent.paneId}` : (agent.cwd ?? "");
  const parts = [`${STATUS_GLYPHS[agent.status]} ${agent.name}`, agent.tool, agent.kind];
  if (location) parts.push(location);
  if (agent.taskTitle) parts.push(`— ${agent.taskTitle}`);
  parts.push(`[${agent.id}]`);
  return `  ${parts.join("  ")}`;
}

/** Human-readable fleet listing, grouped by machine (this machine first). */
export function formatAgentList(agents: AgentRecord[]): string {
  if (agents.length === 0) {
    return "No agents found.";
  }
  const lines: string[] = [];
  for (const group of groupAgentsByMachine(agents)) {
    const label =
      group.machineId === null
        ? group.machineName
          ? `${group.machineName} (this machine)`
          : "this machine"
        : (group.machineName ?? group.machineId);
    lines.push(label);
    for (const agent of group.agents) {
      lines.push(formatAgentLine(agent));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Daemon HTTP plumbing
// ---------------------------------------------------------------------------

function requireDaemonInfo(): CanonicalDaemonInfo {
  const info = readCanonicalDaemonInfo();
  if (!info) {
    throw new IdeError(NO_DAEMON_MESSAGE, { code: "DAEMON_UNAVAILABLE", exitCode: 1 });
  }
  return info;
}

function daemonRequest(
  info: CanonicalDaemonInfo,
  path: string,
): { url: string; headers: Record<string, string> } {
  const url = `http://${hostnameForClient(info.bindHostname)}:${info.port}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (info.authToken) headers.Authorization = `Bearer ${info.authToken}`;
  return { url, headers };
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function fetchAgentList(
  info: CanonicalDaemonInfo,
): Promise<{ agents: AgentRecord[]; raw: unknown }> {
  const { url, headers } = daemonRequest(info, "/api/hq/agents");
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: timeoutSignal(15_000) });
  } catch {
    // daemon.json exists but nothing answers — treat as no daemon.
    throw new IdeError(NO_DAEMON_MESSAGE, { code: "DAEMON_UNAVAILABLE", exitCode: 1 });
  }
  if (!res.ok) {
    throw new IdeError(`Daemon replied ${res.status} to GET /api/hq/agents`, {
      code: "DAEMON_ERROR",
      exitCode: 1,
    });
  }
  const raw: unknown = await res.json();
  const parsed = AgentListSchemaZ.safeParse(raw);
  if (!parsed.success) {
    throw new IdeError("Daemon returned an unexpected /api/hq/agents payload", {
      code: "DAEMON_ERROR",
      exitCode: 1,
    });
  }
  return { agents: parsed.data.agents, raw };
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function listAgents(opts: { json?: boolean }): Promise<void> {
  const info = requireDaemonInfo();
  const { agents, raw } = await fetchAgentList(info);
  if (opts.json) {
    console.log(JSON.stringify(raw));
    return;
  }
  console.log(formatAgentList(agents));
}

async function sendToAgent(opts: {
  id: string;
  message: string;
  noEnter?: boolean;
  json?: boolean;
}): Promise<void> {
  const info = requireDaemonInfo();
  const { agents } = await fetchAgentList(info);
  const { agent, machineId } = resolveSendTarget(agents, opts.id);

  const { url, headers } = daemonRequest(info, "/api/agents/send");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: opts.id,
        machineId,
        message: opts.message,
        noEnter: opts.noEnter ? true : undefined,
      }),
      signal: timeoutSignal(15_000),
    });
  } catch {
    throw new IdeError(NO_DAEMON_MESSAGE, { code: "DAEMON_UNAVAILABLE", exitCode: 1 });
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const detail = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    const code = res.status === 409 ? "AGENT_OBSERVE_ONLY" : "SEND_FAILED";
    throw new IdeError(`Send failed: ${detail}`, { code, exitCode: 1 });
  }

  if (opts.json) {
    console.log(JSON.stringify(body));
    return;
  }
  const where = machineId === null ? "this machine" : (agent.machineName ?? machineId);
  console.log(`Sent to ${agent.name} [${agent.id}] on ${where}.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface AgentsCommandOptions {
  sub?: string;
  args?: string[];
  json?: boolean;
  noEnter?: boolean;
}

/**
 * Entry point for `tmux-ide agents ...`.
 *
 * - `agents` / `agents list [--json]` — list every agent across machines.
 * - `agents send <agent-id> <message...> [--no-enter]` — send input to any
 *   agent by id (external plain-terminal agents are observe-only).
 */
export async function agentsCommand(opts: AgentsCommandOptions): Promise<void> {
  const sub = opts.sub;

  if (sub === undefined || sub === "list") {
    await listAgents({ json: opts.json });
    return;
  }

  if (sub === "send") {
    const [id, ...messageParts] = opts.args ?? [];
    const message = messageParts.join(" ");
    if (!id || !message) {
      throw new IdeError(
        "Usage: tmux-ide agents send <agent-id> <message...> [--no-enter]\n" +
          "Run `tmux-ide agents` to list agent ids.",
        { code: "USAGE", exitCode: 1 },
      );
    }
    await sendToAgent({ id, message, noEnter: opts.noEnter, json: opts.json });
    return;
  }

  throw new IdeError(
    "Usage:\n" +
      "  tmux-ide agents [list] [--json]\n" +
      "  tmux-ide agents send <agent-id> <message...> [--no-enter] [--json]\n" +
      "(For the plain-terminal hook reporter, see `tmux-ide agent`.)",
    { code: "USAGE", exitCode: 1 },
  );
}
