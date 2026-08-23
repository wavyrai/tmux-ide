import {
  PANE_STREAM_MAX_HELD_DELTAS,
  PANE_STREAM_MAX_OUTPUT_BASE64_CHARS,
  PANE_STREAM_MAX_PANES,
  PANE_STREAM_MAX_SEED_BASE64_CHARS,
  PANE_STREAM_PROTOCOL_VERSION,
  PANE_STREAM_WEBSOCKET_SUBPROTOCOL,
  PaneStreamIssueDescriptorSchemaZ,
  PaneStreamLeaseRequestSchemaZ,
  PaneStreamServerFrameSchemaZ,
  type PaneStreamIssueDescriptor,
  type PaneStreamLeaseRequest,
  type PaneStreamServerFrame,
  type TerminalDeliveryAck,
  type TerminalDeliveryOffer,
  type SessionRuntimeActivityKind,
  type SessionRuntimePresenceState,
  type SessionRuntimeAuthoritySnapshot,
} from "@tmux-ide/contracts";
import {
  TerminalDeliveryAssembler,
  admitTerminalDeliveryChunk,
  admitTerminalDeliveryEnvelope,
  commitTerminalDelivery,
  completeTerminalDelivery,
  createTerminalDeliveryClientState,
  encodeAnsiTerminalPatchRepresentation,
  encodeAnsiTerminalRepresentation,
  type TerminalDeliveryClientState,
} from "@tmux-ide/core";
import { browserWebSocketHandshakeUrl } from "../runtime/browser-websocket-session.ts";
import { browserInitiatedWebSocketCloseCode } from "../browser-websocket.ts";
import type { GuiPerformanceTelemetrySink } from "../runtime/gui-performance-telemetry.ts";

/**
 * Renderer-direct pane-stream transport (m43 card 3): ONE WebSocket per
 * session-scoped lease, demultiplexed into per-pane mirror events.
 *
 * The admission discipline is the terminal-attachment transport's, applied to
 * the pane-stream wire contract:
 *  - the injected issue call is the only privileged seam (Electron main owns
 *    credentials); its result stays untrusted until validated here;
 *  - the `ps1_` ticket bounds credential DELIVERY only — once the redemption
 *    frame is on the wire the daemon owns expiry, and a bounded local ceiling
 *    merely catches a daemon that never answers;
 *  - every inbound frame is bounded then schema-parsed; any violation retires
 *    the whole session with an honest typed error.
 *
 * Flow control: the redeem frame commits to `deliveryAcks`, so this transport
 * MUST send cumulative per-pane `consumed` acks. An ack is sent only after the
 * consumer's apply settles — withholding acks is how a slow renderer parks
 * exactly its own pane subscription upstream.
 */
export const PANE_STREAM_TRANSPORT_PROTOCOL = PANE_STREAM_WEBSOCKET_SUBPROTOCOL;
export const PANE_STREAM_MAX_DESCRIPTOR_LIFETIME_MS = 60_000;
export const PANE_STREAM_DEFAULT_ISSUE_TIMEOUT_MS = 5_000;
/** Ceiling on the daemon's answer once the redemption frame is on the wire. */
export const PANE_STREAM_REDEEM_RESPONSE_TIMEOUT_MS = 75_000;
/**
 * Upper bound of one server frame in UTF-16 code units. Server payloads are
 * ASCII (JSON + base64), so code units bound bytes from below; a worst-case
 * seed-batch carries a full seed plus every held delta.
 */
export const PANE_STREAM_MAX_SERVER_FRAME_CHARS =
  PANE_STREAM_MAX_SEED_BASE64_CHARS +
  PANE_STREAM_MAX_HELD_DELTAS * PANE_STREAM_MAX_OUTPUT_BASE64_CHARS +
  16_384;
/** Applied-but-unacked local queue ceiling per pane; the daemon's renderer-backlog
 *  flow budget should park the pane far earlier, so crossing this means the
 *  daemon ignored its own ledger and the session fails closed. */
export const PANE_STREAM_MAX_PENDING_EVENTS_PER_PANE = 1_024;
export const PANE_STREAM_RATE_WINDOW_MS = 1_000;
export const PANE_STREAM_MAX_INBOUND_FRAMES_PER_WINDOW = 32_768;
export const PANE_STREAM_MAX_CONNECTION_LIFETIME_MS = 24 * 60 * 60 * 1_000;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;

type SocketEventType = "open" | "message" | "close" | "error";

export interface PaneStreamSocketEvent {
  readonly data?: unknown;
}

export type PaneStreamSocketListener = (event: PaneStreamSocketEvent) => void;

