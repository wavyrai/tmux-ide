// In-memory registry of externally-reported Claude/codex agents — sessions
// running in plain terminals (no tmux) that self-report via a hook. Entries go
// `offline` after a missed-heartbeat window and are evicted once long stale.
import type {
  AgentHeartbeatPayload,
  AgentRecord,
  AgentRegisterPayload,
  AgentStatus,
  AgentTool,
} from "@tmux-ide/contracts";

interface ExternalAgentEntry {
  id: string;
  tool: AgentTool;
  name: string;
  cwd: string | null;
  session: string | null;
  pid: number | null;
  status: AgentStatus;
  taskTitle: string | null;
  registeredAt: number;
  lastSeen: number;
}

export interface ExternalAgentRegistryOptions {
  // Window without a heartbeat before an agent is reported `offline`.
  offlineAfterMs?: number;
  // Window without a heartbeat before an agent is dropped entirely.
  evictAfterMs?: number;
  // Hard cap on tracked agents; protects the long-lived daemon from a flood of
  // unique-id registrations. On overflow the least-recently-seen entry is
  // evicted so growth is bounded regardless of how often the list is read.
  maxEntries?: number;
}

export class ExternalAgentRegistry {
  private agents = new Map<string, ExternalAgentEntry>();
  private readonly offlineAfterMs: number;
  private readonly evictAfterMs: number;
  private readonly maxEntries: number;

  constructor(opts?: ExternalAgentRegistryOptions) {
    // 5min: hooks only refresh lastSeen on prompt/tool-use/turn-end, so the
    // window must tolerate a long turn that makes no tool calls.
    this.offlineAfterMs = opts?.offlineAfterMs ?? 5 * 60_000;
    this.evictAfterMs = opts?.evictAfterMs ?? 30 * 60_000;
    this.maxEntries = opts?.maxEntries ?? 1000;
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestSeen = Infinity;
    for (const [id, entry] of this.agents) {
      if (entry.lastSeen < oldestSeen) {
        oldestSeen = entry.lastSeen;
        oldestId = id;
      }
    }
    if (oldestId !== null) this.agents.delete(oldestId);
  }

  register(payload: AgentRegisterPayload, now = Date.now()): void {
    const existing = this.agents.get(payload.id);
    if (!existing && this.agents.size >= this.maxEntries) this.evictOldest();
    this.agents.set(payload.id, {
      id: payload.id,
      tool: payload.tool,
      name: payload.name ?? existing?.name ?? payload.id.slice(0, 12),
      cwd: payload.cwd ?? existing?.cwd ?? null,
      session: payload.session ?? existing?.session ?? null,
      pid: payload.pid ?? existing?.pid ?? null,
      status: payload.status ?? existing?.status ?? "idle",
      taskTitle: payload.taskTitle ?? existing?.taskTitle ?? null,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
    });
  }

  heartbeat(payload: AgentHeartbeatPayload, now = Date.now()): boolean {
    const entry = this.agents.get(payload.id);
    if (!entry) return false;
    entry.lastSeen = now;
    if (payload.status) entry.status = payload.status;
    if (payload.taskTitle !== undefined) entry.taskTitle = payload.taskTitle;
    return true;
  }

  unregister(id: string): boolean {
    return this.agents.delete(id);
  }

  /** Drop entries that have been silent past the eviction window. */
  prune(now = Date.now()): void {
    for (const [id, entry] of this.agents) {
      if (now - entry.lastSeen > this.evictAfterMs) this.agents.delete(id);
    }
  }

  /** Snapshot as unified AgentRecords; stale entries surface as `offline`. */
  list(now = Date.now()): AgentRecord[] {
    this.prune(now);
    return Array.from(this.agents.values()).map((entry) => {
      const stale = now - entry.lastSeen > this.offlineAfterMs;
      return {
        id: entry.id,
        kind: "external",
        tool: entry.tool,
        name: entry.name,
        status: stale ? "offline" : entry.status,
        session: entry.session,
        paneId: null,
        paneTitle: null,
        cwd: entry.cwd,
        taskId: null,
        taskTitle: entry.taskTitle,
        pid: entry.pid,
        lastActivity: new Date(entry.lastSeen).toISOString(),
        machineId: null,
        machineName: null,
      } satisfies AgentRecord;
    });
  }
}

