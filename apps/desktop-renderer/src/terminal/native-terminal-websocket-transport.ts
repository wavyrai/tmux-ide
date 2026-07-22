import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL,
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentIssueDescriptorSchemaZ,
  TerminalAttachmentViewerModeSchemaZ,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentViewerMode,
  type TerminalAttachmentViewport,
} from "@tmux-ide/contracts";

import type {
  NativeTerminalAttachment,
  NativeTerminalConnectResult,
  NativeTerminalEvent,
  NativeTerminalMutationResult,
  NativeTerminalTransport,
  NativeTerminalTransportError,
} from "./native-terminal-transport.ts";

export const NATIVE_TERMINAL_WEBSOCKET_PROTOCOL = TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL;
export const NATIVE_TERMINAL_MAX_CONTROL_BYTES = 4 * 1024;
export const NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES = 256 * 1024;
export const NATIVE_TERMINAL_MAX_QUEUED_EVENT_BYTES = 1024 * 1024;
export const NATIVE_TERMINAL_MAX_QUEUED_EVENTS = 32;
export const NATIVE_TERMINAL_MAX_CONTROL_FRAMES = 1_024;
export const NATIVE_TERMINAL_MAX_SOCKET_BUFFERED_BYTES = 64 * 1024;
export const NATIVE_TERMINAL_MAX_DESCRIPTOR_LIFETIME_MS = 60_000;
export const NATIVE_TERMINAL_DEFAULT_ISSUE_TIMEOUT_MS = 5_000;
export const NATIVE_TERMINAL_RATE_WINDOW_MS = 1_000;
export const NATIVE_TERMINAL_MAX_INBOUND_FRAMES_PER_WINDOW = 4_096;
export const NATIVE_TERMINAL_MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW = 256;
export const NATIVE_TERMINAL_MAX_CONNECTION_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const NATIVE_TERMINAL_RESIZE_ACK_TIMEOUT_MS = 5_000;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const RequestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ErrorCodePattern = /^[a-z][a-z0-9_-]{0,79}$/u;

type SocketEventType = "open" | "message" | "close" | "error";

export interface NativeTerminalSocketEvent {
  readonly data?: unknown;
}

export type NativeTerminalSocketListener = (event: NativeTerminalSocketEvent) => void;

/** Browser WebSocket subset used by the renderer-only transport and deterministic tests. */
export interface NativeTerminalWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  readonly protocol: string;
  binaryType: BinaryType;
  addEventListener(type: SocketEventType, listener: NativeTerminalSocketListener): void;
  removeEventListener(type: SocketEventType, listener: NativeTerminalSocketListener): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export type NativeTerminalWebSocketFactory = (
  url: string,
  protocol: string,
) => NativeTerminalWebSocket;

/** The unreviewed host result stays unknown until this card-local parser accepts it. */
export type NativeTerminalIssueAttachment = (request: TerminalAttachRequest) => Promise<unknown>;

export interface NativeTerminalWebSocketTransportDependencies {
  /** Privileged issue call injected by a future host adapter; never a stream proxy. */
  readonly issueAttachment: NativeTerminalIssueAttachment;
  readonly createWebSocket?: NativeTerminalWebSocketFactory;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly issueTimeoutMs?: number;
}

interface SafeIssueDescriptor {
  readonly webSocketUrl: string;
  readonly webSocketProtocol: typeof NATIVE_TERMINAL_WEBSOCKET_PROTOCOL;
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly effectiveViewerMode: TerminalAttachmentViewerMode;
  readonly redemptionFrame: string;
}

// Card-local projections of untrusted daemon frames. They deliberately are
// not exported as a public wire contract; every field is checked below before
// it can affect renderer state.
interface ReadyFrame {
  readonly type: "ready";
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly generation: number;
  readonly effectiveViewerMode: TerminalAttachmentViewerMode;
  readonly sourceGrid: TerminalAttachmentViewport;
  readonly clientViewport: TerminalAttachmentViewport;
}

interface GeometryFrame {
  readonly type: "geometry";
  readonly generation: number;
  readonly sourceGrid: TerminalAttachmentViewport;
  readonly clientViewport: TerminalAttachmentViewport;
}

interface ExitFrame {
  readonly type: "exit";
  readonly generation: number;
  readonly exitCode: number;
  readonly signal: number | null;
}

interface ErrorFrame {
  readonly type: "error" | "mutation-error";
  readonly code: string;
  readonly retryable: boolean;
}

