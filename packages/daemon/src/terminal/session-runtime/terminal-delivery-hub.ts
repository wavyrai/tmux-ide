import {
  TERMINAL_DELIVERY_PATCH_TO_SEED_BYTES,
  TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
  TerminalDeliveryEnvelopeSchemaZ,
  TerminalDeliveryAckSchemaZ,
  TerminalDeliveryNackSchemaZ,
  TerminalDeliveryOfferSchemaZ,
  TerminalDeliveryVisibilitySchemaZ,
  type CanonicalTerminalReplicaUpdate,
  type SessionRuntimeGeneration,
  type TerminalDeliveryAck,
  type TerminalDeliveryEnvelope,
  type TerminalDeliveryNack,
  type TerminalDeliveryNegotiationResult,
  type TerminalDeliveryOffer,
  type TerminalDeliveryServerMessage,
  type TerminalDeliveryVisibility,
  type TerminalReplicaSnapshot,
  type TerminalSemanticDeliveryPayload,
} from "@tmux-ide/contracts";
import {
  TerminalDeliveryStateTooLargeError,
  applyTerminalReplicaUpdate,
  encodeCompactSemanticTerminalUpdate,
  encodeAnsiTerminalRepresentation,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  negotiateTerminalDelivery,
  preaccountSemanticTerminalUpdateBytes,
  type TerminalReplicaState,
} from "@tmux-ide/core";
import type {
  TerminalReplicaCommittedRaw,
  TerminalReplicaSourceSubscription,
} from "./terminal-replica-owner.ts";
import {
  SYSTEM_SESSION_RUNTIME_SCHEDULER,
  type SessionRuntimeScheduler,
  type SessionRuntimeTimer,
} from "./runtime-scheduler.ts";
import {
  DISABLED_SESSION_RUNTIME_OBSERVABILITY,
  type SessionRuntimeObservability,
  type SessionRuntimeTraceContext,
} from "./runtime-observability.ts";
import { registerTerminalDeliveryObservationOrdinal } from "./terminal-delivery-observation-identity.ts";

export const MAX_CANONICAL_REVISIONS = 128;
export const MAX_RAW_JOURNAL_BYTES = 4 * 1024 * 1024;
/** Eight workload conditioning revisions fill the cache before measured samples begin. */
export const MAX_REPRESENTATION_CACHE_ENTRIES = 8;
export const MAX_REPRESENTATION_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_CLIENTS = 64;
const MAX_PANES = 32;
const MAX_CONNECTIONS = MAX_CLIENTS * MAX_PANES;
const BACKGROUND_CADENCE_MS = 100;

export interface TerminalDeliveryMetrics {
  /** Unique delivery subscribers, independent of their pane count. */
  readonly clients: number;
  readonly connections: number;
  readonly inFlight: number;
  readonly latestPointers: number;
  readonly coalesced: number;
  readonly reseeds: number;
  readonly nacks: number;
  readonly representationCacheBytes: number;
  readonly rawJournalBytes: number;
  readonly maxSlowClientMs: number;
  readonly queueDepth: number;
  readonly maxQueueDepth: number;
  readonly inFlightBytes: number;
}

export interface TerminalDeliveryConvergenceSnapshot {
  readonly panes: readonly {
    readonly semanticPaneId: string;
    readonly incarnation: string;
    readonly revision: number;
    readonly stateHash: string;
  }[];
  readonly clients: readonly {
    readonly clientId: string;
    readonly semanticPaneId: string;
    readonly visibility: TerminalDeliveryVisibility;
    readonly baselineRevision: number;
    readonly baselineHash: string | null;
    readonly inFlightRevision: number | null;
    readonly latestRevision: number | null;
    readonly queueDepth: number;
  }[];
}

export interface TerminalDeliveryConnection {
  readonly negotiation: TerminalDeliveryNegotiationResult;
  ack(ack: TerminalDeliveryAck): void;
  nack(nack: TerminalDeliveryNack): void;
  setVisibility(visibility: TerminalDeliveryVisibility): void;
  close(): Promise<void>;
}

interface RevisionRecord {
  readonly update: CanonicalTerminalReplicaUpdate;
  readonly state: TerminalReplicaState;
  readonly trace: SessionRuntimeTraceContext | null;
}

interface PendingCanonicalUpdate {
  readonly update: CanonicalTerminalReplicaUpdate;
  readonly trace: SessionRuntimeTraceContext | null;
}

interface PaneState {
  readonly owner: TerminalDeliverySourceOwner;
  source: TerminalReplicaSourceSubscription | null;
  start: Promise<void>;
  current: TerminalReplicaState | null;
  latest: RevisionRecord | null;
  readonly revisions: Map<number, RevisionRecord>;
  readonly raw: Map<number, Uint8Array>;
  rawBytes: number;
  rawFloorRevision: number;
  lastRawRevision: number;
  readonly pendingCanonical: PendingCanonicalUpdate[];
  canonicalScheduled: boolean;
  pendingDeliveryTrace: SessionRuntimeTraceContext | null;
}

export interface TerminalDeliverySourceOwner {
  subscribeSource(
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      trace: SessionRuntimeTraceContext | null,
    ) => void,
    onRaw: (record: TerminalReplicaCommittedRaw) => void,
  ): Promise<TerminalReplicaSourceSubscription>;
}

interface ClientState {
  readonly key: string;
  readonly clientId: string;
  readonly diagnosticClientId: string;
  readonly diagnosticSurface: string;
  readonly diagnosticLaneId: string;
  readonly diagnosticRequestId: string;
  readonly paneId: string;
  readonly negotiated: Extract<TerminalDeliveryNegotiationResult, { accepted: true }>["negotiated"];
  readonly accept: (message: TerminalDeliveryServerMessage) => void | Promise<void>;
  visibility: TerminalDeliveryVisibility;
  baselineRevision: number;
  baselineHash: string | null;
  reseedRequired: boolean;
  inFlight: {
    envelope: TerminalDeliveryEnvelope;
    deliveryOrdinal: number;
    bytes: Uint8Array;
    nextChunk: number;
    sentAt: number;
  } | null;
  latestRevision: number | null;
  scheduled: boolean;
  closed: boolean;
  lifecycleOpenRecorded: boolean;
  readonly outgoing: Array<() => TerminalDeliveryServerMessage>;
  sending: boolean;
  retireAfterDrain: boolean;
  lastAck: TerminalDeliveryAck | null;
  /** Delivery displaced by authoritative source close; its racing ACK is benign. */
  sourceClosedFlight: TerminalDeliveryEnvelope | null;
  backgroundTimer: SessionRuntimeTimer | null;
}

interface CachedRepresentation {
  readonly bytes: Uint8Array;
  readonly encoding?: "semantic-v1" | "semantic-compact-v1";
  readonly frame: "seed" | "patch" | "tombstone";
  readonly canonicalEquivalent: boolean;
  readonly history: "complete" | "truncated" | "not-applicable";
  readonly representationHash?: string;
  /** Internal reachability metadata; never serialized onto the wire. */
  readonly cachePaneId?: string;
  readonly cacheBaseRevision?: number;
  readonly cacheTargetRevision?: number;
  readonly selectionObservation?: Readonly<{
    attemptedPatchBytes: number | null;
    attemptedSeedBytes: number | null;
    attemptedLegacyPatchBytes: number | null;
    attemptedLegacySeedBytes: number | null;
    attemptedLegacyPatchAtLeastBytes: number | null;
    attemptedLegacySeedAtLeastBytes: number | null;
    attemptedLegacyPatchSizeCapped: boolean;
    attemptedLegacySeedSizeCapped: boolean;
    attemptedCompactPatchBytes: number | null;
    attemptedCompactSeedBytes: number | null;
    selectedEncoding: "semantic-v1" | "semantic-compact-v1";
    selectionStatus:
      | "patch-preferred"
      | "seed-preferred"
      | "patch-fallback"
      | "legacy-patch-fallback"
      | "legacy-seed-fallback"
      | "direct-seed"
      | "direct-tombstone";
  }>;
}

type SemanticSelectionObservation = NonNullable<CachedRepresentation["selectionObservation"]>;

type ExactSemanticSelectionObservation = Pick<
  SemanticSelectionObservation,
  "attemptedPatchBytes" | "attemptedSeedBytes" | "selectionStatus"
>;

class ExactSemanticRepresentationSelectionError extends TerminalDeliveryStateTooLargeError {
  readonly selectionObservation: ExactSemanticSelectionObservation;

