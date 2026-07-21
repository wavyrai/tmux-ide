import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ApplicationShellProjectionInputV1 } from "@tmux-ide/contracts";
import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
} from "@tmux-ide/contracts";

import {
  daemonGenerationKey,
  type DesktopApplicationShellResourceState,
  type DesktopApplicationShellTarget,
} from "./connection-state.ts";
import {
  DaemonTransportError,
  type DaemonEventConnection,
  type DesktopDaemonTransport,
} from "./daemon-transport.ts";

export interface DesktopResourceClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DesktopReconnectPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
  /** Symmetric fraction around the exponential delay, from 0 through 1. */
  readonly jitterRatio: number;
  /** A verified connection must survive this long before the retry budget resets. */
  readonly stabilityWindowMs: number;
}

export interface DesktopApplicationShellStoreOptions {
  readonly target: unknown;
  readonly transport: DesktopDaemonTransport;
  readonly clock?: DesktopResourceClock;
  readonly random?: () => number;
  readonly reconnect?: Partial<DesktopReconnectPolicy>;
}

export type DesktopResourceStateListener = (state: DesktopApplicationShellResourceState) => void;

export interface DesktopApplicationShellResourceStore {
  getState(): DesktopApplicationShellResourceState;
  subscribe(listener: DesktopResourceStateListener): () => void;
  setTarget(target: unknown): void;
  refresh(): void;
  dispose(): void;
}

export interface SolidDesktopApplicationShellResourceStore {
  readonly state: Accessor<DesktopApplicationShellResourceState>;
  setTarget(target: unknown): void;
  refresh(): void;
  dispose(): void;
}

const DEFAULT_RECONNECT: DesktopReconnectPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 8_000,
  maximumAttempts: 6,
  jitterRatio: 0.2,
  stabilityWindowMs: 10_000,
};

const RECONNECT_LIMITS = {
  delayMinMs: 10,
  delayMaxMs: 300_000,
  attemptsMin: 1,
  attemptsMax: 20,
  stabilityMinMs: 100,
  stabilityMaxMs: 300_000,
} as const;

const defaultClock: DesktopResourceClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function dataFromState(
  state: DesktopApplicationShellResourceState,
): ApplicationShellProjectionInputV1 | null {
  return "data" in state ? state.data : null;
}

function updatedAtFromState(state: DesktopApplicationShellResourceState): number | null {
  return "updatedAt" in state ? state.updatedAt : null;
}

function boundedReconnectDelay(
  attempt: number,
  policy: DesktopReconnectPolicy,
  random: () => number,
): number {
  const exponential = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * 2 ** Math.max(0, attempt),
  );
  let rawSample = 0.5;
  try {
    rawSample = random();
  } catch {
    // A test/host-provided entropy source cannot break reconnect accounting.
  }
  const sample = Number.isFinite(rawSample) ? Math.max(0, Math.min(1, rawSample)) : 0.5;
  const jitter = 1 - policy.jitterRatio + sample * policy.jitterRatio * 2;
  return Math.min(policy.maximumDelayMs, Math.max(0, Math.round(exponential * jitter)));
}

