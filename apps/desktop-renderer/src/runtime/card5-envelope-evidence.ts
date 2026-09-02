import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import type { Card5PhysicalPaneStreamBinding } from "../terminal/pane-stream-transport.ts";

const MAX_EVENTS = 64;
const MAX_ACTIVE_LIFECYCLE_REQUESTS = 16;
const MAX_ACTIVE_LIFECYCLE_REQUESTS_PER_GENERATION = 8;
const MAX_ACTIVE_LIFECYCLE_OVERFLOW_GENERATIONS = 16;

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
  readonly physicalEpoch: number;
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
  readonly physicalEpoch: number;
  readonly generation: string;
  readonly requestId: string;
  readonly socketUrl: string;
  readonly subprotocol: string;
  readonly ordinal: number;
}

interface Card5ActiveLifecycleRequest {
  readonly physicalEpoch: number;
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

export type Card5InputOperationStage =
  | "xterm-enqueue"
  | "surface-write"
  | "authority-request"
  | "authority-result"
  | "input-send"
  | "input-ack"
  | "receipt-published";

export type Card5InputOperationOutcome =
  | "attempt"
  | "ok"
  | "sent"
  | "send-failed"
  | "granted"
  | "rejected"
  | "authority-timeout"
  | "ack-timeout"
  | "closed"
  | "unavailable"
  | "failed";

interface Card5InputOperationEvent {
  readonly physicalEpoch: number | null;
  readonly generation: string | null;
  readonly lifecycleRequestId: string | null;
  readonly authorityRequestId: string | null;
  readonly clientId: string | null;
  readonly pane: string | null;
  readonly seq: number | null;
  readonly stage: Card5InputOperationStage;
  readonly outcome: Card5InputOperationOutcome;
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
    activeLifecycleRequestGlobalOverflow: boolean;
    ackEvents: readonly Card5AckEvent[];
    ackSentCount: number;
    descriptorEvents: readonly Card5DescriptorEvent[];
    descriptorEventCount: number;
    inputReceipts: readonly Card5InputReceiptEvent[];
    inputReceiptCount: number;
    inputOperations: readonly Card5InputOperationEvent[];
    inputOperationCount: number;
    geometryReceipts: readonly Card5GeometryReceiptEvent[];
    geometryReceiptCount: number;
    physicalEpochCount: number;
    currentPhysicalBinding: Card5PhysicalPaneStreamBinding | null;
    physicalBindingOrdinal: number;
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
    activeLifecycleRequestGlobalOverflow: boolean;
    ackEvents: Card5AckEvent[];
    ackSentCount: number;
    descriptorEvents: Card5DescriptorEvent[];
    descriptorEventCount: number;
    inputReceipts: Card5InputReceiptEvent[];
    inputReceiptCount: number;
    inputOperations: Card5InputOperationEvent[];
    inputOperationCount: number;
    geometryReceipts: Card5GeometryReceiptEvent[];
    geometryReceiptCount: number;
    physicalEpochCount: number;
    currentPhysicalBinding: Card5PhysicalPaneStreamBinding | null;
    physicalBindingOrdinal: number;
  };
  __TMUX_IDE_CARD5_INPUT_OPERATION_RECORD__?: (event: {
    readonly stage: Card5InputOperationStage;
    readonly outcome: Card5InputOperationOutcome;
    readonly generation?: string | null;
    readonly lifecycleRequestId?: string | null;
    readonly authorityRequestId?: string | null;
    readonly clientId?: string | null;
    readonly pane?: string | null;
    readonly seq?: number | null;
  }) => void;
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
    activeLifecycleRequestGlobalOverflow: false,
    ackEvents: [],
    ackSentCount: 0,
    descriptorEvents: [],
    descriptorEventCount: 0,
    inputReceipts: [],
    inputReceiptCount: 0,
    inputOperations: [],
    inputOperationCount: 0,
    geometryReceipts: [],
    geometryReceiptCount: 0,
    physicalEpochCount: 0,
    currentPhysicalBinding: null,
    physicalBindingOrdinal: 0,
  };
  const store = (host.__TMUX_IDE_CARD5_ENVELOPE_STORE__ ??= initialStore);
  host.__TMUX_IDE_CARD5_INPUT_OPERATION_RECORD__ ??= (event) => {
    const binding = store.currentPhysicalBinding;
    if (store.inputOperations.length === 64) store.inputOperations.shift();
    store.inputOperations.push({
      physicalEpoch: binding?.physicalEpoch ?? null,
      generation: event.generation ?? binding?.generation ?? null,
      lifecycleRequestId: event.lifecycleRequestId ?? binding?.requestId ?? null,
      authorityRequestId: event.authorityRequestId ?? null,
      clientId: event.clientId ?? binding?.clientId ?? null,
      pane: event.pane ?? null,
      seq: Number.isSafeInteger(event.seq) && (event.seq ?? -1) >= 0 ? event.seq! : null,
      stage: event.stage,
      outcome: event.outcome,
      ordinal: store.inputOperationCount,
    });
    store.inputOperationCount += 1;
  };
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
      activeLifecycleRequestGlobalOverflow: store.activeLifecycleRequestGlobalOverflow,
      ackEvents: Object.freeze(store.ackEvents.map((event) => Object.freeze({ ...event }))),
      ackSentCount: Math.min(store.ackSentCount, 0xffff_ffff),
      descriptorEvents: Object.freeze(
        store.descriptorEvents.map((event) => Object.freeze({ ...event })),
      ),
      descriptorEventCount: Math.min(store.descriptorEventCount, 65_535),
      inputReceipts: Object.freeze(store.inputReceipts.map((event) => Object.freeze({ ...event }))),
      inputReceiptCount: Math.min(store.inputReceiptCount, 0xffff_ffff),
      inputOperations: Object.freeze(
        store.inputOperations.map((event) => Object.freeze({ ...event })),
      ),
      inputOperationCount: Math.min(store.inputOperationCount, 0xffff_ffff),
      geometryReceipts: Object.freeze(
        store.geometryReceipts.map((event) => Object.freeze({ ...event })),
      ),
      geometryReceiptCount: Math.min(store.geometryReceiptCount, 0xffff_ffff),
      physicalEpochCount: Math.min(store.physicalEpochCount, 0xffff_ffff),
      currentPhysicalBinding: store.currentPhysicalBinding
        ? Object.freeze({
            ...store.currentPhysicalBinding,
            semanticPaneIds: Object.freeze([...store.currentPhysicalBinding.semanticPaneIds]),
          })
        : null,
      physicalBindingOrdinal: Math.min(store.physicalBindingOrdinal, 0xffff_ffff),
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
  readonly physicalEpoch?: number;
}):
  | (((event: Omit<Card5PaneStreamLifecycleEvent, "ordinal" | "physicalEpoch">) => void) & {
      readonly physicalEpoch: number;
    })
  | null {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return null;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return null;
  const physicalEpoch = binding?.physicalEpoch ?? store.physicalEpochCount + 1;
  if (
    !Number.isSafeInteger(physicalEpoch) ||
    physicalEpoch < 1 ||
    physicalEpoch <= store.physicalEpochCount
  )
    return null;
  store.physicalEpochCount = physicalEpoch;
  const markOverflow = (generation: string) => {
    if (store.activeLifecycleRequestOverflowGenerations.has(generation)) return;
    if (
      store.activeLifecycleRequestOverflowGenerations.size >=
      MAX_ACTIVE_LIFECYCLE_OVERFLOW_GENERATIONS
    ) {
      store.activeLifecycleRequestGlobalOverflow = true;
      return;
    }
    store.activeLifecycleRequestOverflowGenerations.add(generation);
  };
  const record = (event: Omit<Card5PaneStreamLifecycleEvent, "ordinal" | "physicalEpoch">) => {
    const requestKey = `${event.generation}\u0000${event.requestId}\u0000${physicalEpoch}`;
    if (event.stage === "terminal") {
      store.activeLifecycleRequests.delete(requestKey);
    } else if (event.stage === "first-seed" && !store.activeLifecycleRequests.has(requestKey)) {
      if (
        !binding ||
        binding.workspaceName.length === 0 ||
        binding.semanticPaneIds.length === 0 ||
        binding.semanticPaneIds.some((pane) => pane.length === 0)
      ) {
        markOverflow(event.generation);
      }
      const generationActiveCount = [...store.activeLifecycleRequests.values()].filter(
        (request) => request.generation === event.generation,
      ).length;
      if (
        !binding ||
        generationActiveCount >= MAX_ACTIVE_LIFECYCLE_REQUESTS_PER_GENERATION ||
        store.activeLifecycleRequests.size >= MAX_ACTIVE_LIFECYCLE_REQUESTS
      ) {
        markOverflow(event.generation);
      } else {
        store.activeLifecycleRequests.set(requestKey, {
          physicalEpoch,
          generation: event.generation,
          requestId: event.requestId,
          firstSeedOrdinal: store.lifecycleEventCount,
          workspaceName: binding.workspaceName,
          semanticPaneIds: Object.freeze([...new Set(binding.semanticPaneIds)].sort()),
        });
      }
    }
    if (store.lifecycleEvents.length === MAX_EVENTS) store.lifecycleEvents.shift();
    store.lifecycleEvents.push({ ...event, physicalEpoch, ordinal: store.lifecycleEventCount });
    store.lifecycleEventCount += 1;
  };
  return Object.assign(record, { physicalEpoch });
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
    host.__TMUX_IDE_CARD5_INPUT_OPERATION_RECORD__?.({
      stage: "receipt-published",
      outcome: "ok",
      generation: receipt.generation,
      lifecycleRequestId: receipt.requestId,
      clientId: receipt.authorityClientId,
      pane: receipt.pane,
      seq: receipt.seq,
    });
  };
}

