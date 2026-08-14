import type {
  CanonicalTerminalReplicaUpdate,
  SessionRuntimeAuthorityKind,
  TerminalReplicaAddress,
} from "@tmux-ide/contracts";
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
    listener: (update: CanonicalTerminalReplicaUpdate) => void,
  ): () => void;
}

/** A transport-ingress-validated canonical subscription, never an unknown replica cast. */
export interface CanonicalTerminalSubscriptionPort {
  readonly subscribeTerminal: (
    target: TerminalReplicaAddress,
    listener: (update: CanonicalTerminalReplicaUpdate) => void,
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
    bytes: Uint8Array,
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
}

export interface TerminalFastLane {
  address(): TerminalFastLaneGenerationAddress;
  replaceGeneration(address: TerminalFastLaneGenerationAddress): void;
  subscribePane(
    semanticPaneId: string,
    listener: (publication: TerminalFastLanePublication) => void,
  ): () => void;
  paneState(semanticPaneId: string): TerminalReplicaState | null;
  sendInput(semanticPaneId: string, bytes: Uint8Array): Promise<TerminalFastLaneInputOutcome>;
  resize(viewport: TerminalFastLaneViewport): Promise<TerminalFastLaneResizeOutcome>;
  counters(): TerminalFastLaneCounters;
  dispose(): void;
}

interface PaneInterest {
  readonly semanticPaneId: string;
  readonly listeners: Set<(publication: TerminalFastLanePublication) => void>;
  state: TerminalReplicaState | null;
  repairPending: boolean;
  release: (() => void) | null;
}

interface InputRequest {
  readonly generationEpoch: number;
  readonly semanticPaneId: string;
  readonly bytes: Uint8Array;
  readonly resolve: (outcome: TerminalFastLaneInputOutcome) => void;
}

const DEFAULT_MAX_PENDING_INPUTS = 256;
const DEFAULT_MAX_PENDING_INPUT_BYTES = 256 * 1024;

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
  if (!Number.isInteger(maxPendingInputs) || maxPendingInputs < 1)
    throw new TypeError("maxPendingInputs must be a positive integer");
  if (!Number.isInteger(maxPendingInputBytes) || maxPendingInputBytes < 1)
    throw new TypeError("maxPendingInputBytes must be a positive integer");

  const panes = new Map<string, PaneInterest>();
  const inputQueue: InputRequest[] = [];
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
    mutableCounters.inputRejected += 1;
    input.resolve({ status: "rejected", reason });
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

  const accept = (interest: PaneInterest, update: CanonicalTerminalReplicaUpdate): void => {
    if (disposed) return;
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
    const result = applyTerminalReplicaUpdate(interest.state, update);
    if (result.status === "idempotent" || result.status === "stale") {
      mutableCounters.duplicateOrStale += 1;
      return;
    }
    if (result.status === "gap" || result.status === "conflict") {
      mutableCounters.rejected += 1;
      requestRepair(interest, result.status, result, update.revision);
      return;
    }
    if (result.status !== "applied") return;
    interest.state = result.state;
    if (update.type === "terminal.seed") interest.repairPending = false;
    mutableCounters.published += 1;
    const publication = Object.freeze({ address: expected, state: result.state, update });
    for (const listener of [...interest.listeners]) {
      try {
        listener(publication);
      } catch {
        // One pane observer cannot interrupt sibling observers or protocol ACKs.
      }
    }
  };

  const open = (interest: PaneInterest): void => {
    if (disposed || interest.release || interest.listeners.size === 0) return;
    const epoch = generationEpoch;
    interest.release = options.source.subscribe(
      paneAddress(generationAddress, interest.semanticPaneId),
      (update) => {
        if (!disposed && epoch === generationEpoch) accept(interest, update);
      },
    );
  };

