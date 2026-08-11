/**
 * Unified push channel for clients — single WebSocket carrying session,
 * workspace, project-registry, terminal, and config change signals.
 *
 * Endpoint: `/ws/events` (mounted by the daemon's HTTP server).
 *
 * Wire protocol: see `packages/contracts/src/daemon-events.ts`.
 *
 * The orchestrator/task/chat event feed moved out of tmux-ide (agent
 * coordination now lives in sfora.ai), so this channel only carries
 * session-control signals.
 */

import type { RawData, WebSocket } from "ws";
import {
  discoverSessions,
  buildOverviews,
  buildProjectDetail,
  readAdoptedSessionNames,
  readAgentStatesBySession,
} from "./discovery.ts";
import { AgentStatusWatcher, type AgentTurnCompletion } from "./agent-status-watch.ts";
import { agentIdForPaneStamp } from "./resources/application-shell.ts";
import { projectRegistryEmitter } from "../lib/project-registry.ts";
import { getDefaultWorkspaceRegistry } from "../lib/workspace-registry.ts";
import {
  DaemonEventClientFrameSchemaZ,
  DaemonEventResourceChangedFrameSchemaZ,
  InteractionReceiptSchemaZ,
  TerminalAttachmentSemanticPaneIdSchemaZ,
  type DaemonEventAgentTurnCompletedFrame,
  type DaemonEventClientFrame,
  type DaemonEventResourceChangedFrame,
  type DaemonEventResourceInterest,
  type DaemonEventResourceKind,
  type DaemonEventServerFrame,
  type DaemonEventWorkspacePromotionCompletedFrame,
  type DaemonInstanceIdentity,
  type InteractionReceipt,
  type InteractionOrigin,
  type InteractionSafeSummary,
  type DaemonSessionSnapshot,
  type Workspace,
} from "@tmux-ide/contracts";
import {
  WorkspaceResourceObserver,
  isObservableWorkspaceResource,
} from "./workspace-resource-observer.ts";

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
  broadcastAgentStatusChanged(sessionName: string): void;
  broadcastAgentTurnCompleted(frame: DaemonEventAgentTurnCompletedFrame): void;
  broadcastWorkspacePromotionCompleted(frame: DaemonEventWorkspacePromotionCompletedFrame): void;
  broadcastFleetChanged(): void;
  broadcastResourceChanged(frame: DaemonEventResourceChangedFrame): void;
  broadcastInteractionReceipt(frame: InteractionReceipt): void;
}
const allClients = new Set<ClientHandle>();

const RESOURCE_EVENT_JOURNAL_LIMIT = 256;
let resourceEventGeneration: string | null = null;
let resourceEventSequence = 0;
type ReplayableDaemonEventFrame = DaemonEventResourceChangedFrame | InteractionReceipt;
let resourceEventJournal: ReplayableDaemonEventFrame[] = [];
const resourceRevisions = new Map<string, number>();

function useResourceEventGeneration(instanceId: string): void {
  if (resourceEventGeneration === instanceId) return;
  void workspaceResourceObserver?.dispose();
  workspaceResourceObserver = null;
  resourceEventGeneration = instanceId;
  resourceEventSequence = 0;
  resourceEventJournal = [];
  resourceRevisions.clear();
}

function resourceRevisionKey(
  workspaceName: string | null,
  resource: DaemonEventResourceKind,
): string {
  return `${workspaceName === null ? "global" : `workspace\0${workspaceName}`}\0${resource}`;
}

function resourceInterestKey(interest: DaemonEventResourceInterest): string {
  return resourceRevisionKey(interest.workspaceName, interest.resource);
}

export interface ResourceChangedBroadcast {
  readonly workspaceName: string | null;
  readonly resource: DaemonEventResourceKind;
  /** Uses the next daemon-scoped resource revision when omitted. */
  readonly revision?: number;
  readonly causeOperationId?: string | null;
}

/**
 * Record and broadcast one scoped invalidation. The journal and sequence are
 * tied to the supplied daemon instance id, so a restarted daemon can never
 * replay frames from its predecessor.
 */
