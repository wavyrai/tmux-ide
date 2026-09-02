import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  PaneStreamLeaseRequestSchemaZ,
  type PaneStreamLeaseRequest,
  type PaneStreamViewerMode,
  type TerminalDeliveryOffer,
} from "@tmux-ide/contracts";

/**
 * PaneStreamLeaseManager — in-memory authority for pane-stream leases (m43
 * card 2), following the terminal-attachment lease discipline:
 *
 *  - a one-time `ps1_` bearer ticket whose SHA-256 digest is all the manager
 *    retains, burned before activation so no concurrent caller can replay it;
 *  - the ticket TTL bounds credential DELIVERY (the authenticated redemption
 *    frame must arrive in time); execution after delivery gets its own bounded
 *    processing budget, so a redemption delivered in time is never retired by
 *    its own queue wait (the redeem-expiry fix pattern);
 *  - a daemon restart constructs a fresh manager and invalidates every prior
 *    bearer capability.
 *
 * The lease is SESSION-scoped with its pane set ENUMERATED at issue. In
 * production, semantic panes are resolved through the same trusted catalog as
 * native attachments and their interactive grant is claimed from the shared
 * daemon-generation input authority per live tmux WINDOW.
 */
const BindingIdSchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const RequestIdSchemaZ = z.uuid();
const SessionNameSchemaZ = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\0\r\n]/u.test(value));
const TicketPattern = /^ps1_[A-Za-z0-9_-]{43}$/u;

export interface PaneStreamLeaseBinding {
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly projectIdentity: string;
}

export interface PaneStreamIssueContext {
  readonly requestId: string;
  readonly projectIdentity: string;
  /** Daemon-resolved tmux session backing the workspace. Never renderer input. */
  readonly sessionName: string;
  readonly runtimeSessionId?: string;
  readonly hostClientId?: string;
}

export type PaneStreamLeaseStatus = "awaiting-redemption" | "active";

export interface PaneStreamLeaseDescriptor {
  readonly leaseId: string;
  readonly requestId: string;
  /** Daemon-internal trusted host identity; never copied to renderer descriptors. */
  readonly hostClientId: string | null;
  readonly workspaceName: string;
  /** Daemon-internal: consumed by the endpoint, never sent to a renderer. */
  readonly sessionName: string;
  readonly runtimeSessionId: string | null;
  readonly panes: readonly string[];
  readonly viewerMode: PaneStreamViewerMode;
  readonly terminalDelivery: TerminalDeliveryOffer | null;
  readonly status: PaneStreamLeaseStatus;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface IssuedPaneStreamLease {
  readonly descriptor: PaneStreamLeaseDescriptor;
  /** One-time bearer secret. The manager retains only its SHA-256 digest. */
  readonly redemptionTicket: string;
}

export type PaneStreamLeaseErrorCode =
  | "duplicate-request"
  | "invalid-request"
  | "invalid-ticket"
  | "ticket-expired"
  | "binding-mismatch"
  | "interactive-viewer-conflict"
  | "lease-not-found"
  | "identity-generation-failed";

export class PaneStreamLeaseError extends Error {
  readonly code: PaneStreamLeaseErrorCode;

