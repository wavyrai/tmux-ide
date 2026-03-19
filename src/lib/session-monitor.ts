import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const INTERVAL = 1000;
const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒|/\\-] /;

interface MonitorPane {
  id: string;
  pid: string;
  cmd?: string;
  title?: string;
}

// --- Port detection (pure helpers) ---

function getListeningPids(): Set<string> {
  // Returns Set of PIDs that have a listening TCP port in range 1024-20000
  try {
    const raw = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set<string>();
    let currentPid: string | null = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line.startsWith("n") && currentPid) {
        const match = line.match(/:(\d+)$/);
        if (match) {
          const port = parseInt(match[1]!, 10);
          if (port >= 1024 && port <= 20000) pids.add(currentPid);
        }
      }
    }
    return pids;
  } catch {
    return new Set<string>();
  }
}

function getProcessTree(): Map<string, string> {
  // Returns Map<pid, ppid>
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tree = new Map<string, string>();
    for (const line of raw.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) tree.set(parts[0]!, parts[1]!);
    }
    return tree;
  } catch {
    return new Map<string, string>();
  }
}

export function computePortPanes(
  panes: MonitorPane[],
  { listeners, tree }: { listeners?: Set<string>; tree?: Map<string, string> } = {},
): Set<string> {
  // Walk up from each listening PID to find which pane owns it
  const resolvedListeners = listeners ?? getListeningPids();
  const resolvedTree = tree ?? getProcessTree();
  if (resolvedListeners.size === 0) return new Set<string>();

  const panePids = new Map(panes.map((p) => [p.pid, p.id]));
  const result = new Set<string>();

  for (const listenerPid of resolvedListeners) {
    let pid: string | undefined = listenerPid;
    while (pid && pid !== "0") {
      if (panePids.has(pid)) {
        result.add(panePids.get(pid)!);
        break;
      }
      pid = resolvedTree.get(pid);
    }
  }
  return result;
}

// --- Agent detection ---

export function computeAgentStates(panes: MonitorPane[]): Map<string, "busy" | "idle" | null> {
  // Returns Map<paneId, "busy" | "idle" | null>
  const states = new Map<string, "busy" | "idle" | null>();
  for (const pane of panes) {
    const cmd = (pane.cmd ?? "").toLowerCase();
    if (!cmd.includes("claude") && !cmd.includes("codex")) {
      states.set(pane.id, null);
      continue;
    }
    states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
  }
  return states;
}

// --- Main loop (only runs when executed directly) ---

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const session: string = process.argv[2]!;
  if (!session) process.exit(1);

  function tmux(...args: string[]): string {
    return execFileSync("tmux", args, { encoding: "utf-8" }).trim();
  }

  function tmuxSilent(...args: string[]): string {
    try {
      return tmux(...args);
    } catch {
      return "";
    }
  }

  function sessionExists(): boolean {
    try {
      tmux("has-session", "-t", session);
      return true;
    } catch {
      return false;
    }
  }

  function hasClients(): boolean {
    return tmuxSilent("list-clients").length > 0;
  }

  function listPanes(): MonitorPane[] {
    const raw = tmuxSilent(
      "list-panes",
      "-t",
      session,
      "-F",
      "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}",
    );
    if (!raw) return [];
    return raw.split("\n").map((line) => {
      const [id, pid, cmd, title] = line.split("\t");
      return { id: id!, pid: pid!, cmd, title };
    });
  }

  let lastState = "";

  function tick(): void {
    if (!sessionExists()) process.exit(0);
    if (!hasClients()) return; // skip when nobody is watching

    const panes = listPanes();
    if (panes.length === 0) return;

    const portPanes = computePortPanes(panes);
    const agentStates = computeAgentStates(panes);

    // Build state fingerprint for change detection
    const stateKey = panes
      .map((p) => {
        const port = portPanes.has(p.id) ? "1" : "0";
        const agent = agentStates.get(p.id) ?? "-";
        return `${p.id}:${port}:${agent}`;
      })
      .join("|");

    if (stateKey === lastState) return;

    // Apply changes
    for (const pane of panes) {
      const hasPort = portPanes.has(pane.id) ? "1" : "0";
      const agent = agentStates.get(pane.id);

      tmuxSilent("set-option", "-pqt", pane.id, "@has_port", hasPort);
      tmuxSilent("set-option", "-pqt", pane.id, "@agent_busy", agent === "busy" ? "1" : "0");
      tmuxSilent("set-option", "-pqt", pane.id, "@agent_idle", agent === "idle" ? "1" : "0");
    }

    tmuxSilent("refresh-client", "-S");
    lastState = stateKey;
  }

  setInterval(tick, INTERVAL);
  tick(); // run immediately
}