/** Browser WebSocket subset used by this renderer-only transport and tests. */
export interface PaneStreamWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  binaryType: BinaryType;
  addEventListener(type: SocketEventType, listener: PaneStreamSocketListener): void;
  removeEventListener(type: SocketEventType, listener: PaneStreamSocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type PaneStreamWebSocketFactory = (url: string, protocol: string) => PaneStreamWebSocket;

/** The unreviewed host result stays unknown until this card-local parser accepts it. */
export type PaneStreamIssueLease = (request: PaneStreamLeaseRequest) => Promise<unknown>;

export interface PaneStreamTransportError {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
}

/** One atomic reseed, decoded: apply as ONE paint (reset → seed → held → cursor). */
export interface PaneMirrorSeedBatch {
  readonly reset: { readonly cols: number; readonly rows: number } | null;
  readonly seed: Uint8Array;
  readonly held: readonly Uint8Array[];
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

export interface PaneMirrorCanonicalProjection {
  readonly deliveryRequestId: string;
  readonly generation: string;
  readonly incarnation: string;
  readonly revision: number;
  readonly stateHash: string;
  readonly cols: number;
  readonly rows: number;
  readonly sourceEpoch: number;
  readonly alternateScreen: boolean;
  readonly cursor: Readonly<{
    x: number;
    y: number;
    hidden: boolean;
    style: "block" | "underline" | "bar";
    blink: boolean;
  }>;
  readonly gridRowsRead: number;
  readonly gridCellsRead: number;
  readonly fullGridWalks: number;
}

export type PaneMirrorEvent =
  | {
      readonly type: "seed-batch";
      readonly batch: PaneMirrorSeedBatch;
      readonly canonical?: PaneMirrorCanonicalProjection;
    }
  | {
      readonly type: "output";
      readonly bytes: Uint8Array;
      readonly canonical?: PaneMirrorCanonicalProjection;
      /** Lazily materialized canonical repaint retained for sink handoff. */
      readonly replay?: () => PaneMirrorSeedBatch;
    }
  | { readonly type: "cursor"; readonly x: number; readonly y: number }
  | {
      readonly type: "flow";
      readonly state: "paused" | "resumed";
      readonly reason: "backpressure" | "requested";
    }
  | { readonly type: "closed" };

export interface PaneStreamLayoutEvent {
  readonly semanticWindowId: string | null;
  readonly windowName: string | null;
  readonly currentWindow: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly zoomed: boolean;
  readonly paneBorderStatus: "top" | "bottom" | "off";
  readonly panes: readonly {
    readonly pane: string | null;
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly active: boolean;
  }[];
}

export interface PaneStreamSessionListeners {
  /**
   * Per-pane mirror event, delivered in wire order per pane. The returned
   * promise marks the event APPLIED; the cumulative `consumed` ack for its
   * server sequence is sent only after it settles successfully.
   */
  readonly onPaneEvent: (pane: string, event: PaneMirrorEvent) => void | Promise<void>;
  readonly onLayout?: (layout: PaneStreamLayoutEvent) => void;
  /** Terminal state of the whole session; null error is a clean end. */
  readonly onEnd: (error: PaneStreamTransportError | null) => void;
  readonly onAuthoritySnapshot?: (snapshot: SessionRuntimeAuthoritySnapshot) => void;
}

export interface PaneStreamSessionHandle {
  dispose(): void;
  updatePresence?(state: SessionRuntimePresenceState): void;
  noteActivity?(activity: SessionRuntimeActivityKind): void;
  write?(pane: string, text: string): Promise<boolean>;
  resize?(cols: number, rows: number): Promise<boolean>;
}

export type PaneStreamConnectResult =
  | { readonly status: "connected"; readonly session: PaneStreamSessionHandle }
  | { readonly status: "error"; readonly error: PaneStreamTransportError };

export interface PaneStreamRequest {
  readonly workspaceName: string;
  readonly panes: readonly string[];
  readonly viewerMode?: "read-only" | "interactive";
}

export interface PaneStreamTransport {
  connect(
    request: PaneStreamRequest,
    listeners: PaneStreamSessionListeners,
  ): Promise<PaneStreamConnectResult>;
}

export interface PaneStreamTransportDependencies {
  /** Privileged issue call injected by the host adapter; never a stream proxy. */
  readonly issuePaneStream: PaneStreamIssueLease;
  readonly createWebSocket?: PaneStreamWebSocketFactory;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly issueTimeoutMs?: number;
  /** Default is the canonical semantic lane; null is the legacy compatibility profile. */
  readonly terminalDelivery?: TerminalDeliveryOffer | null;
  readonly performanceTelemetry?: GuiPerformanceTelemetrySink | null;
}

/**
 * Structured issue failure the host adapter throws so the daemon's real
 * pane-stream verdict (e.g. pane-not-found) survives to the surface instead of
 * collapsing into one generic message.
 */
export class PaneStreamIssueFailure extends Error {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
  constructor(code: string, reason: string, retryable: boolean) {
    super(reason);
    this.name = "PaneStreamIssueFailure";
    this.code = code;
    this.reason = reason;
    this.retryable = retryable;
  }
}

const ErrorCodePattern = /^[a-z][a-z0-9_-]{0,79}$/u;

function transportError(
  code: string,
  reason: string,
  retryable: boolean,
): PaneStreamTransportError {
  return Object.freeze({ code, reason, retryable });
}

const GENERIC_ISSUE_ERROR = transportError(
  "pane-stream-issue-failed",
  "The desktop host could not issue a pane stream.",
  true,
);

function boundedIssueReason(reason: unknown): string | null {
  return typeof reason === "string" &&
    reason.length > 0 &&
    reason.length <= 240 &&
    !/[\0\r\n]/u.test(reason)
    ? reason
    : null;
}

function issueErrorToTransportError(error: unknown): PaneStreamTransportError {
  if (error instanceof PaneStreamIssueFailure && ErrorCodePattern.test(error.code)) {
    const reason = boundedIssueReason(error.reason);
    if (reason) return transportError(error.code, reason, error.retryable);
  }
  return GENERIC_ISSUE_ERROR;
}

function defaultCreateWebSocket(url: string, protocol: string): PaneStreamWebSocket {
  return new globalThis.WebSocket(url, protocol) as unknown as PaneStreamWebSocket;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function boundedIssueTimeout(value: number | undefined): number {
  const selected = value ?? PANE_STREAM_DEFAULT_ISSUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 30_000) {
    throw new TypeError("Pane-stream issue timeout is invalid.");
  }
  return selected;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const text = globalThis.atob(value);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

interface SafeStreamDescriptor {
  readonly workspaceName: string;
  readonly webSocketUrl: string;
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly panes: readonly string[];
  readonly effectiveViewerMode: "read-only" | "interactive";
  readonly redemptionFrame: string;
}

function validateIssueDescriptor(
  value: unknown,
  request: PaneStreamLeaseRequest,
  now: number,
): SafeStreamDescriptor | null {
  const parsed = PaneStreamIssueDescriptorSchemaZ.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.expiresAt <= now ||
    parsed.data.expiresAt - now > PANE_STREAM_MAX_DESCRIPTOR_LIFETIME_MS
  ) {
    return null;
  }
  const descriptor: PaneStreamIssueDescriptor = parsed.data;
  if (
    descriptor.effectiveViewerMode !== request.viewerMode ||
    descriptor.panes.length !== request.panes.length ||
    descriptor.panes.some((pane, index) => pane !== request.panes[index])
  ) {
    return null;
  }
  const redemptionFrame = JSON.stringify({
    type: "redeem",
    protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
    ticket: descriptor.redemptionTicket,
    requestId: descriptor.requestId,
    daemonInstanceId: descriptor.daemonInstanceId,
    // Semantic delivery owns its transaction ACK lifecycle. Advertising the
    // legacy cumulative renderer ACK lane at the same time is an invalid dual
    // ownership claim and the daemon correctly rejects it.
    ...(request.terminalDelivery ? {} : { deliveryAcks: true }),
  });
  return {
    workspaceName: request.workspaceName,
    webSocketUrl: descriptor.webSocketUrl,
    daemonInstanceId: descriptor.daemonInstanceId,
    requestId: descriptor.requestId,
    expiresAt: descriptor.expiresAt,
    panes: descriptor.panes,
    effectiveViewerMode: descriptor.effectiveViewerMode,
    redemptionFrame,
  };
}

const STREAM_ERROR_REASON: Readonly<Record<string, string>> = {
  "redemption-rejected": "The daemon rejected the pane-stream redemption.",
  "ticket-expired": "The pane-stream ticket expired before the daemon received it.",
  "live-capacity-exhausted": "The daemon's live pane-stream capacity is exhausted.",
  "stream-unavailable": "The pane stream is unavailable.",
  "input-rejected": "The daemon rejected pane-stream input.",
  "protocol-error": "The daemon rejected the pane-stream protocol exchange.",
};

interface PaneChannel {
  readonly pane: string;
  /** Last server seq received for this pane; the wire increments by exactly one. */
  receivedSeq: number;
  /** Highest seq whose event settled successfully at the consumer. */
  appliedSeq: number;
  /** Highest seq acknowledged to the daemon with a cumulative `consumed`. */
  consumedSeq: number;
  pendingApplies: number;
  applyTail: Promise<void>;
  closed: boolean;
  semanticPhase: "awaiting" | "live" | "faulted";
  semanticDelivery: TerminalDeliveryClientState | null;
  semanticAssembler: TerminalDeliveryAssembler | null;
  sourceEpoch: number;
}

class PaneStreamSession {
  readonly #socket: PaneStreamWebSocket;
  readonly #listeners: PaneStreamSessionListeners;
  readonly #descriptor: Omit<SafeStreamDescriptor, "redemptionFrame">;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #now: () => number;
  readonly #performanceTelemetry: GuiPerformanceTelemetrySink | null;
  readonly #panes = new Map<string, PaneChannel>();
  readonly #connectPromise: Promise<PaneStreamConnectResult>;
  #resolveConnect!: (result: PaneStreamConnectResult) => void;
  #redemptionFrame: string | null;
  #cancelExpiry: (() => void) | null = null;
  #cancelRedeemResponse: (() => void) | null = null;
  #cancelLifetime: (() => void) | null = null;
  #phase: "opening" | "redeeming" | "live" | "closed" = "opening";
  #connectSettled = false;
  #endNotified = false;
  #rateWindowStartedAt: number;
  #inboundFrames = 0;
  #clientSequence = 0;
  readonly #authorityWaiters = new Map<string, (granted: boolean) => void>();
  readonly #inputWaiters = new Map<number, () => void>();
  readonly #viewportWaiters = new Map<number, () => void>();
  readonly #heldAuthorities = new Set<"input" | "focus" | "geometry">();
  readonly #authorityClientIds = new Map<"input" | "focus" | "geometry", string>();
  #writeTail: Promise<void> = Promise.resolve();
  #queuedWrites = 0;

  constructor(options: {
    readonly descriptor: SafeStreamDescriptor;
    readonly socket: PaneStreamWebSocket;
    readonly listeners: PaneStreamSessionListeners;
    readonly schedule: (callback: () => void, delayMs: number) => () => void;
    readonly now: () => number;
    readonly performanceTelemetry?: GuiPerformanceTelemetrySink | null;
  }) {
    this.#socket = options.socket;
    this.#listeners = options.listeners;
    this.#schedule = options.schedule;
    this.#now = options.now;
    this.#performanceTelemetry = options.performanceTelemetry ?? null;
    this.#rateWindowStartedAt = options.now();
    const { redemptionFrame, ...descriptor } = options.descriptor;
    this.#redemptionFrame = redemptionFrame;
    this.#descriptor = descriptor;
    for (const pane of descriptor.panes) {
      this.#panes.set(pane, {
        pane,
        receivedSeq: 0,
        appliedSeq: 0,
        consumedSeq: 0,
        pendingApplies: 0,
        applyTail: Promise.resolve(),
        closed: false,
        semanticPhase: "awaiting",
        semanticDelivery: null,
        semanticAssembler: null,
        sourceEpoch: 0,
      });
    }
    this.#connectPromise = new Promise((resolve) => {
      this.#resolveConnect = resolve;
    });
  }

  start(): Promise<PaneStreamConnectResult> {
    this.#socket.binaryType = "arraybuffer";
    this.#socket.addEventListener("open", this.#onOpen);
    this.#socket.addEventListener("message", this.#onMessage);
    this.#socket.addEventListener("close", this.#onClose);
    this.#socket.addEventListener("error", this.#onError);
    const remaining = this.#descriptor.expiresAt - this.#now();
    if (remaining <= 0) {
      this.#retire(
        transportError("stream-expired", "The pane-stream ticket expired.", true),
        1008,
        "stream-expired",
      );
    } else {
      this.#cancelExpiry = this.#schedule(
        () =>
          this.#retire(
            transportError("stream-expired", "The pane-stream ticket expired.", true),
            1008,
            "stream-expired",
          ),
        remaining,
      );
    }
    return this.#connectPromise;
  }

  readonly dispose = (): void => {
    // A Web document opens one pane-stream transport per visible pane, while
    // the daemon deliberately ref-counts them under one host-client principal.
    // Releasing shared authority from one socket would revoke live siblings.
    // Closing the transport binding owns ref retirement; the daemon releases
    // the principal only when its last same-host connection closes.
    this.#heldAuthorities.clear();
    this.#authorityClientIds.clear();
    this.#retire(null, 1000, "renderer-disposed");
  };

  readonly updatePresence = (state: SessionRuntimePresenceState): void => {
    this.#sendControl({ type: "presence", generation: this.#descriptor.daemonInstanceId, state });
  };

  readonly noteActivity = (activity: SessionRuntimeActivityKind): void => {
    this.#sendControl({
      type: "activity",
      generation: this.#descriptor.daemonInstanceId,
      activity,
    });
  };

  readonly write = async (pane: string, text: string): Promise<boolean> => {
    if (this.#queuedWrites >= 256) return false;
    this.#queuedWrites += 1;
    let resolveResult!: (accepted: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });
    this.#writeTail = this.#writeTail
      .then(async () => resolveResult(await this.#writeNow(pane, text)))
      .catch(() => resolveResult(false))
      .finally(() => {
        this.#queuedWrites -= 1;
      });
    return await result;
  };

  async #writeNow(pane: string, text: string): Promise<boolean> {
    if (!(await this.#ensureAuthority("input"))) return false;
    const seq = ++this.#clientSequence;
    const accepted = new Promise<boolean>((resolve) => {
      const cancel = this.#schedule(() => {
        this.#inputWaiters.delete(seq);
        resolve(false);
      }, 2_000);
      this.#inputWaiters.set(seq, () => {
        cancel();
        resolve(true);
      });
    });
    this.#sendControl({ type: "input", kind: "text", pane, seq, data: text });
    this.noteActivity("input");
    return await accepted;
  }

  readonly resize = async (cols: number, rows: number): Promise<boolean> => {
    if (!(await this.#ensureAuthority("geometry"))) return false;
    const seq = ++this.#clientSequence;
    const accepted = new Promise<boolean>((resolve) => {
      const cancel = this.#schedule(() => {
        this.#viewportWaiters.delete(seq);
        resolve(false);
      }, 2_000);
      this.#viewportWaiters.set(seq, () => {
        cancel();
        resolve(true);
      });
    });
    this.#sendControl({ type: "viewport", seq, cols, rows });
    this.noteActivity("geometry");
    return await accepted;
  };

  async #ensureAuthority(authority: "input" | "geometry"): Promise<boolean> {
    if (this.#phase !== "live" || this.#socket.readyState !== WS_OPEN) return false;
    if (this.#heldAuthorities.has(authority)) return true;
    const requestId = globalThis.crypto.randomUUID();
    const granted = new Promise<boolean>((resolve) => {
      const cancel = this.#schedule(() => {
        this.#authorityWaiters.delete(requestId);
        resolve(false);
      }, 2_000);
      this.#authorityWaiters.set(requestId, (ok) => {
        cancel();
        resolve(ok);
      });
    });
    this.#sendControl({
      type: "authority-request",
      generation: this.#descriptor.daemonInstanceId,
      requestId,
      authority,
    });
    return await granted;
  }

  #sendControl(frame: object): void {
    if (this.#phase !== "live" || this.#socket.readyState !== WS_OPEN) return;
    try {
      this.#socket.send(JSON.stringify(frame));
    } catch {
      /* transport retirement owns socket failure */
    }
  }

  readonly #onOpen = (): void => {
    if (this.#phase !== "opening") return;
    if (
      this.#socket.protocol !== PANE_STREAM_TRANSPORT_PROTOCOL ||
      this.#socket.readyState !== WS_OPEN
    ) {
      this.#retire(
        transportError(
          "subprotocol-mismatch",
          "The pane-stream WebSocket negotiated an unexpected protocol.",
          false,
        ),
        1002,
        "subprotocol-mismatch",
      );
      return;
    }
    if (this.#now() >= this.#descriptor.expiresAt || !this.#redemptionFrame) {
      this.#retire(
        transportError("stream-expired", "The pane-stream ticket expired.", true),
        1008,
        "stream-expired",
      );
      return;
    }
    const frame = this.#redemptionFrame;
    this.#redemptionFrame = null;
    this.#phase = "redeeming";
    try {
      this.#socket.send(frame);
    } catch {
      this.#retire(
        transportError("socket-unavailable", "The pane-stream WebSocket became unavailable.", true),
        1011,
        "socket-unavailable",
      );
      return;
    }
    // Delivery-versus-processing split: the ticket bounded DELIVERY and the
    // frame is on the wire, so expiry authority moves to the daemon. Keep only
    // a bounded local ceiling so a silent daemon cannot hold the card open.
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
    this.#cancelRedeemResponse = this.#schedule(
      () =>
        this.#retire(
          transportError(
            "redeem-timeout",
            "The daemon did not answer the pane-stream redemption in time.",
            true,
          ),
          1008,
          "redeem-timeout",
        ),
      PANE_STREAM_REDEEM_RESPONSE_TIMEOUT_MS,
    );
  };

  readonly #onClose = (): void => {
    if (this.#phase === "closed") return;
    const allClosed = [...this.#panes.values()].every((channel) => channel.closed);
    if (allClosed && this.#phase === "live") {
      this.#retire(null);
      return;
    }
    this.#retire(
      transportError("stream-closed", "The pane-stream connection closed.", true),
      undefined,
      undefined,
    );
  };

  readonly #onError = (): void => {
    if (this.#phase === "closed") return;
    this.#retire(
      transportError("socket-unavailable", "The pane-stream WebSocket became unavailable.", true),
      1011,
      "socket-unavailable",
    );
  };

  readonly #onMessage = (event: PaneStreamSocketEvent): void => {
    if (this.#phase === "closed") return;
    if (this.#phase === "opening") {
      this.#protocolFailure();
      return;
    }
    if (!this.#acceptInboundFrame()) return;
    if (
      typeof event.data !== "string" ||
      event.data.length === 0 ||
      event.data.length > PANE_STREAM_MAX_SERVER_FRAME_CHARS
    ) {
      this.#retire(
        transportError(
          "invalid-server-frame",
          "The daemon sent an out-of-bounds pane-stream frame.",
          true,
        ),
        1009,
        "invalid-server-frame",
      );
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      this.#protocolFailure();
      return;
    }
    const parsed = PaneStreamServerFrameSchemaZ.safeParse(raw);
    if (!parsed.success) {
      this.#protocolFailure();
      return;
    }
    this.#handleFrame(parsed.data);
  };

  #acceptInboundFrame(): boolean {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.#rateWindowStartedAt ||
      now - this.#rateWindowStartedAt >= PANE_STREAM_RATE_WINDOW_MS
    ) {
      this.#rateWindowStartedAt = Number.isSafeInteger(now) ? now : this.#rateWindowStartedAt;
      this.#inboundFrames = 0;
    }
    this.#inboundFrames += 1;
    if (this.#inboundFrames <= PANE_STREAM_MAX_INBOUND_FRAMES_PER_WINDOW) return true;
    this.#retire(
      transportError(
        "inbound-frame-rate-limit",
        "The daemon exceeded the pane-stream frame-rate limit.",
        true,
      ),
      1008,
      "inbound-frame-rate-limit",
    );
    return false;
  }

  #handleFrame(frame: PaneStreamServerFrame): void {
    if (frame.type === "ready") {
      if (
        this.#phase !== "redeeming" ||
        frame.daemonInstanceId !== this.#descriptor.daemonInstanceId ||
        frame.requestId !== this.#descriptor.requestId ||
        frame.effectiveViewerMode !== this.#descriptor.effectiveViewerMode ||
        frame.panes.length !== this.#descriptor.panes.length ||
        frame.panes.some((pane, index) => pane !== this.#descriptor.panes[index])
      ) {
        this.#protocolFailure();
        return;
      }
      this.#phase = "live";
      this.#cancelRedeemResponse?.();
      this.#cancelRedeemResponse = null;
      this.#cancelLifetime = this.#schedule(
        () =>
          this.#retire(
            transportError(
              "connection-lifetime-limit",
              "The pane stream reached its maximum connection lifetime.",
              true,
            ),
            1008,
            "connection-lifetime-limit",
          ),
        PANE_STREAM_MAX_CONNECTION_LIFETIME_MS,
      );
      this.#settleConnect({
        status: "connected",
        session: Object.freeze({
          dispose: this.dispose,
          updatePresence: this.updatePresence,
          noteActivity: this.noteActivity,
          write: this.write,
          resize: this.resize,
        }),
      });
      if (frame.authority) this.#applyAuthoritySnapshot(frame.authority);
      return;
    }

    if (frame.type === "error") {
      const retryable =
        frame.retryable ||
        frame.code === "live-capacity-exhausted" ||
        frame.code === "ticket-expired";
      this.#retire(
        transportError(
          frame.code,
          STREAM_ERROR_REASON[frame.code] ?? "The daemon retired this pane stream.",
          retryable,
        ),
        1008,
        frame.code,
      );
      return;
    }

    if (this.#phase !== "live") {
      this.#protocolFailure();
      return;
    }

    if (frame.type === "layout") {
      try {
        this.#listeners.onLayout?.(frame);
      } catch {
        // A layout consumer fault cannot destabilize the byte stream.
      }
      return;
    }

    if (frame.type === "input-ack") {
      const settle = this.#inputWaiters.get(frame.seq);
      if (!settle) {
        this.#protocolFailure();
        return;
      }
      this.#inputWaiters.delete(frame.seq);
      settle();
      return;
    }
    if (frame.type === "authority-snapshot") {
      this.#applyAuthoritySnapshot(frame.snapshot);
      return;
    }
    if (frame.type === "authority-receipt") {
      if (frame.status === "granted" && frame.lease) {
        this.#heldAuthorities.add(frame.authority);
        this.#authorityClientIds.set(frame.authority, frame.lease.clientId);
      } else {
        this.#heldAuthorities.delete(frame.authority);
        this.#authorityClientIds.delete(frame.authority);
      }
      this.#applyAuthoritySnapshot(frame.snapshot);
      const settle = this.#authorityWaiters.get(frame.requestId);
      this.#authorityWaiters.delete(frame.requestId);
      settle?.(frame.status === "granted" && this.#heldAuthorities.has(frame.authority));
      return;
    }
    if (frame.type === "viewport-ack") {
      const settle = this.#viewportWaiters.get(frame.seq);
      if (!settle) {
        this.#protocolFailure();
        return;
      }
      this.#viewportWaiters.delete(frame.seq);
      settle();
      return;
    }

    const addressedChannel = "pane" in frame ? this.#panes.get(frame.pane) : undefined;
    if ("pane" in frame && (!addressedChannel || addressedChannel.closed)) {
      // Pane lanes are monotonic. Once closed/faulted, no later ready, seed or
      // patch can resurrect the lane or reset its generation/revision.
      this.#protocolFailure();
      return;
    }

    if (frame.type === "terminal-delivery-ready") {
      const channel = addressedChannel!;
      if (
        channel.semanticPhase !== "awaiting" ||
        channel.semanticDelivery !== null ||
        !frame.negotiation.accepted
      ) {
        this.#protocolFailure();
        return;
      }
      channel.semanticDelivery = createTerminalDeliveryClientState(
        frame.negotiation.negotiated,
        this.#descriptor.workspaceName,
        frame.pane,
      );
      channel.semanticPhase = "live";
      channel.semanticAssembler = null;
      return;
    }
    if (frame.type === "terminal-delivery-envelope") {
      const channel = addressedChannel!;
      if (
        channel.semanticPhase !== "live" ||
        !channel.semanticDelivery ||
        frame.envelope.semanticPaneId !== frame.pane
      ) {
        this.#protocolFailure();
        return;
      }
      const next = admitTerminalDeliveryEnvelope(channel.semanticDelivery, frame.envelope);
      if (next.failed) {
        this.#protocolFailure();
        return;
      }
      channel.semanticDelivery = next;
      if (this.#performanceTelemetry?.enabled) {
        this.#performanceTelemetry.recordRevisionLag(
          Math.max(0, frame.envelope.canonicalRevision - next.appliedRevision),
        );
      }
      channel.semanticAssembler = new TerminalDeliveryAssembler(frame.envelope);
      return;
    }
    if (frame.type === "terminal-delivery-chunk") {
      const channel = addressedChannel!;
      if (
        channel.semanticPhase !== "live" ||
        !channel.semanticDelivery ||
        !channel.semanticAssembler
      ) {
        this.#protocolFailure();
        return;
      }
      try {
        const decoded = decodeBase64(frame.data);
        if (!decoded) throw new TypeError("Terminal delivery chunk was not base64");
        const bytes = new Uint8Array(decoded);
        channel.semanticAssembler.write({
          type: "terminal.delivery.chunk",
          transactionId: frame.transactionId,
          index: frame.index,
          bytes,
        });
        channel.semanticDelivery = admitTerminalDeliveryChunk(channel.semanticDelivery, {
          type: "terminal.delivery.chunk",
          transactionId: frame.transactionId,
          index: frame.index,
          bytes,
        });
        const envelope = channel.semanticDelivery.inFlight;
        if (!envelope || channel.semanticDelivery.nextChunk !== envelope.chunkCount) return;
        const staged = completeTerminalDelivery(
          channel.semanticDelivery,
          channel.semanticAssembler,
        );
        const previousSnapshot = channel.semanticDelivery.canonicalSnapshot;
        const committed = commitTerminalDelivery(channel.semanticDelivery, staged);
        const semanticUpdate = committed.semanticUpdate;
        if (!semanticUpdate) throw new TypeError("Semantic delivery did not produce an update");
        channel.semanticDelivery = committed.state;
        if (this.#performanceTelemetry?.enabled) this.#performanceTelemetry.recordRevisionLag(0);
        channel.semanticAssembler = null;
        const snapshot = committed.state.canonicalSnapshot;
        if (!snapshot) {
          this.#deliverSemantic(channel, { type: "closed" }, committed.ack);
          return;
        }
        if (semanticUpdate.frame === "tombstone") {
          throw new TypeError("Semantic tombstone retained a canonical snapshot");
        }
        if (semanticUpdate.frame === "patch" && !previousSnapshot) {
          throw new TypeError("Semantic patch did not retain its exact canonical baseline");
        }
        if (!committed.state.incarnation || !committed.state.appliedHash) {
          throw new TypeError("Semantic delivery did not retain its exact canonical identity");
        }
        if (semanticUpdate.frame === "seed") channel.sourceEpoch += 1;
        const fullGridWalk =
          semanticUpdate.frame === "seed" ||
          semanticUpdate.patch.dimensions !== undefined ||
          previousSnapshot?.modes.alternateScreen !== snapshot.modes.alternateScreen;
        const projectedRows =
          semanticUpdate.frame === "patch" && !fullGridWalk
            ? semanticUpdate.patch.rows.map(({ row }) => row)
            : snapshot.grid;
        const canonical = Object.freeze({
          deliveryRequestId: this.#descriptor.requestId,
          generation: committed.state.negotiated.generation,
          incarnation: committed.state.incarnation,
          revision: committed.state.appliedRevision,
          stateHash: committed.state.appliedHash,
          cols: snapshot.cols,
          rows: snapshot.rows,
          sourceEpoch: channel.sourceEpoch,
          alternateScreen: snapshot.modes.alternateScreen,
          cursor: Object.freeze({ ...snapshot.cursor }),
          gridRowsRead: projectedRows.length,
          gridCellsRead: projectedRows.reduce((total, row) => total + row.cells.length, 0),
          fullGridWalks: fullGridWalk ? 1 : 0,
        } satisfies PaneMirrorCanonicalProjection);
        const ansi =
          semanticUpdate.frame === "patch" && previousSnapshot
            ? encodeAnsiTerminalPatchRepresentation(
                semanticUpdate.patch,
                snapshot,
                previousSnapshot,
              )
            : encodeAnsiTerminalRepresentation(previousSnapshot, snapshot);
        const requiresAtomicReset =
          !previousSnapshot ||
          previousSnapshot.cols !== snapshot.cols ||
          previousSnapshot.rows !== snapshot.rows;
        this.#deliverSemantic(
          channel,
          requiresAtomicReset
            ? {
                type: "seed-batch",
                canonical,
                batch: {
                  reset: { cols: snapshot.cols, rows: snapshot.rows },
                  seed: ansi,
                  held: [],
                  cursor: { x: snapshot.cursor.x, y: snapshot.cursor.y },
                },
              }
            : {
                type: "output",
                bytes: ansi,
                canonical,
                // Snapshot state already exists for semantic validation. Keep
                // it by reference and do the full-grid ANSI materialization
                // only if a replacement sink actually asks for a repaint.
                replay: () => ({
                  reset: { cols: snapshot.cols, rows: snapshot.rows },
                  seed: encodeAnsiTerminalRepresentation(null, snapshot),
                  held: [],
                  cursor: { x: snapshot.cursor.x, y: snapshot.cursor.y },
                }),
              },
          committed.ack,
        );
      } catch {
        this.#protocolFailure();
      }
      return;
    }
    if (frame.type === "terminal-delivery-fault") {
      const channel = addressedChannel!;
      channel.semanticPhase = "faulted";
      channel.closed = true;
      channel.semanticAssembler = null;
      this.#deliverSemantic(channel, { type: "closed" }, null);
      return;
    }

    // Keep the legacy parser closed over the old sequenced profile. Semantic
    // delivery frames were consumed above and use transaction acknowledgements.
    if (
      frame.type !== "seed-batch" &&
      frame.type !== "output" &&
      frame.type !== "cursor" &&
      frame.type !== "flow" &&
      frame.type !== "closed"
    ) {
      this.#protocolFailure();
      return;
    }

    const channel = this.#panes.get(frame.pane);
    if (!channel || channel.closed || frame.seq !== channel.receivedSeq + 1) {
      this.#protocolFailure();
      return;
    }
    if (
      channel.semanticPhase === "live" &&
      (frame.type === "seed-batch" ||
        frame.type === "output" ||
        frame.type === "cursor" ||
        frame.type === "flow")
    ) {
      // Negotiation is a one-way cutover. Accepting legacy bytes afterwards
      // creates two competing revision lanes and can repaint stale terminal state.
      this.#protocolFailure();
      return;
    }
    channel.receivedSeq = frame.seq;

    if (frame.type === "closed") {
      channel.closed = true;
      this.#deliver(channel, frame.seq, { type: "closed" });
      return;
    }
    if (frame.type === "flow") {
      this.#deliver(channel, frame.seq, {
        type: "flow",
        state: frame.state,
        reason: frame.reason,
      });
      return;
    }
    if (frame.type === "cursor") {
      this.#deliver(channel, frame.seq, { type: "cursor", x: frame.x, y: frame.y });
      return;
    }
    if (frame.type === "output") {
      const bytes = decodeBase64(frame.data);
      if (!bytes) {
        this.#protocolFailure();
        return;
      }
      this.#deliver(channel, frame.seq, { type: "output", bytes });
      return;
    }
    // seed-batch: decode every part, then hand the consumer ONE atomic paint.
    const seed = decodeBase64(frame.seed);
    const held: Uint8Array[] = [];
    let decodable = seed !== null;
    for (const chunk of frame.held) {
      const bytes = decodeBase64(chunk);
      if (!bytes) {
        decodable = false;
        break;
      }
      held.push(bytes);
    }
    if (!decodable || seed === null) {
      this.#protocolFailure();
      return;
    }
    this.#deliver(channel, frame.seq, {
      type: "seed-batch",
      batch: { reset: frame.reset, seed, held, cursor: frame.cursor },
    });
  }

  /**
   * Per-pane FIFO apply queue. The cumulative `consumed` ack for a sequence is
   * sent only after the consumer settles that event; a consumer fault retires
   * the session (the daemon force-returns its flow tickets on close).
   */
  #deliver(channel: PaneChannel, seq: number, event: PaneMirrorEvent): void {
    if (channel.pendingApplies >= PANE_STREAM_MAX_PENDING_EVENTS_PER_PANE) {
      this.#retire(
        transportError(
          "renderer-backpressure",
          "The renderer could not keep up with the pane stream.",
          true,
        ),
        1013,
        "renderer-backpressure",
      );
      return;
    }
    channel.pendingApplies += 1;
    this.#recordPendingApplyCount();
    channel.applyTail = channel.applyTail
      .then(async () => {
        if (this.#phase === "closed") return;
        await this.#listeners.onPaneEvent(channel.pane, event);
        channel.appliedSeq = seq;
        this.#acknowledge(channel);
      })
      .catch(() => {
        if (this.#phase === "closed") return;
        this.#retire(
          transportError(
            "renderer-consumer-failed",
            "The renderer could not consume the pane stream.",
            true,
          ),
          1013,
          "renderer-consumer-failed",
        );
      })
      .finally(() => {
        channel.pendingApplies -= 1;
        this.#recordPendingApplyCount();
      });
  }

  #deliverSemantic(
    channel: PaneChannel,
    event: PaneMirrorEvent,
    ack: TerminalDeliveryAck | null,
  ): void {
    if (channel.pendingApplies >= PANE_STREAM_MAX_PENDING_EVENTS_PER_PANE) {
      this.#retire(
        transportError(
          "renderer-backpressure",
          "The renderer could not keep up with the pane stream.",
          true,
        ),
        1013,
        "renderer-backpressure",
      );
      return;
    }
    channel.pendingApplies += 1;
    this.#recordPendingApplyCount();
    channel.applyTail = channel.applyTail
      .then(async () => {
        if (this.#phase === "closed") return;
        await this.#listeners.onPaneEvent(channel.pane, event);
        if (ack && this.#socket.readyState === WS_OPEN) {
          this.#socket.send(JSON.stringify({ type: "terminal-delivery-ack", ack }));
        }
      })
      .catch(() => {
        if (this.#phase !== "closed") {
          this.#retire(
            transportError(
              "renderer-consumer-failed",
              "The renderer could not consume the pane stream.",
              true,
            ),
            1013,
            "renderer-consumer-failed",
          );
        }
      })
      .finally(() => {
        channel.pendingApplies -= 1;
        this.#recordPendingApplyCount();
      });
  }

  #recordPendingApplyCount(): void {
    const telemetry = this.#performanceTelemetry;
    if (!telemetry?.enabled) return;
    let count = 0;
    for (const channel of this.#panes.values()) count += channel.pendingApplies;
    telemetry.recordQueueDepth(count, PANE_STREAM_MAX_PENDING_EVENTS_PER_PANE * this.#panes.size);
  }

  #acknowledge(channel: PaneChannel): void {
    if (
      this.#phase !== "live" ||
      this.#socket.readyState !== WS_OPEN ||
      channel.appliedSeq <= channel.consumedSeq
    ) {
      return;
    }
    const frame = JSON.stringify({
      type: "consumed",
      pane: channel.pane,
      seq: channel.appliedSeq,
    });
    try {
      this.#socket.send(frame);
      channel.consumedSeq = channel.appliedSeq;
    } catch {
      this.#retire(
        transportError("socket-unavailable", "The pane-stream WebSocket became unavailable.", true),
        1011,
        "socket-unavailable",
      );
    }
  }

  #applyAuthoritySnapshot(snapshot: SessionRuntimeAuthoritySnapshot): void {
    for (const authority of ["input", "focus", "geometry"] as const) {
      const knownClientId = this.#authorityClientIds.get(authority);
      if (!knownClientId || snapshot.owners[authority] !== knownClientId) {
        this.#heldAuthorities.delete(authority);
        this.#authorityClientIds.delete(authority);
      }
    }
    this.#listeners.onAuthoritySnapshot?.(snapshot);
  }

  #protocolFailure(): void {
    this.#retire(
      transportError("protocol-error", "The pane-stream WebSocket protocol was invalid.", false),
      1002,
      "protocol-error",
    );
  }

  #settleConnect(result: PaneStreamConnectResult): void {
    if (this.#connectSettled) return;
    this.#connectSettled = true;
    this.#resolveConnect(result);
  }

  #retire(error: PaneStreamTransportError | null, closeCode?: number, closeReason?: string): void {
    if (this.#phase === "closed") return;
    const wasLive = this.#phase === "live";
    this.#phase = "closed";
    this.#redemptionFrame = null;
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
    this.#cancelRedeemResponse?.();
    this.#cancelRedeemResponse = null;
    this.#cancelLifetime?.();
    this.#cancelLifetime = null;
    this.#socket.removeEventListener("open", this.#onOpen);
    this.#socket.removeEventListener("message", this.#onMessage);
    this.#socket.removeEventListener("close", this.#onClose);
    this.#socket.removeEventListener("error", this.#onError);
    if (!this.#connectSettled) {
      this.#settleConnect({
        status: "error",
        error: error ?? transportError("disposed", "The pane stream was disposed.", false),
      });
    } else if (wasLive && !this.#endNotified) {
      this.#endNotified = true;
      try {
        this.#listeners.onEnd(error);
      } catch {
        // The session is already retired; a listener fault changes nothing.
      }
    }
    if (
      closeCode !== undefined &&
      (this.#socket.readyState === WS_CONNECTING ||
        this.#socket.readyState === WS_OPEN ||
        this.#socket.readyState === WS_CLOSING)
    ) {
      try {
        this.#socket.close(
          browserInitiatedWebSocketCloseCode(closeCode),
          closeReason?.slice(0, 123),
        );
      } catch {
        // Local authority is already retired.
      }
    }
  }
}

