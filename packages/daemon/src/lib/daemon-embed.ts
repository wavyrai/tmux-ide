/**
 * Programmatic tmux-ide daemon entrypoint.
 *
 * This is the shared runtime used by the standalone daemon process and by
 * embedders such as Electron's main process.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { computeAgentStates, computePortPanes } from "./session-monitor.ts";
import {
  flushPendingTaskStore,
  getTaskStoreHealth,
  reconcileTaskStore,
  replayTaskStoreWal,
  startTaskStoreWatcher,
} from "./task-store.ts";
import { DaemonShutdownError, DaemonStartupError } from "./errors.ts";
import { handlePtyWebSocket, shutdownPtyBridges } from "../server/ws-route.ts";
import { handleWsEventsConnection } from "../command-center/ws-events.ts";
import { setRemoteAccessRestartBackend } from "../command-center/actions/handlers/app-set-remote-access.ts";
import { setDaemonShutdownBackend } from "../command-center/actions/handlers/daemon-shutdown.ts";
import { shutdownDefaultChatRuntime } from "../chat/defaults.ts";
import { readAppSettings } from "./app-settings.ts";
import { getProject } from "./project-registry.ts";
import { getDefaultWorkspaceRegistry } from "./workspace-registry.ts";
import { setActivationBackend, type ProjectActivationOptions } from "./active-projects.ts";
import {
  clearCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
  writeCanonicalDaemonInfo,
} from "./canonical-daemon.ts";

const requireFromHere = createRequire(import.meta.url);
const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_GRACEFUL_MS = 2000;
const MONITOR_INTERVAL_MS = 1000;
const RECONCILE_INTERVAL_MS = 30_000;
const EMBEDDED_SESSION_NAME = "__embedded__";

export interface EmbeddedDaemonOptions {
  sessionName?: string;
  port?: number;
  bindHostname?: string;
  authToken?: string | null;
  localBypassToken?: string | null;
  takeoverIfRunning?: boolean;
  silent?: boolean;
  /** @deprecated Use bindHostname. */
  hostname?: string;
  orchestratorStarter?: (sessionName: string, dir: string) => Promise<() => void>;
}

export interface EmbeddedDaemonHandle {
  readonly port: number;
  readonly apiBaseUrl: string;
  readonly wsUrl: string;
  readonly localBypassToken: string | null;
  activateProject(
    projectName: string,
    options?: ProjectActivationOptions,
  ): Promise<{ stop: () => Promise<void> }>;
  stop(opts?: { gracefulMs?: number }): Promise<void>;
}

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
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    // Pipe stdio explicitly. Inheriting (the default) inherits the parent's
    // file descriptors; when the daemon is launched detached (nohup, disown,
    // launchd, etc.) the controlling terminal's fds can be invalid, and the
    // child spawn fails with EBADF. The visible symptom is sessionExists()
    // returning false → stopSelf → ghost daemon.
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tmuxSilent(...args: string[]): string {
  try {
    return tmux(...args);
  } catch {
    return "";
  }
}

function assertTmuxSession(sessionName: string): void {
  try {
    tmux("has-session", "-t", sessionName);
  } catch (err) {
    throw new DaemonStartupError(
      `tmux session "${sessionName}" does not exist`,
      "tmux_session_missing",
      { cause: err as Error },
    );
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DaemonStartupError(`Invalid daemon port: ${port}`, "port_invalid");
  }
}

async function pickFreePort(hostname: string): Promise<number> {
  const probe = createServer();
  return await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, hostname, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => {
        if (port) resolve(port);
        else reject(new DaemonStartupError("Could not allocate daemon port", "bind_failed"));
      });
    });
  });
}