type ServerControlFrame = ReadyFrame | GeometryFrame | ExitFrame | ErrorFrame;

interface QueuedEvent {
  readonly event: NativeTerminalEvent;
  readonly byteLength: number;
}

interface ResizeRequest {
  readonly viewport: TerminalAttachmentViewport;
  readonly promise: Promise<NativeTerminalMutationResult>;
  readonly resolve: (result: NativeTerminalMutationResult) => void;
  settled: boolean;
}

interface SentResize {
  readonly viewport: TerminalAttachmentViewport;
  request: ResizeRequest | null;
  cancelTimeout: () => void;
}

function defaultCreateWebSocket(url: string, protocol: string): NativeTerminalWebSocket {
  return new globalThis.WebSocket(url, protocol) as unknown as NativeTerminalWebSocket;
}

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = globalThis.setTimeout(callback, delayMs);
  return () => globalThis.clearTimeout(timer);
}

function transportError(
  code: string,
  reason: string,
  retryable: boolean,
): NativeTerminalTransportError {
  return Object.freeze({ code, reason, retryable });
}

const INPUT_UNAVAILABLE = transportError(
  "input-backpressure-unavailable",
  "Terminal input is unavailable until the daemon enables bounded input recovery.",
  false,
);

function errorResult(error: NativeTerminalTransportError): NativeTerminalMutationResult {
  return { status: "error", error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function safeIdentity(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/u.test(value)
  );
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function boundedControlByteLength(value: string): number | null {
  // A UTF-16 code unit always contributes at least one UTF-8 byte. Reject on
  // that allocation-free lower bound before TextEncoder can copy hostile text.
  if (value.length === 0 || value.length > NATIVE_TERMINAL_MAX_CONTROL_BYTES) return null;
  const byteLength = new TextEncoder().encode(value).byteLength;
  return byteLength <= NATIVE_TERMINAL_MAX_CONTROL_BYTES ? byteLength : null;
}

function validateIssueDescriptor(
  value: unknown,
  request: TerminalAttachRequest,
  now: number,
): SafeIssueDescriptor | null {
  const parsed = TerminalAttachmentIssueDescriptorSchemaZ.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.expiresAt <= now ||
    parsed.data.expiresAt - now > NATIVE_TERMINAL_MAX_DESCRIPTOR_LIFETIME_MS
  )
    return null;
  const descriptor = parsed.data;

  const redemptionFrame = JSON.stringify({
    type: "redeem",
    protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
    ticket: descriptor.redemptionTicket,
    requestId: descriptor.requestId,
    daemonInstanceId: descriptor.daemonInstanceId,
  });
  if (boundedControlByteLength(redemptionFrame) === null) return null;

  // A mode change is allowed only when it is explicit in both issue and ready;
  // the renderer never infers authority from the requested mode.
  void request;
  return {
    webSocketUrl: descriptor.webSocketUrl,
    webSocketProtocol: NATIVE_TERMINAL_WEBSOCKET_PROTOCOL,
    daemonInstanceId: descriptor.daemonInstanceId,
    requestId: descriptor.requestId,
    expiresAt: descriptor.expiresAt,
    effectiveViewerMode: descriptor.effectiveViewerMode,
    redemptionFrame,
  };
}

function parseControlFrame(text: string): ServerControlFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.protocolVersion !== TERMINAL_ATTACHMENT_PROTOCOL_VERSION) {
    return null;
  }

  if (value.type === "ready") {
    if (
      !hasExactKeys(value, [
        "clientViewport",
        "daemonInstanceId",
        "effectiveViewerMode",
        "generation",
        "inputCapability",
        "protocolVersion",
        "requestId",
        "sourceGrid",
        "type",
      ]) ||
      !safeInteger(value.generation) ||
      value.generation < 0 ||
      value.inputCapability !== "unavailable" ||
      !safeIdentity(value.daemonInstanceId, 4_096) ||
      typeof value.requestId !== "string" ||
      !RequestIdPattern.test(value.requestId) ||
      !TerminalAttachmentViewportSchemaZ.safeParse(value.sourceGrid).success ||
      !TerminalAttachmentViewportSchemaZ.safeParse(value.clientViewport).success
    ) {
      return null;
    }
    const viewerMode = TerminalAttachmentViewerModeSchemaZ.safeParse(value.effectiveViewerMode);
    if (!viewerMode.success) return null;
    return {
      type: "ready",
      daemonInstanceId: value.daemonInstanceId,
      requestId: value.requestId,
      generation: value.generation,
      effectiveViewerMode: viewerMode.data,
      sourceGrid: TerminalAttachmentViewportSchemaZ.parse(value.sourceGrid),
      clientViewport: TerminalAttachmentViewportSchemaZ.parse(value.clientViewport),
    };
  }

  if (value.type === "geometry") {
    if (
      !hasExactKeys(value, [
        "clientViewport",
        "generation",
        "protocolVersion",
        "sourceGrid",
        "type",
      ]) ||
      !safeInteger(value.generation) ||
      value.generation < 0 ||
      !TerminalAttachmentViewportSchemaZ.safeParse(value.sourceGrid).success ||
      !TerminalAttachmentViewportSchemaZ.safeParse(value.clientViewport).success
    ) {
      return null;
    }
    return {
      type: "geometry",
      generation: value.generation,
      sourceGrid: TerminalAttachmentViewportSchemaZ.parse(value.sourceGrid),
      clientViewport: TerminalAttachmentViewportSchemaZ.parse(value.clientViewport),
    };
  }

  if (value.type === "exit") {
    if (
      !hasExactKeys(value, ["exitCode", "generation", "protocolVersion", "signal", "type"]) ||
      !safeInteger(value.generation) ||
      value.generation < 0 ||
      !safeInteger(value.exitCode) ||
      !(value.signal === null || safeInteger(value.signal))
    ) {
      return null;
    }
    return {
      type: "exit",
      generation: value.generation,
      exitCode: value.exitCode,
      signal: value.signal,
    };
  }

  if (value.type === "error") {
    if (
      !hasExactKeys(value, ["code", "protocolVersion", "retryable", "type"]) ||
      typeof value.code !== "string" ||
      !ErrorCodePattern.test(value.code) ||
      typeof value.retryable !== "boolean"
    ) {
      return null;
    }
    return { type: "error", code: value.code, retryable: value.retryable };
  }

  if (value.type === "mutation-error") {
    if (
      !hasExactKeys(value, ["code", "mutation", "protocolVersion", "retryable", "type"]) ||
      value.mutation !== "input" ||
      typeof value.code !== "string" ||
      !ErrorCodePattern.test(value.code) ||
      typeof value.retryable !== "boolean"
    ) {
      return null;
    }
    return { type: "mutation-error", code: value.code, retryable: value.retryable };
  }

  return null;
}

