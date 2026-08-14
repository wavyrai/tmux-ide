import { randomUUID } from "node:crypto";
import type {
  CanonicalTerminalReplicaUpdate,
  InteractionReceipt,
  PaneStreamServerFrame,
  SessionRuntimeAuthorityKind,
  SessionRuntimeAuthoritySnapshot,
  SessionRuntimeTerminalSubscription,
  TerminalDeliveryEnvelope,
  TerminalDeliveryAck,
  TerminalDeliveryNack,
  TerminalDeliveryNegotiated,
  TerminalDeliveryServerMessage,
  TerminalReplicaAddress,
  TerminalReplicaDeliveryMetadata,
  TerminalReplicaPatchPayload,
  TerminalReplicaSnapshot,
  TerminalReplicaTombstonePayload,
} from "@tmux-ide/contracts";
import {
  TerminalDeliveryAssembler,
  decodeSemanticTerminalUpdate,
  hashTerminalReplicaSnapshot,
} from "@tmux-ide/core";
import type { PaneStreamRuntimeClient } from "@tmux-ide/daemon-client/pane-stream-client";
import type {
  WorkspaceClientRuntimeInventory,
  WorkspaceClientRuntimePort,
} from "@tmux-ide/daemon-client/workspace-client-types";

import {
  type OpenTuiVerifiedRoutingContext,
  type OpenTuiVerifiedRoutingIdentity,
} from "./open-tui-verified-routing.ts";
import { createOpenTuiPaneStreamSocket } from "./open-tui-pane-stream-socket.ts";

const OPENTUI_ORIGIN = "tmux-ide://opentui";
/** Stable controller principal used by the daemon authority snapshot. */
export const OPEN_TUI_HOST_CLIENT_ID = `opentui:${process.pid}`;

export type OpenTuiWorkspaceLayout = Extract<PaneStreamServerFrame, { type: "layout" }>;

export interface OpenTuiWorkspaceLayoutSnapshot {
  readonly current: OpenTuiWorkspaceLayout | null;
  readonly windows: readonly OpenTuiWorkspaceLayout[];
}

export interface OpenTuiWorkspaceRuntimePort extends WorkspaceClientRuntimePort<
  TerminalReplicaSnapshot,
  TerminalReplicaPatchPayload,
  TerminalReplicaTombstonePayload
> {
  getLayout(): OpenTuiWorkspaceLayout | null;
  getLayoutSnapshot(): OpenTuiWorkspaceLayoutSnapshot;
  onLayout(listener: (layout: OpenTuiWorkspaceLayoutSnapshot) => void): () => void;
  fitViewport(cols: number, rows: number): Promise<void>;
}

export interface ConnectOpenTuiWorkspaceRuntimePortOptions {
  readonly inventory: WorkspaceClientRuntimeInventory;
  readonly routing: OpenTuiVerifiedRoutingContext;
  readonly signal?: AbortSignal;
  readonly onFault?: (error: Error) => void;
  readonly onDiagnostic?: (
    phase: "layout" | "seed" | "physical-ready" | "coherent",
    details: Readonly<Record<string, unknown>>,
  ) => void;
}

type PaneStreamClientWithReceipts = PaneStreamRuntimeClient & {
  onReceipt?(listener: (receipt: InteractionReceipt) => void): () => void;
};

interface PendingDelivery {
  readonly envelope: TerminalDeliveryEnvelope;
  readonly update: CanonicalTerminalReplicaUpdate;
  readonly nextCols: number;
  readonly nextRows: number;
  readonly metadata: TerminalReplicaDeliveryMetadata | undefined;
}

function freezeLayout(frame: OpenTuiWorkspaceLayout): OpenTuiWorkspaceLayout {
  return Object.freeze({
    ...frame,
    panes: frame.panes.map((pane) => Object.freeze({ ...pane })),
  });
}

