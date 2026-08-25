import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";

const MAX_EVENTS = 64;

export interface Card5EnvelopeEvidenceEvent {
  readonly type: CanonicalTerminalReplicaUpdate["type"];
  readonly generation: string;
  readonly revision: number;
  readonly acceptedOrdinal: number;
}

interface Card5ReplacementBoundary {
  readonly predecessorGeneration: string;
  readonly replacementGeneration: string;
  readonly acceptedOrdinal: number;
  readonly socketOrdinal: number;
}

interface Card5SocketEvent {
  readonly generation: string;
  readonly outcome: "open" | "closed" | "failed";
  readonly ordinal: number;
}

export type Card5PaneStreamLifecycleStage =
  | "issued"
  | "socket-open"
  | "server-ready"
  | "layout-validated"
  | "delivery-open"
  | "first-seed"
  | "terminal";

export type Card5PaneStreamLifecycleOrigin = "client" | "peer" | "dispose" | "unknown";

export interface Card5PaneStreamLifecycleEvent {
  readonly generation: string;
  readonly requestId: string;
  readonly stage: Card5PaneStreamLifecycleStage;
  readonly code: string;
  readonly origin: Card5PaneStreamLifecycleOrigin;
  readonly closeCode: number | null;
  readonly closeReason: string;
  readonly ordinal: number;
}

interface Card5AckEvent {
  readonly generation: string;
  readonly revision: number;
  readonly transactionId: string;
  readonly deliveryNonce: string;
  readonly canonicalStateHash: string;
  readonly ordinal: number;
}

interface Card5DescriptorEvent {
  readonly generation: string;
  readonly requestId: string;
  readonly socketUrl: string;
  readonly subprotocol: string;
  readonly ordinal: number;
}

interface Card5ActiveLifecycleRequest {
  readonly generation: string;
  readonly requestId: string;
  readonly firstSeedOrdinal: number;
  readonly workspaceName: string;
  readonly semanticPaneIds: readonly string[];
}

interface Card5InputReceiptEvent {
  readonly generation: string;
  readonly pane: string;
  readonly seq: number;
  readonly inputSha256: string;
  readonly requestId: string;
  readonly authorityClientId: string;
  readonly ordinal: number;
}

interface Card5GeometryReceiptEvent {
  readonly generation: string;
  readonly requestId: string;
  readonly authorityClientId: string;
  readonly seq: number;
  readonly cols: number;
  readonly rows: number;
  readonly ordinal: number;
}

type Card5EvidenceGlobals = typeof globalThis & {
  __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__?: () => Readonly<{
    events: readonly Card5EnvelopeEvidenceEvent[];
    acceptedCount: number;
    replacementCount: number;
    replacementBoundary: Card5ReplacementBoundary | null;
    predecessorAcceptedAfterReplacement: number;
    socketEvents: readonly Card5SocketEvent[];
    socketEventCount: number;
    lifecycleEvents: readonly Card5PaneStreamLifecycleEvent[];
    lifecycleEventCount: number;
    activeLifecycleRequests: readonly Card5ActiveLifecycleRequest[];
    activeLifecycleRequestOverflowGenerations: readonly string[];
    ackEvents: readonly Card5AckEvent[];
    ackSentCount: number;
    descriptorEvents: readonly Card5DescriptorEvent[];
    descriptorEventCount: number;
    inputReceipts: readonly Card5InputReceiptEvent[];
    inputReceiptCount: number;
    geometryReceipts: readonly Card5GeometryReceiptEvent[];
    geometryReceiptCount: number;
  }>;
  __TMUX_IDE_CARD5_ENVELOPE_STORE__?: {
    events: Card5EnvelopeEvidenceEvent[];
    acceptedCount: number;
    replacementCount: number;
    replacementBoundary: Card5ReplacementBoundary | null;
    predecessorAcceptedAfterReplacement: number;
    socketEvents: Card5SocketEvent[];
    socketEventCount: number;
    lifecycleEvents: Card5PaneStreamLifecycleEvent[];
    lifecycleEventCount: number;
    activeLifecycleRequests: Map<string, Card5ActiveLifecycleRequest>;
    activeLifecycleRequestOverflowGenerations: Set<string>;
    ackEvents: Card5AckEvent[];
    ackSentCount: number;
    descriptorEvents: Card5DescriptorEvent[];
    descriptorEventCount: number;
    inputReceipts: Card5InputReceiptEvent[];
    inputReceiptCount: number;
    geometryReceipts: Card5GeometryReceiptEvent[];
    geometryReceiptCount: number;
  };
};

type Card5EnvelopeStore = NonNullable<Card5EvidenceGlobals["__TMUX_IDE_CARD5_ENVELOPE_STORE__"]>;