function sessionExists(sessionName: string): "yes" | "no" | "unknown" {
  try {
    tmux("has-session", "-t", sessionName);
    return "yes";
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).message ?? "";
    const code = (err as NodeJS.ErrnoException).code;
    // Spawn-level failures (EBADF, EAGAIN, etc.) are transient OS issues,
    // not "session is gone" signals. Same for non-zero exits without stderr
    // — `has-session` returns 1 only when the session is genuinely missing,
    // and tmux always writes to stderr in that case.
    if (
      code === "EBADF" ||
      code === "EAGAIN" ||
      code === "EMFILE" ||
      code === "ENFILE" ||
      msg.includes("EBADF") ||
      msg.includes("EAGAIN")
    ) {
      console.error("[daemon] sessionExists transient spawn error:", msg);
      return "unknown";
    }
    return "no";
  }
}

function hasClients(): boolean {
  return tmuxSilent("list-clients").length > 0;
}

function listPanes(sessionName: string): MonitorPane[] {
  const raw = tmuxSilent(
    "list-panes",
    "-t",
    sessionName,
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

async function startOrchestrator(sessionName: string, dir: string): Promise<() => void> {
  try {
    const { readConfig } = await import("./yaml-io.ts");
    const { config } = readConfig(dir);
    if (!config.orchestrator?.enabled) return () => undefined;

    const { createOrchestrator } = await import("./orchestrator.ts");

    if (config.orchestrator.webhooks?.length) {
      const { setWebhookConfig } = await import("./event-log.ts");
      setWebhookConfig(config.orchestrator.webhooks);
    }

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

    cleanupDispatchFiles(dir);
    const orch = config.orchestrator;
    return createOrchestrator({
      session: sessionName,
      dir,
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
  } catch (err) {
    console.error("[daemon] Orchestrator failed to start:", err);
    return () => undefined;
  }
}

function bearerToken(authHeader: string | string[] | undefined): string | null {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

function requestToken(req: import("node:http").IncomingMessage): string | null {
  const headerToken = bearerToken(req.headers.authorization);
  if (headerToken) return headerToken;
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

function isLoopbackRequest(req: import("node:http").IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  // Cover both IPv4 (127.0.0.1) and IPv6 (::1 / ::ffff:127.0.0.1) loopback.
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1" ||
    remote.startsWith("127.")
  );
}

function isLoopbackBind(bindHostname: string | null | undefined): boolean {
  return bindHostname === "127.0.0.1" || bindHostname === "::1" || bindHostname === "localhost";
}

function isUpgradeAuthorized(
  req: import("node:http").IncomingMessage,
  token: string | null | undefined,
  localBypassToken: string | null | undefined,
  bindHostname?: string | null,
): boolean {
  if (!token) return true;
  // T085: when the daemon binds to a loopback interface, the only way to
  // reach `/ws/events` + `/ws/pty/:id` is from the same machine — match the
  // REST `requireAuth` loopback bypass so the localhost dashboard doesn't
  // have to juggle the remote-access token through every URL. Remote-bound
  // daemons (0.0.0.0 / explicit hostnames) still enforce the token even on
  // loopback because the operator has explicitly opted into remote access.
  if (isLoopbackBind(bindHostname) && isLoopbackRequest(req)) return true;
  const supplied = requestToken(req);
  return supplied === token || (localBypassToken != null && supplied === localBypassToken);
}

function rejectUpgradeWithPolicy(
  wss: WebSocketServer,
  req: import("node:http").IncomingMessage,
  socket: Socket,
  head: Buffer,
): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.close(1008, "Remote access token required");
  });
}

function attachWebSockets(
  server: Server,
  opts: {
    authToken?: string | null;
    localBypassToken?: string | null;
    bindHostname?: string | null;
  } = {},
): {
  closeClients: () => void;
  closeServers: () => Promise<void>;
} {
  const eventsWss = new WebSocketServer({ noServer: true });
  const ptyWss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  const track = (ws: WebSocket): void => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  };

  const upgradeListener = (
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    if (
      (pathname === "/ws/events" || pathname.startsWith("/ws/pty/")) &&
      !isUpgradeAuthorized(req, opts.authToken, opts.localBypassToken, opts.bindHostname)
    ) {
      rejectUpgradeWithPolicy(pathname === "/ws/events" ? eventsWss : ptyWss, req, socket, head);
      return;
    }

    if (pathname === "/ws/events") {
      eventsWss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        handleWsEventsConnection(ws);
      });
      return;
    }

    const ptyMatch = pathname.match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      const id = decodeURIComponent(ptyMatch[1]!);
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        handlePtyWebSocket(ws, id);
      });
      return;
    }
  };

  server.on("upgrade", upgradeListener);

  return {
    closeClients: () => {
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          closeWsGoingAway(ws);
        }
      }
    },
    closeServers: async () => {
      server.off("upgrade", upgradeListener);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
          ws.terminate();
        }
      }
      const closeWss = (wss: WebSocketServer) =>
        Promise.race([new Promise<void>((resolve) => wss.close(() => resolve())), delay(100)]);
      await Promise.all([closeWss(eventsWss), closeWss(ptyWss)]);
    },
  };
}

