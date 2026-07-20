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
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { computeAgentStates, computePortPanes } from "./session-monitor.ts";
import { DaemonShutdownError, DaemonStartupError } from "./errors.ts";
import { handlePtyWebSocket, shutdownPtyBridges } from "../server/ws-route.ts";
import { handleWsEventsConnection } from "../command-center/ws-events.ts";
import { setRemoteAccessRestartBackend } from "../command-center/actions/handlers/app-set-remote-access.ts";
import { setDaemonShutdownBackend } from "../command-center/actions/handlers/daemon-shutdown.ts";
import { readAppSettings } from "./app-settings.ts";
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
const EMBEDDED_SESSION_NAME = "__embedded__";

export interface EmbeddedDaemonOptions {
  sessionName?: string;
  port?: number;
  bindHostname?: string;
  authToken?: string | null;
  localBypassToken?: string | null;
  takeoverIfRunning?: boolean;
  silent?: boolean;
  /** Diagnostic product version advertised by daemon.json. */
  productVersion?: string;
  /** @deprecated Use bindHostname. */
  hostname?: string;
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
  readProjectAuth,
}: {
  sessionName: string;
  requestedPort: number;
  bindHostname: string;
  dir: string;
  authToken?: string | null;
  localBypassToken?: string | null;
  silent?: boolean;
  readProjectAuth?: boolean;
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

  let authConfig = AuthConfigSchema.parse({});
  if (readProjectAuth !== false) {
    try {
      const { resolveConfig } = await import("./resolved-config.ts");
      const { launchConfig } = await resolveConfig(dir);
      if (launchConfig?.auth) authConfig = AuthConfigSchema.parse(launchConfig.auth);
    } catch {
      // Config not readable — use defaults.
    }
  }

  const authService = new AuthService(authConfig.secret);

  const app = createApp({
    authService,
    authConfig,
    remoteAccess: {
      bindHostname,
      token: authToken ?? null,
      localBypassToken: localBypassToken ?? null,
    },
  });
  app.get("/api/daemon/health", (c: { json: (body: unknown, status?: number) => Response }) => {
    return c.json({ ok: true, session: sessionName });
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

  return {
    server,
    sockets,
    closeClients,
    closeWsServers,
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
  // Explicit null means "no auth". This is important for the native app's
  // loopback-only `tmux-ide --headless` child: persisted remote-access settings
  // must not silently change the process contract it requested.
  const authToken = Object.prototype.hasOwnProperty.call(opts, "authToken")
    ? (opts.authToken ?? null)
    : (persistedRemoteAccess?.token ?? null);
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
  const { server, sockets, closeClients, closeWsServers } = await startHttpServer({
    sessionName,
    requestedPort: port,
    bindHostname,
    dir,
    authToken,
    localBypassToken,
    silent: opts.silent,
    readProjectAuth: !sessionless,
  });
  // The shipped root CLI is an esbuild bundle, so import.meta.url points at
  // bin/cli.js and the daemon package's relative package.json does not exist.
  // Process hosts pass their product version explicitly; standalone embedders
  // retain the package-local fallback.
  const productVersion =
    opts.productVersion ??
    (requireFromHere("../../package.json") as { version?: string }).version ??
    "0.0.0";
  writeCanonicalDaemonInfo({
    pid: process.pid,
    port,
    version: productVersion,
    startedAt: new Date().toISOString(),
    bindHostname,
    authToken,
  });

  let lastState = "";
  let stopped = false;
  let stopping: Promise<void> | null = null;
  let stopSelf: (() => void) | null = null;
  const activeProjectStops = new Map<string, { stop: () => void }>();

  // Track active projects so the session-control surface can open/close
  // them. Orchestration moved out of tmux-ide (agent coordination lives in
  // sfora.ai), so activation is now bookkeeping only.
  const activateProjectOnDaemon = async (
    projectName: string,
    _options: ProjectActivationOptions = {},
  ): Promise<{ stop: () => Promise<void> }> => {
    if (!activeProjectStops.has(projectName)) {
      activeProjectStops.set(projectName, { stop: () => undefined });
    }
    return {
      stop: async () => {
        const current = activeProjectStops.get(projectName);
        if (!current) return;
        activeProjectStops.delete(projectName);
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

          const closePromise = waitForServerClose(server);
          closeClients();
          for (const stop of activeProjectStops.values()) {
            stop.stop();
          }
          activeProjectStops.clear();
          shutdownPtyBridges();
          await Promise.race([closePromise, delay(gracefulMs)]);
          for (const socket of sockets) socket.destroy();
          await Promise.race([closePromise.catch(() => undefined), delay(100)]);
          await closeWsServers();
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
