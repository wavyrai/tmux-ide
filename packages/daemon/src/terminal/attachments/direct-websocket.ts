import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  TERMINAL_ATTACHMENT_MAX_INPUT_WIRE_BYTES,
  TerminalAttachmentInputLimitsSchemaZ,
  decodeTerminalAttachmentInputFrame,
  type TerminalAttachmentInputCapability,
  type TerminalAttachmentInputLimits,
} from "@tmux-ide/contracts/terminal-attachment-stream";
import {
  TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
  TERMINAL_ATTACHMENT_REDEEM_PATH,
  TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL,
  TerminalAttachRequestSchemaZ,
  TerminalAttachmentLoopbackWebSocketUrlSchemaZ,
  TerminalAttachmentViewportSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentViewport,
  type TerminalAttachmentViewerMode,
} from "@tmux-ide/contracts";
import type {
  AttachmentIssueContext,
  AttachmentLeaseBinding,
  AttachmentLeaseDescriptor,
  ExecutedAttachmentViewOperation,
  IssuedAttachmentLease,
  RedeemedAttachmentLease,
} from "./lease-manager.ts";
import type {
  ClaimedPtyTmuxAttachment,
  PtyTmuxAttachmentClaimKey,
} from "./pty-tmux-attachment-launcher.ts";

export { TERMINAL_ATTACHMENT_REDEEM_PATH };
/** @deprecated Import the authoritative shared subprotocol constant from contracts. */
export const TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL = TERMINAL_ATTACHMENT_WEBSOCKET_SUBPROTOCOL;
export const TERMINAL_ATTACHMENT_MAX_REDEMPTION_BYTES = 4 * 1024;
export const TERMINAL_ATTACHMENT_MAX_CONTROL_BYTES = 4 * 1024;
export const TERMINAL_ATTACHMENT_MAX_REDEMPTION_MS = 1_000;
export const TERMINAL_ATTACHMENT_MAX_LIVE_CONTROL_FRAMES = 1_024;

const WS_OPEN = 1;
const TicketPattern = /^ta1_[A-Za-z0-9_-]{43}$/u;
const BindingIdSchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const RedemptionFrameSchemaZ = z
  .object({
    type: z.literal("redeem"),
    protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
    ticket: z.string().regex(TicketPattern),
    requestId: z.uuid(),
    daemonInstanceId: BindingIdSchemaZ,
  })
  .strict();
const ResizeFrameSchemaZ = z
  .object({
    type: z.literal("resize"),
    protocolVersion: z.literal(TERMINAL_ATTACHMENT_PROTOCOL_VERSION),
    generation: z.number().int().nonnegative(),
    viewport: TerminalAttachmentViewportSchemaZ,
  })
  .strict();
const GridSchemaZ = TerminalAttachmentViewportSchemaZ;

type RedemptionFrame = z.infer<typeof RedemptionFrameSchemaZ>;

export interface TerminalAttachmentGeometry {
  readonly sourceGrid: TerminalAttachmentViewport;
  readonly clientViewport: TerminalAttachmentViewport;
}

/** Narrow, non-capability proof retained only inside the daemon runtime. */
export interface TerminalAttachmentGeometryClientProof {
  readonly attemptId: string;
  readonly attachmentId: string;
  readonly generation: number;
  readonly pid: number;
}

export interface DirectTerminalAttachmentDescriptor {
  readonly protocolVersion: typeof TERMINAL_ATTACHMENT_PROTOCOL_VERSION;
  readonly webSocketUrl: string;
  readonly redemptionTicket: string;
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly expiresAt: number;
  readonly effectiveViewerMode: TerminalAttachmentViewerMode;
}

export interface DirectTerminalAttachmentIssueContext extends AttachmentIssueContext {
  /** Canonical trusted renderer Origin supplied by the host, never the renderer request body. */
  readonly rendererOrigin: string;
}

export interface DirectTerminalAttachmentLeaseManager {
  issue(
    request: TerminalAttachRequest,
    context: AttachmentIssueContext,
  ): Promise<IssuedAttachmentLease>;
  redeem(ticket: string, binding: AttachmentLeaseBinding): Promise<RedeemedAttachmentLease>;
  renew(leaseId: string, binding: AttachmentLeaseBinding): Promise<RedeemedAttachmentLease>;
  executeViewOperation(
    leaseId: string,
    binding: AttachmentLeaseBinding,
    operation: "create" | "attach",
  ): Promise<ExecutedAttachmentViewOperation>;
  release(
    leaseId: string,
    binding: AttachmentLeaseBinding,
  ): Promise<{ released: boolean; cleanup: string }>;
}

export interface DirectTerminalAttachmentLauncher {
  claim(key: PtyTmuxAttachmentClaimKey): ClaimedPtyTmuxAttachment | null;
}

export interface DirectTerminalSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  send(data: string | Buffer, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(
    event: "message",
    listener: (data: string | Buffer | ArrayBuffer | readonly Buffer[], isBinary: boolean) => void,
  ): this;
  on(event: "close" | "error", listener: () => void): this;
  off(
    event: "message",
    listener: (data: string | Buffer | ArrayBuffer | readonly Buffer[], isBinary: boolean) => void,
  ): this;
  off(event: "close" | "error", listener: () => void): this;
}

export type TerminalAttachmentAdmissionErrorCode =
  | "daemon-shutting-down"
  | "invalid-origin"
  | "origin-rejected"
  | "invalid-path"
  | "invalid-subprotocol"
  | "pending-capacity-exhausted"
  | "preauth-capacity-exhausted"
  | "live-capacity-exhausted"
  | "read_only_unavailable"
  | "redemption-rejected"
  | "attachment-unavailable";

export class TerminalAttachmentAdmissionError extends Error {
  readonly code: TerminalAttachmentAdmissionErrorCode;

