/**
 * Unified push channel for the dashboard — single WebSocket carrying
 * task / mission / milestone / goal / agent / event-log changes for one
 * or more sessions, replacing a fan of SSE streams.
 *
 * Endpoint: `/ws/events` (mounted by the daemon's HTTP server).
 *
 * Wire protocol: see `src/schemas/ws-events.ts`.
 */

import type { RawData, WebSocket } from "ws";
import { discoverSessions, buildOverviews, buildProjectDetail } from "./discovery.ts";
import { subscribeFsChanges } from "./fs-watch.ts";
import { taskStore, loadMission, loadTasks, type TaskStoreChangeEvent } from "../lib/task-store.ts";
import { readEvents, eventLogEmitter, type OrchestratorEvent } from "../lib/event-log.ts";
import { loadValidationState } from "../lib/validation.ts";
import { loadSkills } from "../lib/skill-registry.ts";
import { projectRegistryEmitter } from "../lib/project-registry.ts";
import { getDefaultWorkspaceRegistry } from "../lib/workspace-registry.ts";
import type { ServerFrame, ClientFrame } from "../schemas/ws-events.ts";
import type { ChatEvent } from "../chat/types.ts";
import type { Workspace } from "@tmux-ide/contracts";

const WS_OPEN = 1;
const KEEPALIVE_INTERVAL_MS = 25_000;
const SESSIONS_POLL_MS = 2_000;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: RawData | string, isBinary: boolean) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  off?(event: string, listener: (...args: unknown[]) => void): this;
  removeListener?(event: string, listener: (...args: unknown[]) => void): this;
}

interface SessionListener {
  taskListener: (change: TaskStoreChangeEvent) => void;
  eventListener: (message: { dir: string; event: OrchestratorEvent }) => void;
  /** Unsubscribe hook from the per-session chokidar watcher. */
  fsUnsubscribe: () => void;
}

// Module-level globals for cross-connection broadcasts (sessions.changed,
// projects.changed, init.* job updates). All clients receive these — the
// dashboard filters init.* frames by jobId on its end.
interface ClientHandle {
  broadcastSessionsChanged(): void;
  broadcastProjectsChanged(): void;
  broadcastInitOutput(jobId: string, chunk: string, done?: boolean): void;
  broadcastInitError(jobId: string, message: string): void;
  broadcastActionComplete(name: string, result: unknown): void;
  broadcastSkillsChanged(sessionName: string): void;
  broadcastValidationChanged(sessionName: string): void;
  broadcastConfigChanged(sessionName: string): void;
  broadcastChatEvent(event: ChatEvent): void;
  broadcastTerminalsChanged(sessionName: string): void;
}
const allClients = new Set<ClientHandle>();

// ---------------------------------------------------------------------------
// Chat timeline replay log (Step 2: WS reconnect/resume).
//
// Every materialized timeline frame is the server's authoritative truth
// (Step 1 made the client a pure renderer). We stamp each with a
// monotonic per-thread `seq` at this single broadcast choke point and
// retain a bounded per-thread buffer. On `chat.subscribe { threadId,
// lastSeq }` we replay the buffered frames with `seq > lastSeq` in
// order, then live frames continue (they are already broadcast to all
// clients). A `chat.timeline.reset` is a new baseline — it supersedes
// every earlier buffered frame, so the buffer is cleared on reset and a
// fresh client (lastSeq 0) always resumes from a wholesale snapshot:
// gap-free, dupe-free, idempotent by row id.
// ---------------------------------------------------------------------------

interface BufferedChatFrame {
  seq: number;
  frame: ServerFrame;
}

const CHAT_REPLAY_CAP_PER_THREAD = 1024;
const chatSeqByThread = new Map<string, number>();
const chatReplayByThread = new Map<string, BufferedChatFrame[]>();

function isChatTimelineFrame(
  event: ChatEvent,
): event is Extract<ChatEvent, { type: "chat.timeline.upsert" | "chat.timeline.reset" }> {
  return event.type === "chat.timeline.upsert" || event.type === "chat.timeline.reset";
}