export function broadcastResourceChanged(
  change: ResourceChangedBroadcast,
  daemonInstanceId: string,
): DaemonEventResourceChangedFrame {
  useResourceEventGeneration(daemonInstanceId);
  const key = resourceRevisionKey(change.workspaceName, change.resource);
  const previousRevision = resourceRevisions.get(key) ?? 0;
  // A domain revision (for example AppWindow documentRevision) is a useful
  // lower bound, not the resource projection's whole clock: pane creation and
  // tmux mutations also change application-shell. Always advance strictly so
  // mixed mutation kinds can never emit an equal or backwards revision.
  const revision = Math.max(previousRevision + 1, change.revision ?? 0);
  const frame = DaemonEventResourceChangedFrameSchemaZ.parse({
    type: "resource.changed",
    sequence: resourceEventSequence + 1,
    workspaceName: change.workspaceName,
    resource: change.resource,
    revision,
    causeOperationId: change.causeOperationId ?? null,
  });
  resourceEventSequence = frame.sequence;
  resourceRevisions.set(key, revision);
  resourceEventJournal.push(frame);
  if (resourceEventJournal.length > RESOURCE_EVENT_JOURNAL_LIMIT) {
    resourceEventJournal.splice(0, resourceEventJournal.length - RESOURCE_EVENT_JOURNAL_LIMIT);
  }
  for (const client of allClients) client.broadcastResourceChanged(frame);
  return frame;
}

export interface InteractionReceiptBroadcast {
  readonly operationId: string;
  readonly origin: InteractionOrigin;
  readonly workspaceName: string;
  readonly sourceSemanticPaneId?: string | null;
  readonly target: InteractionReceipt["target"];
  readonly operationKind: InteractionReceipt["operationKind"];
  readonly phase: InteractionReceipt["phase"];
  readonly summary: InteractionSafeSummary;
  readonly proof: InteractionReceipt["proof"];
  readonly resourceRevision?: number | null;
  readonly at?: string;
}

/** Record and fan out one privacy-safe interaction receipt on the shared journal. */
export function broadcastInteractionReceipt(
  receipt: InteractionReceiptBroadcast,
  daemonInstanceId: string,
): InteractionReceipt {
  useResourceEventGeneration(daemonInstanceId);
  const frame = InteractionReceiptSchemaZ.parse({
    type: "interaction.receipt",
    sequence: resourceEventSequence + 1,
    operationId: receipt.operationId,
    origin: receipt.origin,
    workspaceName: receipt.workspaceName,
    sourceSemanticPaneId: receipt.sourceSemanticPaneId ?? null,
    target: receipt.target,
    operationKind: receipt.operationKind,
    phase: receipt.phase,
    summary: receipt.summary,
    proof: receipt.proof,
    at: receipt.at ?? new Date().toISOString(),
    resourceRevision: receipt.resourceRevision ?? null,
  });
  resourceEventSequence = frame.sequence;
  resourceEventJournal.push(frame);
  if (resourceEventJournal.length > RESOURCE_EVENT_JOURNAL_LIMIT) {
    resourceEventJournal.splice(0, resourceEventJournal.length - RESOURCE_EVENT_JOURNAL_LIMIT);
  }
  for (const client of allClients) client.broadcastInteractionReceipt(frame);
  return frame;
}

let sessionsPollTimer: ReturnType<typeof setInterval> | null = null;
let lastSessionsHash = "";
let projectRegistryListener: (() => void) | null = null;
let workspaceRegistryListenerReleases: readonly (() => void)[] = [];
let agentStatusWatcher: AgentStatusWatcher | null = null;
let fleetPollTimer: ReturnType<typeof setInterval> | null = null;
let lastFleetHash = "";
let sessionsObserverRefs = 0;
let projectRegistryObserverRefs = 0;
let agentStatusObserverRefs = 0;
let fleetObserverRefs = 0;
let workspaceResourceObserver: WorkspaceResourceObserver | null = null;

function workspaceNameForSession(sessionName: string): string | null {
  return (
    getDefaultWorkspaceRegistry()
      .list()
      .find((workspace) => workspace.sessionName === sessionName)?.name ?? null
  );
}