function controlError(frame: ErrorFrame): NativeTerminalTransportError {
  const reasons: Readonly<Record<string, string>> = {
    "attachment-renewal-failed": "The terminal attachment could not renew its lease.",
    "input-backpressure-unavailable": INPUT_UNAVAILABLE.reason,
    "resize-unavailable": "The daemon could not resize this terminal attachment.",
  };
  return transportError(
    frame.code,
    reasons[frame.code] ?? "The daemon retired this terminal attachment.",
    frame.retryable,
  );
}

function binaryByteLength(value: unknown): number | null {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

function copyBinaryBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError("Terminal output frame is not binary.");
}

function boundedIssueTimeout(value: number | undefined): number {
  const selected = value ?? NATIVE_TERMINAL_DEFAULT_ISSUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 30_000) {
    throw new TypeError("Native terminal issue timeout is invalid.");
  }
  return selected;
}

function sameViewport(
  left: TerminalAttachmentViewport,
  right: TerminalAttachmentViewport,
): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}

function resizeRequest(viewport: TerminalAttachmentViewport): ResizeRequest {
  let resolve!: (result: NativeTerminalMutationResult) => void;
  const promise = new Promise<NativeTerminalMutationResult>((settle) => {
    resolve = settle;
  });
  return { viewport, promise, resolve, settled: false };
}