/**
 * Stamp a per-thread `seq` onto a materialized timeline frame and append
 * it to the bounded replay buffer. Mutates the event in place — this is
 * the single sink every chat broadcast flows through, so all clients +
 * the buffer observe the same seq. Non-timeline chat events pass through
 * untouched (they are not part of the resumable transcript).
 */
function recordChatTimelineFrame(event: ChatEvent): void {
  if (!isChatTimelineFrame(event)) return;
  const threadId = event.threadId;
  const seq = (chatSeqByThread.get(threadId) ?? 0) + 1;
  chatSeqByThread.set(threadId, seq);
  event.seq = seq;
  let buf = chatReplayByThread.get(threadId);
  if (!buf) {
    buf = [];
    chatReplayByThread.set(threadId, buf);
  }
  // A reset re-baselines the thread: every earlier buffered frame is
  // superseded, so drop them and start the buffer at this snapshot.
  if (event.type === "chat.timeline.reset") buf.length = 0;
  buf.push({ seq, frame: event as ServerFrame });
  if (buf.length > CHAT_REPLAY_CAP_PER_THREAD) {
    buf.splice(0, buf.length - CHAT_REPLAY_CAP_PER_THREAD);
  }
}

/**
 * Replay the buffered materialized timeline frames for `threadId` with
 * `seq > lastSeq`, in order, to a single (re)subscribing socket. Because
 * a reset clears the buffer, a fresh client (`lastSeq` 0) always gets a
 * wholesale baseline first — no gap, no duplicate, idempotent by id.
 */
function replayChatTimelineSince(
  threadId: string,
  lastSeq: number,
  send: (frame: ServerFrame) => void,
): void {
  const buf = chatReplayByThread.get(threadId);
  if (!buf) return;
  for (const entry of buf) {
    if (entry.seq > lastSeq) send(entry.frame);
  }
}

/**
 * Test-only: drop the chat replay log so e2e/unit suites don't bleed
 * sequence state across cases.
 */
export function _resetChatReplayForTests(): void {
  chatSeqByThread.clear();
  chatReplayByThread.clear();
}

let sessionsPollTimer: ReturnType<typeof setInterval> | null = null;
let lastSessionsHash = "";
let projectRegistryListener: (() => void) | null = null;

function snapshotSessionsHash(): string {
  try {
    return JSON.stringify(
      discoverSessions()
        .map((s) => s.name)
        .sort(),
    );
  } catch {
    return "";
  }
}

function ensureSessionsPoller(): void {
  if (sessionsPollTimer) return;
  lastSessionsHash = snapshotSessionsHash();
  sessionsPollTimer = setInterval(() => {
    const hash = snapshotSessionsHash();
    if (hash === lastSessionsHash) return;
    lastSessionsHash = hash;
    for (const client of allClients) client.broadcastSessionsChanged();
  }, SESSIONS_POLL_MS);
  sessionsPollTimer.unref?.();
}

function maybeStopSessionsPoller(): void {
  if (allClients.size > 0 || !sessionsPollTimer) return;
  clearInterval(sessionsPollTimer);
  sessionsPollTimer = null;
}

/**
 * Subscribe (lazily) to the project-registry emitter and fan changes out to
 * every connected ws client. The listener is registered on the first client
 * and removed when the last one disconnects so we never leak.
 */
function ensureProjectRegistryListener(): void {
  if (projectRegistryListener) return;
  const listener = (): void => {
    for (const client of allClients) client.broadcastProjectsChanged();
  };
  projectRegistryListener = listener;
  projectRegistryEmitter.on("change", listener);
}

