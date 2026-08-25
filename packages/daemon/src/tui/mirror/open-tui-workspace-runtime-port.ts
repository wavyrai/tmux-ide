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
  decodeVerifiedCompactSemanticTerminalUpdateCooperatively,
  decodeVerifiedLegacySemanticTerminalUpdate,
  terminalDeliveryEncodingAccepted,
  type CompactSemanticCommitProfile,
} from "@tmux-ide/core";
import {
  PaneStreamOperationError,
  type PaneStreamRuntimeClient,
} from "@tmux-ide/daemon-client/pane-stream-client";
import type {
  WorkspaceClientRuntimeInventory,
  WorkspaceClientRuntimePort,
} from "@tmux-ide/daemon-client/workspace-client-types";

import {
  type OpenTuiVerifiedRoutingContext,
  type OpenTuiVerifiedRoutingIdentity,
} from "./open-tui-verified-routing.ts";
import { createOpenTuiPaneStreamSocket } from "./open-tui-pane-stream-socket.ts";
import { currentTuiPerformanceEventSink } from "./performance-events.ts";
import type { CausalCellClientLedger } from "./runtime/causal-cell-client-ledger.ts";

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
  getAuthoritySnapshot(): SessionRuntimeAuthoritySnapshot | null;
  getLayout(): OpenTuiWorkspaceLayout | null;
  getLayoutSnapshot(): OpenTuiWorkspaceLayoutSnapshot;
  onLayout(listener: (layout: OpenTuiWorkspaceLayoutSnapshot) => void): () => void;
  fitViewport(cols: number, rows: number): Promise<"ok" | "geometry-authority-conflict">;
}

