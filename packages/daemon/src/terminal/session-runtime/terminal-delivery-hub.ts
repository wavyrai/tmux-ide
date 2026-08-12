import {
  TERMINAL_DELIVERY_PATCH_TO_SEED_BYTES,
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
  encodeAnsiTerminalRepresentation,
  encodeSemanticTerminalUpdate,
  hashTerminalDeliveryRepresentation,
  negotiateTerminalDelivery,
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

export const MAX_CANONICAL_REVISIONS = 128;
export const MAX_RAW_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_REPRESENTATION_CACHE_ENTRIES = 32;
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
  readonly paneId: string;
  readonly negotiated: Extract<TerminalDeliveryNegotiationResult, { accepted: true }>["negotiated"];
  readonly accept: (message: TerminalDeliveryServerMessage) => void | Promise<void>;
  visibility: TerminalDeliveryVisibility;
  baselineRevision: number;
  baselineHash: string | null;
  reseedRequired: boolean;
  inFlight: {
    envelope: TerminalDeliveryEnvelope;
    bytes: Uint8Array;
    nextChunk: number;
    sentAt: number;
  } | null;
  latestRevision: number | null;
  scheduled: boolean;
  closed: boolean;
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
  readonly frame: "seed" | "patch" | "tombstone";
  readonly canonicalEquivalent: boolean;
  readonly history: "complete" | "truncated" | "not-applicable";
  readonly representationHash?: string;
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
        outgoing: [],
        sending: false,
        retireAfterDrain: false,
        lastAck: null,
        sourceClosedFlight: null,
        backgroundTimer: null,
      };
      this.#clients.set(key, client);
      this.#schedule(client);
      return {
        negotiation,
        ack: (ack) => this.#ack(client, ack),
        nack: (nack) => this.#nack(client, nack),
        setVisibility: (visibilityInput) => {
          if (client.closed) return;
          client.visibility = TerminalDeliveryVisibilitySchemaZ.parse(visibilityInput);
          if (client.visibility === "visible" || client.visibility === "background")
            this.#schedule(client);
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
    const record = { update, state: result.state, trace };
    pane.latest = record;
    pane.revisions.set(update.revision, record);
    while (pane.revisions.size > MAX_CANONICAL_REVISIONS)
      pane.revisions.delete(pane.revisions.keys().next().value!);
    for (const client of this.#clients.values()) {
      if (client.paneId !== semanticPaneId || client.closed) continue;
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
    try {
      const representation = this.#representation(client, pane, target);
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
        encoding: client.negotiated.encoding,
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
      client.inFlight = {
        envelope,
        bytes: representation.bytes,
        nextChunk: 0,
        sentAt: this.#scheduler.nowMs(),
      };
      this.#enqueue(client, envelope);
    } catch (error) {
      this.#fault(
        client,
        error instanceof TerminalDeliveryStateTooLargeError
          ? "state-too-large"
          : "protocol-violation",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (this.#observability.enabled)
        this.#observability.recordSpan(
          "transport",
          "terminal-delivery-encode-enqueue",
          traceStarted,
          this.#observability.nowMicros(),
          target.trace,
        );
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
    let result: CachedRepresentation;
    if (client.negotiated.encoding === "semantic-v1") {
      let payload = client.reseedRequired
        ? semanticSeed(target)
        : semanticPayload(client.baselineRevision, baseline, target);
      let bytes = encodeSemanticTerminalUpdate(payload);
      if (payload.frame === "patch" && bytes.byteLength > TERMINAL_DELIVERY_PATCH_TO_SEED_BYTES) {
        payload = semanticSeed(target);
        bytes = encodeSemanticTerminalUpdate(payload);
        this.#reseeds += 1;
      }
      result = {
        bytes,
        frame: payload.frame,
        canonicalEquivalent: true,
        history: payload.frame === "tombstone" ? "not-applicable" : "complete",
      };
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
    const hashed = {
      ...result,
      representationHash: hashTerminalDeliveryRepresentation(result.bytes),
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
    this.#schedule(client);
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
  }

  #fault(
    client: ClientState,
    reason: "state-too-large" | "source-closed" | "protocol-violation",
    message: string,
  ): void {
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