function waitForServerClose(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateLocalBypassToken(): string {
  return randomBytes(32).toString("base64url");
}

function probeHostname(bindHostname: string): string {
  return bindHostname === "0.0.0.0" ? "127.0.0.1" : bindHostname;
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

async function healthGone(port: number, bindHostname: string): Promise<boolean> {
  try {
    const res = await fetch(`http://${probeHostname(bindHostname)}:${port}/health`, {
      signal: timeoutSignal(500),
    });
    return !res.ok;
  } catch {
    return true;
  }
}

async function requestDaemonShutdown(port: number, bindHostname: string): Promise<void> {
  try {
    await fetch(`http://${probeHostname(bindHostname)}:${port}/api/v2/action/daemon.shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "takeover" }),
      signal: timeoutSignal(1_000),
    });
  } catch {
    // The existing daemon may predate the action or be mid-shutdown. Polling
    // and the final PID kill below handle both cases.
  }
}

async function takeoverCanonicalDaemon(info: {
  pid: number;
  port: number;
  bindHostname: string;
}): Promise<void> {
  await requestDaemonShutdown(info.port, info.bindHostname);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = readCanonicalDaemonInfo();
    const fileGone = !current || current.pid !== info.pid || current.port !== info.port;
    const serverGone = await healthGone(info.port, info.bindHostname);
    if (fileGone && serverGone) return;
    await delay(150);
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // Already gone or not ours.
  }
  await delay(500);
  try {
    process.kill(info.pid, "SIGKILL");
  } catch {
    // Already gone or not ours.
  }
  clearCanonicalDaemonInfo();
}

function closeWsGoingAway(ws: WebSocket): void {
  const reason = Buffer.from("going away");
  const payload = Buffer.allocUnsafe(2 + reason.length);
  payload.writeUInt16BE(1001, 0);
  reason.copy(payload, 2);
  const frame = Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
  const socket = (ws as unknown as { _socket?: Socket })._socket;
  if (socket && !socket.destroyed && socket.writable) {
    socket.end(frame);
    return;
  }
  ws.close(1001, reason);
}

async function startHttpServer({
  sessionName,
  requestedPort,
  bindHostname,
  dir,
  authToken,
  localBypassToken,
  silent,
}: {
  sessionName: string;
  requestedPort: number;
  bindHostname: string;
  dir: string;
  authToken?: string | null;
  localBypassToken?: string | null;
  silent?: boolean;
}): Promise<{
  server: Server;
  sockets: Set<Socket>;
  closeClients: () => void;
  closeWsServers: () => Promise<void>;
}> {
  const { createApp } = await import("../command-center/server.ts");
  const { getRequestListener } = await import(requireFromHere.resolve("@hono/node-server"));
  const { AuthService } = await import("./auth/auth-service.ts");
  const { AuthConfigSchema } = await import("./auth/types.ts");
  const { TunnelManager } = await import("./tunnels/manager.ts");
  const { RemoteRegistry } = await import("./hq/registry.ts");
  const { HQConfigSchema } = await import("./hq/types.ts");

  let authConfig = AuthConfigSchema.parse({});
  let tunnelConfig: Record<string, unknown> | undefined;
  let hqConfig: ReturnType<typeof HQConfigSchema.parse> | undefined;
  try {
    const { readConfig } = await import("./yaml-io.ts");
    const { config } = readConfig(dir);
    if (config.auth) authConfig = AuthConfigSchema.parse(config.auth);
    if (config.tunnel) tunnelConfig = config.tunnel as Record<string, unknown>;
    if (config.hq) hqConfig = HQConfigSchema.parse(config.hq);
  } catch {
    // Config not readable — use defaults.
  }

  const authService = new AuthService(authConfig.secret);
  const tunnelManager = new TunnelManager({ session: sessionName, dir });
  let registryShuttingDown = false;
  const remoteRegistry =
    hqConfig?.enabled && hqConfig.role === "hq"
      ? new RemoteRegistry({
          healthInterval: hqConfig.heartbeat_interval,
          isShuttingDown: () => registryShuttingDown,
        })
      : undefined;

  const { hostname: osHostname } = await import("node:os");
  const app = createApp({
    authService,
    authConfig,
    tunnelManager,
    remoteRegistry,
    hqMachineName: hqConfig?.machine_name ?? osHostname(),
    remoteAccess: {
      bindHostname,
      token: authToken ?? null,
      localBypassToken: localBypassToken ?? null,
    },
  });
  app.get("/api/daemon/health", (c: { json: (body: unknown, status?: number) => Response }) => {
    const health = getTaskStoreHealth();
    return c.json({ ...health, ok: health.ok, session: sessionName });
  });

  const server = createServer(getRequestListener(app.fetch));
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const { closeClients, closeServers: closeWsServers } = attachWebSockets(server, {
    authToken,
    localBypassToken,
    bindHostname,
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new DaemonStartupError(`Port ${requestedPort} is already in use`, "port_in_use", {
            cause: err,
          }),
        );
      } else {
        reject(
          new DaemonStartupError(`Failed to bind daemon on port ${requestedPort}`, "bind_failed", {
            cause: err,
          }),
        );
      }
    };
    const onListening = () => {
      server.off("error", onError);
      if (!silent) {
        console.log(
          `[daemon] Command Center on http://${bindHostname}:${requestedPort} (session: ${sessionName})`,
        );
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(requestedPort, bindHostname);
  });

  if (remoteRegistry) {
    console.log("[daemon] HQ registry started");
  }

  if (tunnelConfig?.auto_start) {
    try {
      const { tunnelConfigSchema } = await import("./tunnels/types.ts");
      const parsed = tunnelConfigSchema.parse({
        ...tunnelConfig,
        port: tunnelConfig.port ?? requestedPort,
      });
      await tunnelManager.start(parsed);
      console.log("[daemon] Tunnel auto-started");
    } catch (err) {
      console.error("[daemon] Tunnel auto-start failed:", err);
    }
  }

  let hqClient:
    | { register: () => Promise<void>; destroy: () => Promise<void>; getName: () => string }
    | undefined;
  if (hqConfig?.enabled && hqConfig.role === "remote" && hqConfig.hq_url) {
    try {
      const { HQClient } = await import("./hq/client.ts");
      const os = await import("node:os");
      hqClient = new HQClient({
        hqUrl: hqConfig.hq_url,
        secret: hqConfig.secret ?? "",
        machineName: hqConfig.machine_name ?? os.hostname(),
        remoteUrl: `http://${bindHostname}:${requestedPort}`,
        heartbeatInterval: hqConfig.heartbeat_interval,
      });
      await hqClient.register();
      console.log(`[daemon] Registered with HQ as ${hqClient.getName()}`);
    } catch (err) {
      console.error("[daemon] HQ client registration failed:", err);
    }
  }

  const originalCloseClients = closeClients;
  const originalCloseWsServers = closeWsServers;
  return {
    server,
    sockets,
    closeClients: originalCloseClients,
    closeWsServers: async () => {
      registryShuttingDown = true;
      remoteRegistry?.destroy();
      if (hqClient) await hqClient.destroy();
      await originalCloseWsServers();
    },
  };
}

export async function startEmbeddedDaemon(
  opts: EmbeddedDaemonOptions,
): Promise<EmbeddedDaemonHandle> {
  const sessionName = opts.sessionName ?? EMBEDDED_SESSION_NAME;
  const sessionless = opts.sessionName == null;
  const appSettings = readAppSettings();
  const persistedRemoteAccess =
    appSettings.remoteAccess.enabled && appSettings.remoteAccess.token
      ? appSettings.remoteAccess
      : null;
  const bindHostname =
    opts.bindHostname ?? opts.hostname ?? (persistedRemoteAccess ? "0.0.0.0" : DEFAULT_HOSTNAME);
  const authToken = opts.authToken ?? persistedRemoteAccess?.token ?? null;
  const localBypassToken = opts.localBypassToken ?? generateLocalBypassToken();
  const existingCanonical = readCanonicalDaemonInfo();
  if (existingCanonical) {
    if (await isCanonicalDaemonAlive(existingCanonical)) {
      if (opts.takeoverIfRunning) {
        await takeoverCanonicalDaemon(existingCanonical);
      } else {
        throw new DaemonStartupError(
          `Canonical daemon is already running on port ${existingCanonical.port}`,
          "canonical_already_running",
        );
      }
    } else {
      clearCanonicalDaemonInfo();
    }
  }
  if (!sessionless) assertTmuxSession(sessionName);
  const port = opts.port ?? (await pickFreePort(bindHostname));
  validatePort(port);
  const dir = process.cwd();

  // Workspace registry: load + reconcile against live tmux sessions on
  // startup. Backwards-compat: if TMUX_IDE_SESSION is set, auto-add it as
  // a workspace so legacy single-session callers (pre-T068) keep working.
  // The registry is the source of truth for /api/project/:name lookups.
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  await workspaceRegistry.load();
  const legacySession = process.env.TMUX_IDE_SESSION;
  if (legacySession && !workspaceRegistry.has(legacySession)) {
    try {
      workspaceRegistry.add({
        name: legacySession,
        sessionName: legacySession,
        projectDir: dir,
      });
    } catch {
      // Already added or persistence failed; non-fatal.
    }
  }
  // Also register the explicit sessionName when the daemon is launched
  // against a specific tmux session (e.g. `node daemon.ts new-name 6060`).
  // Without this the operator has to POST /api/workspaces by hand before
  // /api/sessions / /api/project/:name return anything — which was the
  // dashboard's "terminal not connecting" symptom before this fix.
  if (
    !sessionless &&
    sessionName !== EMBEDDED_SESSION_NAME &&
    !workspaceRegistry.has(sessionName)
  ) {
    try {
      workspaceRegistry.add({
        name: sessionName,
        sessionName,
        projectDir: dir,
      });
    } catch {
      // Already added or persistence failed; non-fatal.
    }
  }
  const orchestratorStarter = opts.orchestratorStarter ?? startOrchestrator;

  const { server, sockets, closeClients, closeWsServers } = await startHttpServer({
    sessionName,
    requestedPort: port,
    bindHostname,
    dir,
    authToken,
    localBypassToken,
    silent: opts.silent,
  });
  const pkg = requireFromHere("../../package.json") as { version?: string };
  writeCanonicalDaemonInfo({
    pid: process.pid,
    port,
    version: pkg.version ?? "0.0.0",
    startedAt: new Date().toISOString(),
    bindHostname,
    authToken,
  });

  let stopRootTaskStoreWatcher: (() => Promise<void>) | null = null;
  let rootReconcileInterval: ReturnType<typeof setInterval> | null = null;
  let stopRootOrchestrator: (() => void) | null = null;

  if (!sessionless) {
    replayTaskStoreWal(dir);
    stopRootOrchestrator = await orchestratorStarter(sessionName, dir);
    stopRootTaskStoreWatcher = startTaskStoreWatcher(dir);
    rootReconcileInterval = setInterval(() => {
      reconcileTaskStore(dir);
    }, RECONCILE_INTERVAL_MS);
    reconcileTaskStore(dir);
  }

  let lastState = "";
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let stopSelf: (() => void) | null = null;
  const activeProjectStops = new Map<string, { stop: () => void; orchestrated: boolean }>();

  const activateProjectOnDaemon = async (
    projectName: string,
    options: ProjectActivationOptions = {},
  ): Promise<{ stop: () => Promise<void> }> => {
    const existing = activeProjectStops.get(projectName);
    if (existing) {
      if (options.orchestrate && !existing.orchestrated) {
        const project = getProject(projectName);
        if (project && existsSync(join(project.dir, "ide.yml"))) {
          existing.stop = await orchestratorStarter(project.name, project.dir);
          existing.orchestrated = true;
        }
      }
      return {
        stop: async () => {
          existing.stop();
        },
      };
    }

    const project = getProject(projectName);
    if (!project) {
      // Live-session-only projects (e.g. tmux sessions the user spawned
      // outside the registry) don't have an ide.yml and can't be
      // orchestrated, but they MUST still be openable from the
      // dashboard's Terminal leaf. Treat activation as a no-op for
      // unregistered names rather than throwing — `resolveProject`
      // already accepted them, so `project.openTerminal` and friends
      // can proceed. The orchestrator only runs for registered
      // projects with an ide.yml.
      activeProjectStops.set(projectName, { stop: () => undefined, orchestrated: false });
      return {
        stop: async () => {
          const current = activeProjectStops.get(projectName);
          if (!current) return;
          activeProjectStops.delete(projectName);
          current.stop();
        },
      };
    }

    const shouldOrchestrate =
      options.orchestrate === true && existsSync(join(project.dir, "ide.yml"));
    const stopOrchestrator = shouldOrchestrate
      ? await orchestratorStarter(project.name, project.dir)
      : () => undefined;
    activeProjectStops.set(project.name, {
      stop: stopOrchestrator,
      orchestrated: shouldOrchestrate,
    });

    return {
      stop: async () => {
        const current = activeProjectStops.get(project.name);
        if (!current) return;
        activeProjectStops.delete(project.name);
        current.stop();
      },
    };
  };

  setActivationBackend({
    activateProject: async (name, options) => {
      await activateProjectOnDaemon(name, options);
    },
    deactivateProject: async (name) => {
      const stop = activeProjectStops.get(name);
      if (!stop) return;
      activeProjectStops.delete(name);
      stop.stop();
    },
  });

  const tick = (): void => {
    if (sessionless) return;
    const session = sessionExists(sessionName);
    if (session === "no") {
      stopSelf?.();
      return;
    }
    if (session === "unknown") {
      // Transient spawn failure — skip this tick rather than self-destruct.
      return;
    }
    if (!hasClients()) return;

    const panes = listPanes(sessionName);
    if (panes.length === 0) return;

    const portPanes = computePortPanes(panes);
    const agentStates = computeAgentStates(panes);
    const stateKey = panes
      .map((pane) => {
        const portState = portPanes.has(pane.id) ? "1" : "0";
        const agent = agentStates.get(pane.id) ?? "-";
        const titleDrift = pane.name && pane.title !== pane.name ? "d" : "ok";
        return `${pane.id}:${portState}:${agent}:${titleDrift}`;
      })
      .join("|");

    if (stateKey === lastState) return;

    for (const pane of panes) {
      const hasPort = portPanes.has(pane.id) ? "1" : "0";
      const agent = agentStates.get(pane.id);
      tmuxSilent("set-option", "-pqt", pane.id, "@has_port", hasPort);
      tmuxSilent("set-option", "-pqt", pane.id, "@agent_busy", agent === "busy" ? "1" : "0");
      tmuxSilent("set-option", "-pqt", pane.id, "@agent_idle", agent === "idle" ? "1" : "0");
      if (pane.name && pane.title !== pane.name) {
        tmuxSilent("select-pane", "-t", pane.id, "-T", pane.name);
      }
    }

    tmuxSilent("refresh-client", "-S");
    lastState = stateKey;
  };

  const monitorInterval = setInterval(tick, MONITOR_INTERVAL_MS);

  const apiBaseUrl = `http://${bindHostname}:${port}`;
  const wsUrl = `ws://${bindHostname}:${port}/ws/events`;

  const handle: EmbeddedDaemonHandle = {
    port,
    apiBaseUrl,
    wsUrl,
    localBypassToken,
    stop: async ({ gracefulMs = DEFAULT_GRACEFUL_MS } = {}) => {
      if (stopped) return;
      if (stopping) return stopping;
      stopping = (async () => {
        try {
          stopped = true;
          setActivationBackend(null);
          clearInterval(monitorInterval);
          if (rootReconcileInterval) clearInterval(rootReconcileInterval);

          const closePromise = waitForServerClose(server);
          closeClients();
          for (const stop of activeProjectStops.values()) {
            stop.stop();
          }
          activeProjectStops.clear();
          stopRootOrchestrator?.();
          await shutdownDefaultChatRuntime();
          shutdownPtyBridges();
          await Promise.race([closePromise, delay(gracefulMs)]);
          for (const socket of sockets) socket.destroy();
          await Promise.race([closePromise.catch(() => undefined), delay(100)]);
          await closeWsServers();
          if (stopRootTaskStoreWatcher) await stopRootTaskStoreWatcher();
          flushPendingTaskStore();
          setRemoteAccessRestartBackend(null);
          setDaemonShutdownBackend(null);
        } catch (err) {
          throw new DaemonShutdownError("Daemon shutdown failed", { cause: err as Error });
        } finally {
          clearCanonicalDaemonInfo();
        }
      })();
      return stopping;
    },
    activateProject: activateProjectOnDaemon,
  };
  setDaemonShutdownBackend(async () => {
    await handle.stop({ gracefulMs: 500 });
  });
  setRemoteAccessRestartBackend((request) => {
    setTimeout(() => {
      void (async () => {
        const restartPort = request.port ?? port;
        try {
          await handle.stop({ gracefulMs: 500 });
        } catch (err) {
          console.error("[daemon] Remote access stop before restart failed:", err);
        } finally {
          clearCanonicalDaemonInfo();
        }

        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const nextHandle = await startEmbeddedDaemon({
              sessionName: sessionless ? undefined : sessionName,
              port: restartPort,
              bindHostname: request.bindHostname,
              authToken: request.token,
              localBypassToken,
              orchestratorStarter,
            });
            const mutableHandle = handle as {
              stop: EmbeddedDaemonHandle["stop"];
              activateProject: EmbeddedDaemonHandle["activateProject"];
            };
            mutableHandle.stop = nextHandle.stop;
            mutableHandle.activateProject = nextHandle.activateProject;
            return;
          } catch (err) {
            if (
              err instanceof DaemonStartupError &&
              err.reason === "port_in_use" &&
              attempt === 0
            ) {
              await delay(150);
              continue;
            }
            throw err;
          }
        }
      })().catch((err) => {
        console.error("[daemon] Remote access restart failed:", err);
        clearCanonicalDaemonInfo();
      });
    }, 50).unref?.();
    return { port };
  });
  stopSelf = () => void handle.stop();
  tick();

  return handle;
}