function maybeStopProjectRegistryListener(): void {
  if (allClients.size > 0 || !projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
}

/**
 * Push an `init.output` chunk to every connected client. Called by the
 * REST handler that runs `tmux-ide init`; clients filter by `jobId`.
 */
export function broadcastInitOutput(jobId: string, chunk: string, done?: boolean): void {
  for (const client of allClients) client.broadcastInitOutput(jobId, chunk, done);
}

/**
 * Push an `init.error` frame to every connected client.
 */
export function broadcastInitError(jobId: string, message: string): void {
  for (const client of allClients) client.broadcastInitError(jobId, message);
}

/**
 * Push an `action.complete` frame to every connected client. Called by the
 * v2 action dispatcher after a handler succeeds — clients use it to
 * invalidate caches without polling.
 */
export function broadcastActionComplete(name: string, result: unknown): void {
  for (const client of allClients) client.broadcastActionComplete(name, result);
}

export function broadcastSkillsChanged(sessionName: string): void {
  for (const client of allClients) client.broadcastSkillsChanged(sessionName);
}

export function broadcastValidationChanged(sessionName: string): void {
  for (const client of allClients) client.broadcastValidationChanged(sessionName);
}

export function broadcastConfigChanged(sessionName: string): void {
  for (const client of allClients) client.broadcastConfigChanged(sessionName);
}

export function broadcastTerminalsChanged(sessionName: string): void {
  for (const client of allClients) client.broadcastTerminalsChanged(sessionName);
}

export function broadcastChatEvent(event: ChatEvent): void {
  // Stamp seq + buffer (timeline frames only) BEFORE fan-out so every
  // live client and the replay buffer share the same sequence.
  recordChatTimelineFrame(event);
  for (const client of allClients) client.broadcastChatEvent(event);
}

function rawDataToText(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as Uint8Array).toString("utf8");
}

function isPathInside(path: string | null | undefined, root: string): boolean {
  if (!path) return false;
  return path === root || path.startsWith(root + "/");
}

function classifyTaskStorePath(
  change: TaskStoreChangeEvent,
  sessionDir: string,
): "task" | "mission" | "goal" | "milestone" | null {
  const path = change.path;
  if (!path) return null;
  if (!isPathInside(path, sessionDir)) return null;
  // Schema name is the most reliable signal when available.
  if (change.schemaName === "task") return "task";
  if (change.schemaName === "goal") return "goal";
  if (change.schemaName === "mission") return "mission";
  // Path-based fallback. mission.json contains milestones, so treat
  // mission writes as both mission and milestone changes — the dashboard
  // is happy to receive both.
  if (path.includes("/.tasks/tasks/")) return "task";
  if (path.includes("/.tasks/goals/")) return "goal";
  if (path.endsWith("/.tasks/mission.json")) return "mission";
  return null;
}

/**
 * Build the snapshot payload pushed to a client when they subscribe to a
 * session. Mirrors `buildProjectStreamSnapshot` in server.ts so the SSE and
 * WS channels stay observationally equivalent during the migration.
 */
export function buildSessionSnapshot(sessionName: string): unknown | null {
  const session = discoverSessions().find((s) => s.name === sessionName);
  if (!session) return null;

  const project = buildProjectDetail(session);
  const mission = loadMission(session.dir);
  const tasks = loadTasks(session.dir);
  const milestones = mission
    ? [...mission.milestones]
        .sort((a, b) => a.order - b.order)
        .map((milestone) => {
          const milestoneTasks = tasks.filter((t) => t.milestone === milestone.id);
          return {
            ...milestone,
            taskCount: milestoneTasks.length,
            tasksDone: milestoneTasks.filter((t) => t.status === "done").length,
          };
        })
    : [];

  const valState = loadValidationState(session.dir);
  const assertions = valState ? Object.values(valState.assertions) : [];
  const validationSummary = {
    total: assertions.length,
    passing: assertions.filter((a) => a.status === "passing").length,
    failing: assertions.filter((a) => a.status === "failing").length,
    pending: assertions.filter((a) => a.status === "pending").length,
    blocked: assertions.filter((a) => a.status === "blocked").length,
  };

  return {
    project,
    mission: mission ? { mission, validationSummary } : null,
    milestones,
    goals: project.goals,
    tasks: project.tasks,
    skills: loadSkills(session.dir),
    agents: project.agents,
    events: readEvents(session.dir).slice(-100).reverse(),
  };
}

/**
 * Wire a single WebSocket connection. Tracks per-session subscriptions,
 * forwards `taskStore` and `eventLogEmitter` events to the client (filtered
 * by subscription), and tears all listeners down on close — no leaks.
 */