  const drainInput = (): void => {
    if (disposed || inputDrainEpoch !== null || inputQueue.length === 0) return;
    const epoch = generationEpoch;
    inputDrainEpoch = epoch;
    void requestAuthority("input", epoch).then(async (granted) => {
      try {
        if (disposed || epoch !== generationEpoch) return;
        if (!granted) {
          while (inputQueue[0]?.generationEpoch === epoch) {
            const input = inputQueue.shift()!;
            inputBytes -= input.bytes.byteLength;
            rejectInput(input, "authority-denied");
          }
          return;
        }
        while (!disposed && epoch === generationEpoch && inputQueue.length > 0) {
          const input = inputQueue[0]!;
          if (input.generationEpoch !== epoch) {
            inputQueue.shift();
            inputBytes -= input.bytes.byteLength;
            rejectInput(input, "retired");
            continue;
          }
          if (!options.control.owns("input", generationAddress.generation)) {
            while (inputQueue[0]?.generationEpoch === epoch) {
              const retired = inputQueue.shift()!;
              inputBytes -= retired.bytes.byteLength;
              rejectInput(retired, "authority-lost");
            }
            break;
          }
          let outcome: TerminalFastLaneMutationResult;
          try {
            outcome = await options.control.write(
              paneAddress(generationAddress, input.semanticPaneId),
              input.bytes,
            );
          } catch (error) {
            inputQueue.shift();
            inputBytes -= input.bytes.byteLength;
            input.resolve({ status: "failed", error });
            continue;
          }
          if (disposed || epoch !== generationEpoch) return;
          if (outcome === "authority-lost") {
            while (inputQueue[0]?.generationEpoch === epoch) {
              const retired = inputQueue.shift()!;
              inputBytes -= retired.bytes.byteLength;
              rejectInput(retired, "authority-lost");
            }
            break;
          }
          inputQueue.shift();
          inputBytes -= input.bytes.byteLength;
          mutableCounters.inputWrites += 1;
          input.resolve({ status: "sent" });
        }
      } finally {
        if (inputDrainEpoch === epoch) inputDrainEpoch = null;
        if (
          !disposed &&
          epoch === generationEpoch &&
          inputDrainEpoch === null &&
          inputQueue.length > 0
        ) {
          queueMicrotask(drainInput);
        }
      }
    });
  };

  const settleResize = (key: string, outcome: TerminalFastLaneResizeOutcome): void => {
    const waiters = resizeWaiters.get(key) ?? [];
    resizeWaiters.delete(key);
    for (const waiter of waiters) waiter(outcome);
  };

  const retireWork = (reason: "disposed" | "retired"): void => {
    for (const input of inputQueue.splice(0)) rejectInput(input, reason);
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
        interest.repairPending = false;
        open(interest);
      }
    },
    subscribePane(semanticPaneId, listener) {
      if (disposed) return () => undefined;
      const interest =
        panes.get(semanticPaneId) ??
        ({
          semanticPaneId,
          listeners: new Set(),
          state: null,
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
        if (interest.listeners.size > 0) return;
        interest.release?.();
        panes.delete(semanticPaneId);
      };
    },
    paneState: (semanticPaneId) => panes.get(semanticPaneId)?.state ?? null,
    sendInput(semanticPaneId, bytes) {
      if (disposed) return Promise.resolve({ status: "rejected", reason: "disposed" });
      if (
        bytes.byteLength === 0 ||
        inputQueue.length >= maxPendingInputs ||
        inputBytes + bytes.byteLength > maxPendingInputBytes
      ) {
        mutableCounters.inputRejected += 1;
        return Promise.resolve({ status: "rejected", reason: "queue-full" });
      }
      const retained = Uint8Array.from(bytes);
      mutableCounters.inputAccepted += 1;
      return new Promise((resolve) => {
        inputQueue.push({
          generationEpoch,
          semanticPaneId,
          bytes: retained,
          resolve,
        });
        inputBytes += retained.byteLength;
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
    counters: () => Object.freeze({ ...mutableCounters }),
    dispose() {
      if (disposed) return;
      disposed = true;
      generationEpoch += 1;
      retireWork("disposed");
      for (const interest of panes.values()) interest.release?.();
      panes.clear();
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