  constructor(bytes: number, selectionObservation: ExactSemanticSelectionObservation) {
    super(bytes);
    this.name = "ExactSemanticRepresentationSelectionError";
    this.selectionObservation = selectionObservation;
  }
}

class TerminalDeliveryRepresentationSelectionError extends TerminalDeliveryStateTooLargeError {
  readonly selectionObservation: SemanticSelectionObservation;
  readonly sizeCapped: boolean;
  readonly atLeastBytes: number | null;

  constructor(bytes: number, selectionObservation: SemanticSelectionObservation) {
    super(bytes);
    this.name = "TerminalDeliveryRepresentationSelectionError";
    this.selectionObservation = selectionObservation;
    this.atLeastBytes =
      selectionObservation.attemptedLegacyPatchAtLeastBytes ??
      selectionObservation.attemptedLegacySeedAtLeastBytes;
    this.sizeCapped = this.atLeastBytes !== null;
    if (this.atLeastBytes !== null)
      this.message = `Terminal delivery representation is at least ${this.atLeastBytes} bytes; maximum is ${TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES}`;
  }
}

class TerminalDeliveryPreaccountLimitError extends TerminalDeliveryStateTooLargeError {
  readonly atLeastBytes: number;
  readonly sizeCapped = true;

  constructor(atLeastBytes: number) {
    super(atLeastBytes);
    this.name = "TerminalDeliveryPreaccountLimitError";
    this.message = `Terminal delivery representation is at least ${atLeastBytes} bytes; maximum is ${TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES}`;
    this.atLeastBytes = atLeastBytes;
  }
}

/** One bounded, renderer-independent delivery coordinator per SessionRuntime. */
export class SessionRuntimeTerminalDeliveryHub {
  readonly #ownerForPane: (semanticPaneId: string) => TerminalDeliverySourceOwner;
  readonly #scheduler: SessionRuntimeScheduler;
  readonly #observability: SessionRuntimeObservability;
  readonly #panes = new Map<string, PaneState>();
  readonly #clients = new Map<string, ClientState>();
  /** Synchronous reservations held while an async pane source is starting. */
  readonly #pendingClients = new Map<string, string>();
  readonly #cache = new Map<string, CachedRepresentation>();
  #cacheBytes = 0;
  #coalesced = 0;
  #reseeds = 0;
  #nacks = 0;
  #maxSlowClientMs = 0;
  #maxQueueDepth = 0;
  #deliveryOrdinal = 0;
  #deliveryLifecycleOrdinal = 0;
  #deliveryStatusOrdinal = 0;
  #closed = false;

  constructor(
    readonly generation: SessionRuntimeGeneration,
    readonly workspaceName: string,
    ownerForPane: (semanticPaneId: string) => TerminalDeliverySourceOwner,
    options: {
      readonly scheduler?: SessionRuntimeScheduler;
      readonly observability?: SessionRuntimeObservability;
    } = {},
  ) {
    this.#ownerForPane = ownerForPane;
    this.#scheduler = options.scheduler ?? SYSTEM_SESSION_RUNTIME_SCHEDULER;
    this.#observability = options.observability ?? DISABLED_SESSION_RUNTIME_OBSERVABILITY;
  }

