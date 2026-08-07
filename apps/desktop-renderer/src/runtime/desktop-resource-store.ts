import { createSignal, onCleanup, type Accessor } from "solid-js";
import type { ApplicationShellProjectionInputV1 } from "@tmux-ide/contracts";
import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
} from "@tmux-ide/contracts";

import { transportStateReason } from "./connection-health.ts";
import {
  daemonGenerationKey,
  type DesktopApplicationShellResourceState,
  type DesktopApplicationShellTarget,
} from "./connection-state.ts";
import { DaemonTransportError, type DesktopDaemonTransport } from "./daemon-transport.ts";
import {
  createGenerationBoundStore,
  type GenerationBoundAdapter,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
  type GenerationBoundView,
} from "./generation-bound-store.ts";

/**
 * Generation-bound renderer store for the application-shell projection.
 *
 * Same policy as the two catalog stores — it runs on the shared engine in
 * {@link ./generation-bound-store.ts} — but shaped around a
 * {@link DesktopDaemonTransport} instead of the host capability facade. What is
 * unique here is the failure vocabulary: transport error KINDS rather than
 * capability error codes, and a `unavailable`/`degraded` split that names
 * whether the resource is missing or the generation is suspect.
 *
 * Its retry ladder keeps the jitter and stability window the other two do not
 * need: this store is the one that reconnects a socket it opened itself, so a
 * flapping daemon must not burn the budget and repeated attempts must not
 * align with the supervisor's own ladder.
 */

export type DesktopResourceClock = GenerationBoundClock;

export type DesktopReconnectPolicy = GenerationBoundRetryPolicy;

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

/**
 * The transport error kinds, plus the two faults that have no thrown error:
 * a dropped socket and a rejected or malformed event frame.
 */
type ShellFailureKind =
  | "descriptor-invalid"
  | "daemon-identity-mismatch"
  | "not-found"
  | "network-error"
  | "http-error"
  | "schema-invalid"
  | "event-frame-invalid"
  | "disconnected";

interface ShellFailure {
  readonly kind: ShellFailureKind;
  readonly reason: string;
}

type ShellView = GenerationBoundView<
  DesktopApplicationShellTarget,
  ApplicationShellProjectionInputV1,
  ShellFailure
>;

function shellFailure(error: unknown, fallbackReason: string): ShellFailure {
  if (error instanceof DaemonTransportError) {
    return { kind: error.kind, reason: error.message };
  }
  return {
    kind: "network-error",
    reason: error instanceof Error ? error.message : fallbackReason,
  };
}

