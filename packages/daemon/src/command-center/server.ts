import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import {
  discoverSessions,
  buildOverviews,
  buildProjectDetail,
  type SessionOverview,
} from "./discovery.ts";
import {
  listSessionPanes,
  sendCommand,
  sendEnterToPane,
  sendLiteralToPane,
  sendText,
  getPaneBusyStatus,
} from "../widgets/lib/pane-comms.ts";
import { resolvePane } from "../send.ts";
import { getSessionState, killSession, stopSessionMonitor } from "@tmux-ide/tmux-bridge";
import { writeConfig } from "../lib/yaml-io.ts";
import { resolveConfig } from "../lib/resolved-config.ts";
import { resolveProjectConfigContext } from "../lib/config-context.ts";
import { IdeConfigSchema } from "../schemas/ide-config.ts";
import { getLogBuffer, subscribeLogs, type LogEntry } from "../lib/log.ts";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  getDefaultWorkspaceRegistry,
  WorkspaceAlreadyExistsError,
  WorkspaceNotFoundError,
} from "../lib/workspace-registry.ts";
import {
  AddWorkspaceRequestSchemaZ,
  APPLICATION_SHELL_RESOURCE_VERSION,
  WORKSPACE_CATALOG_RESOURCE_VERSION,
  DAEMON_WIRE_PROTOCOL_VERSION,
  DaemonInstanceIdentitySchemaZ,
  type ApplicationShellResourceV1,
  type WorkspaceCatalogResourceV1,
  type DaemonInstanceIdentity,
  type DaemonPanesResponse,
  type DaemonProjectResponse,
  type DaemonProjectsResponse,
  type DaemonProjectTemplatesResponse,
  type DaemonRegisteredProjectResponse,
  type DaemonSessionsResponse,
  type DaemonWorkspaceResponse,
  type DaemonWorkspacesResponse,
} from "@tmux-ide/contracts";
import { sendCommandSchema } from "./schemas.ts";
import {
  createScriptTerminalId,
  terminalCreateRequestSchema,
  terminalRenameRequestSchema,
  type Terminal,
  type TerminalListResponse,
  type TerminalRuntime,
} from "@tmux-ide/contracts";
import {
  deleteTerminal as deleteTerminalRecord,
  loadTerminals,
  renameTerminal as renameTerminalRecord,
  upsertTerminal as upsertTerminalRecord,
} from "../lib/terminals-store.ts";
import { defaultPtyBridgeRegistry } from "../server/ws-route.ts";
import { broadcastTerminalsChanged } from "./ws-events.ts";
import { AuthService } from "../lib/auth/auth-service.ts";
import { authMiddleware } from "../lib/auth/middleware.ts";
import type { AuthConfig } from "../lib/auth/types.ts";
import { handleWsEventsConnection, broadcastInitOutput, broadcastInitError } from "./ws-events.ts";
import { createActionDispatcher } from "./actions/dispatcher.ts";
import {
  listProjects,
  getProject,
  registerProject,
  unregisterProject,
  refreshProject,
  ProjectAlreadyRegisteredError,
  ProjectDirNotFoundError,
  ProjectNotFoundError,
} from "../lib/project-registry.ts";
import {
  runInit,
  ProjectInitFailedError,
  ProjectInitTimeoutError,
} from "../lib/project-init-runner.ts";
import {
  RegisterProjectRequestSchemaZ,
  InitProjectRequestSchemaZ,
  type ProjectTemplate,
} from "../schemas/registry.ts";
import { OnboardProjectRequestSchemaZ } from "../schemas/inspect.ts";
import { SandboxViolationError, assertInsideSandbox } from "../lib/filesystem-browser.ts";
import { inspectProject, InspectDirNotFoundError } from "../lib/project-inspect.ts";
import {
  composeIdeYmlConfig,
  assertNoExistingIdeYml,
  OnboardConflictError,
  OnboardInvalidInputError,
} from "../lib/project-onboard.ts";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { projectApplicationShellResource } from "./resources/application-shell.ts";
export interface CreateAppOptions {
  authService?: AuthService;
  authConfig?: AuthConfig;
  remoteAccess?: {
    bindHostname?: string;
    token?: string | null;
    localBypassToken?: string | null;
    /** Private owner-only capability. This is never the remote access token. */
    ownerToken?: string | null;
  };
  daemonIdentity?: {
    productVersion: string;
    instanceId: string;
    startedAt: string;
  };
  workspacePaneCreationBackend?: import("./actions/handlers/workspace-pane-create.ts").WorkspacePaneCreationBackend;
}

let projectStreamConnections = 0;

function bearerToken(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
}

