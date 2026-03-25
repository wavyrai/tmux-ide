/**
 * Unified tmux-ide daemon — background process that combines:
 * 1. Pane monitor loop (port detection, agent state, title drift)
 * 2. Orchestrator startup (task dispatch, stall detection)
 * 3. Command Center HTTP/WebSocket server
 *
 * Entry: bun src/lib/daemon.ts <session> [port]
 * Spawned as a detached child by launch.ts (via daemon-watchdog.ts).
 */

import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { computePortPanes, computeAgentStates } from "./session-monitor.ts";

const INTERVAL = 1000;

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const sessionArg = process.argv[2];
if (!sessionArg) {
  console.error("Usage: daemon.ts <session> [port]");
  process.exit(1);
}
const session: string = sessionArg;
const requestedPort = parseInt(process.argv[3] ?? "0", 10);

// ---------------------------------------------------------------------------
// tmux helpers (same as session-monitor.ts)
// ---------------------------------------------------------------------------

interface MonitorPane {
  id: string;
  pid: string;
  cmd?: string;
  title?: string;
  role?: string;
  type?: string;
  name?: string;
}

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
    "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_title}\t#{@ide_role}\t#{@ide_type}\t#{@ide_name}",
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [id, pid, cmd, title, role, type, name] = line.split("\t");
    return {
      id: id!,
      pid: pid!,
      cmd,
      title,
      role: role || undefined,
      type: type || undefined,
      name: name || undefined,
    };
  });
}

// ---------------------------------------------------------------------------
// Monitor loop
// ---------------------------------------------------------------------------

let lastState = "";

function tick(): void {
  if (!sessionExists()) {
    shutdown();
    return;
  }
  if (!hasClients()) return; // skip when nobody is watching

  const panes = listPanes();
  if (panes.length === 0) return;

  const portPanes = computePortPanes(panes);
  const agentStates = computeAgentStates(panes);

  // Build state fingerprint for change detection (includes title drift)
  const stateKey = panes
    .map((p) => {
      const port = portPanes.has(p.id) ? "1" : "0";
      const agent = agentStates.get(p.id) ?? "-";
      const titleDrift = p.name && p.title !== p.name ? "d" : "ok";
      return `${p.id}:${port}:${agent}:${titleDrift}`;
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

    // Restore configured pane title if Claude Code changed it
    if (pane.name && pane.title !== pane.name) {
      tmuxSilent("select-pane", "-t", pane.id, "-T", pane.name);
    }
  }

  tmuxSilent("refresh-client", "-S");
  lastState = stateKey;
}

const monitorInterval = setInterval(tick, INTERVAL);
tick(); // run immediately

// ---------------------------------------------------------------------------
// Orchestrator (if enabled in ide.yml)
// ---------------------------------------------------------------------------

let stopOrchestrator: (() => void) | null = null;

async function startOrchestrator(): Promise<void> {
  try {
    const { readConfig } = await import("./yaml-io.ts");
    const { config } = readConfig(process.cwd());

    if (!config.orchestrator?.enabled) return;

    try {
      const { createOrchestrator } = await import("./orchestrator.ts");

      // Configure webhooks for event delivery
      if (config.orchestrator.webhooks?.length) {
        const { setWebhookConfig } = await import("./event-log.ts");
        setWebhookConfig(config.orchestrator.webhooks);
      }

      const orch = config.orchestrator;

      // Build pane specialty map from ide.yml config
      const paneSpecialties = new Map<string, string[]>();
      for (const row of config.rows) {
        for (const pane of row.panes) {
          if (pane.specialty && pane.title) {
            paneSpecialties.set(
              pane.title,
              pane.specialty.split(",").map((s: string) => s.trim().toLowerCase()),
            );
          }
        }
      }

      stopOrchestrator = createOrchestrator({
        session,
        dir: process.cwd(),
        autoDispatch: orch.auto_dispatch ?? true,
        stallTimeout: orch.stall_timeout ?? 300000,
        pollInterval: orch.poll_interval ?? 5000,
        worktreeRoot: orch.worktree_root ?? ".worktrees/",
        masterPane: orch.master_pane ?? null,
        beforeRun: orch.before_run ?? null,
        afterRun: orch.after_run ?? null,
        cleanupOnDone: orch.cleanup_on_done ?? false,
        maxConcurrentAgents: orch.max_concurrent_agents ?? 10,
        dispatchMode: orch.dispatch_mode ?? "tasks",
        paneSpecialties,
      });
    } catch {
      // Orchestrator module not available yet
    }
  } catch {
    // Config not readable — skip orchestrator
  }
}

void startOrchestrator();

// ---------------------------------------------------------------------------
// Command Center HTTP + WebSocket server
// ---------------------------------------------------------------------------

let httpServer: Server | null = null;

async function startCommandCenter(): Promise<void> {
  try {
    const { createApp } = await import("../command-center/server.ts");
    const { attachWebSockets } = await import("../command-center/index.ts");
    const { getRequestListener } = await import("@hono/node-server");

    const app = createApp();

    // Health endpoint for watchdog and external probes
    app.get("/health", (c: { json: (body: unknown, status?: number) => Response }) => {
      return c.json({ ok: true, session, uptime: process.uptime() });
    });

    const listener = getRequestListener(app.fetch);
    const server = createServer(listener);

    // Attach WebSocket upgrade handler for pane mirrors
    attachWebSockets(server, session, process.cwd());

    // Try requested port, fall back to auto-assign if taken
    const tryPort = (port: number): Promise<void> =>
      new Promise<void>((res, rej) => {
        server.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && port !== 0) {
            console.log(`[daemon] Port ${port} in use, falling back to auto-assign`);
            server.removeAllListeners("error");
            tryPort(0).then(res, rej);
          } else {
            rej(err);
          }
        });
        server.listen(port, "0.0.0.0", () => {
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : port;
          tmuxSilent("set-option", "-t", session, "@command_center_port", String(actualPort));
          console.log(
            `[daemon] Command Center on http://0.0.0.0:${actualPort} (session: ${session})`,
          );
          res();
        });
      });

    await tryPort(requestedPort);
    httpServer = server;
  } catch (err) {
    // Command center failed but daemon continues (monitor + orchestrator still work)
    console.error("[daemon] Command Center failed to start:", err);
  }
}

void startCommandCenter();

// ---------------------------------------------------------------------------
// Unified shutdown
// ---------------------------------------------------------------------------

function shutdown(): void {
  clearInterval(monitorInterval);
  if (stopOrchestrator) stopOrchestrator();
  if (httpServer) httpServer.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