  constructor(code: TerminalAttachmentAdmissionErrorCode, message: string) {
    super(message);
    this.name = "TerminalAttachmentAdmissionError";
    this.code = code;
  }
}

export type TerminalAttachmentUpgradeDecision =
  | { readonly accepted: true; readonly admission: TerminalAttachmentPreAuthAdmission }
  | {
      readonly accepted: false;
      readonly code: TerminalAttachmentAdmissionErrorCode;
      readonly httpStatus: 403 | 404 | 426 | 503;
    };

export interface TerminalAttachmentPreAuthAdmission {
  bind(socket: DirectTerminalSocket): void;
  cancelBeforeBind(): void;
}

export interface TerminalAttachmentAdmissionSnapshot {
  readonly pendingTickets: number;
  readonly preAuthSockets: number;
  readonly liveConnections: number;
  readonly shuttingDown: boolean;
}

export interface TerminalAttachmentAdmissionCoordinatorOptions {
  readonly daemonInstanceId: string;
  readonly webSocketUrl: string;
  readonly leaseManager: DirectTerminalAttachmentLeaseManager;
  readonly launcher: DirectTerminalAttachmentLauncher;
  /**
   * Daemon-owned startup work which must complete before any descriptor or
   * WebSocket admission can be published. Rejections are deliberately
   * collapsed to the static attachment-unavailable domain error.
   */
  readonly startupBarrier?: PromiseLike<void>;
  readonly resolveGeometry: (
    descriptor: AttachmentLeaseDescriptor,
    client: TerminalAttachmentGeometryClientProof,
  ) => Promise<TerminalAttachmentGeometry>;
  readonly maxPendingTickets?: number;
  readonly maxPreAuthSockets?: number;
  readonly maxLiveConnections?: number;
  readonly redemptionTimeoutMs?: number;
  readonly maxBufferedOutputBytes?: number;
  readonly maxOutputFrameBytes?: number;
  readonly maxLiveControlFrames?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface PendingTicket {
  readonly leaseId: string;
  readonly requestId: string;
  readonly projectIdentity: string;
  readonly origin: string;
  readonly ticketDigest: Buffer;
  readonly descriptor: AttachmentLeaseDescriptor;
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
    throw new TypeError("Terminal attachment admission limit is invalid.");
  }
  return selected;
}

function digestTicket(ticket: string): Buffer {
  return createHash("sha256").update(ticket, "utf8").digest();
}

function matchesDigest(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function canonicalRendererOrigin(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 2048 ||
    value === "null" ||
    value === "*" ||
    /[\0\r\n\t ]/u.test(value)
  ) {
    throw new TerminalAttachmentAdmissionError("invalid-origin", "Renderer Origin is invalid.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TerminalAttachmentAdmissionError("invalid-origin", "Renderer Origin is invalid.");
  }
  if (
    !/^[a-z][a-z0-9+.-]*:$/u.test(parsed.protocol) ||
    parsed.protocol === "file:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    throw new TerminalAttachmentAdmissionError("invalid-origin", "Renderer Origin is invalid.");
  }
  const canonical = `${parsed.protocol}//${parsed.host}`;
  if (canonical !== value) {
    throw new TerminalAttachmentAdmissionError(
      "invalid-origin",
      "Renderer Origin must be canonical.",
    );
  }
  return canonical;
}

function validateWebSocketUrl(value: string): string {
  try {
    return TerminalAttachmentLoopbackWebSocketUrlSchemaZ.parse(value);
  } catch {
    throw new TypeError("Terminal attachment WebSocket URL is invalid.");
  }
}

function rawDataToBuffer(data: string | Buffer | ArrayBuffer | readonly Buffer[]): Buffer {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data.map((entry) => Buffer.from(entry)));
}

function rawDataByteLength(
  data: string | Buffer | ArrayBuffer | readonly Buffer[],
  maximum: number,
): number {
  if (typeof data === "string") return Buffer.byteLength(data, "utf8");
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  let total = 0;
  for (const entry of data) {
    if (entry.byteLength > maximum - total) return maximum + 1;
    total += entry.byteLength;
  }
  return total;
}

function strictJson(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes.byteLength || text.includes("\uFFFD")) {
    throw new TypeError("Control frame is not valid UTF-8.");
  }
  return JSON.parse(text) as unknown;
}

function safeClose(socket: DirectTerminalSocket, code: number, reason: string): void {
  try {
    if (socket.readyState === WS_OPEN) socket.close(code, reason.slice(0, 123));
  } catch {
    // Teardown ownership has already moved to the daemon state machine.
  }
}

function sendControl(socket: DirectTerminalSocket, frame: Readonly<Record<string, unknown>>): void {
  if (socket.readyState !== WS_OPEN) return;
  const encoded = JSON.stringify(frame);
  if (Buffer.byteLength(encoded, "utf8") > TERMINAL_ATTACHMENT_MAX_CONTROL_BYTES) {
    throw new TypeError("Terminal attachment control frame exceeded its bound.");
  }
  socket.send(encoded, { binary: false });
}

function sameTarget(
  left: AttachmentLeaseDescriptor["target"],
  right: AttachmentLeaseDescriptor["target"],
): boolean {
  return left.workspaceName === right.workspaceName && left.semanticPaneId === right.semanticPaneId;
}

function validDescriptorIdentity(descriptor: AttachmentLeaseDescriptor): boolean {
  return (
    z.uuid().safeParse(descriptor.leaseId).success &&
    z.uuid().safeParse(descriptor.requestId).success &&
    Number.isSafeInteger(descriptor.issuedAt) &&
    Number.isSafeInteger(descriptor.expiresAt) &&
    Number.isSafeInteger(descriptor.bindingGeneration) &&
    descriptor.bindingGeneration >= 0 &&
    Number.isSafeInteger(descriptor.viewGeneration) &&
    descriptor.viewGeneration >= 0
  );
}

