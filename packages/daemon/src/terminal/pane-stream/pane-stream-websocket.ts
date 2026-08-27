import { z } from "zod";
import {
  PANE_STREAM_MAX_HELD_DELTAS,
  PANE_STREAM_MAX_OUTPUT_BYTES,
  PANE_STREAM_MAX_PANES,
  PANE_STREAM_MAX_SEED_BYTES,
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_REDEEM_PATH,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamClientFrameSchemaZ,
  PaneStreamLoopbackWebSocketUrlSchemaZ,
  PaneStreamRedeemFrameSchemaZ,
  PaneStreamServerFrameSchemaZ,
  sharedMonotonicMicros,
  type PaneStreamErrorFrameCode,
  type PaneStreamServerFrame,
  type PaneStreamLeaseRequest,
  type PaneStreamRedeemFrame,
  type PaneStreamViewerMode,
  type PaneStreamDiagnosticCapability,
  type SessionRuntimeSemanticIntent,
  type SessionRuntimeTerminalInput,
  type CausalCellProbeV1,
  type SessionRuntimeActivityKind,
  type SessionRuntimeAuthorityKind,
  type SessionRuntimeAuthorityLease,
  type SessionRuntimeAuthoritySnapshot,
  type SessionRuntimePresenceState,
  type TerminalDeliveryAck,
  type TerminalDeliveryNack,
  type TerminalDeliveryOffer,
  type TerminalDeliveryNegotiationResult,
  type TerminalDeliveryServerMessage,
  type TerminalDeliveryVisibility,
  type WorkspaceMultiplexerMutationResult,
} from "@tmux-ide/contracts";
import type {
  MirrorLayoutAuthoritySnapshot,
  MirrorLayoutEvent,
  MirrorPaneEvent,
  MirrorSessionDescription,
} from "../mirror/events.ts";
import type {
  MirrorLayoutSubscription,
  MirrorSubscribeRequest,
  MirrorSubscription,
} from "../mirror/mirror-service.ts";
import type { CausalCellLedgerResult } from "../session-runtime/causal-cell-ledger.ts";
import {
  canonicalOriginOrNull,
  digestSecret,
  digestsEqual,
  rawDataByteLength,
  rawDataToBuffer,
  safeCloseSocket,
  strictJsonParse,
} from "../attachments/admission-util.ts";
import type { DirectTerminalSocket } from "../attachments/direct-websocket.ts";
import type { SessionRuntimeObservability } from "../session-runtime/runtime-observability.ts";
import { SessionRuntimeControllerLeaseError } from "../session-runtime/registry.ts";
import { terminalDeliveryObservationOrdinal } from "../session-runtime/terminal-delivery-observation-identity.ts";
import {
  PaneStreamLeaseError,
  type IssuedPaneStreamLease,
  type PaneStreamLeaseBinding,
  type PaneStreamLeaseDescriptor,
} from "./lease-manager.ts";
import {
  DEFAULT_PANE_STREAM_FLOW_BUDGETS,
  PaneStreamWireLedger,
  type PaneStreamFlowBudgets,
} from "./wire-ledger.ts";

/**
 * The pane-stream WebSocket endpoint (m43 card 2): redeems a one-time `ps1_`
 * ticket and bridges MirrorService subscriptions to wire frames. Admission is
 * the direct-websocket discipline verbatim — Origin-gated upgrade reservation,
 * digest-only pending tickets, one text redemption frame, delivery-bound TTL —
 * applied to a session-scoped lease whose pane set was enumerated at issue.
 *
 * Flow control at the wire is a LEDGER per (client x pane x owner): a stalled
 * client freezes ONLY its own MirrorService subscription for the exhausted
 * pane (siblings and other clients keep flowing; the upstream control-mode
 * pause engages only when every subscriber of a pane is parked, which the
 * session channel already models), tickets force-return on WS close within
 * one tick, and thaw rides the service's atomic reseed.
 */
export { PANE_STREAM_REDEEM_PATH, PANE_STREAM_WEBSOCKET_SUBPROTOCOL };
export const PANE_STREAM_MAX_REDEMPTION_BYTES = 4 * 1024;
export const PANE_STREAM_MAX_CONTROL_BYTES = 4 * 1024;
export const PANE_STREAM_MAX_REDEMPTION_MS = 1_000;

const WS_OPEN = 1;
const CANONICAL_KEY_INPUT_FRAME_PREFIX = Buffer.from('{"kind":"key",', "utf8");
const CANONICAL_TEXT_INPUT_FRAME_PREFIX = Buffer.from('{"kind":"text",', "utf8");
const SEMANTIC_BACKEND_REFUSALS = new Set([
  "pane_inventory_not_ready",
  "pane_identity_changed_before_select",
  "pane_not_active",
]);

function semanticBackendRefusal(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return null;
    const context = "context" in candidate ? candidate.context : null;
    const reason =
      context && typeof context === "object" && "reason" in context ? context.reason : null;
    if (typeof reason === "string" && SEMANTIC_BACKEND_REFUSALS.has(reason)) return reason;
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}
const TYPE_FIRST_INPUT_FRAME_PREFIX = Buffer.from('{"type":"input",', "utf8");

function startsWithBuffer(raw: Buffer, prefix: Buffer): boolean {
  return (
    raw.length >= prefix.length && raw.compare(prefix, 0, prefix.length, 0, prefix.length) === 0
  );
}

function hasCanonicalInputFramePrefix(raw: Buffer): boolean {
  return (
    startsWithBuffer(raw, CANONICAL_KEY_INPUT_FRAME_PREFIX) ||
    startsWithBuffer(raw, CANONICAL_TEXT_INPUT_FRAME_PREFIX) ||
    startsWithBuffer(raw, TYPE_FIRST_INPUT_FRAME_PREFIX)
  );
}
const TicketPattern = /^ps1_[A-Za-z0-9_-]{43}$/u;
const BindingIdSchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));

/** The mirror surface the endpoint consumes (MirrorService satisfies it). */
export interface PaneStreamMirror {
  describeSession(session: string): Promise<MirrorSessionDescription>;
  describeSessionAuthority?(
    session: string,
  ): Promise<{ readonly description: MirrorSessionDescription; readonly runtimeSessionId: string }>;
  subscribe(request: MirrorSubscribeRequest): Promise<MirrorSubscription>;
  subscribeLayout?(
    session: string,
    onLayout: (event: MirrorLayoutEvent) => void,
    authority?: {
      readonly expectedSemanticPaneIds: readonly string[];
      readonly expectedRuntimeSessionId: string;
      readonly onAuthority?: (snapshot: MirrorLayoutAuthoritySnapshot) => void;
    },
  ): Promise<MirrorLayoutSubscription>;
}

export interface PaneStreamLeaseAuthority {
  issue(
    request: PaneStreamLeaseRequest,
    context: { requestId: string; projectIdentity: string; sessionName: string },
  ): Promise<IssuedPaneStreamLease>;
  redeem(
    ticket: string,
    binding: PaneStreamLeaseBinding,
    receivedAt?: number,
  ): Promise<{ descriptor: PaneStreamLeaseDescriptor }>;
  release(leaseId: string, binding: PaneStreamLeaseBinding): Promise<{ released: boolean }>;
}

export type PaneStreamAdmissionErrorCode =
  | "daemon-shutting-down"
  | "invalid-origin"
  | "origin-rejected"
  | "invalid-path"
  | "invalid-subprotocol"
  | "pending-capacity-exhausted"
  | "preauth-capacity-exhausted"
  | "live-capacity-exhausted"
  | "pane-not-found"
  | "redemption-rejected"
  | "stream-unavailable";

export class PaneStreamAdmissionError extends Error {
  readonly code: PaneStreamAdmissionErrorCode;

  constructor(code: PaneStreamAdmissionErrorCode, message: string) {
    super(message);
    this.name = "PaneStreamAdmissionError";
    this.code = code;
  }
}

export interface PaneStreamIssueContext {
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly sessionName: string;
  /** Canonical trusted renderer Origin supplied by the host, never the renderer body. */
  readonly rendererOrigin: string;
  /** Stable identity injected by the trusted host boundary, never renderer JSON. */
  readonly hostClientId?: string;
}

export interface PaneStreamDescriptor {
  readonly protocolVersion: typeof PANE_STREAM_PROTOCOL_VERSION;
  readonly webSocketUrl: string;
  readonly redemptionTicket: string;
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly panes: readonly string[];
  readonly effectiveViewerMode: PaneStreamViewerMode;
}

export type PaneStreamUpgradeDecision =
  | { readonly accepted: true; readonly admission: PaneStreamPreAuthAdmission }
  | {
      readonly accepted: false;
      readonly code: PaneStreamAdmissionErrorCode;
      readonly httpStatus: 403 | 404 | 426 | 503;
    };

export interface PaneStreamPreAuthAdmission {
  bind(socket: DirectTerminalSocket): void;
  cancelBeforeBind(): void;
}

export interface PaneStreamAdmissionSnapshot {
  readonly pendingTickets: number;
  readonly preAuthSockets: number;
  readonly liveConnections: number;
  readonly shuttingDown: boolean;
}

export interface PaneStreamAdmissionCoordinatorOptions {
  readonly daemonInstanceId: string;
  readonly webSocketUrl: string;
  readonly leaseManager: PaneStreamLeaseAuthority;
  readonly mirror: PaneStreamMirror;
  /** Trusted redemption boundary into the generation's SessionRuntime owner. */
  readonly bindSessionRuntime?: (
    descriptor: PaneStreamLeaseDescriptor,
  ) => SessionRuntimePaneStreamTransportBinding;
  readonly maxPendingTickets?: number;
  readonly maxPreAuthSockets?: number;
  readonly maxLiveConnections?: number;
  readonly redemptionTimeoutMs?: number;
  readonly flowBudgets?: PaneStreamFlowBudgets;
  /** Cadence of the send-buffer drain check while frames are in flight. */
  readonly drainTickMs?: number;
  /** Hard whole-socket ceiling; the ledger should stall panes far earlier. */
  readonly maxSocketBufferedBytes?: number;
  /** Input flood budget for one rolling admission window, never a lifetime quota. */
  readonly maxInputFramesPerWindow?: number;
  readonly maxInputBytesPerWindow?: number;
  readonly inputRateWindowMs?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  /** Opt-in daemon-local timing observer; disabled in normal production. */
  readonly observability?: SessionRuntimeObservability;
  /** Test seam consulted only for a negotiated clock-bounds capability. */
  readonly diagnosticSharedNowMicros?: () => number;
  /** Test-only parse-delay seam; consulted only with clock diagnostics. */
  readonly diagnosticAfterFrameParse?: () => void;
}

export interface SessionRuntimePaneStreamTransportBinding {
  readonly generation: string;
  readonly session: string;
  readonly clientId: string;
  readonly surface?: string;
  readonly explicitAuthority?: boolean;
  readonly deliveryLaneId?: string;
  readonly deliveryRequestId?: string;
  /** Optional only for the bounded v1 transport adapter. New clients require these methods. */
  authoritySnapshot?(): SessionRuntimeAuthoritySnapshot;
  activateLegacyAuthority?(geometry: boolean): SessionRuntimeAuthoritySnapshot;
  onAuthoritySnapshot?(listener: (snapshot: SessionRuntimeAuthoritySnapshot) => void): () => void;
  updatePresence?(state: SessionRuntimePresenceState): SessionRuntimeAuthoritySnapshot;
  noteActivity?(activity: SessionRuntimeActivityKind): SessionRuntimeAuthoritySnapshot;
  requestAuthority?(authority: SessionRuntimeAuthorityKind): SessionRuntimeAuthorityLease | null;
  releaseAuthority?(authority: SessionRuntimeAuthorityKind): SessionRuntimeAuthoritySnapshot;
  assertController(semanticPaneId?: string): void;
  openTerminalDelivery(
    semanticPaneId: string,
    offer: TerminalDeliveryOffer,
    onMessage: (message: TerminalDeliveryServerMessage) => void | Promise<void>,
  ): Promise<SessionRuntimeTerminalDeliveryConnection>;
  submitIntent(
    operationId: string,
    intent: SessionRuntimeSemanticIntent,
  ): Promise<WorkspaceMultiplexerMutationResult | void>;
  sendInput(
    semanticPaneId: string,
    input: SessionRuntimeTerminalInput,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeV1,
    onCausalResult?: (result: CausalCellLedgerResult) => void,
  ): void;
  fitViewport(lease: SessionRuntimeAuthorityLease, cols: number, rows: number): void;
  close(): Promise<void>;
}