function finiteClamped(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedReconnectPolicy(
  overrides: Partial<DesktopReconnectPolicy> | undefined,
): DesktopReconnectPolicy {
  const initialDelayMs = Math.round(
    finiteClamped(
      overrides?.initialDelayMs,
      DEFAULT_RECONNECT.initialDelayMs,
      RECONNECT_LIMITS.delayMinMs,
      RECONNECT_LIMITS.delayMaxMs,
    ),
  );
  const maximumDelayMs = Math.max(
    initialDelayMs,
    Math.round(
      finiteClamped(
        overrides?.maximumDelayMs,
        DEFAULT_RECONNECT.maximumDelayMs,
        RECONNECT_LIMITS.delayMinMs,
        RECONNECT_LIMITS.delayMaxMs,
      ),
    ),
  );
  return {
    initialDelayMs,
    maximumDelayMs,
    maximumAttempts: Math.trunc(
      finiteClamped(
        overrides?.maximumAttempts,
        DEFAULT_RECONNECT.maximumAttempts,
        RECONNECT_LIMITS.attemptsMin,
        RECONNECT_LIMITS.attemptsMax,
      ),
    ),
    jitterRatio: finiteClamped(overrides?.jitterRatio, DEFAULT_RECONNECT.jitterRatio, 0, 1),
    stabilityWindowMs: Math.round(
      finiteClamped(
        overrides?.stabilityWindowMs,
        DEFAULT_RECONNECT.stabilityWindowMs,
        RECONNECT_LIMITS.stabilityMinMs,
        RECONNECT_LIMITS.stabilityMaxMs,
      ),
    ),
  };
}

function validateStoreTarget(value: unknown): DesktopApplicationShellTarget {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success) {
    throw new DaemonTransportError(
      "descriptor-invalid",
      `Daemon application-shell target is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.daemon.protocolVersion)) {
    throw new DaemonTransportError(
      "descriptor-invalid",
      `Daemon protocol ${parsed.data.daemon.protocolVersion} is not compatible with this renderer.`,
    );
  }
  return parsed.data;
}

export function createDesktopApplicationShellResourceStore(
  options: DesktopApplicationShellStoreOptions,
): DesktopApplicationShellResourceStore {
  const transport = options.transport;
  const clock = options.clock ?? defaultClock;
  const random = options.random ?? Math.random;
  const reconnect = normalizedReconnectPolicy(options.reconnect);
  const listeners = new Set<DesktopResourceStateListener>();

  let disposed = false;
  let generation = 0;
  let target: DesktopApplicationShellTarget | null = null;
  let targetKey = "";
  let state: DesktopApplicationShellResourceState = {
    status: "loading",
    generation,
    target: null,
    data: null,
  };
  let requestId = 0;
  let requestController: AbortController | null = null;
  let connection: DaemonEventConnection | null = null;
  let connectionId = 0;
  let eventConnected = false;
  let reconnectAttempts = 0;
  let reconnectTimer: unknown | null = null;
  let stabilityTimer: unknown | null = null;
  let targetIsValid = false;

  const emit = (next: DesktopApplicationShellResourceState): void => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener(next);
  };

  const current = (expectedGeneration: number, expectedKey: string): boolean =>
    !disposed && generation === expectedGeneration && targetKey === expectedKey;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer === null) return;
    clock.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const clearStabilityTimer = (): void => {
    if (stabilityTimer === null) return;
    clock.clearTimeout(stabilityTimer);
    stabilityTimer = null;
  };

  const retireConnection = (): void => {
    connectionId += 1;
    eventConnected = false;
    clearStabilityTimer();
    const active = connection;
    connection = null;
    active?.close();
  };

  const abortRequest = (): void => {
    requestId += 1;
    requestController?.abort();
    requestController = null;
  };

  const emitDisconnected = (reason: string, exhausted = false): void => {
    const data = dataFromState(state);
    const updatedAt = updatedAtFromState(state);
    if (data && updatedAt !== null) {
      emit({ status: "stale", generation, target, data, updatedAt, reason });
      return;
    }
    emit({
      status: "unavailable",
      generation,
      target,
      data: null,
      code: exhausted ? "reconnect-exhausted" : "disconnected",
      reason,
    });
  };

  const emitTransportError = (error: unknown): void => {
    const data = dataFromState(state);
    if (error instanceof DaemonTransportError) {
      if (error.kind === "descriptor-invalid") {
        emit({
          status: "degraded",
          generation,
          target,
          data,
          updatedAt: updatedAtFromState(state),
          code: "descriptor-invalid",
          reason: error.message,
        });
        return;
      }
      if (error.kind === "daemon-identity-mismatch") {
        emit({
          status: "degraded",
          generation,
          target,
          data,
          updatedAt: updatedAtFromState(state),
          code: "daemon-identity-mismatch",
          reason: error.message,
        });
        return;
      }
      if (error.kind === "schema-invalid") {
        emit({
          status: "degraded",
          generation,
          target,
          data,
          updatedAt: updatedAtFromState(state),
          code: "schema-invalid",
          reason: error.message,
        });
        return;
      }
      if (error.kind === "not-found") {
        emit({
          status: "unavailable",
          generation,
          target,
          data: null,
          code: "not-found",
          reason: error.message,
        });
        return;
      }
      const updatedAt = updatedAtFromState(state);
      if (data && updatedAt !== null) {
        emit({ status: "stale", generation, target, data, updatedAt, reason: error.message });
      } else {
        emit({
          status: "error",
          generation,
          target,
          data: null,
          code: error.kind === "network-error" ? "network-error" : "http-error",
          reason: error.message,
        });
      }
      return;
    }
    const reason =
      error instanceof Error ? error.message : "Daemon application-shell request failed.";
    const updatedAt = updatedAtFromState(state);
    if (data && updatedAt !== null) {
      emit({ status: "stale", generation, target, data, updatedAt, reason });
    } else {
      emit({
        status: "error",
        generation,
        target,
        data: null,
        code: "network-error",
        reason,
      });
    }
  };

  const fetchResource = (expectedGeneration: number, expectedKey: string): void => {
    if (!current(expectedGeneration, expectedKey) || !targetIsValid || target === null) return;
    const requestTarget = target;
    abortRequest();
    const activeRequestId = requestId;
    const controller = new AbortController();
    requestController = controller;
    void transport
      .fetchApplicationShell(requestTarget, controller.signal)
      .then((data) => {
        if (
          controller.signal.aborted ||
          activeRequestId !== requestId ||
          !current(expectedGeneration, expectedKey) ||
          !targetIsValid
        ) {
          return;
        }
        requestController = null;
        const updatedAt = clock.now();
        emit(
          eventConnected
            ? { status: "live", generation, target, data, updatedAt }
            : {
                status: "stale",
                generation,
                target,
                data,
                updatedAt,
                reason: "Daemon event socket is not connected.",
              },
        );
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          activeRequestId !== requestId ||
          !current(expectedGeneration, expectedKey)
        ) {
          return;
        }
        requestController = null;
        if (error instanceof DaemonTransportError && error.kind === "daemon-identity-mismatch") {
          targetIsValid = false;
          retireConnection();
        }
        emitTransportError(error);
      });
  };

  const scheduleReconnect = (expectedGeneration: number, expectedKey: string): void => {
    if (!current(expectedGeneration, expectedKey) || reconnectTimer !== null || !targetIsValid) {
      return;
    }
    if (reconnectAttempts >= reconnect.maximumAttempts) {
      emitDisconnected("Daemon event reconnection attempts were exhausted.", true);
      return;
    }
    const attempt = reconnectAttempts;
    reconnectAttempts += 1;
    const delay = boundedReconnectDelay(attempt, reconnect, random);
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      connectEvents(expectedGeneration, expectedKey);
    }, delay);
  };

  const handleConnectionLoss = (
    expectedConnectionId: number,
    expectedGeneration: number,
    expectedKey: string,
    reason: string,
  ): void => {
    if (expectedConnectionId !== connectionId || !current(expectedGeneration, expectedKey)) {
      return;
    }
    abortRequest();
    retireConnection();
    emitDisconnected(reason);
    scheduleReconnect(expectedGeneration, expectedKey);
  };

  function connectEvents(expectedGeneration: number, expectedKey: string): void {
    if (
      !current(expectedGeneration, expectedKey) ||
      !targetIsValid ||
      target === null ||
      connection !== null
    )
      return;
    const connectionTarget = target;
    const activeConnectionId = connectionId;
    const wasReconnect = reconnectAttempts > 0;
    try {
      connection = transport.connectEvents(connectionTarget, {
        onVerifiedOpen: () => {
          if (activeConnectionId !== connectionId || !current(expectedGeneration, expectedKey)) {
            return;
          }
          eventConnected = true;
          clearStabilityTimer();
          if (reconnectAttempts > 0) {
            stabilityTimer = clock.setTimeout(() => {
              stabilityTimer = null;
              if (
                activeConnectionId === connectionId &&
                eventConnected &&
                current(expectedGeneration, expectedKey)
              ) {
                reconnectAttempts = 0;
              }
            }, reconnect.stabilityWindowMs);
          }
          if (wasReconnect) {
            fetchResource(expectedGeneration, expectedKey);
          } else if (state.status === "stale") {
            emit({
              status: "live",
              generation,
              target,
              data: state.data,
              updatedAt: state.updatedAt,
            });
          }
        },
        onInvalidate: () => {
          if (activeConnectionId !== connectionId || !current(expectedGeneration, expectedKey)) {
            return;
          }
          fetchResource(expectedGeneration, expectedKey);
        },
        onProtocolError: (reason) => {
          if (activeConnectionId !== connectionId || !current(expectedGeneration, expectedKey)) {
            return;
          }
          const data = dataFromState(state);
          emit({
            status: "degraded",
            generation,
            target,
            data,
            updatedAt: updatedAtFromState(state),
            code: "event-frame-invalid",
            reason: `Daemon rejected the event subscription: ${reason}`,
          });
          abortRequest();
          retireConnection();
          scheduleReconnect(expectedGeneration, expectedKey);
        },
        onPeerMismatch: (reason) => {
          if (activeConnectionId !== connectionId || !current(expectedGeneration, expectedKey)) {
            return;
          }
          targetIsValid = false;
          abortRequest();
          const data = dataFromState(state);
          emit({
            status: "degraded",
            generation,
            target,
            data,
            updatedAt: updatedAtFromState(state),
            code: "daemon-identity-mismatch",
            reason,
          });
          retireConnection();
        },
        onMalformedFrame: (reason) => {
          if (activeConnectionId !== connectionId || !current(expectedGeneration, expectedKey)) {
            return;
          }
          const data = dataFromState(state);
          emit({
            status: "degraded",
            generation,
            target,
            data,
            updatedAt: updatedAtFromState(state),
            code: "event-frame-invalid",
            reason,
          });
          abortRequest();
          retireConnection();
          scheduleReconnect(expectedGeneration, expectedKey);
        },
        onClose: () =>
          handleConnectionLoss(
            activeConnectionId,
            expectedGeneration,
            expectedKey,
            "Daemon event socket disconnected.",
          ),
        onError: (reason) =>
          handleConnectionLoss(activeConnectionId, expectedGeneration, expectedKey, reason),
      });
    } catch (error) {
      if (!current(expectedGeneration, expectedKey)) return;
      if (
        error instanceof DaemonTransportError &&
        (error.kind === "descriptor-invalid" || error.kind === "daemon-identity-mismatch")
      ) {
        targetIsValid = false;
        emitTransportError(error);
        return;
      }
      emitDisconnected(
        error instanceof Error ? error.message : "Daemon event socket could not be opened.",
      );
      scheduleReconnect(expectedGeneration, expectedKey);
    }
  }

  const startTarget = (untrustedTarget: unknown): void => {
    let nextTarget: DesktopApplicationShellTarget;
    try {
      nextTarget = validateStoreTarget(
        transport.validateTarget(validateStoreTarget(untrustedTarget)),
      );
    } catch (error) {
      clearReconnectTimer();
      abortRequest();
      retireConnection();
      generation += 1;
      target = null;
      targetKey = `invalid:${generation}`;
      reconnectAttempts = 0;
      targetIsValid = false;
      emit({ status: "loading", generation, target: null, data: null });
      emitTransportError(error);
      return;
    }
    const nextKey = daemonGenerationKey(nextTarget);
    if (target !== null && nextKey === targetKey) return;
    clearReconnectTimer();
    abortRequest();
    retireConnection();
    generation += 1;
    target = nextTarget;
    targetKey = nextKey;
    reconnectAttempts = 0;
    targetIsValid = true;
    emit({ status: "loading", generation, target, data: null });
    fetchResource(generation, targetKey);
    connectEvents(generation, targetKey);
  };

  const store: DesktopApplicationShellResourceStore = {
    getState: () => state,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    setTarget(nextTarget) {
      if (disposed) return;
      startTarget(nextTarget);
    },
    refresh() {
      if (disposed || !targetIsValid) return;
      fetchResource(generation, targetKey);
    },
    dispose() {
      if (disposed) return;
      clearReconnectTimer();
      clearStabilityTimer();
      abortRequest();
      retireConnection();
      disposed = true;
      listeners.clear();
    },
  };

  startTarget(options.target);
  return store;
}

/** Solid lifecycle adapter; the underlying store remains framework-independent. */
export function createSolidDesktopApplicationShellResourceStore(
  options: DesktopApplicationShellStoreOptions,
): SolidDesktopApplicationShellResourceStore {
  const store = createDesktopApplicationShellResourceStore(options);
  const [state, setState] = createSignal(store.getState(), { equals: false });
  const unsubscribe = store.subscribe(setState);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    store.dispose();
  };
  onCleanup(dispose);
  return {
    state,
    setTarget: (target) => store.setTarget(target),
    refresh: () => store.refresh(),
    dispose,
  };
}