  async open(
    clientId: string,
    semanticPaneId: string,
    offerInput: TerminalDeliveryOffer,
    accept: (message: TerminalDeliveryServerMessage) => void | Promise<void>,
    diagnosticIdentity: Readonly<{
      clientId: string;
      surface: string;
      laneId: string;
      requestId?: string;
    }> = Object.freeze({ clientId, surface: "direct", laneId: clientId }),
  ): Promise<TerminalDeliveryConnection> {
    if (this.#closed) throw new Error("Terminal delivery hub is closed");
    const offer = TerminalDeliveryOfferSchemaZ.parse(offerInput);
    const negotiation = negotiateTerminalDelivery(
      offer,
      this.generation,
      this.#scheduler.createId(),
    );
    if (!negotiation.accepted) return rejectedConnection(negotiation);
    const key = cacheKey([clientId, semanticPaneId]);
    if (this.#clients.has(key) || this.#pendingClients.has(key))
      throw new TypeError("Terminal delivery already open for client/pane");
    const uniqueClients = new Set([
      ...[...this.#clients.values()].map((client) => client.clientId),
      ...this.#pendingClients.values(),
    ]);
    if (!uniqueClients.has(clientId) && uniqueClients.size >= MAX_CLIENTS)
      throw new Error("Terminal delivery client limit reached");
    if (this.#clients.size + this.#pendingClients.size >= MAX_CONNECTIONS)
      throw new Error("Terminal delivery connection limit reached");

    // Reserve before the first await. Without this reservation, a burst of
    // concurrent opens can all pass the capacity precheck while ensurePane is
    // awaiting the source and oversubscribe the hub together afterwards.
    this.#pendingClients.set(key, clientId);
    try {
      const pane = await this.#ensurePane(semanticPaneId);
      if (this.#closed) throw new Error("Terminal delivery hub is closed");
      const client: ClientState = {
        key,
        clientId,
        diagnosticClientId: diagnosticIdentity.clientId,
        diagnosticSurface: diagnosticIdentity.surface,
        diagnosticLaneId: diagnosticIdentity.laneId,
        diagnosticRequestId: diagnosticIdentity.requestId ?? diagnosticIdentity.laneId,
        paneId: semanticPaneId,
        negotiated: negotiation.negotiated,
        accept,
        visibility: "visible",
        baselineRevision: -1,
        baselineHash: null,
        reseedRequired: false,
        inFlight: null,
        latestRevision: pane.latest?.update.revision ?? null,
        scheduled: false,
        closed: false,
        lifecycleOpenRecorded: false,
        outgoing: [],
        sending: false,
        retireAfterDrain: false,
        lastAck: null,
        sourceClosedFlight: null,
        backgroundTimer: null,
      };
      this.#clients.set(key, client);
      client.lifecycleOpenRecorded = this.#recordDeliveryLifecycle(client, pane, "open");
      this.#schedule(client);
      this.#recordDeliveryStatus(client, pane);
      return {
        negotiation,
        ack: (ack) => this.#ack(client, ack),
        nack: (nack) => this.#nack(client, nack),
        setVisibility: (visibilityInput) => {
          if (client.closed) return;
          client.visibility = TerminalDeliveryVisibilitySchemaZ.parse(visibilityInput);
          if (client.visibility === "visible" || client.visibility === "background")
            this.#schedule(client);
          this.#recordDeliveryStatus(client, this.#panes.get(client.paneId));
        },
        close: async () => this.#closeClient(client),
      };
    } finally {
      this.#pendingClients.delete(key);
    }
  }

  metrics(): TerminalDeliveryMetrics {
    const now = this.#scheduler.nowMs();
    const currentSlow = [...this.#clients.values()].reduce(
      (max, client) => Math.max(max, client.inFlight ? now - client.inFlight.sentAt : 0),
      0,
    );
    return Object.freeze({
      clients: new Set([...this.#clients.values()].map((client) => client.clientId)).size,
      connections: this.#clients.size,
      inFlight: [...this.#clients.values()].filter((client) => client.inFlight).length,
      latestPointers: [...this.#clients.values()].filter((client) => client.latestRevision !== null)
        .length,
      coalesced: this.#coalesced,
      reseeds: this.#reseeds,
      nacks: this.#nacks,
      representationCacheBytes: this.#cacheBytes,
      rawJournalBytes: [...this.#panes.values()].reduce((sum, pane) => sum + pane.rawBytes, 0),
      maxSlowClientMs: Math.max(this.#maxSlowClientMs, currentSlow),
      queueDepth: [...this.#clients.values()].reduce(
        (sum, client) => sum + client.outgoing.length,
        0,
      ),
      maxQueueDepth: this.#maxQueueDepth,
      inFlightBytes: [...this.#clients.values()].reduce(
        (sum, client) => sum + (client.inFlight?.envelope.representationBytes ?? 0),
        0,
      ),
    });
  }

  convergenceSnapshot(): TerminalDeliveryConvergenceSnapshot {
    return Object.freeze({
      panes: Object.freeze(
        [...this.#panes.entries()].flatMap(([semanticPaneId, pane]) =>
          pane.latest
            ? [
                Object.freeze({
                  semanticPaneId,
                  incarnation: pane.latest.update.incarnation,
                  revision: pane.latest.update.revision,
                  stateHash: pane.latest.update.stateHash,
                }),
              ]
            : [],
        ),
      ),
      clients: Object.freeze(
        [...this.#clients.values()].map((client) =>
          Object.freeze({
            clientId: client.clientId,
            semanticPaneId: client.paneId,
            visibility: client.visibility,
            baselineRevision: client.baselineRevision,
            baselineHash: client.baselineHash,
            inFlightRevision: client.inFlight?.envelope.canonicalRevision ?? null,
            latestRevision: client.latestRevision,
            queueDepth: client.outgoing.length,
          }),
        ),
      ),
    });
  }

  async resetForSessionRestart(): Promise<void> {
    for (const client of this.#clients.values()) {
      client.outgoing.length = 0;
      client.inFlight = null;
      this.#enqueue(client, {
        type: "terminal.delivery.fault",
        reason: "source-closed",
        message: "Terminal source restarted",
        deliveryNonce: client.negotiated.deliveryNonce,
      });
      client.retireAfterDrain = true;
    }
    const panes = [...this.#panes.values()];
    this.#panes.clear();
    for (const pane of panes) {
      pane.pendingCanonical.length = 0;
      pane.canonicalScheduled = false;
    }
    await Promise.allSettled(panes.map((pane) => pane.source?.close()));
    this.#clearCache();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.resetForSessionRestart();
    await Promise.allSettled(
      [...this.#clients.values()].map((client) => this.#closeClient(client)),
    );
  }

  async #ensurePane(semanticPaneId: string): Promise<PaneState> {
    let pane = this.#panes.get(semanticPaneId);
    if (pane) {
      await pane.start;
      return pane;
    }
    if (this.#panes.size >= MAX_PANES) throw new Error("Terminal delivery pane limit reached");
    const owner = this.#ownerForPane(semanticPaneId);
    pane = {
      owner,
      source: null,
      start: Promise.resolve(),
      current: null,
      latest: null,
      revisions: new Map(),
      raw: new Map(),
      rawBytes: 0,
      rawFloorRevision: 0,
      lastRawRevision: -1,
      pendingCanonical: [],
      canonicalScheduled: false,
      pendingDeliveryTrace: null,
    };
    this.#panes.set(semanticPaneId, pane);
    pane.start = owner
      .subscribeSource(
        (update, trace) => this.#observeCanonical(semanticPaneId, update, trace),
        (record) => this.#observeRaw(semanticPaneId, record),
      )
      .then(async (source) => {
        if (this.#closed || this.#panes.get(semanticPaneId) !== pane) {
          await source.close();
          throw new Error("Terminal delivery source retired during startup");
        }
        pane!.source = source;
      })
      .catch((error) => {
        if (this.#panes.get(semanticPaneId) === pane) this.#panes.delete(semanticPaneId);
        throw error;
      });
    await pane.start;
    return pane;
  }

  #observeCanonical(
    semanticPaneId: string,
    update: CanonicalTerminalReplicaUpdate,
    trace: SessionRuntimeTraceContext | null,
  ): void {
    const pane = this.#panes.get(semanticPaneId);
    if (!pane) return;
    pane.pendingCanonical.push({ update, trace });
    if (pane.canonicalScheduled) return;
    pane.canonicalScheduled = true;
    this.#scheduler.microtask(() => {
      if (this.#panes.get(semanticPaneId) !== pane) return;
      pane.canonicalScheduled = false;
      for (const pending of pane.pendingCanonical.splice(0))
        this.#applyCanonical(semanticPaneId, pane, pending.update, pending.trace);
    });
  }

  #applyCanonical(
    semanticPaneId: string,
    pane: PaneState,
    update: CanonicalTerminalReplicaUpdate,
    trace: SessionRuntimeTraceContext | null,
  ): void {
    if (
      update.workspaceName !== this.workspaceName ||
      update.semanticPaneId !== semanticPaneId ||
      update.generation !== this.generation
    )
      return;
    const result = applyTerminalReplicaUpdate(pane.current, update);
    if (result.status !== "applied" && result.status !== "idempotent") return;
    pane.current = result.state;
    if (trace) pane.pendingDeliveryTrace = trace;
    const record = { update, state: result.state, trace: pane.pendingDeliveryTrace };
    pane.latest = record;
    pane.revisions.set(update.revision, record);
    while (pane.revisions.size > MAX_CANONICAL_REVISIONS)
      pane.revisions.delete(pane.revisions.keys().next().value!);
    for (const client of this.#clients.values()) {
      if (client.paneId !== semanticPaneId || client.closed) continue;
      if (!client.lifecycleOpenRecorded)
        client.lifecycleOpenRecorded = this.#recordDeliveryLifecycle(client, pane, "open");
      if (
        update.type === "terminal.tombstone" &&
        (client.inFlight !== null || client.visibility !== "visible")
      ) {
        this.#fault(client, "source-closed", "Terminal source closed before final state delivery");
        continue;
      }
      if (client.latestRevision !== null && client.latestRevision !== update.revision)
        this.#coalesced += 1;
      client.latestRevision = update.revision;
      this.#schedule(client);
    }
    if (update.type === "terminal.tombstone") {
      this.#scheduler.timer(() => {
        if (this.#panes.get(semanticPaneId) !== pane) return;
        this.#panes.delete(semanticPaneId);
        pane.pendingCanonical.length = 0;
        pane.canonicalScheduled = false;
        void pane.source?.close().catch(() => undefined);
        this.#clearCache();
      }, 0);
    }
  }

  #observeRaw(semanticPaneId: string, record: TerminalReplicaCommittedRaw): void {
    const pane = this.#panes.get(semanticPaneId);
    if (!pane) return;
    if (record.revision <= pane.lastRawRevision) return;
    if (
      record.baseRevision === record.revision ||
      record.baseRevision !== record.revision - 1 ||
      (pane.lastRawRevision >= 0 && record.baseRevision !== pane.lastRawRevision)
    ) {
      pane.raw.clear();
      pane.rawBytes = 0;
      pane.rawFloorRevision = Math.max(pane.rawFloorRevision, record.revision + 1);
      pane.lastRawRevision = record.revision;
      return;
    }
    if (!record.contiguous || record.bytes.byteLength > MAX_RAW_JOURNAL_BYTES) {
      pane.raw.clear();
      pane.rawBytes = 0;
      pane.rawFloorRevision = Math.max(pane.rawFloorRevision, record.revision + 1);
      pane.lastRawRevision = record.revision;
      return;
    }
    pane.raw.set(record.revision, record.bytes);
    pane.lastRawRevision = record.revision;
    pane.rawBytes += record.bytes.byteLength;
    while (pane.rawBytes > MAX_RAW_JOURNAL_BYTES || pane.raw.size > MAX_CANONICAL_REVISIONS) {
      const first = pane.raw.entries().next().value as [number, Uint8Array] | undefined;
      if (!first) break;
      pane.raw.delete(first[0]);
      pane.rawBytes -= first[1].byteLength;
      pane.rawFloorRevision = Math.max(pane.rawFloorRevision, first[0] + 1);
    }
  }

  #schedule(client: ClientState): void {
    if (
      client.closed ||
      client.inFlight ||
      client.latestRevision === null ||
      client.latestRevision === client.baselineRevision ||
      client.visibility === "hidden" ||
      client.visibility === "frozen"
    )
      return;
    if (client.visibility === "background") {
      if (client.backgroundTimer) return;
      client.backgroundTimer = this.#scheduler.timer(() => {
        client.backgroundTimer = null;
        if (!client.closed && !client.inFlight && client.latestRevision !== null)
          this.#deliver(client);
      }, BACKGROUND_CADENCE_MS);
      return;
    }
    if (client.scheduled) return;
    client.scheduled = true;
    this.#scheduler.microtask(() => {
      client.scheduled = false;
      if (!client.closed && client.visibility === "visible" && !client.inFlight)
        this.#deliver(client);
    });
  }

  #deliver(client: ClientState): void {
    const pane = this.#panes.get(client.paneId);
    const target = pane?.latest;
    if (!pane || !target || target.update.revision !== client.latestRevision) return;
    const traceStarted = this.#observability.enabled ? this.#observability.nowMicros() : 0;
    let encodedRepresentation: CachedRepresentation | null = null;
    let failedSelectionObservation: SemanticSelectionObservation | null = null;
    let deliveryEnvelope: TerminalDeliveryEnvelope | null = null;
    let deliveryOrdinal: number | null = null;
    try {
      const representation = this.#representation(client, pane, target);
      encodedRepresentation = representation;
      const transactionId = this.#scheduler.createId();
      const chunkCount = Math.max(1, Math.ceil(representation.bytes.byteLength / (256 * 1024)));
      const envelope = TerminalDeliveryEnvelopeSchemaZ.parse({
        type: "terminal.delivery",
        workspaceName: target.update.workspaceName,
        semanticPaneId: target.update.semanticPaneId,
        generation: target.update.generation,
        incarnation: target.update.incarnation,
        deliveryNonce: client.negotiated.deliveryNonce,
        transactionId,
        ...(target.trace ? { performanceTraceId: target.trace.traceId } : {}),
        protocolVersion: 1,
        encoding: representation.encoding ?? client.negotiated.encoding,
        frame: representation.frame,
        baseRevision: representation.frame === "seed" ? null : Math.max(0, client.baselineRevision),
        canonicalRevision: target.update.revision,
        canonicalStateHash: target.update.stateHash,
        representationHash:
          representation.representationHash ??
          hashTerminalDeliveryRepresentation(representation.bytes),
        representationBytes: representation.bytes.byteLength,
        chunkCount,
        canonicalEquivalent: representation.canonicalEquivalent,
        history: representation.history,
        richPlacements: client.negotiated.richPlacements,
      });
      deliveryEnvelope = envelope;
      deliveryOrdinal = ++this.#deliveryOrdinal;
      registerTerminalDeliveryObservationOrdinal(envelope, deliveryOrdinal);
      client.inFlight = {
        envelope,
        deliveryOrdinal,
        bytes: representation.bytes,
        nextChunk: 0,
        sentAt: this.#scheduler.nowMs(),
      };
      this.#enqueue(client, envelope);
      this.#recordDeliveryStatus(client, pane);
      if (target.trace?.traceId === pane.pendingDeliveryTrace?.traceId)
        pane.pendingDeliveryTrace = null;
    } catch (error) {
      failedSelectionObservation = semanticSelectionObservationFromError(error);
      this.#fault(
        client,
        error instanceof TerminalDeliveryStateTooLargeError
          ? "state-too-large"
          : "protocol-violation",
        error instanceof Error ? error.message : String(error),
        failedSelectionObservation,
      );
    } finally {
      if (this.#observability.enabled)
        try {
          const metrics = this.metrics();
          this.#observability.recordSpan(
            "transport",
            "terminal-delivery-encode-enqueue",
            traceStarted,
            this.#observability.nowMicros(),
            target.trace,
            undefined,
            Object.freeze({
              representationCacheBytes: metrics.representationCacheBytes,
              rawJournalBytes: metrics.rawJournalBytes,
              queueDepth: metrics.queueDepth,
              maxQueueDepth: metrics.maxQueueDepth,
              inFlight: metrics.inFlight,
              inFlightBytes: metrics.inFlightBytes,
              ...(encodedRepresentation
                ? {
                    representation: encodedRepresentation.frame,
                    representationBytes: encodedRepresentation.bytes.byteLength,
                  }
                : {}),
              attemptedPatchBytes:
                encodedRepresentation?.selectionObservation?.attemptedPatchBytes ??
                failedSelectionObservation?.attemptedPatchBytes ??
                null,
              attemptedSeedBytes:
                encodedRepresentation?.selectionObservation?.attemptedSeedBytes ??
                failedSelectionObservation?.attemptedSeedBytes ??
                null,
              ...((encodedRepresentation?.selectionObservation ?? failedSelectionObservation)
                ? terminalSelectionObservation(
                    encodedRepresentation?.selectionObservation ?? failedSelectionObservation!,
                  )
                : {}),
              ...(deliveryEnvelope && deliveryOrdinal !== null
                ? {
                    workspaceName: deliveryEnvelope.workspaceName,
                    semanticPaneId: deliveryEnvelope.semanticPaneId,
                    canonicalGeneration: deliveryEnvelope.generation,
                    canonicalIncarnation: deliveryEnvelope.incarnation,
                    canonicalRevision: deliveryEnvelope.canonicalRevision,
                    canonicalStateHash: deliveryEnvelope.canonicalStateHash,
                    deliveryOrdinal,
                    transactionId: deliveryEnvelope.transactionId,
                    deliveryClientId: client.diagnosticClientId,
                    deliverySurface: client.diagnosticSurface,
                    deliveryLaneId: client.diagnosticLaneId,
                    deliveryRequestId: client.diagnosticRequestId,
                    deliveryNonce: deliveryEnvelope.deliveryNonce,
                  }
                : {}),
            }),
          );
        } catch {
          // Detailed resource diagnostics never own terminal delivery.
        }
    }
  }