export interface SessionRuntimeTerminalDeliveryConnection {
  readonly negotiation: TerminalDeliveryNegotiationResult;
  ack(ack: TerminalDeliveryAck): void;
  nack(nack: TerminalDeliveryNack): void;
  setVisibility(visibility: TerminalDeliveryVisibility): void;
  close(): Promise<void>;
}

interface PendingTicket {
  readonly leaseId: string;
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly origin: string;
  readonly ticketDigest: Buffer;
  readonly descriptor: PaneStreamLeaseDescriptor;
  cancelExpiry: (() => void) | null;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new TypeError("Pane-stream admission limit is invalid.");
  }
  return selected;
}

function sendControl(socket: DirectTerminalSocket, frame: Readonly<Record<string, unknown>>): void {
  if (socket.readyState !== WS_OPEN) return;
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > PANE_STREAM_MAX_CONTROL_BYTES) {
    throw new TypeError("Pane-stream control frame exceeded its bound.");
  }
  socket.send(encoded, { binary: false });
}

function errorFrameCode(error: unknown): PaneStreamErrorFrameCode {
  if (error instanceof PaneStreamLeaseError && error.code === "ticket-expired") {
    return "ticket-expired";
  }
  if (error instanceof PaneStreamAdmissionError) {
    switch (error.code) {
      case "live-capacity-exhausted":
        return "live-capacity-exhausted";
      case "pane-not-found":
      case "stream-unavailable":
        return "stream-unavailable";
      default:
        return "redemption-rejected";
    }
  }
  return "stream-unavailable";
}

/**
 * In-memory admission authority for one daemon instance. It retains only
 * ticket digests; a daemon restart makes every prior descriptor inert.
 */
