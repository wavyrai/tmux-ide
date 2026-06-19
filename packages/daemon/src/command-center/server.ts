import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  statSync,
  renameSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE, stream as streamResponse } from "hono/streaming";
import { cors } from "hono/cors";
import {
  discoverSessions,
  buildOverviews,
  buildProjectDetail,
  buildOrchestratorSnapshot,
  type SessionOverview,
  type ProjectDetail,
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
import { readConfig, writeConfig } from "../lib/yaml-io.ts";
import { IdeConfigSchema } from "../schemas/ide-config.ts";
import {
  ensureTasksDir,
  loadMission,
  saveMission,
  loadTasks,
  taskStore,
  getTaskStoreMetrics,
  type TaskStoreChangeEvent,
} from "../lib/task-store.ts";
import {
  createTaskRecord,
  deleteTaskRecord,
  updateTaskRecord,
  TaskActionError,
} from "../lib/task-actions.ts";
import { readEvents, appendEvent, eventLogEmitter } from "../lib/event-log.ts";
import { getLogBuffer, subscribeLogs, type LogEntry } from "../lib/log.ts";
import { extractMarks, calculateStats, tagContent } from "../lib/authorship.ts";
import {
  loadValidationState,
  loadValidationContract,
  saveValidationState,
  checkCoverage,
} from "../lib/validation.ts";
import {
  loadSkills,
  loadSkill,
  writeSkillFromFields,
  deleteSkill,
  projectSkillExists,
} from "../lib/skill-registry.ts";
import { computeMetrics, loadMissionHistory } from "../lib/metrics.ts";
import { loadPlans, markPlanDone } from "../lib/plan-store.ts";
import {
  loadCheckpoints,
  loadCheckpoint,
  loadCheckpointsForTask,
  saveCheckpoint,
  deleteCheckpoint,
  nextCheckpointId,
  loadReviews,
  loadReview,
  loadReviewsForTask,
  saveReview,
  deleteReview,
  nextReviewId,
  type Checkpoint,
  type ReviewRequest,
  type ReviewComment,
} from "../lib/workflow-store.ts";
import { zValidator } from "@hono/zod-validator";
import {
  getDefaultWorkspaceRegistry,
  WorkspaceAlreadyExistsError,
  WorkspaceNotFoundError,
} from "../lib/workspace-registry.ts";
import { discoverTmuxAgents } from "../lib/agent-discovery.ts";
import {
  aggregateHqAgents,
  getDefaultExternalAgentRegistry,
  mergeLocalAgents,
  type RemoteAgentSource,
} from "../lib/agent-registry.ts";
import { AgentListSchemaZ, type AgentRecord } from "@tmux-ide/contracts";
import { AddWorkspaceRequestSchemaZ } from "@tmux-ide/contracts";
import {
  updateTaskSchema,
  createTaskSchema,
  savePlanSchema,
  savePlanContentSchema,
  sendCommandSchema,
  createMilestoneSchema,
  updateMilestoneSchema,
  updateAssertionSchema,
  triggerResearchSchema,
  createSkillSchema,
  updateSkillSchema,
} from "./schemas.ts";
import { Effect } from "effect";
import {
  branches as gitBranches,
  checkout as gitCheckout,
  commit as gitCommit,
  commits as gitCommits,
  commitDiff as gitCommitDiff,
  push as gitPush,
  rangeDiff as gitRangeDiff,
  stage as gitStage,
  status as gitStatus,
  unstage as gitUnstage,
} from "../git/git-service.ts";
import { toPayload as gitErrorToPayload } from "../git/errors.ts";
import {
  createPullRequest as ghCreatePr,
  listChecks as ghListChecks,
  status as ghStatus,
  toPayload as githubErrorToPayload,
} from "../git/github-service.ts";
import {
  checkoutRequestSchema,
  commitRequestSchema,
  pushRequestSchema,
  stageRequestSchema,
  unstageRequestSchema,
  createPrRequestSchema,
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
import { TunnelManager } from "../lib/tunnels/manager.ts";
import { RemoteRegistry } from "../lib/hq/registry.ts";
import { RegistrationPayloadSchema } from "../lib/hq/types.ts";
import { dispatchResearch, loadResearchState } from "../lib/research.ts";
import { parseSearchQuery, resolveRipgrepPath, runSearch, type SearchFrame } from "./search.ts";
import { executeReplace, ReplaceRequestZ } from "./search-replace.ts";
import { serveDashboard } from "./static.ts";
import { attachNotesRoutes } from "../notes/handlers.ts";
import { getOrchestratorHealth, getPaneContentHashMetrics } from "../lib/orchestrator.ts";
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
import {
  InspectFilesystemRequestSchemaZ,
  OnboardProjectRequestSchemaZ,
} from "../schemas/inspect.ts";
import {
  browseDirectory,
  InvalidPathError,
  PathNotFoundError,
  SandboxViolationError,
  assertInsideSandbox,
} from "../lib/filesystem-browser.ts";
import { inspectProject, InspectDirNotFoundError } from "../lib/project-inspect.ts";
import {
  composeIdeYmlConfig,
  assertNoExistingIdeYml,
  OnboardConflictError,
  OnboardInvalidInputError,
} from "../lib/project-onboard.ts";
import { realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, resolve as pathResolve } from "node:path";
import { getLspClient, getLspClientForFile } from "../lsp/registry.ts";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  initializeDefaultChatRuntime,
  getDefaultPlanOrchestrator,
  getDefaultPlanStore,
  getDefaultTurnDiffProjection,
} from "../chat/defaults.ts";
import type { TurnDiffProjection } from "../persistence/projections/turn-diff-projection.ts";
import {
  discoverProviders,
  type ProviderInfo as ChatProviderInfo,
  type ProviderDiscoveryOptions,
} from "../chat/provider-discovery.ts";
import {
  PlanAlreadyImplementedError,
  PlanAlreadyRejectedError,
  TurnAlreadyRunningError,
} from "../chat/plan-orchestrator.ts";
import { PlanNotFoundError } from "../chat/plan-store.ts";
import { PlanApproveBodyZ, PlanRejectBodyZ } from "@tmux-ide/contracts";
import {
  makeProviderStore,
  ProviderStoreError,
  type ProviderStore,
} from "../chat/provider-store.ts";
import { ProviderInstanceZ } from "@tmux-ide/contracts";

export interface CreateAppOptions {
  authService?: AuthService;
  authConfig?: AuthConfig;
  tunnelManager?: TunnelManager;
  remoteRegistry?: RemoteRegistry;
  /**
   * This host's HQ machine name (the name it registers under when acting as
   * an HQ remote). Used to stamp local agents in GET /api/hq/agents so the
   * aggregated view labels them by machine. Falls back to os.hostname().
   */
  hqMachineName?: string;
  remoteAccess?: {
    bindHostname?: string;
    token?: string | null;
    localBypassToken?: string | null;
  };
  /**
   * Provider instance store (T080). Backs `/api/providers` GET/POST/DELETE
   * over `~/.tmux-ide/providers.json`. Override in tests to point at a
   * tmpdir; production code uses the default file location.
   */
  providerStore?: ProviderStore;
  /**
   * TurnDiff projection backing the `/api/project/:name/turn-diffs/*`
   * endpoints (T101a). Tests inject an in-memory projection populated
   * from a FakeEventReader; production uses the chat-defaults singleton.
   */
  turnDiffProjection?: TurnDiffProjection;
  /** Inject the provider-discovery probe (tests pass stubs). */
  providerDiscovery?: ProviderDiscoveryOptions;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve our package.json's version. The lookup needs to handle BOTH
// dev (this file lives at src/command-center/, so the workspace root
// is two levels up) AND the packaged Electron bundle (this file is
// flattened into app.asar/dist-electron/, so the bundled package.json
// is ONE level up; two levels up escapes the asar). Try the candidates
// in order; fall back to a sentinel if neither is readable.
function resolvePackageVersion(): string {
  const candidates = [join(__dirname, "../../package.json"), join(__dirname, "../package.json")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0";
}
const pkgVersion: string = resolvePackageVersion();
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

function remoteAccessAuth(options: CreateAppOptions): {
  token: string | null;
  localBypassToken: string | null;
} {
  const bindHostname = options.remoteAccess?.bindHostname ?? "127.0.0.1";
  return {
    token: bindHostname === "127.0.0.1" ? null : (options.remoteAccess?.token ?? null),
    localBypassToken: options.remoteAccess?.localBypassToken ?? null,
  };
}

const ALLOWED_MILESTONE_TRANSITIONS = new Map([
  ["locked", new Set(["active"])],
  ["active", new Set(["validating"])],
  ["validating", new Set(["done", "active"])],
  ["done", new Set<string>()],
]);

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

function isPathInside(path: string | null | undefined, root: string): boolean {
  if (!path) return false;
  return path === root || path.startsWith(root + "/");
}

function safePlanName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9_\-. ]/g, "");
}

function planFilePath(projectDir: string, filename: string): string {
  const safeName = safePlanName(filename);
  return join(projectDir, "plans", safeName.endsWith(".md") ? safeName : `${safeName}.md`);
}

function writePlanAtomic(filePath: string, content: string): number {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, filePath);
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best effort cleanup; the real write has either completed or failed.
      }
    }
  }
  return statSync(filePath).mtimeMs;
}

function parsePlanFrontmatterSummary(content: string): {
  owner: string | null;
  status: string | null;
} {
  if (!content.startsWith("---\n")) return { owner: null, status: null };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { owner: null, status: null };
  let owner: string | null = null;
  let status: string | null = null;
  for (const line of content.slice(4, end).split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim().replace(/^["']|["']$/g, "");
    if (key === "owner") owner = value;
    if (key === "status") status = value.toLowerCase().replace(/\s+/g, "-");
  }
  return { owner, status };
}

function patchPlanStatus(content: string, status: string): string {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const block = content.slice(4, end);
      const rest = content.slice(end);
      if (/^status:\s*.*$/im.test(block)) {
        return `---\n${block.replace(/^status:\s*.*$/im, `status: ${status}`)}${rest}`;
      }
      return `---\nstatus: ${status}\n${block}${rest}`;
    }
  }

  if (/\*\*Status:\*\*\s*`[^`]+`/.test(content)) {
    return content.replace(/\*\*Status:\*\*\s*`[^`]+`/, `**Status:** \`${status}\``);
  }
  return `---\nstatus: ${status}\n---\n${content}`;
}

function isValidMilestoneTransition(
  from: "locked" | "active" | "done" | "validating",
  to: "locked" | "active" | "done" | "validating",
): boolean {
  if (from === to) return true;
  return ALLOWED_MILESTONE_TRANSITIONS.get(from)?.has(to) ?? false;
}

type DiscoveredSession = ReturnType<typeof discoverSessions>[number];

function validationSummary(dir: string): {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  blocked: number;
} {
  const valState = loadValidationState(dir);
  const assertions = valState ? Object.values(valState.assertions) : [];
  return {
    total: assertions.length,
    passing: assertions.filter((a) => a.status === "passing").length,
    failing: assertions.filter((a) => a.status === "failing").length,
    pending: assertions.filter((a) => a.status === "pending").length,
    blocked: assertions.filter((a) => a.status === "blocked").length,
  };
}