  #representation(
    client: ClientState,
    pane: PaneState,
    target: RevisionRecord,
  ): CachedRepresentation {
    const key = cacheKey([
      target.update.workspaceName,
      target.update.semanticPaneId,
      target.update.generation,
      target.update.incarnation,
      client.negotiated.encoding,
      client.negotiated.fallbackEncoding ?? "no-fallback",
      client.negotiated.richPlacements ? "rich" : "plain",
      client.baselineRevision,
      client.baselineHash ?? "none",
      client.reseedRequired ? "reseed" : "incremental",
      target.update.revision,
      target.update.stateHash,
    ]);
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const baseline = client.reseedRequired
      ? null
      : (pane.revisions.get(client.baselineRevision)?.state.snapshot ?? null);
    const snapshot = target.state.snapshot;
    let result: CachedRepresentation | null = null;
    if (
      client.negotiated.encoding === "semantic-v1" ||
      client.negotiated.encoding === "semantic-compact-v1"
    ) {
      const encodeSemantic =
        client.negotiated.encoding === "semantic-compact-v1"
          ? encodeCompactSemanticTerminalUpdate
          : encodeSemanticTerminalUpdate;
      if (client.reseedRequired) {
        const payload = semanticSeed(target);
        let bytes: Uint8Array;
        let actualEncoding = client.negotiated.encoding;
        let fallbackObservation: SemanticSelectionObservation | null = null;
        try {
          bytes = encodeSemantic(payload);
        } catch (error) {
          if (!(error instanceof TerminalDeliveryStateTooLargeError)) throw error;
          if (
            client.negotiated.encoding === "semantic-compact-v1" &&
            client.negotiated.fallbackEncoding === "semantic-v1"
          ) {
            try {
              bytes = encodeLegacySemanticCandidate(payload);
              actualEncoding = "semantic-v1";
              fallbackObservation = legacyFallbackObservation(
                "seed",
                error.bytes,
                bytes.byteLength,
              );
            } catch (legacyError) {
              if (!(legacyError instanceof TerminalDeliveryStateTooLargeError)) throw legacyError;
              throw new TerminalDeliveryRepresentationSelectionError(
                legacyError.bytes,
                failedCompactAndLegacyObservation("seed", error.bytes, legacyError),
              );
            }
          } else {
            throw new TerminalDeliveryRepresentationSelectionError(error.bytes, {
              attemptedPatchBytes: null,
              attemptedSeedBytes: error.bytes,
              attemptedLegacyPatchBytes: null,
              attemptedLegacySeedBytes:
                client.negotiated.encoding === "semantic-v1" ? error.bytes : null,
              attemptedLegacyPatchAtLeastBytes: null,
              attemptedLegacySeedAtLeastBytes: null,
              attemptedLegacyPatchSizeCapped: false,
              attemptedLegacySeedSizeCapped: false,
              attemptedCompactPatchBytes: null,
              attemptedCompactSeedBytes:
                client.negotiated.encoding === "semantic-compact-v1" ? error.bytes : null,
              selectedEncoding: client.negotiated.encoding,
              selectionStatus: "direct-seed",
            });
          }
        }
        const selectionObservation =
          fallbackObservation ??
          (this.#observability.enabled
            ? completeSemanticSelectionObservation(
                {
                  attemptedPatchBytes: null,
                  attemptedSeedBytes: bytes.byteLength,
                  selectionStatus: "direct-seed",
                },
                client.negotiated.encoding,
                null,
              )
            : null);
        result = {
          bytes,
          encoding: actualEncoding,
          frame: payload.frame,
          canonicalEquivalent: true,
          history: payload.frame === "tombstone" ? "not-applicable" : "complete",
          ...(selectionObservation ? { selectionObservation } : {}),
        };
        this.#reseeds += 1;
      } else {
        const patchPayload = semanticPayload(client.baselineRevision, baseline, target);
        const seedPayload = patchPayload.frame === "tombstone" ? null : semanticSeed(target);
        const legacyAttempts = null;
        if (patchPayload.frame !== "patch") {
          let bytes: Uint8Array;
          let actualEncoding = client.negotiated.encoding;
          let fallbackObservation: SemanticSelectionObservation | null = null;
          try {
            bytes = encodeSemantic(patchPayload);
          } catch (error) {
            if (!(error instanceof TerminalDeliveryStateTooLargeError)) throw error;
            if (
              client.negotiated.encoding === "semantic-compact-v1" &&
              client.negotiated.fallbackEncoding === "semantic-v1" &&
              patchPayload.frame === "seed"
            ) {
              try {
                bytes = encodeLegacySemanticCandidate(patchPayload);
                actualEncoding = "semantic-v1";
                fallbackObservation = legacyFallbackObservation(
                  "seed",
                  error.bytes,
                  bytes.byteLength,
                );
              } catch (legacyError) {
                if (!(legacyError instanceof TerminalDeliveryStateTooLargeError)) throw legacyError;
                const directObservation = failedCompactAndLegacyObservation(
                  "seed",
                  error.bytes,
                  legacyError,
                );
                throw new TerminalDeliveryRepresentationSelectionError(
                  legacyError.bytes,
                  directObservation,
                );
              }
            } else {
              const directObservation = completeSemanticSelectionObservation(
                {
                  attemptedPatchBytes: null,
                  attemptedSeedBytes: patchPayload.frame === "seed" ? error.bytes : null,
                  selectionStatus:
                    patchPayload.frame === "seed" ? "direct-seed" : "direct-tombstone",
                },
                client.negotiated.encoding,
                legacyAttempts,
              );
              throw new TerminalDeliveryRepresentationSelectionError(
                error.bytes,
                directObservation,
              );
            }
          }
          const directObservation =
            fallbackObservation ??
            (this.#observability.enabled
              ? completeSemanticSelectionObservation(
                  {
                    attemptedPatchBytes: null,
                    attemptedSeedBytes: patchPayload.frame === "seed" ? bytes.byteLength : null,
                    selectionStatus:
                      patchPayload.frame === "seed" ? "direct-seed" : "direct-tombstone",
                  },
                  client.negotiated.encoding,
                  legacyAttempts,
                )
              : null);
          if (patchPayload.frame === "seed") this.#reseeds += 1;
          result = {
            bytes,
            encoding: actualEncoding,
            frame: patchPayload.frame,
            canonicalEquivalent: true,
            history: patchPayload.frame === "tombstone" ? "not-applicable" : "complete",
            ...(directObservation ? { selectionObservation: directObservation } : {}),
          };
        } else {
          let selected: ReturnType<
            typeof selectExactSemanticRepresentation<TerminalSemanticDeliveryPayload>
          > | null = null;
          try {
            selected = selectExactSemanticRepresentation(
              () => ({ payload: patchPayload, bytes: encodeSemantic(patchPayload) }),
              () => {
                if (!seedPayload) throw new TypeError("Patch has no seed representation");
                return { payload: seedPayload, bytes: encodeSemantic(seedPayload) };
              },
              this.#observability.enabled,
            );
          } catch (error) {
            if (!(error instanceof ExactSemanticRepresentationSelectionError)) throw error;
            if (
              client.negotiated.encoding === "semantic-compact-v1" &&
              client.negotiated.fallbackEncoding === "semantic-v1"
            ) {
              try {
                const legacySelected = selectExactSemanticRepresentation(
                  () => ({
                    payload: patchPayload,
                    bytes: encodeLegacySemanticCandidate(patchPayload),
                  }),
                  () => {
                    if (!seedPayload)
                      throw new TypeError("Patch has no legacy seed representation");
                    return {
                      payload: seedPayload,
                      bytes: encodeLegacySemanticCandidate(seedPayload),
                    };
                  },
                  true,
                );
                const fallbackObservation = legacyFallbackFromSelection(
                  legacySelected.observation!,
                  error.selectionObservation,
                  legacySelected.payload.frame,
                );
                if (legacySelected.payload.frame === "seed") this.#reseeds += 1;
                result = {
                  bytes: legacySelected.bytes,
                  encoding: "semantic-v1",
                  frame: legacySelected.payload.frame,
                  canonicalEquivalent: true,
                  history:
                    legacySelected.payload.frame === "tombstone" ? "not-applicable" : "complete",
                  selectionObservation: fallbackObservation,
                };
              } catch (legacyError) {
                if (!(legacyError instanceof ExactSemanticRepresentationSelectionError))
                  throw legacyError;
                throw new TerminalDeliveryRepresentationSelectionError(
                  legacyError.bytes,
                  failedCompactAndLegacySelectionObservation(
                    error.selectionObservation,
                    legacyError.selectionObservation,
                  ),
                );
              }
            } else {
              throw new TerminalDeliveryRepresentationSelectionError(
                error.bytes,
                completeSemanticSelectionObservation(
                  error.selectionObservation,
                  client.negotiated.encoding,
                  legacyAttempts,
                ),
              );
            }
          }
          if (selected) {
            if (selected.payload.frame === "seed") this.#reseeds += 1;
            const selectionObservation = selected.observation
              ? completeSemanticSelectionObservation(
                  selected.observation,
                  client.negotiated.encoding,
                  legacyAttempts,
                )
              : null;
            result = {
              bytes: selected.bytes,
              encoding: client.negotiated.encoding,
              frame: selected.payload.frame,
              canonicalEquivalent: true,
              history: selected.payload.frame === "tombstone" ? "not-applicable" : "complete",
              ...(selectionObservation ? { selectionObservation } : {}),
            };
          }
        }
      }
    } else if (client.negotiated.encoding === "ansi-diff-v1") {
      if (!snapshot) result = emptyTombstone();
      else {
        const patch = baseline !== null;
        result = {
          bytes: encodeAnsiTerminalRepresentation(patch ? baseline : null, snapshot),
          frame: patch ? "patch" : "seed",
          canonicalEquivalent: false,
          history: snapshot.history.length > 0 ? "truncated" : "complete",
        };
        if (!patch) this.#reseeds += 1;
      }
    } else result = this.#rawRepresentation(client, pane, target);
    if (!result) throw new TypeError("Terminal delivery representation selection was incomplete");
    const hashed = {
      ...result,
      representationHash: hashTerminalDeliveryRepresentation(result.bytes),
      cachePaneId: client.paneId,
      cacheBaseRevision: client.baselineRevision,
      cacheTargetRevision: target.update.revision,
    };
    this.#cacheSet(key, hashed);
    return hashed;
  }

  #rawRepresentation(
    client: ClientState,
    pane: PaneState,
    target: RevisionRecord,
  ): CachedRepresentation {
    if (client.baselineRevision >= pane.rawFloorRevision - 1) {
      const parts: Uint8Array[] = [];
      let contiguous = true;
      for (
        let revision = client.baselineRevision + 1;
        revision <= target.update.revision;
        revision += 1
      ) {
        const raw = pane.raw.get(revision);
        if (!raw) {
          contiguous = false;
          break;
        }
        parts.push(raw);
      }
      if (contiguous)
        return {
          bytes: joinBytes(parts),
          frame: "patch",
          canonicalEquivalent: false,
          history: "not-applicable",
        };
    }
    this.#reseeds += 1;
    return target.state.snapshot
      ? {
          bytes: encodeAnsiTerminalRepresentation(null, target.state.snapshot),
          frame: "seed",
          canonicalEquivalent: false,
          history: "not-applicable",
        }
      : emptyTombstone();
  }

  #ack(client: ClientState, input: TerminalDeliveryAck): void {
    const ack = TerminalDeliveryAckSchemaZ.parse(input);
    const flight = client.inFlight;
    if (!flight) {
      if (client.lastAck && JSON.stringify(client.lastAck) === JSON.stringify(ack)) return;
      const closed = client.sourceClosedFlight;
      if (
        closed &&
        ack.workspaceName === closed.workspaceName &&
        ack.semanticPaneId === closed.semanticPaneId &&
        ack.generation === closed.generation &&
        ack.incarnation === closed.incarnation &&
        ack.deliveryNonce === closed.deliveryNonce &&
        ack.transactionId === closed.transactionId &&
        ack.canonicalRevision === closed.canonicalRevision &&
        ack.canonicalStateHash === closed.canonicalStateHash &&
        ack.representationHash === closed.representationHash
      )
        return;
      this.#fault(client, "protocol-violation", "ACK has no in-flight transaction");
      return;
    }
    const envelope = flight.envelope;
    if (
      flight.nextChunk !== envelope.chunkCount ||
      ack.workspaceName !== envelope.workspaceName ||
      ack.semanticPaneId !== envelope.semanticPaneId ||
      ack.generation !== envelope.generation ||
      ack.incarnation !== envelope.incarnation ||
      ack.deliveryNonce !== envelope.deliveryNonce ||
      ack.transactionId !== envelope.transactionId ||
      ack.canonicalRevision !== envelope.canonicalRevision ||
      ack.canonicalStateHash !== envelope.canonicalStateHash ||
      ack.representationHash !== envelope.representationHash
    ) {
      this.#fault(client, "protocol-violation", "ACK does not identify the in-flight delivery");
      return;
    }
    this.#maxSlowClientMs = Math.max(
      this.#maxSlowClientMs,
      this.#scheduler.nowMs() - flight.sentAt,
    );
    client.baselineRevision = ack.canonicalRevision;
    client.baselineHash = ack.canonicalStateHash;
    client.reseedRequired = false;
    client.inFlight = null;
    client.lastAck = ack;
    if (client.latestRevision === ack.canonicalRevision) client.latestRevision = null;
    this.#pruneAckSupersededCache(client.paneId);
    if (this.#observability.enabled)
      try {
        const atMicros = this.#observability.nowMicros();
        const metrics = this.metrics();
        this.#observability.recordSpan(
          "transport",
          "terminal-delivery-settled",
          atMicros,
          atMicros,
          envelope.performanceTraceId
            ? Object.freeze({
                traceId: envelope.performanceTraceId,
                scenario: "terminal-input-to-paint",
                authority: Object.freeze({
                  generation: envelope.generation,
                  incarnation: envelope.incarnation,
                }),
              })
            : null,
          undefined,
          Object.freeze({
            representationCacheBytes: metrics.representationCacheBytes,
            rawJournalBytes: metrics.rawJournalBytes,
            queueDepth: metrics.queueDepth,
            maxQueueDepth: metrics.maxQueueDepth,
            inFlight: metrics.inFlight,
            inFlightBytes: metrics.inFlightBytes,
            workspaceName: envelope.workspaceName,
            semanticPaneId: envelope.semanticPaneId,
            canonicalGeneration: envelope.generation,
            canonicalIncarnation: envelope.incarnation,
            canonicalRevision: envelope.canonicalRevision,
            canonicalStateHash: envelope.canonicalStateHash,
            deliveryOrdinal: flight.deliveryOrdinal,
            transactionId: envelope.transactionId,
            deliveryClientId: client.diagnosticClientId,
            deliverySurface: client.diagnosticSurface,
            deliveryLaneId: client.diagnosticLaneId,
            deliveryRequestId: client.diagnosticRequestId,
            deliveryNonce: envelope.deliveryNonce,
          }),
        );
      } catch {
        // Detailed settlement diagnostics never own ACK adoption.
      }
    this.#schedule(client);
    this.#recordDeliveryStatus(client, this.#panes.get(client.paneId));
  }

  #nack(client: ClientState, input: TerminalDeliveryNack): void {
    const nack = TerminalDeliveryNackSchemaZ.parse(input);
    const envelope = client.inFlight?.envelope;
    if (
      !envelope ||
      nack.workspaceName !== envelope.workspaceName ||
      nack.semanticPaneId !== envelope.semanticPaneId ||
      nack.generation !== envelope.generation ||
      nack.incarnation !== envelope.incarnation ||
      nack.deliveryNonce !== envelope.deliveryNonce ||
      nack.transactionId !== envelope.transactionId
    ) {
      this.#fault(client, "protocol-violation", "NACK does not identify the in-flight delivery");
      return;
    }
    this.#nacks += 1;
    client.reseedRequired = true;
    client.inFlight = null;
    this.#schedule(client);
    this.#recordDeliveryStatus(client, this.#panes.get(client.paneId));
  }

  #fault(
    client: ClientState,
    reason: "state-too-large" | "source-closed" | "protocol-violation",
    message: string,
    selectionObservation: SemanticSelectionObservation | null = null,
  ): void {
    if (this.#observability.enabled)
      try {
        const atMicros = this.#observability.nowMicros();
        const flight = client.inFlight;
        const metrics = this.metrics();
        this.#observability.recordSpan(
          "transport",
          "terminal-delivery-fault",
          atMicros,
          atMicros,
          null,
          undefined,
          Object.freeze({
            representationCacheBytes: metrics.representationCacheBytes,
            rawJournalBytes: metrics.rawJournalBytes,
            queueDepth: metrics.queueDepth,
            maxQueueDepth: metrics.maxQueueDepth,
            inFlight: metrics.inFlight,
            inFlightBytes: metrics.inFlightBytes,
            workspaceName: this.workspaceName,
            semanticPaneId: client.paneId,
            faultReason: reason,
            ...(selectionObservation ? terminalSelectionObservation(selectionObservation) : {}),
            ...(flight
              ? {
                  canonicalGeneration: flight.envelope.generation,
                  canonicalIncarnation: flight.envelope.incarnation,
                  canonicalRevision: flight.envelope.canonicalRevision,
                  canonicalStateHash: flight.envelope.canonicalStateHash,
                  deliveryOrdinal: flight.deliveryOrdinal,
                  transactionId: flight.envelope.transactionId,
                }
              : {}),
          }),
        );
      } catch {
        // Detailed fault diagnostics never own delivery failure handling.
      }
    client.outgoing.length = 0;
    if (reason === "source-closed") client.sourceClosedFlight = client.inFlight?.envelope ?? null;
    client.inFlight = null;
    const fault: TerminalDeliveryServerMessage = {
      type: "terminal.delivery.fault",
      reason,
      message: message.slice(0, 1024),
      deliveryNonce: client.negotiated.deliveryNonce,
    };
    if (reason === "source-closed" && client.sending) {
      // A data callback may be waiting for renderer credit. Source closure is
      // authoritative control state, so send it out-of-band and retire after
      // that small frame has reached the transport instead of waiting behind
      // a transaction which can no longer become current.
      void Promise.resolve(client.accept(fault)).then(
        () => this.#closeClient(client),
        () => this.#closeClient(client),
      );
      return;
    }
    this.#enqueue(client, fault);
    client.retireAfterDrain = true;
  }

  #enqueue(client: ClientState, message: TerminalDeliveryServerMessage): void {
    this.#enqueueFactory(client, () => message);
  }

  #enqueueFactory(client: ClientState, create: () => TerminalDeliveryServerMessage): void {
    if (client.closed) return;
    client.outgoing.push(create);
    this.#maxQueueDepth = Math.max(this.#maxQueueDepth, client.outgoing.length);
    if (client.sending) return;
    client.sending = true;
    this.#scheduler.microtask(async () => {
      try {
        while (!client.closed) {
          const queued = client.outgoing.shift();
          let next = queued?.();
          const flight = client.inFlight;
          if (!next && flight && flight.nextChunk < flight.envelope.chunkCount) {
            const index = flight.nextChunk;
            flight.nextChunk += 1;
            next = {
              type: "terminal.delivery.chunk",
              transactionId: flight.envelope.transactionId,
              index,
              bytes: flight.bytes.slice(
                index * 256 * 1024,
                Math.min(flight.bytes.byteLength, (index + 1) * 256 * 1024),
              ),
            };
          }
          if (!next) break;
          await this.#withDeadline(Promise.resolve(client.accept(next)), 5_000);
        }
      } catch {
        client.outgoing.length = 0;
        try {
          client.outgoing.length = 0;
          await this.#closeClient(client);
        } catch {
          // Closing a failed source is best effort and cannot escape this task.
        }
      } finally {
        client.sending = false;
        if (client.retireAfterDrain) await this.#closeClient(client).catch(() => undefined);
      }
    });
  }

  async #closeClient(client: ClientState): Promise<void> {
    if (client.closed) return;
    client.closed = true;
    if (client.lifecycleOpenRecorded)
      this.#recordDeliveryLifecycle(client, this.#panes.get(client.paneId), "close");
    client.backgroundTimer?.cancel();
    client.outgoing.length = 0;
    this.#clients.delete(client.key);
    if ([...this.#clients.values()].some((candidate) => candidate.paneId === client.paneId)) return;
    const pane = this.#panes.get(client.paneId);
    this.#panes.delete(client.paneId);
    if (pane) {
      pane.pendingCanonical.length = 0;
      pane.canonicalScheduled = false;
    }
    await pane?.source?.close().catch(() => undefined);
    this.#clearCache();
  }

  #recordDeliveryLifecycle(
    client: ClientState,
    pane: PaneState | undefined,
    event: "open" | "close",
  ): boolean {
    if (!this.#observability.enabled) return false;
    const canonical = pane?.latest?.update;
    if (!canonical) return false;
    try {
      const atMicros = this.#observability.nowMicros();
      this.#observability.recordSpan(
        "transport",
        "terminal-delivery-subscriber-lifecycle",
        atMicros,
        atMicros,
        null,
        undefined,
        Object.freeze({
          workspaceName: this.workspaceName,
          semanticPaneId: client.paneId,
          canonicalGeneration: this.generation,
          canonicalIncarnation: canonical.incarnation,
          canonicalRevision: canonical.revision,
          canonicalStateHash: canonical.stateHash,
          deliveryClientId: client.diagnosticClientId,
          deliverySurface: client.diagnosticSurface,
          deliveryLaneId: client.diagnosticLaneId,
          deliveryRequestId: client.diagnosticRequestId,
          deliveryLifecycleEvent: event,
          deliveryPurpose: "terminal-surface",
          deliveryLifecycleOrdinal: ++this.#deliveryLifecycleOrdinal,
        }),
      );
      return true;
    } catch {
      // Detailed lifecycle evidence is fail-open for product delivery.
      return false;
    }
  }

  #recordDeliveryStatus(client: ClientState, pane: PaneState | undefined): boolean {
    if (!this.#observability.enabled || client.closed) return false;
    const canonical = pane?.latest?.update;
    if (!canonical) return false;
    try {
      const atMicros = this.#observability.nowMicros();
      this.#observability.recordSpan(
        "transport",
        "terminal-delivery-subscriber-status",
        atMicros,
        atMicros,
        null,
        undefined,
        Object.freeze({
          workspaceName: this.workspaceName,
          semanticPaneId: client.paneId,
          canonicalGeneration: this.generation,
          canonicalIncarnation: canonical.incarnation,
          canonicalRevision: canonical.revision,
          canonicalStateHash: canonical.stateHash,
          deliveryClientId: client.diagnosticClientId,
          deliverySurface: client.diagnosticSurface,
          deliveryLaneId: client.diagnosticLaneId,
          deliveryRequestId: client.diagnosticRequestId,
          deliveryPurpose: "terminal-surface",
          deliveryStatusOrdinal: ++this.#deliveryStatusOrdinal,
          deliveryVisibility: client.visibility,
          deliveryBaselineRevision: client.baselineRevision,
          deliveryBaselineHash: client.baselineHash,
          deliveryInFlightRevision: client.inFlight?.envelope.canonicalRevision ?? null,
          deliveryInFlightHash: client.inFlight?.envelope.canonicalStateHash ?? null,
          deliveryLatestRevision: client.latestRevision,
          deliveryClientQueueDepth: client.outgoing.length,
        }),
      );
      return true;
    } catch {
      // Detailed readiness evidence never owns terminal delivery.
      return false;
    }
  }

  async #withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
    let timer: SessionRuntimeTimer | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = this.#scheduler.timer(
            () => reject(new Error("Terminal delivery sink timed out")),
            milliseconds,
          );
        }),
      ]);
    } finally {
      timer?.cancel();
    }
  }

  #cacheSet(key: string, value: CachedRepresentation): void {
    if (value.bytes.byteLength > MAX_REPRESENTATION_CACHE_BYTES) return;
    const previous = this.#cache.get(key);
    if (previous) this.#cacheBytes -= previous.bytes.byteLength;
    this.#cache.set(key, value);
    this.#cacheBytes += value.bytes.byteLength;
    while (
      this.#cache.size > MAX_REPRESENTATION_CACHE_ENTRIES ||
      this.#cacheBytes > MAX_REPRESENTATION_CACHE_BYTES
    ) {
      const first = this.#cache.entries().next().value as
        | [string, CachedRepresentation]
        | undefined;
      if (!first) break;
      this.#cache.delete(first[0]);
      this.#cacheBytes -= first[1].bytes.byteLength;
    }
  }

  #clearCache(): void {
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

  #pruneAckSupersededCache(paneId: string): void {
    const clients = [...this.#clients.values()].filter(
      (candidate) => !candidate.closed && candidate.paneId === paneId,
    );
    for (const [key, cached] of this.#cache) {
      if (cached.cachePaneId !== paneId) continue;
      const reachable = clients.some(
        (candidate) =>
          cached.cacheBaseRevision === candidate.baselineRevision ||
          (Number.isSafeInteger(cached.cacheTargetRevision) &&
            cached.cacheTargetRevision! > candidate.baselineRevision) ||
          cached.cacheTargetRevision === candidate.inFlight?.envelope.canonicalRevision,
      );
      if (reachable) continue;
      this.#cache.delete(key);
      this.#cacheBytes -= cached.bytes.byteLength;
    }
  }
}

