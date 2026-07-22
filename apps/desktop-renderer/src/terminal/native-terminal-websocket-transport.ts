import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TerminalAttachRequestSchemaZ,
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

export const NATIVE_TERMINAL_WEBSOCKET_PROTOCOL = "tmux-ide-terminal.v1";
export const NATIVE_TERMINAL_MAX_CONTROL_BYTES = 4 * 1024;
export const NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES = 256 * 1024;
export const NATIVE_TERMINAL_MAX_QUEUED_EVENT_BYTES = 1024 * 1024;
export const NATIVE_TERMINAL_MAX_QUEUED_EVENTS = 32;
export const NATIVE_TERMINAL_MAX_CONTROL_FRAMES = 1_024;
export const NATIVE_TERMINAL_MAX_SOCKET_BUFFERED_BYTES = 64 * 1024;
export const NATIVE_TERMINAL_MAX_DESCRIPTOR_LIFETIME_MS = 60_000;
export const NATIVE_TERMINAL_DEFAULT_ISSUE_TIMEOUT_MS = 5_000;

const REDEEM_PATH = "/v1/terminal/attachments/redeem";
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
}

interface GeometryFrame {
  readonly type: "geometry";
  readonly generation: number;
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

function controlByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateLoopbackWebSocketUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== REDEEM_PATH ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return null;
  }
  return parsed.toString();
}

function validateIssueDescriptor(
  value: unknown,
  request: TerminalAttachRequest,
  now: number,
): SafeIssueDescriptor | null {
  if (!isRecord(value)) return null;
  if (
    !hasExactKeys(value, [
      "daemonInstanceId",
      "effectiveViewerMode",
      "expiresAt",
      "protocolVersion",
      "redemptionTicket",
      "requestId",
      "webSocketProtocol",
      "webSocketUrl",
    ]) ||
    value.protocolVersion !== TERMINAL_ATTACHMENT_PROTOCOL_VERSION ||
    value.webSocketProtocol !== NATIVE_TERMINAL_WEBSOCKET_PROTOCOL ||
    !safeIdentity(value.daemonInstanceId, 4_096) ||
    typeof value.requestId !== "string" ||
    !RequestIdPattern.test(value.requestId) ||
    !safeInteger(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt - now > NATIVE_TERMINAL_MAX_DESCRIPTOR_LIFETIME_MS ||
    !safeIdentity(value.redemptionTicket, 4_096)
  ) {
    return null;
  }
  const webSocketUrl = validateLoopbackWebSocketUrl(value.webSocketUrl);
  const viewerMode = TerminalAttachmentViewerModeSchemaZ.safeParse(value.effectiveViewerMode);
  if (!webSocketUrl || !viewerMode.success) return null;

  const redemptionFrame = JSON.stringify({
    type: "redeem",
    protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
    ticket: value.redemptionTicket,
    requestId: value.requestId,
    daemonInstanceId: value.daemonInstanceId,
  });
  if (controlByteLength(redemptionFrame) > NATIVE_TERMINAL_MAX_CONTROL_BYTES) return null;

  // A mode change is allowed only when it is explicit in both issue and ready;
  // the renderer never infers authority from the requested mode.
  void request;
  return {
    webSocketUrl,
    webSocketProtocol: NATIVE_TERMINAL_WEBSOCKET_PROTOCOL,
    daemonInstanceId: value.daemonInstanceId,
    requestId: value.requestId,
    expiresAt: value.expiresAt,
    effectiveViewerMode: viewerMode.data,
    redemptionFrame,
  };
}

function parseControlFrame(text: string): ServerControlFrame | null {
  if (text.length === 0 || controlByteLength(text) > NATIVE_TERMINAL_MAX_CONTROL_BYTES) return null;
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
    return { type: "geometry", generation: value.generation };
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

function binaryBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

function boundedIssueTimeout(value: number | undefined): number {
  const selected = value ?? NATIVE_TERMINAL_DEFAULT_ISSUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 30_000) {
    throw new TypeError("Native terminal issue timeout is invalid.");
  }
  return selected;
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
  #phase: "opening" | "redeeming" | "live" | "closed" = "opening";
  #generation: number | null = null;
  #connectSettled = false;
  #notifiedDisconnected = false;
  #eventCount = 0;
  #eventBytes = 0;
  #delivering = false;
  #pendingResize: TerminalAttachmentViewport | null = null;
  #resizePromise: Promise<NativeTerminalMutationResult> | null = null;
  #controlFrames = 0;

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
    if (typeof event.data === "string") {
      const frame = parseControlFrame(event.data);
      if (!frame) {
        this.#protocolFailure();
        return;
      }
      this.#handleControl(frame);
      return;
    }
    const bytes = binaryBytes(event.data);
    if (!bytes || this.#phase !== "live") {
      this.#protocolFailure();
      return;
    }
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > NATIVE_TERMINAL_MAX_OUTPUT_FRAME_BYTES) {
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
    this.#queueEvent({ type: "output", bytes }, bytes.byteLength);
  };

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
      this.#settleConnect({ status: "connected", attachment: this.#attachment });
      this.#queueEvent({ type: "state", state: "connected", error: null }, 0);
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
      if (frame.generation !== this.#generation) this.#protocolFailure();
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
    this.#pendingResize = parsed.data;
    if (this.#resizePromise) return this.#resizePromise;
    this.#resizePromise = Promise.resolve().then(() => {
      const next = this.#pendingResize;
      this.#pendingResize = null;
      this.#resizePromise = null;
      if (this.#phase !== "live" || this.#generation === null || !next) {
        return errorResult(
          transportError("resize-unavailable", "Terminal resize is unavailable.", true),
        );
      }
      if (this.#controlFrames >= NATIVE_TERMINAL_MAX_CONTROL_FRAMES) {
        const error = transportError(
          "control-frame-limit",
          "The terminal control-frame limit was exhausted.",
          true,
        );
        this.#retire(error, true, 1008, "control-frame-limit");
        return errorResult(error);
      }
      const frame = JSON.stringify({
        type: "resize",
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        generation: this.#generation,
        viewport: next,
      });
      const sendError = this.#sendControl(frame);
      if (sendError) return errorResult(sendError);
      this.#controlFrames += 1;
      return { status: "ok" };
    });
    return this.#resizePromise;
  }

  #sendControl(frame: string): NativeTerminalTransportError | null {
    const byteLength = controlByteLength(frame);
    const buffered = this.#socket.bufferedAmount;
    if (
      this.#socket.readyState !== WS_OPEN ||
      byteLength === 0 ||
      byteLength > NATIVE_TERMINAL_MAX_CONTROL_BYTES ||
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
    this.#pendingResize = null;
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
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