function ensureWorkspaceResourceObserver(daemonInstanceId: string): WorkspaceResourceObserver {
  if (workspaceResourceObserver) return workspaceResourceObserver;
  workspaceResourceObserver = new WorkspaceResourceObserver({
    registry: getDefaultWorkspaceRegistry(),
    emit: ({ workspaceName, resource }) => {
      broadcastResourceChanged({ workspaceName, resource }, daemonInstanceId);
    },
  });
  return workspaceResourceObserver;
}

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
    if (resourceEventGeneration) {
      broadcastResourceChanged(
        { workspaceName: null, resource: "workspace-catalog" },
        resourceEventGeneration,
      );
      broadcastResourceChanged(
        { workspaceName: null, resource: "fleet-catalog" },
        resourceEventGeneration,
      );
    }
  }, SESSIONS_POLL_MS);
  sessionsPollTimer.unref?.();
}

function maybeStopSessionsPoller(): void {
  if (sessionsObserverRefs > 0 || !sessionsPollTimer) return;
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
    if (resourceEventGeneration) {
      broadcastResourceChanged(
        { workspaceName: null, resource: "workspace-catalog" },
        resourceEventGeneration,
      );
    }
  };
  projectRegistryListener = listener;
  projectRegistryEmitter.on("change", listener);
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  workspaceRegistryListenerReleases = [
    workspaceRegistry.on("workspace.added", listener),
    workspaceRegistry.on("workspace.removed", listener),
  ];
}