// ---------------------------------------------------------------------------
// Default singleton — the daemon process holds one registry so both the v2
// action handlers (agent.register / heartbeat / unregister) and the
// GET /api/agents route observe the same external-agent state.
// ---------------------------------------------------------------------------

let _default: ExternalAgentRegistry | null = null;

export function getDefaultExternalAgentRegistry(): ExternalAgentRegistry {
  if (!_default) _default = new ExternalAgentRegistry();
  return _default;
}

/** @internal Test hook: replace the singleton. */
export function _setDefaultExternalAgentRegistryForTests(
  registry: ExternalAgentRegistry | null,
): void {
  _default = registry;
}

/** A remote machine's agents as fetched by HQ during fan-out. */
export interface RemoteAgentSource {
  machineId: string;
  machineName: string;
  agents: AgentRecord[];
}

// Remote agents come from a possibly-hostile/compromised machine. The response
// is already Zod-bounded for length; here we additionally strip control chars
// (terminal escape sequences, NULs) from display strings so a remote can't
// inject into the local UI/terminal when its records are rendered.
function sanitizeDisplay(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // Drop C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F) —
    // xterm-class terminals can interpret C1 bytes (e.g. 0x9B = CSI).
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    out += ch;
  }
  return out.slice(0, 512);
}

function sanitizeRemoteAgent(a: AgentRecord, remote: RemoteAgentSource): AgentRecord {
  // machineId/machineName come from the remote's registration record, which is
  // also attacker-influenceable — sanitize them too, not just the agent fields.
  const machineId = sanitizeDisplay(remote.machineId);
  return {
    ...a,
    id: `${machineId}:${sanitizeDisplay(a.id)}`,
    name: sanitizeDisplay(a.name),
    session: a.session === null ? null : sanitizeDisplay(a.session),
    paneTitle: a.paneTitle === null ? null : sanitizeDisplay(a.paneTitle),
    cwd: a.cwd === null ? null : sanitizeDisplay(a.cwd),
    taskTitle: a.taskTitle === null ? null : sanitizeDisplay(a.taskTitle),
    machineId,
    machineName: sanitizeDisplay(remote.machineName),
  };
}

/**
 * Build the aggregated HQ view: this host's local agents (stamped with the
 * self machine name, machineId null) followed by every reachable remote's
 * agents (stamped + sanitized, ids namespaced by `${machineId}:` so they stay
 * globally unique). Pure — the caller owns fetch/timeout/skip/self-exclusion.
 */
export function aggregateHqAgents(
  localAgents: AgentRecord[],
  selfMachineName: string,
  remotes: RemoteAgentSource[],
): AgentRecord[] {
  const selfName = sanitizeDisplay(selfMachineName);
  const out: AgentRecord[] = localAgents.map((a) => ({
    ...a,
    machineId: null,
    machineName: selfName,
  }));
  for (const remote of remotes) {
    for (const a of remote.agents) {
      out.push(sanitizeRemoteAgent(a, remote));
    }
  }
  return out;
}

/**
 * Merge tmux-discovered agents with externally-reported ones, de-duplicating
 * by pid (a hook-registered agent that's also visible in a tmux pane shows up
 * once, preferring the richer live tmux record).
 */
export function mergeLocalAgents(
  tmuxAgents: AgentRecord[],
  externalAgents: AgentRecord[],
): AgentRecord[] {
  const tmuxPids = new Set(
    tmuxAgents.map((a) => a.pid).filter((pid): pid is number => pid !== null),
  );
  const externalOnly = externalAgents.filter((a) => a.pid === null || !tmuxPids.has(a.pid));
  return [...tmuxAgents, ...externalOnly];
}