export function handleWsEventsConnection(socket: WebSocket | WsLike): void {
  const ws = socket as WsLike;
  // sessionName → listener pair on taskStore + eventLogEmitter
  const subscriptions = new Map<string, SessionListener>();
  // sessionName → resolved dir at subscribe time. Used to filter
  // path-scoped change events.
  const sessionDirs = new Map<string, string>();
  let closed = false;

  const send = (frame: ServerFrame): void => {
    if (closed || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // peer went away mid-send; close path will clean up
    }
  };

  const broadcastSessionsChanged = (): void => {
    send({ type: "sessions.changed" });
  };

  const broadcastProjectsChanged = (): void => {
    send({ type: "projects.changed" });
  };

  const broadcastInitOutputForClient = (jobId: string, chunk: string, done?: boolean): void => {
    const frame: ServerFrame =
      done === undefined
        ? { type: "init.output", jobId, chunk }
        : { type: "init.output", jobId, chunk, done };
    send(frame);
  };

  const broadcastInitErrorForClient = (jobId: string, message: string): void => {
    send({ type: "init.error", jobId, message });
  };

  const broadcastActionCompleteForClient = (name: string, result: unknown): void => {
    send({ type: "action.complete", name, result });
  };

  const broadcastSkillsChangedForClient = (sessionName: string): void => {
    send({ type: "skills.changed", sessionName });
  };

  const broadcastValidationChangedForClient = (sessionName: string): void => {
    send({ type: "validation.changed", sessionName });
  };

  const broadcastConfigChangedForClient = (sessionName: string): void => {
    send({ type: "config.changed", sessionName });
  };

  const broadcastChatEventForClient = (event: ChatEvent): void => {
    send(event as ServerFrame);
  };

  const broadcastTerminalsChangedForClient = (sessionName: string): void => {
    send({ type: "terminals.changed", sessionName } as ServerFrame);
  };

  // Per-connection subscription to the current workspace-registry singleton.
  // Resolved at connection time so test overrides via
  // `_setDefaultWorkspaceRegistryForTests` are picked up. Cleaned up on close.
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  const unsubWorkspaceAdded = workspaceRegistry.on("workspace.added", (workspace) =>
    send({ type: "workspace.added", workspace: workspace as Workspace }),
  );
  const unsubWorkspaceRemoved = workspaceRegistry.on("workspace.removed", (name) =>
    send({ type: "workspace.removed", name: name as string }),
  );

  // Track this client globally for "sessions.changed" / "projects.changed"
  // / init.* / action.complete broadcasts.
  const clientHandle: ClientHandle = {
    broadcastSessionsChanged,
    broadcastProjectsChanged,
    broadcastInitOutput: broadcastInitOutputForClient,
    broadcastInitError: broadcastInitErrorForClient,
    broadcastActionComplete: broadcastActionCompleteForClient,
    broadcastSkillsChanged: broadcastSkillsChangedForClient,
    broadcastValidationChanged: broadcastValidationChangedForClient,
    broadcastConfigChanged: broadcastConfigChangedForClient,
    broadcastChatEvent: broadcastChatEventForClient,
    broadcastTerminalsChanged: broadcastTerminalsChangedForClient,
  };
  allClients.add(clientHandle);
  ensureSessionsPoller();
  ensureProjectRegistryListener();

  // Server-initiated keepalive — mirrors the SSE behavior so middle-boxes
  // don't reap the connection.
  const keepalive = setInterval(() => {
    send({ type: "pong" });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  const subscribe = (sessionName: string): void => {
    if (subscriptions.has(sessionName)) return;

    const session = discoverSessions().find((s) => s.name === sessionName);
    const dir = session?.dir ?? null;
    if (dir) sessionDirs.set(sessionName, dir);

    const taskListener = (change: TaskStoreChangeEvent): void => {
      const knownDir = sessionDirs.get(sessionName);
      if (!knownDir) return;
      const kind = classifyTaskStorePath(change, knownDir);
      if (!kind) return;
      // mission.json drives milestones too — emit both.
      if (kind === "mission") {
        send({ type: "mission.changed", sessionName });
        send({ type: "milestone.changed", sessionName });
        return;
      }
      if (kind === "task") send({ type: "task.changed", sessionName });
      else if (kind === "goal") send({ type: "goal.changed", sessionName });
      else if (kind === "milestone") send({ type: "milestone.changed", sessionName });
    };

    const eventListener = (message: { dir: string; event: OrchestratorEvent }): void => {
      const knownDir = sessionDirs.get(sessionName);
      if (!knownDir || message.dir !== knownDir) return;
      send({ type: "event.appended", sessionName, event: message.event });
    };

    taskStore.on("change", taskListener);
    eventLogEmitter.on("event", eventListener);

    // FS-watch — fan chokidar events to `file.changed` frames so
    // the dashboard's buffer-store can reseed open buffers when
    // files are rewritten externally.
    const fsUnsubscribe = dir
      ? subscribeFsChanges(dir, (event) => {
          send({
            type: "file.changed",
            sessionName,
            path: event.path,
            kind: event.kind,
          });
        })
      : () => {};

    subscriptions.set(sessionName, { taskListener, eventListener, fsUnsubscribe });

    // Push initial snapshot so the dashboard doesn't have to poll on connect.
    if (session) {
      const data = buildSessionSnapshot(sessionName);
      if (data) {
        send({
          type: "snapshot",
          sessionName,
          data: data as Record<string, unknown>,
        });
      }
    }
  };

  const unsubscribe = (sessionName: string): void => {
    const entry = subscriptions.get(sessionName);
    if (!entry) return;
    taskStore.off("change", entry.taskListener);
    eventLogEmitter.off("event", entry.eventListener);
    try {
      entry.fsUnsubscribe();
    } catch {
      /* watcher already torn down */
    }
    subscriptions.delete(sessionName);
    sessionDirs.delete(sessionName);
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    allClients.delete(clientHandle);
    for (const [name, entry] of subscriptions) {
      taskStore.off("change", entry.taskListener);
      eventLogEmitter.off("event", entry.eventListener);
      try {
        entry.fsUnsubscribe();
      } catch {
        /* watcher already torn down */
      }
      sessionDirs.delete(name);
    }
    subscriptions.clear();
    unsubWorkspaceAdded();
    unsubWorkspaceRemoved();
    maybeStopSessionsPoller();
    maybeStopProjectRegistryListener();
  };

  ws.on("message", (data) => {
    if (closed) return;
    let parsed: ClientFrame | null = null;
    try {
      const obj = JSON.parse(rawDataToText(data));
      if (obj && typeof obj === "object" && typeof (obj as { type?: unknown }).type === "string") {
        parsed = obj as ClientFrame;
      }
    } catch {
      return; // ignore non-JSON / malformed frames
    }
    if (!parsed) return;

    if (parsed.type === "subscribe") {
      for (const name of parsed.sessions) subscribe(name);
      return;
    }
    if (parsed.type === "unsubscribe") {
      for (const name of parsed.sessions) unsubscribe(name);
      return;
    }
    if (parsed.type === "ping") {
      send({ type: "pong" });
      return;
    }
    if (parsed.type === "chat.subscribe") {
      // Resume: replay the materialized timeline frames this socket
      // missed (seq > lastSeq), in order, then live frames continue
      // via the global broadcast. lastSeq omitted ⇒ 0 ⇒ full replay.
      replayChatTimelineSince(parsed.threadId, parsed.lastSeq ?? 0, send);
      return;
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);

  // Send the initial hello — caller knows which sessions exist without
  // a separate REST round-trip.
  try {
    const sessions = discoverSessions();
    send({ type: "hello", sessions: buildOverviews(sessions) });
  } catch {
    send({ type: "hello", sessions: [] });
  }
}

/**
 * Test-only hook to shut down the global sessions poller. The handler also
 * stops it automatically when the last client disconnects, but tests that
 * never connect a client may need to assert no timer leak.
 */
export function _stopSessionsPollerForTests(): void {
  if (!sessionsPollTimer) return;
  clearInterval(sessionsPollTimer);
  sessionsPollTimer = null;
}

/**
 * Test-only hook to detach the registry listener. Mirrors the sessions
 * poller helper so tests can assert no listener leak across cases.
 */
export function _detachProjectRegistryListenerForTests(): void {
  if (!projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
}