function requireAuth(token: string | null, localBypassToken: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return next();
    const url = new URL(c.req.url);
    const suppliedToken =
      bearerToken(c.req.header("Authorization")) ?? url.searchParams.get("token");
    if (suppliedToken === token || (localBypassToken && suppliedToken === localBypassToken)) {
      return next();
    }
    return c.json({ error: "Remote access token required" }, 401);
  };
}

function requireHostCapability(ownerToken: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.param("name") !== "workspace.pane.create") return next();
    if (!ownerToken) {
      return c.json({ error: "Host mutation capability is unavailable" }, 503);
    }
    const supplied = bearerToken(c.req.header("Authorization"));
    if (!supplied || supplied !== ownerToken) {
      return c.json({ error: "Host mutation capability required" }, 401);
    }
    if (!z.uuid().safeParse(c.req.header("X-Tmux-Ide-Operation-Id")).success) {
      return c.json({ error: "A stable host operation id is required" }, 400);
    }
    return next();
  };
}

function remoteAccessAuth(options: CreateAppOptions): {
  token: string | null;
  localBypassToken: string | null;
} {
  const bindHostname = options.remoteAccess?.bindHostname ?? "127.0.0.1";
  const loopback =
    bindHostname === "127.0.0.1" || bindHostname === "::1" || bindHostname === "localhost";
  return {
    token: loopback ? null : (options.remoteAccess?.token ?? null),
    localBypassToken: options.remoteAccess?.localBypassToken ?? null,
  };
}

const sseMetrics = {
  connections: 0,
  messagesSent: 0,
};

export function getSseMetrics(): { connections: number; messagesSent: number } {
  return { ...sseMetrics };
}

/**
 * Resolve a BottomPanel Output-tab channel id to a `LogEntry` predicate.
 * Channels are simple component-prefix filters over the single in-process
 * structured logger. Returns `null` for unknown channels (handler emits
 * 404). Add new channels here when adding new log components.
 */
function matchLogChannel(channel: string): ((entry: LogEntry) => boolean) | null {
  switch (channel) {
    case "daemon":
      return () => true;
    case "hq":
      return (entry) => entry.component.startsWith("hq") || entry.component.startsWith("remote");
    case "watchdog":
      return (entry) => entry.component.startsWith("watchdog");
    default:
      return null;
  }
}

function freezePayload<T>(payload: T): T {
  if (payload && typeof payload === "object") {
    for (const value of Object.values(payload as Record<string, unknown>)) {
      freezePayload(value);
    }
    Object.freeze(payload);
  }
  return payload;
}

type DiscoveredSession = ReturnType<typeof discoverSessions>[number];

function buildProjectStreamSnapshot(session: DiscoveredSession) {
  return {
    project: buildProjectDetail(session),
  };
}

/**
 * Resolve a user-supplied directory to a canonical absolute path and verify
 * it lives inside the filesystem-browser sandbox. Used by `/api/filesystem/
 * inspect` and `/api/projects/onboard` so unregistered directories get the
 * same protection as the directory browser. Returns either the canonical
 * path or a structured error suitable for `c.json`.
 *
 * Tilde-expansion mirrors `/api/filesystem/browse`: `~` and `~/sub` map to
 * `homedir()`. The sandbox roots are owned by `assertInsideSandbox`.
 */
