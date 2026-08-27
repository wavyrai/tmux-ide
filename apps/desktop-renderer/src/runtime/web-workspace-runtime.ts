import type {
  CanonicalTerminalReplicaUpdate,
  InteractionReceipt,
  SessionRuntimeActivityKind,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthorityLease,
  SessionRuntimeAuthoritySnapshot,
  SessionRuntimePresenceState,
  SessionRuntimeSemanticIntent,
  SessionRuntimeTerminalInputResult,
  TerminalReplicaAddress,
  TerminalReplicaDeliveryMetadata,
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
  TerminalReplicaTombstonePayload,
  WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import type {
  WorkspaceClientRuntimeInventory,
  WorkspaceClientRuntimePort,
} from "@tmux-ide/daemon-client";

import type {
  PaneMirrorEvent,
  PaneStreamResizeResult,
  PaneStreamLayoutEvent,
  PaneStreamLayoutSnapshotEvent,
  Card5PhysicalPaneStreamBinding,
  PaneStreamSessionHandle,
  PaneStreamTransport,
} from "../terminal/pane-stream-transport.ts";
import {
  createCard5DescriptorRecorder,
  createCard5EnvelopeAckRecorder,
  createCard5EnvelopeEvidenceRecorder,
  createCard5GeometryReceiptRecorder,
  createCard5InputReceiptRecorder,
  createCard5PaneStreamLifecycleRecorder,
  recordCard5SocketLifecycle,
} from "./card5-envelope-evidence.ts";

export type WebWorkspaceRuntimePort = WorkspaceClientRuntimePort<
  TerminalReplicaSnapshot,
  TerminalReplicaPatchPayload,
  TerminalReplicaTombstonePayload
>;

let physicalBindingEpoch = 0;

function allocatePhysicalBindingEpoch(): number {
  if (!Number.isSafeInteger(physicalBindingEpoch + 1)) {
    throw new Error("The physical pane-stream binding epoch overflowed.");
  }
  physicalBindingEpoch += 1;
  return physicalBindingEpoch;
}

function runtimeTerminalCode(
  reason: unknown,
  origin: "client" | "peer" | "dispose" | "unknown",
): string {
  if (!(reason instanceof Error))
    return reason === undefined
      ? origin === "peer"
        ? "runtime-source-closed"
        : "runtime-ended"
      : "runtime-fault";
  switch (reason.message) {
    case "terminal-conflict":
      return "runtime-terminal-conflict";
    case "terminal-gap":
      return "runtime-terminal-gap";
    case "terminal-snapshot-missing":
      return "runtime-snapshot-missing";
    case "Terminal delivery escaped the active workspace inventory.":
      return "runtime-inventory-escape";
    default:
      return "runtime-fault";
  }
}

export type WebWorkspaceViewportFailureCode =
  | "geometry-authority-timeout"
  | "geometry-viewport-timeout"
  | "pane-stream-closed"
  | "geometry-lifecycle-retired"
  | "geometry-resize-failed";

export class WebWorkspaceViewportError extends Error {
  readonly code: WebWorkspaceViewportFailureCode;

  constructor(code: WebWorkspaceViewportFailureCode) {
    super(code);
    this.name = "WebWorkspaceViewportError";
    this.code = code;
  }
}

export interface WebWorkspaceRuntimeOptions {
  readonly transport: PaneStreamTransport;
  readonly inventory: WorkspaceClientRuntimeInventory;
  readonly signal: AbortSignal;
  readonly submitIntent?: (
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ) => Promise<WorkspaceMultiplexerMutationResult | null>;
  readonly onPaneEvent?: (pane: string, event: PaneMirrorEvent) => void;
  readonly onLayout?: (layout: PaneStreamLayoutEvent) => void;
  readonly onLayoutSnapshot?: (snapshot: PaneStreamLayoutSnapshotEvent) => void;
  readonly onSession?: (session: PaneStreamSessionHandle | null) => void;
  readonly onEnd?: (error: unknown) => void;
}

interface PaneSubscription {
  readonly target: TerminalReplicaAddress;
  readonly listeners: Set<
    (update: CanonicalTerminalReplicaUpdate, metadata?: TerminalReplicaDeliveryMetadata) => void
  >;
  frozen: boolean;
  closed: boolean;
  lastDeliveredIdentity: string | null;
}

function targetKey(target: TerminalReplicaAddress): string {
  return `${target.workspaceName}\u0000${target.semanticPaneId}`;
}

interface ReplicaReplay {
  readonly identity: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly seed: CanonicalTerminalReplicaUpdate;
  readonly snapshot: TerminalReplicaSnapshot;
}

function updateIdentity(update: CanonicalTerminalReplicaUpdate): string {
  return `${update.generation}\u0000${update.incarnation}\u0000${update.revision}\u0000${update.stateHash}`;
}

function replaySeed(
  update: CanonicalTerminalReplicaUpdate,
  snapshot: TerminalReplicaSnapshot,
): CanonicalTerminalReplicaUpdate {
  return Object.freeze({
    type: "terminal.seed",
    workspaceName: update.workspaceName,
    semanticPaneId: update.semanticPaneId,
    generation: update.generation,
    incarnation: update.incarnation,
    revision: update.revision,
    cols: snapshot.cols,
    rows: snapshot.rows,
    stateHash: update.stateHash,
    hashAlgorithm: "fnv1a64-v1",
    snapshot,
  });
}

/**
 * One renderer-neutral WorkspaceClient runtime over one host-issued pane-stream
 * descriptor. The renderer never receives an owner token or daemon URL.
 */
export async function connectWebWorkspaceRuntime(
  options: WebWorkspaceRuntimeOptions,
): Promise<WebWorkspaceRuntimePort> {
  const runtimePhysicalEpoch = allocatePhysicalBindingEpoch();
  const recordCard5Envelope = createCard5EnvelopeEvidenceRecorder();
  const recordCard5Ack = createCard5EnvelopeAckRecorder();
  const recordCard5InputReceipt = createCard5InputReceiptRecorder();
  const recordCard5GeometryReceipt = createCard5GeometryReceiptRecorder();
  const recordCard5Lifecycle = createCard5PaneStreamLifecycleRecorder({
    workspaceName: options.inventory.workspaceName,
    semanticPaneIds: options.inventory.semanticPaneIds,
    physicalEpoch: runtimePhysicalEpoch,
  });
  const recordCard5Descriptor = createCard5DescriptorRecorder(
    recordCard5Lifecycle?.physicalEpoch ?? null,
  );
  let lifecycleIdentity: { generation: string; requestId: string } | null = null;
  let lifecycleActive = false;
  let terminalLifecycleObserved = false;
  const physicalBindingListeners = new Set<
    (binding: Card5PhysicalPaneStreamBinding | null) => void
  >();
  const subscriptions = new Map<string, Set<PaneSubscription>>();
  const replicas = new Map<string, ReplicaReplay>();
  const receipts = new Set<(receipt: InteractionReceipt) => void>();
  const authorityListeners = new Set<(snapshot: SessionRuntimeAuthoritySnapshot) => void>();
  let authority: SessionRuntimeAuthoritySnapshot | null = null;
  let session: PaneStreamSessionHandle | null = null;
  let physicalSession: PaneStreamSessionHandle | null = null;
  let closed = false;
  let settleClosed!: (reason?: unknown) => void;
  const closedPromise = new Promise<unknown>((resolve) => {
    settleClosed = resolve;
  });
  const currentPhysicalBinding = (): Card5PhysicalPaneStreamBinding | null => {
    if (
      closed ||
      !lifecycleActive ||
      !lifecycleIdentity ||
      physicalSession === null ||
      authority === null ||
      authority.generation !== lifecycleIdentity.generation ||
      typeof authority.session !== "string" ||
      authority.session.length === 0
    )
      return null;
    const physicalClientId = physicalSession.connectionClientId?.() ?? null;
    if (physicalClientId === null) return null;
    return Object.freeze({
      physicalEpoch: runtimePhysicalEpoch,
      generation: lifecycleIdentity.generation,
      requestId: lifecycleIdentity.requestId,
      runtimeSession: authority.session,
      workspaceName: options.inventory.workspaceName,
      semanticPaneIds: Object.freeze([...options.inventory.semanticPaneIds].sort()),
      clientId: physicalClientId,
      stage: "first-seed",
    });
  };
  const publishPhysicalBinding = (): void => {
    const binding = currentPhysicalBinding();
    for (const listener of physicalBindingListeners) listener(binding);
  };

  const finish = (
    reason?: unknown,
    origin: "client" | "peer" | "dispose" | "unknown" = "client",
  ): void => {
    if (closed) return;
    closed = true;
    lifecycleActive = false;
    options.signal.removeEventListener("abort", abort);
    if (recordCard5Lifecycle && lifecycleIdentity && !terminalLifecycleObserved) {
      terminalLifecycleObserved = true;
      recordCard5Lifecycle({
        ...lifecycleIdentity,
        stage: "terminal",
        code: origin === "dispose" ? "runtime-aborted" : runtimeTerminalCode(reason, origin),
        origin,
        closeCode: null,
        closeReason: "none",
      });
    }
    recordCard5SocketLifecycle(options.inventory.daemonGeneration, session ? "closed" : "failed");
    session?.dispose();
    session = null;
    physicalSession = null;
    publishPhysicalBinding();
    options.onSession?.(null);
    options.onEnd?.(reason);
    settleClosed(reason);
  };
  const abort = (): void => finish(options.signal.reason, "dispose");
  options.signal.addEventListener("abort", abort, { once: true });

  const result = await options.transport.connect(
    {
      workspaceName: options.inventory.workspaceName,
      panes: options.inventory.semanticPaneIds,
      viewerMode: "interactive",
    },
    {
      onPaneEvent(pane, event) {
        const update =
          event.type === "seed-batch" || event.type === "output" || event.type === "closed"
            ? event.canonicalUpdate
            : undefined;
        if (!update) {
          if (event.type === "closed") finish(undefined, "peer");
          return;
        }
        if (
          pane !== update.semanticPaneId ||
          update.workspaceName !== options.inventory.workspaceName ||
          !options.inventory.semanticPaneIds.includes(update.semanticPaneId)
        ) {
          finish(new Error("Terminal delivery escaped the active workspace inventory."));
          return;
        }
        const key = targetKey(update);
        const current = replicas.get(key);
        const identity = updateIdentity(update);
        if (
          current &&
          current.generation === update.generation &&
          current.incarnation === update.incarnation &&
          update.revision <= current.revision
        ) {
          if (update.revision === current.revision && identity === current.identity) return;
          if (update.revision < current.revision) return;
          finish(new Error("terminal-conflict"));
          return;
        }
        if (
          current &&
          update.type !== "terminal.seed" &&
          (current.generation !== update.generation ||
            current.incarnation !== update.incarnation ||
            update.baseRevision !== current.revision ||
            update.revision !== current.revision + 1)
        ) {
          finish(new Error("terminal-gap"));
          return;
        }
        const snapshot =
          event.type === "seed-batch" || event.type === "output"
            ? event.canonicalSnapshot
            : undefined;
        if (update.type !== "terminal.tombstone") {
          if (!snapshot) {
            finish(new Error("terminal-snapshot-missing"));
            return;
          }
          const next: ReplicaReplay = {
            identity,
            generation: update.generation,
            incarnation: update.incarnation,
            revision: update.revision,
            seed: replaySeed(update, snapshot),
            snapshot,
          };
          replicas.set(key, next);
        }
        recordCard5Envelope?.(update);
        for (const subscription of subscriptions.get(key) ?? []) {
          if (subscription.closed || subscription.frozen) continue;
          for (const listener of subscription.listeners)
            listener(update, { canonicalSnapshot: snapshot ?? null });
          if (subscription.listeners.size > 0) {
            subscription.lastDeliveredIdentity = identity;
          }
        }
        if (update.type === "terminal.tombstone") replicas.delete(key);
        options.onPaneEvent?.(pane, event);
      },
      onLayout(layout) {
        options.onLayout?.(layout);
      },
      onLayoutSnapshot(snapshot) {
        options.onLayoutSnapshot?.(snapshot);
      },
      onAuthoritySnapshot(snapshot) {
        authority = snapshot;
        publishPhysicalBinding();
        for (const listener of authorityListeners) listener(snapshot);
      },
      ...(recordCard5Ack ? { onDeliveryAckSent: recordCard5Ack } : {}),
      ...(recordCard5InputReceipt ? { onInputAckObserved: recordCard5InputReceipt } : {}),
      ...(recordCard5GeometryReceipt ? { onViewportAckObserved: recordCard5GeometryReceipt } : {}),
      ...(recordCard5Descriptor ? { onDescriptorIssued: recordCard5Descriptor } : {}),
      onDiagnosticLifecycle(event) {
        if (event.stage === "issued") {
          lifecycleIdentity = {
            generation: event.generation,
            requestId: event.requestId,
          };
          terminalLifecycleObserved = false;
        }
        if (event.stage === "first-seed") lifecycleActive = true;
        if (event.stage === "terminal") {
          if (terminalLifecycleObserved) return;
          terminalLifecycleObserved = true;
          lifecycleActive = false;
        }
        recordCard5Lifecycle?.(event);
        publishPhysicalBinding();
      },
      onEnd(error) {
        finish(error, "unknown");
      },
    },
  );
  if (result.status === "error") {
    finish(result.error, "unknown");
    throw new Error(result.error.reason);
  }
  if (closed) {
    result.session.dispose();
    throw new Error("The Web workspace runtime was retired before it connected.");
  }
  physicalSession = result.session;
  const retainedPhysicalSession = result.session;
  session = {
    dispose: () => retainedPhysicalSession.dispose(),
    ...(retainedPhysicalSession.connectionClientId
      ? { connectionClientId: () => retainedPhysicalSession.connectionClientId?.() ?? null }
      : {}),
    ...(retainedPhysicalSession.updatePresence
      ? { updatePresence: (state) => retainedPhysicalSession.updatePresence?.(state) }
      : {}),
    ...(retainedPhysicalSession.noteActivity
      ? { noteActivity: (activity) => retainedPhysicalSession.noteActivity?.(activity) }
      : {}),
    ...(retainedPhysicalSession.connectionAuthorityClientId
      ? {
          connectionAuthorityClientId: (kind) =>
            retainedPhysicalSession.connectionAuthorityClientId?.(kind) ?? null,
        }
      : {}),
    ...(retainedPhysicalSession.write
      ? { write: (pane, input) => retainedPhysicalSession.write!(pane, input) }
      : {}),
    ...(retainedPhysicalSession.resize
      ? { resize: (cols, rows) => retainedPhysicalSession.resize!(cols, rows) }
      : {}),
    ...(retainedPhysicalSession.requestAuthority
      ? { requestAuthority: (kind) => retainedPhysicalSession.requestAuthority!(kind) }
      : {}),
    ...(retainedPhysicalSession.releaseAuthority
      ? { releaseAuthority: (kind) => retainedPhysicalSession.releaseAuthority!(kind) }
      : {}),
    card5PhysicalBinding: currentPhysicalBinding,
    subscribeCard5PhysicalBinding(listener) {
      physicalBindingListeners.add(listener);
      listener(currentPhysicalBinding());
      return () => physicalBindingListeners.delete(listener);
    },
  };
  publishPhysicalBinding();
  recordCard5SocketLifecycle(options.inventory.daemonGeneration, "open");
  options.onSession?.(session);

  return {
    generation: options.inventory.daemonGeneration,
    closed: closedPromise,
    async subscribeTerminal(target) {
      if (
        closed ||
        target.workspaceName !== options.inventory.workspaceName ||
        !options.inventory.semanticPaneIds.includes(target.semanticPaneId)
      ) {
        throw new Error("The terminal target is outside the active workspace inventory.");
      }
      const subscription: PaneSubscription = {
        target,
        listeners: new Set(),
        frozen: false,
        closed: false,
        lastDeliveredIdentity: null,
      };
      const key = targetKey(target);
      const group = subscriptions.get(key) ?? new Set<PaneSubscription>();
      group.add(subscription);
      subscriptions.set(key, group);
      return {
        generation: options.inventory.daemonGeneration,
        async close() {
          if (subscription.closed) return;
          subscription.closed = true;
          subscription.listeners.clear();
          group.delete(subscription);
          if (group.size === 0) subscriptions.delete(key);
        },
        freeze() {
          subscription.frozen = true;
        },
        thaw() {
          if (!subscription.frozen || subscription.closed) return;
          subscription.frozen = false;
          const state = replicas.get(key);
          if (state && subscription.lastDeliveredIdentity !== state.identity) {
            for (const listener of subscription.listeners)
              listener(state.seed, { canonicalSnapshot: state.snapshot });
            if (subscription.listeners.size > 0) {
              subscription.lastDeliveredIdentity = state.identity;
            }
          }
        },
        onUpdate(listener) {
          if (subscription.closed) return () => undefined;
          subscription.listeners.add(listener);
          const state = replicas.get(key);
          if (!subscription.frozen && state)
            queueMicrotask(() => {
              if (subscription.closed || subscription.frozen) return;
              const current = replicas.get(key);
              if (!current || subscription.lastDeliveredIdentity === current.identity) return;
              listener(current.seed, { canonicalSnapshot: current.snapshot });
              subscription.lastDeliveredIdentity = current.identity;
            });
          return () => subscription.listeners.delete(listener);
        },
      };
    },
    async submitIntent(operationId, intent) {
      return (await options.submitIntent?.(operationId, intent)) ?? undefined;
    },
    async sendTerminalInput(target, input): Promise<SessionRuntimeTerminalInputResult> {
      if (
        closed ||
        !session?.write ||
        target.workspaceName !== options.inventory.workspaceName ||
        !options.inventory.semanticPaneIds.includes(target.semanticPaneId)
      ) {
        return "authority-lost";
      }
      return (await session.write(target.semanticPaneId, input)) ? "ok" : "authority-lost";
    },
    onReceipt(listener) {
      receipts.add(listener);
      return () => receipts.delete(listener);
    },
    async fitViewport(cols, rows) {
      if (closed || !session?.resize) {
        throw new WebWorkspaceViewportError("geometry-lifecycle-retired");
      }
      let result: PaneStreamResizeResult;
      try {
        result = await session.resize(cols, rows);
      } catch {
        throw new WebWorkspaceViewportError("geometry-resize-failed");
      }
      if (result === "geometry-authority-conflict") return result;
      if (result === "authority-timeout") {
        throw new WebWorkspaceViewportError("geometry-authority-timeout");
      }
      if (result === "viewport-timeout") {
        throw new WebWorkspaceViewportError("geometry-viewport-timeout");
      }
      if (result === "stream-closed") throw new WebWorkspaceViewportError("pane-stream-closed");
      if (result === "lifecycle-retired") {
        throw new WebWorkspaceViewportError("geometry-lifecycle-retired");
      }
      if (result !== "ok") throw new WebWorkspaceViewportError("geometry-resize-failed");
      return "ok";
    },
    setPresence(state: SessionRuntimePresenceState) {
      session?.updatePresence?.(state);
    },
    noteActivity(activity: SessionRuntimeActivityKind) {
      session?.noteActivity?.(activity);
    },
    ownsConnectionAuthority(kind: SessionRuntimeAuthorityKind) {
      return (session?.connectionAuthorityClientId?.(kind) ?? null) !== null;
    },
    connectionAuthorityClientId(kind: SessionRuntimeAuthorityKind) {
      return session?.connectionAuthorityClientId?.(kind) ?? null;
    },
    async requestAuthority(
      kind: SessionRuntimeAuthorityKind,
    ): Promise<SessionRuntimeAuthorityLease | null> {
      return (await session?.requestAuthority?.(kind)) ?? null;
    },
    async releaseAuthority(
      kind: SessionRuntimeAuthorityKind,
    ): Promise<SessionRuntimeAuthoritySnapshot> {
      const released = await session?.releaseAuthority?.(kind);
      if (!released) throw new Error("Terminal authority is unavailable.");
      return released;
    },
    onAuthority(listener) {
      authorityListeners.add(listener);
      const replay = authority;
      if (replay)
        queueMicrotask(() => {
          if (authorityListeners.has(listener) && authority === replay) listener(replay);
        });
      return () => authorityListeners.delete(listener);
    },
    requestTerminalRepair() {
      finish(new Error("Terminal replica repair requested."));
    },
    close() {
      finish();
    },
  };
}