function layoutKey(frame: OpenTuiWorkspaceLayout): string {
  if (frame.semanticWindowId) return `semantic:${frame.semanticWindowId}`;
  if (frame.windowName) return `name:${frame.windowName}`;
  return "unidentified";
}

function layoutSnapshot(
  windows: ReadonlyMap<string, OpenTuiWorkspaceLayout>,
): OpenTuiWorkspaceLayoutSnapshot {
  const frames = Object.freeze([...windows.values()]);
  return Object.freeze({
    current: frames.find((frame) => frame.currentWindow) ?? null,
    windows: frames,
  });
}

function canonicalPaneIds(inventory: WorkspaceClientRuntimeInventory): readonly string[] {
  const panes = [...new Set(inventory.semanticPaneIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  if (panes.length === 0) throw new Error("OpenTUI runtime inventory has no attachable panes");
  if (
    panes.length !== inventory.semanticPaneIds.length ||
    panes.some((pane, index) => pane !== inventory.semanticPaneIds[index])
  ) {
    throw new Error("OpenTUI runtime inventory pane ids must be sorted and unique");
  }
  return Object.freeze(panes);
}

function updateFromDelivery(
  envelope: TerminalDeliveryEnvelope,
  payload: ReturnType<typeof decodeSemanticTerminalUpdate>,
  cols: number,
  rows: number,
): CanonicalTerminalReplicaUpdate {
  const common = {
    workspaceName: envelope.workspaceName,
    semanticPaneId: envelope.semanticPaneId,
    generation: envelope.generation,
    incarnation: envelope.incarnation,
    cols,
    rows,
    stateHash: envelope.canonicalStateHash,
    hashAlgorithm: "fnv1a64-v1" as const,
  };
  if (payload.frame === "seed") {
    return Object.freeze({
      ...common,
      type: "terminal.seed" as const,
      revision: payload.revision,
      snapshot: payload.snapshot,
    });
  }
  if (payload.frame === "patch") {
    return Object.freeze({
      ...common,
      type: "terminal.patch" as const,
      baseRevision: payload.baseRevision,
      revision: payload.revision,
      patch: payload.patch,
    });
  }
  return Object.freeze({
    ...common,
    type: "terminal.tombstone" as const,
    baseRevision: payload.baseRevision,
    revision: payload.revision,
    tombstone: payload.tombstone,
  });
}

class WireTerminalEndpoint {
  readonly #workspaceName: string;
  readonly #semanticPaneId: string;
  readonly #ack: PaneStreamRuntimeClient["ack"];
  readonly #nack: PaneStreamRuntimeClient["nack"];
  readonly #failConnection: (error: Error) => void;
  readonly #canonicalSeedReady: () => void;
  #negotiated: TerminalDeliveryNegotiated | null = null;
  #assembler: TerminalDeliveryAssembler | null = null;
  #envelope: TerminalDeliveryEnvelope | null = null;
  #appliedRevision = -1;
  #incarnation: string | null = null;
  #cols = 0;
  #rows = 0;
  #reseedRequired = false;
  #subscription: WireTerminalSubscription | null = null;
  #pending: PendingDelivery | null = null;
  #closed = false;
  readonly #ready: Promise<boolean>;
  #resolveReady!: (ready: boolean) => void;
  #readySettled = false;
  #hasCanonicalSeed = false;

  constructor(options: {
    workspaceName: string;
    semanticPaneId: string;
    ack: PaneStreamRuntimeClient["ack"];
    nack: PaneStreamRuntimeClient["nack"];
    failConnection(error: Error): void;
    canonicalSeedReady(): void;
  }) {
    this.#workspaceName = options.workspaceName;
    this.#semanticPaneId = options.semanticPaneId;
    this.#ack = options.ack;
    this.#nack = options.nack;
    this.#failConnection = options.failConnection;
    this.#canonicalSeedReady = options.canonicalSeedReady;
    this.#ready = new Promise<boolean>((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  negotiate(negotiated: TerminalDeliveryNegotiated): void {
    if (this.#closed || this.#negotiated) {
      this.#failConnection(new Error(`Duplicate terminal negotiation for ${this.#semanticPaneId}`));
      return;
    }
    if (negotiated.encoding !== "semantic-v1") {
      this.#failConnection(
        new Error(`OpenTUI requires semantic-v1 delivery for ${this.#semanticPaneId}`),
      );
      return;
    }
    this.#negotiated = negotiated;
  }

  async subscription(): Promise<
    SessionRuntimeTerminalSubscription<
      TerminalReplicaSnapshot,
      TerminalReplicaPatchPayload,
      TerminalReplicaTombstonePayload
    >
  > {
    const ready = await this.#ready;
    if (!ready) throw new Error(`Terminal endpoint ${this.#semanticPaneId} closed before ready`);
    if (this.#closed) throw new Error(`Terminal endpoint ${this.#semanticPaneId} is closed`);
    if (!this.#negotiated)
      throw new Error(`Terminal endpoint ${this.#semanticPaneId} is not ready`);
    if (this.#subscription && !this.#subscription.closed) {
      throw new Error(`Terminal endpoint ${this.#semanticPaneId} already has a subscription`);
    }
    const subscription = new WireTerminalSubscription(
      this.#negotiated.generation,
      () => this.#flush(),
      () => {
        if (this.#subscription === subscription) this.#subscription = null;
      },
    );
    this.#subscription = subscription;
    return subscription;
  }

  accept(message: TerminalDeliveryServerMessage): void {
    if (this.#closed) return;
    if (!this.#negotiated) {
      this.#failConnection(
        new Error(`Terminal delivery arrived before negotiation for ${this.#semanticPaneId}`),
      );
      return;
    }
    if (message.type === "terminal.delivery.fault") {
      this.#failConnection(
        new Error(`Terminal delivery failed for ${this.#semanticPaneId}: ${message.reason}`),
      );
      return;
    }
    if (message.type === "terminal.delivery") {
      this.#acceptEnvelope(message);
      return;
    }
    this.#acceptChunk(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#assembler = null;
    this.#envelope = null;
    this.#pending = null;
    if (!this.#readySettled) {
      this.#readySettled = true;
      this.#resolveReady(false);
    }
    const subscription = this.#subscription;
    this.#subscription = null;
    void subscription?.close();
  }

  #acceptEnvelope(envelope: TerminalDeliveryEnvelope): void {
    const negotiated = this.#negotiated!;
    if (envelope.generation !== negotiated.generation) {
      this.#reject("stale-generation", envelope);
      return;
    }
    if (
      envelope.workspaceName !== this.#workspaceName ||
      envelope.semanticPaneId !== this.#semanticPaneId ||
      envelope.protocolVersion !== negotiated.protocolVersion ||
      envelope.deliveryNonce !== negotiated.deliveryNonce ||
      envelope.encoding !== negotiated.encoding ||
      envelope.richPlacements !== negotiated.richPlacements ||
      this.#envelope !== null ||
      this.#pending !== null
    ) {
      this.#reject("protocol-violation", envelope);
      return;
    }
    if (
      envelope.frame !== "seed" &&
      (this.#reseedRequired ||
        this.#incarnation !== envelope.incarnation ||
        envelope.baseRevision !== this.#appliedRevision)
    ) {
      this.#reject("gap", envelope);
      return;
    }
    this.#envelope = envelope;
    this.#assembler = new TerminalDeliveryAssembler(envelope);
  }

  #acceptChunk(
    chunk: Extract<TerminalDeliveryServerMessage, { type: "terminal.delivery.chunk" }>,
  ): void {
    const assembler = this.#assembler;
    const envelope = this.#envelope;
    if (!assembler || !envelope) {
      this.#reject("protocol-violation", null, chunk.transactionId);
      return;
    }
    try {
      assembler.write(chunk);
      if (chunk.index + 1 < envelope.chunkCount) return;
      const payload = decodeSemanticTerminalUpdate(assembler.complete());
      if (
        payload.frame !== envelope.frame ||
        payload.revision !== envelope.canonicalRevision ||
        (payload.frame !== "seed" && payload.baseRevision !== envelope.baseRevision)
      ) {
        throw new TypeError("Semantic delivery metadata did not match its envelope");
      }
      const dimensions =
        payload.frame === "seed"
          ? { cols: payload.snapshot.cols, rows: payload.snapshot.rows }
          : payload.frame === "patch" && payload.patch.dimensions
            ? payload.patch.dimensions
            : { cols: this.#cols, rows: this.#rows };
      if (dimensions.cols <= 0 || dimensions.rows <= 0) {
        this.#reject("gap", envelope);
        return;
      }
      if (
        payload.frame === "seed" &&
        hashTerminalReplicaSnapshot(payload.snapshot) !== envelope.canonicalStateHash
      ) {
        throw new TypeError("Semantic seed hash did not match its envelope");
      }
      this.#pending = Object.freeze({
        envelope,
        update: updateFromDelivery(envelope, payload, dimensions.cols, dimensions.rows),
        nextCols: dimensions.cols,
        nextRows: dimensions.rows,
        metadata: envelope.performanceTraceId
          ? Object.freeze({ performanceTraceId: envelope.performanceTraceId })
          : undefined,
      });
      if (payload.frame === "seed" && !this.#hasCanonicalSeed) {
        this.#hasCanonicalSeed = true;
        this.#readySettled = true;
        this.#resolveReady(true);
        this.#canonicalSeedReady();
      }
      this.#flush();
    } catch {
      this.#reject("decode-failed", envelope);
    }
  }

  #flush(): void {
    const delivery = this.#pending;
    const subscription = this.#subscription;
    if (!delivery || !subscription || subscription.closed || subscription.frozen) return;
    try {
      if (!subscription.deliver(delivery.update, delivery.metadata)) return;
    } catch (error) {
      this.#failConnection(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.#appliedRevision = delivery.envelope.canonicalRevision;
    this.#incarnation = delivery.envelope.incarnation;
    this.#cols = delivery.nextCols;
    this.#rows = delivery.nextRows;
    this.#reseedRequired = false;
    this.#pending = null;
    this.#envelope = null;
    this.#assembler = null;
    try {
      this.#ack({
        type: "terminal.delivery.ack",
        workspaceName: delivery.envelope.workspaceName,
        semanticPaneId: delivery.envelope.semanticPaneId,
        generation: delivery.envelope.generation,
        incarnation: delivery.envelope.incarnation,
        deliveryNonce: delivery.envelope.deliveryNonce,
        transactionId: delivery.envelope.transactionId,
        canonicalRevision: delivery.envelope.canonicalRevision,
        canonicalStateHash: delivery.envelope.canonicalStateHash,
        representationHash: delivery.envelope.representationHash,
      });
    } catch (error) {
      this.#failConnection(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #reject(
    reason: TerminalDeliveryNack["reason"],
    envelope: TerminalDeliveryEnvelope | null,
    transactionId: string | null = null,
  ): void {
    const negotiated = this.#negotiated;
    if (!negotiated) {
      this.#failConnection(new Error(`Cannot NACK unnegotiated pane ${this.#semanticPaneId}`));
      return;
    }
    const attempted = envelope ?? this.#envelope;
    try {
      this.#nack({
        type: "terminal.delivery.nack",
        workspaceName: this.#workspaceName,
        semanticPaneId: this.#semanticPaneId,
        generation: negotiated.generation,
        incarnation: attempted?.incarnation ?? this.#incarnation ?? "unknown",
        deliveryNonce: negotiated.deliveryNonce,
        transactionId: attempted?.transactionId ?? transactionId,
        reason,
        appliedRevision: this.#appliedRevision,
      });
    } catch (error) {
      this.#failConnection(error instanceof Error ? error : new Error(String(error)));
    }
    this.#assembler = null;
    this.#envelope = null;
    this.#pending = null;
    this.#reseedRequired = true;
  }
}