export function selectExactSemanticRepresentation<T extends { readonly frame: string }>(
  encodePatch: () => { readonly payload: T; readonly bytes: Uint8Array },
  encodeSeed: () => { readonly payload: T; readonly bytes: Uint8Array },
  observe = true,
): {
  readonly payload: T;
  readonly bytes: Uint8Array;
  readonly observation?: Readonly<{
    attemptedPatchBytes: number | null;
    attemptedSeedBytes: number | null;
    selectionStatus:
      | "patch-preferred"
      | "seed-preferred"
      | "patch-fallback"
      | "legacy-patch-fallback"
      | "legacy-seed-fallback"
      | "direct-seed"
      | "direct-tombstone";
  }>;
} {
  let patch: { readonly payload: T; readonly bytes: Uint8Array };
  try {
    patch = encodePatch();
  } catch (error) {
    if (!(error instanceof TerminalDeliveryStateTooLargeError)) throw error;
    let seed;
    try {
      seed = encodeSeed();
    } catch (seedError) {
      if (!(seedError instanceof TerminalDeliveryStateTooLargeError)) throw seedError;
      throw new ExactSemanticRepresentationSelectionError(seedError.bytes, {
        attemptedPatchBytes: error.bytes,
        attemptedSeedBytes: seedError.bytes,
        selectionStatus: "seed-preferred",
      });
    }
    if (!observe) return seed;
    return {
      ...seed,
      observation: Object.freeze({
        attemptedPatchBytes: error.bytes,
        attemptedSeedBytes: seed.bytes.byteLength,
        selectionStatus: "seed-preferred" as const,
      }),
    };
  }
  if (patch.payload.frame !== "patch") {
    if (!observe) return patch;
    return {
      ...patch,
      observation: Object.freeze({
        attemptedPatchBytes: null,
        attemptedSeedBytes: patch.payload.frame === "seed" ? patch.bytes.byteLength : null,
        selectionStatus:
          patch.payload.frame === "seed" ? ("direct-seed" as const) : ("direct-tombstone" as const),
      }),
    };
  }
  if (patch.bytes.byteLength <= TERMINAL_DELIVERY_PATCH_TO_SEED_BYTES) {
    if (!observe) return patch;
    return {
      ...patch,
      observation: Object.freeze({
        attemptedPatchBytes: patch.bytes.byteLength,
        attemptedSeedBytes: null,
        selectionStatus: "patch-preferred" as const,
      }),
    };
  }
  try {
    const seed = encodeSeed();
    const selected = patch.bytes.byteLength <= seed.bytes.byteLength ? patch : seed;
    if (!observe) return selected;
    return {
      ...selected,
      observation: Object.freeze({
        attemptedPatchBytes: patch.bytes.byteLength,
        attemptedSeedBytes: seed.bytes.byteLength,
        selectionStatus:
          selected === patch ? ("patch-preferred" as const) : ("seed-preferred" as const),
      }),
    };
  } catch (error) {
    if (!(error instanceof TerminalDeliveryStateTooLargeError)) throw error;
    if (!observe) return patch;
    return {
      ...patch,
      observation: Object.freeze({
        attemptedPatchBytes: patch.bytes.byteLength,
        attemptedSeedBytes: error.bytes,
        selectionStatus: "patch-fallback" as const,
      }),
    };
  }
}

