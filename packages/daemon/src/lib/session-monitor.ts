import { execFileSync } from "node:child_process";

const SPINNERS = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠒⠢⠆⠐⠠⠄◐◓◑◒|/\\-] /;

interface MonitorPane {
  id: string;
  pid: string;
  cmd?: string;
  title?: string;
  role?: string;
  type?: string;
  name?: string;
}

// --- Port detection (pure helpers) ---

function getListeningPids(): Set<string> {
  // Returns Set of PIDs that have a listening TCP port in range 1024-20000
  try {
    const raw = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpPn"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
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
      timeout: 2000,
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
    const role = pane.role ?? "";

    // Primary: use @ide_role pane option if available
    if (role === "lead" || role === "teammate") {
      states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
      continue;
    }

    // Fallback: command-based detection for pre-upgrade sessions
    const cmd = (pane.cmd ?? "").toLowerCase();
    if (!cmd.includes("claude") && !cmd.includes("codex")) {
      states.set(pane.id, null);
      continue;
    }
    states.set(pane.id, SPINNERS.test(pane.title ?? "") ? "busy" : "idle");
  }
  return states;
}

// The per-session tick loop / orchestrator bootstrap that used to live
// here was orphaned by the canonical-tree fold — `daemon-embed.ts` owns
// both responsibilities now (see `startEmbeddedDaemon` + its
// orchestrator branch). Removing the legacy CLI block also fixes the
// esbuild-bundle case where `import.meta.url`-vs-`process.argv[1]`
// resolved to true at the bin/cli.js entry, causing the daemon's
// session monitor to hijack every CLI invocation (see N1 of
// docs/npm-distribution-audit.md). The pure exports above
// (`computeAgentStates`, `computePortPanes`) remain — that's what
// `daemon-embed.ts` actually imports.
