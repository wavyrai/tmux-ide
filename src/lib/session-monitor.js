import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const INTERVAL = 1000;
const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒|/\\-] /;

// --- Port detection (pure helpers) ---

function getListeningPids() {
  // Returns Set of PIDs that have a listening TCP port in range 1024-20000
  try {
    const raw = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    let currentPid = null;
    for (const line of raw.split("\n")) {
      if (line.startsWith("p")) {
        currentPid = line.slice(1);
      } else if (line.startsWith("n") && currentPid) {
        const match = line.match(/:(\d+)$/);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= 1024 && port <= 20000) pids.add(currentPid);
        }
      }
    }
    return pids;
  } catch {
    return new Set();
  }
}

function getProcessTree() {
  // Returns Map<pid, ppid>
  try {
    const raw = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tree = new Map();
    for (const line of raw.trim().split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length === 2) tree.set(parts[0], parts[1]);
    }
    return tree;
  } catch {
    return new Map();
  }
}

export function computePortPanes(panes, { listeners, tree } = {}) {
  // Walk up from each listening PID to find which pane owns it
  if (!listeners) listeners = getListeningPids();
  if (!tree) tree = getProcessTree();
  if (listeners.size === 0) return new Set();

  const panePids = new Map(panes.map((p) => [p.pid, p.id]));
  const result = new Set();

  for (const listenerPid of listeners) {
    let pid = listenerPid;
    while (pid && pid !== "0") {
      if (panePids.has(pid)) {
        result.add(panePids.get(pid));
        break;
      }
      pid = tree.get(pid);
    }
  }
  return result;
}

// --- Agent detection ---

export function computeAgentStates(panes) {
  // Returns Map<paneId, "busy" | "idle" | null>
  const states = new Map();
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
  const session = process.argv[2];
  if (!session) process.exit(1);

  function tmux(...args) {
    return execFileSync("tmux", args, { encoding: "utf-8" }).trim();
  }

  function tmuxSilent(...args) {
    try {
      return tmux(...args);
    } catch {
      return "";
    }
  }

  function sessionExists() {
    try {
      tmux("has-session", "-t", session);
      return true;
    } catch {
      return false;
    }
  }

  function hasClients() {
    return tmuxSilent("list-clients").length > 0;
  }

  function listPanes() {
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
      return { id, pid, cmd, title };
    });
  }

  let lastState = "";

  function tick() {
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