function completeSemanticSelectionObservation(
  observation: ExactSemanticSelectionObservation,
  selectedEncoding: "semantic-v1" | "semantic-compact-v1",
  legacyAttempts: Readonly<{ patchBytes: number | null; seedBytes: number | null }> | null,
): SemanticSelectionObservation {
  const compact = selectedEncoding === "semantic-compact-v1";
  return Object.freeze({
    ...observation,
    attemptedLegacyPatchBytes: compact
      ? (legacyAttempts?.patchBytes ?? null)
      : observation.attemptedPatchBytes,
    attemptedLegacySeedBytes: compact
      ? (legacyAttempts?.seedBytes ?? null)
      : observation.attemptedSeedBytes,
    attemptedLegacyPatchAtLeastBytes: null,
    attemptedLegacySeedAtLeastBytes: null,
    attemptedLegacyPatchSizeCapped: false,
    attemptedLegacySeedSizeCapped: false,
    attemptedCompactPatchBytes: compact ? observation.attemptedPatchBytes : null,
    attemptedCompactSeedBytes: compact ? observation.attemptedSeedBytes : null,
    selectedEncoding,
  });
}

function legacyFallbackObservation(
  frame: "seed" | "patch",
  compactBytes: number,
  legacyBytes: number,
): SemanticSelectionObservation {
  return Object.freeze({
    attemptedPatchBytes: frame === "patch" ? legacyBytes : null,
    attemptedSeedBytes: frame === "seed" ? legacyBytes : null,
    attemptedLegacyPatchBytes: frame === "patch" ? legacyBytes : null,
    attemptedLegacySeedBytes: frame === "seed" ? legacyBytes : null,
    attemptedLegacyPatchAtLeastBytes: null,
    attemptedLegacySeedAtLeastBytes: null,
    attemptedLegacyPatchSizeCapped: false,
    attemptedLegacySeedSizeCapped: false,
    attemptedCompactPatchBytes: frame === "patch" ? compactBytes : null,
    attemptedCompactSeedBytes: frame === "seed" ? compactBytes : null,
    selectedEncoding: "semantic-v1",
    selectionStatus: frame === "patch" ? "legacy-patch-fallback" : "legacy-seed-fallback",
  });
}

