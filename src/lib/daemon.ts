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
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { computePortPanes, computeAgentStates } from "./session-monitor.ts";

/** Remove dispatch files older than 24 hours */
function cleanupDispatchFiles(dir: string): void {
  const dispatchDir = join(dir, ".tasks", "dispatch");
  if (!existsSync(dispatchDir)) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const file of readdirSync(dispatchDir)) {
      const filePath = join(dispatchDir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < cutoff) unlinkSync(filePath);
      } catch {
        // skip files we can't stat/delete
      }
    }
  } catch {
    // dispatch dir unreadable — skip
  }
}

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
let prevAgentStates = new Map<string, "busy" | "idle" | null>();
let monitorInitialized = false;

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

  // Notify master pane when an agent transitions from busy → idle
  if (monitorInitialized) {
    const masterPane = panes.find((p) => p.role === "lead");
    if (masterPane) {
      for (const pane of panes) {
        const prev = prevAgentStates.get(pane.id);
        const curr = agentStates.get(pane.id);
        if (prev === "busy" && curr === "idle" && pane.id !== masterPane.id) {
          const label = pane.name ?? pane.title ?? pane.id;
          tmuxSilent("send-keys", "-t", masterPane.id, `Agent "${label}" is now idle`, "Enter");
        }
      }
    }
  }
  monitorInitialized = true;
  prevAgentStates = agentStates;

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

      // Clean up stale dispatch files on startup
      cleanupDispatchFiles(process.cwd());

      stopOrchestrator = createOrchestrator({
        session,
        dir: process.cwd(),
        autoDispatch: orch.auto_dispatch ?? true,
        stallTimeout: orch.stall_timeout ?? 300000,
        pollInterval: orch.poll_interval ?? 5000,
        masterPane: orch.master_pane ?? null,
        beforeRun: orch.before_run ?? null,
        afterRun: orch.after_run ?? null,
        maxConcurrentAgents: orch.max_concurrent_agents ?? 10,
        dispatchMode: orch.dispatch_mode ?? "tasks",
        paneSpecialties,
        services:
          (orch.services as Record<
            string,
            { command: string; port?: number; healthcheck?: string }
          >) ?? {},
        research: orch.research,
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
    const { getRequestListener } = await import("@hono/node-server");
    const { AuthService } = await import("./auth/auth-service.ts");
    const { AuthConfigSchema } = await import("./auth/types.ts");
    const { TunnelManager } = await import("./tunnels/manager.ts");
    const { RemoteRegistry } = await import("./hq/registry.ts");
    const { HQConfigSchema } = await import("./hq/types.ts");

    // Load auth + tunnel + hq config from ide.yml
    let authConfig = AuthConfigSchema.parse({});
    let authService: InstanceType<typeof AuthService> | undefined;
    let tunnelConfig: Record<string, unknown> | undefined;
    let hqConfig: ReturnType<typeof HQConfigSchema.parse> | undefined;
    try {
      const { readConfig } = await import("./yaml-io.ts");
      const { config } = readConfig(process.cwd());
      if (config.auth) {
        authConfig = AuthConfigSchema.parse(config.auth);
      }
      if (config.tunnel) {
        tunnelConfig = config.tunnel as Record<string, unknown>;
      }
      if (config.hq) {
        hqConfig = HQConfigSchema.parse(config.hq);
      }
    } catch {
      // Config not readable — use defaults
    }
    authService = new AuthService(authConfig.secret);
    const tunnelManager = new TunnelManager({ session, dir: process.cwd() });

    // Start HQ registry if role is "hq"
    let remoteRegistry: InstanceType<typeof RemoteRegistry> | undefined;
    if (hqConfig?.enabled && hqConfig.role === "hq") {
      let _isShuttingDown = false;
      remoteRegistry = new RemoteRegistry({
        healthInterval: hqConfig.heartbeat_interval,
        isShuttingDown: () => _isShuttingDown,
      });
      // Wire shutdown flag
      const origShutdown = shutdown;
      const shutdownWithRegistry = () => {
        _isShuttingDown = true;
        remoteRegistry?.destroy();
        origShutdown();
      };
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
      process.on("SIGTERM", shutdownWithRegistry);
      process.on("SIGINT", shutdownWithRegistry);
      console.log("[daemon] HQ registry started");
    }

    const app = createApp({ authService, authConfig, tunnelManager, remoteRegistry });

    // Health endpoint for watchdog and external probes
    app.get("/health", (c: { json: (body: unknown, status?: number) => Response }) => {
      return c.json({ ok: true, session, uptime: process.uptime() });
    });

    const listener = getRequestListener(app.fetch);
    const server = createServer(listener);

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

    // Auto-start tunnel if configured
    if (tunnelConfig && tunnelConfig.auto_start) {
      try {
        const { tunnelConfigSchema } = await import("./tunnels/types.ts");
        const addr = server.address();
        const ccPort = typeof addr === "object" && addr ? addr.port : requestedPort;
        const parsed = tunnelConfigSchema.parse({
          ...tunnelConfig,
          port: tunnelConfig.port ?? ccPort,
        });
        await tunnelManager.start(parsed);
        console.log("[daemon] Tunnel auto-started");
      } catch (err) {
        console.error("[daemon] Tunnel auto-start failed:", err);
      }
    }

    // Auto-start HQ client if role is "remote"
    if (hqConfig?.enabled && hqConfig.role === "remote" && hqConfig.hq_url) {
      try {
        const { HQClient } = await import("./hq/client.ts");
        const os = await import("node:os");
        const addr = server.address();
        const ccPort = typeof addr === "object" && addr ? addr.port : requestedPort;
        const hqClient = new HQClient({
          hqUrl: hqConfig.hq_url,
          secret: hqConfig.secret ?? "",
          machineName: hqConfig.machine_name ?? os.hostname(),
          remoteUrl: `http://localhost:${ccPort}`,
          heartbeatInterval: hqConfig.heartbeat_interval,
        });
        await hqClient.register();
        console.log(`[daemon] Registered with HQ as ${hqClient.getName()}`);

        // Deregister on shutdown
        const origShutdownFn = shutdown;
        process.removeListener("SIGTERM", shutdown);
        process.removeListener("SIGINT", shutdown);
        const shutdownWithHQ = async () => {
          await hqClient.destroy();
          origShutdownFn();
        };
        process.on("SIGTERM", () => void shutdownWithHQ());
        process.on("SIGINT", () => void shutdownWithHQ());
      } catch (err) {
        console.error("[daemon] HQ client registration failed:", err);
      }
    }
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
