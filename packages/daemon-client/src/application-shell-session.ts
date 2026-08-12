import {
  DesktopApplicationShellTargetSchemaZ,
  isDaemonWireProtocolCompatible,
  type ApplicationShellProjectionInputV1,
  type DesktopApplicationShellTarget,
  type DesktopDaemonTransportState,
  type InteractionReceipt,
} from "@tmux-ide/contracts";

import {
  createGenerationBoundStore,
  type GenerationBoundAdapter,
  type GenerationBoundClock,
  type GenerationBoundRetryPolicy,
  type GenerationBoundStoreMetrics,
  type GenerationBoundView,
} from "./generation-bound-store.ts";

/** Stable failure vocabulary shared by every application-shell client. */
export type ApplicationShellTransportErrorKind =
  | "descriptor-invalid"
  | "daemon-identity-mismatch"
  | "not-found"
  | "network-error"
  | "http-error"
  | "schema-invalid";

export class ApplicationShellTransportError extends Error {
  readonly kind: ApplicationShellTransportErrorKind;
  readonly statusCode?: number;

  constructor(kind: ApplicationShellTransportErrorKind, message: string, statusCode?: number) {
    super(message);
    this.name = "ApplicationShellTransportError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export interface ApplicationShellEventHandlers {
  /** Fires only after the peer proves it is the requested daemon generation. */
  readonly onVerifiedOpen: () => void;
  readonly onInvalidate: () => void;
  readonly onOperationAcknowledged?: (receipt: {
    readonly daemonInstanceId: string;
    readonly operationId: string;
    readonly sequence: number;
    readonly revision: number;
  }) => void;
  readonly onInteractionReceipt?: (receipt: InteractionReceipt) => void;
  readonly onProtocolError: (reason: string) => void;
  readonly onPeerMismatch: (reason: string) => void;
  readonly onMalformedFrame: (reason: string) => void;
  readonly onClose: () => void;
  readonly onError: (reason: string) => void;
  /** Optional state from a host-owned physical connection supervisor. */
  readonly onTransportStateChanged?: (transport: DesktopDaemonTransportState) => void;
}

export interface ApplicationShellEventConnection {
  close(): void;
}

/**
 * Renderer-neutral application-shell transport. GUI IPC, browser loopback and
 * OpenTUI daemon clients adapt their physical connection to this one boundary.
 */
export interface ApplicationShellTransport {
  fetchApplicationShell(
    target: DesktopApplicationShellTarget,
    signal: AbortSignal,
  ): Promise<ApplicationShellProjectionInputV1>;
  connectEvents(
    target: DesktopApplicationShellTarget,
    handlers: ApplicationShellEventHandlers,
  ): ApplicationShellEventConnection;
  validateTarget(target: unknown): DesktopApplicationShellTarget;
}

interface ApplicationShellStateBase {
  readonly generation: number;
  readonly target: DesktopApplicationShellTarget | null;
  readonly transport?: DesktopDaemonTransportState | null;
}

export type ApplicationShellSessionState =
  | (ApplicationShellStateBase & { readonly status: "loading"; readonly data: null })
  | (ApplicationShellStateBase & {
      readonly status: "live";
      readonly data: ApplicationShellProjectionInputV1;
      readonly updatedAt: number;
    })
  | (ApplicationShellStateBase & {
      readonly status: "unavailable";
      readonly data: null;
      readonly code: "not-found" | "disconnected" | "reconnect-exhausted";
      readonly reason: string;
    })
  | (ApplicationShellStateBase & {
      readonly status: "degraded";
      readonly data: ApplicationShellProjectionInputV1 | null;
      readonly updatedAt: number | null;
      readonly code:
        | "descriptor-invalid"
        | "daemon-identity-mismatch"
        | "schema-invalid"
        | "event-frame-invalid";
      readonly reason: string;
    })
  | (ApplicationShellStateBase & {
      readonly status: "error";
      readonly data: null;
      readonly code: "network-error" | "http-error";
      readonly reason: string;
    })
  | (ApplicationShellStateBase & {
      readonly status: "stale";
      readonly data: ApplicationShellProjectionInputV1;
      readonly updatedAt: number;
      readonly reason: string;
    })
  | (ApplicationShellStateBase & {
      readonly status: "disposed";
      readonly target: null;
      readonly data: null;
    });

export interface ApplicationShellSessionOptions {
  readonly target: unknown;
  readonly transport: ApplicationShellTransport;
  readonly clock?: GenerationBoundClock;
  readonly random?: () => number;
  readonly reconnect?: Partial<GenerationBoundRetryPolicy>;
  readonly onOperationAcknowledged?: ApplicationShellEventHandlers["onOperationAcknowledged"];
  readonly onInteractionReceipt?: ApplicationShellEventHandlers["onInteractionReceipt"];
}

export interface ApplicationShellSession {
  getState(): ApplicationShellSessionState;
  subscribe(listener: (state: ApplicationShellSessionState) => void): () => void;
  setTarget(target: unknown): void;
  refresh(): void;
  getMetrics(): GenerationBoundStoreMetrics;
  dispose(): void;
}

/** Stable status wording for a supervisor-owned event transport. */
export function applicationShellTransportStateReason(
  transport: DesktopDaemonTransportState,
): string | null {
  switch (transport.phase) {
    case "idle":
    case "connected":
      return null;
    case "connecting":
      return "Connecting to the engine event stream.";
    case "degraded":
      return `Engine event connection degraded — ${transport.error.reason}`;
    case "reconnecting":
      return `Reconnecting to the engine (attempt ${transport.attempt} of ${transport.maximumAttempts}).`;
    case "stopped":
      return "Engine event reconnection attempts were exhausted. Recheck the daemon to reconnect.";
  }
}

const DEFAULT_RECONNECT: GenerationBoundRetryPolicy = {
  initialDelayMs: 250,
  maximumDelayMs: 8_000,
  maximumAttempts: 6,
  jitterRatio: 0.2,
  stabilityWindowMs: 10_000,
};

type ShellFailureKind = ApplicationShellTransportErrorKind | "event-frame-invalid" | "disconnected";

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
  if (error instanceof ApplicationShellTransportError) {
    return { kind: error.kind, reason: error.message };
  }
  return {
    kind: "network-error",
    reason: error instanceof Error ? error.message : fallbackReason,
  };
}

