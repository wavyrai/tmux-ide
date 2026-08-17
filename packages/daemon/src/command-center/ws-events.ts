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
import { discoverSessions, buildOverviews, buildProjectDetail } from "./discovery.ts";
import type { AgentTurnCompletion } from "./agent-status-watch.ts";
import {
  DaemonFleetFactsObserver,
  readAgentStateFacts,
  readSessionCompositionFacts,
  type DaemonFleetFactsObserverOptions,
} from "./daemon-fleet-facts-observer.ts";
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
  // Terminal topology has both global (out-of-band tmux) and workspace-scoped
  // invalidations. They describe one authority and therefore require one
  // monotonically increasing daemon-generation clock across both scopes.
  const revisionKey =
    change.resource === "terminal-runtime-inventory"
      ? resourceRevisionKey(null, change.resource)
      : key;
  const previousRevision = resourceRevisions.get(revisionKey) ?? 0;
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
  resourceRevisions.set(revisionKey, revision);
  resourceEventJournal.push(frame);
  if (resourceEventJournal.length > RESOURCE_EVENT_JOURNAL_LIMIT) {
    resourceEventJournal.splice(0, resourceEventJournal.length - RESOURCE_EVENT_JOURNAL_LIMIT);
  }
  for (const client of allClients) client.broadcastResourceChanged(frame);
  return frame;
}

/** Current generation-scoped revision for a resource snapshot read barrier. */
export function currentResourceRevision(
  workspaceName: string,
  resource: DaemonEventResourceKind,
): number {
  return Math.max(
    resourceRevisions.get(resourceRevisionKey(workspaceName, resource)) ?? 0,
    resourceRevisions.get(resourceRevisionKey(null, resource)) ?? 0,
  );
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

let projectRegistryListener: (() => void) | null = null;
let workspaceRegistryListenerReleases: readonly (() => void)[] = [];
let fleetFactsObserver: DaemonFleetFactsObserver | null = null;
let fleetFactsReaderOverride: Pick<
  DaemonFleetFactsObserverOptions,
  "readSessions" | "readAgents"
> | null = null;
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

function broadcastSessionCompositionChanged(): void {
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
    broadcastResourceChanged(
      { workspaceName: null, resource: "terminal-runtime-inventory" },
      resourceEventGeneration,
    );
  }
}

