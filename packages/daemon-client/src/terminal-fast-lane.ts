import type {
  CanonicalTerminalReplicaUpdate,
  CausalCellProbeRequestV1,
  SessionRuntimeAuthorityKind,
  SessionRuntimeTerminalInput,
  TerminalReplicaDeliveryMetadata,
  TerminalReplicaAddress,
} from "@tmux-ide/contracts";
import { SessionRuntimeTerminalInputSchemaZ } from "@tmux-ide/contracts";
import {
  applyTerminalReplicaUpdate,
  type TerminalReplicaApplyResult,
  type TerminalReplicaState,
} from "@tmux-ide/core";

import { FirstLatestCoordinator } from "./first-latest-coordinator.ts";

export interface TerminalFastLaneGenerationAddress {
  readonly workspaceName: string;
  readonly generation: string;
}

export interface TerminalFastLanePaneAddress extends TerminalFastLaneGenerationAddress {
  readonly semanticPaneId: string;
}

export type TerminalFastLaneRepairReason = "gap" | "conflict" | "wrong-address";

export interface TerminalFastLaneSourcePort {
  subscribe(
    address: TerminalFastLanePaneAddress,
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void,
  ): () => void;
}

/** A transport-ingress-validated canonical subscription, never an unknown replica cast. */
export interface CanonicalTerminalSubscriptionPort {
  readonly subscribeTerminal: (
    target: TerminalReplicaAddress,
    listener: (
      update: CanonicalTerminalReplicaUpdate,
      metadata?: TerminalReplicaDeliveryMetadata,
    ) => void,
  ) => () => void;
}

export interface TerminalFastLaneRepairPort {
  request(input: {
    readonly address: TerminalFastLanePaneAddress;
    readonly reason: TerminalFastLaneRepairReason;
    readonly expectedRevision: number;
    readonly receivedRevision: number;
  }): void | Promise<void>;
}

export type TerminalFastLaneMutationResult = "ok" | "authority-lost";

export interface TerminalFastLaneControlPort {
  owns(authority: SessionRuntimeAuthorityKind, generation: string): boolean;
  request(authority: SessionRuntimeAuthorityKind, generation: string): Promise<boolean>;
  write(
    address: TerminalFastLanePaneAddress,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeRequestV1,
  ): Promise<TerminalFastLaneMutationResult>;
  resize(
    address: TerminalFastLaneGenerationAddress,
    viewport: TerminalFastLaneViewport,
  ): Promise<TerminalFastLaneMutationResult>;
}