function buildProjectStreamSnapshot(session: DiscoveredSession) {
  const project = buildProjectDetail(session);
  const mission = loadMission(session.dir);
  const tasks = loadTasks(session.dir);
  const milestones = mission
    ? [...mission.milestones]
        .sort((a, b) => a.order - b.order)
        .map((milestone) => {
          const milestoneTasks = tasks.filter((task) => task.milestone === milestone.id);
          return {
            ...milestone,
            taskCount: milestoneTasks.length,
            tasksDone: milestoneTasks.filter((task) => task.status === "done").length,
          };
        })
    : [];

  return {
    project,
    mission: mission ? { mission, validationSummary: validationSummary(session.dir) } : null,
    milestones,
    goals: project.goals,
    tasks: project.tasks,
    skills: loadSkills(session.dir),
    agents: project.agents,
    events: readEvents(session.dir).slice(-100).reverse(),
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
  initializeDefaultChatRuntime();

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

  app.post("/api/v2/action/:name", createActionDispatcher());

  // --- /api/providers — ProviderInstance CRUD over ~/.tmux-ide/providers.json
  // (T080). The dashboard's ProvidersPanel reads/writes through this surface;
  // summaries are redacted (no apiKey) so secrets stay daemon-side.
  const providerStore: ProviderStore = options.providerStore ?? makeProviderStore();

  function providerErrorStatus(err: ProviderStoreError): 400 | 404 | 409 {
    if (err.code === "not_found") return 404;
    if (err.code === "duplicate_id") return 409;
    return 400;
  }

  app.get("/api/providers", (c) => {
    return c.json({ providers: providerStore.summaries() });
  });

  app.post("/api/providers", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON" }, 400);
    }
    const parsed = ProviderInstanceZ.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid provider instance",
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    }
    try {
      const created = providerStore.add(parsed.data);
      return c.json(
        {
          provider: created.id,
          summary: providerStore.summaries().find((s) => s.id === created.id),
        },
        201,
      );
    } catch (err) {
      if (err instanceof ProviderStoreError) {
        return c.json({ error: err.message, code: err.code }, providerErrorStatus(err));
      }
      throw err;
    }
  });

  app.delete("/api/providers/:id", (c) => {
    const id = c.req.param("id");
    const removed = providerStore.remove(id);
    if (!removed) {
      return c.json({ error: `Provider not found: ${id}` }, 404);
    }
    return c.json({ removed: id });
  });

  // --- API routes ---

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
  // every consumer. Returns ok + version + uptime (ms since boot).
  const HEALTHZ_BOOTED_AT = Date.now();
  app.get("/healthz", (c) => {
    return c.json({
      ok: true,
      version: process.env.npm_package_version ?? "dev",
      uptimeMs: Date.now() - HEALTHZ_BOOTED_AT,
    });
  });

  app.get("/api/sessions", (c) => {
    const sessions = discoverSessions();
    const overviews = buildOverviews(sessions);
    return c.json({ sessions: overviews });
  });

  // ---------------------------------------------------------------------
  // /api/workspaces — registry-backed CRUD. The registry is the source of
  // truth for which projects the daemon serves. WS frames `workspace.added`
  // and `workspace.removed` are emitted by the registry's emitter, picked
  // up by ws-events' ensureWorkspaceRegistryListener and fanned to clients.
  // ---------------------------------------------------------------------

  app.get("/api/workspaces", (c) => {
    const registry = getDefaultWorkspaceRegistry();
    return c.json({ workspaces: registry.list() });
  });

  app.get("/api/workspaces/:name", (c) => {
    const name = c.req.param("name");
    const registry = getDefaultWorkspaceRegistry();
    const workspace = registry.get(name);
    if (!workspace) return c.json({ error: "Workspace not found" }, 404);
    return c.json({ workspace });
  });

  app.post("/api/workspaces", zValidator("json", AddWorkspaceRequestSchemaZ), (c) => {
    const body = c.req.valid("json");
    const registry = getDefaultWorkspaceRegistry();
    const name = body.name ?? basename(body.projectDir);
    if (!name || name.length === 0) {
      return c.json({ error: "Cannot derive workspace name from projectDir" }, 400);
    }
    try {
      const workspace = registry.add({
        name,
        sessionName: body.sessionName,
        projectDir: body.projectDir,
        ideConfigPath: body.ideConfigPath ?? null,
      });
      return c.json({ workspace }, 201);
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
  app.get("/api/chat/providers", async (c) => {
    const providers: ChatProviderInfo[] = await discoverProviders(options.providerDiscovery);
    return c.json({ providers });
  });

  app.get("/api/threads/:threadId/plans", (c) => {
    const threadId = c.req.param("threadId");
    if (!threadId) return c.json({ error: "threadId is required" }, 400);
    const plans = getDefaultPlanStore().list(threadId);
    return c.json({ plans });
  });

  app.post(
    "/api/threads/:threadId/plans/:planId/approve",
    zValidator("json", PlanApproveBodyZ),
    async (c) => {
      const threadId = c.req.param("threadId");
      const planId = c.req.param("planId");
      const body = c.req.valid("json");
      const orchestrator = getDefaultPlanOrchestrator();
      try {
        const result = await orchestrator.approve({
          threadId,
          planId,
          ...(body.runtimeMode ? { runtimeMode: body.runtimeMode } : {}),
        });
        return c.json({ plan: result.plan, turnId: result.turnId });
      } catch (err) {
        if (err instanceof PlanNotFoundError) {
          return c.json({ error: err.message, code: "plan_not_found" }, 404);
        }
        if (
          err instanceof PlanAlreadyImplementedError ||
          err instanceof PlanAlreadyRejectedError ||
          err instanceof TurnAlreadyRunningError
        ) {
          return c.json({ error: err.message, code: err.name }, 409);
        }
        throw err;
      }
    },
  );

  app.post(
    "/api/threads/:threadId/plans/:planId/reject",
    zValidator("json", PlanRejectBodyZ),
    (c) => {
      const threadId = c.req.param("threadId");
      const planId = c.req.param("planId");
      const body = c.req.valid("json");
      const orchestrator = getDefaultPlanOrchestrator();
      try {
        const plan = orchestrator.reject({
          threadId,
          planId,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
        });
        return c.json({ plan });
      } catch (err) {
        if (err instanceof PlanNotFoundError) {
          return c.json({ error: err.message, code: "plan_not_found" }, 404);
        }
        if (err instanceof PlanAlreadyImplementedError || err instanceof PlanAlreadyRejectedError) {
          return c.json({ error: err.message, code: err.name }, 409);
        }
        throw err;
      }
    },
  );

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
    const orchestratorSnapshot = buildOrchestratorSnapshot(session);
    let orchestratorConfig: { enabled: boolean; dispatchMode: string } | null = null;
    try {
      const { config } = readConfig(session.dir);
      const orch = config.orchestrator;
      if (orch) {
        orchestratorConfig = {
          enabled: orch.enabled ?? false,
          dispatchMode: orch.dispatch_mode ?? "tasks",
        };
      }
    } catch {
      // unreadable ide.yml
    }
    return c.json({ ...detail, orchestratorSnapshot, orchestratorConfig });
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
    });
  });

  app.post("/api/project/:name/task/:id", zValidator("json", updateTaskSchema), async (c) => {
    const name = c.req.param("name");
    const taskId = c.req.param("id");

    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = c.req.valid("json");
    try {
      const { task } = updateTaskRecord(session.dir, {
        taskId,
        status: body.status,
        assignee: body.assignee,
        title: body.title,
        description: body.description,
        priority: body.priority,
      });
      return c.json({ ok: true, task });
    } catch (err) {
      if (err instanceof TaskActionError && err.code === "task_not_found") {
        return c.json({ error: "Task not found" }, 404);
      }
      return c.json({ error: "Task not found" }, 404);
    }
  });

  // Create task
  app.post("/api/project/:name/task", zValidator("json", createTaskSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = c.req.valid("json");

    const { task } = createTaskRecord(session.dir, {
      title: body.title,
      description: body.description,
      priority: body.priority,
      goalId: body.goal,
      tags: body.tags,
    });
    return c.json({ ok: true, task }, 201);
  });

  // Delete task
  app.delete("/api/project/:name/task/:id", (c) => {
    const name = c.req.param("name");
    const taskId = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    try {
      deleteTaskRecord(session.dir, taskId);
    } catch (err) {
      if (err instanceof TaskActionError && err.code === "task_not_found") {
        return c.json({ error: "Task not found" }, 404);
      }
      throw err;
    }
    return c.json({ ok: true, deleted: taskId });
  });

  // List plan files with status metadata
  app.get("/api/project/:name/plans", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const plans = loadPlans(session.dir).map((p) => {
      const filePath = join(session.dir, "plans", `${p.name}.md`);
      const raw = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
      const frontmatter = parsePlanFrontmatterSummary(raw);
      return {
        name: p.name,
        path: `${p.name}.md`,
        title: p.title,
        status: frontmatter.status ?? p.status,
        effort: p.effort ?? null,
        owner: frontmatter.owner,
        updated: existsSync(filePath) ? statSync(filePath).mtime.toISOString() : null,
        completed: p.completed ?? null,
      };
    });

    return c.json({ plans });
  });

  // Read a single plan file
  app.get("/api/project/:name/plans/:filename", (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // Sanitize filename — no path traversal
    const safeName = safePlanName(filename);
    const filePath = planFilePath(session.dir, filename);

    if (!existsSync(filePath)) {
      return c.json({ error: "Plan not found" }, 404);
    }

    const raw = readFileSync(filePath, "utf-8");
    const { content, marks } = extractMarks(raw);
    const stats = marks ? calculateStats(marks.marks) : null;
    return c.json({
      name: safeName.replace(/\.md$/, ""),
      content,
      marks: marks?.marks ?? null,
      stats,
      mtime: statSync(filePath).mtimeMs,
    });
  });

  // Save a plan file (with authorship tagging)
  app.post("/api/project/:name/plans/:filename", zValidator("json", savePlanSchema), async (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const body = c.req.valid("json");

    const filePath = planFilePath(session.dir, filename);

    // Auto-tag uncovered character ranges as human-authored
    const tagged = tagContent(body.content, "human");
    const mtime = writePlanAtomic(filePath, tagged);

    return c.json({ ok: true, mtime });
  });

  app.post(
    "/api/project/:name/plans/:filename/content",
    zValidator("json", savePlanContentSchema),
    async (c) => {
      const name = c.req.param("name");
      const filename = c.req.param("filename");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const filePath = planFilePath(session.dir, filename);
      if (!existsSync(filePath)) {
        return c.json({ error: "Plan not found" }, 404);
      }

      const body = c.req.valid("json");
      const mtime = writePlanAtomic(filePath, body.content);
      return c.json({ ok: true, mtime });
    },
  );

  // Delete a plan file
  app.delete("/api/project/:name/plans/:filename", (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const safeName = safePlanName(filename);
    const filePath = planFilePath(session.dir, filename);

    if (!existsSync(filePath)) {
      return c.json({ error: "Plan not found" }, 404);
    }

    unlinkSync(filePath);
    return c.json({ ok: true, deleted: safeName });
  });

  // Mark a plan as done
  app.post("/api/project/:name/plans/:filename/done", (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const safeName = filename.replace(/[^a-zA-Z0-9_\-. ]/g, "").replace(/\.md$/, "");
    const result = markPlanDone(session.dir, safeName);
    if (!result) {
      return c.json({ error: "Plan not found" }, 404);
    }

    return c.json({ ok: true, plan: result });
  });

  app.post("/api/project/:name/plans/:filename/status", async (c) => {
    const name = c.req.param("name");
    const filename = c.req.param("filename");
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
    const status = (body as { status?: unknown })?.status;
    if (
      status !== "pending" &&
      status !== "in-progress" &&
      status !== "done" &&
      status !== "archived"
    ) {
      return c.json({ error: "Invalid status" }, 400);
    }

    if (status === "done") {
      const safeName = safePlanName(filename).replace(/\.md$/, "");
      const result = markPlanDone(session.dir, safeName);
      if (!result) return c.json({ error: "Plan not found" }, 404);
      return c.json({ ok: true, plan: result });
    }

    const filePath = planFilePath(session.dir, filename);
    if (!existsSync(filePath)) {
      return c.json({ error: "Plan not found" }, 404);
    }
    const patched = patchPlanStatus(readFileSync(filePath, "utf-8"), status);
    const mtime = writePlanAtomic(filePath, patched);
    return c.json({ ok: true, mtime });
  });

  // --- Checkpoints ---

  app.get("/api/project/:name/checkpoints", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const taskId = c.req.query("task");
    const list = taskId
      ? loadCheckpointsForTask(session.dir, taskId)
      : loadCheckpoints(session.dir);
    return c.json({ checkpoints: list });
  });

  app.get("/api/project/:name/checkpoints/:id", (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const cp = loadCheckpoint(session.dir, id);
    if (!cp) return c.json({ error: "Checkpoint not found" }, 404);
    return c.json({ checkpoint: cp });
  });

  app.post("/api/project/:name/checkpoints", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = nextCheckpointId(session.dir);
    const checkpoint: Checkpoint = {
      id,
      taskId: body.taskId ?? "",
      title: body.title ?? `Checkpoint ${id}`,
      description: body.description ?? "",
      status: "pending",
      createdBy: body.createdBy ?? "",
      reviewedBy: null,
      created: now,
      updated: now,
      diff: body.diff ?? null,
      files: body.files ?? [],
      comments: [],
    };
    saveCheckpoint(session.dir, checkpoint);
    return c.json({ ok: true, checkpoint }, 201);
  });

  app.post("/api/project/:name/checkpoints/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const existing = loadCheckpoint(session.dir, id);
    if (!existing) return c.json({ error: "Checkpoint not found" }, 404);
    const body = await c.req.json();
    const updated: Checkpoint = {
      ...existing,
      ...body,
      id: existing.id,
      created: existing.created,
      updated: new Date().toISOString(),
    };
    saveCheckpoint(session.dir, updated);
    return c.json({ ok: true, checkpoint: updated });
  });

  app.delete("/api/project/:name/checkpoints/:id", (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!deleteCheckpoint(session.dir, id)) return c.json({ error: "Checkpoint not found" }, 404);
    return c.json({ ok: true, deleted: id });
  });

  // --- TurnDiff (T101a) -----------------------------------------------------
  // Per-turn file-diff aggregate, projected from chat.checkpoint.created
  // events (see packages/daemon/src/persistence/projections/turn-diff-
  // projection.ts). All three endpoints are project-scoped: they share the
  // same `:name → live tmux session` resolution as the rest of /api/project
  // so 404s line up with the other project routes.

  const turnDiffProjection: TurnDiffProjection =
    options.turnDiffProjection ?? getDefaultTurnDiffProjection();

  // GET /api/project/:name/turn-diffs/aggregate?threadId=X — must be
  // registered BEFORE the `/:turnId` route so Hono routes "aggregate" to
  // the aggregate handler instead of treating it as a turn id.
  app.get("/api/project/:name/turn-diffs/aggregate", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    if (!sessions.find((s) => s.name === name)) {
      return c.json({ error: "Session not found" }, 404);
    }
    const threadId = c.req.query("threadId");
    if (!threadId) {
      return c.json({ error: "threadId query parameter is required" }, 400);
    }
    return c.json(turnDiffProjection.aggregateForThread(threadId));
  });

  // GET /api/project/:name/turn-diffs/:turnId → TurnDiffEntry[]
  app.get("/api/project/:name/turn-diffs/:turnId", (c) => {
    const name = c.req.param("name");
    const turnId = c.req.param("turnId");
    const sessions = discoverSessions();
    if (!sessions.find((s) => s.name === name)) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ turnId, entries: turnDiffProjection.listForTurn(turnId) });
  });

  // GET /api/project/:name/turn-diffs?threadId=X
  //   → { byTurn: Record<turnId, TurnDiffEntry[]> }
  app.get("/api/project/:name/turn-diffs", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    if (!sessions.find((s) => s.name === name)) {
      return c.json({ error: "Session not found" }, 404);
    }
    const threadId = c.req.query("threadId");
    if (!threadId) {
      return c.json({ error: "threadId query parameter is required" }, 400);
    }
    return c.json({ threadId, byTurn: turnDiffProjection.listForThread(threadId) });
  });

  // --- Reviews ---

  app.get("/api/project/:name/reviews", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const taskId = c.req.query("task");
    const list = taskId ? loadReviewsForTask(session.dir, taskId) : loadReviews(session.dir);
    return c.json({ reviews: list });
  });

  app.get("/api/project/:name/reviews/:id", (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const review = loadReview(session.dir, id);
    if (!review) return c.json({ error: "Review not found" }, 404);
    return c.json({ review });
  });

  app.post("/api/project/:name/reviews", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = nextReviewId(session.dir);
    const review: ReviewRequest = {
      id,
      taskId: body.taskId ?? "",
      checkpointId: body.checkpointId ?? null,
      title: body.title ?? `Review ${id}`,
      description: body.description ?? "",
      status: "open",
      requestedBy: body.requestedBy ?? "",
      reviewer: body.reviewer ?? null,
      created: now,
      updated: now,
      comments: [],
    };
    saveReview(session.dir, review);
    return c.json({ ok: true, review }, 201);
  });

  app.post("/api/project/:name/reviews/:id", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const existing = loadReview(session.dir, id);
    if (!existing) return c.json({ error: "Review not found" }, 404);
    const body = await c.req.json();
    const updated: ReviewRequest = {
      ...existing,
      ...body,
      id: existing.id,
      created: existing.created,
      updated: new Date().toISOString(),
    };
    saveReview(session.dir, updated);
    return c.json({ ok: true, review: updated });
  });

  app.post("/api/project/:name/reviews/:id/comment", async (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const existing = loadReview(session.dir, id);
    if (!existing) return c.json({ error: "Review not found" }, 404);
    const body = await c.req.json();
    const comment: ReviewComment = {
      author: body.author ?? "",
      body: body.body ?? "",
      created: new Date().toISOString(),
    };
    existing.comments.push(comment);
    existing.updated = comment.created;
    saveReview(session.dir, existing);
    return c.json({ ok: true, review: existing });
  });

  app.delete("/api/project/:name/reviews/:id", (c) => {
    const name = c.req.param("name");
    const id = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    if (!deleteReview(session.dir, id)) return c.json({ error: "Review not found" }, 404);
    return c.json({ ok: true, deleted: id });
  });

  app.get("/api/project/:name/files", async (c) => {
    const { createIgnoreFilter, readDirectory } = await import("../widgets/lib/files.ts");
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }
    const ig = createIgnoreFilter(session.dir);
    interface FileNode {
      path: string;
      name: string;
      isDirectory: boolean;
      children?: FileNode[];
      truncated?: true;
    }

    // `?path=<relpath>` — non-recursive single-folder listing for
    // lazy-loaded file trees. Returns just the immediate children of
    // the requested directory. Sandboxed via realpath; symlinks that
    // escape the session root are rejected. An empty/absent `path`
    // falls through to the legacy recursive walk below.
    const pathParam = c.req.query("path");
    if (pathParam !== undefined) {
      const relPath = pathParam.replace(/^\/+/g, "");
      const requested = relPath === "" ? session.dir : pathResolve(session.dir, relPath);
      let resolvedRoot: string;
      let resolvedTarget: string;
      try {
        resolvedRoot = realpathSync(session.dir);
      } catch {
        return c.json({ error: "Session directory not accessible" }, 500);
      }
      try {
        resolvedTarget = realpathSync(requested);
      } catch {
        return c.json({ tree: [], truncated: false });
      }
      if (!resolvedTarget.startsWith(resolvedRoot + "/") && resolvedTarget !== resolvedRoot) {
        return c.json({ error: "Path outside session" }, 403);
      }
      const entries = readDirectory(resolvedTarget, session.dir, ig, false);
      const children: FileNode[] = entries.map((e) => ({
        path: e.path,
        name: e.name,
        isDirectory: e.isDir,
      }));
      return c.json({ tree: children, truncated: false });
    }

    const MAX_DEPTH = 5;
    const MAX_NODES = 5000;
    let nodeBudget = MAX_NODES;
    const walk = (dir: string, depth: number): FileNode[] => {
      if (nodeBudget <= 0) return [];
      const entries = readDirectory(dir, session.dir, ig, false);
      const out: FileNode[] = [];
      for (const e of entries) {
        if (nodeBudget <= 0) break;
        nodeBudget--;
        const node: FileNode = { path: e.path, name: e.name, isDirectory: e.isDir };
        if (e.isDir) {
          if (depth + 1 < MAX_DEPTH) {
            node.children = walk(e.absolutePath, depth + 1);
          } else {
            node.truncated = true;
          }
        }
        out.push(node);
      }
      return out;
    };
    const tree = walk(session.dir, 0);
    return c.json({ tree, maxDepth: MAX_DEPTH, truncated: nodeBudget <= 0 });
  });

  app.get("/api/project/:name/diff", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    // `?source=working|staged|pr` selects which diff group to return.
    //   working — HEAD ↔ working tree (staged + unstaged, default).
    //   staged  — HEAD ↔ index (`git diff --cached`).
    //   pr      — <base-branch-merge-base> ↔ HEAD. Base branch picked
    //             via `gh pr view --json baseRefName` first, then a
    //             local heuristic over main / master / develop.
    const sourceParam = (c.req.query("source") ?? "working").toLowerCase();
    const source: "working" | "staged" | "pr" =
      sourceParam === "staged" || sourceParam === "pr" ? sourceParam : "working";

    // Bumped from execFileSync's 1 MB default — real diffs in active repos
    // routinely exceed it (a 3+ MB diff was silently dropping into an empty
    // string before, since the buffer-overflow throw was caught and ignored).
    // 64 MB is more than enough for any sane review session.
    const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

    function runGit(args: string[]): string | null {
      try {
        return execFileSync("git", args, {
          cwd: session!.dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: DIFF_MAX_BUFFER,
        });
      } catch {
        return null;
      }
    }

    interface DiffFile {
      file: string;
      additions: number;
      deletions: number;
    }
    function parseNumstat(out: string | null): DiffFile[] {
      if (!out) return [];
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [added, removed, file] = line.split("\t");
          return {
            file: file!,
            additions: parseInt(added!, 10) || 0,
            deletions: parseInt(removed!, 10) || 0,
          };
        });
    }

    function resolvePrBase(): { baseBranch: string | null; mergeBase: string | null } {
      // First try `gh pr view --json baseRefName,headRefName` to pick
      // up the actual PR base for the checked-out branch. Falls back
      // to a local heuristic that tries main / master / develop.
      let baseBranch: string | null = null;
      try {
        const out = execFileSync("gh", ["pr", "view", "--json", "baseRefName"], {
          cwd: session!.dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 1024 * 64,
        });
        const parsed = JSON.parse(out) as { baseRefName?: string };
        if (parsed.baseRefName) baseBranch = parsed.baseRefName;
      } catch {
        // gh missing, not authed, or no PR for this branch — fall
        // through to the local heuristic.
      }
      if (!baseBranch) {
        for (const candidate of ["main", "master", "develop"]) {
          const exists = runGit(["rev-parse", "--verify", candidate]);
          if (exists !== null) {
            baseBranch = candidate;
            break;
          }
        }
      }
      if (!baseBranch) return { baseBranch: null, mergeBase: null };
      const mergeBaseOut = runGit(["merge-base", "HEAD", baseBranch]);
      const mergeBase = mergeBaseOut?.trim() ?? null;
      return { baseBranch, mergeBase: mergeBase || null };
    }

    let diff: string;
    let files: DiffFile[];
    let originalRef = "HEAD";
    let modifiedRef: string;
    let baseBranch: string | null = null;

    if (source === "staged") {
      diff = runGit(["diff", "--cached", "HEAD"]) ?? runGit(["diff", "--cached"]) ?? "";
      files = parseNumstat(
        runGit(["diff", "--cached", "--numstat", "HEAD"]) ??
          runGit(["diff", "--cached", "--numstat"]),
      );
      modifiedRef = "STAGED";
    } else if (source === "pr") {
      const { baseBranch: base, mergeBase } = resolvePrBase();
      baseBranch = base;
      if (mergeBase) {
        diff = runGit(["diff", `${mergeBase}...HEAD`]) ?? "";
        files = parseNumstat(runGit(["diff", "--numstat", `${mergeBase}...HEAD`]));
        originalRef = mergeBase;
      } else {
        // Couldn't resolve a base — fall back to working-tree.
        diff = runGit(["diff", "HEAD"]) ?? "";
        files = parseNumstat(runGit(["diff", "--numstat", "HEAD"]));
      }
      modifiedRef = "HEAD";
    } else {
      diff = runGit(["diff", "HEAD"]) ?? runGit(["diff"]) ?? "";
      files = parseNumstat(runGit(["diff", "--numstat", "HEAD"]) ?? runGit(["diff", "--numstat"]));
      modifiedRef = "WORKING";
    }

    return c.json({ diff, files, source, originalRef, modifiedRef, baseBranch });
  });

  // Per-file diff endpoint
  app.get("/api/project/:name/diff/:file{.+}", (c) => {
    const name = c.req.param("name");
    const file = c.req.param("file");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Same buffer-overflow bug fix as the parent handler: a single-file diff
    // can still exceed 1 MB on a generated/large file. 64 MB is generous.
    const PER_FILE_MAX_BUFFER = 64 * 1024 * 1024;

    let diff = "";
    try {
      diff = execFileSync("git", ["diff", "HEAD", "--", file], {
        cwd: session.dir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: PER_FILE_MAX_BUFFER,
      });
    } catch {
      // no committed diff
    }
    if (!diff) {
      try {
        diff = execFileSync("git", ["diff", "--", file], {
          cwd: session.dir,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: PER_FILE_MAX_BUFFER,
        });
      } catch {
        // no working-tree diff
      }
    }

    return c.json({ file, diff });
  });

  // GET /api/project/:name/git/file?path=...&ref=...
  // Returns the content of `path` (workspace-relative) at the given ref.
  // Used by the Monaco StickyDiffEditor's `git://...` side. Refs supported:
  //   HEAD     — git show HEAD:path (default)
  //   STAGED   — git show :path (index)
  //   WORKING  — read the working-tree mirror so callers can request all
  //              three sides through the same endpoint
  //   <sha> | <branch> | origin/main — git show <ref>:path
  // Identity is sandboxed: path must be relative and stay under
  // session.dir; absolute / `..` paths are rejected.
  app.get("/api/project/:name/git/file", (c) => {
    const name = c.req.param("name");
    const path = c.req.query("path") ?? "";
    const ref = (c.req.query("ref") ?? "HEAD").trim();
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    // Sandbox the path. No leading `/`, no `..` segments.
    if (!path) return c.json({ error: "Missing ?path=" }, 400);
    if (path.startsWith("/") || path.split("/").some((seg) => seg === ".." || seg === ".")) {
      return c.json({ error: "Path escapes workspace" }, 403);
    }
    // Ref must be a sane shape — alphanumerics, slash, dot, dash, underscore,
    // plus the two pseudo-refs STAGED + WORKING.
    if (ref !== "STAGED" && ref !== "WORKING" && !/^[A-Za-z0-9_./-]+$/.test(ref)) {
      return c.json({ error: "Invalid ref" }, 400);
    }

    const PER_FILE_MAX_BUFFER = 64 * 1024 * 1024;

    let content: string;
    let exists = true;
    try {
      if (ref === "WORKING") {
        const requested = pathResolve(session.dir, path);
        let resolvedRoot: string;
        try {
          resolvedRoot = realpathSync(session.dir);
        } catch {
          return c.json({ error: "Session directory not accessible" }, 500);
        }
        let resolvedTarget: string;
        try {
          resolvedTarget = realpathSync(requested);
        } catch {
          return c.json({ path, ref, exists: false, content: "" });
        }
        if (!resolvedTarget.startsWith(resolvedRoot + "/") && resolvedTarget !== resolvedRoot) {
          return c.json({ error: "Path escapes workspace" }, 403);
        }
        try {
          content = readFileSync(resolvedTarget, "utf-8");
        } catch {
          return c.json({ path, ref, exists: false, content: "" });
        }
      } else {
        const spec = ref === "STAGED" ? `:${path}` : `${ref}:${path}`;
        try {
          content = execFileSync("git", ["show", spec], {
            cwd: session.dir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: PER_FILE_MAX_BUFFER,
          });
        } catch {
          // File didn't exist at that ref (added since, or never tracked).
          exists = false;
          content = "";
        }
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    return c.json({ path, ref, exists, content });
  });

  // PUT /api/project/:name/file?path=...
  // Writes the request body's `{ content: string }` to the
  // workspace-relative path. Used by the dashboard's buffer-store
  // save action (Cmd+S) to persist edits made in the leased Monaco
  // editor.
  //
  // Identity is sandboxed: path must be relative, no `..` segments,
  // resolved target must stay under session.dir (realpath-checked).
  // Parent directories must already exist — the endpoint refuses to
  // create new directories, since "Cmd+S in an open editor" never
  // wants to materialise a tree the user can't see.
  app.put("/api/project/:name/file", async (c) => {
    const name = c.req.param("name");
    const path = c.req.query("path") ?? "";
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    if (!path) return c.json({ error: "Missing ?path=" }, 400);
    if (path.startsWith("/") || path.split("/").some((seg) => seg === ".." || seg === ".")) {
      return c.json({ error: "Path escapes workspace" }, 403);
    }

    let body: { content?: string };
    try {
      body = (await c.req.json()) as { content?: string };
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body?.content !== "string") {
      return c.json({ error: "Body must be `{ content: string }`" }, 400);
    }

    let resolvedRoot: string;
    try {
      resolvedRoot = realpathSync(session.dir);
    } catch {
      return c.json({ error: "Session directory not accessible" }, 500);
    }

    const requested = pathResolve(session.dir, path);
    // Validate the *parent* dir exists + lives inside the workspace.
    // The target file may not exist yet (first save of a freshly-
    // created path), so realpath the parent instead.
    const parent = requested.substring(0, requested.lastIndexOf("/"));
    let resolvedParent: string;
    try {
      resolvedParent = realpathSync(parent);
    } catch {
      return c.json({ error: "Parent directory not found" }, 404);
    }
    if (!resolvedParent.startsWith(resolvedRoot + "/") && resolvedParent !== resolvedRoot) {
      return c.json({ error: "Path escapes workspace" }, 403);
    }

    const target = `${resolvedParent}/${requested.substring(requested.lastIndexOf("/") + 1)}`;

    try {
      writeFileSync(target, body.content, "utf-8");
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }

    let bytes = 0;
    try {
      bytes = statSync(target).size;
    } catch {
      /* size is best-effort — the write succeeded */
    }
    return c.json({ ok: true, path, bytes });
  });

  // GET /api/project/:name/search?q=&include=&exclude=&case=&regex=&context=&maxResults=&maxFileSize=
  //
  // Streams NDJSON (`Content-Type: application/x-ndjson`) one frame per
  // line — `{type: 'begin'|'match'|'context'|'end'|'summary'|'error'}`.
  // See docs/goal-19-repo-search.md §1 for the schema, §2 for the
  // ripgrep invocation strategy, and `./search.ts` for the
  // implementation.
  //
  // Sandboxing: the search root is `realpathSync(session.dir)`; rg
  // never sees a path the client could have manipulated. Include /
  // exclude globs are validated by `parseSearchQuery` (no leading `/`,
  // no `..` segments) so `--glob` can't break out either.
  //
  // Cancellation: when the client disconnects, Hono fires
  // `stream.onAbort` which kills the rg child via SIGTERM. The cap on
  // `maxResults` also triggers a SIGTERM mid-stream and emits a
  // truncated-summary frame.
  app.get("/api/project/:name/search", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const parsed = parseSearchQuery(c.req.query() as Record<string, string | undefined>);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    let searchRoot: string;
    try {
      searchRoot = realpathSync(session.dir);
    } catch {
      return c.json({ error: "Session directory not accessible" }, 500);
    }

    const rgPath = await resolveRipgrepPath();

    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");
    c.header("X-Accel-Buffering", "no");

    return streamResponse(c, async (stream) => {
      const controller = new AbortController();
      const onAbort = (): void => controller.abort();
      stream.onAbort(onAbort);

      try {
        for await (const frame of runSearch({
          rgPath,
          query: parsed.query,
          searchRoot,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          await stream.writeln(JSON.stringify(frame satisfies SearchFrame));
        }
      } catch (err) {
        // Any unexpected throw inside runSearch — surface as a final
        // error frame so the client sees structured failure rather than
        // a half-closed stream.
        const message = err instanceof Error ? err.message : String(err);
        await stream.writeln(
          JSON.stringify({ type: "error", message, fatal: true } satisfies SearchFrame),
        );
      }
    });
  });

  // POST /api/project/:name/search/replace
  // Offset-based replacement across N files, gated by an optional
  // per-file mtime guard so files modified since the search snapshot
  // are skipped (not silently corrupted). See `./search-replace.ts`.
  app.post("/api/project/:name/search/replace", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON" }, 400);
    }
    const parsed = ReplaceRequestZ.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid replace request",
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }

    let searchRoot: string;
    try {
      searchRoot = realpathSync(session.dir);
    } catch {
      return c.json({ error: "Session directory not accessible" }, 500);
    }

    const result = executeReplace(searchRoot, parsed.data);
    return c.json(result);
  });

  // GET /api/project/:name/preview/:file — read a file's contents from inside
  // the session's working directory. The path is sandboxed: we resolve it
  // against session.dir and reject anything that escapes (symlink-aware via
  // realpath). Used by the v2 Preview surface to render file contents in the
  // browser without giving general filesystem access.
  app.get("/api/project/:name/preview/:file{.+}", (c) => {
    const name = c.req.param("name");
    const file = c.req.param("file");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const requested = pathResolve(session.dir, file);
    let resolvedRoot: string;
    let resolvedTarget: string;
    try {
      resolvedRoot = realpathSync(session.dir);
    } catch {
      return c.json({ error: "Session directory not accessible" }, 500);
    }
    try {
      resolvedTarget = realpathSync(requested);
    } catch {
      return c.json({ file, exists: false, content: "" });
    }
    if (!resolvedTarget.startsWith(resolvedRoot + "/") && resolvedTarget !== resolvedRoot) {
      return c.json({ error: "Path outside session" }, 403);
    }
    let stat;
    try {
      stat = statSync(resolvedTarget);
    } catch {
      return c.json({ file, exists: false, content: "" });
    }
    if (!stat.isFile()) {
      return c.json({ error: "Not a regular file" }, 400);
    }
    // For files larger than the preview budget, return the first
    // chunk with `truncated: true` so the client can render a
    // too-large fallback instead of a hard 413.
    const MAX_PREVIEW_BYTES = 1_000_000;
    let content: string;
    let truncated = false;
    try {
      if (stat.size > MAX_PREVIEW_BYTES) {
        const fd = openSync(resolvedTarget, "r");
        try {
          const buf = Buffer.alloc(MAX_PREVIEW_BYTES);
          const bytesRead = readSync(fd, buf, 0, MAX_PREVIEW_BYTES, 0);
          content = buf.subarray(0, bytesRead).toString("utf-8");
        } finally {
          closeSync(fd);
        }
        truncated = true;
      } else {
        content = readFileSync(resolvedTarget, "utf-8");
      }
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "read failed" }, 500);
    }
    return c.json({
      file,
      exists: true,
      content,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      truncated,
    });
  });

  // GET /api/project/:name/image/:file — read an image file inside
  // the session directory and return it as a base64 `data:` URL. The
  // path is sandboxed the same way as `/preview/:file` (realpath +
  // session-root containment). Used by the dashboard's image
  // renderer so it doesn't have to embed the raw text endpoint URL.
  app.get("/api/project/:name/image/:file{.+}", (c) => {
    const name = c.req.param("name");
    const file = c.req.param("file");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const requested = pathResolve(session.dir, file);
    let resolvedRoot: string;
    let resolvedTarget: string;
    try {
      resolvedRoot = realpathSync(session.dir);
    } catch {
      return c.json({ error: "Session directory not accessible" }, 500);
    }
    try {
      resolvedTarget = realpathSync(requested);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    if (!resolvedTarget.startsWith(resolvedRoot + "/") && resolvedTarget !== resolvedRoot) {
      return c.json({ error: "Path outside session" }, 403);
    }
    let stat;
    try {
      stat = statSync(resolvedTarget);
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    if (!stat.isFile()) return c.json({ error: "Not a regular file" }, 400);
    // 25 MB hard cap. Images larger than this are almost certainly a
    // wrong-file mistake; refusing keeps us from base64-encoding a
    // 100 MB blob into a JSON response.
    if (stat.size > 25 * 1024 * 1024) {
      return c.json({ error: "Image too large", size: stat.size }, 413);
    }
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    const mime =
      ext === "png"
        ? "image/png"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "gif"
            ? "image/gif"
            : ext === "webp"
              ? "image/webp"
              : ext === "bmp"
                ? "image/bmp"
                : ext === "ico"
                  ? "image/x-icon"
                  : ext === "svg"
                    ? "image/svg+xml"
                    : "application/octet-stream";
    let dataUrl: string;
    try {
      const bytes = readFileSync(resolvedTarget);
      dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "read failed" }, 500);
    }
    return c.json({ file, dataUrl, mime, size: stat.size });
  });

  // --- Milestone endpoints ---

  app.get("/api/project/:name/milestones", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const mission = loadMission(session.dir);
    if (!mission) return c.json({ milestones: [] });
    const tasks = loadTasks(session.dir);
    const milestones = [...mission.milestones]
      .sort((a, b) => a.order - b.order)
      .map((m) => {
        const mTasks = tasks.filter((t) => t.milestone === m.id);
        return {
          ...m,
          taskCount: mTasks.length,
          tasksDone: mTasks.filter((t) => t.status === "done").length,
        };
      });
    return c.json({ milestones });
  });

  app.get("/api/project/:name/milestones/:id", (c) => {
    const name = c.req.param("name");
    const milestoneId = c.req.param("id");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const mission = loadMission(session.dir);
    if (!mission) return c.json({ error: "No mission" }, 404);
    const milestone = mission.milestones.find((m) => m.id === milestoneId);
    if (!milestone) return c.json({ error: "Milestone not found" }, 404);
    const tasks = loadTasks(session.dir).filter((t) => t.milestone === milestoneId);
    return c.json({ milestone, tasks });
  });

  app.post(
    "/api/project/:name/milestones",
    zValidator("json", createMilestoneSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const mission = loadMission(session.dir);
      if (!mission) return c.json({ error: "No mission" }, 404);
      const body = c.req.valid("json");
      const id = `M${body.sequence}`;
      if (mission.milestones.find((m) => m.id === id)) {
        return c.json({ error: `Milestone ${id} already exists` }, 409);
      }
      const now = new Date().toISOString();
      const hasActive = mission.milestones.some(
        (m) => m.status === "active" || m.status === "done",
      );
      const milestone = {
        id,
        title: body.title,
        description: body.description ?? "",
        status: (hasActive ? "locked" : "active") as "locked" | "active",
        order: body.sequence,
        created: now,
        updated: now,
      };
      mission.milestones.push(milestone);
      mission.milestones.sort((a, b) => a.order - b.order);
      mission.updated = now;
      saveMission(session.dir, mission);
      return c.json({ ok: true, milestone }, 201);
    },
  );

  app.post(
    "/api/project/:name/milestones/:id",
    zValidator("json", updateMilestoneSchema),
    async (c) => {
      const name = c.req.param("name");
      const milestoneId = c.req.param("id");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const mission = loadMission(session.dir);
      if (!mission) return c.json({ error: "No mission" }, 404);
      const milestone = mission.milestones.find((m) => m.id === milestoneId);
      if (!milestone) return c.json({ error: "Milestone not found" }, 404);
      const body = c.req.valid("json");
      if (body.status && !isValidMilestoneTransition(milestone.status, body.status)) {
        return c.json(
          {
            error: `Invalid milestone status transition: ${milestone.status} -> ${body.status}`,
          },
          409,
        );
      }
      if (body.status) milestone.status = body.status;
      if (body.title) milestone.title = body.title;
      if (body.description !== undefined) milestone.description = body.description;
      milestone.updated = new Date().toISOString();
      mission.updated = milestone.updated;
      saveMission(session.dir, mission);
      return c.json({ ok: true, milestone });
    },
  );

  // --- Validation endpoints ---

  app.get("/api/project/:name/validation", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const state = loadValidationState(session.dir);
    const contract = loadValidationContract(session.dir);
    return c.json({ contract: contract ?? null, state: state ?? null });
  });

  app.get("/api/project/:name/validation/coverage", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(checkCoverage(session.dir));
  });

  app.post(
    "/api/project/:name/validation/assert/:assertId",
    zValidator("json", updateAssertionSchema),
    async (c) => {
      const name = c.req.param("name");
      const assertId = c.req.param("assertId");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      ensureTasksDir(session.dir);
      const state = loadValidationState(session.dir) ?? { assertions: {}, lastVerified: null };
      state.assertions[assertId] = {
        status: body.status,
        verifiedBy: body.verifiedBy ?? null,
        verifiedAt: new Date().toISOString(),
        evidence: body.evidence ?? null,
        blockedBy: body.status === "blocked" ? (body.evidence ?? null) : null,
      };
      state.lastVerified = new Date().toISOString();
      saveValidationState(session.dir, state);
      return c.json({ ok: true, assertionId: assertId, ...state.assertions[assertId] });
    },
  );

  app.get("/api/project/:name/research", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);

    const state = loadResearchState(session.dir);
    const tasks = loadTasks(session.dir);
    const activeTask =
      state.activeResearchTaskId != null
        ? (tasks.find((task) => task.id === state.activeResearchTaskId) ?? null)
        : null;
    const findings = tasks
      .filter((task) => task.tags.includes("research") && task.status === "done")
      .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
      .slice(0, 10);

    return c.json({ state, activeTask, findings });
  });

  app.post(
    "/api/project/:name/research/trigger",
    zValidator("json", triggerResearchSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);

      const body = c.req.valid("json");
      const tasks = loadTasks(session.dir);
      const researchState = loadResearchState(session.dir);

      let maxConcurrentAgents = 10;
      let masterPane: string | null = null;
      let researchEnabled = true;
      try {
        const { config } = readConfig(session.dir);
        maxConcurrentAgents = config.orchestrator?.max_concurrent_agents ?? 10;
        masterPane = config.orchestrator?.master_pane ?? null;
        researchEnabled = config.orchestrator?.research?.enabled ?? true;
      } catch {
        // ide.yml unreadable — use defaults
      }

      const task = dispatchResearch(
        {
          session: name,
          dir: session.dir,
          masterPane,
          maxConcurrentAgents,
          research: { enabled: researchEnabled },
        },
        {
          lastActivity: new Map(),
          previousTasks: new Map(),
          claimedTasks: new Set(),
          taskClaimTimes: new Map(),
          inflightDispatches: new Map(),
          completedDispatches: new Set(),
          stallNudges: new Map(),
          totalDispatched: 0,
          totalCompleted: 0,
          totalFailed: 0,
          lastTickMs: 0,
          ticking: false,
          idleAgents: 0,
          queuedDispatches: 0,
          lastError: null,
          lastReconcileMs: 0,
        },
        researchState,
        tasks,
        listSessionPanes(name),
        {
          type: body.type,
          reason: `Manual research trigger: ${body.type}`,
        },
      );

      if (!task) {
        return c.json({ error: `Unable to dispatch research trigger "${body.type}"` }, 409);
      }

      return c.json({ ok: true, task }, 201);
    },
  );

  // --- Skill endpoints ---

  app.get("/api/project/:name/skills", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const skills = loadSkills(session.dir);
    return c.json({ skills });
  });

  app.get("/api/project/:name/skills/:skillName", (c) => {
    const name = c.req.param("name");
    const skillName = c.req.param("skillName");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const skill = loadSkill(session.dir, skillName);
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    return c.json({ skill });
  });

  app.post("/api/project/:name/skill", zValidator("json", createSkillSchema), (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = c.req.valid("json");
    if (projectSkillExists(session.dir, body.name)) {
      return c.json({ error: `Skill "${body.name}" already exists` }, 409);
    }
    try {
      const skill = writeSkillFromFields(session.dir, body);
      return c.json({ skill }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.put("/api/project/:name/skill/:skillName", zValidator("json", updateSkillSchema), (c) => {
    const name = c.req.param("name");
    const skillName = c.req.param("skillName");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const existing = loadSkill(session.dir, skillName);
    if (!existing) return c.json({ error: "Skill not found" }, 404);
    const body = c.req.valid("json");
    try {
      const skill = writeSkillFromFields(session.dir, {
        name: skillName,
        role: body.role ?? existing.role,
        description: body.description ?? existing.description,
        specialties: body.specialties ?? [...existing.specialties],
        body: body.body ?? existing.body,
      });
      return c.json({ skill });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.delete("/api/project/:name/skill/:skillName", (c) => {
    const name = c.req.param("name");
    const skillName = c.req.param("skillName");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const removed = deleteSkill(session.dir, skillName);
      if (!removed) return c.json({ error: "Skill not found" }, 404);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // --- Git endpoints (G18-P1) -----------------------------------------
  //
  // Thin Effect-backed shell-outs to the host `git`. Each handler
  // resolves the session dir, runs the matching service function, and
  // maps tagged errors to the wire payload shape consumers know how to
  // render. Larger surface (diffs, cat-file, watcher → WS broadcast)
  // waits for G18-P2 per docs/goal-18-git-ops.md §G18-P1.

  app.get("/api/project/:name/git/status", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return Effect.runPromise(
      gitStatus(session.dir).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (s) => c.json({ status: s }),
        }),
      ),
    );
  });

  app.get("/api/project/:name/git/branches", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return Effect.runPromise(
      gitBranches(session.dir).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (payload) => c.json(payload),
        }),
      ),
    );
  });

  // Commit history for HEAD. `?base=main` adds the ahead-of-base
  // range (per-commit `ahead` flag + `aheadCount`) so the dashboard
  // can mark which commits a PR against `base` would contain.
  app.get("/api/project/:name/git/commits", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const base = c.req.query("base")?.trim() || undefined;
    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    return Effect.runPromise(
      gitCommits(session.dir, {
        ...(base ? { base } : {}),
        ...(limit && Number.isFinite(limit) ? { limit } : {}),
      }).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (payload) => c.json(payload),
        }),
      ),
    );
  });

  // Unified diff + per-file numstat for one commit (vs its first
  // parent, or the empty tree for the root commit).
  app.get("/api/project/:name/git/commit/:sha/diff", async (c) => {
    const name = c.req.param("name");
    const sha = c.req.param("sha");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return Effect.runPromise(
      gitCommitDiff(session.dir, sha).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (payload) => c.json(payload),
        }),
      ),
    );
  });

  // The full `base...HEAD` diff — what a PR against `base` contains.
  app.get("/api/project/:name/git/range-diff", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const base = c.req.query("base")?.trim() || "main";
    return Effect.runPromise(
      gitRangeDiff(session.dir, base).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (payload) => c.json(payload),
        }),
      ),
    );
  });

  app.post(
    "/api/project/:name/git/checkout",
    zValidator("json", checkoutRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      return Effect.runPromise(
        gitCheckout(session.dir, body).pipe(
          Effect.match({
            onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
            onSuccess: (r) => c.json({ ok: true, currentBranch: r.currentBranch }),
          }),
        ),
      );
    },
  );

  app.post("/api/project/:name/git/commit", zValidator("json", commitRequestSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = c.req.valid("json");
    return Effect.runPromise(
      gitCommit(session.dir, body).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (r) => c.json({ ok: true, sha: r.sha }),
        }),
      ),
    );
  });

  app.post("/api/project/:name/git/push", zValidator("json", pushRequestSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = c.req.valid("json");
    return Effect.runPromise(
      gitPush(session.dir, body).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: (r) => c.json({ ok: true, remote: r.remote, branch: r.branch }),
        }),
      ),
    );
  });

  app.post("/api/project/:name/git/stage", zValidator("json", stageRequestSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = c.req.valid("json");
    return Effect.runPromise(
      gitStage(session.dir, body.paths).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
          onSuccess: () => c.json({ ok: true }),
        }),
      ),
    );
  });

  app.post(
    "/api/project/:name/git/unstage",
    zValidator("json", unstageRequestSchema),
    async (c) => {
      const name = c.req.param("name");
      const sessions = discoverSessions();
      const session = sessions.find((s) => s.name === name);
      if (!session) return c.json({ error: "Session not found" }, 404);
      const body = c.req.valid("json");
      return Effect.runPromise(
        gitUnstage(session.dir, body.paths).pipe(
          Effect.match({
            onFailure: (err) => c.json({ error: gitErrorToPayload(err) }, 400),
            onSuccess: () => c.json({ ok: true }),
          }),
        ),
      );
    },
  );

  app.get("/api/project/:name/git/checks", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const ref = c.req.query("ref") ?? undefined;
    return Effect.runPromise(
      ghListChecks(session.dir, ref).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: githubErrorToPayload(err) }, 400),
          onSuccess: (payload) => c.json(payload),
        }),
      ),
    );
  });

  app.get("/api/project/:name/git/github-status", async (c) => {
    // GitHub auth is per-host (gh CLI / env token) — not per-project —
    // so we don't gate on session lookup beyond URL shape. Still keep
    // the :name segment so the dashboard can scope future work
    // (per-repo overrides) without changing the path.
    return Effect.runPromise(ghStatus().pipe(Effect.map((status) => c.json(status))));
  });

  app.post("/api/project/:name/git/pr", zValidator("json", createPrRequestSchema), async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const body = c.req.valid("json");
    return Effect.runPromise(
      ghCreatePr(session.dir, body).pipe(
        Effect.match({
          onFailure: (err) => c.json({ error: githubErrorToPayload(err) }, 400),
          onSuccess: (pr) => c.json({ ok: true, pr }),
        }),
      ),
    );
  });

  // --- Terminals registry (G20-P1) ---------------------------------
  //
  // Tab-strip metadata for the multi-terminal panel. The actual PTY
  // process lives in `PtyBridgeRegistry` (see ws-route.ts); this
  // surface persists tab labels + scopes so the strip can restore
  // them across browser reloads. Listing combines the JSON store with
  // a live `registry.peek(id)` so the UI knows which tabs are
  // currently running.

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

  // --- Mission endpoints ---

  app.get("/api/project/:name/mission", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const mission = loadMission(session.dir);
    if (!mission) return c.json({ error: "No mission" }, 404);
    const valState = loadValidationState(session.dir);
    const assertions = valState ? Object.values(valState.assertions) : [];
    const validationSummary = {
      total: assertions.length,
      passing: assertions.filter((a) => a.status === "passing").length,
      failing: assertions.filter((a) => a.status === "failing").length,
      pending: assertions.filter((a) => a.status === "pending").length,
      blocked: assertions.filter((a) => a.status === "blocked").length,
    };
    return c.json({ mission, validationSummary });
  });

  app.post("/api/project/:name/mission/plan-complete", async (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const mission = loadMission(session.dir);
    if (!mission) return c.json({ error: "No mission" }, 404);
    if (mission.status !== "planning") {
      return c.json({ error: `Mission is "${mission.status}", expected "planning"` }, 409);
    }
    mission.status = "active";
    const sorted = [...mission.milestones].sort((a, b) => a.order - b.order);
    const first = sorted.find((m) => m.status === "locked");
    if (first) {
      first.status = "active";
      first.updated = new Date().toISOString();
    }
    mission.updated = new Date().toISOString();
    saveMission(session.dir, mission);
    return c.json({ ok: true, mission });
  });

  // --- Metrics endpoints ---

  app.get("/api/project/:name/metrics", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(computeMetrics(session.dir));
  });

  app.get("/api/project/:name/metrics/agents", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ agents: computeMetrics(session.dir).agents });
  });

  app.get("/api/project/:name/metrics/timeline", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ timeline: computeMetrics(session.dir).timeline });
  });

  app.get("/api/project/:name/metrics/history", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json({ history: loadMissionHistory(session.dir) });
  });

  // Events endpoint — returns recent orchestrator events
  app.get("/api/project/:name/events", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const allEvents = readEvents(session.dir);
    // Return last 50 events, newest first
    const recent = allEvents.slice(-50).reverse();

    // Add relative timestamps
    const now = Date.now();
    const withRelative = recent.map((e) => {
      const ms = now - new Date(e.timestamp).getTime();
      let relative: string;
      if (ms < 60000) relative = `${Math.floor(ms / 1000)}s ago`;
      else if (ms < 3600000) relative = `${Math.floor(ms / 60000)}m ago`;
      else if (ms < 86400000) relative = `${Math.floor(ms / 3600000)}h ago`;
      else relative = `${Math.floor(ms / 86400000)}d ago`;
      return { ...e, relative };
    });

    return c.json({ events: withRelative });
  });

  app.get("/api/project/:name/stream", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      projectStreamConnections += 1;
      sseMetrics.connections = projectStreamConnections;
      let closed = false;
      let changeQueued = false;
      let previousSnapshotHash = "";
      let previousTaskHashes = new Map<string, string>();
      let previousGoalHashes = new Map<string, string>();
      let previousMilestoneHashes = new Map<string, string>();
      let previousAgentHashes = new Map<string, string>();
      let previousMissionHash = "";
      let eventCursor = 0;
      let lastPing = Date.now();
      const tasksRoot = join(session.dir, ".tasks");

      function writeSse(event: string, payload: unknown): void {
        sseMetrics.messagesSent += 1;
        void stream.writeSSE({ event, data: JSON.stringify(freezePayload(payload)) });
      }

      function writeSnapshot(currentSession: DiscoveredSession): void {
        const snapshot = buildProjectStreamSnapshot(currentSession);
        previousSnapshotHash = JSON.stringify(snapshot);
        previousTaskHashes = new Map(snapshot.tasks.map((task) => [task.id, JSON.stringify(task)]));
        previousGoalHashes = new Map(snapshot.goals.map((goal) => [goal.id, JSON.stringify(goal)]));
        previousMilestoneHashes = new Map(
          snapshot.milestones.map((milestone) => [milestone.id, JSON.stringify(milestone)]),
        );
        previousAgentHashes = new Map(
          snapshot.agents.map((agent) => [agent.paneId, JSON.stringify(agent)]),
        );
        previousMissionHash = JSON.stringify(snapshot.mission);
        eventCursor = readEvents(currentSession.dir).length;
        writeSse("snapshot", snapshot);
      }

      function writeChanges(currentSession: DiscoveredSession): void {
        const snapshot = buildProjectStreamSnapshot(currentSession);
        const snapshotHash = JSON.stringify(snapshot);
        if (!previousSnapshotHash) {
          writeSnapshot(currentSession);
          return;
        }

        const missionHash = JSON.stringify(snapshot.mission);
        if (missionHash !== previousMissionHash) {
          writeSse("mission.changed", {});
          previousMissionHash = missionHash;
        }

        const nextTaskHashes = new Map(
          snapshot.tasks.map((task) => [task.id, JSON.stringify(task)]),
        );
        for (const task of snapshot.tasks) {
          if (nextTaskHashes.get(task.id) !== previousTaskHashes.get(task.id)) {
            const op = previousTaskHashes.has(task.id) ? "update" : "create";
            writeSse("task.changed", { id: task.id, op });
          }
        }
        for (const id of previousTaskHashes.keys()) {
          if (!nextTaskHashes.has(id)) {
            writeSse("task.changed", { id, op: "delete" });
          }
        }
        previousTaskHashes = nextTaskHashes;

        const nextGoalHashes = new Map(
          snapshot.goals.map((goal) => [goal.id, JSON.stringify(goal)]),
        );
        for (const goal of snapshot.goals) {
          if (nextGoalHashes.get(goal.id) !== previousGoalHashes.get(goal.id)) {
            const op = previousGoalHashes.has(goal.id) ? "update" : "create";
            writeSse("goal.changed", { id: goal.id, op });
          }
        }
        for (const id of previousGoalHashes.keys()) {
          if (!nextGoalHashes.has(id)) {
            writeSse("goal.changed", { id, op: "delete" });
          }
        }
        previousGoalHashes = nextGoalHashes;

        const nextMilestoneHashes = new Map(
          snapshot.milestones.map((milestone) => [milestone.id, JSON.stringify(milestone)]),
        );
        for (const milestone of snapshot.milestones) {
          if (nextMilestoneHashes.get(milestone.id) !== previousMilestoneHashes.get(milestone.id)) {
            const op = previousMilestoneHashes.has(milestone.id) ? "update" : "create";
            writeSse("milestone.changed", { id: milestone.id, op });
          }
        }
        for (const id of previousMilestoneHashes.keys()) {
          if (!nextMilestoneHashes.has(id)) {
            writeSse("milestone.changed", { id, op: "delete" });
          }
        }
        previousMilestoneHashes = nextMilestoneHashes;

        const nextAgentHashes = new Map(
          snapshot.agents.map((agent) => [agent.paneId, JSON.stringify(agent)]),
        );
        for (const agent of snapshot.agents) {
          if (nextAgentHashes.get(agent.paneId) !== previousAgentHashes.get(agent.paneId)) {
            writeSse("agent.changed", {
              paneId: agent.paneId,
              status: agent.isBusy ? "busy" : "idle",
            });
          }
        }
        previousAgentHashes = nextAgentHashes;

        const events = readEvents(currentSession.dir);
        const effectiveCursor = events.length < eventCursor ? 0 : eventCursor;
        for (const event of events.slice(effectiveCursor)) {
          writeSse("event.appended", event);
        }
        eventCursor = events.length;

        if (snapshotHash !== previousSnapshotHash) {
          writeSse("snapshot", snapshot);
          previousSnapshotHash = snapshotHash;
        }
      }

      function queueChanges(): void {
        if (closed || changeQueued) return;
        changeQueued = true;
        queueMicrotask(() => {
          changeQueued = false;
          const current = discoverSessions().find((candidate) => candidate.name === name);
          if (current) writeChanges(current);
        });
      }

      const onTaskStoreChange = (change: TaskStoreChangeEvent) => {
        if (!isPathInside(change.path, tasksRoot) && change.path !== null) return;
        queueChanges();
      };

      const onEventAppended = (message: { dir: string; event: unknown }) => {
        if (message.dir !== session.dir) return;
        queueChanges();
      };

      try {
        stream.onAbort(() => {
          closed = true;
        });
        taskStore.on("change", onTaskStoreChange);
        eventLogEmitter.on("event", onEventAppended);
        writeSnapshot(session);
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
        closed = true;
        taskStore.off("change", onTaskStoreChange);
        eventLogEmitter.off("event", onEventAppended);
        projectStreamConnections = Math.max(0, projectStreamConnections - 1);
        sseMetrics.connections = projectStreamConnections;
      }
    });
  });

  // LSP endpoints — POST { file, line, column } and return raw LSP-shaped responses.
  // `file` is a workspace-relative path; the daemon sandboxes it under the session
  // directory before handing it to the language server.
  const resolveLspTarget = (
    sessionName: string,
    file: unknown,
  ):
    | { ok: true; root: string; target: string }
    | { ok: false; status: 400 | 403 | 404; error: string } => {
    if (typeof file !== "string" || !file) {
      return { ok: false, status: 400, error: "Missing `file`" };
    }
    if (file.startsWith("/") || file.split("/").some((seg) => seg === ".." || seg === ".")) {
      return { ok: false, status: 403, error: "Path escapes workspace" };
    }
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === sessionName);
    if (!session) return { ok: false, status: 404, error: "Session not found" };
    let root: string;
    try {
      root = realpathSync(session.dir);
    } catch {
      return { ok: false, status: 404, error: "Session directory not accessible" };
    }
    const requested = pathResolve(root, file);
    let target: string;
    try {
      target = realpathSync(requested);
    } catch {
      target = requested;
    }
    if (!target.startsWith(root + "/") && target !== root) {
      return { ok: false, status: 403, error: "Path escapes workspace" };
    }
    return { ok: true, root, target };
  };

  type LspRequestBody = { file?: string; line?: number; column?: number };

  const parseLspPositionBody = (
    raw: unknown,
  ): { ok: true; file: string; line: number; column: number } | { ok: false; error: string } => {
    const body = (raw ?? {}) as LspRequestBody;
    const { file, line, column } = body;
    if (typeof file !== "string" || !file) {
      return { ok: false, error: "Missing `file`" };
    }
    if (typeof line !== "number" || line < 0 || !Number.isFinite(line)) {
      return { ok: false, error: "Missing or invalid `line`" };
    }
    if (typeof column !== "number" || column < 0 || !Number.isFinite(column)) {
      return { ok: false, error: "Missing or invalid `column`" };
    }
    return { ok: true, file, line, column };
  };

  app.post("/api/project/:name/lsp/hover", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseLspPositionBody(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const sandbox = resolveLspTarget(c.req.param("name"), parsed.file);
    if (!sandbox.ok) return c.json({ error: sandbox.error }, sandbox.status);
    const client = await getLspClientForFile(sandbox.root, sandbox.target).catch(
      (err) =>
        ({
          __error: err instanceof Error ? err.message : String(err),
        }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    if (!client) {
      return c.json({ error: "No LSP server registered for this file type" }, 400);
    }
    const hover = await client.hover(sandbox.target, parsed.line, parsed.column);
    return c.json({ hover });
  });

  app.post("/api/project/:name/lsp/definition", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseLspPositionBody(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const sandbox = resolveLspTarget(c.req.param("name"), parsed.file);
    if (!sandbox.ok) return c.json({ error: sandbox.error }, sandbox.status);
    const client = await getLspClientForFile(sandbox.root, sandbox.target).catch(
      (err) =>
        ({
          __error: err instanceof Error ? err.message : String(err),
        }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    if (!client) {
      return c.json({ error: "No LSP server registered for this file type" }, 400);
    }
    const definition = await client.definition(sandbox.target, parsed.line, parsed.column);
    return c.json({ definition });
  });

  app.post("/api/project/:name/lsp/references", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseLspPositionBody(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const sandbox = resolveLspTarget(c.req.param("name"), parsed.file);
    if (!sandbox.ok) return c.json({ error: sandbox.error }, sandbox.status);
    const client = await getLspClientForFile(sandbox.root, sandbox.target).catch(
      (err) =>
        ({
          __error: err instanceof Error ? err.message : String(err),
        }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    if (!client) {
      return c.json({ error: "No LSP server registered for this file type" }, 400);
    }
    const references = await client.references(sandbox.target, parsed.line, parsed.column);
    return c.json({ references });
  });

  // POST /api/project/:name/lsp/diagnostics { file } — opens the file in the LSP,
  // waits briefly for the server to push diagnostics, then returns whatever is
  // currently cached. `line`/`column` are accepted but unused (diagnostics are
  // file-scoped); they are not required.
  app.post("/api/project/:name/lsp/diagnostics", async (c) => {
    let body: LspRequestBody;
    try {
      body = (await c.req.json()) as LspRequestBody;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const sandbox = resolveLspTarget(c.req.param("name"), body?.file);
    if (!sandbox.ok) return c.json({ error: sandbox.error }, sandbox.status);
    const client = await getLspClientForFile(sandbox.root, sandbox.target).catch(
      (err) => ({ __error: err instanceof Error ? err.message : String(err) }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    if (!client) {
      return c.json({ error: "No LSP server registered for this file type" }, 400);
    }
    await client.ensureOpen(sandbox.target);
    const diagnostics = await client.waitForDiagnostics(sandbox.target, 1500);
    return c.json({ diagnostics });
  });

  // POST /api/project/:name/lsp/symbols { query } — workspace-wide symbol
  // search. No file required — the language server is keyed on the session
  // root. The endpoint always boots the typescript server for the workspace;
  // future languages can be added by trying additional registry keys.
  app.post("/api/project/:name/lsp/symbols", async (c) => {
    let body: { query?: unknown };
    try {
      body = (await c.req.json()) as { query?: unknown };
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const query = typeof body?.query === "string" ? body.query : "";
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    let root: string;
    try {
      root = realpathSync(session.dir);
    } catch {
      return c.json({ error: "Session directory not accessible" }, 404);
    }
    const client = await getLspClient(root, "typescript").catch(
      (err) =>
        ({
          __error: err instanceof Error ? err.message : String(err),
        }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    const symbols = await client.workspaceSymbols(query);
    return c.json({ symbols: symbols ?? [] });
  });

  // POST /api/project/:name/lsp/rename { file, line, column, newName }
  //
  // Returns the raw LSP `WorkspaceEdit` describing changes the dashboard
  // should preview + apply. The daemon never writes files itself —
  // the IDE is the source of truth for "do you actually want this edit
  // applied", since rename touches multiple files and may step on
  // unsaved buffer state.
  app.post("/api/project/:name/lsp/rename", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseLspPositionBody(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const newName = (raw as { newName?: unknown })?.newName;
    if (typeof newName !== "string" || !newName.trim()) {
      return c.json({ error: "Missing `newName`" }, 400);
    }
    const sandbox = resolveLspTarget(c.req.param("name"), parsed.file);
    if (!sandbox.ok) return c.json({ error: sandbox.error }, sandbox.status);
    const client = await getLspClientForFile(sandbox.root, sandbox.target).catch(
      (err) =>
        ({
          __error: err instanceof Error ? err.message : String(err),
        }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    if (!client) {
      return c.json({ error: "No LSP server registered for this file type" }, 400);
    }
    const edit = await client.rename(sandbox.target, parsed.line, parsed.column, newName);
    return c.json({ edit });
  });

  // POST /api/project/:name/lsp/codeActions
  //   { file, line, column, endLine?, endColumn? }
  //
  // Returns the LSP `(Command | CodeAction)[]` array for the cursor or
  // selection. End line/column default to start when omitted (point
  // selection). Diagnostics for the file are forwarded as context so
  // the server can return quick-fixes that match the current squigglies.
  app.post("/api/project/:name/lsp/codeActions", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = parseLspPositionBody(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const body = raw as { endLine?: unknown; endColumn?: unknown };
    const endLine =
      typeof body?.endLine === "number" && body.endLine >= 0 ? body.endLine : parsed.line;
    const endColumn =
      typeof body?.endColumn === "number" && body.endColumn >= 0 ? body.endColumn : parsed.column;
    const sandbox = resolveLspTarget(c.req.param("name"), parsed.file);
    if (!sandbox.ok) return c.json({ error: sandbox.error }, sandbox.status);
    const client = await getLspClientForFile(sandbox.root, sandbox.target).catch(
      (err) =>
        ({
          __error: err instanceof Error ? err.message : String(err),
        }) as const,
    );
    if (client && "__error" in client) {
      return c.json({ error: `LSP failed to start: ${client.__error}` }, 500);
    }
    if (!client) {
      return c.json({ error: "No LSP server registered for this file type" }, 400);
    }
    const diagnostics = client.diagnostics(sandbox.target);
    const actions = await client.codeActions(
      sandbox.target,
      {
        start: { line: parsed.line, character: parsed.column },
        end: { line: endLine, character: endColumn },
      },
      diagnostics,
    );
    return c.json({ actions: actions ?? [] });
  });

  app.get("/api/daemon/metrics", (c) => {
    const metrics = getTaskStoreMetrics();
    return c.json({
      uptimeMs: metrics.uptimeMs,
      cache: metrics.cache,
      watcher: metrics.watcher,
      reconcile: metrics.reconcile,
      sse: getSseMetrics(),
      writes: metrics.writes,
      paneContentHash: getPaneContentHashMetrics(),
    });
  });

  app.get("/api/project/:name/orchestrator/health", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    const live = getOrchestratorHealth(name);
    if (live) return c.json(live);

    const tasks = loadTasks(session.dir);
    const panes: ReturnType<typeof listSessionPanes> = (() => {
      try {
        return listSessionPanes(name);
      } catch {
        return [];
      }
    })();
    const inProgress = tasks.filter((task) => task.status === "in-progress");
    const busyAssignees = new Set(inProgress.map((task) => task.assignee).filter(Boolean));
    const idleAgents = panes.filter((pane) => {
      if (pane.role === "lead") return false;
      const agentName = pane.name ?? pane.title;
      return !busyAssignees.has(agentName);
    }).length;

    return c.json({
      ticking: false,
      lastTickMs: 0,
      inflight: inProgress.length,
      idleAgents,
      queuedDispatches: tasks.filter((task) => task.status === "todo").length,
      lastError: null,
      totalDispatched: 0,
      totalCompleted: tasks.filter((task) => task.status === "done").length,
      totalFailed: tasks.filter((task) => task.status === "review").length,
    });
  });

  // --- Remote command execution endpoints ---

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

    appendEvent(session.dir, {
      timestamp: new Date().toISOString(),
      type: "send",
      target: pane.name ?? pane.title,
      paneId: pane.id,
      message: text.length > 100 ? text.slice(0, 100) + "..." : text,
    });

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

    appendEvent(session.dir, {
      timestamp: new Date().toISOString(),
      type: "send",
      target: pane.name ?? pane.title,
      paneId: pane.id,
      message: prepared.length > 100 ? prepared.slice(0, 100) + "..." : prepared,
    });

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

  // GET /api/project/:name/config — read parsed ide.yml + raw text. Used by
  // the v2 Config editor to hydrate the form.
  app.get("/api/project/:name/config", (c) => {
    const name = c.req.param("name");
    const sessions = discoverSessions();
    const session = sessions.find((s) => s.name === name);
    if (!session) return c.json({ error: "Session not found" }, 404);
    try {
      const { config, configPath } = readConfig(session.dir);
      return c.json({ ok: true, config, configPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to read ide.yml", detail: message }, 500);
    }
  });

  // POST /api/project/:name/config — accept a full IdeConfig payload, validate
  // against IdeConfigSchema, and write to ide.yml. Returns the persisted
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
      const configPath = writeConfig(session.dir, parsed.data);
      return c.json({ ok: true, config: parsed.data, configPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Failed to write ide.yml", detail: message }, 500);
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
      let prevDetails = new Map<string, ProjectDetail>();
      const eventCursors = new Map<string, number>(); // session → last-seen event count
      let prevOrchHashes = new Map<string, string>(); // session → orchestrator snapshot hash

      const poll = () => {
        const sessions = discoverSessions();
        const overviews = buildOverviews(sessions);

        // Detect session-level changes
        const prevNames = new Set(prevOverviews.map((s) => s.name));
        const currNames = new Set(overviews.map((s) => s.name));

        for (const overview of overviews) {
          if (!prevNames.has(overview.name)) {
            stream.writeSSE({
              event: "session_added",
              data: JSON.stringify(overview),
            });
            continue;
          }

          const prev = prevOverviews.find((s) => s.name === overview.name);
          if (
            prev &&
            (prev.stats.doneTasks !== overview.stats.doneTasks ||
              prev.stats.totalTasks !== overview.stats.totalTasks ||
              prev.stats.activeAgents !== overview.stats.activeAgents)
          ) {
            stream.writeSSE({
              event: "session_update",
              data: JSON.stringify(overview),
            });
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

        // Per-session: event log cursor + orchestrator state + task/agent diffs
        for (const session of sessions) {
          // Cursor-based event streaming from event log
          const events = readEvents(session.dir);
          const cursor = eventCursors.get(session.name) ?? 0;

          // Handle log rotation: if events.length < cursor, log was rotated
          const effectiveCursor = events.length < cursor ? 0 : cursor;
          const newEvents = events.slice(effectiveCursor);

          for (const evt of newEvents) {
            const eventId = `${evt.timestamp}:${evt.type}:${evt.taskId ?? ""}`;
            stream.writeSSE({
              id: eventId,
              event: "orchestrator_event",
              data: JSON.stringify({ session: session.name, ...evt }),
            });
          }
          eventCursors.set(session.name, events.length);

          // Orchestrator state snapshot (emit only on change)
          const orchSnapshot = buildOrchestratorSnapshot(session);
          const orchHash = JSON.stringify(orchSnapshot);
          const prevHash = prevOrchHashes.get(session.name);
          if (orchHash !== prevHash) {
            stream.writeSSE({
              event: "orchestrator_state",
              data: JSON.stringify({ session: session.name, ...orchSnapshot }),
            });
            prevOrchHashes.set(session.name, orchHash);
          }

          // Task-level and agent-level diffs (existing logic)
          const detail = buildProjectDetail(session);
          const prevDetail = prevDetails.get(session.name);

          if (prevDetail) {
            const prevTaskMap = new Map(prevDetail.tasks.map((t) => [t.id, t]));
            for (const task of detail.tasks) {
              const prevTask = prevTaskMap.get(task.id);
              if (!prevTask) {
                stream.writeSSE({
                  event: "task_update",
                  data: JSON.stringify({
                    session: session.name,
                    taskId: task.id,
                    status: task.status,
                    title: task.title,
                  }),
                });
              } else if (prevTask.status !== task.status || prevTask.assignee !== task.assignee) {
                stream.writeSSE({
                  event: "task_update",
                  data: JSON.stringify({
                    session: session.name,
                    taskId: task.id,
                    status: task.status,
                    assignee: task.assignee,
                  }),
                });
              }
            }

            // Detect agent status changes
            const prevAgentMap = new Map(prevDetail.agents.map((a) => [a.paneTitle, a]));
            for (const agent of detail.agents) {
              const prevAgent = prevAgentMap.get(agent.paneTitle);
              if (!prevAgent || prevAgent.isBusy !== agent.isBusy) {
                stream.writeSSE({
                  event: "agent_status",
                  data: JSON.stringify({
                    session: session.name,
                    agent: agent.paneTitle,
                    busy: agent.isBusy,
                    taskId: agent.taskId,
                  }),
                });
              }
            }
          }

          prevDetails.set(session.name, detail);
        }

        prevOverviews = overviews;
      };

      // Initial snapshot
      poll();

      // Poll every 2 seconds
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

  // --- HQ endpoints ---

  const remoteRegistry = options.remoteRegistry ?? null;

  app.post("/api/hq/register", async (c) => {
    if (!remoteRegistry) return c.json({ error: "HQ registry not enabled" }, 501);
    const body = await c.req.json();
    const parsed = RegistrationPayloadSchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "Invalid payload", details: parsed.error.issues }, 400);
    try {
      const machine = remoteRegistry.register(parsed.data);
      return c.json({
        ok: true,
        id: machine.id,
        name: machine.name,
        registeredAt: machine.registeredAt.toISOString(),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  app.get("/api/hq/machines", (c) => {
    if (!remoteRegistry) return c.json({ machines: [] });
    const machines = remoteRegistry.getMachines().map((m) => ({
      id: m.id,
      name: m.name,
      url: m.url,
      registeredAt: m.registeredAt.toISOString(),
      lastHeartbeat: m.lastHeartbeat.toISOString(),
      sessions: Array.from(m.sessionIds),
    }));
    return c.json({ machines });
  });

  app.get("/api/hq/machines/:id", (c) => {
    if (!remoteRegistry) return c.json({ error: "HQ registry not enabled" }, 501);
    const machine = remoteRegistry.getMachine(c.req.param("id"));
    if (!machine) return c.json({ error: "Machine not found" }, 404);
    return c.json({
      id: machine.id,
      name: machine.name,
      url: machine.url,
      registeredAt: machine.registeredAt.toISOString(),
      lastHeartbeat: machine.lastHeartbeat.toISOString(),
      sessions: Array.from(machine.sessionIds),
    });
  });

  app.delete("/api/hq/machines/:id", (c) => {
    if (!remoteRegistry) return c.json({ error: "HQ registry not enabled" }, 501);
    const removed = remoteRegistry.unregister(c.req.param("id"));
    if (!removed) return c.json({ error: "Machine not found" }, 404);
    return c.json({ ok: true });
  });

  // --- Unified agent view ---

  // Every Claude/codex agent on THIS host: tmux-discovered panes (managed +
  // unmanaged) merged with hook-registered external sessions. machineId/Name
  // stay null here — HQ stamps them when aggregating across hosts.
  function localAgents(): AgentRecord[] {
    const managed = new Set(
      getDefaultWorkspaceRegistry()
        .list()
        .map((w) => w.sessionName),
    );
    const tmuxAgents = discoverTmuxAgents(managed);
    const external = getDefaultExternalAgentRegistry().list();
    return mergeLocalAgents(tmuxAgents, external);
  }

  app.get("/api/agents", (c) => {
    const payload = AgentListSchemaZ.parse({ agents: localAgents() });
    return c.json(payload);
  });

  // Aggregated view across HQ-registered machines. Always includes this
  // host's local agents (stamped with this host's machine name). When acting
  // as HQ, fans out to each remote's /api/agents and namespaces ids by
  // machine id. Machines that error or time out are skipped.
  app.get("/api/hq/agents", async (c) => {
    const selfName = options.hqMachineName ?? hostname();
    let remotes: RemoteAgentSource[] = [];

    if (remoteRegistry) {
      const fanout = remoteRegistry
        .getMachines()
        .map(async (machine): Promise<RemoteAgentSource | null> => {
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 5_000);
            const res = await fetch(`${machine.url}/api/agents`, {
              headers: { Authorization: `Bearer ${machine.token}` },
              signal: controller.signal,
            });
            clearTimeout(tid);
            if (!res.ok) return null;
            const parsed = AgentListSchemaZ.safeParse(await res.json());
            if (!parsed.success) return null;
            return { machineId: machine.id, machineName: machine.name, agents: parsed.data.agents };
          } catch {
            // Skip unreachable / slow machines — don't fail the whole response.
            return null;
          }
        });
      remotes = (await Promise.all(fanout)).filter((r): r is RemoteAgentSource => r !== null);
    }

    const agents = aggregateHqAgents(localAgents(), selfName, remotes);
    return c.json(AgentListSchemaZ.parse({ agents }));
  });

  // --- Tunnel endpoints ---

  const tunnelManager = options.tunnelManager ?? null;

  app.get("/api/tunnel", async (c) => {
    if (!tunnelManager) return c.json({ running: false, provider: null });
    const status = await tunnelManager.status();
    return c.json(status);
  });

  app.post("/api/tunnel/start", async (c) => {
    if (!tunnelManager) return c.json({ error: "Tunnel manager not configured" }, 501);
    const body = await c.req.json().catch(() => ({}));
    const { tunnelConfigSchema } = await import("../lib/tunnels/types.ts");
    const parsed = tunnelConfigSchema.safeParse(body);
    if (!parsed.success)
      return c.json({ error: "Invalid tunnel config", details: parsed.error.issues }, 400);
    const status = await tunnelManager.start(parsed.data);
    return c.json(status);
  });

  app.post("/api/tunnel/stop", async (c) => {
    if (!tunnelManager) return c.json({ error: "Tunnel manager not configured" }, 501);
    await tunnelManager.stop();
    return c.json({ ok: true });
  });

  // Health check for daemon liveness probes
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      uptime: Math.round(process.uptime()),
      version: pkgVersion,
    });
  });

  // --- Project registry ---

  app.get("/api/projects", (c) => {
    return c.json({ projects: listProjects() });
  });

  app.get("/api/projects/templates", (c) => {
    return c.json({ templates: listAvailableTemplates() });
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
      return c.json({ project }, 201);
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

  app.get("/api/filesystem/browse", (c) => {
    const rawPath = c.req.query("path");
    const showHiddenRaw = c.req.query("showHidden");
    const showHidden = showHiddenRaw === "1" || showHiddenRaw === "true";
    try {
      const result = browseDirectory({
        path: rawPath ?? null,
        showHidden,
      });
      return c.json(result);
    } catch (err) {
      if (err instanceof SandboxViolationError) {
        return c.json({ error: "outside-sandbox", message: err.message }, 403);
      }
      if (err instanceof PathNotFoundError) {
        return c.json({ error: "not-found", message: err.message }, 404);
      }
      if (err instanceof InvalidPathError) {
        return c.json({ error: "invalid-path", message: err.message }, 400);
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
      return c.json({ project });
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
  // POST /api/projects/onboard   — generate ide.yml + register the project.
  // -------------------------------------------------------------------------

  app.post("/api/filesystem/inspect", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid-path", message: "Invalid JSON body" }, 400);
    }
    const parsed = InspectFilesystemRequestSchemaZ.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid-path", message: "Invalid request" }, 400);
    }
    const sandboxResult = sandboxResolveDir(parsed.data.dir);
    if ("error" in sandboxResult) {
      return c.json(
        { error: sandboxResult.error, message: sandboxResult.message },
        sandboxResult.status,
      );
    }
    try {
      const project = await inspectProject(sandboxResult.canonical);
      return c.json({ project });
    } catch (err) {
      if (err instanceof InspectDirNotFoundError) {
        return c.json({ error: "not-found", message: err.message }, 404);
      }
      throw err;
    }
  });

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

    // Never overwrite an existing ide.yml.
    try {
      assertNoExistingIdeYml(dir);
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
      return c.json({ project }, 201);
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

  // Notes feature — per-project markdown scratchpad. See
  // docs/feature-framework.md for the 7-file pattern this exemplifies.
  attachNotesRoutes(app, {
    resolveSession(name) {
      return discoverSessions().find((s) => s.name === name) ?? null;
    },
  });

  // Serve the Next.js static dashboard for all non-API routes
  app.use("*", serveDashboard());

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
export function attachWsEvents(server: import("node:http").Server): {
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
      handleWsEventsConnection(ws);
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