class WireTerminalSubscription implements SessionRuntimeTerminalSubscription<
  TerminalReplicaSnapshot,
  TerminalReplicaPatchPayload,
  TerminalReplicaTombstonePayload
> {
  readonly generation: string;
  readonly #listeners = new Set<
    (update: CanonicalTerminalReplicaUpdate, metadata?: TerminalReplicaDeliveryMetadata) => void
  >();
  readonly #flush: () => void;
  readonly #didClose: () => void;
  frozen = false;
  closed = false;

  constructor(generation: string, flush: () => void, didClose: () => void) {
    this.generation = generation;
    this.#flush = flush;
    this.#didClose = didClose;
  }

  onUpdate(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void,
  ): () => void {
    if (this.closed) return () => undefined;
    this.#listeners.add(listener);
    this.#flush();
    return () => this.#listeners.delete(listener);
  }

  deliver(
    update: CanonicalTerminalReplicaUpdate,
    metadata?: TerminalReplicaDeliveryMetadata,
  ): boolean {
    if (this.closed || this.frozen || this.#listeners.size === 0) return false;
    for (const listener of [...this.#listeners]) listener(update, metadata);
    return true;
  }

  freeze(): void {
    if (!this.closed) this.frozen = true;
  }

  thaw(): void {
    if (this.closed || !this.frozen) return;
    this.frozen = false;
    this.#flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.#listeners.clear();
    this.#didClose();
  }
}

/**
 * Open one renderer-neutral runtime lane from the shell-authority inventory.
 * This adapter only authenticates, assembles and decodes wire updates; the
 * TerminalFastLane remains the sole owner of canonical terminal reduction.
 */
export async function connectOpenTuiWorkspaceRuntimePort(
  options: ConnectOpenTuiWorkspaceRuntimePortOptions,
): Promise<OpenTuiWorkspaceRuntimePort> {
  const { inventory, routing } = options;
  const panes = canonicalPaneIds(inventory);
  const expected: OpenTuiVerifiedRoutingIdentity = {
    daemonInstanceId: inventory.daemonGeneration,
    workspaceName: inventory.workspaceName,
    // The shell inventory carries a renderer-neutral semantic session id.
    // Verified routing owns the exact raw tmux session name; the two identities
    // are intentionally not interchangeable.
    sessionName: routing.sessionName,
  };
  routing.assertCurrent(expected);
  if (
    routing.daemonInstanceId !== inventory.daemonGeneration ||
    routing.workspaceName !== inventory.workspaceName
  ) {
    throw new Error("OpenTUI runtime inventory does not match its verified route");
  }

  let client: PaneStreamClientWithReceipts | null = null;
  const layoutsByWindow = new Map<string, OpenTuiWorkspaceLayout>();
  let latestLayoutSnapshot: OpenTuiWorkspaceLayoutSnapshot = Object.freeze({
    current: null,
    windows: Object.freeze([]),
  });
  let latestAuthority: SessionRuntimeAuthoritySnapshot | null = null;
  let closed = false;
  let physicalReady = false;
  let coherentSettled = false;
  const canonicalSeedPanes = new Set<string>();
  let resolveCoherent!: () => void;
  let rejectCoherent!: (error: Error) => void;
  const coherent = new Promise<void>((resolve, reject) => {
    resolveCoherent = resolve;
    rejectCoherent = reject;
  });
  let resolveClosed!: (reason?: unknown) => void;
  const closedPromise = new Promise<unknown>((resolve) => {
    resolveClosed = resolve;
  });
  const layoutListeners = new Set<(layout: OpenTuiWorkspaceLayoutSnapshot) => void>();
  const authorityListeners = new Set<(snapshot: SessionRuntimeAuthoritySnapshot) => void>();
  const receiptListeners = new Set<(receipt: InteractionReceipt) => void>();
  let stopClientReceipts: (() => void) | null = null;
  const endpoints = new Map<string, WireTerminalEndpoint>();
  const pendingControls: Array<TerminalDeliveryAck | TerminalDeliveryNack> = [];

  const settleCoherent = (): void => {
    if (
      coherentSettled ||
      closed ||
      !physicalReady ||
      latestLayoutSnapshot.current === null ||
      canonicalSeedPanes.size !== panes.length
    ) {
      return;
    }
    coherentSettled = true;
    options.onDiagnostic?.("coherent", {
      panes: panes.length,
      seededPanes: canonicalSeedPanes.size,
      windows: latestLayoutSnapshot.windows.length,
    });
    resolveCoherent();
  };

  const close = (reason?: unknown): void => {
    if (closed) return;
    closed = true;
    stopClientReceipts?.();
    stopClientReceipts = null;
    pendingControls.length = 0;
    for (const endpoint of endpoints.values()) endpoint.close();
    endpoints.clear();
    try {
      client?.close();
    } finally {
      options.signal?.removeEventListener("abort", abort);
      layoutListeners.clear();
      authorityListeners.clear();
      receiptListeners.clear();
      if (!coherentSettled) {
        coherentSettled = true;
        rejectCoherent(
          reason instanceof Error
            ? reason
            : new Error("OpenTUI runtime closed before coherent readiness"),
        );
      }
      resolveClosed(reason);
    }
  };
  const abort = (): void =>
    close(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new DOMException("OpenTUI runtime connection was aborted", "AbortError"),
    );
  const failConnection = (error: Error): void => {
    try {
      options.onFault?.(error);
    } finally {
      close(error);
    }
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  if (closed) await coherent;

  for (const semanticPaneId of panes) {
    endpoints.set(
      semanticPaneId,
      new WireTerminalEndpoint({
        workspaceName: inventory.workspaceName,
        semanticPaneId,
        ack: (ack) => {
          if (closed) return;
          if (client) client.ack(ack);
          else pendingControls.push(ack);
        },
        nack: (nack) => {
          if (closed) return;
          if (client) client.nack(nack);
          else pendingControls.push(nack);
        },
        canonicalSeedReady: () => {
          canonicalSeedPanes.add(semanticPaneId);
          options.onDiagnostic?.("seed", {
            semanticPaneId,
            seededPanes: canonicalSeedPanes.size,
            expectedPanes: panes.length,
          });
          settleCoherent();
        },
        failConnection,
      }),
    );
  }

  let opened: PaneStreamClientWithReceipts;
  try {
    opened = (await routing.openPaneStream(expected, {
      origin: OPENTUI_ORIGIN,
      hostClientId: OPEN_TUI_HOST_CLIENT_ID,
      requestId: randomUUID(),
      stream: {
        protocolVersion: 1,
        workspaceName: inventory.workspaceName,
        panes: [...panes],
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-v1"],
          richPlacements: true,
        },
      },
      createSocket: createOpenTuiPaneStreamSocket,
      onNegotiated: (pane, negotiation) => {
        const endpoint = endpoints.get(pane);
        if (!endpoint) {
          failConnection(new Error(`Pane-stream negotiated an unrequested pane: ${pane}`));
          return;
        }
        if (!negotiation.accepted) {
          failConnection(
            new Error(`Terminal delivery negotiation failed for ${pane}: ${negotiation.reason}`),
          );
          return;
        }
        endpoint.negotiate(negotiation.negotiated);
      },
      onTerminalDelivery: (pane, message) => {
        const endpoint = endpoints.get(pane);
        if (!endpoint) {
          failConnection(new Error(`Pane-stream delivered an unrequested pane: ${pane}`));
          return;
        }
        endpoint.accept(message);
      },
      onLayout: (frame) => {
        if (closed) return;
        const retained = freezeLayout(frame);
        layoutsByWindow.set(layoutKey(retained), retained);
        latestLayoutSnapshot = layoutSnapshot(layoutsByWindow);
        options.onDiagnostic?.("layout", {
          windows: latestLayoutSnapshot.windows.length,
          current: latestLayoutSnapshot.current !== null,
          panes: retained.panes.length,
        });
        settleCoherent();
        for (const listener of [...layoutListeners]) {
          try {
            listener(latestLayoutSnapshot);
          } catch {
            // Layout diagnostics are observational, never stream backpressure.
          }
        }
      },
      onAuthoritySnapshot: (snapshot) => {
        if (closed || snapshot.generation !== inventory.daemonGeneration) return;
        latestAuthority = snapshot;
        for (const listener of [...authorityListeners]) {
          try {
            listener(snapshot);
          } catch {
            // One UI observer cannot interrupt canonical authority projection.
          }
        }
      },
      onFault: failConnection,
    })) as PaneStreamClientWithReceipts;
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    close(error);
    await coherent;
    throw error;
  }
  if (closed) {
    opened.close();
    await coherent;
    throw new Error("OpenTUI pane-stream closed during startup");
  }
  if (opened.daemonInstanceId !== inventory.daemonGeneration) {
    opened.close();
    const error = new Error("OpenTUI pane-stream connected to another daemon generation");
    close(error);
    await coherent;
    throw error;
  }
  client = opened;
  physicalReady = true;
  options.onDiagnostic?.("physical-ready", { panes: panes.length });
  try {
    for (const control of pendingControls.splice(0)) {
      if (control.type === "terminal.delivery.ack") opened.ack(control);
      else opened.nack(control);
    }
  } catch (cause) {
    failConnection(cause instanceof Error ? cause : new Error(String(cause)));
    await coherent;
  }
  latestAuthority = opened.authoritySnapshot;
  stopClientReceipts =
    opened.onReceipt?.((receipt) => {
      if (closed || receipt.workspaceName !== inventory.workspaceName) return;
      for (const listener of [...receiptListeners]) {
        try {
          listener(receipt);
        } catch {
          // Receipts are observation; consumer failure cannot break transport.
        }
      }
    }) ?? null;
  settleCoherent();
  await coherent;

  return {
    generation: inventory.daemonGeneration,
    closed: closedPromise,
    getLayout: () => latestLayoutSnapshot.current,
    getLayoutSnapshot: () => latestLayoutSnapshot,
    onLayout(listener) {
      if (closed) return () => undefined;
      layoutListeners.add(listener);
      listener(latestLayoutSnapshot);
      return () => layoutListeners.delete(listener);
    },
    subscribeTerminal: async (target: TerminalReplicaAddress) => {
      if (closed) throw new Error("OpenTUI runtime port is closed");
      if (target.workspaceName !== inventory.workspaceName) {
        throw new Error("Terminal subscription belongs to another workspace");
      }
      const endpoint = endpoints.get(target.semanticPaneId);
      if (!endpoint) throw new Error("Terminal subscription is outside runtime inventory");
      return await endpoint.subscription();
    },
    submitIntent: async (operationId, intent) =>
      (await opened.submitIntent(operationId, intent)) ?? undefined,
    sendTerminalInput: (target, input, performanceTraceId) =>
      opened.sendTerminalInput(target, input, performanceTraceId),
    onReceipt(listener) {
      if (closed) return () => undefined;
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
    setPresence: (state) => opened.setPresence(state),
    noteActivity: (activity) => opened.noteActivity(activity),
    requestAuthority: (authority: SessionRuntimeAuthorityKind) =>
      opened.requestAuthority(authority),
    releaseAuthority: (authority: SessionRuntimeAuthorityKind) =>
      opened.releaseAuthority(authority),
    onAuthority(listener) {
      if (closed) return () => undefined;
      authorityListeners.add(listener);
      if (latestAuthority) listener(latestAuthority);
      return () => authorityListeners.delete(listener);
    },
    fitViewport: (cols, rows) => opened.fitViewport(cols, rows),
    close: () => close(),
  };
}