class NativeTerminalWebSocketSession {
  readonly #socket: NativeTerminalWebSocket;
  readonly #listener: (event: NativeTerminalEvent) => void | Promise<void>;
  readonly #identity: Omit<SafeIssueDescriptor, "redemptionFrame">;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #now: () => number;
  readonly #eventQueue: QueuedEvent[] = [];
  readonly #attachment: NativeTerminalAttachment;
  readonly #connectPromise: Promise<NativeTerminalConnectResult>;
  #resolveConnect!: (result: NativeTerminalConnectResult) => void;
  #redemptionFrame: string | null;
  #cancelExpiry: (() => void) | null = null;
  #cancelLifetime: (() => void) | null = null;
  #phase: "opening" | "redeeming" | "live" | "closed" = "opening";
  #generation: number | null = null;
  #connectSettled = false;
  #notifiedDisconnected = false;
  #eventCount = 0;
  #eventBytes = 0;
  #delivering = false;
  #queuedResize: ResizeRequest | null = null;
  #sentResize: SentResize | null = null;
  #resizeFlushScheduled = false;
  #outboundControlFrames = 0;
  #rateWindowStartedAt: number;
  #inboundFrames = 0;
  #inboundControlFrames = 0;

  constructor(options: {
    readonly descriptor: SafeIssueDescriptor;
    readonly socket: NativeTerminalWebSocket;
    readonly listener: (event: NativeTerminalEvent) => void | Promise<void>;
    readonly schedule: (callback: () => void, delayMs: number) => () => void;
    readonly now: () => number;
  }) {
    this.#socket = options.socket;
    this.#listener = options.listener;
    this.#schedule = options.schedule;
    this.#now = options.now;
    this.#rateWindowStartedAt = options.now();
    const { redemptionFrame, ...identity } = options.descriptor;
    this.#redemptionFrame = redemptionFrame;
    this.#identity = identity;
    this.#connectPromise = new Promise((resolve) => {
      this.#resolveConnect = resolve;
    });
    this.#attachment = Object.freeze({
      write: (bytes: Uint8Array) => this.#write(bytes),
      resize: (viewport: TerminalAttachmentViewport) => this.#resize(viewport),
      dispose: () => this.#dispose(),
    });
  }

  start(): Promise<NativeTerminalConnectResult> {
    this.#socket.binaryType = "arraybuffer";
    this.#socket.addEventListener("open", this.#onOpen);
    this.#socket.addEventListener("message", this.#onMessage);
    this.#socket.addEventListener("close", this.#onClose);
    this.#socket.addEventListener("error", this.#onError);
    const remaining = this.#identity.expiresAt - this.#now();
    if (remaining <= 0) {
      this.#retire(
        transportError("attachment-expired", "The terminal attachment ticket expired.", true),
        false,
        1008,
        "attachment-expired",
      );
    } else {
      this.#cancelExpiry = this.#schedule(
        () =>
          this.#retire(
            transportError("attachment-expired", "The terminal attachment ticket expired.", true),
            false,
            1008,
            "attachment-expired",
          ),
        remaining,
      );
    }
    return this.#connectPromise;
  }

  readonly #onOpen = (): void => {
    if (this.#phase !== "opening") return;
    if (
      this.#socket.protocol !== this.#identity.webSocketProtocol ||
      this.#socket.readyState !== WS_OPEN
    ) {
      this.#retire(
        transportError(
          "subprotocol-mismatch",
          "The terminal WebSocket negotiated an unexpected protocol.",
          false,
        ),
        false,
        1002,
        "subprotocol-mismatch",
      );
      return;
    }
    if (this.#now() >= this.#identity.expiresAt || !this.#redemptionFrame) {
      this.#retire(
        transportError("attachment-expired", "The terminal attachment ticket expired.", true),
        false,
        1008,
        "attachment-expired",
      );
      return;
    }
    const frame = this.#redemptionFrame;
    this.#redemptionFrame = null;
    this.#phase = "redeeming";
    const sendError = this.#sendControl(frame);
    if (sendError) return;
  };

  readonly #onMessage = (event: NativeTerminalSocketEvent): void => {
    if (this.#phase === "closed" || this.#phase === "opening") {
      if (this.#phase === "opening") this.#protocolFailure();
      return;
    }
    if (!this.#acceptInboundFrame(typeof event.data === "string")) return;
    if (typeof event.data === "string") {
      if (boundedControlByteLength(event.data) === null) {
        this.#retire(
          transportError(
            "control-frame-too-large",
            "The daemon sent an oversized terminal control frame.",
            true,
          ),
          this.#phase === "live",
          1009,
          "control-frame-too-large",
        );
        return;
      }
      const frame = parseControlFrame(event.data);
      if (!frame) {
        this.#protocolFailure();
        return;
      }
      this.#handleControl(frame);
      return;
    }
    const byteLength = binaryByteLength(event.data);
    if (byteLength === null || this.#phase !== "live") {
      this.#protocolFailure();
      return;
    }
    if (byteLength === 0) return;
    if (byteLength > NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES) {
      this.#retire(
        transportError(
          "output-frame-too-large",
          "The daemon sent an oversized terminal output frame.",
          true,
        ),
        true,
        1009,
        "output-frame-too-large",
      );
      return;
    }
    const bytes = copyBinaryBytes(event.data as ArrayBuffer | ArrayBufferView);
    this.#queueEvent({ type: "output", bytes }, byteLength);
  };

  #acceptInboundFrame(control: boolean): boolean {
    const now = this.#now();
    if (
      !Number.isSafeInteger(now) ||
      now < this.#rateWindowStartedAt ||
      now - this.#rateWindowStartedAt >= NATIVE_TERMINAL_RATE_WINDOW_MS
    ) {
      this.#rateWindowStartedAt = Number.isSafeInteger(now) ? now : this.#rateWindowStartedAt;
      this.#inboundFrames = 0;
      this.#inboundControlFrames = 0;
    }
    this.#inboundFrames += 1;
    if (control) this.#inboundControlFrames += 1;
    if (
      this.#inboundFrames <= NATIVE_TERMINAL_MAX_INBOUND_FRAMES_PER_WINDOW &&
      this.#inboundControlFrames <= NATIVE_TERMINAL_MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW
    ) {
      return true;
    }
    const controlExhausted =
      this.#inboundControlFrames > NATIVE_TERMINAL_MAX_INBOUND_CONTROL_FRAMES_PER_WINDOW;
    const error = transportError(
      controlExhausted ? "control-frame-rate-limit" : "inbound-frame-rate-limit",
      controlExhausted
        ? "The daemon exceeded the terminal control-frame rate limit."
        : "The daemon exceeded the terminal inbound frame-rate limit.",
      true,
    );
    this.#retire(error, this.#phase === "live", 1008, error.code);
    return false;
  }

  readonly #onClose = (): void => {
    if (this.#phase === "closed") return;
    this.#retire(
      transportError("attachment-closed", "The native tmux attachment closed.", true),
      this.#phase === "live",
      undefined,
      undefined,
      true,
    );
  };

  readonly #onError = (): void => {
    if (this.#phase === "closed") return;
    this.#retire(
      transportError("socket-unavailable", "The terminal WebSocket became unavailable.", true),
      this.#phase === "live",
      1011,
      "socket-unavailable",
    );
  };

  #handleControl(frame: ServerControlFrame): void {
    if (frame.type === "ready") {
      if (
        this.#phase !== "redeeming" ||
        frame.generation < 0 ||
        frame.effectiveViewerMode !== this.#identity.effectiveViewerMode ||
        frame.daemonInstanceId !== this.#identity.daemonInstanceId ||
        frame.requestId !== this.#identity.requestId
      ) {
        this.#protocolFailure();
        return;
      }
      this.#generation = frame.generation;
      this.#phase = "live";
      this.#cancelExpiry?.();
      this.#cancelExpiry = null;
      this.#cancelLifetime = this.#schedule(
        () =>
          this.#retire(
            transportError(
              "connection-lifetime-limit",
              "The terminal attachment reached its maximum connection lifetime.",
              true,
            ),
            true,
            1008,
            "connection-lifetime-limit",
          ),
        NATIVE_TERMINAL_MAX_CONNECTION_LIFETIME_MS,
      );
      if (this.#phase !== "live") return;
      this.#settleConnect({ status: "connected", attachment: this.#attachment });
      this.#queueEvent(
        {
          type: "state",
          state: "connected",
          error: null,
          sourceGrid: frame.sourceGrid,
          clientViewport: frame.clientViewport,
        },
        0,
      );
      return;
    }

    if (this.#phase !== "live") {
      if (frame.type === "error") {
        this.#retire(controlError(frame), false, 1008, "attachment-unavailable");
      } else {
        this.#protocolFailure();
      }
      return;
    }
    if (frame.type === "geometry") {
      if (frame.generation !== this.#generation) {
        this.#protocolFailure();
        return;
      }
      this.#queueEvent(
        {
          type: "geometry",
          sourceGrid: frame.sourceGrid,
          clientViewport: frame.clientViewport,
        },
        0,
      );
      this.#acknowledgeResize(frame.clientViewport);
      return;
    }
    if (frame.type === "exit") {
      if (frame.generation !== this.#generation) {
        this.#protocolFailure();
        return;
      }
      this.#retire(
        transportError(
          "terminal-exit",
          frame.signal === null
            ? `The tmux client exited with status ${frame.exitCode}.`
            : "The tmux client exited after a signal.",
          false,
        ),
        true,
        1000,
        "terminal-exit",
        true,
      );
      return;
    }
    this.#retire(controlError(frame), true, 1008, "attachment-unavailable", true);
  }

  #protocolFailure(): void {
    this.#retire(
      transportError("protocol-error", "The terminal WebSocket protocol was invalid.", false),
      this.#phase === "live",
      1002,
      "protocol-error",
    );
  }

  #write(_bytes: Uint8Array): Promise<NativeTerminalMutationResult> {
    // Input remains deliberately unavailable even though the daemon now owns a
    // bounded primitive. Recovery/no-replay enablement is a separate reviewed card.
    return Promise.resolve(errorResult(INPUT_UNAVAILABLE));
  }

  #resize(viewport: TerminalAttachmentViewport): Promise<NativeTerminalMutationResult> {
    const parsed = TerminalAttachmentViewportSchemaZ.safeParse(viewport);
    if (!parsed.success) {
      return Promise.resolve(
        errorResult(transportError("invalid-viewport", "The terminal viewport is invalid.", false)),
      );
    }
    if (
      this.#phase !== "live" ||
      this.#generation === null ||
      this.#identity.effectiveViewerMode !== "interactive"
    ) {
      return Promise.resolve(
        errorResult(transportError("resize-unavailable", "Terminal resize is unavailable.", true)),
      );
    }
    const next = parsed.data;
    if (this.#queuedResize && sameViewport(this.#queuedResize.viewport, next)) {
      return this.#queuedResize.promise;
    }
    if (this.#sentResize && sameViewport(this.#sentResize.viewport, next)) {
      this.#supersedeResize(this.#queuedResize);
      this.#queuedResize = null;
      if (this.#sentResize.request) return this.#sentResize.request.promise;
      const request = resizeRequest(next);
      this.#sentResize.request = request;
      return request.promise;
    }

    if (this.#sentResize?.request) {
      this.#supersedeResize(this.#sentResize.request);
      this.#sentResize.request = null;
    }
    this.#supersedeResize(this.#queuedResize);
    const request = resizeRequest(next);
    this.#queuedResize = request;
    this.#scheduleResizeFlush();
    return request.promise;
  }

  #supersedeResize(request: ResizeRequest | null): void {
    if (!request || request.settled) return;
    request.settled = true;
    request.resolve(
      errorResult(
        transportError(
          "resize-superseded",
          "A newer terminal viewport superseded this resize request.",
          true,
        ),
      ),
    );
  }

  #settleResize(request: ResizeRequest | null, result: NativeTerminalMutationResult): void {
    if (!request || request.settled) return;
    request.settled = true;
    request.resolve(result);
  }

  #scheduleResizeFlush(): void {
    if (this.#resizeFlushScheduled) return;
    this.#resizeFlushScheduled = true;
    void Promise.resolve().then(() => {
      this.#resizeFlushScheduled = false;
      this.#flushResize();
    });
  }

  #flushResize(): void {
    if (this.#sentResize || !this.#queuedResize) return;
    if (this.#phase !== "live" || this.#generation === null) {
      const request = this.#queuedResize;
      this.#queuedResize = null;
      this.#settleResize(
        request,
        errorResult(transportError("resize-unavailable", "Terminal resize is unavailable.", true)),
      );
      return;
    }
    if (this.#outboundControlFrames >= NATIVE_TERMINAL_MAX_CONTROL_FRAMES) {
      this.#retire(
        transportError(
          "control-frame-limit",
          "The terminal control-frame limit was exhausted.",
          true,
        ),
        true,
        1008,
        "control-frame-limit",
      );
      return;
    }
    const request = this.#queuedResize;
    const frame = JSON.stringify({
      type: "resize",
      protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
      generation: this.#generation,
      viewport: request.viewport,
    });
    const sendError = this.#sendControl(frame);
    if (sendError) return;
    this.#queuedResize = null;
    this.#outboundControlFrames += 1;
    const sent: SentResize = {
      viewport: request.viewport,
      request,
      cancelTimeout: () => undefined,
    };
    this.#sentResize = sent;
    sent.cancelTimeout = this.#schedule(() => {
      if (this.#sentResize !== sent) return;
      this.#retire(
        transportError(
          "resize-ack-timeout",
          "The daemon did not confirm the terminal viewport in time.",
          true,
        ),
        true,
        1008,
        "resize-ack-timeout",
      );
    }, NATIVE_TERMINAL_RESIZE_ACK_TIMEOUT_MS);
  }

  #acknowledgeResize(viewport: TerminalAttachmentViewport): void {
    const sent = this.#sentResize;
    if (!sent || !sameViewport(sent.viewport, viewport)) return;
    sent.cancelTimeout();
    this.#sentResize = null;
    this.#settleResize(sent.request, { status: "ok" });
    this.#scheduleResizeFlush();
  }

  #sendControl(frame: string): NativeTerminalTransportError | null {
    const byteLength = boundedControlByteLength(frame);
    const buffered = this.#socket.bufferedAmount;
    if (
      this.#socket.readyState !== WS_OPEN ||
      byteLength === null ||
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      buffered > NATIVE_TERMINAL_MAX_SOCKET_BUFFERED_BYTES - byteLength
    ) {
      const error = transportError(
        "socket-backpressure",
        "The terminal WebSocket could not accept another control frame.",
        true,
      );
      this.#retire(error, this.#phase === "live", 1013, "socket-backpressure");
      return error;
    }
    try {
      this.#socket.send(frame);
      return null;
    } catch {
      const error = transportError(
        "socket-unavailable",
        "The terminal WebSocket became unavailable.",
        true,
      );
      this.#retire(error, this.#phase === "live", 1011, "socket-unavailable");
      return error;
    }
  }

  #queueEvent(event: NativeTerminalEvent, byteLength: number): void {
    if (this.#phase === "closed" && event.type === "output") return;
    if (
      this.#eventCount >= NATIVE_TERMINAL_MAX_QUEUED_EVENTS ||
      byteLength > NATIVE_TERMINAL_MAX_QUEUED_EVENT_BYTES - this.#eventBytes
    ) {
      this.#retire(
        transportError(
          "renderer-backpressure",
          "The renderer could not keep up with terminal output.",
          true,
        ),
        true,
        1013,
        "renderer-backpressure",
      );
      return;
    }
    this.#eventQueue.push({ event, byteLength });
    this.#eventCount += 1;
    this.#eventBytes += byteLength;
    this.#drainEvents();
  }

  #drainEvents(): void {
    if (this.#delivering) return;
    this.#delivering = true;
    const run = async (): Promise<void> => {
      while (this.#eventQueue.length > 0) {
        const entry = this.#eventQueue.shift()!;
        try {
          await this.#listener(entry.event);
        } catch {
          this.#clearQueuedEvents();
          this.#retire(
            transportError(
              "renderer-consumer-failed",
              "The renderer could not consume terminal output.",
              true,
            ),
            false,
            1013,
            "renderer-consumer-failed",
          );
          return;
        } finally {
          this.#eventCount -= 1;
          this.#eventBytes -= entry.byteLength;
        }
      }
    };
    void run().finally(() => {
      this.#delivering = false;
      if (this.#eventQueue.length > 0) this.#drainEvents();
    });
  }

  #clearQueuedEvents(): void {
    for (const entry of this.#eventQueue) {
      this.#eventCount -= 1;
      this.#eventBytes -= entry.byteLength;
    }
    this.#eventQueue.length = 0;
  }

  #settleConnect(result: NativeTerminalConnectResult): void {
    if (this.#connectSettled) return;
    this.#connectSettled = true;
    this.#resolveConnect(result);
  }

  #retire(
    error: NativeTerminalTransportError,
    notify: boolean,
    closeCode?: number,
    closeReason?: string,
    preserveQueue = false,
  ): void {
    if (this.#phase === "closed") return;
    const wasLive = this.#phase === "live";
    this.#phase = "closed";
    this.#redemptionFrame = null;
    const queuedResize = this.#queuedResize;
    const sentResize = this.#sentResize;
    this.#queuedResize = null;
    this.#sentResize = null;
    sentResize?.cancelTimeout();
    this.#settleResize(sentResize?.request ?? null, errorResult(error));
    this.#settleResize(queuedResize, errorResult(error));
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
    this.#cancelLifetime?.();
    this.#cancelLifetime = null;
    this.#socket.removeEventListener("open", this.#onOpen);
    this.#socket.removeEventListener("message", this.#onMessage);
    this.#socket.removeEventListener("close", this.#onClose);
    this.#socket.removeEventListener("error", this.#onError);
    if (!preserveQueue) this.#clearQueuedEvents();
    if (!this.#connectSettled) {
      this.#settleConnect({ status: "error", error });
    } else if (notify && wasLive && !this.#notifiedDisconnected) {
      this.#notifiedDisconnected = true;
      if (this.#eventCount >= NATIVE_TERMINAL_MAX_QUEUED_EVENTS) {
        this.#clearQueuedEvents();
      }
      this.#queueEvent({ type: "state", state: "disconnected", error }, 0);
    }
    if (
      closeCode !== undefined &&
      (this.#socket.readyState === WS_CONNECTING ||
        this.#socket.readyState === WS_OPEN ||
        this.#socket.readyState === WS_CLOSING)
    ) {
      try {
        this.#socket.close(closeCode, closeReason?.slice(0, 123));
      } catch {
        // Local authority is already retired.
      }
    }
  }

  #dispose(): void {
    this.#retire(
      transportError("disposed", "The terminal attachment was disposed.", false),
      false,
      1000,
      "renderer-disposed",
    );
  }
}