/**
 * In-memory admission authority for one daemon instance. It contains no raw
 * tmux identity and retains only ticket digests. A daemon restart constructs a
 * fresh coordinator and makes every prior renderer descriptor inert.
 */
export class TerminalAttachmentAdmissionCoordinator {
  readonly #instanceId: string;
  readonly #webSocketUrl: string;
  readonly #leaseManager: DirectTerminalAttachmentLeaseManager;
  readonly #launcher: DirectTerminalAttachmentLauncher;
  readonly #startupBarrier: Promise<void>;
  readonly #resolveGeometry: TerminalAttachmentAdmissionCoordinatorOptions["resolveGeometry"];
  readonly #maxPending: number;
  readonly #maxPreAuth: number;
  readonly #maxLive: number;
  readonly #redemptionTimeoutMs: number;
  readonly #maxBufferedOutputBytes: number;
  readonly #maxOutputFrameBytes: number;
  readonly #maxLiveControlFrames: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  readonly #pending = new Map<string, PendingTicket>();
  readonly #preAuth = new Set<PreAuthAdmission>();
  readonly #live = new Set<TerminalAttachmentLiveConnection>();
  readonly #retiringReleases = new Set<Promise<void>>();
  #pendingReservations = 0;
  #liveReservations = 0;
  #operationTail: Promise<void> = Promise.resolve();
  #startupState: "pending" | "ready" | "failed";
  #shuttingDown = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: TerminalAttachmentAdmissionCoordinatorOptions) {
    this.#instanceId = BindingIdSchemaZ.parse(options.daemonInstanceId);
    this.#webSocketUrl = validateWebSocketUrl(options.webSocketUrl);
    this.#leaseManager = options.leaseManager;
    this.#launcher = options.launcher;
    if (options.startupBarrier) {
      this.#startupState = "pending";
      this.#startupBarrier = Promise.resolve(options.startupBarrier).then(
        () => {
          this.#startupState = "ready";
        },
        () => {
          this.#startupState = "failed";
          throw new TerminalAttachmentAdmissionError(
            "attachment-unavailable",
            "Terminal attachment startup reconciliation failed.",
          );
        },
      );
      // The same rejection remains observable through issue(); this handler
      // only prevents a constructor-started barrier from becoming unhandled.
      void this.#startupBarrier.catch(() => undefined);
    } else {
      this.#startupState = "ready";
      this.#startupBarrier = Promise.resolve();
    }
    this.#resolveGeometry = options.resolveGeometry;
    this.#maxPending = boundedInteger(options.maxPendingTickets, 32, 1_024);
    this.#maxPreAuth = boundedInteger(options.maxPreAuthSockets, 16, 1_024);
    this.#maxLive = boundedInteger(options.maxLiveConnections, 16, 1_024);
    this.#redemptionTimeoutMs = boundedInteger(
      options.redemptionTimeoutMs,
      TERMINAL_ATTACHMENT_MAX_REDEMPTION_MS,
      TERMINAL_ATTACHMENT_MAX_REDEMPTION_MS,
    );
    this.#maxBufferedOutputBytes = boundedInteger(
      options.maxBufferedOutputBytes,
      1 << 20,
      16 << 20,
    );
    this.#maxOutputFrameBytes = boundedInteger(options.maxOutputFrameBytes, 256 << 10, 1 << 20);
    if (this.#maxOutputFrameBytes > this.#maxBufferedOutputBytes) {
      throw new TypeError("Output frame bound must not exceed the WebSocket output bound.");
    }
    this.#maxLiveControlFrames = boundedInteger(
      options.maxLiveControlFrames,
      TERMINAL_ATTACHMENT_MAX_LIVE_CONTROL_FRAMES,
      65_536,
    );
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  issue(
    request: TerminalAttachRequest,
    context: DirectTerminalAttachmentIssueContext,
  ): Promise<DirectTerminalAttachmentDescriptor> {
    return this.#exclusive(async () => {
      try {
        await this.#startupBarrier;
      } catch {
        if (this.#shuttingDown) {
          throw new TerminalAttachmentAdmissionError(
            "daemon-shutting-down",
            "Terminal attachment admission is shutting down.",
          );
        }
        throw new TerminalAttachmentAdmissionError(
          "attachment-unavailable",
          "Terminal attachment startup reconciliation failed.",
        );
      }
      if (this.#shuttingDown) {
        throw new TerminalAttachmentAdmissionError(
          "daemon-shutting-down",
          "Terminal attachment admission is shutting down.",
        );
      }
      const parsedRequest = TerminalAttachRequestSchemaZ.parse(request);
      if (parsedRequest.viewerMode === "read-only") {
        throw new TerminalAttachmentAdmissionError(
          "read_only_unavailable",
          "Read-only terminal attachments are not proven geometry-neutral.",
        );
      }
      const origin = canonicalRendererOrigin(context.rendererOrigin);
      const requestId = z.uuid().parse(context.requestId);
      const projectIdentity = BindingIdSchemaZ.parse(context.projectIdentity);
      if (this.#pending.size + this.#pendingReservations >= this.#maxPending) {
        throw new TerminalAttachmentAdmissionError(
          "pending-capacity-exhausted",
          "Terminal attachment ticket capacity is exhausted.",
        );
      }
      this.#pendingReservations += 1;
      let issued: IssuedAttachmentLease;
      try {
        issued = await this.#leaseManager.issue(parsedRequest, { requestId, projectIdentity });
      } finally {
        this.#pendingReservations -= 1;
      }
      if (this.#shuttingDown) {
        await this.#releaseLease(issued.descriptor.leaseId, {
          daemonInstanceId: this.#instanceId,
          requestId,
          projectIdentity,
        });
        throw new TerminalAttachmentAdmissionError(
          "daemon-shutting-down",
          "Terminal attachment admission is shutting down.",
        );
      }
      const ticket = issued.redemptionTicket;
      const issuedDescriptor = issued.descriptor;
      if (
        !TicketPattern.test(ticket) ||
        !validDescriptorIdentity(issuedDescriptor) ||
        issuedDescriptor.requestId !== requestId ||
        issuedDescriptor.status !== "awaiting-redemption" ||
        issuedDescriptor.viewerMode !== parsedRequest.viewerMode ||
        !sameTarget(issuedDescriptor.target, parsedRequest.target)
      ) {
        await this.#releaseLease(issued.descriptor.leaseId, {
          daemonInstanceId: this.#instanceId,
          requestId,
          projectIdentity,
        });
        throw new TerminalAttachmentAdmissionError(
          "attachment-unavailable",
          "Terminal attachment ticket generation failed.",
        );
      }
      const ticketDigest = digestTicket(ticket);
      if (
        [...this.#pending.values()].some((pending) =>
          matchesDigest(pending.ticketDigest, ticketDigest),
        )
      ) {
        ticketDigest.fill(0);
        await this.#releaseLease(issuedDescriptor.leaseId, {
          daemonInstanceId: this.#instanceId,
          requestId,
          projectIdentity,
        });
        throw new TerminalAttachmentAdmissionError(
          "attachment-unavailable",
          "Terminal attachment ticket generation failed.",
        );
      }
      const pending: PendingTicket = {
        leaseId: issuedDescriptor.leaseId,
        requestId,
        projectIdentity,
        origin,
        ticketDigest,
        descriptor: structuredClone(issuedDescriptor),
        cancelExpiry: null,
      };
      const remainingMs = issuedDescriptor.expiresAt - this.#now();
      if (remainingMs <= 0) {
        pending.ticketDigest.fill(0);
        await this.#releaseLease(pending.leaseId, this.#binding(pending));
        throw new TerminalAttachmentAdmissionError(
          "attachment-unavailable",
          "Terminal attachment ticket expired before issue completed.",
        );
      }
      pending.cancelExpiry = this.#schedule(() => {
        void this.#exclusive(() => this.#retirePending(pending));
      }, remainingMs);
      this.#pending.set(pending.leaseId, pending);
      return Object.freeze({
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        webSocketUrl: this.#webSocketUrl,
        redemptionTicket: ticket,
        daemonInstanceId: this.#instanceId,
        requestId,
        expiresAt: issuedDescriptor.expiresAt,
        effectiveViewerMode: issuedDescriptor.viewerMode,
      });
    });
  }

  reserveUpgrade(input: {
    readonly path: string;
    readonly protocols: readonly string[];
    readonly origin: string | null | undefined;
  }): TerminalAttachmentUpgradeDecision {
    if (this.#shuttingDown) {
      return { accepted: false, code: "daemon-shutting-down", httpStatus: 503 };
    }
    if (this.#startupState !== "ready") {
      return { accepted: false, code: "attachment-unavailable", httpStatus: 503 };
    }
    if (input.path !== TERMINAL_ATTACHMENT_REDEEM_PATH) {
      return { accepted: false, code: "invalid-path", httpStatus: 404 };
    }
    if (
      input.protocols.length !== 1 ||
      input.protocols[0] !== TERMINAL_ATTACHMENT_WEBSOCKET_PROTOCOL
    ) {
      return { accepted: false, code: "invalid-subprotocol", httpStatus: 426 };
    }
    let origin: string;
    try {
      origin = canonicalRendererOrigin(input.origin ?? "");
    } catch {
      return { accepted: false, code: "invalid-origin", httpStatus: 403 };
    }
    if (![...this.#pending.values()].some((pending) => pending.origin === origin)) {
      return { accepted: false, code: "origin-rejected", httpStatus: 403 };
    }
    if (this.#preAuth.size >= this.#maxPreAuth) {
      return { accepted: false, code: "preauth-capacity-exhausted", httpStatus: 503 };
    }
    const admission = new PreAuthAdmission({
      origin,
      timeoutMs: this.#redemptionTimeoutMs,
      schedule: this.#schedule,
      onRelease: (released) => this.#preAuth.delete(released),
      onRedeem: (active, frame, socket) => this.#redeem(active, frame, socket),
    });
    this.#preAuth.add(admission);
    return { accepted: true, admission };
  }

  snapshot(): TerminalAttachmentAdmissionSnapshot {
    return Object.freeze({
      pendingTickets: this.#pending.size + this.#pendingReservations,
      preAuthSockets: this.#preAuth.size,
      liveConnections: this.#live.size + this.#liveReservations,
      shuttingDown: this.#shuttingDown,
    });
  }

  toJSON(): TerminalAttachmentAdmissionSnapshot {
    return this.snapshot();
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
      // Operations admitted before shutdown may have crossed async lease or
      // launcher boundaries. Sweep only after they have left the serialized
      // section so a late-created live connection cannot escape teardown.
      for (const connection of [...this.#live]) {
        connection.close(1001, "daemon-shutdown");
      }
      for (const pending of [...this.#pending.values()]) await this.#retirePending(pending);
    });
    await Promise.all([...this.#retiringReleases]);
  }

  #redeem(
    admission: PreAuthAdmission,
    frame: RedemptionFrame,
    socket: DirectTerminalSocket,
  ): Promise<TerminalAttachmentLiveConnection> {
    return this.#exclusive(async () => {
      if (this.#shuttingDown) {
        throw new TerminalAttachmentAdmissionError(
          "redemption-rejected",
          "Terminal attachment redemption was rejected.",
        );
      }
      if (frame.daemonInstanceId !== this.#instanceId) {
        throw new TerminalAttachmentAdmissionError(
          "redemption-rejected",
          "Terminal attachment redemption was rejected.",
        );
      }
      const candidateDigest = digestTicket(frame.ticket);
      let pending: PendingTicket | undefined;
      for (const entry of this.#pending.values()) {
        if (matchesDigest(entry.ticketDigest, candidateDigest)) pending = entry;
      }
      candidateDigest.fill(0);
      if (
        !pending ||
        pending.origin !== admission.origin ||
        pending.requestId !== frame.requestId
      ) {
        throw new TerminalAttachmentAdmissionError(
          "redemption-rejected",
          "Terminal attachment redemption was rejected.",
        );
      }
      const binding = this.#binding(pending);
      if (!admission.isOpen()) {
        this.#removePending(pending);
        await this.#releaseLease(pending.leaseId, binding);
        throw new TerminalAttachmentAdmissionError(
          "redemption-rejected",
          "Terminal attachment redemption was rejected.",
        );
      }
      this.#removePending(pending);
      if (this.#live.size + this.#liveReservations >= this.#maxLive) {
        await this.#releaseLease(pending.leaseId, binding);
        throw new TerminalAttachmentAdmissionError(
          "live-capacity-exhausted",
          "Terminal attachment live capacity is exhausted.",
        );
      }
      let liveReservationHeld = true;
      this.#liveReservations += 1;
      try {
        const redeemed = await this.#leaseManager.redeem(frame.ticket, binding);
        this.#assertActiveDescriptor(redeemed.descriptor, pending);
        if (!admission.isOpen()) {
          throw new TerminalAttachmentAdmissionError(
            "redemption-rejected",
            "Terminal attachment redemption was rejected.",
          );
        }
        await this.#leaseManager.executeViewOperation(pending.leaseId, binding, "create");
        const attached = await this.#leaseManager.executeViewOperation(
          pending.leaseId,
          binding,
          "attach",
        );
        if (!attached.clientClaim) {
          throw new TerminalAttachmentAdmissionError(
            "attachment-unavailable",
            "Terminal attachment client was unavailable.",
          );
        }
        const activeDescriptor = this.#assertActiveDescriptor(attached.descriptor, pending);
        const client = this.#launcher.claim(attached.clientClaim);
        if (!client) {
          throw new TerminalAttachmentAdmissionError(
            "attachment-unavailable",
            "Terminal attachment client was unavailable.",
          );
        }
        let geometry: TerminalAttachmentGeometry;
        try {
          const resolved = await this.#resolveGeometry(activeDescriptor, client);
          geometry = {
            sourceGrid: GridSchemaZ.parse(resolved.sourceGrid),
            clientViewport: GridSchemaZ.parse(resolved.clientViewport),
          };
        } catch {
          client.dispose();
          throw new TerminalAttachmentAdmissionError(
            "attachment-unavailable",
            "Terminal attachment geometry was unavailable.",
          );
        }
        if (!admission.isOpen()) {
          client.dispose();
          throw new TerminalAttachmentAdmissionError(
            "redemption-rejected",
            "Terminal attachment redemption was rejected.",
          );
        }
        const live = new TerminalAttachmentLiveConnection({
          onRetire: (connection) => this.#trackRetiringRelease(connection),
          socket,
          client,
          leaseManager: this.#leaseManager,
          leaseId: pending.leaseId,
          binding,
          descriptor: activeDescriptor,
          geometry,
          resolveGeometry: this.#resolveGeometry,
          maxBufferedOutputBytes: this.#maxBufferedOutputBytes,
          maxOutputFrameBytes: this.#maxOutputFrameBytes,
          maxLiveControlFrames: this.#maxLiveControlFrames,
          now: this.#now,
          schedule: this.#schedule,
        });
        liveReservationHeld = false;
        this.#liveReservations -= 1;
        this.#live.add(live);
        admission.promote();
        live.start();
        return live;
      } catch (error) {
        if (liveReservationHeld) {
          this.#liveReservations -= 1;
        }
        await this.#releaseLease(pending.leaseId, binding);
        throw error;
      }
    });
  }

  #binding(pending: PendingTicket): AttachmentLeaseBinding {
    return {
      daemonInstanceId: this.#instanceId,
      requestId: pending.requestId,
      projectIdentity: pending.projectIdentity,
    };
  }

  #assertActiveDescriptor(
    descriptor: AttachmentLeaseDescriptor,
    pending: PendingTicket,
  ): AttachmentLeaseDescriptor {
    if (
      !validDescriptorIdentity(descriptor) ||
      descriptor.leaseId !== pending.leaseId ||
      descriptor.requestId !== pending.requestId ||
      descriptor.status !== "active" ||
      descriptor.viewerMode !== pending.descriptor.viewerMode ||
      !sameTarget(descriptor.target, pending.descriptor.target) ||
      descriptor.expiresAt <= this.#now()
    ) {
      throw new TerminalAttachmentAdmissionError(
        "attachment-unavailable",
        "Terminal attachment lease identity was unavailable.",
      );
    }
    return structuredClone(descriptor);
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
    const binding = this.#binding(pending);
    this.#removePending(pending);
    await this.#releaseLease(pending.leaseId, binding);
  }

  async #releaseLease(leaseId: string, binding: AttachmentLeaseBinding): Promise<void> {
    try {
      await this.#leaseManager.release(leaseId, binding);
    } catch {
      // The lease manager may already have retired the one-use lease. No
      // credential, target proof, or terminal bytes are reflected outward.
    }
  }

  #trackRetiringRelease(connection: TerminalAttachmentLiveConnection): void {
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
  readonly timeoutMs: number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly onRelease: (admission: PreAuthAdmission) => void;
  readonly onRedeem: (
    admission: PreAuthAdmission,
    frame: RedemptionFrame,
    socket: DirectTerminalSocket,
  ) => Promise<TerminalAttachmentLiveConnection>;
}