function legacyFallbackFromSelection(
  legacy: ExactSemanticSelectionObservation,
  compact: ExactSemanticSelectionObservation,
  frame: string,
): SemanticSelectionObservation {
  return Object.freeze({
    attemptedPatchBytes: legacy.attemptedPatchBytes,
    attemptedSeedBytes: legacy.attemptedSeedBytes,
    attemptedLegacyPatchBytes: legacy.attemptedPatchBytes,
    attemptedLegacySeedBytes: legacy.attemptedSeedBytes,
    attemptedLegacyPatchAtLeastBytes: null,
    attemptedLegacySeedAtLeastBytes: null,
    attemptedLegacyPatchSizeCapped: false,
    attemptedLegacySeedSizeCapped: false,
    attemptedCompactPatchBytes: compact.attemptedPatchBytes,
    attemptedCompactSeedBytes: compact.attemptedSeedBytes,
    selectedEncoding: "semantic-v1",
    selectionStatus: frame === "patch" ? "legacy-patch-fallback" : "legacy-seed-fallback",
  });
}

function failedCompactAndLegacyObservation(
  frame: "seed" | "patch",
  compactBytes: number,
  legacyError: TerminalDeliveryStateTooLargeError,
): SemanticSelectionObservation {
  const capped = legacyError instanceof TerminalDeliveryPreaccountLimitError;
  return Object.freeze({
    attemptedPatchBytes: frame === "patch" ? compactBytes : null,
    attemptedSeedBytes: frame === "seed" ? compactBytes : null,
    attemptedLegacyPatchBytes: !capped && frame === "patch" ? legacyError.bytes : null,
    attemptedLegacySeedBytes: !capped && frame === "seed" ? legacyError.bytes : null,
    attemptedLegacyPatchAtLeastBytes: capped && frame === "patch" ? legacyError.atLeastBytes : null,
    attemptedLegacySeedAtLeastBytes: capped && frame === "seed" ? legacyError.atLeastBytes : null,
    attemptedLegacyPatchSizeCapped: capped && frame === "patch",
    attemptedLegacySeedSizeCapped: capped && frame === "seed",
    attemptedCompactPatchBytes: frame === "patch" ? compactBytes : null,
    attemptedCompactSeedBytes: frame === "seed" ? compactBytes : null,
    selectedEncoding: "semantic-compact-v1",
    selectionStatus: frame === "patch" ? "patch-preferred" : "direct-seed",
  });
}