export interface ConnectOpenTuiWorkspaceRuntimePortOptions {
  readonly inventory: WorkspaceClientRuntimeInventory;
  readonly routing: OpenTuiVerifiedRoutingContext;
  readonly signal?: AbortSignal;
  readonly causalCellLedger?: CausalCellClientLedger;
  /** Prime inventory-wide canonical consumers before coherence can settle. */
  readonly prepareRuntime?: (runtime: OpenTuiWorkspaceRuntimePort) => void | Promise<void>;
  readonly onFault?: (error: Error) => void;
  readonly onDiagnostic?: (
    phase:
      | "layout"
      | "seed"
      | "physical-ready"
      | "coherent"
      | "stream-open-start"
      | "stream-open-resolved"
      | "clock-calibration"
      | "compact-decode"
      | `stream-${
          | "issue-start"
          | "issue-response"
          | "socket-created"
          | "socket-open"
          | "ready-frame"
          | "clock-calibration"}`,
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
  readonly nextSnapshot: TerminalReplicaSnapshot | null;
  readonly metadata: TerminalReplicaDeliveryMetadata | undefined;
}

type VerifiedTerminalDelivery = Awaited<
  ReturnType<typeof decodeVerifiedCompactSemanticTerminalUpdateCooperatively>
>;

function freezeLayout(frame: OpenTuiWorkspaceLayout): OpenTuiWorkspaceLayout {
  return Object.freeze({
    ...frame,
    panes: frame.panes.map((pane) => Object.freeze({ ...pane })),
  });
}

function layoutKey(frame: OpenTuiWorkspaceLayout): string | null {
  if (frame.semanticWindowId) return `semantic:${frame.semanticWindowId}`;
  const panes = frame.panes.flatMap(({ pane }) => (typeof pane === "string" ? [pane] : [])).sort();
  if (
    panes.length === 0 ||
    panes.length !== frame.panes.length ||
    panes.some((pane) => pane.length === 0 || pane.length > 256) ||
    new Set(panes).size !== panes.length
  )
    return null;
  return `panes:${panes.join("\u0000")}`;
}

function layoutSnapshot(
  windows: ReadonlyMap<string, OpenTuiWorkspaceLayout>,
  currentWindowKey: string | null = null,
): OpenTuiWorkspaceLayoutSnapshot {
  const selectedKey =
    currentWindowKey ??
    [...windows.entries()].find(([, frame]) => frame.currentWindow)?.[0] ??
    null;
  const frames = Object.freeze(
    [...windows.entries()].map(([key, frame]) =>
      frame.currentWindow === (key === selectedKey)
        ? frame
        : freezeLayout({ ...frame, currentWindow: key === selectedKey }),
    ),
  );
  return Object.freeze({
    current: frames.find((frame) => frame.currentWindow) ?? null,
    windows: frames,
  });
}

function layoutFrameSemanticallyEqual(
  left: OpenTuiWorkspaceLayout,
  right: OpenTuiWorkspaceLayout,
): boolean {
  return (
    left.semanticWindowId === right.semanticWindowId &&
    left.windowName === right.windowName &&
    left.currentWindow === right.currentWindow &&
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.zoomed === right.zoomed &&
    left.paneBorderStatus === right.paneBorderStatus &&
    left.panes.length === right.panes.length &&
    left.panes.every((pane, index) => {
      const candidate = right.panes[index];
      return (
        candidate !== undefined &&
        pane.pane === candidate.pane &&
        pane.left === candidate.left &&
        pane.top === candidate.top &&
        pane.width === candidate.width &&
        pane.height === candidate.height &&
        pane.active === candidate.active
      );
    })
  );
}

function layoutSnapshotsSemanticallyEqual(
  left: OpenTuiWorkspaceLayoutSnapshot,
  right: OpenTuiWorkspaceLayoutSnapshot,
): boolean {
  return (
    left.windows.length === right.windows.length &&
    left.windows.every((window, index) => {
      const candidate = right.windows[index];
      return candidate !== undefined && layoutFrameSemanticallyEqual(window, candidate);
    })
  );
}

function layoutExactlyCoversPanes(
  snapshot: OpenTuiWorkspaceLayoutSnapshot,
  expectedPanes: readonly string[],
): boolean {
  if (
    snapshot.current === null ||
    snapshot.windows.filter((window) => window.currentWindow).length !== 1
  )
    return false;
  const observed = snapshot.windows.flatMap((window) => window.panes.map((pane) => pane.pane));
  if (!observed.every((pane): pane is string => typeof pane === "string")) return false;
  const observedPanes = observed as string[];
  return (
    new Set(observedPanes).size === observedPanes.length &&
    observedPanes.length === expectedPanes.length &&
    [...observedPanes]
      .sort((left, right) => left.localeCompare(right))
      .every((pane, index) => pane === expectedPanes[index])
  );
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
  payload: ReturnType<typeof decodeVerifiedLegacySemanticTerminalUpdate>["payload"],
  canonicalSnapshot: TerminalReplicaSnapshot | null,
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
      snapshot: canonicalSnapshot!,
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
  readonly #compactDecodeProfile: ((profile: CompactSemanticCommitProfile) => void) | undefined;
  #negotiated: TerminalDeliveryNegotiated | null = null;
  #assembler: TerminalDeliveryAssembler | null = null;
  #assemblyStorage: Uint8Array | null = null;
  #envelope: TerminalDeliveryEnvelope | null = null;
  #appliedRevision = -1;
  #incarnation: string | null = null;
  #cols = 0;
  #rows = 0;
  #canonicalSnapshot: TerminalReplicaSnapshot | null = null;
  #reseedRequired = false;
  #subscription: WireTerminalSubscription | null = null;
  #pending: PendingDelivery | null = null;
  #rejectedTransactionId: string | null = null;
  #decodeToken: object | null = null;
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
    compactDecodeProfile?: (profile: CompactSemanticCommitProfile) => void;
  }) {
    this.#workspaceName = options.workspaceName;
    this.#semanticPaneId = options.semanticPaneId;
    this.#ack = options.ack;
    this.#nack = options.nack;
    this.#failConnection = options.failConnection;
    this.#canonicalSeedReady = options.canonicalSeedReady;
    this.#compactDecodeProfile = options.compactDecodeProfile;
    this.#ready = new Promise<boolean>((resolve) => {
      this.#resolveReady = resolve;
    });
  }

  negotiate(negotiated: TerminalDeliveryNegotiated): void {
    if (this.#closed || this.#negotiated) {
      this.#failConnection(new Error(`Duplicate terminal negotiation for ${this.#semanticPaneId}`));
      return;
    }
    if (negotiated.encoding !== "semantic-v1" && negotiated.encoding !== "semantic-compact-v1") {
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

  accept(message: TerminalDeliveryServerMessage): void | { readonly consumedOwnedChunk: true } {
    if (this.#closed) return;
    if (!this.#negotiated) {
      this.#failConnection(
        new Error(`Terminal delivery arrived before negotiation for ${this.#semanticPaneId}`),
      );
      return;
    }
    if (message.type === "terminal.delivery.fault") {
      const detail = message.message.trim();
      this.#failConnection(
        new Error(
          `Terminal delivery failed for ${this.#semanticPaneId}: ${message.reason}${detail ? ` (${detail})` : ""}`,
        ),
      );
      return;
    }
    if (message.type === "terminal.delivery") {
      this.#acceptEnvelope(message);
      return;
    }
    return this.#acceptChunk(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#assembler = null;
    this.#assemblyStorage = null;
    this.#envelope = null;
    this.#pending = null;
    this.#decodeToken = null;
    this.#canonicalSnapshot = null;
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
    if (this.#decodeToken !== null) {
      // A negotiated server owns exactly one flight. Overlap while a compact
      // decode is yielding is a connection-level protocol violation: retire
      // the incumbent token atomically rather than NACKing either ambiguous
      // transaction and leaving a poisoned endpoint behind.
      this.#decodeToken = null;
      this.#assembler = null;
      this.#envelope = null;
      this.#pending = null;
      this.#reseedRequired = true;
      this.#failConnection(new Error(`Overlapping terminal delivery for ${this.#semanticPaneId}`));
      return;
    }
    if (envelope.generation !== negotiated.generation) {
      this.#reject("stale-generation", envelope);
      return;
    }
    if (
      envelope.workspaceName !== this.#workspaceName ||
      envelope.semanticPaneId !== this.#semanticPaneId ||
      envelope.protocolVersion !== negotiated.protocolVersion ||
      envelope.deliveryNonce !== negotiated.deliveryNonce ||
      !terminalDeliveryEncodingAccepted(negotiated, envelope.encoding) ||
      envelope.richPlacements !== negotiated.richPlacements ||
      this.#envelope !== null ||
      this.#pending !== null ||
      this.#decodeToken !== null
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
    this.#rejectedTransactionId = null;
    this.#assembler = new TerminalDeliveryAssembler(envelope, this.#assemblyStorage ?? undefined);
    this.#assemblyStorage = null;
  }

  #acceptChunk(
    chunk: Extract<TerminalDeliveryServerMessage, { type: "terminal.delivery.chunk" }>,
  ): void | { readonly consumedOwnedChunk: true } {
    // A rejected envelope is still followed by its already-framed chunks.
    // The first NACK retires the daemon flight, so rejecting those chunks
    // again would accidentally target the next flight.
    if (chunk.transactionId === this.#rejectedTransactionId) return;
    const assembler = this.#assembler;
    const envelope = this.#envelope;
    if (!assembler || !envelope) {
      this.#reject("protocol-violation", null, chunk.transactionId);
      return;
    }
    // Keep the ordinary delivery path allocation/clock free. The reference
    // collector is installed only by an explicit diagnostic journey.
    const performanceSink = currentTuiPerformanceEventSink();
    const parseStartedAt = performanceSink ? performance.now() : 0;
    try {
      assembler.write(chunk);
      const consumed = Object.freeze({ consumedOwnedChunk: true as const });
      if (chunk.index + 1 < envelope.chunkCount) return consumed;
      const bytes = assembler.complete();
      if (envelope.encoding === "semantic-compact-v1") {
        const token = Object.freeze({});
        this.#decodeToken = token;
        void this.#completeCooperativeCompactDecode(
          token,
          envelope,
          bytes,
          performanceSink,
          parseStartedAt,
        );
        return consumed;
      }
      const verified = decodeVerifiedLegacySemanticTerminalUpdate(
        bytes,
        this.#canonicalSnapshot,
        envelope.canonicalStateHash,
      );
      this.#acceptVerified(envelope, verified, performanceSink, parseStartedAt);
      return consumed;
    } catch {
      this.#reject("decode-failed", envelope);
    }
  }

  async #completeCooperativeCompactDecode(
    token: object,
    envelope: TerminalDeliveryEnvelope,
    bytes: Uint8Array,
    performanceSink: ReturnType<typeof currentTuiPerformanceEventSink>,
    parseStartedAt: number,
  ): Promise<void> {
    try {
      const verified = await decodeVerifiedCompactSemanticTerminalUpdateCooperatively(
        bytes,
        this.#canonicalSnapshot,
        envelope.canonicalStateHash,
        {
          grantReducerAdoption: true,
          ...(this.#compactDecodeProfile ? { onComplete: this.#compactDecodeProfile } : {}),
          yieldControl: async () => {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (this.#closed || this.#decodeToken !== token || this.#envelope !== envelope)
              throw new Error("Cooperative terminal decode was retired");
          },
        },
      );
      if (
        this.#closed ||
        this.#decodeToken !== token ||
        this.#envelope !== envelope ||
        this.#assembler === null
      )
        return;
      this.#decodeToken = null;
      this.#acceptVerified(envelope, verified, performanceSink, parseStartedAt);
    } catch {
      if (!this.#closed && this.#decodeToken === token && this.#envelope === envelope) {
        this.#decodeToken = null;
        this.#reject("decode-failed", envelope);
      }
    }
  }

  #acceptVerified(
    envelope: TerminalDeliveryEnvelope,
    verified: VerifiedTerminalDelivery,
    performanceSink: ReturnType<typeof currentTuiPerformanceEventSink>,
    parseStartedAt: number,
  ): void {
    try {
      const payload = verified.payload;
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
      const nextSnapshot = verified.canonicalSnapshot;
      this.#pending = Object.freeze({
        envelope,
        update: updateFromDelivery(
          envelope,
          payload,
          nextSnapshot,
          dimensions.cols,
          dimensions.rows,
        ),
        nextCols: dimensions.cols,
        nextRows: dimensions.rows,
        nextSnapshot,
        metadata: Object.freeze({
          representationHash: envelope.representationHash,
          ...(envelope.performanceTraceId
            ? { performanceTraceId: envelope.performanceTraceId }
            : {}),
        }),
      });
      const revisionLagPeak = Math.max(
        0,
        envelope.canonicalRevision - Math.max(0, this.#appliedRevision + 1),
      );
      const reseed = payload.frame === "seed" && this.#hasCanonicalSeed;
      if (payload.frame === "seed" && !this.#hasCanonicalSeed) {
        this.#hasCanonicalSeed = true;
        this.#readySettled = true;
        this.#resolveReady(true);
        this.#canonicalSeedReady();
      }
      this.#flush();
      performanceSink?.terminalDelivery({
        parseMs: performance.now() - parseStartedAt,
        // WireTerminalEndpoint admits at most one assembled transaction and
        // refuses another envelope until that transaction is delivered.
        queuePeak: 1,
        queueCapacity: 1,
        settledQueueDepth: this.#pending === null ? 0 : 1,
        revisionLagPeak,
        reseed,
      });
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
      // Delivery is synchronous. Canonical consumers may reject an admitted
      // update and request generation repair from inside the callback, which
      // closes this endpoint. Never emit the admission ACK after that repair.
      if (this.#closed || subscription.closed) return;
    } catch (error) {
      this.#failConnection(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.#appliedRevision = delivery.envelope.canonicalRevision;
    this.#incarnation = delivery.envelope.incarnation;
    this.#cols = delivery.nextCols;
    this.#rows = delivery.nextRows;
    this.#canonicalSnapshot = delivery.nextSnapshot;
    this.#reseedRequired = false;
    this.#pending = null;
    this.#decodeToken = null;
    this.#envelope = null;
    if (this.#assembler) {
      const storage = this.#assembler.releaseStorage();
      this.#assemblyStorage = storage.byteLength <= 2 * 1_024 * 1_024 ? storage : null;
    }
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
    this.#decodeToken = null;
    this.#rejectedTransactionId = attempted?.transactionId ?? transactionId;
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
  let currentWindowKey: string | null = null;
  let lastRejectedLayoutSnapshot: OpenTuiWorkspaceLayoutSnapshot | null = null;
  let latestLayoutSnapshot: OpenTuiWorkspaceLayoutSnapshot = Object.freeze({
    current: null,
    windows: Object.freeze([]),
  });
  let latestAuthority: SessionRuntimeAuthoritySnapshot | null = null;
  let closed = false;
  let repairRequested = false;
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
      !layoutExactlyCoversPanes(latestLayoutSnapshot, panes) ||
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
        ...(options.onDiagnostic
          ? {
              compactDecodeProfile: (profile: CompactSemanticCommitProfile) =>
                options.onDiagnostic?.("compact-decode", { ...profile }),
            }
          : {}),
        failConnection,
      }),
    );
  }

  const performanceSink = currentTuiPerformanceEventSink();
  let clockCalibration:
    | import("@tmux-ide/daemon-client/pane-stream-clock-calibration").PaneStreamClockCalibration
    | null = null;
  const clockFields = () =>
    clockCalibration
      ? {
          clockOffsetLowerMicros: clockCalibration.offsetLowerMicros,
          clockOffsetUpperMicros: clockCalibration.offsetUpperMicros,
          clockUncertaintyMicros: clockCalibration.uncertaintyMicros,
          clockCalibratedAtMicros: clockCalibration.calibratedAtMicros,
          clockCalibrationRequestId: clockCalibration.requestId,
        }
      : {};
  let opened: PaneStreamClientWithReceipts;
  try {
    options.onDiagnostic?.("stream-open-start", { panes: panes.length });
    opened = (await routing.openPaneStream(expected, {
      origin: OPENTUI_ORIGIN,
      hostClientId: OPEN_TUI_HOST_CLIENT_ID,
      requestId: randomUUID(),
      requestInitialInputAuthority: false,
      ...(options.causalCellLedger || performanceSink?.terminalTraceStage
        ? {
            diagnosticCapabilities: [
              ...(options.causalCellLedger ? (["causal-cell-v1"] as const) : []),
              ...(performanceSink?.terminalTraceStage ? (["clock-bounds-v1"] as const) : []),
            ],
            ...(performanceSink?.terminalTraceStage
              ? {
                  onClockCalibration: (
                    calibration:
                      | import("@tmux-ide/daemon-client/pane-stream-clock-calibration").PaneStreamClockCalibration
                      | null,
                  ) => {
                    clockCalibration = calibration;
                  },
                  onClockCalibrationOutcome: (
                    outcome: import("@tmux-ide/daemon-client/pane-stream-clock-calibration").PaneStreamClockCalibrationOutcome,
                  ) => {
                    try {
                      performanceSink.terminalClockCalibration?.({
                        ...outcome,
                        processId: `opentui:${process.pid}`,
                        clockId: "opentui-performance-now",
                        clockKind: "performance-now",
                        atMicros: Math.floor(performance.now() * 1_000),
                      });
                    } catch {
                      // Diagnostics cannot alter stream readiness.
                    }
                    try {
                      options.onDiagnostic?.("clock-calibration", {
                        reason: outcome.reason,
                        attemptedProbes: outcome.attemptedProbes,
                        receivedProbes: outcome.receivedProbes,
                        validProbes: outcome.validProbes,
                        selectedProbes: outcome.selectedProbes,
                        selectedProbe: outcome.selectedProbe,
                      });
                    } catch {
                      // Diagnostics cannot alter stream readiness.
                    }
                  },
                }
              : {}),
            onCausalCellProof: (proof: import("@tmux-ide/contracts").CausalCellProofV1) =>
              options.causalCellLedger?.noteProof(proof),
            onCausalCellFailure: (failure: import("@tmux-ide/contracts").CausalCellFailureV1) =>
              options.causalCellLedger?.fail(failure.traceId, failure.reason, failure.diagnostic),
          }
        : {}),
      signal: options.signal,
      stream: {
        protocolVersion: 1,
        workspaceName: inventory.workspaceName,
        panes: [...panes],
        viewerMode: "interactive",
        terminalDelivery: {
          protocolVersions: [1],
          encodings: ["semantic-compact-v1", "semantic-v1"],
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
        return endpoint.accept(message);
      },
      ...(performanceSink?.terminalTraceStage
        ? {
            onInputTransportStage: ({
              traceId,
              operation,
              atMicros,
              pane,
              bufferedAmount,
              frameBytes,
              drained,
              sharedMicros,
            }) => {
              try {
                performanceSink.terminalTraceStage?.({
                  traceId,
                  scenario: "terminal-input-to-paint",
                  stage: "client",
                  operation,
                  processId: `opentui:${process.pid}`,
                  clockId: "opentui-performance-now",
                  clockKind: "performance-now",
                  atMicros,
                  ...(sharedMicros === undefined ? {} : { sharedMicros }),
                  ...clockFields(),
                  semanticPaneId: pane,
                  generation: expected.daemonInstanceId,
                  ...(bufferedAmount === undefined ? {} : { bufferedAmount }),
                  ...(frameBytes === undefined ? {} : { frameBytes }),
                  ...(drained === undefined ? {} : { drained }),
                });
              } catch {
                // Diagnostics cannot alter input transport truth.
              }
            },
            onTerminalFrameArrival: ({ traceId, atMicros, sharedMicros }) => {
              try {
                performanceSink.terminalTraceStage?.({
                  traceId,
                  scenario: "terminal-input-to-paint",
                  stage: "client",
                  operation: "socket-frame-arrival",
                  processId: `opentui:${process.pid}`,
                  clockId: "opentui-performance-now",
                  clockKind: "performance-now",
                  atMicros,
                  generation: expected.daemonInstanceId,
                  ...(sharedMicros === undefined ? {} : { sharedMicros }),
                  ...clockFields(),
                });
              } catch {
                // Diagnostics cannot alter terminal frame delivery.
              }
            },
            onInputAck: ({ traceId, sharedMicros }) => {
              if (!traceId || sharedMicros === undefined) return;
              try {
                performanceSink.terminalTraceStage?.({
                  traceId,
                  scenario: "terminal-input-to-paint",
                  stage: "client",
                  operation: "pane-stream-input-ack-callback",
                  processId: `opentui:${process.pid}`,
                  clockId: "opentui-performance-now",
                  clockKind: "performance-now",
                  atMicros: Math.floor(performance.now() * 1_000),
                  generation: expected.daemonInstanceId,
                  sharedMicros,
                  ...clockFields(),
                });
              } catch {
                // Diagnostics cannot alter input acknowledgement.
              }
            },
          }
        : {}),
      onLayout: (frame) => {
        if (closed) return;
        const retained = freezeLayout(frame);
        const key = layoutKey(retained);
        if (key === null) {
          options.onDiagnostic?.("layout", {
            windows: layoutsByWindow.size,
            current: currentWindowKey !== null,
            panes: retained.panes.length,
            rejected: "ambiguous-window-identity",
          });
          return;
        }
        layoutsByWindow.set(key, retained);
        // tmux reports a switch as incumbent=false followed by target=true.
        // Retain the incumbent through that pair and publish one unique current
        // window only when the positive target frame arrives.
        if (retained.currentWindow) currentWindowKey = key;
        const candidate = layoutSnapshot(layoutsByWindow, currentWindowKey);
        if (!layoutExactlyCoversPanes(candidate, panes)) {
          if (
            lastRejectedLayoutSnapshot &&
            layoutSnapshotsSemanticallyEqual(candidate, lastRejectedLayoutSnapshot)
          )
            return;
          lastRejectedLayoutSnapshot = candidate;
          options.onDiagnostic?.("layout", {
            windows: candidate.windows.length,
            current: candidate.current !== null,
            panes: retained.panes.length,
            rejected: "incomplete-inventory-coverage",
          });
          return;
        }
        lastRejectedLayoutSnapshot = null;
        if (layoutSnapshotsSemanticallyEqual(candidate, latestLayoutSnapshot)) return;
        latestLayoutSnapshot = candidate;
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
      onLayoutSnapshot: (snapshot) => {
        if (closed) return;
        const replacement = new Map<string, ReturnType<typeof freezeLayout>>();
        let replacementCurrent: string | null = null;
        for (const frame of snapshot.layouts) {
          const retained = freezeLayout(frame);
          const key = layoutKey(retained);
          if (key === null || replacement.has(key))
            return failConnection(new Error("invalid layout snapshot"));
          replacement.set(key, retained);
          if (retained.currentWindow) {
            if (replacementCurrent !== null)
              return failConnection(new Error("invalid layout snapshot current window"));
            replacementCurrent = key;
          }
        }
        const candidate = layoutSnapshot(replacement, replacementCurrent);
        if (!layoutExactlyCoversPanes(candidate, panes))
          return failConnection(new Error("layout snapshot does not cover terminal inventory"));
        layoutsByWindow.clear();
        for (const [key, layout] of replacement) layoutsByWindow.set(key, layout);
        currentWindowKey = replacementCurrent;
        lastRejectedLayoutSnapshot = null;
        if (layoutSnapshotsSemanticallyEqual(candidate, latestLayoutSnapshot)) return;
        latestLayoutSnapshot = candidate;
        settleCoherent();
        for (const listener of [...layoutListeners]) {
          try {
            listener(latestLayoutSnapshot);
          } catch {
            // Layout observers do not own the stream.
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
      onConnectionDiagnostic: (phase, details) =>
        options.onDiagnostic?.(`stream-${phase}`, details),
    })) as PaneStreamClientWithReceipts;
    options.onDiagnostic?.("stream-open-resolved", { panes: panes.length });
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
  const runtimePort: OpenTuiWorkspaceRuntimePort = {
    generation: inventory.daemonGeneration,
    getAuthoritySnapshot: () => latestAuthority,
    closed: closedPromise,
    requestTerminalRepair: (target, reason) => {
      if (
        closed ||
        repairRequested ||
        target.workspaceName !== inventory.workspaceName ||
        !panes.includes(target.semanticPaneId)
      ) {
        return;
      }
      repairRequested = true;
      failConnection(
        new Error(`Canonical terminal repair requested for ${target.semanticPaneId}: ${reason}`),
      );
    },
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
    sendTerminalInput: (target, input, performanceTraceId, causalProbe) =>
      opened.sendTerminalInput(target, input, performanceTraceId, causalProbe),
    onReceipt(listener) {
      if (closed) return () => undefined;
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
    setPresence: (state) => opened.setPresence(state),
    noteActivity: (activity) => opened.noteActivity(activity),
    ownsConnectionAuthority: (authority) => opened.ownsConnectionAuthority(authority),
    connectionAuthorityClientId: (authority) => opened.connectionAuthorityClientId(authority),
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
    fitViewport: async (cols, rows) => {
      try {
        return await opened.fitViewport(cols, rows);
      } catch (error) {
        if (error instanceof PaneStreamOperationError && error.code === "authority-rejected")
          return "geometry-authority-conflict";
        throw error;
      }
    },
    close: () => close(),
  };
  try {
    await options.prepareRuntime?.(runtimePort);
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    close(error);
    throw error;
  }
  settleCoherent();
  await coherent;
  return runtimePort;
}