class PreAuthAdmission implements TerminalAttachmentPreAuthAdmission {
  readonly origin: string;
  readonly #onRelease: PreAuthAdmissionOptions["onRelease"];
  readonly #onRedeem: PreAuthAdmissionOptions["onRedeem"];
  readonly #cancelDeadline: () => void;
  #socket: DirectTerminalSocket | null = null;
  #frameReceived = false;
  #open = true;
  #promoted = false;

  constructor(options: PreAuthAdmissionOptions) {
    this.origin = options.origin;
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
      safeClose(socket, 1008, "redemption-rejected");
      return;
    }
    this.#socket = socket;
    socket.on("message", this.#onMessage);
    socket.on("close", this.#onClose);
    socket.on("error", this.#onClose);
  }

  beginRedemption(): void {
    if (!this.#open || this.#promoted) return;
    this.#cancelDeadline();
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
    if (socket) safeClose(socket, code, reason);
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
    const byteLength = rawDataByteLength(data, TERMINAL_ATTACHMENT_MAX_REDEMPTION_BYTES);
    if (isBinary || byteLength === 0 || byteLength > TERMINAL_ATTACHMENT_MAX_REDEMPTION_BYTES) {
      this.close(1009, "redemption-frame-rejected");
      return;
    }
    const bytes = rawDataToBuffer(data);
    let frame: RedemptionFrame;
    try {
      frame = RedemptionFrameSchemaZ.parse(strictJson(bytes));
    } catch {
      this.close(1008, "redemption-frame-rejected");
      return;
    }
    const socket = this.#socket;
    if (!socket) {
      this.close(1008, "redemption-rejected");
      return;
    }
    this.beginRedemption();
    void this.#onRedeem(this, frame, socket).catch((error: unknown) => {
      if (!this.#open) return;
      const code =
        error instanceof TerminalAttachmentAdmissionError ? error.code : "attachment-unavailable";
      try {
        sendControl(socket, {
          type: "error",
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          code,
          retryable: code === "live-capacity-exhausted",
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
  readonly onRetire: (connection: TerminalAttachmentLiveConnection) => void;
  readonly socket: DirectTerminalSocket;
  readonly client: ClaimedPtyTmuxAttachment;
  readonly leaseManager: DirectTerminalAttachmentLeaseManager;
  readonly leaseId: string;
  readonly binding: AttachmentLeaseBinding;
  readonly descriptor: AttachmentLeaseDescriptor;
  readonly geometry: TerminalAttachmentGeometry;
  readonly resolveGeometry: (
    descriptor: AttachmentLeaseDescriptor,
    client: TerminalAttachmentGeometryClientProof,
  ) => Promise<TerminalAttachmentGeometry>;
  readonly maxBufferedOutputBytes: number;
  readonly maxOutputFrameBytes: number;
  readonly maxLiveControlFrames: number;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

function boundedInputCapability(
  client: ClaimedPtyTmuxAttachment,
  viewerMode: TerminalAttachmentViewerMode,
): {
  readonly input: NonNullable<ClaimedPtyTmuxAttachment["boundedInput"]> | null;
  readonly capability: TerminalAttachmentInputCapability;
  readonly limits: TerminalAttachmentInputLimits | null;
} {
  const input = viewerMode === "interactive" ? client.boundedInput : null;
  if (!input) return { input: null, capability: "unavailable", limits: null };
  try {
    const snapshot = input.snapshot();
    if (snapshot.state !== "open") {
      return { input: null, capability: "unavailable", limits: null };
    }
    const limits = TerminalAttachmentInputLimitsSchemaZ.parse({
      maxFrameBytes: snapshot.maxFrameBytes,
      maxAcceptedBytes: snapshot.maxAcceptedBytes,
      maxAcceptedFrames: snapshot.maxAcceptedFrames,
    });
    return {
      input,
      capability: Object.freeze({ mode: "bounded", limits }),
      limits,
    };
  } catch {
    return { input: null, capability: "unavailable", limits: null };
  }
}

class TerminalAttachmentLiveConnection {
  readonly #onRetire: LiveConnectionOptions["onRetire"];
  readonly #socket: DirectTerminalSocket;
  readonly #client: ClaimedPtyTmuxAttachment;
  readonly #leaseManager: DirectTerminalAttachmentLeaseManager;
  readonly #leaseId: string;
  readonly #binding: AttachmentLeaseBinding;
  #descriptor: AttachmentLeaseDescriptor;
  readonly #initialGeometry: TerminalAttachmentGeometry;
  readonly #resolveGeometry: LiveConnectionOptions["resolveGeometry"];
  readonly #maxBufferedOutputBytes: number;
  readonly #maxOutputFrameBytes: number;
  readonly #maxLiveControlFrames: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;
  #removeDataListener: (() => void) | null = null;
  #removeExitListener: (() => void) | null = null;
  #pendingResize: TerminalAttachmentViewport | null = null;
  #resizeRunning = false;
  #controlFrames = 0;
  #input: NonNullable<ClaimedPtyTmuxAttachment["boundedInput"]> | null = null;
  #inputCapability: TerminalAttachmentInputCapability = "unavailable";
  #inputLimits: TerminalAttachmentInputLimits | null = null;
  #nextInputSequence = 1;
  #acceptedInputBytes = 0;
  #acceptedInputFrames = 0;
  #closed = false;
  #cancelRenewal: (() => void) | null = null;
  #cancelExpiry: (() => void) | null = null;
  #renewing = false;
  #releasePromise: Promise<unknown> | null = null;

  constructor(options: LiveConnectionOptions) {
    this.#onRetire = options.onRetire;
    this.#socket = options.socket;
    this.#client = options.client;
    this.#leaseManager = options.leaseManager;
    this.#leaseId = options.leaseId;
    this.#binding = options.binding;
    this.#descriptor = structuredClone(options.descriptor);
    this.#initialGeometry = structuredClone(options.geometry);
    this.#resolveGeometry = options.resolveGeometry;
    this.#maxBufferedOutputBytes = options.maxBufferedOutputBytes;
    this.#maxOutputFrameBytes = options.maxOutputFrameBytes;
    this.#maxLiveControlFrames = options.maxLiveControlFrames;
    this.#now = options.now;
    this.#schedule = options.schedule;
  }

  start(): void {
    if (this.#closed || this.#socket.readyState !== WS_OPEN) {
      this.close(1008, "attachment-retired");
      return;
    }
    this.#socket.on("message", this.#onMessage);
    this.#socket.on("close", this.#onClose);
    this.#socket.on("error", this.#onClose);
    try {
      const boundedInput = boundedInputCapability(this.#client, this.#descriptor.viewerMode);
      this.#input = boundedInput.input;
      this.#inputCapability = boundedInput.capability;
      this.#inputLimits = boundedInput.limits;
      this.#acceptedInputBytes = 0;
      this.#acceptedInputFrames = 0;
      sendControl(this.#socket, {
        type: "ready",
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        daemonInstanceId: this.#binding.daemonInstanceId,
        requestId: this.#binding.requestId,
        generation: this.#descriptor.viewGeneration,
        effectiveViewerMode: this.#descriptor.viewerMode,
        inputCapability: this.#inputCapability,
        sourceGrid: this.#initialGeometry.sourceGrid,
        clientViewport: this.#initialGeometry.clientViewport,
      });
      this.#removeExitListener = this.#client.onExit(this.#onClientExit);
      this.#removeDataListener = this.#client.onData(this.#onClientData);
      this.#scheduleLeaseLifecycle();
    } catch {
      this.close(1011, "attachment-unavailable");
    }
  }

  close(code = 1000, reason = "attachment-closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelRenewal?.();
    this.#cancelRenewal = null;
    this.#cancelExpiry?.();
    this.#cancelExpiry = null;
    this.#pendingResize = null;
    this.#input = null;
    this.#inputLimits = null;
    this.#socket.off("message", this.#onMessage);
    this.#socket.off("close", this.#onClose);
    this.#socket.off("error", this.#onClose);
    this.#removeDataListener?.();
    this.#removeDataListener = null;
    this.#removeExitListener?.();
    this.#removeExitListener = null;
    try {
      this.#client.dispose();
    } catch {
      // Lease retirement below remains authoritative.
    }
    this.#releasePromise = this.#leaseManager
      .release(this.#leaseId, this.#binding)
      .catch(() => undefined);
    this.#onRetire(this);
    safeClose(this.#socket, code, reason);
  }

  async waitForRelease(): Promise<void> {
    await this.#releasePromise;
  }

  readonly #onMessage = (
    data: string | Buffer | ArrayBuffer | readonly Buffer[],
    isBinary: boolean,
  ): void => {
    if (this.#closed) return;
    if (isBinary) {
      this.#acceptInputFrame(data);
      return;
    }
    this.#controlFrames += 1;
    if (this.#controlFrames > this.#maxLiveControlFrames) {
      this.close(1008, "control-frame-limit");
      return;
    }
    const byteLength = rawDataByteLength(data, TERMINAL_ATTACHMENT_MAX_CONTROL_BYTES);
    if (byteLength === 0 || byteLength > TERMINAL_ATTACHMENT_MAX_CONTROL_BYTES) {
      this.close(1009, "control-frame-rejected");
      return;
    }
    const bytes = rawDataToBuffer(data);
    let frame: z.infer<typeof ResizeFrameSchemaZ>;
    try {
      frame = ResizeFrameSchemaZ.parse(strictJson(bytes));
    } catch {
      this.close(1008, "control-frame-rejected");
      return;
    }
    if (frame.generation !== this.#descriptor.viewGeneration) {
      this.close(1008, "retired-generation");
      return;
    }
    this.#pendingResize = frame.viewport;
    this.#flushResize();
  };

  #acceptInputFrame(data: string | Buffer | ArrayBuffer | readonly Buffer[]): void {
    const input = this.#input;
    const limits = this.#inputLimits;
    if (!input || !limits) {
      this.#rejectInput("input-backpressure-unavailable");
      return;
    }
    const byteLength = rawDataByteLength(data, TERMINAL_ATTACHMENT_MAX_INPUT_WIRE_BYTES);
    if (byteLength === 0 || byteLength > TERMINAL_ATTACHMENT_MAX_INPUT_WIRE_BYTES) {
      this.#rejectInput("input-rejected");
      return;
    }
    const decoded = decodeTerminalAttachmentInputFrame(rawDataToBuffer(data));
    if (
      !decoded ||
      decoded.sequence !== this.#nextInputSequence ||
      decoded.payload.byteLength > limits.maxFrameBytes
    ) {
      this.#rejectInput("input-rejected");
      return;
    }
    try {
      const receipt = input.write(decoded.payload);
      const acceptedBytes = this.#acceptedInputBytes + decoded.payload.byteLength;
      const acceptedFrames = this.#acceptedInputFrames + 1;
      const remainingBytes = limits.maxAcceptedBytes - acceptedBytes;
      const remainingFrames = limits.maxAcceptedFrames - acceptedFrames;
      const state = remainingBytes === 0 || remainingFrames === 0 ? "exhausted" : "open";
      if (
        receipt.status !== "accepted" ||
        receipt.byteLength !== decoded.payload.byteLength ||
        receipt.snapshot.maxFrameBytes !== limits.maxFrameBytes ||
        receipt.snapshot.maxAcceptedBytes !== limits.maxAcceptedBytes ||
        receipt.snapshot.maxAcceptedFrames !== limits.maxAcceptedFrames ||
        receipt.snapshot.state !== state ||
        receipt.snapshot.acceptedBytes !== acceptedBytes ||
        receipt.snapshot.acceptedFrames !== acceptedFrames ||
        receipt.snapshot.remainingBytes !== remainingBytes ||
        receipt.snapshot.remainingFrames !== remainingFrames
      ) {
        throw new TypeError("bounded input returned an invalid receipt");
      }
      sendControl(this.#socket, {
        type: "input-ack",
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        generation: this.#descriptor.viewGeneration,
        sequence: decoded.sequence,
        byteLength: receipt.byteLength,
        state: receipt.snapshot.state,
        acceptedBytes: receipt.snapshot.acceptedBytes,
        acceptedFrames: receipt.snapshot.acceptedFrames,
        remainingBytes: receipt.snapshot.remainingBytes,
        remainingFrames: receipt.snapshot.remainingFrames,
      });
      this.#acceptedInputBytes = acceptedBytes;
      this.#acceptedInputFrames = acceptedFrames;
      this.#nextInputSequence += 1;
    } catch {
      this.#rejectInput("input-rejected");
    }
  }

  #rejectInput(code: "input-backpressure-unavailable" | "input-rejected"): void {
    try {
      sendControl(this.#socket, {
        type: "mutation-error",
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        mutation: "input",
        code,
        retryable: false,
      });
    } catch {
      this.close(1011, "attachment-unavailable");
      return;
    }
    this.close(1008, code);
  }

  readonly #onClose = (): void => this.close(1000, "peer-closed");

  readonly #onClientData = (data: Buffer): void => {
    if (this.#closed || data.byteLength === 0) return;
    const buffered = this.#socket.bufferedAmount ?? 0;
    if (
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      data.byteLength > this.#maxOutputFrameBytes ||
      buffered > this.#maxBufferedOutputBytes - data.byteLength
    ) {
      this.close(1013, "output-backpressure");
      return;
    }
    try {
      this.#socket.send(Buffer.from(data), { binary: true });
    } catch {
      this.close(1011, "attachment-unavailable");
    }
  };

  readonly #onClientExit = (event: {
    readonly exitCode: number;
    readonly signal: number | null;
  }): void => {
    if (this.#closed) return;
    try {
      sendControl(this.#socket, {
        type: "exit",
        protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
        generation: this.#descriptor.viewGeneration,
        exitCode: Number.isSafeInteger(event.exitCode) ? event.exitCode : 1,
        signal: Number.isSafeInteger(event.signal) ? event.signal : null,
      });
    } finally {
      this.close(1000, "terminal-exit");
    }
  };

  #flushResize(): void {
    if (this.#closed || this.#resizeRunning || !this.#pendingResize) return;
    this.#resizeRunning = true;
    const run = async (): Promise<void> => {
      while (!this.#closed && this.#pendingResize) {
        const viewport = this.#pendingResize;
        this.#pendingResize = null;
        try {
          this.#client.resize(viewport.cols, viewport.rows);
          const geometry = await this.#resolveGeometry(this.#descriptor, this.#client);
          if (this.#closed) return;
          sendControl(this.#socket, {
            type: "geometry",
            protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
            generation: this.#descriptor.viewGeneration,
            sourceGrid: GridSchemaZ.parse(geometry.sourceGrid),
            clientViewport: GridSchemaZ.parse(geometry.clientViewport),
          });
        } catch {
          this.close(1011, "resize-unavailable");
          return;
        }
      }
    };
    void run().finally(() => {
      this.#resizeRunning = false;
      this.#flushResize();
    });
  }

  #scheduleLeaseLifecycle(): void {
    this.#cancelRenewal?.();
    this.#cancelExpiry?.();
    this.#cancelRenewal = null;
    this.#cancelExpiry = null;
    const remaining = this.#descriptor.expiresAt - this.#now();
    if (remaining <= 0) {
      this.close(1008, "attachment-expired");
      return;
    }
    this.#cancelExpiry = this.#schedule(() => this.close(1008, "attachment-expired"), remaining);
    this.#cancelRenewal = this.#schedule(
      () => {
        this.#cancelRenewal = null;
        this.#renewLease();
      },
      Math.max(1, Math.floor((remaining * 2) / 3)),
    );
  }

  #renewLease(): void {
    if (this.#closed || this.#renewing) return;
    this.#renewing = true;
    void this.#leaseManager
      .renew(this.#leaseId, this.#binding)
      .then(async ({ descriptor }) => {
        if (this.#closed) return;
        if (
          descriptor.leaseId !== this.#descriptor.leaseId ||
          descriptor.requestId !== this.#descriptor.requestId ||
          descriptor.viewerMode !== this.#descriptor.viewerMode ||
          descriptor.viewGeneration !== this.#descriptor.viewGeneration ||
          descriptor.status !== "active" ||
          descriptor.target.workspaceName !== this.#descriptor.target.workspaceName ||
          descriptor.target.semanticPaneId !== this.#descriptor.target.semanticPaneId ||
          descriptor.expiresAt <= this.#now()
        ) {
          throw new TypeError("Terminal attachment lease identity changed during renewal.");
        }
        const geometry = await this.#resolveGeometry(descriptor, this.#client);
        if (this.#closed) return;
        this.#descriptor = structuredClone(descriptor);
        sendControl(this.#socket, {
          type: "geometry",
          protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
          generation: this.#descriptor.viewGeneration,
          sourceGrid: GridSchemaZ.parse(geometry.sourceGrid),
          clientViewport: GridSchemaZ.parse(geometry.clientViewport),
        });
        this.#scheduleLeaseLifecycle();
      })
      .catch(() => {
        if (this.#closed) return;
        try {
          sendControl(this.#socket, {
            type: "error",
            protocolVersion: TERMINAL_ATTACHMENT_PROTOCOL_VERSION,
            code: "attachment-renewal-failed",
            retryable: true,
          });
        } finally {
          this.close(1012, "attachment-renewal-failed");
        }
      })
      .finally(() => {
        this.#renewing = false;
      });
  }
}