type SandboxResolveOk = { canonical: string };
type SandboxResolveErr = {
  error: "invalid-path" | "not-found" | "outside-sandbox";
  message: string;
  status: 400 | 403 | 404;
};
function sandboxResolveDir(rawDir: string): SandboxResolveOk | SandboxResolveErr {
  const trimmed = rawDir.trim();
  if (!trimmed) return { error: "invalid-path", message: "Path must not be empty", status: 400 };
  if (trimmed.includes("\0")) {
    return { error: "invalid-path", message: "Path contains a null byte", status: 400 };
  }
  const home =
    process.env.TMUX_IDE_HOME_OVERRIDE && process.env.TMUX_IDE_HOME_OVERRIDE.trim().length > 0
      ? process.env.TMUX_IDE_HOME_OVERRIDE
      : homedir();
  let candidate = trimmed;
  if (candidate === "~") {
    candidate = home;
  } else if (candidate.startsWith("~/")) {
    candidate = `${home.replace(/\/+$/, "")}/${candidate.slice(2)}`;
  }
  if (!isAbsolute(candidate)) {
    return { error: "invalid-path", message: "Path must be absolute", status: 400 };
  }
  const resolved = pathResolve(candidate);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return {
        error: "not-found",
        message: `Path "${resolved}" does not exist`,
        status: 404,
      };
    }
    throw err;
  }
  try {
    assertInsideSandbox(canonical, home);
  } catch (err) {
    if (err instanceof SandboxViolationError) {
      return { error: "outside-sandbox", message: err.message, status: 403 };
    }
    throw err;
  }
  return { canonical };
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const authConfig: AuthConfig = options.authConfig ?? { method: "none", token_expiry: 86400 };
  const authService = options.authService ?? new AuthService();
  const daemonIdentity = options.daemonIdentity ?? {
    productVersion: "0.0.0",
    instanceId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const daemonInstanceIdentity = DaemonInstanceIdentitySchemaZ.parse({
    protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
    ...daemonIdentity,
  });
  const healthBootedAt = Date.now();

  const app = new Hono();

  // Allow cross-origin (Next.js dashboard, Tailscale, etc.)
  app.use("/*", cors());

  // Remote access bearer gate. Local Electron access uses a per-daemon
  // bypass token from preload; loopback IPs are not implicitly trusted.
  const remoteAuth = remoteAccessAuth(options);
  app.use("/api/*", requireAuth(remoteAuth.token, remoteAuth.localBypassToken));

  // Auth middleware — passes through when method is "none"
  app.use("/*", authMiddleware(authService, authConfig));

  // Global error handler
  app.onError((err, c) => {
    console.error("[command-center]", err.message);
    return c.json({ error: err.message }, 500);
  });

  // --- Auth routes (always available, bypassed by middleware) ---

  app.post("/api/auth/challenge", async (c) => {
    const body = await c.req.json();
    const userId = body.userId ?? authService.getCurrentUser();
    const challenge = authService.createChallenge(userId);
    return c.json(challenge);
  });

  app.post("/api/auth/verify", async (c) => {
    const body = await c.req.json();
    const result = await authService.authenticateWithSSHKey({
      publicKey: body.publicKey,
      signature: body.signature,
      challengeId: body.challengeId,
    });
    if (!result.success) {
      return c.json({ error: result.error }, 401);
    }
    return c.json({ token: result.token, userId: result.userId });
  });

  app.post("/api/auth/token", async (c) => {
    if (authConfig.method !== "none") {
      return c.json({ error: "Direct token generation requires auth method 'none'" }, 403);
    }
    const body = await c.req.json();
    const userId = body.userId ?? authService.getCurrentUser();
    const token = authService.generateToken(userId);
    return c.json({ token, userId });
  });

  // --- v2 action dispatcher (single typed entry-point for state-changing
  //     project / terminal operations — see src/command-center/actions/) ---

  app.post(
    "/api/v2/action/:name",
    requireHostCapability(options.remoteAccess?.ownerToken ?? null),
    createActionDispatcher({
      daemonInstanceId: daemonIdentity.instanceId,
      workspacePaneCreationBackend: options.workspacePaneCreationBackend,
    }),
  );

  app.get("/api/widget/:name/spawn", async (c) => {
    const { resolveWidgetSpawn, WIDGET_TYPES } = await import("../widgets/resolve.ts");
    const name = c.req.param("name");
    if (!WIDGET_TYPES.includes(name)) {
      return c.json({ error: `unknown widget: ${name}`, available: WIDGET_TYPES }, 404);
    }
    const session = c.req.query("session");
    const dir = c.req.query("dir");
    if (!session || !dir) {
      return c.json({ error: "session and dir query params are required" }, 400);
    }
    const target = c.req.query("target") ?? null;
    const themeRaw = c.req.query("theme");
    let theme: unknown = null;
    if (themeRaw) {
      try {
        theme = JSON.parse(themeRaw);
      } catch {
        return c.json({ error: "theme must be valid JSON" }, 400);
      }
    }
    try {
      const spec = resolveWidgetSpawn(name, {
        session,
        dir,
        target,
        theme: theme as never,
      });
      return c.json(spec);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // T067: /healthz — minimal liveness probe used by daemon-client.
  // Intentionally NOT under /api so it bypasses the auth middleware on
  // every consumer. Returns ok + productVersion + uptime (ms since boot).
  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: daemonIdentity.productVersion,
      uptimeMs: Date.now() - healthBootedAt,
    });
  });

  // Credential-free endpoint binding. A desktop host reads the nonce from the
  // owner-only canonical record, probes this endpoint, and compares before it
  // sends any remote-access or local-bypass credential.
  app.get("/identity", (c) => {
    return c.json({
      ok: true,
      pid: process.pid,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      productVersion: daemonIdentity.productVersion,
      instanceId: daemonIdentity.instanceId,
      startedAt: daemonIdentity.startedAt,
    });
  });

  app.get("/api/sessions", (c) => {
    const sessions = discoverSessions();
    const overviews = buildOverviews(sessions);
    return c.json({ sessions: overviews } satisfies DaemonSessionsResponse);
  });

  // ---------------------------------------------------------------------
  // /api/workspaces — registry-backed CRUD. The registry is the source of
  // truth for which projects the daemon serves. WS frames `workspace.added`
  // and `workspace.removed` are emitted by the registry's emitter, picked
  // up by ws-events' ensureWorkspaceRegistryListener and fanned to clients.
  // ---------------------------------------------------------------------

  app.get("/api/workspaces", (c) => {
    const registry = getDefaultWorkspaceRegistry();
    return c.json({ workspaces: registry.list() } satisfies DaemonWorkspacesResponse);
  });

  app.get("/api/resources/workspace-catalog", (c) => {
    const registry = getDefaultWorkspaceRegistry();
    return c.json({
      version: WORKSPACE_CATALOG_RESOURCE_VERSION,
      daemon: daemonInstanceIdentity,
      workspaces: registry
        .list()
        .map(({ name, sessionName }) => ({ workspaceName: name, sessionName })),
    } satisfies WorkspaceCatalogResourceV1);
  });

  app.get("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    const workspace = registry.get(name);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    return c.json({ workspace } satisfies DaemonWorkspaceResponse);
  });

  app.post("/api/workspaces", zValidator("json", AddWorkspaceRequestSchemaZ), async (c) => {
    const body = c.req.valid("json");
    const registry = getDefaultWorkspaceRegistry();
    const name = body.name ?? basename(body.projectDir);
    if (!name || name.length === 0) {
      return c.json({ error: "Cannot derive workspace name from projectDir" }, 400);
    }
    const facts = await resolveProjectConfigContext(body.projectDir);
    try {
      const workspace = registry.add({
        name,
        sessionName: body.sessionName,
        projectDir: body.projectDir,
        ideConfigPath: body.ideConfigPath ?? facts.ideConfigPath,
        configKind: body.configKind ?? facts.configKind,
        configPath: body.configPath ?? facts.configPath,
        hasWorkspaceConfig: body.hasWorkspaceConfig ?? facts.hasWorkspaceConfig,
      });
      return c.json({ workspace } satisfies DaemonWorkspaceResponse, 201);
    } catch (err) {
      if (err instanceof WorkspaceAlreadyExistsError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  });

  // GET /api/chat/providers — discovery (claude-code / codex binaries on
  // PATH). Distinct from `/api/providers`, which serves the redacted
  // user-configured `ProviderInstanceSummary` set (T079).
  app.delete("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    try {
      registry.remove(name);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof WorkspaceNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });

  app.get("/api/project/:name", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const detail = buildProjectDetail(session);
    return c.json({ ...detail } satisfies DaemonProjectResponse);
  });

  app.get("/api/project/:name/application-shell", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((candidate) => candidate.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({
      version: APPLICATION_SHELL_RESOURCE_VERSION,
      daemon: daemonInstanceIdentity,
      resource: projectApplicationShellResource(session),
    } satisfies ApplicationShellResourceV1);
  });

  app.get("/api/project/:name/panes", (c) => {
    const name = c.req.param("name");
    let panes: ReturnType<typeof listSessionPanes>;
    try {
      panes = listSessionPanes(name);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }
    if (panes.length === 0) {
      // Verify the session actually exists before returning empty
      const sessions = discoverSessions();
      if (!sessions.find((s) => s.name === name)) {
        return c.json({ error: "Session not found" }, 404);
      }
    }
    return c.json({
      panes: panes.map((p) => ({
        id: p.id,
        index: p.index,
        title: p.title,
        currentCommand: p.currentCommand,
        width: p.width,
        height: p.height,
        active: p.active,
        role: p.role,
        name: p.name,
        type: p.type,
      })),
    } satisfies DaemonPanesResponse);
  });

  app.get("/api/project/:name/terminals", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const records = loadTerminals(session.dir);
    const terminals = records.map((t) => {
      const bridge = defaultPtyBridgeRegistry.peek(t.id) as
        | (Parameters<typeof defaultPtyBridgeRegistry.peek>[0] extends never ? never : null)
        | (Record<string, unknown> & {
            running?: boolean;
            cols?: number | null;
            rows?: number | null;
            getReplayBuffer?: () => Buffer;
          })
        | null;
      let runtime: TerminalRuntime = { running: false };
      if (bridge) {
        const cols = typeof bridge.cols === "number" ? bridge.cols : undefined;
        const rows = typeof bridge.rows === "number" ? bridge.rows : undefined;
        const replay =
          typeof bridge.getReplayBuffer === "function"
            ? bridge.getReplayBuffer().byteLength
            : undefined;
        runtime = {
          running: bridge.running !== false,
          ...(cols !== undefined ? { cols } : {}),
          ...(rows !== undefined ? { rows } : {}),
          ...(replay !== undefined ? { replayBytes: replay } : {}),
        };
      }
      return { ...t, runtime };
    });
    return c.json({ terminals } satisfies TerminalListResponse);
  });

  app.post(
    "/api/project/:name/terminals",
    zValidator("json", terminalCreateRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      // Pick the id: explicit > deterministic (when script provided) >
      // UUID. The script-derived id collapse is the load-bearing bit
      // for "two callers asking for the same run-script tab share a
      // bridge + scrollback".
      let id = body.id;
      let scripted = false;
      const kind = body.kind ?? "shell";
      if (!id && body.script) {
        id = await createScriptTerminalId({
          projectId: name,
          scopeId: body.scopeId,
          kind,
          script: body.script,
        });
        scripted = true;
      }
      if (!id) id = randomUUID();
      try {
        const upsertInput: Parameters<typeof upsertTerminalRecord>[1] = {
          id,
          projectId: name,
          scopeId: body.scopeId,
          name: body.name,
          kind,
        };
        if (scripted) upsertInput.scripted = true;
        const record = upsertTerminalRecord(session.dir, upsertInput);
        broadcastTerminalsChanged(name);
        return c.json({ ok: true, terminal: record satisfies Terminal });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  app.post(
    "/api/project/:name/terminals/:id/rename",
    zValidator("json", terminalRenameRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const id = c.req.param("id");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      try {
        const record = renameTerminalRecord(session.dir, id, c.req.valid("json").name);
        if (!record) return c.json({ error: "Terminal not found" }, 404);
        broadcastTerminalsChanged(name);
        return c.json({ ok: true, terminal: record satisfies Terminal });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  app.delete("/api/project/:name/terminals/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const removedRecord = deleteTerminalRecord(session.dir, id);
    // Kill the live bridge too — keep store + registry consistent.
    const killed = defaultPtyBridgeRegistry.delete(id);
    if (!removedRecord && !killed) {
      return c.json({ error: "Terminal not found" }, 404);
    }
    broadcastTerminalsChanged(name);
    return c.json({ ok: true });
  });

  // --- Project event/stream endpoints ---
  // The orchestrator/task event feed moved out of tmux-ide (now in sfora.ai),
  // so these surfaces only carry the live pane/project snapshot.

  app.get("/api/project/:name/events", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ events: [] });
  });

  app.get("/api/project/:name/stream", (c) => {
    const name = c.req.param("name");
    const session = discoverSessions().find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      projectStreamConnections += 1;
      sseMetrics.connections = projectStreamConnections;
      let closed = false;
      let previousSnapshotHash = "";
      let lastPing = Date.now();

      function writeSse(event: string, payload: unknown): void {
        sseMetrics.messagesSent += 1;
        void stream.writeSSE({ event, data: JSON.stringify(freezePayload(payload)) });
      }

      function writeChanges(currentSession: DiscoveredSession): void {
        const snapshot = buildProjectStreamSnapshot(currentSession);
        const snapshotHash = JSON.stringify(snapshot);
        if (snapshotHash !== previousSnapshotHash) {
          writeSse("snapshot", snapshot);
          previousSnapshotHash = snapshotHash;
        }
      }

      try {
        stream.onAbort(() => {
          closed = true;
        });
        writeChanges(session);
        while (!closed) {
          await stream.sleep(250);
          const current = discoverSessions().find((candidate) => candidate.name === name);
          if (!current) break;
          writeChanges(current);
          const now = Date.now();
          if (now - lastPing >= 25_000) {
            writeSse("ping", { at: new Date().toISOString() });
            lastPing = now;
          }
        }
      } finally {
        projectStreamConnections = Math.max(0, projectStreamConnections - 1);
        sseMetrics.connections = projectStreamConnections;
      }
    });
  });

  app.post("/api/project/:name/inject", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const text = (body as { text?: unknown }).text;
    const paneId = (body as { paneId?: unknown }).paneId;
    const sendEnter = (body as { sendEnter?: unknown }).sendEnter;

    if (typeof text !== "string" || text.trim().length === 0) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (paneId !== undefined && (typeof paneId !== "string" || !/^%\d+$/.test(paneId))) {
      return c.json({ error: "paneId must match /^%\\d+$/" }, 400);
    }
    if (sendEnter !== undefined && typeof sendEnter !== "boolean") {
      return c.json({ error: "sendEnter must be a boolean" }, 400);
    }

    const panes = listSessionPanes(name);
    const pane = paneId
      ? panes.find((candidate) => candidate.id === paneId)
      : panes.find((p) => p.active);
    if (!pane) {
      return c.json({ error: "Pane not found" }, 404);
    }

    sendLiteralToPane(name, pane.id, text);
    if (sendEnter) sendEnterToPane(name, pane.id);

    return c.json({ ok: true });
  });

  // Send message to a pane by name/title/role/ID
  app.post("/api/project/:name/send", zValidator("json", sendCommandSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const { target, message, noEnter } = c.req.valid("json");

    const panes = listSessionPanes(name);
    const pane = resolvePane(panes, target);
    if (!pane) {
      const available = panes.map((p) => ({
        id: p.id,
        title: p.title,
        name: p.name,
        role: p.role,
      }));
      return c.json({ error: "Pane not found", target, available }, 404);
    }

    const busyStatus = getPaneBusyStatus(name, pane.id);

    // Collapse multiline for agent panes
    const prepared = busyStatus === "agent" ? message.replace(/\n+/g, " ").trim() : message;

    if (noEnter) {
      sendText(name, pane.id, prepared);
    } else {
      sendCommand(name, pane.id, prepared);
    }

    return c.json({
      ok: true,
      session: name,
      target: {
        paneId: pane.id,
        name: pane.name,
        title: pane.title,
        role: pane.role,
      },
      busyStatus,
    });
  });

  // GET /api/project/:name/config — read parsed workspace config. Used by
  // the v2 Config editor to hydrate the form.
  app.get("/api/project/:name/config", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const resolved = await resolveConfig(session.dir);
      if (!resolved.launchConfig || !resolved.path) {
        return c.json({ error: "Config not found" }, 404);
      }
      return c.json({
        ok: true,
        config: resolved.launchConfig,
        configPath: resolved.path,
        configKind: resolved.kind,
        hasWorkspaceConfig: resolved.kind === "workspace",
        hasIdeYml: resolved.resolution.legacyConfigPath !== null,
        ideConfigPath: resolved.resolution.legacyConfigPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to read workspace config", detail: message }, 500);
    }
  });

  // POST /api/project/:name/config — accept a full IdeConfig payload, validate
  // against IdeConfigSchema, and write to workspace.yml. Returns the persisted
  // config so the client can re-hydrate without a follow-up GET.
  app.post("/api/project/:name/config", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = IdeConfigSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid config", details: parsed.error.issues }, 400);
    }
    try {
      const context = await resolveProjectConfigContext(session.dir);
      const configPath = writeConfig(context.configWriteRoot, parsed.data);
      const resolved = await resolveConfig(session.dir);
      return c.json({
        ok: true,
        config: parsed.data,
        configPath,
        configKind: resolved.kind,
        hasWorkspaceConfig: resolved.kind === "workspace",
        hasIdeYml: resolved.resolution.legacyConfigPath !== null,
        ideConfigPath: resolved.resolution.legacyConfigPath,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to write workspace config", detail: message }, 500);
    }
  });

  // Launch a tmux-ide session (shells out to CLI since launch has complex side effects)
  const execFileAsync = promisify(execFile);

  // POST /api/project/:name/restart — fire `tmux-ide restart` async. The CLI
  // handles stop+launch; this endpoint is fire-and-forget aside from a short
  // 30s timeout so the client can retry on its own.
  app.post("/api/project/:name/restart", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      await execFileAsync("tmux-ide", ["restart", "--json"], {
        cwd: session.dir,
        timeout: 30000,
        env: { ...process.env, TMUX: "" },
      });
      return c.json({ ok: true, session: name, status: "restarted" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Restart failed", detail: message }, 500);
    }
  });

  app.post("/api/project/:name/launch", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Check if already running
    const state = getSessionState(name);
    if (state.running) {
      return c.json({ ok: true, session: name, status: "already_running" });
    }

    try {
      await execFileAsync("tmux-ide", ["--json"], {
        cwd: session.dir,
        timeout: 30000,
        env: { ...process.env, TMUX: "" }, // Clear TMUX to avoid nesting
      });
      return c.json({ ok: true, session: name, status: "launched" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Launch failed", detail: message }, 500);
    }
  });

  // Stop a tmux-ide session
  app.post("/api/project/:name/stop", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const state = getSessionState(name);
    if (!state.running) {
      return c.json({ ok: true, session: name, status: "not_running" });
    }

    stopSessionMonitor(name);
    const result = killSession(name);
    if (result.stopped) {
      return c.json({ ok: true, session: name, status: "stopped" });
    }
    return c.json({ error: "Stop failed", reason: result.reason }, 500);
  });

  // SSE endpoint — cursor-based event streaming with orchestrator state
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      let prevOverviews: SessionOverview[] = [];

      const poll = () => {
        const sessions = discoverSessions();
        const overviews = buildOverviews(sessions);

        const prevNames = new Set(prevOverviews.map((s) => s.name));
        const currNames = new Set(overviews.map((s) => s.name));

        for (const overview of overviews) {
          if (!prevNames.has(overview.name)) {
            stream.writeSSE({ event: "session_added", data: JSON.stringify(overview) });
          }
        }

        for (const prev of prevOverviews) {
          if (!currNames.has(prev.name)) {
            stream.writeSSE({
              event: "session_removed",
              data: JSON.stringify({ name: prev.name }),
            });
          }
        }

        prevOverviews = overviews;
      };

      poll();
      while (true) {
        await stream.sleep(2000);
        poll();
      }
    });
  });

  // ---------------------------------------------------------------------
  // GET /api/logs/:channel — SSE stream of structured logger entries.
  //
  // Channels are filtered views over the single in-process logger:
  //   - "daemon"   → no component filter (all entries)
  //   - "hq"       → component starts with "hq" or "remote"
  //   - "watchdog" → component starts with "watchdog"
  // The dashboard BottomPanel Output tab opens one EventSource per
  // selected channel. Backfill from the in-memory ring buffer is sent
  // first as `event: "backfill"` followed by a `bookmark` event so the
  // client can render history immediately; new entries arrive as
  // `event: "entry"` data.
  // ---------------------------------------------------------------------
  app.get("/api/logs/:channel", (c) => {
    const channel = c.req.param("channel");
    const match = matchLogChannel(channel);
    if (!match) {
      return c.json({ error: `Unknown log channel: ${channel}` }, 404);
    }
    return streamSSE(c, async (stream) => {
      // 1. Backfill from the ring buffer.
      const backfill = getLogBuffer().filter(match);
      for (const entry of backfill) {
        await stream.writeSSE({ event: "entry", data: JSON.stringify(entry) });
      }
      await stream.writeSSE({ event: "bookmark", data: String(backfill.length) });
      // 2. Subscribe to live entries.
      const queue: LogEntry[] = [];
      let cancelled = false;
      const unsub = subscribeLogs((entry) => {
        if (cancelled) return;
        if (match(entry)) queue.push(entry);
      });
      try {
        while (!cancelled) {
          if (queue.length === 0) {
            await stream.sleep(500);
            continue;
          }
          const drained = queue.splice(0, queue.length);
          for (const entry of drained) {
            await stream.writeSSE({ event: "entry", data: JSON.stringify(entry) });
          }
        }
      } finally {
        cancelled = true;
        unsub();
      }
    });
  });

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      protocolVersion: DAEMON_WIRE_PROTOCOL_VERSION,
      uptime: Math.round(process.uptime()),
      productVersion: daemonIdentity.productVersion,
    });
  });

  // --- Project registry ---

  app.get("/api/projects", (c) => {
    return c.json({ projects: listProjects() } satisfies DaemonProjectsResponse);
  });

  app.get("/api/projects/templates", (c) => {
    return c.json({ templates: listAvailableTemplates() } satisfies DaemonProjectTemplatesResponse);
  });

  app.post("/api/projects", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = RegisterProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    try {
      const project = await registerProject({
        dir: parsed.data.dir,
        name: parsed.data.name,
      });
      return c.json({ project } satisfies DaemonRegisteredProjectResponse, 201);
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      if (err instanceof ProjectAlreadyRegisteredError) {
        return c.json({ error: err.message, code: err.code, suggestion: err.suggestion }, 409);
      }
      throw err;
    }
  });

  app.delete("/api/projects/:name", (c) => {
    const name = c.req.param("name");
    try {
      unregisterProject(name);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });

  app.post("/api/projects/:name/probe", async (c) => {
    const name = c.req.param("name");
    if (!getProject(name)) {
      return c.json({ error: `Project "${name}" not found in registry`, code: "NOT_FOUND" }, 404);
    }
    try {
      const project = await refreshProject(name);
      return c.json({ project } satisfies DaemonRegisteredProjectResponse);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      throw err;
    }
  });

  app.post("/api/projects/init", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = InitProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    if (!existsSync(parsed.data.dir)) {
      return c.json({ error: `Directory "${parsed.data.dir}" does not exist` }, 400);
    }

    const jobId = randomUUID();
    const command = process.env.TMUX_IDE_INIT_COMMAND ?? "tmux-ide";

    // Fire-and-forget — runs in the background and streams chunks via WS.
    void (async () => {
      try {
        await runInit({
          cwd: parsed.data.dir,
          template: parsed.data.template,
          command,
          onChunk: (chunk) => {
            broadcastInitOutput(jobId, chunk);
          },
        });
        // Mark stream complete
        broadcastInitOutput(jobId, "", true);

        // Probe + register the freshly-init'd project so it shows up in
        // the registry — also broadcasts `projects.changed`.
        try {
          await registerProject({ dir: parsed.data.dir });
        } catch (err) {
          // Already-registered is benign here; report anything else.
          if (
            !(err instanceof ProjectAlreadyRegisteredError) &&
            !(err instanceof ProjectDirNotFoundError)
          ) {
            broadcastInitError(jobId, (err as Error).message);
          }
        }
      } catch (err) {
        if (err instanceof ProjectInitTimeoutError) {
          broadcastInitError(jobId, err.message);
        } else if (err instanceof ProjectInitFailedError) {
          broadcastInitError(jobId, err.message);
        } else {
          broadcastInitError(jobId, (err as Error).message);
        }
      }
    })();

    return c.json({ jobId }, 202);
  });

  // -------------------------------------------------------------------------
  // POST /api/filesystem/inspect — registry-agnostic directory inspection.
  // POST /api/projects/onboard   — generate workspace.yml + register the project.
  // -------------------------------------------------------------------------

  app.post("/api/projects/onboard", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = OnboardProjectRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: parsed.error.issues }, 400);
    }
    const sandboxResult = sandboxResolveDir(parsed.data.dir);
    if ("error" in sandboxResult) {
      return c.json(
        { error: sandboxResult.error, message: sandboxResult.message },
        sandboxResult.status,
      );
    }

    const dir = sandboxResult.canonical;
    let inspect;
    try {
      inspect = await inspectProject(dir);
    } catch (err) {
      if (err instanceof InspectDirNotFoundError) {
        return c.json({ error: "not-found", message: err.message }, 404);
      }
      throw err;
    }

    // Never overwrite an existing workspace or legacy config.
    try {
      await assertNoExistingIdeYml(dir);
    } catch (err) {
      if (err instanceof OnboardConflictError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }

    // Compose the config from inputs (defaults to inspect.name).
    const finalName = parsed.data.name?.trim() || inspect.name;
    let config;
    try {
      config = composeIdeYmlConfig({
        name: finalName,
        agents: parsed.data.agents,
        agentNames: parsed.data.agentNames,
        devCommand: parsed.data.devCommand ?? null,
        testCommand: parsed.data.testCommand ?? null,
        lintCommand: parsed.data.lintCommand ?? null,
      });
    } catch (err) {
      if (err instanceof OnboardInvalidInputError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }

    writeConfig(dir, config);

    // Now register — this also broadcasts `projects.changed`.
    try {
      const project = await registerProject({ dir, name: finalName });
      return c.json({ project } satisfies DaemonRegisteredProjectResponse, 201);
    } catch (err) {
      if (err instanceof ProjectAlreadyRegisteredError) {
        return c.json({ error: err.message, code: err.code, suggestion: err.suggestion }, 409);
      }
      if (err instanceof ProjectDirNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
  });

  return app;
}

/**
 * Discover bundled templates by reading `templates/*.yml`. Hardcoded
 * descriptions for the canonical set; unknown templates surface with a
 * generic label so we don't break if templates are added without updating
 * this map.
 */
function listAvailableTemplates(): ProjectTemplate[] {
  const __filename = fileURLToPath(import.meta.url);
  const __dir = dirname(__filename);
  // Repo-root templates/ — 4 levels up from packages/daemon/src/command-center/.
  // Pre-fold this lived at <pkg>/templates (..,.. worked); post-fold the
  // canonical templates dir is at the repo root.
  const templatesDir = join(__dir, "..", "..", "..", "..", "templates");
  if (!existsSync(templatesDir)) return [];
  const labels: Record<string, { label: string; description: string }> = {
    default: { label: "Default", description: "Single Claude pane + dev/shell row" },
    nextjs: {
      label: "Next.js",
      description: "Two Claude panes + Next.js dev server + shell",
    },
    vite: { label: "Vite", description: "Vite dev server + Claude + shell" },
    convex: {
      label: "Convex",
      description: "Convex dev + Next.js + Claude pane",
    },
    python: { label: "Python", description: "Python project with Claude + tests" },
    go: { label: "Go", description: "Go project with Claude + tests + shell" },
    "agent-team": {
      label: "Agent Team",
      description: "Lead + teammate Claude panes for coordinated multi-agent work",
    },
    "agent-team-nextjs": {
      label: "Agent Team — Next.js",
      description: "Agent team layout tuned for a Next.js app",
    },
    "agent-team-monorepo": {
      label: "Agent Team — Monorepo",
      description: "Agent team layout for monorepos with multiple apps",
    },
    missions: {
      label: "Missions",
      description: "Mission-driven layout with planner, validator, and researcher",
    },
  };
  const entries = readdirSync(templatesDir).filter((f) => f.endsWith(".yml"));
  return entries
    .map((file) => {
      const id = file.replace(/\.yml$/, "");
      const meta = labels[id];
      return {
        id,
        label: meta?.label ?? id,
        description: meta?.description ?? `Template: ${id}`,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Attach the unified `/ws/events` push channel to a Node HTTP server. The
 * daemon calls this once after binding the command-center port. Existing
 * SSE endpoints (`/api/events`, `/api/project/<name>/stream`) continue to
 * work alongside this — they will be retired in a follow-up slice.
 */
export function attachWsEvents(
  server: import("node:http").Server,
  daemonIdentity: DaemonInstanceIdentity,
): {
  close: () => void;
} {
  const wss = new WebSocketServer({ noServer: true });

  const upgradeListener = (
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    if (pathname !== "/ws/events") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleWsEventsConnection(ws, daemonIdentity);
    });
  };

  server.on("upgrade", upgradeListener);

  return {
    close: () => {
      server.off("upgrade", upgradeListener);
      wss.close();
    },
  };
}