function issueWithTimeout(
  issueAttachment: NativeTerminalIssueAttachment,
  request: TerminalAttachRequest,
  timeoutMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<{ readonly status: "ok"; readonly value: unknown } | { readonly status: "error" }> {
  return new Promise((resolve) => {
    let settled = false;
    let cancelTimeout = (): void => undefined;
    const finish = (
      result: { readonly status: "ok"; readonly value: unknown } | { readonly status: "error" },
    ): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      resolve(result);
    };
    const scheduledCancellation = schedule(() => finish({ status: "error" }), timeoutMs);
    cancelTimeout = scheduledCancellation;
    if (settled) scheduledCancellation();
    void Promise.resolve()
      .then(() => issueAttachment(request))
      .then(
        (value) => finish({ status: "ok", value }),
        () => finish({ status: "error" }),
      );
  });
}

/**
 * Renderer-owned direct WebSocket adapter. The injected issue function is the
 * only privileged seam; Electron/host code is intentionally absent from bytes,
 * resize, lifecycle, and terminal state.
 */
export function createNativeTerminalWebSocketTransport(
  dependencies: NativeTerminalWebSocketTransportDependencies,
): NativeTerminalTransport {
  if (typeof dependencies.issueAttachment !== "function") {
    throw new TypeError("Native terminal transport requires an issueAttachment function.");
  }
  const now = dependencies.now ?? Date.now;
  const schedule = dependencies.schedule ?? defaultSchedule;
  const createWebSocket = dependencies.createWebSocket ?? defaultCreateWebSocket;
  const issueTimeoutMs = boundedIssueTimeout(dependencies.issueTimeoutMs);

  return Object.freeze({
    connect: async (
      request: TerminalAttachRequest,
      listener: (event: NativeTerminalEvent) => void | Promise<void>,
    ): Promise<NativeTerminalConnectResult> => {
      const parsedRequest = TerminalAttachRequestSchemaZ.safeParse(request);
      if (!parsedRequest.success || typeof listener !== "function") {
        return {
          status: "error",
          error: transportError(
            "invalid-request",
            "The semantic terminal attachment request is invalid.",
            false,
          ),
        };
      }

      const issued = await issueWithTimeout(
        dependencies.issueAttachment,
        parsedRequest.data,
        issueTimeoutMs,
        schedule,
      );
      if (issued.status === "error") {
        return {
          status: "error",
          error: transportError(
            "attachment-issue-failed",
            "The desktop host could not issue a terminal attachment.",
            true,
          ),
        };
      }
      const descriptor = validateIssueDescriptor(issued.value, parsedRequest.data, now());
      if (!descriptor) {
        return {
          status: "error",
          error: transportError(
            "invalid-descriptor",
            "The desktop host returned an invalid terminal attachment descriptor.",
            false,
          ),
        };
      }

      let socket: NativeTerminalWebSocket;
      try {
        socket = createWebSocket(descriptor.webSocketUrl, descriptor.webSocketProtocol);
      } catch {
        return {
          status: "error",
          error: transportError(
            "socket-unavailable",
            "The terminal WebSocket could not be created.",
            true,
          ),
        };
      }
      return new NativeTerminalWebSocketSession({
        descriptor,
        socket,
        listener,
        schedule,
        now,
      }).start();
    },
  });
}