  constructor(code: PaneStreamLeaseErrorCode, message: string) {
    super(message);
    this.name = "PaneStreamLeaseError";
    this.code = code;
  }
}

export interface PaneStreamLeaseManagerOptions {
  readonly daemonInstanceId: string;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly createId?: () => string;
  /** Bounds credential delivery: the redemption frame must arrive in time. */
  readonly ticketTtlMs?: number;
  /** Bounds the daemon's own serialized work after delivery. */
  readonly redemptionProcessingTtlMs?: number;
}

interface LeaseState {
  leaseId: string;
  requestId: string;
  projectIdentity: string;
  hostClientId: string | null;
  request: PaneStreamLeaseRequest;
  sessionName: string;
  runtimeSessionId: string | null;
  status: PaneStreamLeaseStatus;
  issuedAt: number;
  expiresAt: number;
  ticketDigest: Buffer | null;
  ticketExpiresAt: number | null;
}

function positiveDuration(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function hashTicket(ticket: string): Buffer {
  return createHash("sha256").update(ticket, "utf8").digest();
}

function digestsMatch(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function validateBinding(binding: PaneStreamLeaseBinding): PaneStreamLeaseBinding {
  return {
    daemonInstanceId: BindingIdSchemaZ.parse(binding.daemonInstanceId),
    requestId: RequestIdSchemaZ.parse(binding.requestId),
    projectIdentity: BindingIdSchemaZ.parse(binding.projectIdentity),
  };
}

export class PaneStreamLeaseManager {
  readonly #instanceId: string;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #createId: () => string;
  readonly #ticketTtlMs: number;
  readonly #redemptionProcessingTtlMs: number;
  readonly #leases = new Map<string, LeaseState>();
  readonly #requests = new Map<string, string>();
  readonly #pendingRequests = new Set<string>();

  constructor(options: PaneStreamLeaseManagerOptions) {
    this.#instanceId = BindingIdSchemaZ.parse(options.daemonInstanceId);
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#createId = options.createId ?? randomUUID;
    this.#ticketTtlMs = positiveDuration(options.ticketTtlMs, 15_000, "ticketTtlMs");
    this.#redemptionProcessingTtlMs = positiveDuration(
      options.redemptionProcessingTtlMs,
      60_000,
      "redemptionProcessingTtlMs",
    );
  }

  async issue(
    request: PaneStreamLeaseRequest,
    context: PaneStreamIssueContext,
  ): Promise<IssuedPaneStreamLease> {
    const parsedRequest = PaneStreamLeaseRequestSchemaZ.parse(request);
    const requestId = RequestIdSchemaZ.parse(context.requestId);
    const projectIdentity = BindingIdSchemaZ.parse(context.projectIdentity);
    const hostClientId = context.hostClientId ? BindingIdSchemaZ.parse(context.hostClientId) : null;
    const sessionName = SessionNameSchemaZ.parse(context.sessionName);
    this.#expire(this.#now());
    if (this.#requests.has(requestId) || this.#pendingRequests.has(requestId)) {
      throw new PaneStreamLeaseError("duplicate-request", "The request already owns a lease.");
    }
    this.#pendingRequests.add(requestId);

    try {
      const leaseId = this.#freshId();
      const issuedAt = this.#now();
      const ticketBytes = this.#randomBytes(32);
      if (ticketBytes.byteLength !== 32) {
        throw new PaneStreamLeaseError(
          "identity-generation-failed",
          "The secure random source returned an invalid ticket.",
        );
      }
      const redemptionTicket = `ps1_${Buffer.from(ticketBytes).toString("base64url")}`;
      const state: LeaseState = {
        leaseId,
        requestId,
        projectIdentity,
        hostClientId,
        request: parsedRequest,
        sessionName,
        runtimeSessionId:
          typeof context.runtimeSessionId === "string" ? context.runtimeSessionId : null,
        status: "awaiting-redemption",
        issuedAt,
        expiresAt: issuedAt + this.#ticketTtlMs,
        ticketDigest: hashTicket(redemptionTicket),
        ticketExpiresAt: issuedAt + this.#ticketTtlMs,
      };
      this.#leases.set(leaseId, state);
      this.#requests.set(requestId, leaseId);
      const issued = { descriptor: this.#descriptor(state) } as IssuedPaneStreamLease;
      Object.defineProperty(issued, "redemptionTicket", {
        value: redemptionTicket,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return issued;
    } finally {
      this.#pendingRequests.delete(requestId);
    }
  }

  /**
   * `receivedAt` is the in-process arrival time of the authenticated
   * redemption frame, stamped by the admission boundary BEFORE the redemption
   * queued behind other serialized work: delivery is judged against the
   * ticket TTL at that instant, and execution gets its own bounded budget.
   */
  async redeem(
    ticket: string,
    binding: PaneStreamLeaseBinding,
    receivedAt?: number,
  ): Promise<{ descriptor: PaneStreamLeaseDescriptor }> {
    const parsedBinding = validateBinding(binding);
    if (!TicketPattern.test(ticket)) {
      throw new PaneStreamLeaseError("invalid-ticket", "The redemption ticket is invalid.");
    }
    const candidateDigest = hashTicket(ticket);
    let state: LeaseState | undefined;
    for (const candidate of this.#leases.values()) {
      if (
        candidate.ticketDigest !== null &&
        digestsMatch(candidate.ticketDigest, candidateDigest)
      ) {
        state = candidate;
      }
    }
    candidateDigest.fill(0);
    if (!state || state.ticketDigest === null || state.ticketExpiresAt === null) {
      throw new PaneStreamLeaseError("invalid-ticket", "The redemption ticket is invalid.");
    }
    if (
      parsedBinding.daemonInstanceId !== this.#instanceId ||
      parsedBinding.requestId !== state.requestId ||
      parsedBinding.projectIdentity !== state.projectIdentity
    ) {
      throw new PaneStreamLeaseError(
        "binding-mismatch",
        "The redemption ticket is bound to a different daemon request or project.",
      );
    }

    const now = this.#now();
    // The caller is trusted in-process code; a claimed future arrival still
    // never precedes now, and a claimed past arrival only SHRINKS the budget.
    const deliveredAt =
      typeof receivedAt === "number" && Number.isSafeInteger(receivedAt) && receivedAt <= now
        ? receivedAt
        : now;
    if (deliveredAt >= state.ticketExpiresAt) {
      this.#removeState(state);
      throw new PaneStreamLeaseError("ticket-expired", "The redemption ticket has expired.");
    }
    // Burn the digest first: even concurrent callers cannot replay it.
    state.ticketDigest.fill(0);
    state.ticketDigest = null;
    state.ticketExpiresAt = null;
    if (this.#now() >= deliveredAt + this.#redemptionProcessingTtlMs) {
      this.#removeState(state);
      throw new PaneStreamLeaseError("ticket-expired", "The redemption ticket has expired.");
    }
    state.status = "active";
    // Active leases are connection-bound: the wire connection that redeemed
    // the ticket is the lease's lifetime; there is no wall-clock renewal.
    state.expiresAt = Number.MAX_SAFE_INTEGER;
    return { descriptor: this.#descriptor(state) };
  }

  async release(leaseId: string, binding: PaneStreamLeaseBinding): Promise<{ released: boolean }> {
    const state = this.#leases.get(leaseId);
    if (!state) return { released: false };
    const parsedBinding = validateBinding(binding);
    if (
      parsedBinding.daemonInstanceId !== this.#instanceId ||
      parsedBinding.requestId !== state.requestId ||
      parsedBinding.projectIdentity !== state.projectIdentity
    ) {
      throw new PaneStreamLeaseError(
        "binding-mismatch",
        "The pane-stream lease is bound to a different daemon request or project.",
      );
    }
    this.#removeState(state);
    return { released: true };
  }

  sweep(): void {
    this.#expire(this.#now());
  }

  snapshot(): { readonly leases: readonly PaneStreamLeaseDescriptor[] } {
    return { leases: [...this.#leases.values()].map((state) => this.#descriptor(state)) };
  }

  #expire(now: number): void {
    // The sweep waits out the processing budget past the ticket TTL: a
    // redemption whose frame was DELIVERED in time may still be queued behind
    // serialized work, and the sweep must not retire it (the ticket bounds
    // delivery; execution has its own budget). redeem() itself still rejects
    // any late delivery at the TTL.
    for (const state of [...this.#leases.values()]) {
      if (
        state.status === "awaiting-redemption" &&
        now >= state.expiresAt + this.#redemptionProcessingTtlMs
      ) {
        this.#removeState(state);
      }
    }
  }

  #freshId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.#createId();
      if (z.uuid().safeParse(candidate).success && !this.#leases.has(candidate)) return candidate;
    }
    throw new PaneStreamLeaseError(
      "identity-generation-failed",
      "Could not allocate a unique pane-stream lease identity.",
    );
  }

  #removeState(state: LeaseState): void {
    if (this.#leases.get(state.leaseId) !== state) return;
    this.#leases.delete(state.leaseId);
    this.#requests.delete(state.requestId);
    state.ticketDigest?.fill(0);
    state.ticketDigest = null;
    state.ticketExpiresAt = null;
  }

  #descriptor(state: LeaseState): PaneStreamLeaseDescriptor {
    return {
      leaseId: state.leaseId,
      requestId: state.requestId,
      hostClientId: state.hostClientId,
      workspaceName: state.request.workspaceName,
      sessionName: state.sessionName,
      runtimeSessionId: state.runtimeSessionId,
      panes: [...state.request.panes],
      viewerMode: state.request.viewerMode,
      terminalDelivery: state.request.terminalDelivery ?? null,
      status: state.status,
      issuedAt: state.issuedAt,
      expiresAt: state.expiresAt,
    };
  }
}