export class PaneStreamAdmissionCoordinator {
  readonly #instanceId: string;
  readonly #webSocketUrl: string;
  readonly #leaseManager: PaneStreamLeaseAuthority;
  readonly #mirror: PaneStreamMirror;
  readonly #bindSessionRuntime:
    | PaneStreamAdmissionCoordinatorOptions["bindSessionRuntime"]
    | undefined;
  readonly #maxPending: number;
  readonly #maxPreAuth: number;
  readonly #maxLive: number;
  readonly #redemptionTimeoutMs: number;
  readonly #flowBudgets: PaneStreamFlowBudgets;
  readonly #drainTickMs: number;
  readonly #maxSocketBufferedBytes: number;
  readonly #maxInputFrames: number;
  readonly #maxInputBytes: number;
  readonly #inputRateWindowMs: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #observability: SessionRuntimeObservability | undefined;
  readonly #diagnosticSharedNowMicros: (() => number) | undefined;
  readonly #diagnosticAfterFrameParse: (() => void) | undefined;
  readonly #ledger: PaneStreamWireLedger;
  readonly #pending = new Map<string, PendingTicket>();
  readonly #preAuth = new Set<PreAuthAdmission>();
  readonly #live = new Set<PaneStreamLiveConnection>();
  readonly #retiringReleases = new Set<Promise<void>>();
  #clientCounter = 0;
  #operationTail: Promise<void> = Promise.resolve();
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: PaneStreamAdmissionCoordinatorOptions) {
    this.#instanceId = BindingIdSchemaZ.parse(options.daemonInstanceId);
    this.#webSocketUrl = PaneStreamLoopbackWebSocketUrlSchemaZ.parse(options.webSocketUrl);
    this.#leaseManager = options.leaseManager;
    this.#mirror = options.mirror;
    this.#bindSessionRuntime = options.bindSessionRuntime;
    this.#maxPending = boundedInteger(options.maxPendingTickets, 32, 1_024);
    this.#maxPreAuth = boundedInteger(options.maxPreAuthSockets, 16, 1_024);
    this.#maxLive = boundedInteger(options.maxLiveConnections, 16, 1_024);
    this.#redemptionTimeoutMs = boundedInteger(
      options.redemptionTimeoutMs,
      PANE_STREAM_MAX_REDEMPTION_MS,
      PANE_STREAM_MAX_REDEMPTION_MS,
    );
    this.#flowBudgets = options.flowBudgets ?? DEFAULT_PANE_STREAM_FLOW_BUDGETS;
    this.#ledger = new PaneStreamWireLedger(this.#flowBudgets);
    this.#drainTickMs = boundedInteger(options.drainTickMs, 15, 1_000);
    this.#maxSocketBufferedBytes = boundedInteger(
      options.maxSocketBufferedBytes,
      32 << 20,
      256 << 20,
    );
    this.#maxInputFrames = boundedInteger(options.maxInputFramesPerWindow, 16_384, 1 << 20);
    this.#maxInputBytes = boundedInteger(options.maxInputBytesPerWindow, 4 << 20, 64 << 20);
    this.#inputRateWindowMs = boundedInteger(options.inputRateWindowMs, 1_000, 60_000);
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#observability = options.observability;
    this.#diagnosticSharedNowMicros = options.diagnosticSharedNowMicros;
    this.#diagnosticAfterFrameParse = options.diagnosticAfterFrameParse;
  }

  issue(
    request: PaneStreamLeaseRequest,
    context: PaneStreamIssueContext,
  ): Promise<PaneStreamDescriptor> {
    const trace = this.#observability?.beginTrace(
      "pane-stream-connect",
      { generation: this.#instanceId, incarnation: null },
      context.requestId,
    );
    const queuedAtMicros = trace ? this.#observability!.nowMicros() : 0;
    return this.#exclusive(async () => {
      const admittedAtMicros = trace ? this.#observability!.nowMicros() : 0;
      if (trace)
        this.#observability!.recordSpan(
          "transport",
          "pane-stream-issue-queue",
          queuedAtMicros,
          admittedAtMicros,
          trace,
        );
      if (this.#shuttingDown) {
        throw new PaneStreamAdmissionError(
          "daemon-shutting-down",
          "Pane-stream admission is shutting down.",
        );
      }
      const origin = canonicalOriginOrNull(context.rendererOrigin);
      if (origin === null) {
        throw new PaneStreamAdmissionError("invalid-origin", "Renderer Origin is invalid.");
      }
      const requestId = z.uuid().parse(context.requestId);
      const projectIdentity = BindingIdSchemaZ.parse(context.projectIdentity);
      if (this.#pending.size >= this.#maxPending) {
        throw new PaneStreamAdmissionError(
          "pending-capacity-exhausted",
          "Pane-stream ticket capacity is exhausted.",
        );
      }

      // The pane set is enumerated at issue: every requested pane must exist
      // under verified semantic identity NOW. A describe failure is a probe
      // failure and never reads as absence.
      let described: MirrorSessionDescription;
      let runtimeSessionId: string | null = null;
      try {
        const describeStartedAtMicros = trace ? this.#observability!.nowMicros() : 0;
        if (this.#mirror.describeSessionAuthority) {
          const authority = await this.#mirror.describeSessionAuthority(context.sessionName);
          described = authority.description;
          runtimeSessionId = authority.runtimeSessionId;
        } else {
          described = await this.#mirror.describeSession(context.sessionName);
        }
        if (trace)
          this.#observability!.recordSpan(
            "transport",
            "pane-stream-describe-session",
            describeStartedAtMicros,
            this.#observability!.nowMicros(),
            trace,
          );
      } catch {
        throw new PaneStreamAdmissionError(
          "stream-unavailable",
          "The workspace session could not be described.",
        );
      }
      const known = new Set(described.panes.map((pane) => pane.semanticPaneId));
      for (const pane of request.panes) {
        if (!known.has(pane)) {
          throw new PaneStreamAdmissionError(
            "pane-not-found",
            `The pane ${pane} is not present in the workspace session.`,
          );
        }
      }

      const issued = await this.#leaseManager.issue(request, {
        requestId,
        projectIdentity,
        sessionName: context.sessionName,
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
        ...(context.hostClientId ? { hostClientId: context.hostClientId } : {}),
      });
      const descriptor = issued.descriptor;
      const ticket = issued.redemptionTicket;
      const valid =
        TicketPattern.test(ticket) &&
        z.uuid().safeParse(descriptor.leaseId).success &&
        descriptor.requestId === requestId &&
        (this.#mirror.describeSessionAuthority === undefined ||
          descriptor.runtimeSessionId === runtimeSessionId) &&
        descriptor.status === "awaiting-redemption" &&
        descriptor.viewerMode === request.viewerMode &&
        descriptor.workspaceName === request.workspaceName &&
        descriptor.panes.length === request.panes.length &&
        descriptor.panes.every((pane, index) => pane === request.panes[index]) &&
        descriptor.expiresAt > this.#now();
      const ticketDigest = digestSecret(ticket);
      const duplicate = [...this.#pending.values()].some((pending) =>
        digestsEqual(pending.ticketDigest, ticketDigest),
      );
      if (!valid || duplicate) {
        ticketDigest.fill(0);
        await this.#releaseLease(descriptor.leaseId, {
          daemonInstanceId: this.#instanceId,
          requestId,
          projectIdentity,
        });
        throw new PaneStreamAdmissionError(
          "stream-unavailable",
          "Pane-stream ticket generation failed.",
        );
      }
      const pending: PendingTicket = {
        leaseId: descriptor.leaseId,
        requestId,
        projectIdentity,
        origin,
        ticketDigest,
        descriptor: structuredClone(descriptor),
        cancelExpiry: null,
      };
      pending.cancelExpiry = this.#schedule(
        () => {
          void this.#exclusive(() => this.#retirePending(pending));
        },
        Math.max(1, descriptor.expiresAt - this.#now()),
      );
      this.#pending.set(pending.leaseId, pending);
      if (trace)
        this.#observability!.recordSpan(
          "transport",
          "pane-stream-issue-total",
          admittedAtMicros,
          this.#observability!.nowMicros(),
          trace,
        );
      return Object.freeze({
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        webSocketUrl: this.#webSocketUrl,
        redemptionTicket: ticket,
        daemonInstanceId: this.#instanceId,
        requestId,
        expiresAt: descriptor.expiresAt,
        panes: [...descriptor.panes],
        effectiveViewerMode: descriptor.viewerMode,
      });
    });
  }

  reserveUpgrade(input: {
    readonly path: string;
    readonly protocols: readonly string[];
    readonly origin: string | null | undefined;
    readonly hostClientId?: string | undefined;
    readonly requestId?: string | undefined;
  }): PaneStreamUpgradeDecision {
    if (this.#shuttingDown) {
      return { accepted: false, code: "daemon-shutting-down", httpStatus: 503 };
    }
    if (input.path !== PANE_STREAM_REDEEM_PATH) {
      return { accepted: false, code: "invalid-path", httpStatus: 404 };
    }
    if (input.protocols.length !== 1 || input.protocols[0] !== PANE_STREAM_WEBSOCKET_SUBPROTOCOL) {
      return { accepted: false, code: "invalid-subprotocol", httpStatus: 426 };
    }
    const origin = canonicalOriginOrNull(input.origin ?? "");
    if (origin === null) {
      return { accepted: false, code: "invalid-origin", httpStatus: 403 };
    }
    const hostClientId = input.hostClientId
      ? BindingIdSchemaZ.safeParse(input.hostClientId).data
      : undefined;
    if (input.hostClientId && !hostClientId) {
      return { accepted: false, code: "origin-rejected", httpStatus: 403 };
    }
    const requestId = input.requestId ? z.uuid().safeParse(input.requestId).data : undefined;
    if (input.requestId && !requestId) {
      return { accepted: false, code: "origin-rejected", httpStatus: 403 };
    }
    if (
      ![...this.#pending.values()].some(
        (pending) =>
          pending.origin === origin &&
          (!requestId || pending.requestId === requestId) &&
          (!hostClientId || pending.descriptor.hostClientId === hostClientId),
      )
    ) {
      return { accepted: false, code: "origin-rejected", httpStatus: 403 };
    }
    if (requestId && this.#observability?.enabled) {
      const trace = this.#observability.beginTrace(
        "pane-stream-connect",
        { generation: this.#instanceId, incarnation: null },
        requestId,
      );
      const atMicros = this.#observability.nowMicros();
      this.#observability.recordSpan(
        "transport",
        "pane-stream-upgrade-arrival",
        atMicros,
        atMicros,
        trace,
      );
    }
    if (this.#preAuth.size >= this.#maxPreAuth) {
      return { accepted: false, code: "preauth-capacity-exhausted", httpStatus: 503 };
    }
    const admission = new PreAuthAdmission({
      origin,
      hostClientId: hostClientId ?? null,
      timeoutMs: this.#redemptionTimeoutMs,
      schedule: this.#schedule,
      onRelease: (released) => this.#preAuth.delete(released),
      onRedeem: (active, frame, socket) => this.#redeem(active, frame, socket),
    });
    this.#preAuth.add(admission);
    return { accepted: true, admission };
  }

  snapshot(): PaneStreamAdmissionSnapshot {
    return Object.freeze({
      pendingTickets: this.#pending.size,
      preAuthSockets: this.#preAuth.size,
      liveConnections: this.#live.size,
      shuttingDown: this.#shuttingDown,
    });
  }

  /** Detached (client x pane x owner) outstanding-ticket snapshot. */
  flowSnapshot(): ReturnType<PaneStreamWireLedger["snapshot"]> {
    return this.#ledger.snapshot();
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
  }

  async #finishShutdown(): Promise<void> {
    for (const admission of [...this.#preAuth]) admission.close(1001, "daemon-shutdown");
    await this.#exclusive(async () => {
      for (const connection of [...this.#live]) connection.close(1001, "daemon-shutdown");
      for (const pending of [...this.#pending.values()]) await this.#retirePending(pending);
    });
    await Promise.all([...this.#retiringReleases]);
  }

  #redeem(
    admission: PreAuthAdmission,
    frame: PaneStreamRedeemFrame,
    socket: DirectTerminalSocket,
  ): Promise<PaneStreamLiveConnection> {
    // Stamp authenticated frame arrival BEFORE queueing: a queue wait must not
    // consume the ticket's delivery TTL (execution has its own budget).
    const receivedAt = this.#now();
    return this.#exclusive(async () => {
      if (this.#shuttingDown || frame.daemonInstanceId !== this.#instanceId) {
        throw new PaneStreamAdmissionError(
          "redemption-rejected",
          "Pane-stream redemption was rejected.",
        );
      }
      const candidateDigest = digestSecret(frame.ticket);
      let pending: PendingTicket | undefined;
      for (const entry of this.#pending.values()) {
        if (digestsEqual(entry.ticketDigest, candidateDigest)) pending = entry;
      }
      candidateDigest.fill(0);
      if (
        !pending ||
        pending.origin !== admission.origin ||
        (admission.hostClientId !== null &&
          pending.descriptor.hostClientId !== admission.hostClientId) ||
        pending.requestId !== frame.requestId
      ) {
        throw new PaneStreamAdmissionError(
          "redemption-rejected",
          "Pane-stream redemption was rejected.",
        );
      }
      const binding: PaneStreamLeaseBinding = {
        daemonInstanceId: this.#instanceId,
        requestId: pending.requestId,
        projectIdentity: pending.projectIdentity,
      };
      if (!admission.isOpen()) {
        this.#removePending(pending);
        await this.#releaseLease(pending.leaseId, binding);
        throw new PaneStreamAdmissionError(
          "redemption-rejected",
          "Pane-stream redemption was rejected.",
        );
      }
      this.#removePending(pending);
      if (this.#live.size >= this.#maxLive) {
        await this.#releaseLease(pending.leaseId, binding);
        throw new PaneStreamAdmissionError(
          "live-capacity-exhausted",
          "Pane-stream live capacity is exhausted.",
        );
      }
      try {
        const redeemed = await this.#leaseManager.redeem(frame.ticket, binding, receivedAt);
        const descriptor = redeemed.descriptor;
        if (descriptor.terminalDelivery && frame.deliveryAcks === true) {
          throw new PaneStreamAdmissionError(
            "stream-unavailable",
            "Semantic terminal delivery owns its ACK lifecycle; legacy renderer ACKs are invalid.",
          );
        }
        if (
          descriptor.leaseId !== pending.leaseId ||
          descriptor.requestId !== pending.requestId ||
          descriptor.status !== "active" ||
          descriptor.viewerMode !== pending.descriptor.viewerMode ||
          descriptor.panes.length !== pending.descriptor.panes.length
        ) {
          throw new PaneStreamAdmissionError(
            "stream-unavailable",
            "Pane-stream lease identity was unavailable.",
          );
        }
        if (!admission.isOpen()) {
          throw new PaneStreamAdmissionError(
            "redemption-rejected",
            "Pane-stream redemption was rejected.",
          );
        }
        this.#clientCounter += 1;
        const sessionRuntimeBinding = this.#bindSessionRuntime?.(descriptor) ?? null;
        let live: PaneStreamLiveConnection;
        try {
          live = new PaneStreamLiveConnection({
            clientId: `psc-${this.#clientCounter}`,
            socket,
            descriptor: structuredClone(descriptor),
            sessionRuntimeBinding,
            binding,
            deliveryAcks: frame.deliveryAcks === true,
            diagnosticCapabilities: frame.diagnosticCapabilities ?? [],
            causalCellCapability:
              descriptor.terminalDelivery !== null &&
              descriptor.viewerMode === "interactive" &&
              frame.diagnosticCapabilities?.includes("causal-cell-v1") === true,
            mirror: this.#mirror,
            leaseManager: this.#leaseManager,
            ledger: this.#ledger,
            drainTickMs: this.#drainTickMs,
            maxSocketBufferedBytes: this.#maxSocketBufferedBytes,
            maxInputFrames: this.#maxInputFrames,
            maxInputBytes: this.#maxInputBytes,
            inputRateWindowMs: this.#inputRateWindowMs,
            now: this.#now,
            schedule: this.#schedule,
            observability: this.#observability,
            diagnosticSharedNowMicros: this.#diagnosticSharedNowMicros,
            diagnosticAfterFrameParse: this.#diagnosticAfterFrameParse,
            onRetire: (connection) => this.#trackRetiringRelease(connection),
          });
        } catch (error) {
          await sessionRuntimeBinding?.close();
          throw error;
        }
        this.#live.add(live);
        admission.promote();
        live.start();
        return live;
      } catch (error) {
        await this.#releaseLease(pending.leaseId, binding);
        throw error;
      }
    });
  }

  #removePending(pending: PendingTicket): void {
    if (this.#pending.get(pending.leaseId) !== pending) return;
    this.#pending.delete(pending.leaseId);
    pending.cancelExpiry?.();
    pending.cancelExpiry = null;
    pending.ticketDigest.fill(0);
  }

  async #retirePending(pending: PendingTicket): Promise<void> {
    if (this.#pending.get(pending.leaseId) !== pending) return;
    const binding: PaneStreamLeaseBinding = {
      daemonInstanceId: this.#instanceId,
      requestId: pending.requestId,
      projectIdentity: pending.projectIdentity,
    };
    this.#removePending(pending);
    await this.#releaseLease(pending.leaseId, binding);
  }

  async #releaseLease(leaseId: string, binding: PaneStreamLeaseBinding): Promise<void> {
    try {
      await this.#leaseManager.release(leaseId, binding);
    } catch {
      // The lease manager may already have retired the one-use lease.
    }
  }

  #trackRetiringRelease(connection: PaneStreamLiveConnection): void {
    this.#live.delete(connection);
    const release = connection.waitForRelease();
    this.#retiringReleases.add(release);
    void release.then(
      () => this.#retiringReleases.delete(release),
      () => this.#retiringReleases.delete(release),
    );
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

interface PreAuthAdmissionOptions {
  readonly origin: string;
  readonly hostClientId: string | null;
  readonly timeoutMs: number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly onRelease: (admission: PreAuthAdmission) => void;
  readonly onRedeem: (
    admission: PreAuthAdmission,
    frame: PaneStreamRedeemFrame,
    socket: DirectTerminalSocket,
  ) => Promise<PaneStreamLiveConnection>;
}

class PreAuthAdmission implements PaneStreamPreAuthAdmission {
  readonly origin: string;
  readonly hostClientId: string | null;
  readonly #onRelease: PreAuthAdmissionOptions["onRelease"];
  readonly #onRedeem: PreAuthAdmissionOptions["onRedeem"];
  readonly #cancelDeadline: () => void;
  #socket: DirectTerminalSocket | null = null;
  #frameReceived = false;
  #open = true;
  #promoted = false;

  constructor(options: PreAuthAdmissionOptions) {
    this.origin = options.origin;
    this.hostClientId = options.hostClientId;
    this.#onRelease = options.onRelease;
    this.#onRedeem = options.onRedeem;
    this.#cancelDeadline = options.schedule(
      () => this.close(1008, "redemption-timeout"),
      options.timeoutMs,
    );
  }

  isOpen(): boolean {
    return this.#open && !this.#promoted;
  }

  bind(socket: DirectTerminalSocket): void {
    if (!this.#open || this.#socket) {
      safeCloseSocket(socket, 1008, "redemption-rejected");
      return;
    }
    this.#socket = socket;
    socket.on("message", this.#onMessage);
    socket.on("close", this.#onClose);
    socket.on("error", this.#onClose);
  }

  cancelBeforeBind(): void {
    this.close(1008, "upgrade-rejected");
  }

  promote(): void {
    if (!this.#open) return;
    this.#promoted = true;
    this.#open = false;
    this.#cancelDeadline();
    this.#detach();
    this.#onRelease(this);
  }

  close(code = 1008, reason = "redemption-rejected"): void {
    if (!this.#open) return;
    this.#open = false;
    this.#cancelDeadline();
    const socket = this.#socket;
    this.#detach();
    this.#onRelease(this);
    if (socket) safeCloseSocket(socket, code, reason);
  }

  readonly #onMessage = (
    data: string | Buffer | ArrayBuffer | readonly Buffer[],
    isBinary: boolean,
  ): void => {
    if (!this.#open || this.#frameReceived) {
      this.close(1008, "redemption-frame-rejected");
      return;
    }
    this.#frameReceived = true;
    const byteLength = rawDataByteLength(data, PANE_STREAM_MAX_REDEMPTION_BYTES);
    if (isBinary || byteLength === 0 || byteLength > PANE_STREAM_MAX_REDEMPTION_BYTES) {
      this.close(1009, "redemption-frame-rejected");
      return;
    }
    let frame: PaneStreamRedeemFrame;
    try {
      frame = PaneStreamRedeemFrameSchemaZ.parse(strictJsonParse(rawDataToBuffer(data)));
    } catch {
      this.close(1008, "redemption-frame-rejected");
      return;
    }
    const socket = this.#socket;
    if (!socket) {
      this.close(1008, "redemption-rejected");
      return;
    }
    this.#cancelDeadline();
    void this.#onRedeem(this, frame, socket).catch((error: unknown) => {
      if (!this.#open) return;
      const code = errorFrameCode(error);
      try {
        sendControl(socket, {
          type: "error",
          protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
          code,
          retryable: code === "live-capacity-exhausted" || code === "ticket-expired",
        });
      } catch {
        // Closing below is the fail-closed response.
      }
      this.close(code === "live-capacity-exhausted" ? 1013 : 1008, "redemption-rejected");
    });
  };

  readonly #onClose = (): void => this.close(1008, "redemption-rejected");

  #detach(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.off("message", this.#onMessage);
    socket.off("close", this.#onClose);
    socket.off("error", this.#onClose);
  }
}

interface LiveConnectionOptions {
  readonly clientId: string;
  readonly socket: DirectTerminalSocket;
  readonly descriptor: PaneStreamLeaseDescriptor;
  readonly sessionRuntimeBinding: SessionRuntimePaneStreamTransportBinding | null;
  readonly binding: PaneStreamLeaseBinding;
  readonly deliveryAcks: boolean;
  readonly causalCellCapability: boolean;
  readonly diagnosticCapabilities: readonly PaneStreamDiagnosticCapability[];
  readonly mirror: PaneStreamMirror;
  readonly leaseManager: PaneStreamLeaseAuthority;
  readonly ledger: PaneStreamWireLedger;
  readonly drainTickMs: number;
  readonly maxSocketBufferedBytes: number;
  readonly maxInputFrames: number;
  readonly maxInputBytes: number;
  readonly inputRateWindowMs: number;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly observability?: SessionRuntimeObservability;
  readonly diagnosticSharedNowMicros?: () => number;
  readonly diagnosticAfterFrameParse?: () => void;
  readonly onRetire: (connection: PaneStreamLiveConnection) => void;
}

interface SeedBatch {
  reset: { cols: number; rows: number } | null;
  seed: Uint8Array | null;
  held: Uint8Array[];
  guardArmed: boolean;
}

interface PaneChannel {
  readonly semanticPaneId: string;
  sub: MirrorSubscription | null;
  delivery: SessionRuntimeTerminalDeliveryConnection | null;
  deliveryAddress: {
    workspaceName: string;
    generation: string;
    incarnation: string | null;
    deliveryNonce: string;
  } | null;
  serverSeq: number;
  sentPaneFrames: number;
  consumedSeq: number;
  nextInputSeq: number;
  frozenByWire: boolean;
  closed: boolean;
  batch: SeedBatch | null;
}

interface QueuedSend {
  readonly pane: string | null;
  remaining: number;
}

export class PaneStreamLiveConnection {
  readonly #clientId: string;
  readonly #socket: DirectTerminalSocket;
  readonly #descriptor: PaneStreamLeaseDescriptor;
  readonly #binding: PaneStreamLeaseBinding;
  readonly #sessionRuntimeBinding: SessionRuntimePaneStreamTransportBinding | null;
  readonly #deliveryAcks: boolean;
  readonly #causalCellCapability: boolean;
  readonly #diagnosticCapabilities: readonly PaneStreamDiagnosticCapability[];
  readonly #mirror: PaneStreamMirror;
  readonly #leaseManager: PaneStreamLeaseAuthority;
  readonly #ledger: PaneStreamWireLedger;
  readonly #drainTickMs: number;
  readonly #maxSocketBufferedBytes: number;
  readonly #maxInputFrames: number;
  readonly #maxInputBytes: number;
  readonly #inputRateWindowMs: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #observability: SessionRuntimeObservability | undefined;
  readonly #diagnosticSharedRawMicros: (() => number) | undefined;
  readonly #diagnosticAfterFrameParse: (() => void) | undefined;
  readonly #onRetire: (connection: PaneStreamLiveConnection) => void;
  readonly #panes = new Map<string, PaneChannel>();
  readonly #semanticLayouts = new Map<string, MirrorLayoutEvent>();
  #semanticExpectedPaneIds: readonly string[] | null = null;
  #semanticRuntimeSessionId: string | null = null;
  #semanticTopologyEpoch = -1;
  readonly #sendQueue: QueuedSend[] = [];
  readonly #semanticDrainWaiters = new Map<string, Array<() => void>>();
  #layoutSubscription: MirrorLayoutSubscription | null = null;
  #sentBytesTotal = 0;
  #drainedBytesTotal = 0;
  #cancelDrainTick: (() => void) | null = null;
  #inputWindowStartedAt: number;
  #inputWindowFrames = 0;
  #inputWindowBytes = 0;
  #nextViewportSeq = 1;
  #nextClockProbe = 1;
  readonly #requestedAuthorities = new Set<SessionRuntimeAuthorityKind>();
  #usesExplicitAuthority = false;
  #legacyInputActivated = false;
  #legacyGeometryActivated = false;
  #closed = false;
  #releasePromise: Promise<unknown> | null = null;
  #stopAuthoritySnapshots: (() => void) | null = null;
  #sharedClockOriginMicros: number | null = null;
  #diagnosticFirstSeedObserved = false;
  readonly #diagnosticLifecycleStages: Set<string> | null;

  #recordDiagnosticLifecycle(
    operation:
      | "pane-stream-server-ready"
      | "pane-stream-layout-staged"
      | "pane-stream-layout-validated"
      | "pane-stream-delivery-open"
      | "pane-stream-first-seed"
      | "pane-stream-terminal",
    closeCode?: number,
    closeReason?: string,
  ): void {
    if (!this.#observability?.enabled || !this.#diagnosticLifecycleStages) return;
    if (this.#diagnosticLifecycleStages.has(operation)) return;
    this.#diagnosticLifecycleStages.add(operation);
    const trace = this.#observability.beginTrace(
      "pane-stream-connect",
      { generation: this.#binding.daemonInstanceId, incarnation: null },
      this.#binding.requestId,
    );
    const atMicros = this.#observability.nowMicros();
    const legalReason = (
      new Set([
        "stream-retired",
        "stream-unavailable",
        "stream-closed",
        "topology-changed",
        "output-backpressure",
        "panes-closed",
        "peer-closed",
        "daemon-shutdown",
        "redemption-rejected",
        "unknown",
      ]).has(closeReason ?? "")
        ? closeReason!
        : closeReason
          ? "unknown"
          : "none"
    ) as
      | "none"
      | "stream-retired"
      | "stream-unavailable"
      | "stream-closed"
      | "topology-changed"
      | "output-backpressure"
      | "panes-closed"
      | "peer-closed"
      | "daemon-shutdown"
      | "redemption-rejected"
      | "unknown";
    this.#observability.recordSpan(
      "transport",
      operation,
      atMicros,
      atMicros,
      trace,
      undefined,
      Object.freeze({
        paneStreamCloseCode:
          Number.isInteger(closeCode) && closeCode! >= 1000 && closeCode! <= 4999 ? closeCode! : 0,
        paneStreamCloseReason: legalReason,
      }),
    );
  }

  #sharedMicros(): number {
    const raw = this.#diagnosticSharedRawMicros!();
    this.#sharedClockOriginMicros ??= raw;
    const elapsed = raw - this.#sharedClockOriginMicros;
    if (!Number.isSafeInteger(elapsed) || elapsed < 0)
      throw new Error("Daemon shared monotonic clock regressed");
    return elapsed;
  }

  constructor(options: LiveConnectionOptions) {
    this.#clientId = options.clientId;
    this.#socket = options.socket;
    this.#descriptor = options.descriptor;
    this.#binding = options.binding;
    this.#sessionRuntimeBinding = options.sessionRuntimeBinding;
    this.#usesExplicitAuthority = options.sessionRuntimeBinding?.explicitAuthority === true;
    if (this.#descriptor.viewerMode === "interactive" && !this.#sessionRuntimeBinding) {
      throw new Error("Interactive pane stream requires SessionRuntime authority");
    }
    this.#deliveryAcks = options.deliveryAcks;
    this.#causalCellCapability = options.causalCellCapability;
    this.#diagnosticCapabilities = options.diagnosticCapabilities;
    this.#mirror = options.mirror;
    this.#leaseManager = options.leaseManager;
    this.#ledger = options.ledger;
    this.#drainTickMs = options.drainTickMs;
    this.#maxSocketBufferedBytes = options.maxSocketBufferedBytes;
    this.#maxInputFrames = options.maxInputFrames;
    this.#maxInputBytes = options.maxInputBytes;
    this.#inputRateWindowMs = options.inputRateWindowMs;
    this.#now = options.now;
    this.#inputWindowStartedAt = this.#now();
    this.#schedule = options.schedule;
    this.#observability = options.observability;
    this.#diagnosticLifecycleStages = options.observability?.enabled ? new Set() : null;
    this.#diagnosticSharedRawMicros = this.#diagnosticCapabilities.includes("clock-bounds-v1")
      ? (options.diagnosticSharedNowMicros ?? sharedMonotonicMicros)
      : undefined;
    this.#diagnosticAfterFrameParse = options.diagnosticAfterFrameParse;
    this.#onRetire = options.onRetire;
    for (const pane of options.descriptor.panes) {
      this.#panes.set(pane, {
        semanticPaneId: pane,
        sub: null,
        delivery: null,
        deliveryAddress: null,
        serverSeq: 0,
        sentPaneFrames: 0,
        consumedSeq: 0,
        nextInputSeq: 1,
        frozenByWire: false,
        closed: false,
        batch: null,
      });
    }
  }

  get clientId(): string {
    return this.#clientId;
  }

  start(): void {
    if (this.#closed || this.#socket.readyState !== WS_OPEN) {
      this.close(1008, "stream-retired");
      return;
    }
    this.#socket.on("message", this.#onMessage);
    this.#socket.on("close", this.#onSocketClose);
    this.#socket.on("error", this.#onSocketClose);
    try {
      sendControl(this.#socket, {
        type: "ready",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        daemonInstanceId: this.#binding.daemonInstanceId,
        requestId: this.#binding.requestId,
        ...(this.#sessionRuntimeBinding
          ? { connectionClientId: this.#sessionRuntimeBinding.clientId }
          : {}),
        panes: [...this.#descriptor.panes],
        effectiveViewerMode: this.#descriptor.viewerMode,
        ...(this.#diagnosticCapabilities.length > 0
          ? { diagnosticCapabilities: [...this.#diagnosticCapabilities] }
          : {}),
      });
      this.#recordDiagnosticLifecycle("pane-stream-server-ready");
    } catch {
      this.close(1011, "stream-unavailable-describe");
      return;
    }
    this.#stopAuthoritySnapshots =
      this.#sessionRuntimeBinding?.onAuthoritySnapshot?.((snapshot) =>
        this.#usesExplicitAuthority ? this.#sendAuthoritySnapshot(snapshot) : undefined,
      ) ?? null;
    void this.#subscribeAll();
  }

  close(code = 1000, reason = "stream-closed"): void {
    if (this.#closed) return;
    this.#recordDiagnosticLifecycle("pane-stream-terminal", code, reason);
    this.#closed = true;
    this.#cancelDrainTick?.();
    this.#cancelDrainTick = null;
    // Departure force-returns every ticket within this same tick.
    this.#ledger.forceReturnClient(this.#clientId);
    this.#sendQueue.length = 0;
    for (const waiters of this.#semanticDrainWaiters.values())
      for (const resolve of waiters) resolve();
    this.#semanticDrainWaiters.clear();
    this.#socket.off("message", this.#onMessage);
    this.#socket.off("close", this.#onSocketClose);
    this.#socket.off("error", this.#onSocketClose);
    this.#stopAuthoritySnapshots?.();
    this.#stopAuthoritySnapshots = null;
    const closures: Promise<unknown>[] = [];
    const layoutSubscription = this.#layoutSubscription;
    this.#layoutSubscription = null;
    if (layoutSubscription) closures.push(layoutSubscription.close().catch(() => undefined));
    for (const channel of this.#panes.values()) {
      const sub = channel.sub;
      channel.sub = null;
      const delivery = channel.delivery;
      channel.delivery = null;
      channel.closed = true;
      if (sub) closures.push(sub.close().catch(() => undefined));
      if (delivery) closures.push(delivery.close().catch(() => undefined));
    }
    this.#releasePromise = Promise.allSettled([
      ...closures,
      this.#leaseManager.release(this.#descriptor.leaseId, this.#binding).catch(() => undefined),
      this.#sessionRuntimeBinding?.close() ?? Promise.resolve(),
    ]);
    this.#onRetire(this);
    safeCloseSocket(this.#socket, code, reason);
  }

  async waitForRelease(): Promise<void> {
    await this.#releasePromise;
  }

  /** TESTS ONLY — run one drain evaluation without waiting for the tick. */
  drainNowForTest(): void {
    this.#drainNow();
  }

  async #subscribeAll(): Promise<void> {
    // Fresh truth once for the whole set: a pane listed at issue but gone by
    // redeem gets an honest `closed` frame (a successful describe omitting it
    // is absence; a describe FAILURE is not and fails the connection).
    let described: MirrorSessionDescription;
    try {
      described = await this.#mirror.describeSession(this.#descriptor.sessionName);
    } catch {
      this.close(1011, "stream-unavailable");
      return;
    }
    if (this.#closed) return;
    const known = new Set(described.panes.map((pane) => pane.semanticPaneId));
    if (this.#descriptor.terminalDelivery) {
      await this.#subscribeSemantic(known);
      return;
    }
    if (this.#mirror.subscribeLayout) {
      try {
        const layoutSubscription = await this.#mirror.subscribeLayout(
          this.#descriptor.sessionName,
          (event) => this.#onLayout(event),
        );
        if (this.#closed) {
          await layoutSubscription.close().catch(() => undefined);
          return;
        }
        this.#layoutSubscription = layoutSubscription;
      } catch {
        this.close(1011, "stream-unavailable");
        return;
      }
    }
    let layoutAttached = this.#layoutSubscription !== null;
    for (const channel of this.#panes.values()) {
      if (this.#closed) return;
      if (!known.has(channel.semanticPaneId)) {
        this.#emitClosed(channel);
        continue;
      }
      try {
        const sub = await this.#mirror.subscribe({
          session: this.#descriptor.sessionName,
          semanticPaneId: channel.semanticPaneId,
          onEvent: (event) => this.#onPaneEvent(channel, event),
          ...(layoutAttached ? {} : { onLayout: (event) => this.#onLayout(event) }),
        });
        layoutAttached = true;
        if (this.#closed || channel.closed) {
          void sub.close().catch(() => undefined);
          continue;
        }
        channel.sub = sub;
      } catch {
        this.close(1011, "stream-unavailable");
        return;
      }
    }
    this.#closeIfAllPanesGone();
  }

  async #subscribeSemantic(known: ReadonlySet<string>): Promise<void> {
    const binding = this.#sessionRuntimeBinding;
    const offer = this.#descriptor.terminalDelivery;
    if (!binding || !offer) {
      this.close(1011, "stream-unavailable");
      return;
    }
    const expectedPaneIds = [...this.#descriptor.panes].sort();
    if (expectedPaneIds.some((pane) => !known.has(pane))) {
      this.#failTopologyChanged();
      return;
    }
    const channels = [...this.#panes.values()];
    if (this.#closed || channels.length === 0) return;
    let stagedAuthority: MirrorLayoutAuthoritySnapshot | null = null;
    let authorityMalformed = false;
    let layoutActivated = false;
    // Establish the single session layout observer first. MirrorService owns
    // this lifecycle and may share native control state with delivery setup;
    // only the independent pane delivery opens below are parallelized.
    try {
      if (!this.#mirror.subscribeLayout) throw new Error("authoritative layout is unavailable");
      const subscription = await this.#mirror.subscribeLayout(
        this.#descriptor.sessionName,
        () => undefined,
        {
          expectedSemanticPaneIds: expectedPaneIds,
          expectedRuntimeSessionId: this.#descriptor.runtimeSessionId!,
          onAuthority: (snapshot) => {
            this.#recordDiagnosticLifecycle("pane-stream-layout-staged");
            if (snapshot.layouts.length > PANE_STREAM_MAX_PANES) authorityMalformed = true;
            else if (!layoutActivated) stagedAuthority = snapshot;
            else this.#onLayoutAuthority(snapshot);
          },
        },
      );
      if (this.#closed) {
        await subscription.close().catch(() => undefined);
        return;
      }
      const authority = stagedAuthority as MirrorLayoutAuthoritySnapshot | null;
      const stagedInitialFrames =
        authorityMalformed ||
        authority === null ||
        authority.session !== this.#descriptor.sessionName ||
        this.#descriptor.runtimeSessionId === null ||
        authority.runtimeSessionId !== this.#descriptor.runtimeSessionId ||
        authority.topologyEpoch < 0
          ? null
          : this.#validateInitialLayout(authority.layouts, expectedPaneIds);
      if (!stagedInitialFrames) {
        await subscription.close().catch(() => undefined);
        this.#failTopologyChanged();
        return;
      }
      this.#layoutSubscription = subscription;
    } catch (cause) {
      if (cause instanceof Error && cause.name === "MirrorTopologyChangedError") {
        this.#failTopologyChanged();
        return;
      }
      this.close(1011, "stream-unavailable");
      return;
    }

    // Delivery owners are pane-scoped and independent. Open them concurrently,
    // then publish in descriptor order only after every pane is coherent. This
    // removes N x attachment latency without allowing a fast pane to make the
    // session look ready while a sibling is still missing. allSettled is
    // deliberate: partial success is always closed before the socket retires.
    const openings = channels.map(async (channel) => {
      const pending: TerminalDeliveryServerMessage[] = [];
      let ready = false;
      const delivery = await binding.openTerminalDelivery(
        channel.semanticPaneId,
        offer,
        (message) => {
          if (!ready) pending.push(message);
          else return this.#sendTerminalDelivery(channel.semanticPaneId, message);
        },
      );
      return {
        channel,
        delivery,
        pending,
        markReady: () => {
          ready = true;
        },
      };
    });
    const settled = await Promise.allSettled(openings);
    const opened = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (
      this.#closed ||
      settled.some(
        (result) => result.status === "rejected" || !result.value.delivery.negotiation.accepted,
      )
    ) {
      await Promise.all(opened.map(({ delivery }) => delivery.close().catch(() => undefined)));
      if (!this.#closed) this.close(1011, "stream-unavailable");
      return;
    }

    const deliveryIdentityChanged = opened.some(({ channel, delivery, pending }) => {
      if (!delivery.negotiation.accepted) return true;
      const negotiated = delivery.negotiation.negotiated;
      if (negotiated.generation !== this.#binding.daemonInstanceId) return true;
      let incarnation: string | null = null;
      for (const message of pending) {
        if (message.type !== "terminal.delivery") continue;
        if (
          message.workspaceName !== this.#descriptor.sessionName ||
          message.semanticPaneId !== channel.semanticPaneId ||
          message.generation !== negotiated.generation ||
          message.deliveryNonce !== negotiated.deliveryNonce ||
          (incarnation !== null && message.incarnation !== incarnation)
        )
          return true;
        incarnation = message.incarnation;
      }
      return false;
    });
    if (deliveryIdentityChanged) {
      await Promise.all(opened.map(({ delivery }) => delivery.close().catch(() => undefined)));
      this.#failTopologyChanged();
      return;
    }

    const authority = stagedAuthority as MirrorLayoutAuthoritySnapshot | null;
    const initialFrames =
      authorityMalformed ||
      authority === null ||
      authority.session !== this.#descriptor.sessionName ||
      this.#descriptor.runtimeSessionId === null ||
      authority.runtimeSessionId !== this.#descriptor.runtimeSessionId ||
      authority.topologyEpoch < 0
        ? null
        : this.#validateInitialLayout(authority.layouts, expectedPaneIds);
    if (!initialFrames) {
      await Promise.all(opened.map(({ delivery }) => delivery.close().catch(() => undefined)));
      this.#failTopologyChanged();
      return;
    }
    this.#recordDiagnosticLifecycle("pane-stream-layout-validated");
    this.#semanticExpectedPaneIds = expectedPaneIds;
    this.#semanticRuntimeSessionId = authority!.runtimeSessionId;
    this.#semanticTopologyEpoch = authority!.topologyEpoch;
    this.#semanticLayouts.clear();
    for (const event of authority!.layouts)
      this.#semanticLayouts.set(event.semanticWindowId as string, event);
    this.#sendFrame(null, {
      type: "layout-snapshot",
      topologyEpoch: authority!.topologyEpoch,
      layouts: initialFrames,
    });
    layoutActivated = true;
    this.#recordDiagnosticLifecycle("pane-stream-delivery-open");

    for (const { channel, delivery, pending, markReady } of opened) {
      if (this.#closed || channel.closed) {
        await delivery.close();
        continue;
      }
      // The rejected case was eliminated above; retain this narrowing at the
      // publication boundary so an invalid negotiation cannot leak a nonce.
      if (!delivery.negotiation.accepted) continue;
      channel.delivery = delivery;
      channel.deliveryAddress = {
        workspaceName: this.#descriptor.workspaceName,
        generation: delivery.negotiation.negotiated.generation,
        incarnation: null,
        deliveryNonce: delivery.negotiation.negotiated.deliveryNonce,
      };
      this.#sendFrame(null, {
        type: "terminal-delivery-ready",
        pane: channel.semanticPaneId,
        negotiation: delivery.negotiation,
      });
      markReady();
      for (const message of pending)
        await this.#sendTerminalDelivery(channel.semanticPaneId, message);
    }
    this.#closeIfAllPanesGone();
  }

  async #sendTerminalDelivery(pane: string, message: TerminalDeliveryServerMessage): Promise<void> {
    if (message.type === "terminal.delivery") {
      if (!this.#diagnosticFirstSeedObserved) {
        this.#diagnosticFirstSeedObserved = true;
        this.#recordDiagnosticLifecycle("pane-stream-first-seed");
      }
      const channel = this.#panes.get(pane);
      if (channel?.deliveryAddress) channel.deliveryAddress.incarnation = message.incarnation;
      // SessionRuntime keys canonical replicas by the tmux session, while the
      // public pane-stream lease is keyed by its workspace identity. Translate
      // at this boundary so the renderer has one coherent address vocabulary.
      const detailedDeliveryObservation = this.#observability?.enabled === true;
      const trace =
        message.performanceTraceId && detailedDeliveryObservation
          ? this.#observability!.beginTrace(
              "terminal-input-to-paint",
              { generation: message.generation, incarnation: message.incarnation },
              message.performanceTraceId,
            )
          : null;
      let startedAtMicros: number | null = null;
      if (detailedDeliveryObservation)
        try {
          startedAtMicros = this.#observability!.nowMicros();
        } catch {
          // Detailed delivery timing cannot alter socket delivery.
        }
      let startedAtSharedMicros: number | null = null;
      if (startedAtMicros !== null && this.#diagnosticSharedRawMicros) {
        try {
          startedAtSharedMicros = this.#sharedMicros();
        } catch {
          // Shared-clock diagnostics cannot alter terminal delivery.
        }
      }
      this.#sendFrame(pane, {
        type: "terminal-delivery-envelope",
        pane,
        envelope: { ...message, workspaceName: this.#descriptor.workspaceName },
      });
      if (startedAtMicros !== null) {
        let endedAtMicros: number;
        try {
          endedAtMicros = this.#observability!.nowMicros();
        } catch {
          return;
        }
        let endedAtSharedMicros: number | null = null;
        if (startedAtSharedMicros !== null) {
          try {
            endedAtSharedMicros = this.#sharedMicros();
          } catch {
            // Preserve the process-local span when shared sampling fails.
          }
        }
        try {
          this.#observability!.recordSpan(
            "transport",
            "pane-stream-socket-send",
            startedAtMicros,
            endedAtMicros,
            trace,
            startedAtSharedMicros === null || endedAtSharedMicros === null
              ? undefined
              : {
                  startedAtMicros: startedAtSharedMicros,
                  endedAtMicros: endedAtSharedMicros,
                },
            Object.freeze({
              workspaceName: message.workspaceName,
              semanticPaneId: message.semanticPaneId,
              canonicalGeneration: message.generation,
              canonicalIncarnation: message.incarnation,
              canonicalRevision: message.canonicalRevision,
              canonicalStateHash: message.canonicalStateHash,
              transactionId: message.transactionId,
              ...(terminalDeliveryObservationOrdinal(message) === null
                ? {}
                : { deliveryOrdinal: terminalDeliveryObservationOrdinal(message)! }),
              deliveryClientId: this.#sessionRuntimeBinding?.clientId ?? this.#clientId,
              deliverySurface: this.#sessionRuntimeBinding?.surface ?? "unknown",
              deliveryLaneId: this.#sessionRuntimeBinding?.deliveryLaneId ?? this.#clientId,
              deliveryRequestId: this.#sessionRuntimeBinding?.deliveryRequestId ?? this.#clientId,
              deliveryNonce: message.deliveryNonce,
            }),
          );
        } catch {
          // Diagnostics cannot alter terminal delivery.
        }
      }
    } else if (message.type === "terminal.delivery.chunk") {
      this.#sendFrame(pane, {
        type: "terminal-delivery-chunk",
        pane,
        transactionId: message.transactionId,
        index: message.index,
        data: Buffer.from(message.bytes).toString("base64"),
      });
    } else {
      this.#sendFrame(pane, { type: "terminal-delivery-fault", pane, fault: message });
      // Lifecycle/control truth must never queue behind bulk terminal bytes.
      // The hard socket-wide ceiling still closes a genuinely wedged client in
      // #drainNow; a source-close frame itself is small and immediately useful.
      return;
    }
    await this.#awaitSemanticCredit(pane);
  }

  #awaitSemanticCredit(pane: string): Promise<void> {
    // Backpressure is pane-local. Aggregate pressure is guarded by the hard
    // socket ceiling in #drainNow, but must not let a noisy sibling prevent a
    // pane-close (or any other pane's next semantic delivery) from surfacing.
    if (!this.#ledger.isStalled(this.#clientId, pane)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#semanticDrainWaiters.get(pane) ?? [];
      waiters.push(resolve);
      this.#semanticDrainWaiters.set(pane, waiters);
      this.#ensureDrainTick();
    });
  }

  // ── Mirror events → frames ────────────────────────────────────────────────

  #onPaneEvent(channel: PaneChannel, event: MirrorPaneEvent): void {
    if (this.#closed || channel.closed) return;
    switch (event.type) {
      case "reset": {
        channel.batch = {
          reset: { cols: event.cols, rows: event.rows },
          seed: null,
          held: [],
          guardArmed: false,
        };
        this.#armBatchGuard(channel);
        return;
      }
      case "seed": {
        if (channel.batch) channel.batch.seed = event.data;
        else {
          channel.batch = { reset: null, seed: event.data, held: [], guardArmed: false };
          this.#armBatchGuard(channel);
        }
        return;
      }
      case "delta": {
        const batch = channel.batch;
        if (batch && batch.seed !== null) {
          batch.held.push(event.data);
          return;
        }
        if (batch) {
          // A delta cannot precede the capture of an armed reseed (the feed
          // discards those); treat an impossible ordering as live output.
          this.#flushBatch(channel, null);
        }
        this.#emitOutput(channel, event.data);
        return;
      }
      case "cursor": {
        if (channel.batch) {
          this.#flushBatch(channel, { x: event.x, y: event.y });
          return;
        }
        this.#sendPaneFrame(channel, {
          type: "cursor",
          pane: channel.semanticPaneId,
          seq: this.#nextSeq(channel),
          x: event.x,
          y: event.y,
        });
        return;
      }
      case "flow": {
        if (channel.batch) this.#flushBatch(channel, null);
        this.#sendPaneFrame(channel, {
          type: "flow",
          pane: channel.semanticPaneId,
          seq: this.#nextSeq(channel),
          state: event.state,
          reason: event.reason,
        });
        return;
      }
      case "closed": {
        if (channel.batch) this.#flushBatch(channel, null);
        this.#emitClosed(channel);
        this.#closeIfAllPanesGone();
        return;
      }
    }
  }

  /** The atomic batch arrives in ONE synchronous callback burst; a microtask
   *  guard flushes the degraded no-cursor path without reordering anything. */
  #armBatchGuard(channel: PaneChannel): void {
    const batch = channel.batch;
    if (!batch || batch.guardArmed) return;
    batch.guardArmed = true;
    queueMicrotask(() => {
      if (channel.batch === batch) this.#flushBatch(channel, null);
    });
  }

  #flushBatch(channel: PaneChannel, cursor: { x: number; y: number } | null): void {
    const batch = channel.batch;
    channel.batch = null;
    if (!batch || this.#closed || channel.closed) return;
    let seed = batch.seed ?? new Uint8Array(0);
    if (seed.byteLength > PANE_STREAM_MAX_SEED_BYTES) {
      // Pathological guard: keep the tail, resynchronizing at a line seam.
      let start = seed.byteLength - PANE_STREAM_MAX_SEED_BYTES;
      while (start < seed.byteLength && seed[start] !== 0x0a) start += 1;
      seed = seed.subarray(Math.min(start + 1, seed.byteLength));
    }
    const held = chunkBytes(concatBytes(batch.held), PANE_STREAM_MAX_OUTPUT_BYTES).slice(
      0,
      PANE_STREAM_MAX_HELD_DELTAS,
    );
    this.#sendPaneFrame(channel, {
      type: "seed-batch",
      pane: channel.semanticPaneId,
      seq: this.#nextSeq(channel),
      reset: batch.reset,
      seed: Buffer.from(seed).toString("base64"),
      held: held.map((chunk) => Buffer.from(chunk).toString("base64")),
      cursor,
    });
  }

  #emitOutput(channel: PaneChannel, data: Uint8Array): void {
    for (const chunk of chunkBytes(data, PANE_STREAM_MAX_OUTPUT_BYTES)) {
      this.#sendPaneFrame(channel, {
        type: "output",
        pane: channel.semanticPaneId,
        seq: this.#nextSeq(channel),
        data: Buffer.from(chunk).toString("base64"),
      });
    }
  }

  #emitClosed(channel: PaneChannel): void {
    if (channel.closed) return;
    channel.closed = true;
    const sub = channel.sub;
    channel.sub = null;
    if (sub) void sub.close().catch(() => undefined);
    this.#sendPaneFrame(channel, {
      type: "closed",
      pane: channel.semanticPaneId,
      seq: this.#nextSeq(channel),
    });
    this.#ledger.forgetPane(this.#clientId, channel.semanticPaneId);
  }

  #onLayoutAuthority(snapshot: MirrorLayoutAuthoritySnapshot): void {
    if (this.#closed || !this.#semanticExpectedPaneIds || !this.#semanticRuntimeSessionId) return;
    if (
      snapshot.session !== this.#descriptor.sessionName ||
      snapshot.runtimeSessionId !== this.#semanticRuntimeSessionId ||
      snapshot.topologyEpoch <= this.#semanticTopologyEpoch ||
      snapshot.layouts.length > PANE_STREAM_MAX_PANES
    ) {
      this.#failTopologyChanged();
      return;
    }
    const frames = this.#validateInitialLayout(snapshot.layouts, this.#semanticExpectedPaneIds);
    if (!frames) {
      this.#failTopologyChanged();
      return;
    }
    this.#semanticTopologyEpoch = snapshot.topologyEpoch;
    this.#semanticLayouts.clear();
    for (const event of snapshot.layouts)
      this.#semanticLayouts.set(event.semanticWindowId as string, event);
    this.#sendFrame(null, {
      type: "layout-snapshot",
      topologyEpoch: snapshot.topologyEpoch,
      layouts: frames,
    });
  }

  #onLayout(event: MirrorLayoutEvent): void {
    if (this.#closed) return;
    /*
     * Every window of the session, not only the leased panes' own.
     *
     * The lease is SESSION-scoped by design — one socket for one workspace —
     * and layout is that session's geometry rather than a per-pane stream. A
     * client that saw only its leased window could not render a window LIST at
     * all, which is what the layout-faithful view is built from (m50), and it
     * would have to lease every pane in the session to get one.
     *
     * Nothing new crosses the boundary: the frame carries semantic pane ids and
     * cell rectangles, and the same renderer is already told every pane's
     * semantic identity by the application-shell inventory. No runtime tmux id,
     * command, cwd or credential appears here.
     */
    const frame = this.#layoutFrame(event);
    if (!frame) {
      this.#failTopologyChanged();
      return;
    }
    this.#sendFrame(null, frame);
  }

  #layoutFrame(event: MirrorLayoutEvent): PaneStreamServerFrame | null {
    const frame = {
      type: "layout",
      semanticWindowId: event.semanticWindowId,
      windowName: event.windowName === null ? null : event.windowName.slice(0, 256),
      currentWindow: event.currentWindow,
      cols: event.cols,
      rows: event.rows,
      zoomed: event.zoomed,
      paneBorderStatus: event.paneBorderStatus,
      panes: event.panes.map((pane) => ({
        pane: pane.semanticPaneId,
        displayName: pane.displayName,
        displayNameSource: pane.displayNameSource,
        left: pane.left,
        top: pane.top,
        width: pane.width,
        height: pane.height,
        active: pane.active,
      })),
    };
    // Layout carries user-authored names and unbounded tmux geometry; gate it
    // through the schema and skip rather than ever sending an invalid frame.
    const parsed = PaneStreamServerFrameSchemaZ.safeParse(frame);
    return parsed.success ? parsed.data : null;
  }

  #validateInitialLayout(
    events: readonly MirrorLayoutEvent[],
    expectedPaneIds: readonly string[],
  ): PaneStreamServerFrame[] | null {
    if (events.length === 0) return null;
    const windows = new Set<string>();
    const panes: string[] = [];
    const frames: PaneStreamServerFrame[] = [];
    let currentWindows = 0;
    for (const event of events) {
      if (
        event.session !== this.#descriptor.sessionName ||
        typeof event.semanticWindowId !== "string" ||
        windows.has(event.semanticWindowId)
      )
        return null;
      windows.add(event.semanticWindowId);
      if (event.currentWindow) currentWindows += 1;
      const frame = this.#layoutFrame(event);
      if (!frame || frame.type !== "layout") return null;
      frames.push(frame);
      for (const pane of event.panes) {
        if (typeof pane.semanticPaneId !== "string") return null;
        panes.push(pane.semanticPaneId);
      }
    }
    panes.sort();
    if (
      currentWindows !== 1 ||
      new Set(panes).size !== panes.length ||
      panes.length !== expectedPaneIds.length ||
      panes.some((pane, index) => pane !== expectedPaneIds[index])
    )
      return null;
    return frames;
  }

  #failTopologyChanged(): void {
    if (this.#closed) return;
    this.#sendFrame(null, {
      type: "error",
      protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
      code: "topology-changed",
      retryable: true,
    });
    this.close(1012, "topology-changed");
  }

  // ── Send path + flow ledger ───────────────────────────────────────────────

  #nextSeq(channel: PaneChannel): number {
    channel.serverSeq += 1;
    return channel.serverSeq;
  }

  #sendPaneFrame(channel: PaneChannel, frame: Record<string, unknown>): void {
    channel.sentPaneFrames += 1;
    this.#sendFrame(channel.semanticPaneId, frame);
  }

  #sendFrame(pane: string | null, frame: Record<string, unknown>): void {
    if (this.#closed || this.#socket.readyState !== WS_OPEN) return;
    const encoded = JSON.stringify(frame);
    const bytes = Buffer.byteLength(encoded, "utf8");
    if (pane !== null) {
      this.#ledger.take(this.#clientId, pane, "ws-send-buffer", bytes);
      if (this.#deliveryAcks) this.#ledger.take(this.#clientId, pane, "renderer-backlog", 1);
    }
    this.#sendQueue.push({ pane, remaining: bytes });
    this.#sentBytesTotal += bytes;
    try {
      this.#socket.send(encoded, { binary: false });
    } catch {
      this.close(1011, "stream-unavailable");
      return;
    }
    // Stall is judged on the drain tick, never synchronously at send: the
    // socket must get its chance to drain first, or a single seed batch
    // larger than the budget would park even a healthy client.
    this.#ensureDrainTick();
  }

  #evaluateStall(pane: string): void {
    const channel = this.#panes.get(pane);
    if (!channel || channel.closed || channel.frozenByWire || !channel.sub) return;
    if (this.#ledger.isStalled(this.#clientId, pane)) {
      // Park exactly this subscriber: siblings and other clients keep flowing;
      // upstream %pause only engages when every subscriber of the pane parks.
      channel.frozenByWire = true;
      channel.sub.freeze();
    }
  }

  #evaluateResume(pane: string): void {
    const channel = this.#panes.get(pane);
    if (!channel || channel.closed || !channel.frozenByWire || !channel.sub) return;
    if (this.#ledger.shouldResume(this.#clientId, pane)) {
      channel.frozenByWire = false;
      channel.sub.thaw();
    }
  }

  #ensureDrainTick(): void {
    if (this.#cancelDrainTick || this.#closed || this.#sendQueue.length === 0) return;
    this.#cancelDrainTick = this.#schedule(() => {
      this.#cancelDrainTick = null;
      this.#drainNow();
      this.#ensureDrainTick();
    }, this.#drainTickMs);
  }

  #drainNow(): void {
    if (this.#closed) return;
    const buffered = this.#socket.bufferedAmount ?? 0;
    if (!Number.isSafeInteger(buffered) || buffered < 0) {
      this.close(1011, "stream-unavailable");
      return;
    }
    if (buffered > this.#maxSocketBufferedBytes) {
      this.close(1013, "output-backpressure");
      return;
    }
    let newlyDrained = this.#sentBytesTotal - buffered - this.#drainedBytesTotal;
    while (newlyDrained > 0 && this.#sendQueue.length > 0) {
      const head = this.#sendQueue[0]!;
      const applied = Math.min(newlyDrained, head.remaining);
      head.remaining -= applied;
      newlyDrained -= applied;
      this.#drainedBytesTotal += applied;
      if (head.pane !== null) {
        this.#ledger.give(this.#clientId, head.pane, "ws-send-buffer", applied);
      }
      if (head.remaining === 0) this.#sendQueue.shift();
    }
    for (const [pane, channel] of this.#panes) {
      if (channel.frozenByWire) this.#evaluateResume(pane);
      else this.#evaluateStall(pane);
      const waiters = this.#semanticDrainWaiters.get(pane);
      if (waiters && this.#ledger.shouldResume(this.#clientId, pane)) {
        this.#semanticDrainWaiters.delete(pane);
        for (const resolve of waiters) resolve();
      }
    }
  }

  // ── Client frames ─────────────────────────────────────────────────────────

  readonly #onMessage = (
    data: string | Buffer | ArrayBuffer | readonly Buffer[],
    isBinary: boolean,
  ): void => {
    if (this.#closed) return;
    let callbackAtSharedMicros: number | null = null;
    let ingressAtSharedMicros: number | null = null;
    let ingressAtMicros: number | null = null;
    if (this.#observability?.enabled) {
      try {
        ingressAtMicros = this.#observability.nowMicros();
      } catch {
        // Diagnostics cannot alter protocol truth.
      }
    }
    const byteLength = rawDataByteLength(data, PANE_STREAM_MAX_CONTROL_BYTES);
    if (isBinary || byteLength === 0 || byteLength > PANE_STREAM_MAX_CONTROL_BYTES) {
      this.#failProtocol("protocol-error");
      return;
    }
    const raw = rawDataToBuffer(data);
    if (this.#diagnosticSharedRawMicros && hasCanonicalInputFramePrefix(raw)) {
      try {
        callbackAtSharedMicros = this.#sharedMicros();
      } catch {
        // Preserve the process-local callback timestamp and product traffic.
      }
    }
    let frame: z.infer<typeof PaneStreamClientFrameSchemaZ>;
    try {
      frame = PaneStreamClientFrameSchemaZ.parse(strictJsonParse(raw));
    } catch {
      this.#failProtocol("protocol-error");
      return;
    }
    if (this.#diagnosticSharedRawMicros) {
      try {
        this.#diagnosticAfterFrameParse?.();
      } catch {
        // Test-only diagnostics cannot alter protocol truth.
      }
      if (frame.type === "input") {
        try {
          ingressAtSharedMicros = this.#sharedMicros();
        } catch {
          // Preserve callback timing and product traffic without a parse-complete sample.
        }
      }
    }
    if (frame.type === "clock-probe") {
      if (
        !this.#diagnosticCapabilities.includes("clock-bounds-v1") ||
        frame.requestId !== this.#binding.requestId ||
        frame.probe !== this.#nextClockProbe
      )
        return this.#failProtocol("protocol-error");
      this.#nextClockProbe += 1;
      try {
        ingressAtSharedMicros = this.#sharedMicros();
      } catch {
        return;
      }
      try {
        const daemonSendMicros = this.#sharedMicros();
        this.#sendFrame(null, {
          type: "clock-probe-ack",
          requestId: this.#binding.requestId,
          daemonInstanceId: this.#binding.daemonInstanceId,
          probe: frame.probe,
          clientSendMicros: frame.clientSendMicros,
          daemonReceiveMicros: ingressAtSharedMicros,
          daemonSendMicros,
        });
      } catch {
        // Client timeout reports calibration unavailable; product traffic continues.
      }
      return;
    }
    if (frame.type === "consumed") {
      this.#acceptConsumed(frame.pane, frame.seq);
      return;
    }
    if (frame.type === "presence") {
      if (!this.#acceptAuthorityGeneration(frame.generation)) return;
      this.#usesExplicitAuthority = true;
      if (!this.#sessionRuntimeBinding?.updatePresence) return this.#failProtocol("protocol-error");
      const snapshot = this.#sessionRuntimeBinding.updatePresence(frame.state);
      if (!this.#sessionRuntimeBinding.onAuthoritySnapshot) this.#sendAuthoritySnapshot(snapshot);
      return;
    }
    if (frame.type === "activity") {
      if (!this.#acceptAuthorityGeneration(frame.generation)) return;
      this.#usesExplicitAuthority = true;
      if (!this.#sessionRuntimeBinding?.noteActivity) return this.#failProtocol("protocol-error");
      const snapshot = this.#sessionRuntimeBinding.noteActivity(frame.activity);
      if (!this.#sessionRuntimeBinding.onAuthoritySnapshot) this.#sendAuthoritySnapshot(snapshot);
      return;
    }
    if (frame.type === "authority-request") {
      if (!this.#acceptAuthorityGeneration(frame.generation)) return;
      this.#usesExplicitAuthority = true;
      if (
        !this.#sessionRuntimeBinding?.requestAuthority ||
        !this.#sessionRuntimeBinding.authoritySnapshot
      )
        return this.#failProtocol("protocol-error");
      const lease = this.#sessionRuntimeBinding.requestAuthority(frame.authority);
      if (lease) this.#requestedAuthorities.add(frame.authority);
      this.#sendFrame(null, {
        type: "authority-receipt",
        requestId: frame.requestId,
        authority: frame.authority,
        status: lease ? "granted" : "rejected",
        lease,
        snapshot: this.#sessionRuntimeBinding.authoritySnapshot(),
      });
      return;
    }
    if (frame.type === "authority-release") {
      if (!this.#acceptAuthorityGeneration(frame.generation)) return;
      this.#usesExplicitAuthority = true;
      this.#requestedAuthorities.delete(frame.authority);
      if (!this.#sessionRuntimeBinding?.releaseAuthority)
        return this.#failProtocol("protocol-error");
      const snapshot = this.#sessionRuntimeBinding.releaseAuthority(frame.authority);
      this.#sendFrame(null, {
        type: "authority-receipt",
        requestId: frame.requestId,
        authority: frame.authority,
        status: "released",
        lease: null,
        snapshot,
      });
      return;
    }
    if (frame.type === "terminal-delivery-ack") {
      const channel = this.#deliveryChannel(frame.ack);
      if (!channel) return;
      channel.delivery!.ack({ ...frame.ack, workspaceName: this.#descriptor.sessionName });
      return;
    }
    if (frame.type === "terminal-delivery-nack") {
      const channel = this.#deliveryChannel(frame.nack);
      if (!channel) return;
      channel.delivery!.nack({ ...frame.nack, workspaceName: this.#descriptor.sessionName });
      return;
    }
    if (frame.type === "terminal-delivery-visibility") {
      const channel = this.#deliveryChannel({
        workspaceName: frame.workspaceName,
        semanticPaneId: frame.pane,
        generation: frame.generation,
        incarnation: frame.incarnation,
        deliveryNonce: frame.deliveryNonce,
      });
      if (!channel) return;
      channel.delivery!.setVisibility(frame.visibility);
      return;
    }
    if (frame.type === "semantic-intent") {
      this.#acceptSemanticIntent(frame.operationId, frame.intent);
      return;
    }
    if (frame.type === "viewport") {
      if (
        !this.#descriptor.terminalDelivery ||
        this.#descriptor.viewerMode !== "interactive" ||
        frame.seq !== this.#nextViewportSeq ||
        (this.#usesExplicitAuthority && !this.#requestedAuthorities.has("geometry"))
      ) {
        this.#failProtocol("input-rejected");
        return;
      }
      if (!this.#prepareInputAuthority(true)) return;
      this.#nextViewportSeq += 1;
      try {
        this.#sessionRuntimeBinding!.fitViewport(frame.authorityLease, frame.cols, frame.rows);
        this.#sendFrame(null, {
          type: "viewport-ack",
          seq: frame.seq,
          cols: frame.cols,
          rows: frame.rows,
          outcome: "ok",
          authorityLease: frame.authorityLease,
        });
      } catch (error) {
        if (
          error instanceof SessionRuntimeControllerLeaseError &&
          (error.code === "invalid-client-capability" || error.code === "stale-controller-lease")
        ) {
          this.#sendFrame(null, {
            type: "viewport-ack",
            seq: frame.seq,
            cols: frame.cols,
            rows: frame.rows,
            outcome: "geometry-authority-conflict",
            authorityLease: frame.authorityLease,
          });
          return;
        }
        this.#failProtocol("input-rejected");
      }
      return;
    }
    this.#acceptInput(
      frame.pane,
      frame.seq,
      frame.kind,
      frame.data,
      byteLength,
      frame.performanceTraceId,
      frame.causalProbe,
      ingressAtMicros,
      callbackAtSharedMicros,
      ingressAtSharedMicros,
    );
  };

  #acceptAuthorityGeneration(generation: string): boolean {
    if (!this.#sessionRuntimeBinding || generation !== this.#sessionRuntimeBinding.generation) {
      this.#failProtocol("protocol-error");
      return false;
    }
    return true;
  }

  #sendAuthoritySnapshot(snapshot: SessionRuntimeAuthoritySnapshot): void {
    this.#sendFrame(null, { type: "authority-snapshot", snapshot });
  }

  #prepareInputAuthority(geometry: boolean): boolean {
    if (this.#usesExplicitAuthority) {
      const required = geometry ? "geometry" : "input";
      if (!this.#requestedAuthorities.has(required)) {
        this.#failProtocol("input-rejected");
        return false;
      }
      return true;
    }
    if (this.#legacyInputActivated && (!geometry || this.#legacyGeometryActivated)) return true;
    try {
      // A genuine old binding acquired at admission and has no adapter method.
      // New deferred bindings activate only here, before explicit mode exists.
      this.#sessionRuntimeBinding?.activateLegacyAuthority?.(geometry);
      this.#legacyInputActivated = true;
      if (geometry) this.#legacyGeometryActivated = true;
      return true;
    } catch {
      this.#failProtocol("input-rejected");
      return false;
    }
  }

  #deliveryChannel(address: {
    workspaceName: string;
    semanticPaneId: string;
    generation: string;
    incarnation: string;
    deliveryNonce: string;
  }): PaneChannel | null {
    const channel = this.#panes.get(address.semanticPaneId);
    const expected = channel?.deliveryAddress;
    if (
      !channel?.delivery ||
      !expected ||
      expected.workspaceName !== address.workspaceName ||
      expected.generation !== address.generation ||
      expected.deliveryNonce !== address.deliveryNonce ||
      expected.incarnation === null
    ) {
      this.#failProtocol("protocol-error");
      return null;
    }
    // More than one canonical delivery can legitimately be in flight. The
    // cached address records only the newest incarnation, so comparing an ACK
    // against that single value rejects an earlier valid delivery during a
    // reseed/reconnect burst. Generation + one-use delivery nonce identify the
    // channel here; the retained delivery owner validates incarnation,
    // transaction and revision ordering authoritatively below.
    return channel;
  }

  #acceptSemanticIntent(operationId: string, intent: SessionRuntimeSemanticIntent): void {
    if (!this.#descriptor.terminalDelivery || this.#descriptor.viewerMode !== "interactive") {
      this.#failProtocol("input-rejected");
      return;
    }
    if (!this.#prepareInputAuthority(false)) return;
    void this.#sessionRuntimeBinding!.submitIntent(operationId, intent)
      .then((result) => {
        this.#sendFrame(null, {
          type: "semantic-intent-ack",
          operationId,
          outcome: { status: "applied", result: result ?? null },
        });
      })
      .catch((error: unknown) => {
        const backendRefusal = semanticBackendRefusal(error);
        const rawCode =
          backendRefusal ??
          (error && typeof error === "object" && "code" in error
            ? String(error.code)
            : error && typeof error === "object" && "outcome" in error
              ? `intent-${String(error.outcome)}`
              : "stream-unavailable");
        const code = [
          "controller-conflict",
          "controller-target-unavailable",
          "stale-controller-lease",
          "invalid-client-capability",
          "invalid-source-pane-binding",
          "intent-session-mismatch",
          "intent-rejected",
          "intent-timed-out",
          "pane_inventory_not_ready",
          "pane_identity_changed_before_select",
          "pane_not_active",
        ].includes(rawCode)
          ? rawCode
          : "stream-unavailable";
        this.#sendFrame(null, {
          type: "semantic-intent-ack",
          operationId,
          outcome: {
            status: "rejected",
            code,
            message:
              error instanceof Error ? error.message.slice(0, 512) : "Semantic intent failed",
          },
        });
      });
  }

  #acceptConsumed(pane: string, seq: number): void {
    const channel = this.#panes.get(pane);
    if (
      !this.#deliveryAcks ||
      !channel ||
      seq <= channel.consumedSeq ||
      seq > channel.sentPaneFrames
    ) {
      this.#failProtocol("protocol-error");
      return;
    }
    const returned = seq - channel.consumedSeq;
    channel.consumedSeq = seq;
    this.#ledger.give(this.#clientId, pane, "renderer-backlog", returned);
    this.#evaluateResume(pane);
  }

  #acceptInput(
    pane: string,
    seq: number,
    kind: "text" | "key",
    data: string,
    frameBytes: number,
    performanceTraceId?: string,
    causalProbe?: CausalCellProbeV1,
    ingressAtMicros: number | null = null,
    callbackAtSharedMicros: number | null = null,
    ingressAtSharedMicros: number | null = null,
  ): void {
    if (this.#descriptor.viewerMode !== "interactive") {
      this.#failProtocol("input-rejected");
      return;
    }
    const channel = this.#panes.get(pane);
    const semanticDelivery = this.#descriptor.terminalDelivery !== null;
    if (
      !channel ||
      channel.closed ||
      (semanticDelivery ? !channel.delivery : !channel.sub) ||
      seq !== channel.nextInputSeq
    ) {
      this.#failProtocol("input-rejected");
      return;
    }
    if (causalProbe) {
      const address = channel.deliveryAddress;
      if (
        !this.#causalCellCapability ||
        !address ||
        causalProbe.clientId !== this.#sessionRuntimeBinding?.clientId ||
        causalProbe.transportNonce !== this.#binding.requestId ||
        causalProbe.deliveryNonce !== address.deliveryNonce ||
        causalProbe.inputSequence !== seq ||
        causalProbe.semanticPaneId !== pane ||
        causalProbe.generation !== address.generation ||
        causalProbe.incarnation !== address.incarnation
      ) {
        this.#failProtocol("input-rejected");
        return;
      }
    }
    const now = this.#now();
    if (
      now < this.#inputWindowStartedAt ||
      now - this.#inputWindowStartedAt >= this.#inputRateWindowMs
    ) {
      this.#inputWindowStartedAt = now;
      this.#inputWindowFrames = 0;
      this.#inputWindowBytes = 0;
    }
    if (
      this.#inputWindowFrames + 1 > this.#maxInputFrames ||
      this.#inputWindowBytes + frameBytes > this.#maxInputBytes
    ) {
      this.#failProtocol("input-rejected");
      return;
    }
    if (!this.#prepareInputAuthority(false)) return;
    let trace: ReturnType<SessionRuntimeObservability["beginTrace"]> = null;
    if (performanceTraceId && this.#observability?.enabled) {
      try {
        trace = this.#observability.beginTrace(
          "terminal-input-to-paint",
          {
            generation: this.#sessionRuntimeBinding!.generation,
            incarnation: causalProbe?.incarnation ?? channel.deliveryAddress?.incarnation ?? null,
          },
          performanceTraceId,
        );
        if (trace && ingressAtMicros !== null) {
          this.#observability.recordSpan(
            "transport",
            "pane-stream-socket-message-callback-entry",
            ingressAtMicros,
            ingressAtMicros,
            trace,
            callbackAtSharedMicros === null
              ? undefined
              : {
                  startedAtMicros: callbackAtSharedMicros,
                  endedAtMicros: callbackAtSharedMicros,
                },
          );
          this.#observability.recordSpan(
            "transport",
            "pane-stream-input-frame-ingress",
            ingressAtMicros,
            ingressAtMicros,
            trace,
            ingressAtSharedMicros === null
              ? undefined
              : { startedAtMicros: ingressAtSharedMicros, endedAtMicros: ingressAtSharedMicros },
          );
        }
      } catch {
        trace = null;
      }
    }
    this.#inputWindowFrames += 1;
    this.#inputWindowBytes += frameBytes;
    channel.nextInputSeq += 1;
    try {
      this.#sessionRuntimeBinding!.assertController(pane);
      if (semanticDelivery)
        this.#sessionRuntimeBinding!.sendInput(
          pane,
          { kind, data },
          performanceTraceId,
          causalProbe,
          causalProbe
            ? (result) => {
                if (this.#closed) return;
                if (result.status === "proved") {
                  this.#sendFrame(null, { type: "causal-cell-proof", proof: result.proof });
                } else {
                  this.#sendFrame(null, {
                    type: "causal-cell-failure",
                    failure: {
                      version: 1,
                      capability: "causal-cell-v1",
                      traceId: result.traceId,
                      reason: result.reason,
                      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
                    },
                  });
                }
              }
            : undefined,
        );
      else if (kind === "text") channel.sub!.sendText(data);
      else channel.sub!.sendKey(data);
      let ackStartedAtMicros: number | null = null;
      let ackStartedAtSharedMicros: number | null = null;
      if (trace) {
        try {
          ackStartedAtMicros = this.#observability!.nowMicros();
        } catch {
          // Diagnostics cannot alter protocol truth.
        }
        if (this.#diagnosticSharedRawMicros) {
          try {
            ackStartedAtSharedMicros = this.#sharedMicros();
          } catch {
            // Preserve process-local ACK diagnostics.
          }
        }
      }
      sendControl(this.#socket, { type: "input-ack", pane, seq });
      if (trace && ackStartedAtMicros !== null) {
        let ackEndedAtMicros: number | null = null;
        try {
          ackEndedAtMicros = this.#observability!.nowMicros();
        } catch {
          // Diagnostics cannot alter protocol truth.
        }
        let ackEndedAtSharedMicros: number | null = null;
        if (ackStartedAtSharedMicros !== null) {
          try {
            ackEndedAtSharedMicros = this.#sharedMicros();
          } catch {
            // Preserve process-local ACK diagnostics.
          }
        }
        if (ackEndedAtMicros !== null) {
          try {
            this.#observability!.recordSpan(
              "transport",
              "pane-stream-input-ack-socket-send",
              ackStartedAtMicros,
              ackEndedAtMicros,
              trace,
              ackStartedAtSharedMicros === null || ackEndedAtSharedMicros === null
                ? undefined
                : {
                    startedAtMicros: ackStartedAtSharedMicros,
                    endedAtMicros: ackEndedAtSharedMicros,
                  },
            );
          } catch {
            // Diagnostics cannot alter protocol truth.
          }
        }
      }
    } catch {
      this.close(1011, "stream-unavailable");
    }
  }

  #failProtocol(code: PaneStreamErrorFrameCode): void {
    try {
      sendControl(this.#socket, {
        type: "error",
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        code,
        retryable: false,
      });
    } catch {
      this.close(1011, "stream-unavailable");
      return;
    }
    this.close(1008, code);
  }

  #closeIfAllPanesGone(): void {
    if (this.#closed) return;
    for (const channel of this.#panes.values()) {
      if (!channel.closed) return;
    }
    this.close(1000, "panes-closed");
  }

  readonly #onSocketClose = (): void => this.close(1000, "peer-closed");
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function chunkBytes(data: Uint8Array, maxChunk: number): Uint8Array[] {
  if (data.byteLength === 0) return [];
  if (data.byteLength <= maxChunk) return [data];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += maxChunk) {
    chunks.push(data.subarray(offset, Math.min(offset + maxChunk, data.byteLength)));
  }
  return chunks;
}
