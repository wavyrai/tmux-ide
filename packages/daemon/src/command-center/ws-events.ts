/**
 * Unified push channel for clients — single WebSocket carrying session,
 * workspace, project-registry, terminal, and config change signals.
 *
 * Endpoint: `/ws/events` (mounted by the daemon's HTTP server).
 *
 * Wire protocol: see `src/schemas/ws-events.ts`.
 *
 * The orchestrator/task/chat event feed moved out of tmux-ide (agent
 * coordination now lives in sfora.ai), so this channel only carries
 * session-control signals.
 */

import type { RawData, WebSocket } from "ws";
import { discoverSessions, buildOverviews, buildProjectDetail } from "./discovery.ts";
import { projectRegistryEmitter } from "../lib/project-registry.ts";
import { getDefaultWorkspaceRegistry } from "../lib/workspace-registry.ts";
import type { ServerFrame, ClientFrame } from "../schemas/ws-events.ts";
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

// Module-level globals for cross-connection broadcasts (sessions.changed,
// projects.changed, init.* job updates). All clients receive these.
interface ClientHandle {
  broadcastSessionsChanged(): void;
  broadcastProjectsChanged(): void;
  broadcastInitOutput(jobId: string, chunk: string, done?: boolean): void;
  broadcastInitError(jobId: string, message: string): void;
  broadcastActionComplete(name: string, result: unknown): void;
  broadcastConfigChanged(sessionName: string): void;
  broadcastTerminalsChanged(sessionName: string): void;
}
const allClients = new Set<ClientHandle>();

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

export function broadcastConfigChanged(sessionName: string): void {
  for (const client of allClients) client.broadcastConfigChanged(sessionName);
}

export function broadcastTerminalsChanged(sessionName: string): void {
  for (const client of allClients) client.broadcastTerminalsChanged(sessionName);
}

function rawDataToText(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data as Uint8Array).toString("utf8");
}

/**
 * Build the snapshot payload pushed to a client when they subscribe to a
 * session — the live project + pane state.
 */
export function buildSessionSnapshot(sessionName: string): unknown | null {
  const session = discoverSessions().find((s) => s.name === sessionName);
  if (!session) return null;
  return { project: buildProjectDetail(session) };
}

/**
 * Wire a single WebSocket connection. Tracks per-session subscriptions and
 * tears all listeners down on close — no leaks.
 */
export function handleWsEventsConnection(socket: WebSocket | WsLike): void {
  const ws = socket as WsLike;
  const subscriptions = new Set<string>();
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

  const broadcastConfigChangedForClient = (sessionName: string): void => {
    send({ type: "config.changed", sessionName });
  };

  const broadcastTerminalsChangedForClient = (sessionName: string): void => {
    send({ type: "terminals.changed", sessionName } as ServerFrame);
  };

  // Per-connection subscription to the current workspace-registry singleton.
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  const unsubWorkspaceAdded = workspaceRegistry.on("workspace.added", (workspace) =>
    send({ type: "workspace.added", workspace: workspace as Workspace }),
  );
  const unsubWorkspaceRemoved = workspaceRegistry.on("workspace.removed", (name) =>
    send({ type: "workspace.removed", name: name as string }),
  );

  const clientHandle: ClientHandle = {
    broadcastSessionsChanged,
    broadcastProjectsChanged,
    broadcastInitOutput: broadcastInitOutputForClient,
    broadcastInitError: broadcastInitErrorForClient,
    broadcastActionComplete: broadcastActionCompleteForClient,
    broadcastConfigChanged: broadcastConfigChangedForClient,
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
    subscriptions.add(sessionName);
    if (session) {
      const data = buildSessionSnapshot(sessionName);
      if (data) {
        send({ type: "snapshot", sessionName, data: data as Record<string, unknown> });
      }
    }
  };

  const unsubscribe = (sessionName: string): void => {
    subscriptions.delete(sessionName);
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    allClients.delete(clientHandle);
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
 * Test-only hook to shut down the global sessions poller.
 */
export function _stopSessionsPollerForTests(): void {
  if (!sessionsPollTimer) return;
  clearInterval(sessionsPollTimer);
  sessionsPollTimer = null;
}

/**
 * Test-only hook to detach the registry listener.
 */
export function _detachProjectRegistryListenerForTests(): void {
  if (!projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
}