export function createCard5DescriptorRecorder(
  physicalEpoch: number | null = null,
):
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
  const retainedPhysicalEpoch =
    Number.isSafeInteger(physicalEpoch) && physicalEpoch! > 0
      ? physicalEpoch!
      : ++store.physicalEpochCount;
  return (descriptor) => {
    if (store.descriptorEvents.length === 8) store.descriptorEvents.shift();
    store.descriptorEvents.push({
      physicalEpoch: retainedPhysicalEpoch,
      generation: descriptor.daemonInstanceId,
      requestId: descriptor.requestId,
      socketUrl: descriptor.webSocketUrl,
      subprotocol: descriptor.subprotocol,
      ordinal: store.descriptorEventCount,
    });
    store.descriptorEventCount += 1;
  };
}

/** Detailed-only projection of the exact currently retained physical bridge binding. */
export function recordCard5PhysicalBridgeBinding(
  binding: Card5PhysicalPaneStreamBinding | null,
): void {
  const host = globalThis as Card5EvidenceGlobals;
  if (host.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ !== true) return;
  const store = host.__TMUX_IDE_CARD5_ENVELOPE_STORE__;
  if (!store) return;
  store.currentPhysicalBinding = binding
    ? Object.freeze({ ...binding, semanticPaneIds: Object.freeze([...binding.semanticPaneIds]) })
    : null;
  store.physicalBindingOrdinal += 1;
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