/** Detailed ProductRig-only recorder. Disabled mode allocates no event storage. */
export function createCard5EnvelopeEvidenceRecorder():
  | ((update: CanonicalTerminalReplicaUpdate) => void)
  | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const initialStore: Card5EnvelopeStore = {
    events: [],
    acceptedCount: 0,
    replacementCount: 0,
    replacementBoundary: null,
    predecessorAcceptedAfterReplacement: 0,
    socketEvents: [],
    socketEventCount: 0,
    lifecycleEvents: [],
    lifecycleEventCount: 0,
    activeLifecycleRequests: new Map(),
    activeLifecycleRequestOverflowGenerations: new Set(),
    ackEvents: [],
    ackSentCount: 0,
    descriptorEvents: [],
    descriptorEventCount: 0,
    inputReceipts: [],
    inputReceiptCount: 0,
    geometryReceipts: [],
    geometryReceiptCount: 0,
  };
  const store = (host.__TMUX_IDE_CARD5_ENVELOPE_STORE__ ??= initialStore);
  host.__TMUX_IDE_CARD5_ENVELOPE_EVIDENCE__ ??= () =>
    Object.freeze({
      events: Object.freeze(store.events.map((event) => Object.freeze({ ...event }))),
      acceptedCount: Math.min(store.acceptedCount, 0xffff_ffff),
      replacementCount: Math.min(store.replacementCount, 65_535),
      replacementBoundary: store.replacementBoundary
        ? Object.freeze({ ...store.replacementBoundary })
        : null,
      predecessorAcceptedAfterReplacement: Math.min(
        store.predecessorAcceptedAfterReplacement,
        65_535,
      ),
      socketEvents: Object.freeze(store.socketEvents.map((event) => Object.freeze({ ...event }))),
      socketEventCount: Math.min(store.socketEventCount, 0xffff_ffff),
      lifecycleEvents: Object.freeze(
        store.lifecycleEvents.map((event) => Object.freeze({ ...event })),
      ),
      lifecycleEventCount: Math.min(store.lifecycleEventCount, 0xffff_ffff),
      activeLifecycleRequests: Object.freeze(
        [...store.activeLifecycleRequests.values()].map((request) =>
          Object.freeze({
            ...request,
            semanticPaneIds: Object.freeze([...request.semanticPaneIds]),
          }),
        ),
      ),
      activeLifecycleRequestOverflowGenerations: Object.freeze([
        ...store.activeLifecycleRequestOverflowGenerations,
      ]),
      ackEvents: Object.freeze(store.ackEvents.map((event) => Object.freeze({ ...event }))),
      ackSentCount: Math.min(store.ackSentCount, 0xffff_ffff),
      descriptorEvents: Object.freeze(
        store.descriptorEvents.map((event) => Object.freeze({ ...event })),
      ),
      descriptorEventCount: Math.min(store.descriptorEventCount, 65_535),
      inputReceipts: Object.freeze(store.inputReceipts.map((event) => Object.freeze({ ...event }))),
      inputReceiptCount: Math.min(store.inputReceiptCount, 0xffff_ffff),
      geometryReceipts: Object.freeze(
        store.geometryReceipts.map((event) => Object.freeze({ ...event })),
      ),
      geometryReceiptCount: Math.min(store.geometryReceiptCount, 0xffff_ffff),
    });
  return (update) => {
    const acceptedOrdinal = store.acceptedCount;
    store.acceptedCount += 1;
    if (
      store.replacementBoundary &&
      acceptedOrdinal >= store.replacementBoundary.acceptedOrdinal &&
      update.generation === store.replacementBoundary.predecessorGeneration
    ) {
      store.predecessorAcceptedAfterReplacement += 1;
    }
    if (store.events.length === MAX_EVENTS) store.events.shift();
    store.events.push({
      type: update.type,
      generation: update.generation,
      revision: update.revision,
      acceptedOrdinal,
    });
  };
}

/** Detailed-only pane-stream causality recorder. Raw request ids never leave the
 * page; the ProductRig observer projects them to keyed digests. */