type IssueOutcome =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "error"; readonly error?: unknown };

function issueWithTimeout(
  issuePaneStream: PaneStreamIssueLease,
  request: PaneStreamLeaseRequest,
  timeoutMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<IssueOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let cancelTimeout = (): void => undefined;
    const finish = (result: IssueOutcome): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      resolve(result);
    };
    const scheduledCancellation = schedule(() => finish({ status: "error" }), timeoutMs);
    cancelTimeout = scheduledCancellation;
    if (settled) scheduledCancellation();
    void Promise.resolve()
      .then(() => issuePaneStream(request))
      .then(
        (value) => finish({ status: "ok", value }),
        (error: unknown) => finish({ status: "error", error }),
      );
  });
}

/**
 * Renderer-owned direct pane-stream WebSocket adapter. The injected issue
 * function is the only privileged seam; mirror nodes never see a URL, ticket,
 * or daemon identity.
 */
export function createPaneStreamTransport(
  dependencies: PaneStreamTransportDependencies,
): PaneStreamTransport {
  if (typeof dependencies.issuePaneStream !== "function") {
    throw new TypeError("Pane-stream transport requires an issuePaneStream function.");
  }
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const createWebSocket = dependencies.createWebSocket ?? defaultCreateWebSocket;
  const issueTimeoutMs = boundedIssueTimeout(dependencies.issueTimeoutMs);
  const terminalDelivery =
    dependencies.terminalDelivery === undefined
      ? ({
          protocolVersions: [1],
          encodings: ["semantic-compact-v1", "semantic-v1"],
          richPlacements: true,
        } as const)
      : dependencies.terminalDelivery;

  return Object.freeze({
    connect: async (
      request: PaneStreamRequest,
      listeners: PaneStreamSessionListeners,
    ): Promise<PaneStreamConnectResult> => {
      const parsedRequest = PaneStreamLeaseRequestSchemaZ.safeParse({
        protocolVersion: PANE_STREAM_PROTOCOL_VERSION,
        workspaceName: request.workspaceName,
        panes: request.panes,
        viewerMode: request.viewerMode ?? "read-only",
        ...(terminalDelivery ? { terminalDelivery } : {}),
      });
      if (
        !parsedRequest.success ||
        parsedRequest.data.panes.length > PANE_STREAM_MAX_PANES ||
        typeof listeners.onPaneEvent !== "function" ||
        typeof listeners.onEnd !== "function"
      ) {
        return {
          status: "error",
          error: transportError(
            "invalid-request",
            "The semantic pane-stream request is invalid.",
            false,
          ),
        };
      }

      const issued = await issueWithTimeout(
        dependencies.issuePaneStream,
        parsedRequest.data,
        issueTimeoutMs,
        schedule,
      );
      if (issued.status === "error") {
        return { status: "error", error: issueErrorToTransportError(issued.error) };
      }
      const descriptor = validateIssueDescriptor(issued.value, parsedRequest.data, now());
      if (!descriptor) {
        return {
          status: "error",
          error: transportError(
            "invalid-descriptor",
            "The desktop host returned an invalid pane-stream descriptor.",
            false,
          ),
        };
      }

      let socket: PaneStreamWebSocket;
      try {
        socket = createWebSocket(
          browserWebSocketHandshakeUrl(descriptor.webSocketUrl),
          PANE_STREAM_TRANSPORT_PROTOCOL,
        );
      } catch {
        return {
          status: "error",
          error: transportError(
            "socket-unavailable",
            "The pane-stream WebSocket could not be created.",
            true,
          ),
        };
      }
      return new PaneStreamSession({
        descriptor,
        socket,
        listeners,
        schedule,
        now,
        performanceTelemetry: dependencies.performanceTelemetry,
      }).start();
    },
  });
}