function validateShellTarget(value: unknown): DesktopApplicationShellTarget {
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

function projectShell(view: ShellView): DesktopApplicationShellResourceState {
  const { generation, target, phase, transport } = view;
  if (view.disposed) {
    return { status: "disposed", generation, target: null, data: null, transport: null };
  }
  const data = view.snapshot?.resource ?? null;
  const updatedAt = view.snapshot?.updatedAt ?? null;
  if (phase.kind === "loading") {
    return { status: "loading", generation, target, data: null, transport };
  }
  if (phase.kind === "live" && data !== null && updatedAt !== null) {
    return { status: "live", generation, target, data, updatedAt, transport };
  }
  if (phase.kind === "stale" && data !== null && updatedAt !== null) {
    return {
      status: "stale",
      generation,
      target,
      data,
      updatedAt,
      reason: "Daemon event socket is not connected.",
      transport,
    };
  }
  if (phase.kind !== "failed") {
    return { status: "loading", generation, target, data: null, transport };
  }
  const { failure, exhausted } = phase;
  if (
    failure.kind === "descriptor-invalid" ||
    failure.kind === "daemon-identity-mismatch" ||
    failure.kind === "schema-invalid" ||
    failure.kind === "event-frame-invalid"
  ) {
    return {
      status: "degraded",
      generation,
      target,
      data,
      updatedAt,
      code: failure.kind,
      reason: failure.reason,
      transport,
    };
  }
  if (failure.kind === "not-found") {
    return {
      status: "unavailable",
      generation,
      target,
      data: null,
      code: "not-found",
      reason: failure.reason,
      transport,
    };
  }
  if (data !== null && updatedAt !== null) {
    return {
      status: "stale",
      generation,
      target,
      data,
      updatedAt,
      reason: failure.reason,
      transport,
    };
  }
  if (failure.kind === "disconnected") {
    return {
      status: "unavailable",
      generation,
      target,
      data: null,
      code: exhausted ? "reconnect-exhausted" : "disconnected",
      reason: failure.reason,
      transport,
    };
  }
  return {
    status: "error",
    generation,
    target,
    data: null,
    code: failure.kind === "network-error" ? "network-error" : "http-error",
    reason: failure.reason,
    transport,
  };
}

export function createDesktopApplicationShellResourceStore(
  options: DesktopApplicationShellStoreOptions,
): DesktopApplicationShellResourceStore {
  const transport = options.transport;
  const adapter: GenerationBoundAdapter<
    DesktopApplicationShellTarget,
    ApplicationShellProjectionInputV1,
    ShellFailure,
    DesktopApplicationShellResourceState
  > = {
    // The target arrives from render props, where an equal-but-new object
    // carries no news; `refresh()` is the refetch path.
    reassert: "ignore",
    validateTarget(value) {
      try {
        const target = validateShellTarget(transport.validateTarget(validateShellTarget(value)));
        return { ok: true, target, key: daemonGenerationKey(target) };
      } catch (error) {
        return {
          ok: false,
          failure: shellFailure(error, "Daemon application-shell target is invalid."),
        };
      }
    },
    async fetch(target, signal) {
      try {
        const resource = await transport.fetchApplicationShell(target, signal);
        return { status: "ok", resource };
      } catch (error) {
        return {
          status: "failed",
          failure: shellFailure(error, "Daemon application-shell request failed."),
        };
      }
    },
    connect(target, handlers) {
      try {
        const connection = transport.connectEvents(target, {
          onTransportStateChanged: (state) => handlers.transportChanged(state),
          onVerifiedOpen: () => handlers.live(),
          onInvalidate: () => handlers.invalidate(),
          onProtocolError: (reason) =>
            handlers.failed({
              kind: "event-frame-invalid",
              reason: `Daemon rejected the event subscription: ${reason}`,
            }),
          onMalformedFrame: (reason) => handlers.failed({ kind: "event-frame-invalid", reason }),
          onPeerMismatch: (reason) => handlers.failed({ kind: "daemon-identity-mismatch", reason }),
          onClose: () =>
            handlers.failed({ kind: "disconnected", reason: "Daemon event socket disconnected." }),
          onError: (reason) => handlers.failed({ kind: "disconnected", reason }),
        });
        return { status: "connected", close: () => connection.close() };
      } catch (error) {
        return {
          status: "failed",
          failure: shellFailure(error, "Daemon event socket could not be opened."),
        };
      }
    },
    disposition(failure) {
      // A suspect generation stops retrying; every other fault is transient.
      return failure.kind === "descriptor-invalid" || failure.kind === "daemon-identity-mismatch"
        ? "fatal"
        : "retry";
    },
    rejectionFailure: (source) => ({
      kind: source === "request" ? "network-error" : "disconnected",
      reason:
        source === "request"
          ? "Daemon application-shell request failed."
          : "Daemon event socket could not be opened.",
    }),
    transportFailure: (state) => ({
      kind: "disconnected",
      reason: transportStateReason(state) ?? "Daemon event socket disconnected.",
    }),
    eventExhaustedFailure: () => ({
      kind: "disconnected",
      reason: "Daemon event reconnection attempts were exhausted.",
    }),
    project: projectShell,
  };

  const store = createGenerationBoundStore(adapter, options.target, {
    clock: options.clock,
    random: options.random,
    retry: { ...DEFAULT_RECONNECT, ...options.reconnect },
  });
  return {
    getState: () => store.getState(),
    subscribe: (listener) => store.subscribe(listener),
    setTarget: (target) => store.setTarget(target),
    refresh: () => store.refresh(),
    dispose: () => store.dispose(),
  };
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