export function applicationShellSessionTargetKey(target: DesktopApplicationShellTarget): string {
  const { daemon } = target;
  return [
    daemon.protocolVersion,
    daemon.productVersion,
    daemon.instanceId,
    daemon.startedAt,
    target.workspaceName,
  ].join("\u0000");
}

function validateTarget(
  value: unknown,
  transport: ApplicationShellTransport,
): DesktopApplicationShellTarget {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationShellTransportError(
      "descriptor-invalid",
      `Daemon application-shell target is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.daemon.protocolVersion)) {
    throw new ApplicationShellTransportError(
      "descriptor-invalid",
      `Daemon protocol ${parsed.data.daemon.protocolVersion} is not compatible with this client.`,
    );
  }
  return transport.validateTarget(parsed.data);
}

function projectShell(view: ShellView): ApplicationShellSessionState {
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
      reason:
        transport === null
          ? "Daemon event socket is not connected."
          : (applicationShellTransportStateReason(transport) ??
            "Daemon event socket is not connected."),
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

/**
 * One application-shell client session for every renderer. It owns generation
 * pinning, bounded retry, stale retention, resync, and observer isolation.
 */
export function createApplicationShellSession(
  options: ApplicationShellSessionOptions,
): ApplicationShellSession {
  const transport = options.transport;
  const adapter: GenerationBoundAdapter<
    DesktopApplicationShellTarget,
    ApplicationShellProjectionInputV1,
    ShellFailure,
    ApplicationShellSessionState
  > = {
    reassert: "ignore",
    validateTarget(value) {
      try {
        const target = validateTarget(value, transport);
        return { ok: true, target, key: applicationShellSessionTargetKey(target) };
      } catch (error) {
        return { ok: false, failure: shellFailure(error, "Application-shell target is invalid.") };
      }
    },
    async fetch(target, signal) {
      try {
        return { status: "ok", resource: await transport.fetchApplicationShell(target, signal) };
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
          onOperationAcknowledged: options.onOperationAcknowledged,
          onInteractionReceipt: options.onInteractionReceipt,
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
      reason: applicationShellTransportStateReason(state) ?? "Daemon event socket disconnected.",
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
    getMetrics: () => store.getMetrics(),
    dispose: () => store.dispose(),
  };
}