function broadcastTerminalTopologyChanged(): void {
  if (!resourceEventGeneration) return;
  broadcastResourceChanged(
    { workspaceName: null, resource: "terminal-runtime-inventory" },
    resourceEventGeneration,
  );
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
      broadcastResourceChanged(
        { workspaceName: null, resource: "terminal-runtime-inventory" },
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
function broadcastAgentSessionsChanged(sessions: readonly string[]): void {
  for (const sessionName of sessions) {
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
  }
}

function broadcastAdoptedCompositionChanged(): void {
  for (const client of allClients) client.broadcastFleetChanged();
  if (resourceEventGeneration) {
    broadcastResourceChanged(
      { workspaceName: null, resource: "fleet-catalog" },
      resourceEventGeneration,
    );
  }
}

function ensureFleetFactsObserver(): DaemonFleetFactsObserver {
  const readers = fleetFactsReaderOverride ?? {
    readSessions: readSessionCompositionFacts,
    readAgents: readAgentStateFacts,
  };
  fleetFactsObserver ??= new DaemonFleetFactsObserver({
    ...readers,
    onSessionsChanged: broadcastSessionCompositionChanged,
    onTerminalTopologyChanged: broadcastTerminalTopologyChanged,
    onAdoptedChanged: broadcastAdoptedCompositionChanged,
    onAgentSessionsChanged: broadcastAgentSessionsChanged,
    onAgentTurnCompleted: (completion) => {
      const frame = agentTurnCompletedFrame(completion);
      for (const client of allClients) client.broadcastAgentTurnCompleted(frame);
    },
  });
  return fleetFactsObserver;
}

interface ResourceObservationHandle {
  readonly release: () => void;
  readonly ready: Promise<{ readonly status: "installed" | "unavailable" }>;
}

function acquireGlobalObserver(
  kind: "sessions" | "projects" | "agents" | "fleet",
): ResourceObservationHandle {
  let releaseAuthority: () => void;
  let ready = Promise.resolve({ status: "installed" as const });
  if (kind === "sessions") {
    sessionsObserverRefs += 1;
    const handle = ensureFleetFactsObserver().acquire(["sessions"]);
    releaseAuthority = handle.release;
    ready = handle.ready.then(() => ({ status: "installed" as const }));
  } else if (kind === "projects") {
    projectRegistryObserverRefs += 1;
    ensureProjectRegistryListener();
    releaseAuthority = () => undefined;
  } else if (kind === "agents") {
    agentStatusObserverRefs += 1;
    const handle = ensureFleetFactsObserver().acquire(["agents"]);
    releaseAuthority = handle.release;
    ready = handle.ready.then(() => ({ status: "installed" as const }));
  } else {
    fleetObserverRefs += 1;
    const handle = ensureFleetFactsObserver().acquire(["adopted"]);
    releaseAuthority = handle.release;
    ready = handle.ready.then(() => ({ status: "installed" as const }));
  }
  let released = false;
  return {
    ready,
    release: () => {
      if (released) return;
      released = true;
      releaseAuthority();
      if (kind === "sessions") sessionsObserverRefs = Math.max(0, sessionsObserverRefs - 1);
      else if (kind === "projects") {
        projectRegistryObserverRefs = Math.max(0, projectRegistryObserverRefs - 1);
        maybeStopProjectRegistryListener();
      } else if (kind === "agents")
        agentStatusObserverRefs = Math.max(0, agentStatusObserverRefs - 1);
      else fleetObserverRefs = Math.max(0, fleetObserverRefs - 1);
    },
  };
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
  const combine = (handles: readonly ResourceObservationHandle[]): ResourceObservationHandle => ({
    ready: Promise.all(handles.map(({ ready }) => ready)).then(() => ({ status: "installed" })),
    release: () => handles.forEach(({ release }) => release()),
  });
  if (interest.resource === "workspace-catalog") {
    return combine([acquireGlobalObserver("sessions"), acquireGlobalObserver("projects")]);
  }
  if (interest.resource === "fleet-catalog") {
    return combine([
      acquireGlobalObserver("sessions"),
      acquireGlobalObserver("fleet"),
      acquireGlobalObserver("agents"),
    ]);
  }
  if (interest.resource === "application-shell") {
    return acquireGlobalObserver("agents");
  }
  if (interest.resource === "terminal-runtime-inventory") {
    // Topology invalidations are emitted by the existing session/workspace
    // composition authority. Crucially this lane never acquires agent polling.
    return acquireGlobalObserver("sessions");
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
  const handles = [
    acquireGlobalObserver("sessions"),
    acquireGlobalObserver("projects"),
    acquireGlobalObserver("agents"),
    acquireGlobalObserver("fleet"),
  ];
  return () => handles.forEach(({ release }) => release());
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
  if (!resourceEventGeneration) return;
  const workspaceName = workspaceNameForSession(sessionName);
  if (workspaceName) {
    broadcastResourceChanged(
      { workspaceName, resource: "terminal-runtime-inventory" },
      resourceEventGeneration,
    );
  }
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
  options: { readonly mode?: "legacy" | "semantic"; readonly ownerAuthorized?: boolean } = {},
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
      explicitInterestKeys.has(resourceRevisionKey(frame.workspaceName, frame.resource)) ||
      (frame.workspaceName === null &&
        [...explicitInterestKeys].some((key) => key.endsWith(`\0${frame.resource}`)))
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
    if (interest.resource === "terminal-runtime-inventory" && !options.ownerAuthorized) {
      // Owner-only control retention: reject before acquiring any observer.
      return {
        ready: Promise.resolve({ status: "unavailable" }),
        release: () => undefined,
      };
    }
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
    maybeStopProjectRegistryListener();
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
      // Preserve the legacy protocol's synchronous fast path when there is
      // nothing to order against. Once an acknowledged install is pending,
      // every later mutation joins the same per-socket queue.
      if (parsed.interestRevision === undefined && interestMutation === null) {
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
      if (parsed.interestRevision === undefined && interestMutation === null) {
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
 * Test-only hook to detach the registry listener.
 */
export function _detachProjectRegistryListenerForTests(): void {
  if (!projectRegistryListener) return;
  projectRegistryEmitter.off("change", projectRegistryListener);
  projectRegistryListener = null;
  for (const release of workspaceRegistryListenerReleases) release();
  workspaceRegistryListenerReleases = [];
}

/** Test-only hook to retire and reset the unified fleet facts observer. */
export function _stopFleetFactsObserverForTests(): void {
  fleetFactsObserver?.stop();
  fleetFactsObserver = null;
}

/** Test-only reader seam; production always uses async tmux subprocesses. */
export function _setFleetFactsReadersForTests(
  readers: Pick<DaemonFleetFactsObserverOptions, "readSessions" | "readAgents"> | null,
): void {
  _stopFleetFactsObserverForTests();
  fleetFactsReaderOverride = readers;
}

/** Test-only hook to drive one unified observation cycle deterministically. */
export async function _pollFleetFactsObserverForTests(): Promise<void> {
  await fleetFactsObserver?.runOnce();
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
 * Deterministically retire every demand-driven observer. Embedded daemon
 * shutdown calls this after closing event sockets so native watcher cleanup is
 * part of the daemon's completion barrier rather than process-exit luck.
 */
export async function shutdownWsEventObservation(): Promise<void> {
  sessionsObserverRefs = 0;
  projectRegistryObserverRefs = 0;
  agentStatusObserverRefs = 0;
  fleetObserverRefs = 0;
  _detachProjectRegistryListenerForTests();
  _stopFleetFactsObserverForTests();
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