function failedCompactAndLegacySelectionObservation(
  compact: ExactSemanticSelectionObservation,
  legacy: ExactSemanticSelectionObservation,
): SemanticSelectionObservation {
  return Object.freeze({
    attemptedPatchBytes: compact.attemptedPatchBytes,
    attemptedSeedBytes: compact.attemptedSeedBytes,
    attemptedLegacyPatchBytes: legacy.attemptedPatchBytes,
    attemptedLegacySeedBytes: legacy.attemptedSeedBytes,
    attemptedLegacyPatchAtLeastBytes: null,
    attemptedLegacySeedAtLeastBytes: null,
    attemptedLegacyPatchSizeCapped: false,
    attemptedLegacySeedSizeCapped: false,
    attemptedCompactPatchBytes: compact.attemptedPatchBytes,
    attemptedCompactSeedBytes: compact.attemptedSeedBytes,
    selectedEncoding: "semantic-compact-v1",
    selectionStatus: compact.selectionStatus,
  });
}

function terminalSelectionObservation(observation: SemanticSelectionObservation) {
  return Object.freeze({
    selectionStatus: observation.selectionStatus,
    selectedEncoding: observation.selectedEncoding,
    attemptedLegacyPatchBytes: observation.attemptedLegacyPatchBytes,
    attemptedLegacySeedBytes: observation.attemptedLegacySeedBytes,
    attemptedLegacyPatchAtLeastBytes: observation.attemptedLegacyPatchAtLeastBytes,
    attemptedLegacySeedAtLeastBytes: observation.attemptedLegacySeedAtLeastBytes,
    attemptedLegacyPatchSizeCapped: observation.attemptedLegacyPatchSizeCapped,
    attemptedLegacySeedSizeCapped: observation.attemptedLegacySeedSizeCapped,
    attemptedCompactPatchBytes: observation.attemptedCompactPatchBytes,
    attemptedCompactSeedBytes: observation.attemptedCompactSeedBytes,
  });
}

function semanticSelectionObservationFromError(
  error: unknown,
): SemanticSelectionObservation | null {
  return error instanceof TerminalDeliveryRepresentationSelectionError
    ? error.selectionObservation
    : null;
}

function semanticPayload(
  baselineRevision: number,
  baseline: TerminalReplicaSnapshot | null,
  target: RevisionRecord,
): TerminalSemanticDeliveryPayload {
  const update = target.update;
  if (!target.state.snapshot) {
    if (update.type !== "terminal.tombstone") throw new TypeError("Missing tombstone update");
    return {
      frame: "tombstone",
      baseRevision: Math.max(0, baselineRevision),
      revision: update.revision,
      tombstone: update.tombstone,
    };
  }
  // Adjacent canonical patches are already the cheapest exact diff. A skipped
  // revision uses an atomic seed; the m56.2 adjacent reducer is never weakened.
  if (baseline && update.type === "terminal.patch" && update.baseRevision === baselineRevision)
    return {
      frame: "patch",
      baseRevision: baselineRevision,
      revision: update.revision,
      patch: update.patch,
    };
  return semanticSeed(target);
}

function encodeLegacySemanticCandidate(payload: TerminalSemanticDeliveryPayload): Uint8Array {
  const preaccounted = preaccountSemanticTerminalUpdateBytes(
    payload,
    TERMINAL_DELIVERY_MAX_REPRESENTATION_BYTES,
  );
  if (!preaccounted.exact)
    throw new TerminalDeliveryPreaccountLimitError(preaccounted.atLeastBytes);
  const bytes = encodeSemanticTerminalUpdate(payload);
  if (bytes.byteLength !== preaccounted.bytes)
    throw new TypeError("Legacy semantic byte preaccount did not match encoding");
  return bytes;
}

function semanticSeed(target: RevisionRecord): TerminalSemanticDeliveryPayload {
  if (!target.state.snapshot) throw new TypeError("Cannot seed a tombstone");
  return { frame: "seed", revision: target.update.revision, snapshot: target.state.snapshot };
}

function emptyTombstone(): CachedRepresentation {
  return {
    bytes: new Uint8Array(),
    frame: "tombstone",
    canonicalEquivalent: false,
    history: "not-applicable",
  };
}

function cacheKey(parts: readonly (string | number)[]): string {
  return JSON.stringify(parts);
}

function rejectedConnection(
  negotiation: TerminalDeliveryNegotiationResult,
): TerminalDeliveryConnection {
  return {
    negotiation,
    ack: () => undefined,
    nack: () => undefined,
    setVisibility: () => undefined,
    close: async () => undefined,
  };
}

function joinBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