export interface TerminalFastLaneViewport {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalFastLanePublication {
  readonly address: TerminalFastLanePaneAddress;
  readonly state: TerminalReplicaState;
  readonly update: CanonicalTerminalReplicaUpdate;
  readonly paintTrace?: {
    readonly traceId: string;
    readonly generation: string;
    readonly incarnation: string;
  };
}

export type TerminalFastLaneInputOutcome =
  | { readonly status: "sent" }
  | {
      readonly status: "rejected";
      readonly reason:
        | "queue-full"
        | "authority-denied"
        | "authority-lost"
        | "disposed"
        | "retired";
    }
  | { readonly status: "failed"; readonly error: unknown };

export type TerminalFastLaneResizeOutcome =
  | { readonly status: "applied" }
  | { readonly status: "superseded" | "disposed" | "retired" }
  | { readonly status: "failed"; readonly error: unknown };

export interface TerminalFastLaneCounters {
  readonly accepted: number;
  readonly published: number;
  readonly duplicateOrStale: number;
  readonly rejected: number;
  readonly repairs: number;
  readonly inputAccepted: number;
  readonly inputRejected: number;
  readonly inputWrites: number;
  readonly inputPending: number;
  readonly inputInFlight: number;
  readonly inputPendingBytes: number;
  readonly authorityRequests: number;
  readonly resizeAccepted: number;
  readonly resizeTransports: number;
  readonly resizeSuperseded: number;
}

export interface TerminalFastLaneOptions {
  readonly address: TerminalFastLaneGenerationAddress;
  readonly source: TerminalFastLaneSourcePort;
  readonly repair: TerminalFastLaneRepairPort;
  readonly control: TerminalFastLaneControlPort;
  readonly maxPendingInputs?: number;
  readonly maxPendingInputBytes?: number;
  readonly maxInFlightInputs?: number;
  /** Opt-in same-process causal stages; absent in ordinary production. */
  readonly onTraceStage?: (event: {
    readonly traceId: string;
    readonly operation: string;
    readonly atMicros: number;
    readonly inputPending: number;
    readonly inputInFlight: number;
    readonly inputPendingBytes: number;
    readonly semanticPaneId?: string;
    readonly generation?: string;
    readonly incarnation?: string;
    readonly revision?: number;
    readonly stateHash?: string;
  }) => void;
  /** Test-only clock seam, consulted only while the trace observer is installed. */
  readonly diagnosticNowMicros?: () => number;
}

export interface TerminalFastLane {
  address(): TerminalFastLaneGenerationAddress;
  replaceGeneration(address: TerminalFastLaneGenerationAddress): void;
  /** Replace the exact generation-scoped pane inventory retained by this lane. */
  retainPanes(semanticPaneIds: readonly string[]): void;
  /**
   * Prepare candidate pane interests without retiring the active inventory.
   * The returned release is idempotent; callers commit with retainPanes first,
   * then release the candidate stage.
   */
  stagePanes(semanticPaneIds: readonly string[]): () => void;
  subscribePane(
    semanticPaneId: string,
    listener: (publication: TerminalFastLanePublication) => void,
  ): () => void;
  paneState(semanticPaneId: string): TerminalReplicaState | null;
  paneLastAcceptedUpdateType(semanticPaneId: string): CanonicalTerminalReplicaUpdate["type"] | null;
  sendInput(
    semanticPaneId: string,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeRequestV1,
  ): Promise<TerminalFastLaneInputOutcome>;
  resize(viewport: TerminalFastLaneViewport): Promise<TerminalFastLaneResizeOutcome>;
  counters(): TerminalFastLaneCounters;
  dispose(): void;
}

interface PaneInterest {
  readonly semanticPaneId: string;
  readonly listeners: Set<(publication: TerminalFastLanePublication) => void>;
  state: TerminalReplicaState | null;
  lastAcceptedUpdateType: CanonicalTerminalReplicaUpdate["type"] | null;
  repairPending: boolean;
  release: (() => void) | null;
}

interface InputRequest {
  readonly generationEpoch: number;
  readonly semanticPaneId: string;
  readonly input: SessionRuntimeTerminalInput;
  readonly performanceTraceId?: string;
  readonly causalProbe?: CausalCellProbeRequestV1;
  readonly byteLength: number;
  readonly resolve: (outcome: TerminalFastLaneInputOutcome) => void;
  settled: boolean;
}

const DEFAULT_MAX_PENDING_INPUTS = 256;
const DEFAULT_MAX_PENDING_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_IN_FLIGHT_INPUTS = 8;
const utf8 = new TextEncoder();

function paneAddress(
  address: TerminalFastLaneGenerationAddress,
  semanticPaneId: string,
): TerminalFastLanePaneAddress {
  return Object.freeze({ ...address, semanticPaneId });
}

function validViewport(viewport: TerminalFastLaneViewport): boolean {
  return (
    Number.isInteger(viewport.cols) &&
    Number.isInteger(viewport.rows) &&
    viewport.cols > 0 &&
    viewport.rows > 0
  );
}

/**
 * One renderer-neutral terminal data plane. Semantic workspace publications
 * remain outside this object; terminal output wakes only the addressed pane.
 */
export function createTerminalFastLane(options: TerminalFastLaneOptions): TerminalFastLane {
  const maxPendingInputs = options.maxPendingInputs ?? DEFAULT_MAX_PENDING_INPUTS;
  const maxPendingInputBytes = options.maxPendingInputBytes ?? DEFAULT_MAX_PENDING_INPUT_BYTES;
  const maxInFlightInputs = options.maxInFlightInputs ?? DEFAULT_MAX_IN_FLIGHT_INPUTS;
  if (!Number.isInteger(maxPendingInputs) || maxPendingInputs < 1)
    throw new TypeError("maxPendingInputs must be a positive integer");
  if (!Number.isInteger(maxPendingInputBytes) || maxPendingInputBytes < 1)
    throw new TypeError("maxPendingInputBytes must be a positive integer");
  if (!Number.isInteger(maxInFlightInputs) || maxInFlightInputs < 1)
    throw new TypeError("maxInFlightInputs must be a positive integer");

  const panes = new Map<string, PaneInterest>();
  let retainedPaneIds: ReadonlySet<string> | null = null;
  const stagedPaneCounts = new Map<string, number>();
  const inputQueue: InputRequest[] = [];
  const inFlightInputs = new Set<InputRequest>();
  const authorityRequests = new Map<SessionRuntimeAuthorityKind, Promise<boolean>>();
  let generationAddress = Object.freeze({ ...options.address });
  let generationEpoch = 1;
  let disposed = false;
  let inputBytes = 0;
  let inputDrainEpoch: number | null = null;
  const resizeCoordinator = new FirstLatestCoordinator();
  const resizeWaiters = new Map<string, Array<(outcome: TerminalFastLaneResizeOutcome) => void>>();
  const mutableCounters = {
    accepted: 0,
    published: 0,
    duplicateOrStale: 0,
    rejected: 0,
    repairs: 0,
    inputAccepted: 0,
    inputRejected: 0,
    inputWrites: 0,
    authorityRequests: 0,
    resizeAccepted: 0,
    resizeTransports: 0,
    resizeSuperseded: 0,
  };
  const traceStage = (
    traceId: string | undefined,
    operation: string,
    atMicros?: number,
    identity?: {
      readonly semanticPaneId: string;
      readonly generation: string;
      readonly incarnation: string;
      readonly revision: number;
      readonly stateHash: string;
    },
  ): void => {
    if (!traceId || !options.onTraceStage) return;
    try {
      options.onTraceStage({
        traceId,
        operation,
        atMicros:
          atMicros ?? options.diagnosticNowMicros?.() ?? Math.floor(performance.now() * 1_000),
        inputPending: inputQueue.length,
        inputInFlight: inFlightInputs.size,
        inputPendingBytes: inputBytes,
        ...identity,
      });
    } catch {
      // Diagnostic observers never own canonical delivery or input dispatch.
    }
  };
  const diagnosticNowMicros = (): number | undefined => {
    try {
      return options.diagnosticNowMicros?.() ?? Math.floor(performance.now() * 1_000);
    } catch {
      return undefined;
    }
  };

  const requestAuthority = (
    authority: SessionRuntimeAuthorityKind,
    epoch: number,
  ): Promise<boolean> => {
    if (disposed || epoch !== generationEpoch) return Promise.resolve(false);
    if (options.control.owns(authority, generationAddress.generation)) return Promise.resolve(true);
    const existing = authorityRequests.get(authority);
    if (existing) return existing;
    mutableCounters.authorityRequests += 1;
    const generation = generationAddress.generation;
    let acquisition: Promise<boolean>;
    try {
      acquisition = options.control.request(authority, generation);
    } catch {
      acquisition = Promise.resolve(false);
    }
    const request = acquisition
      .then((granted) => !disposed && epoch === generationEpoch && granted)
      .catch(() => false)
      .finally(() => {
        if (authorityRequests.get(authority) === request) authorityRequests.delete(authority);
      });
    authorityRequests.set(authority, request);
    return request;
  };

  const rejectInput = (
    input: InputRequest,
    reason: Extract<TerminalFastLaneInputOutcome, { status: "rejected" }>["reason"],
  ): void => {
    if (input.settled) return;
    input.settled = true;
    inputBytes -= input.byteLength;
    mutableCounters.inputRejected += 1;
    input.resolve({ status: "rejected", reason });
  };

  const settleInput = (input: InputRequest, outcome: TerminalFastLaneInputOutcome): void => {
    if (input.settled) return;
    input.settled = true;
    inputBytes -= input.byteLength;
    input.resolve(outcome);
  };

  const requestRepair = (
    interest: PaneInterest,
    reason: TerminalFastLaneRepairReason,
    result: Extract<TerminalReplicaApplyResult, { status: "gap" | "conflict" }>,
    receivedRevision: number,
  ): void => {
    if (interest.repairPending) return;
    interest.repairPending = true;
    mutableCounters.repairs += 1;
    try {
      void Promise.resolve(
        options.repair.request({
          address: paneAddress(generationAddress, interest.semanticPaneId),
          reason,
          expectedRevision: result.expectedRevision,
          receivedRevision,
        }),
      ).catch(() => undefined);
    } catch {
      // Repair remains coalesced until a valid seed arrives.
    }
  };

  const accept = (
    interest: PaneInterest,
    update: CanonicalTerminalReplicaUpdate,
    metadata?: TerminalReplicaDeliveryMetadata,
  ): void => {
    if (disposed) return;
    const traceEnabled = Boolean(metadata?.performanceTraceId && options.onTraceStage);
    const identity = traceEnabled
      ? {
          semanticPaneId: update.semanticPaneId,
          generation: update.generation,
          incarnation: update.incarnation,
          revision: update.revision,
          stateHash: update.stateHash,
        }
      : undefined;
    traceStage(metadata?.performanceTraceId, "delivery-received", undefined, identity);
    const observerReturnedAtMicros = traceEnabled ? diagnosticNowMicros() : undefined;
    const expected = paneAddress(generationAddress, interest.semanticPaneId);
    if (
      update.generation !== expected.generation ||
      update.workspaceName !== expected.workspaceName ||
      update.semanticPaneId !== expected.semanticPaneId
    ) {
      mutableCounters.rejected += 1;
      requestRepair(
        interest,
        "wrong-address",
        {
          status: "conflict",
          state: interest.state,
          expectedRevision: interest.state?.revision ?? 0,
          receivedRevision: update.revision,
        },
        update.revision,
      );
      return;
    }
    mutableCounters.accepted += 1;
    const applyStartedAtMicros = traceEnabled ? diagnosticNowMicros() : undefined;
    const result = applyTerminalReplicaUpdate(interest.state, update, {
      ...(metadata?.representationHash
        ? { authenticatedFrameHash: metadata.representationHash }
        : {}),
    });
    const applyEndedAtMicros = traceEnabled ? diagnosticNowMicros() : undefined;
    traceStage(
      metadata?.performanceTraceId,
      "delivery-observer-returned",
      observerReturnedAtMicros,
      identity,
    );
    traceStage(
      metadata?.performanceTraceId,
      "canonical-apply-begin",
      applyStartedAtMicros,
      identity,
    );
    traceStage(metadata?.performanceTraceId, "canonical-apply-end", applyEndedAtMicros, identity);
    if (result.status === "idempotent" || result.status === "stale") {
      mutableCounters.duplicateOrStale += 1;
      // A reconnect can legitimately replay the same canonical seed. It is
      // still proof that repair completed for this pane and must release the
      // coalescing latch for a future independent conflict.
      if (update.type === "terminal.seed" && result.status === "idempotent") {
        interest.repairPending = false;
      }
      return;
    }
    if (result.status === "gap" || result.status === "conflict") {
      mutableCounters.rejected += 1;
      requestRepair(interest, result.status, result, update.revision);
      return;
    }
    if (result.status !== "applied") return;
    interest.state = result.state;
    interest.lastAcceptedUpdateType = update.type;
    if (update.type === "terminal.seed") interest.repairPending = false;
    mutableCounters.published += 1;
    traceStage(metadata?.performanceTraceId, "lane-published", undefined, identity);
    const publication = Object.freeze({
      address: expected,
      state: result.state,
      update,
      ...(metadata?.performanceTraceId
        ? {
            paintTrace: Object.freeze({
              traceId: metadata.performanceTraceId,
              generation: update.generation,
              incarnation: update.incarnation,
            }),
          }
        : {}),
    });
    for (const listener of [...interest.listeners]) {
      try {
        listener(publication);
      } catch {
        // One pane observer cannot interrupt sibling observers or protocol ACKs.
      }
    }
  };

  const open = (interest: PaneInterest): void => {
    if (disposed || interest.release) return;
    const epoch = generationEpoch;
    interest.release = options.source.subscribe(
      paneAddress(generationAddress, interest.semanticPaneId),
      (update, metadata) => {
        if (!disposed && epoch === generationEpoch) accept(interest, update, metadata);
      },
    );
  };

  const isRetainedOrStaged = (semanticPaneId: string): boolean =>
    (retainedPaneIds?.has(semanticPaneId) ?? retainedPaneIds === null) ||
    (stagedPaneCounts.get(semanticPaneId) ?? 0) > 0;

  const trimUnownedPane = (semanticPaneId: string): void => {
    if (isRetainedOrStaged(semanticPaneId)) return;
    const interest = panes.get(semanticPaneId);
    if (!interest) return;
    interest.release?.();
    interest.release = null;
    interest.state = null;
    interest.lastAcceptedUpdateType = null;
    interest.repairPending = false;
    panes.delete(semanticPaneId);
  };

  const retainInterest = (semanticPaneId: string): void => {
    const interest =
      panes.get(semanticPaneId) ??
      ({
        semanticPaneId,
        listeners: new Set(),
        state: null,
        lastAcceptedUpdateType: null,
        repairPending: false,
        release: null,
      } satisfies PaneInterest);
    panes.set(semanticPaneId, interest);
    open(interest);
  };

  const retireInputEpoch = (
    epoch: number,
    reason: Extract<TerminalFastLaneInputOutcome, { status: "rejected" }>["reason"],
  ): void => {
    for (let index = inputQueue.length - 1; index >= 0; index -= 1) {
      const input = inputQueue[index]!;
      if (input.generationEpoch !== epoch) continue;
      inputQueue.splice(index, 1);
      rejectInput(input, reason);
    }
    for (const input of [...inFlightInputs]) {
      if (input.generationEpoch !== epoch) continue;
      inFlightInputs.delete(input);
      rejectInput(input, reason);
    }
  };

  const dispatchInput = (input: InputRequest, epoch: number): void => {
    inFlightInputs.add(input);
    traceStage(input.performanceTraceId, "transport-send-start");
    let pending: Promise<TerminalFastLaneMutationResult>;
    try {
      pending = options.control.write(
        paneAddress(generationAddress, input.semanticPaneId),
        input.input,
        input.performanceTraceId,
        input.causalProbe,
      );
    } catch (error) {
      inFlightInputs.delete(input);
      settleInput(input, { status: "failed", error });
      queueMicrotask(drainInput);
      return;
    }
    void pending
      .then((outcome) => {
        inFlightInputs.delete(input);
        if (input.settled || disposed || epoch !== generationEpoch) return;
        if (outcome === "authority-lost") {
          rejectInput(input, "authority-lost");
          retireInputEpoch(epoch, "authority-lost");
          return;
        }
        mutableCounters.inputWrites += 1;
        settleInput(input, { status: "sent" });
        // The ACK stage is also the authoritative bounded-queue observation.
        // Settle accounting first so the final acknowledgement cannot retain
        // the just-accepted input's bytes in an otherwise empty lane.
        traceStage(input.performanceTraceId, "transport-ack");
      })
      .catch((error) => {
        inFlightInputs.delete(input);
        if (!input.settled) settleInput(input, { status: "failed", error });
      })
      .finally(() => queueMicrotask(drainInput));
  };

  function drainInput(): void {
    if (disposed || inputQueue.length === 0) return;
    const epoch = generationEpoch;
    if (inFlightInputs.size >= maxInFlightInputs) return;
    if (options.control.owns("input", generationAddress.generation)) {
      while (
        !disposed &&
        epoch === generationEpoch &&
        inputQueue.length > 0 &&
        inFlightInputs.size < maxInFlightInputs
      ) {
        const input = inputQueue.shift()!;
        if (input.generationEpoch !== epoch) {
          rejectInput(input, "retired");
          continue;
        }
        dispatchInput(input, epoch);
      }
      return;
    }
    if (inputDrainEpoch !== null) return;
    inputDrainEpoch = epoch;
    void requestAuthority("input", epoch)
      .then((granted) => {
        if (!disposed && epoch === generationEpoch && !granted)
          retireInputEpoch(epoch, "authority-denied");
      })
      .finally(() => {
        if (inputDrainEpoch === epoch) inputDrainEpoch = null;
        if (!disposed && epoch === generationEpoch && inputQueue.length > 0)
          queueMicrotask(drainInput);
      });
  }

  const settleResize = (key: string, outcome: TerminalFastLaneResizeOutcome): void => {
    const waiters = resizeWaiters.get(key) ?? [];
    resizeWaiters.delete(key);
    for (const waiter of waiters) waiter(outcome);
  };

  const retireWork = (reason: "disposed" | "retired"): void => {
    for (const input of inputQueue.splice(0)) rejectInput(input, reason);
    for (const input of [...inFlightInputs]) rejectInput(input, reason);
    inFlightInputs.clear();
    inputBytes = 0;
    // A retired grant/write may never settle. The replacement generation must
    // be able to begin its independent FIFO immediately.
    inputDrainEpoch = null;
    for (const key of [...resizeWaiters.keys()]) settleResize(key, { status: reason });
    resizeCoordinator.retire();
    authorityRequests.clear();
  };

  return {
    address: () => generationAddress,
    replaceGeneration(address) {
      if (disposed) return;
      generationEpoch += 1;
      generationAddress = Object.freeze({ ...address });
      retireWork("retired");
      for (const interest of panes.values()) {
        interest.release?.();
        interest.release = null;
        interest.state = null;
        interest.lastAcceptedUpdateType = null;
        interest.repairPending = false;
        open(interest);
      }
    },
    retainPanes(semanticPaneIds) {
      if (disposed) return;
      const next = new Set(semanticPaneIds);
      retainedPaneIds = next;
      for (const semanticPaneId of panes.keys()) {
        if (next.has(semanticPaneId)) continue;
        trimUnownedPane(semanticPaneId);
      }
      for (const semanticPaneId of next) retainInterest(semanticPaneId);
    },
    stagePanes(semanticPaneIds) {
      if (disposed) return () => undefined;
      const staged = new Set(semanticPaneIds);
      for (const semanticPaneId of staged) {
        stagedPaneCounts.set(semanticPaneId, (stagedPaneCounts.get(semanticPaneId) ?? 0) + 1);
        retainInterest(semanticPaneId);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        for (const semanticPaneId of staged) {
          const nextCount = (stagedPaneCounts.get(semanticPaneId) ?? 1) - 1;
          if (nextCount > 0) stagedPaneCounts.set(semanticPaneId, nextCount);
          else stagedPaneCounts.delete(semanticPaneId);
          trimUnownedPane(semanticPaneId);
        }
      };
    },
    subscribePane(semanticPaneId, listener) {
      if (disposed) return () => undefined;
      if (retainedPaneIds !== null && !retainedPaneIds.has(semanticPaneId)) return () => undefined;
      const interest =
        panes.get(semanticPaneId) ??
        ({
          semanticPaneId,
          listeners: new Set(),
          state: null,
          lastAcceptedUpdateType: null,
          repairPending: false,
          release: null,
        } satisfies PaneInterest);
      panes.set(semanticPaneId, interest);
      interest.listeners.add(listener);
      open(interest);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        interest.listeners.delete(listener);
        // Renderer visibility is not terminal-replica lifetime. A pane surface
        // unmounts when its tmux window is not selected, but output can keep
        // arriving while hidden. Retain the one canonical pane replica and its
        // source subscription until this generation is replaced or the lane is
        // disposed, so switching back never resumes from a patch without its
        // seed. The lane itself is generation-scoped and its pane interests are
        // bounded by the runtime inventory.
      };
    },
    paneState: (semanticPaneId) => panes.get(semanticPaneId)?.state ?? null,
    paneLastAcceptedUpdateType: (semanticPaneId) =>
      panes.get(semanticPaneId)?.lastAcceptedUpdateType ?? null,
    sendInput(semanticPaneId, rawInput, performanceTraceId, causalProbe) {
      if (disposed) return Promise.resolve({ status: "rejected", reason: "disposed" });
      const parsed = SessionRuntimeTerminalInputSchemaZ.safeParse(rawInput);
      if (!parsed.success) {
        mutableCounters.inputRejected += 1;
        return Promise.resolve({ status: "failed", error: parsed.error });
      }
      const input = Object.freeze({ ...parsed.data });
      const byteLength = utf8.encode(input.data).byteLength;
      if (
        inputQueue.length + inFlightInputs.size >= maxPendingInputs ||
        inputBytes + byteLength > maxPendingInputBytes
      ) {
        mutableCounters.inputRejected += 1;
        return Promise.resolve({ status: "rejected", reason: "queue-full" });
      }
      mutableCounters.inputAccepted += 1;
      traceStage(performanceTraceId, "lane-enqueue");
      return new Promise((resolve) => {
        inputQueue.push({
          generationEpoch,
          semanticPaneId,
          input,
          ...(performanceTraceId ? { performanceTraceId } : {}),
          ...(causalProbe ? { causalProbe } : {}),
          byteLength,
          resolve,
          settled: false,
        });
        inputBytes += byteLength;
        drainInput();
      });
    },
    resize(viewport) {
      if (disposed) return Promise.resolve({ status: "disposed" });
      if (!validViewport(viewport)) {
        return Promise.resolve({ status: "failed", error: new TypeError("invalid viewport") });
      }
      const retained = Object.freeze({ ...viewport });
      const key = `${retained.cols}x${retained.rows}`;
      const epoch = generationEpoch;
      mutableCounters.resizeAccepted += 1;
      return new Promise((resolve) => {
        const waiters = resizeWaiters.get(key) ?? [];
        waiters.push(resolve);
        resizeWaiters.set(key, waiters);
        resizeCoordinator.request({
          key,
          execute: async () => {
            const granted = await requestAuthority("geometry", epoch);
            if (!granted || disposed || epoch !== generationEpoch)
              throw new Error("geometry authority unavailable");
            mutableCounters.resizeTransports += 1;
            const result = await options.control.resize(generationAddress, retained);
            if (result !== "ok") throw new Error("geometry authority lost");
          },
          onSuccess: () => settleResize(key, { status: "applied" }),
          onFailure: (error) =>
            settleResize(
              key,
              disposed || epoch !== generationEpoch
                ? { status: disposed ? "disposed" : "retired" }
                : { status: "failed", error },
            ),
          onSuperseded: () => {
            mutableCounters.resizeSuperseded += 1;
            settleResize(key, { status: "superseded" });
          },
        });
      });
    },
    counters: () =>
      Object.freeze({
        ...mutableCounters,
        inputPending: inputQueue.length,
        inputInFlight: inFlightInputs.size,
        inputPendingBytes: inputBytes,
      }),
    dispose() {
      if (disposed) return;
      disposed = true;
      generationEpoch += 1;
      retireWork("disposed");
      for (const interest of panes.values()) interest.release?.();
      panes.clear();
      stagedPaneCounts.clear();
    },
  };
}

/** Thin source adapter; WorkspaceClient remains the only runtime subscription owner. */
export function createWorkspaceClientTerminalSource(
  client: CanonicalTerminalSubscriptionPort,
): TerminalFastLaneSourcePort {
  return {
    subscribe(address, listener) {
      return client.subscribeTerminal(
        {
          workspaceName: address.workspaceName,
          semanticPaneId: address.semanticPaneId,
        },
        listener,
      );
    },
  };
}