export function createCard5PaneStreamLifecycleRecorder(binding?: {
  readonly workspaceName: string;
  readonly semanticPaneIds: readonly string[];
}): ((event: Omit<Card5PaneStreamLifecycleEvent, "ordinal">) => void) | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return null;
  return (event) => {
    const requestKey = `${event.generation}\u0000${event.requestId}`;
    if (event.stage === "terminal") {
      store.activeLifecycleRequests.delete(requestKey);
    } else if (event.stage === "first-seed" && !store.activeLifecycleRequests.has(requestKey)) {
      if (
        !binding ||
        binding.workspaceName.length === 0 ||
        binding.semanticPaneIds.length === 0 ||
        binding.semanticPaneIds.some((pane) => pane.length === 0)
      ) {
        store.activeLifecycleRequestOverflowGenerations.add(event.generation);
      }
      for (const [key, request] of store.activeLifecycleRequests) {
        if (request.generation !== event.generation) store.activeLifecycleRequests.delete(key);
      }
      for (const generation of store.activeLifecycleRequestOverflowGenerations) {
        if (generation !== event.generation)
          store.activeLifecycleRequestOverflowGenerations.delete(generation);
      }
      const generationActiveCount = [...store.activeLifecycleRequests.values()].filter(
        (request) => request.generation === event.generation,
      ).length;
      if (!binding || generationActiveCount >= 8) {
        store.activeLifecycleRequestOverflowGenerations.add(event.generation);
      } else {
        store.activeLifecycleRequests.set(requestKey, {
          generation: event.generation,
          requestId: event.requestId,
          firstSeedOrdinal: store.lifecycleEventCount,
          workspaceName: binding.workspaceName,
          semanticPaneIds: Object.freeze([...new Set(binding.semanticPaneIds)].sort()),
        });
      }
    }
    if (store.lifecycleEvents.length === MAX_EVENTS) store.lifecycleEvents.shift();
    store.lifecycleEvents.push({ ...event, ordinal: store.lifecycleEventCount });
    store.lifecycleEventCount += 1;
  };
}

export function createCard5GeometryReceiptRecorder():
  | ((receipt: Omit<Card5GeometryReceiptEvent, "ordinal">) => void)
  | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return null;
  return (receipt) => {
    if (store.geometryReceipts.length === 16) store.geometryReceipts.shift();
    store.geometryReceipts.push({ ...receipt, ordinal: store.geometryReceiptCount });
    store.geometryReceiptCount += 1;
  };
}

export function createCard5InputReceiptRecorder():
  | ((receipt: {
      readonly generation: string;
      readonly pane: string;
      readonly seq: number;
      readonly input: string;
      readonly requestId: string;
      readonly authorityClientId: string;
    }) => Promise<void>)
  | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return null;
  return async (receipt) => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(receipt.input),
    );
    const inputSha256 = [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    if (store.inputReceipts.length === 64) store.inputReceipts.shift();
    store.inputReceipts.push({
      generation: receipt.generation,
      pane: receipt.pane,
      seq: receipt.seq,
      inputSha256,
      requestId: receipt.requestId,
      authorityClientId: receipt.authorityClientId,
      ordinal: store.inputReceiptCount,
    });
    store.inputReceiptCount += 1;
  };
}

export function createCard5DescriptorRecorder():
  | ((descriptor: {
      readonly daemonInstanceId: string;
      readonly requestId: string;
      readonly webSocketUrl: string;
      readonly subprotocol: string;
    }) => void)
  | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return null;
  return (descriptor) => {
    if (store.descriptorEvents.length === 8) store.descriptorEvents.shift();
    store.descriptorEvents.push({
      generation: descriptor.daemonInstanceId,
      requestId: descriptor.requestId,
      socketUrl: descriptor.webSocketUrl,
      subprotocol: descriptor.subprotocol,
      ordinal: store.descriptorEventCount,
    });
    store.descriptorEventCount += 1;
  };
}

export function createCard5EnvelopeAckRecorder():
  | ((ack: {
      readonly generation: string;
      readonly canonicalRevision: number;
      readonly transactionId: string;
      readonly deliveryNonce: string;
      readonly canonicalStateHash: string;
    }) => void)
  | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return null;
  return (ack) => {
    if (store.ackEvents.length === 64) store.ackEvents.shift();
    store.ackEvents.push({
      generation: ack.generation,
      revision: ack.canonicalRevision,
      transactionId: ack.transactionId,
      deliveryNonce: ack.deliveryNonce,
      canonicalStateHash: ack.canonicalStateHash,
      ordinal: store.ackSentCount,
    });
    store.ackSentCount += 1;
  };
}

export function recordCard5SocketLifecycle(
  generation: string,
  outcome: Card5SocketEvent["outcome"],
): void {
  const host = globalThis as Card5EvidenceGlobals;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store || !["open", "closed", "failed"].includes(outcome)) return;
  if (store.socketEvents.length === 16) store.socketEvents.shift();
  store.socketEvents.push({ generation, outcome, ordinal: store.socketEventCount });
  store.socketEventCount += 1;
}

export function recordCard5RuntimeReplacement(before: string | null, after: string): void {
  const host = globalThis as Card5EvidenceGlobals;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store || before === null || before === after) return;
  store.replacementCount += 1;
  store.replacementBoundary = {
    predecessorGeneration: before,
    replacementGeneration: after,
    acceptedOrdinal: store.acceptedCount,
    socketOrdinal: store.socketEventCount,
  };
  store.predecessorAcceptedAfterReplacement = 0;
}