function maybeStopProjectRegistryListener(): void {
  if (projectRegistryObserverRefs > 0 || !projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
  for (const release of workspaceRegistryListenerReleases) release();
  workspaceRegistryListenerReleases = [];
}

/**
 * Build the wire receipt for one observed turn completion. The durable pane
 * stamp is validated against the semantic grammar before minting the wire-safe
 * `agent.<digest>` id — an unstamped (or garbage-stamped) pane still yields a
 * receipt, with `agentId: null`, because "an agent finished in this session"
 * is useful even without per-agent correlation.
 */
function agentTurnCompletedFrame(
  completion: AgentTurnCompletion,
): DaemonEventAgentTurnCompletedFrame {
  const stampValid =
    completion.paneStamp !== null &&
    TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(completion.paneStamp).success;
  return {
    type: "agent.turn-completed",
    sessionName: completion.sessionName,
    agentId: stampValid ? agentIdForPaneStamp(completion.paneStamp!) : null,
    fromStatus: completion.fromStatus,
    toStatus: completion.toStatus,
    at: new Date().toISOString(),
  };
}

/**
 * Start (lazily) the agent-status watcher on the first connected client. It
 * polls every pane's `@agent_state` and, on each transition, fans a
 * session-scoped `agent-status.changed` invalidation plus a typed
 * `agent.turn-completed` receipt per pane whose turn finished. Runs only
 * while at least one client is connected, so there is no background cost
 * otherwise.
 */
function ensureAgentStatusWatcher(): void {
  if (agentStatusWatcher) return;
  agentStatusWatcher = new AgentStatusWatcher({
    read: () => readAgentStatesBySession(),
    emit: (sessionName) => {
      for (const client of allClients) client.broadcastAgentStatusChanged(sessionName);
      if (resourceEventGeneration) {
        broadcastResourceChanged(
          { workspaceName: null, resource: "fleet-catalog" },
          resourceEventGeneration,
        );
        const workspaceName = workspaceNameForSession(sessionName);
        if (workspaceName) {
          broadcastResourceChanged(
            { workspaceName, resource: "application-shell" },
            resourceEventGeneration,
          );
          broadcastResourceChanged(
            { workspaceName, resource: "workspace-missions" },
            resourceEventGeneration,
          );
        }
      }
    },
    emitTurnCompleted: (completion) => {
      const frame = agentTurnCompletedFrame(completion);
      for (const client of allClients) client.broadcastAgentTurnCompleted(frame);
    },
  });
  agentStatusWatcher.start();
}

function maybeStopAgentStatusWatcher(): void {
  if (agentStatusObserverRefs > 0 || !agentStatusWatcher) return;
  agentStatusWatcher.stop();
  agentStatusWatcher = null;
}

/**
 * Hash the visible adopted-session set. A `null` read (transient tmux failure)
 * holds the current baseline so a hiccup never looks like the whole fleet
 * vanishing. This tracks fleet COMPOSITION only (which sessions are adopted),
 * which is what a `fleet.changed` frame signals — agent-status transitions are
 * carried separately by the agent-status watcher.
 */
function snapshotFleetHash(): string {
  const names = readAdoptedSessionNames();
  if (names === null) return lastFleetHash;
  return JSON.stringify([...names].sort());
}

/** One fleet-composition poll cycle. Exposed for deterministic tests. */
function pollFleetComposition(): void {
  const hash = snapshotFleetHash();
  if (hash === lastFleetHash) return;
  lastFleetHash = hash;
  for (const client of allClients) client.broadcastFleetChanged();
  if (resourceEventGeneration) {
    broadcastResourceChanged(
      { workspaceName: null, resource: "fleet-catalog" },
      resourceEventGeneration,
    );
  }
}

/**
 * Start (lazily) the fleet-composition poller on the first connected client. It
 * polls the adopted-session set — the ONLY signal that covers an adopted-only
 * session (one absent from the workspace registry) appearing or disappearing —
 * and fans a fleet-wide `fleet.changed` frame on each change. Runs only while a
 * client is connected.
 */
function ensureFleetPoller(): void {
  if (fleetPollTimer) return;
  lastFleetHash = snapshotFleetHash();
  fleetPollTimer = setInterval(pollFleetComposition, SESSIONS_POLL_MS);
  fleetPollTimer.unref?.();
}

function maybeStopFleetPoller(): void {
  if (fleetObserverRefs > 0 || !fleetPollTimer) return;
  clearInterval(fleetPollTimer);
  fleetPollTimer = null;
}

function acquireGlobalObserver(kind: "sessions" | "projects" | "agents" | "fleet"): () => void {
  if (kind === "sessions") {
    sessionsObserverRefs += 1;
    ensureSessionsPoller();
  } else if (kind === "projects") {
    projectRegistryObserverRefs += 1;
    ensureProjectRegistryListener();
  } else if (kind === "agents") {
    agentStatusObserverRefs += 1;
    ensureAgentStatusWatcher();
  } else {
    fleetObserverRefs += 1;
    ensureFleetPoller();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (kind === "sessions") {
      sessionsObserverRefs = Math.max(0, sessionsObserverRefs - 1);
      maybeStopSessionsPoller();
    } else if (kind === "projects") {
      projectRegistryObserverRefs = Math.max(0, projectRegistryObserverRefs - 1);
      maybeStopProjectRegistryListener();
    } else if (kind === "agents") {
      agentStatusObserverRefs = Math.max(0, agentStatusObserverRefs - 1);
      maybeStopAgentStatusWatcher();
    } else {
      fleetObserverRefs = Math.max(0, fleetObserverRefs - 1);
      maybeStopFleetPoller();
    }
  };
}

interface ResourceObservationHandle {
  readonly release: () => void;
  readonly ready: Promise<{ readonly status: "installed" | "unavailable" }>;
}
let resourceObservationOverride:
  | ((interest: DaemonEventResourceInterest) => ResourceObservationHandle)
  | null = null;

function acquireResourceObservation(
  interest: DaemonEventResourceInterest,
  daemonInstanceId: string,
): ResourceObservationHandle {
  if (resourceObservationOverride) return resourceObservationOverride(interest);
  const synchronous = (release: () => void): ResourceObservationHandle => ({
    release,
    ready: Promise.resolve({ status: "installed" }),
  });
  if (interest.resource === "workspace-catalog") {
    const releases = [acquireGlobalObserver("sessions"), acquireGlobalObserver("projects")];
    return synchronous(() => releases.forEach((release) => release()));
  }
  if (interest.resource === "fleet-catalog") {
    const releases = [
      acquireGlobalObserver("sessions"),
      acquireGlobalObserver("fleet"),
      acquireGlobalObserver("agents"),
    ];
    return synchronous(() => releases.forEach((release) => release()));
  }
  if (interest.resource === "application-shell") {
    return synchronous(acquireGlobalObserver("agents"));
  }
  if (isObservableWorkspaceResource(interest.resource) && interest.workspaceName !== null) {
    return ensureWorkspaceResourceObserver(daemonInstanceId).acquire(
      interest.workspaceName,
      interest.resource,
    );
  }
  return synchronous(() => undefined);
}

/** Historical sessions-only clients retain the old broad observation set. */
function acquireLegacyObservation(): () => void {
  const releases = [
    acquireGlobalObserver("sessions"),
    acquireGlobalObserver("projects"),
    acquireGlobalObserver("agents"),
    acquireGlobalObserver("fleet"),
  ];
  return () => releases.forEach((release) => release());
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

/**
 * Push a `workspace.promotion-completed` receipt to every connected client.
 * Called by the v2 action dispatcher after a successful `workspace.promote` —
 * the typed, bounded twin of that action's generic `action.complete` frame.
 */
export function broadcastWorkspacePromotionCompleted(
  workspaceName: string,
  outcome: "promoted" | "replayed",
): void {
  const frame: DaemonEventWorkspacePromotionCompletedFrame = {
    type: "workspace.promotion-completed",
    workspaceName,
    outcome,
    at: new Date().toISOString(),
  };
  for (const client of allClients) client.broadcastWorkspacePromotionCompleted(frame);
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
export function buildSessionSnapshot(sessionName: string): DaemonSessionSnapshot | null {
  const session = discoverSessions().find((s) => s.name === sessionName);
  if (!session) return null;
  return { project: buildProjectDetail(session) };
}

/**
 * Wire a single WebSocket connection. Tracks per-session subscriptions and
 * tears all listeners down on close — no leaks.
 */
export function handleWsEventsConnection(
  socket: WebSocket | WsLike,
  daemonIdentity: DaemonInstanceIdentity,
  options: { readonly mode?: "legacy" | "semantic" } = {},
): void {
  useResourceEventGeneration(daemonIdentity.instanceId);
  const ws = socket as WsLike;
  const subscriptions = new Set<string>();
  const interestHandles = new Map<
    string,
    {
      readonly interest: DaemonEventResourceInterest;
      readonly handle: ResourceObservationHandle;
      status: "pending" | "installed" | "unavailable";
    }
  >();
  const explicitInterestKeys = new Set<string>();
  let closed = false;
  let replayRequested = false;
  let releaseLegacyObservation: (() => void) | null = null;
  let legacyDeliveryEnabled = options.mode !== "semantic";
  let interestMutation: Promise<void> | null = null;

  const send = (frame: DaemonEventServerFrame): void => {
    if (closed || ws.readyState !== WS_OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // peer went away mid-send; close path will clean up
    }
  };

  const broadcastSessionsChanged = (): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "sessions.changed" });
  };

  const broadcastProjectsChanged = (): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "projects.changed" });
  };

  const broadcastInitOutputForClient = (jobId: string, chunk: string, done?: boolean): void => {
    if (!legacyDeliveryEnabled) return;
    const frame: DaemonEventServerFrame =
      done === undefined
        ? { type: "init.output", jobId, chunk }
        : { type: "init.output", jobId, chunk, done };
    send(frame);
  };

  const broadcastInitErrorForClient = (jobId: string, message: string): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "init.error", jobId, message });
  };

  const broadcastActionCompleteForClient = (name: string, result: unknown): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "action.complete", name, result });
  };

  const broadcastConfigChangedForClient = (sessionName: string): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "config.changed", sessionName });
  };

  const broadcastTerminalsChangedForClient = (sessionName: string): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "terminals.changed", sessionName });
  };

  const broadcastAgentStatusChangedForClient = (sessionName: string): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "agent-status.changed", sessionName });
  };

  const broadcastAgentTurnCompletedForClient = (
    frame: DaemonEventAgentTurnCompletedFrame,
  ): void => {
    if (!legacyDeliveryEnabled) return;
    send(frame);
  };

  const broadcastWorkspacePromotionCompletedForClient = (
    frame: DaemonEventWorkspacePromotionCompletedFrame,
  ): void => {
    if (!legacyDeliveryEnabled) return;
    send(frame);
  };

  const broadcastFleetChangedForClient = (): void => {
    if (!legacyDeliveryEnabled) return;
    send({ type: "fleet.changed" });
  };

  const broadcastResourceChangedForClient = (frame: DaemonEventResourceChangedFrame): void => {
    if (
      legacyDeliveryEnabled ||
      explicitInterestKeys.has(resourceRevisionKey(frame.workspaceName, frame.resource))
    ) {
      send(frame);
      return;
    }
    send({ type: "resource.observed", sequence: frame.sequence });
  };

  const broadcastInteractionReceiptForClient = (frame: InteractionReceipt): void => {
    if (
      legacyDeliveryEnabled ||
      explicitInterestKeys.has(resourceRevisionKey(frame.workspaceName, "application-shell"))
    ) {
      send(frame);
    } else {
      send({ type: "resource.observed", sequence: frame.sequence });
    }
  };

  // Per-connection subscription to the current workspace-registry singleton.
  const workspaceRegistry = getDefaultWorkspaceRegistry();
  const unsubWorkspaceAdded = workspaceRegistry.on("workspace.added", (workspace) =>
    legacyDeliveryEnabled
      ? send({ type: "workspace.added", workspace: workspace as Workspace })
      : undefined,
  );
  const unsubWorkspaceRemoved = workspaceRegistry.on("workspace.removed", (name) =>
    legacyDeliveryEnabled ? send({ type: "workspace.removed", name: name as string }) : undefined,
  );

  const clientHandle: ClientHandle = {
    broadcastSessionsChanged,
    broadcastProjectsChanged,
    broadcastInitOutput: broadcastInitOutputForClient,
    broadcastInitError: broadcastInitErrorForClient,
    broadcastActionComplete: broadcastActionCompleteForClient,
    broadcastConfigChanged: broadcastConfigChangedForClient,
    broadcastTerminalsChanged: broadcastTerminalsChangedForClient,
    broadcastAgentStatusChanged: broadcastAgentStatusChangedForClient,
    broadcastAgentTurnCompleted: broadcastAgentTurnCompletedForClient,
    broadcastWorkspacePromotionCompleted: broadcastWorkspacePromotionCompletedForClient,
    broadcastFleetChanged: broadcastFleetChangedForClient,
    broadcastResourceChanged: broadcastResourceChangedForClient,
    broadcastInteractionReceipt: broadcastInteractionReceiptForClient,
  };
  allClients.add(clientHandle);

  // Server-initiated keepalive — mirrors the SSE behavior so middle-boxes
  // don't reap the connection.
  const keepalive = setInterval(() => {
    send({ type: "pong" });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  const subscribe = (sessionName: string, sendInitialSnapshot: boolean): void => {
    if (subscriptions.has(sessionName)) return;
    const session = discoverSessions().find((s) => s.name === sessionName);
    subscriptions.add(sessionName);
    if (session && sendInitialSnapshot && legacyDeliveryEnabled) {
      const data = buildSessionSnapshot(sessionName);
      if (data) {
        send({ type: "snapshot", sessionName, data });
      }
    }
  };

  const unsubscribe = (sessionName: string): void => {
    subscriptions.delete(sessionName);
  };

  const subscribeInterest = (interest: DaemonEventResourceInterest): ResourceObservationHandle => {
    const key = resourceInterestKey(interest);
    const existing = interestHandles.get(key);
    if (existing && existing.status !== "unavailable") return existing.handle;
    if (existing) {
      existing.handle.release();
      interestHandles.delete(key);
    }
    explicitInterestKeys.add(key);
    const handle = acquireResourceObservation(interest, daemonIdentity.instanceId);
    const record: {
      readonly interest: DaemonEventResourceInterest;
      readonly handle: ResourceObservationHandle;
      status: "pending" | "installed" | "unavailable";
    } = { interest, handle, status: "pending" };
    interestHandles.set(key, record);
    void handle.ready.then(({ status }) => {
      if (interestHandles.get(key) === record) record.status = status;
    });
    return handle;
  };

  const unsubscribeInterest = (interest: DaemonEventResourceInterest): void => {
    const key = resourceInterestKey(interest);
    const existing = interestHandles.get(key);
    if (!existing) return;
    interestHandles.delete(key);
    explicitInterestKeys.delete(key);
    existing.handle.release();
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    allClients.delete(clientHandle);
    subscriptions.clear();
    releaseLegacyObservation?.();
    releaseLegacyObservation = null;
    for (const { handle } of interestHandles.values()) handle.release();
    interestHandles.clear();
    explicitInterestKeys.clear();
    unsubWorkspaceAdded();
    unsubWorkspaceRemoved();
    maybeStopSessionsPoller();
    maybeStopProjectRegistryListener();
    maybeStopAgentStatusWatcher();
    maybeStopFleetPoller();
  };

  const applyLegacyPreference = (legacyEvents: boolean | undefined): void => {
    const requested =
      options.mode === "semantic" ? false : legacyEvents === undefined ? true : legacyEvents;
    legacyDeliveryEnabled = requested;
    if (requested && releaseLegacyObservation === null) {
      releaseLegacyObservation = acquireLegacyObservation();
    } else if (!requested) {
      releaseLegacyObservation?.();
      releaseLegacyObservation = null;
    }
  };

  const replayAfter = (afterSequence: number | undefined): void => {
    if (afterSequence === undefined || replayRequested) return;
    replayRequested = true;
    const currentSequence = resourceEventSequence;
    const oldestAvailableSequence = resourceEventJournal[0]?.sequence ?? null;
    if (afterSequence > currentSequence) {
      send({
        type: "snapshot-required",
        afterSequence,
        oldestAvailableSequence,
        currentSequence,
        reason: "cursor-ahead",
      });
    } else if (oldestAvailableSequence !== null && afterSequence < oldestAvailableSequence - 1) {
      send({
        type: "snapshot-required",
        afterSequence,
        oldestAvailableSequence,
        currentSequence,
        reason: "journal-gap",
      });
    } else {
      for (const frame of resourceEventJournal) {
        if (frame.sequence <= afterSequence) continue;
        if (frame.type === "resource.changed") broadcastResourceChangedForClient(frame);
        else broadcastInteractionReceiptForClient(frame);
      }
    }
  };

  const enqueueInterestMutation = (mutation: () => Promise<void>): void => {
    let queued!: Promise<void>;
    queued = (interestMutation ? interestMutation.then(mutation) : mutation())
      .catch(() => undefined)
      .finally(() => {
        if (interestMutation === queued) interestMutation = null;
      });
    interestMutation = queued;
  };

  ws.on("message", (data) => {
    if (closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(rawDataToText(data));
    } catch {
      send({
        type: "protocol.error",
        code: "invalid-json",
        message: "Client frame must be valid JSON.",
      });
      return;
    }
    const result = DaemonEventClientFrameSchemaZ.safeParse(raw);
    if (!result.success) {
      send({
        type: "protocol.error",
        code: "invalid-frame",
        message: "Client frame does not match the daemon event protocol.",
      });
      return;
    }
    const parsed: DaemonEventClientFrame = result.data;

    if (parsed.type === "subscribe") {
      if (parsed.interestRevision === undefined) {
        applyLegacyPreference(parsed.legacyEvents);
        for (const interest of parsed.interests ?? []) subscribeInterest(interest);
        replayAfter(parsed.afterSequence);
        for (const name of parsed.sessions) subscribe(name, parsed.afterSequence === undefined);
        return;
      }
      enqueueInterestMutation(async () => {
        if (closed) return;
        applyLegacyPreference(parsed.legacyEvents);
        const acquired = (parsed.interests ?? []).map((interest) => ({
          interest,
          ready: subscribeInterest(interest).ready,
        }));
        const settled = await Promise.all(
          acquired.map(async ({ interest, ready }) => ({ interest, result: await ready })),
        );
        replayAfter(parsed.afterSequence);
        for (const name of parsed.sessions) subscribe(name, parsed.afterSequence === undefined);
        if (parsed.interestRevision !== undefined) {
          send({
            type: "resource.interests-ack",
            interestRevision: parsed.interestRevision,
            sequence: resourceEventSequence,
            unavailableInterests: settled
              .filter(({ result }) => result.status === "unavailable")
              .map(({ interest }) => interest),
          });
        }
      });
      return;
    }
    if (parsed.type === "unsubscribe") {
      if (parsed.interestRevision === undefined) {
        if (parsed.legacyEvents !== undefined) applyLegacyPreference(parsed.legacyEvents);
        for (const name of parsed.sessions) unsubscribe(name);
        for (const interest of parsed.interests ?? []) unsubscribeInterest(interest);
        return;
      }
      enqueueInterestMutation(async () => {
        if (closed) return;
        if (parsed.legacyEvents !== undefined) applyLegacyPreference(parsed.legacyEvents);
        for (const name of parsed.sessions) unsubscribe(name);
        for (const interest of parsed.interests ?? []) unsubscribeInterest(interest);
        if (parsed.interestRevision !== undefined) {
          send({
            type: "resource.interests-ack",
            interestRevision: parsed.interestRevision,
            sequence: resourceEventSequence,
            unavailableInterests: [],
          });
        }
      });
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
    const sessions = options.mode === "semantic" ? [] : discoverSessions();
    send({
      type: "hello",
      daemon: daemonIdentity,
      sessions: options.mode === "semantic" ? [] : buildOverviews(sessions),
      eventSequence: resourceEventSequence,
    });
  } catch {
    send({
      type: "hello",
      daemon: daemonIdentity,
      sessions: [],
      eventSequence: resourceEventSequence,
    });
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
  for (const release of workspaceRegistryListenerReleases) release();
  workspaceRegistryListenerReleases = [];
}

/**
 * Test-only hook to shut down the global agent-status watcher.
 */
export function _stopAgentStatusWatcherForTests(): void {
  if (!agentStatusWatcher) return;
  agentStatusWatcher.stop();
  agentStatusWatcher = null;
}

/**
 * Test-only hook to drive one agent-status poll cycle deterministically,
 * bypassing the real interval.
 */
export function _tickAgentStatusWatcherForTests(): void {
  agentStatusWatcher?.tick();
}

/**
 * Test-only hook to shut down the global fleet-composition poller.
 */
export function _stopFleetPollerForTests(): void {
  if (!fleetPollTimer) return;
  clearInterval(fleetPollTimer);
  fleetPollTimer = null;
  lastFleetHash = "";
}

/** Test-only reset for the generation-scoped replay journal. */
export function _resetResourceEventJournalForTests(): void {
  resourceEventGeneration = null;
  resourceEventSequence = 0;
  resourceEventJournal = [];
  resourceRevisions.clear();
}

/** Test-only deterministic observer installation barrier. */
export function _setResourceObservationOverrideForTests(
  override: ((interest: DaemonEventResourceInterest) => ResourceObservationHandle) | null,
): void {
  resourceObservationOverride = override;
}

/**
 * Test-only hook to drive one fleet-composition poll cycle deterministically,
 * bypassing the real interval.
 */
export function _pollFleetCompositionForTests(): void {
  pollFleetComposition();
}

/**
 * Deterministically retire every demand-driven observer. Embedded daemon
 * shutdown calls this after closing event sockets so native watcher cleanup is
 * part of the daemon's completion barrier rather than process-exit luck.
 */
export async function shutdownWsEventObservation(): Promise<void> {
  sessionsObserverRefs = 0;
  projectRegistryObserverRefs = 0;
  agentStatusObserverRefs = 0;
  fleetObserverRefs = 0;
  _stopSessionsPollerForTests();
  _detachProjectRegistryListenerForTests();
  _stopAgentStatusWatcherForTests();
  _stopFleetPollerForTests();
  const observer = workspaceResourceObserver;
  workspaceResourceObserver = null;
  await observer?.dispose();
}

/** Test-only demand snapshot; contains no path or socket identity. */
export function _resourceObserverStateForTests(): {
  readonly sessions: number;
  readonly projects: number;
  readonly agents: number;
  readonly fleet: number;
  readonly workspaces: ReturnType<WorkspaceResourceObserver["state"]>;
} {
  return {
    sessions: sessionsObserverRefs,
    projects: projectRegistryObserverRefs,
    agents: agentStatusObserverRefs,
    fleet: fleetObserverRefs,
    workspaces: workspaceResourceObserver?.state() ?? [],
  };
}
