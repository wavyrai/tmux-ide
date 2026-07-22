import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  TerminalAttachRequestSchemaZ,
  type TerminalAttachRequest,
  type TerminalAttachmentSemanticTarget,
  type TerminalAttachmentViewerMode,
} from "@tmux-ide/contracts";
import {
  GROUPED_TMUX_MAX_GENERATION,
  GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  GROUPED_TMUX_VIEW_SESSION_PREFIX,
  groupedTmuxViewSessionName,
  planGroupedTmuxAttachment,
  type GroupedTmuxAttachmentPlan,
} from "./grouped-tmux.ts";
import {
  SemanticPaneCatalog,
  semanticPaneTargetKey,
  type SemanticPaneResolution,
} from "./semantic-pane-catalog.ts";

const BindingIdSchemaZ = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"));
const RequestIdSchemaZ = z.uuid();
const RuntimeWindowId = /^@(?:0|[1-9][0-9]*)$/u;
const AttachmentViewOperationSchemaZ = z.enum(["create", "attach", "recover"]);
const RedemptionTicketPattern = /^ta1_[A-Za-z0-9_-]{43}$/u;
const MarkerPattern =
  /^v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*)$/iu;

export interface AttachmentLeaseBinding {
  readonly daemonInstanceId: string;
  readonly requestId: string;
  readonly projectIdentity: string;
}

export interface AttachmentIssueContext {
  readonly requestId: string;
  readonly projectIdentity: string;
}

export interface EnumeratedMarkedAttachmentView {
  readonly viewSessionName: string;
  readonly markerValue: string | null;
  readonly windowIds: readonly string[];
}

export type GuardedAttachmentCleanupResult =
  | "cleaned"
  | "absent"
  | "ownership-mismatch"
  | "topology-mismatch";

export interface GuardedAttachmentCleanup {
  /** Exact-name tmux target. Never a caller-authored prefix or pattern. */
  readonly exactViewSessionTarget: `=${string}`;
  readonly markerEnvironment: typeof GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT;
  readonly expectedMarkerValue: string;
  readonly expectedWindowId: string;
}

export type AttachmentViewOperation = "create" | "attach" | "recover";

export interface GuardedAttachmentViewOperation {
  readonly operation: AttachmentViewOperation;
  readonly exactViewSessionTarget: `=${string}`;
  /** Immutable effective lease/grace deadline checked inside the executor. */
  readonly deadline: number;
  readonly source: {
    readonly sessionId: string;
    readonly windowId: string;
    readonly runtimePaneId: string;
    readonly paneCount: 1;
  };
  /** Server-authored plan whose selected operation is executed by this guard. */
  readonly plan: GroupedTmuxAttachmentPlan;
}

export type GuardedAttachmentViewOperationResult =
  | "executed"
  | "source-proof-mismatch"
  | "lease-expired";

/**
 * All tmux I/O remains behind this daemon-owned boundary. `guardedCleanup`
 * must validate exact session name, marker and one-window topology and perform
 * the kill as one server-owned serialized operation. Implementations must not
 * expose the check and mutation as separate awaits.
 */
export interface AttachmentViewExecutor {
  readonly guardedCleanup: (
    cleanup: GuardedAttachmentCleanup,
  ) => Promise<GuardedAttachmentCleanupResult>;
  /**
   * Revalidates source session/window/pane/single-pane truth and executes the
   * selected create/attach/recover plan as one server-owned serialized
   * operation. Implementations must check `deadline` with their own clock
   * immediately before mutation and must not return between proof, deadline
   * check and mutation.
   */
  readonly executeGuardedViewOperation: (
    operation: GuardedAttachmentViewOperation,
  ) => Promise<GuardedAttachmentViewOperationResult>;
  readonly enumerateMarkedViews: (
    prefix: typeof GROUPED_TMUX_VIEW_SESSION_PREFIX,
    markerEnvironment: typeof GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
  ) => Promise<readonly EnumeratedMarkedAttachmentView[]>;
}

export type AttachmentLeaseStatus = "awaiting-redemption" | "active" | "disconnected";

export interface AttachmentLeaseDescriptor {
  readonly leaseId: string;
  readonly requestId: string;
  readonly target: TerminalAttachmentSemanticTarget;
  readonly viewerMode: TerminalAttachmentViewerMode;
  readonly status: AttachmentLeaseStatus;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly graceExpiresAt: number | null;
  readonly bindingGeneration: number;
  readonly viewGeneration: number;
}

export interface IssuedAttachmentLease {
  readonly descriptor: AttachmentLeaseDescriptor;
  /** One-time bearer secret. The manager retains only its SHA-256 digest. */
  readonly redemptionTicket: string;
}

export interface RedeemedAttachmentLease {
  readonly descriptor: AttachmentLeaseDescriptor;
}

export interface ExecutedAttachmentViewOperation {
  readonly descriptor: AttachmentLeaseDescriptor;
  readonly operation: AttachmentViewOperation;
}

export interface ReconciledOrphanAttachmentDescriptor {
  readonly attachmentId: string;
  readonly generation: number;
}

export interface AttachmentOrphanReconciliationResult {
  readonly cleaned: readonly ReconciledOrphanAttachmentDescriptor[];
  readonly failed: readonly ReconciledOrphanAttachmentDescriptor[];
  /** Includes invalid/unowned/current/mismatched candidates without echoing names. */
  readonly skippedCount: number;
}

export type AttachmentCleanupStatus =
  | "cleaned"
  | "absent"
  | "ownership-mismatch"
  | "topology-mismatch"
  | "failed";

export interface AttachmentLeaseAuditEvent {
  readonly type:
    | "issued"
    | "redeemed"
    | "renewed"
    | "disconnected"
    | "released"
    | "expired"
    | "rebound"
    | "cleanup-failed"
    | "orphan-cleaned";
  readonly leaseId: string;
  readonly requestId: string;
  readonly target: TerminalAttachmentSemanticTarget;
  readonly viewerMode: TerminalAttachmentViewerMode;
  readonly at: number;
  readonly reason?: string;
}

export type AttachmentLeaseErrorCode =
  | "interactive-viewer-conflict"
  | "duplicate-request"
  | "invalid-ticket"
  | "ticket-expired"
  | "binding-mismatch"
  | "lease-not-found"
  | "lease-not-active"
  | "lease-expired"
  | "invalid-ttl"
  | "view-generation-exhausted"
  | "view-cleanup-failed"
  | "view-operation-failed"
  | "orphan-enumeration-failed"
  | "source-proof-mismatch"
  | "identity-generation-failed";

export class AttachmentLeaseError extends Error {
  readonly code: AttachmentLeaseErrorCode;

  constructor(code: AttachmentLeaseErrorCode, message: string) {
    super(message);
    this.name = "AttachmentLeaseError";
    this.code = code;
  }
}

export interface AttachmentLeaseManagerOptions {
  readonly daemonInstanceId: string;
  readonly catalog: SemanticPaneCatalog;
  readonly viewExecutor: AttachmentViewExecutor;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly createId?: () => string;
  readonly ticketTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly maxLeaseTtlMs?: number;
  readonly disconnectGraceMs?: number;
  readonly onAudit?: (event: AttachmentLeaseAuditEvent) => void;
}

interface LeaseState {
  leaseId: string;
  requestId: string;
  projectIdentity: string;
  request: TerminalAttachRequest;
  status: AttachmentLeaseStatus;
  issuedAt: number;
  expiresAt: number;
  graceExpiresAt: number | null;
  ticketDigest: Buffer | null;
  ticketExpiresAt: number | null;
  resolution: SemanticPaneResolution;
  /** Exact global tmux pane identity currently reserved by this lease. */
  interactiveRuntimeKey: string | null;
  viewGeneration: number;
  plan: GroupedTmuxAttachmentPlan;
}

interface CleanupResult {
  leaseId: string;
  status: AttachmentCleanupStatus;
}

interface ParsedOrphanIdentity extends ReconciledOrphanAttachmentDescriptor {
  viewSessionName: string;
  markerValue: string;
  windowId: string;
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

function constantTimeDigestMatch(left: Buffer, right: Buffer): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function validateBinding(binding: AttachmentLeaseBinding): AttachmentLeaseBinding {
  return {
    daemonInstanceId: BindingIdSchemaZ.parse(binding.daemonInstanceId),
    requestId: RequestIdSchemaZ.parse(binding.requestId),
    projectIdentity: BindingIdSchemaZ.parse(binding.projectIdentity),
  };
}

function sameBinding(
  state: LeaseState,
  binding: AttachmentLeaseBinding,
  instanceId: string,
): boolean {
  return (
    binding.daemonInstanceId === instanceId &&
    binding.requestId === state.requestId &&
    binding.projectIdentity === state.projectIdentity
  );
}

function sameLinkedWindow(left: SemanticPaneResolution, right: SemanticPaneResolution): boolean {
  // `@window_id` is server-global and is unchanged when linked into another
  // session, just like `%pane_id`. Session aliases do not rotate the view.
  return left.source.windowId === right.source.windowId;
}

function runtimePaneKey(resolution: SemanticPaneResolution): string {
  // `%pane_id` is server-global and remains stable when a window is linked
  // into another session. Including `$session_id` would permit two writers.
  return resolution.source.runtimePaneId;
}

function exactViewSessionTarget(plan: GroupedTmuxAttachmentPlan): `=${string}` {
  return `=${plan.identity.viewSessionName}`;
}

/**
 * In-memory authority for terminal attachment leases. Constructing a new
 * instance intentionally restores no tickets or leases: a daemon restart
 * invalidates every prior bearer capability.
 */
export class AttachmentLeaseManager {
  readonly #instanceId: string;
  readonly #catalog: SemanticPaneCatalog;
  readonly #viewExecutor: AttachmentViewExecutor;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #createId: () => string;
  readonly #ticketTtlMs: number;
  readonly #leaseTtlMs: number;
  readonly #maxLeaseTtlMs: number;
  readonly #disconnectGraceMs: number;
  readonly #onAudit: ((event: AttachmentLeaseAuditEvent) => void) | undefined;
  readonly #leases = new Map<string, LeaseState>();
  readonly #requests = new Map<string, string>();
  readonly #interactiveOwners = new Map<string, string>();
  readonly #interactiveRuntimeOwners = new Map<string, string>();
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: AttachmentLeaseManagerOptions) {
    this.#instanceId = BindingIdSchemaZ.parse(options.daemonInstanceId);
    this.#catalog = options.catalog;
    this.#viewExecutor = options.viewExecutor;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#createId = options.createId ?? randomUUID;
    this.#ticketTtlMs = positiveDuration(options.ticketTtlMs, 15_000, "ticketTtlMs");
    this.#leaseTtlMs = positiveDuration(options.leaseTtlMs, 60_000, "leaseTtlMs");
    this.#maxLeaseTtlMs = positiveDuration(
      options.maxLeaseTtlMs,
      this.#leaseTtlMs,
      "maxLeaseTtlMs",
    );
    if (this.#leaseTtlMs > this.#maxLeaseTtlMs) {
      throw new TypeError("leaseTtlMs must not exceed maxLeaseTtlMs.");
    }
    this.#disconnectGraceMs = positiveDuration(
      options.disconnectGraceMs,
      5_000,
      "disconnectGraceMs",
    );
    this.#onAudit = options.onAudit;
  }

  issue(
    request: TerminalAttachRequest,
    context: AttachmentIssueContext,
  ): Promise<IssuedAttachmentLease> {
    return this.#exclusive(async () => {
      const parsedRequest = TerminalAttachRequestSchemaZ.parse(request);
      const requestId = RequestIdSchemaZ.parse(context.requestId);
      const projectIdentity = BindingIdSchemaZ.parse(context.projectIdentity);
      await this.#expireAndCleanup(this.#now());
      if (this.#requests.has(requestId)) {
        throw new AttachmentLeaseError("duplicate-request", "The request already owns a lease.");
      }

      const resolution = await this.#catalog.resolve(parsedRequest.target);
      await this.#expireAndCleanup(this.#now());
      const targetKey = semanticPaneTargetKey(parsedRequest.target);
      const runtimeKey = runtimePaneKey(resolution);
      if (parsedRequest.viewerMode === "interactive") {
        if (
          this.#interactiveOwners.has(targetKey) ||
          this.#interactiveRuntimeOwners.has(runtimeKey)
        ) {
          throw new AttachmentLeaseError(
            "interactive-viewer-conflict",
            "The resolved runtime pane already has an interactive input owner.",
          );
        }
      }

      const leaseId = this.#freshId();
      const issuedAt = this.#now();
      const ticketBytes = this.#randomBytes(32);
      if (ticketBytes.byteLength !== 32) {
        throw new AttachmentLeaseError(
          "identity-generation-failed",
          "The secure random source returned an invalid ticket.",
        );
      }
      const redemptionTicket = `ta1_${Buffer.from(ticketBytes).toString("base64url")}`;
      const plan = this.#buildPlan(leaseId, 0, parsedRequest, resolution);
      const state: LeaseState = {
        leaseId,
        requestId,
        projectIdentity,
        request: parsedRequest,
        status: "awaiting-redemption",
        issuedAt,
        expiresAt: issuedAt + this.#ticketTtlMs,
        graceExpiresAt: null,
        ticketDigest: hashTicket(redemptionTicket),
        ticketExpiresAt: issuedAt + this.#ticketTtlMs,
        resolution,
        interactiveRuntimeKey: parsedRequest.viewerMode === "interactive" ? runtimeKey : null,
        viewGeneration: 0,
        plan,
      };
      this.#leases.set(leaseId, state);
      this.#requests.set(requestId, leaseId);
      if (parsedRequest.viewerMode === "interactive") {
        this.#interactiveOwners.set(targetKey, leaseId);
        this.#interactiveRuntimeOwners.set(runtimeKey, leaseId);
      }
      this.#audit("issued", state, issuedAt);
      const issued = { descriptor: this.#descriptor(state) } as IssuedAttachmentLease;
      Object.defineProperty(issued, "redemptionTicket", {
        value: redemptionTicket,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      return issued;
    });
  }

  redeem(ticket: string, binding: AttachmentLeaseBinding): Promise<RedeemedAttachmentLease> {
    return this.#exclusive(async () => {
      const parsedBinding = validateBinding(binding);
      if (!RedemptionTicketPattern.test(ticket)) {
        throw new AttachmentLeaseError("invalid-ticket", "The redemption ticket is invalid.");
      }
      const candidateDigest = hashTicket(ticket);
      let state: LeaseState | undefined;
      for (const candidate of this.#leases.values()) {
        if (
          candidate.ticketDigest !== null &&
          constantTimeDigestMatch(candidate.ticketDigest, candidateDigest)
        ) {
          state = candidate;
        }
      }
      candidateDigest.fill(0);
      if (!state || state.ticketDigest === null || state.ticketExpiresAt === null) {
        throw new AttachmentLeaseError("invalid-ticket", "The redemption ticket is invalid.");
      }
      if (!sameBinding(state, parsedBinding, this.#instanceId)) {
        throw new AttachmentLeaseError(
          "binding-mismatch",
          "The redemption ticket is bound to a different daemon request or project.",
        );
      }

      const now = this.#now();
      if (now >= state.ticketExpiresAt) {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError("ticket-expired", "The redemption ticket has expired.");
      }
      const ticketDeadline = state.ticketExpiresAt;

      // Delete before the first await: even concurrent callers cannot replay it.
      state.ticketDigest.fill(0);
      state.ticketDigest = null;
      state.ticketExpiresAt = null;
      try {
        const resolution = await this.#catalog.resolve(state.request.target);
        await this.#expireTicketOrThrow(state, ticketDeadline);
        await this.#applyResolution(state, resolution);
        await this.#expireTicketOrThrow(state, ticketDeadline);
      } catch (error) {
        if (this.#leases.get(state.leaseId) === state) {
          this.#removeState(state);
          await this.#cleanupPlan(state);
        }
        if (this.#now() >= ticketDeadline) {
          throw new AttachmentLeaseError("ticket-expired", "The redemption ticket has expired.");
        }
        throw error;
      }
      const activatedAt = this.#now();
      if (activatedAt >= ticketDeadline) {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError("ticket-expired", "The redemption ticket has expired.");
      }
      state.status = "active";
      state.graceExpiresAt = null;
      state.expiresAt = activatedAt + this.#leaseTtlMs;
      this.#audit("redeemed", state, activatedAt);
      return { descriptor: this.#descriptor(state) };
    });
  }

  renew(
    leaseId: string,
    binding: AttachmentLeaseBinding,
    ttlMs = this.#leaseTtlMs,
  ): Promise<RedeemedAttachmentLease> {
    return this.#exclusive(async () => {
      const parsedBinding = validateBinding(binding);
      const state = this.#requireLease(leaseId, parsedBinding);
      const now = this.#now();
      if (this.#isExpired(state, now)) {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
      }
      if (state.status === "awaiting-redemption") {
        throw new AttachmentLeaseError(
          "lease-not-active",
          "The attachment lease has not been redeemed.",
        );
      }
      const requestedTtl = this.#validateTtl(ttlMs);
      try {
        const resolution = await this.#catalog.resolve(state.request.target);
        await this.#expireLeaseOrThrow(state);
        await this.#applyResolution(state, resolution);
        await this.#expireLeaseOrThrow(state);
      } catch (error) {
        if (this.#leases.get(state.leaseId) === state && this.#isExpired(state, this.#now())) {
          this.#removeState(state);
          await this.#cleanupPlan(state);
          throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
        }
        throw error;
      }
      const renewedAt = this.#now();
      if (this.#isExpired(state, renewedAt)) {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
      }
      state.status = "active";
      state.graceExpiresAt = null;
      state.expiresAt = renewedAt + requestedTtl;
      this.#audit("renewed", state, renewedAt);
      return { descriptor: this.#descriptor(state) };
    });
  }

  /**
   * Final server-side boundary for create/attach/recover execution. The
   * executor owns fresh proof and mutation together; no authorized plan is
   * returned for a caller to execute later.
   */
  executeViewOperation(
    leaseId: string,
    binding: AttachmentLeaseBinding,
    operation: AttachmentViewOperation,
  ): Promise<ExecutedAttachmentViewOperation> {
    return this.#exclusive(async () => {
      const state = this.#requireLease(leaseId, validateBinding(binding));
      await this.#expireLeaseOrThrow(state);
      if (state.status === "awaiting-redemption") {
        throw new AttachmentLeaseError(
          "lease-not-active",
          "The attachment lease has not been redeemed.",
        );
      }
      const parsedOperation = AttachmentViewOperationSchemaZ.parse(operation);
      let executionResult: GuardedAttachmentViewOperationResult;
      try {
        const resolution = await this.#catalog.resolve(state.request.target);
        await this.#expireLeaseOrThrow(state);
        await this.#applyResolution(state, resolution);
        await this.#expireLeaseOrThrow(state);
        try {
          executionResult = await this.#viewExecutor.executeGuardedViewOperation({
            operation: parsedOperation,
            exactViewSessionTarget: exactViewSessionTarget(state.plan),
            deadline: this.#effectiveDeadline(state),
            source: {
              sessionId: state.resolution.source.sessionId,
              windowId: state.resolution.source.windowId,
              runtimePaneId: state.resolution.source.runtimePaneId,
              paneCount: 1,
            },
            plan: structuredClone(state.plan),
          });
        } catch {
          this.#removeState(state);
          await this.#cleanupPlan(state);
          throw new AttachmentLeaseError(
            "view-operation-failed",
            "The guarded terminal view operation failed.",
          );
        }
        await this.#expireLeaseOrThrow(state);
      } catch (error) {
        if (this.#leases.get(state.leaseId) === state && this.#isExpired(state, this.#now())) {
          this.#removeState(state);
          await this.#cleanupPlan(state);
          throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
        }
        throw error;
      }
      if (executionResult === "source-proof-mismatch") {
        throw new AttachmentLeaseError(
          "source-proof-mismatch",
          "Trusted source topology changed before the attachment operation.",
        );
      }
      if (executionResult === "lease-expired") {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
      }
      if (executionResult !== "executed") {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError(
          "view-operation-failed",
          "The guarded terminal view operation failed.",
        );
      }
      return {
        descriptor: this.#descriptor(state),
        operation: parsedOperation,
      };
    });
  }

  disconnect(leaseId: string, binding: AttachmentLeaseBinding): Promise<AttachmentLeaseDescriptor> {
    return this.#exclusive(async () => {
      const state = this.#requireLease(leaseId, validateBinding(binding));
      const now = this.#now();
      if (this.#isExpired(state, now)) {
        this.#removeState(state);
        await this.#cleanupPlan(state);
        throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
      }
      if (state.status === "awaiting-redemption") {
        throw new AttachmentLeaseError(
          "lease-not-active",
          "The attachment lease has not been redeemed.",
        );
      }
      state.status = "disconnected";
      state.graceExpiresAt = now + this.#disconnectGraceMs;
      this.#audit("disconnected", state, now);
      return this.#descriptor(state);
    });
  }

  release(
    leaseId: string,
    binding: AttachmentLeaseBinding,
  ): Promise<{ released: boolean; cleanup: AttachmentCleanupStatus }> {
    return this.#exclusive(async () => {
      const state = this.#leases.get(leaseId);
      if (!state) return { released: false, cleanup: "absent" };
      const parsedBinding = validateBinding(binding);
      if (!sameBinding(state, parsedBinding, this.#instanceId)) {
        throw new AttachmentLeaseError(
          "binding-mismatch",
          "The attachment lease is bound to a different daemon request or project.",
        );
      }
      this.#removeState(state);
      const cleanup = await this.#cleanupPlan(state);
      this.#audit("released", state, this.#now());
      return { released: true, cleanup: cleanup.status };
    });
  }

  sweep(): Promise<readonly CleanupResult[]> {
    return this.#exclusive(() => this.#expireAndCleanup(this.#now()));
  }

  reconcileOrphanViews(): Promise<AttachmentOrphanReconciliationResult> {
    return this.#exclusive(async () => {
      const activeNames = new Set(
        [...this.#leases.values()].map((state) => state.plan.identity.viewSessionName),
      );
      let candidates: readonly EnumeratedMarkedAttachmentView[];
      try {
        const enumerated = await this.#viewExecutor.enumerateMarkedViews(
          GROUPED_TMUX_VIEW_SESSION_PREFIX,
          GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
        );
        if (!Array.isArray(enumerated)) throw new TypeError("Invalid marked view enumeration.");
        candidates = [...enumerated];
      } catch {
        throw new AttachmentLeaseError(
          "orphan-enumeration-failed",
          "Marked attachment view enumeration failed.",
        );
      }
      const cleaned: ReconciledOrphanAttachmentDescriptor[] = [];
      const failed: ReconciledOrphanAttachmentDescriptor[] = [];
      let skippedCount = 0;

      for (const candidate of candidates) {
        let parsed: ParsedOrphanIdentity | null;
        try {
          parsed = this.#parseOrphanIdentity(candidate);
        } catch {
          parsed = null;
        }
        if (!parsed) {
          skippedCount += 1;
          continue;
        }
        const identity = {
          attachmentId: parsed.attachmentId,
          generation: parsed.generation,
        };
        if (activeNames.has(parsed.viewSessionName)) {
          skippedCount += 1;
          continue;
        }
        try {
          const result = await this.#viewExecutor.guardedCleanup({
            exactViewSessionTarget: `=${parsed.viewSessionName}`,
            markerEnvironment: GROUPED_TMUX_VIEW_MARKER_ENVIRONMENT,
            expectedMarkerValue: parsed.markerValue,
            expectedWindowId: parsed.windowId,
          });
          switch (result) {
            case "cleaned":
              break;
            case "absent":
            case "ownership-mismatch":
            case "topology-mismatch":
              skippedCount += 1;
              continue;
            default:
              throw new TypeError("The guarded cleanup executor returned an invalid result.");
          }
          cleaned.push(identity);
          this.#emitAudit({
            type: "orphan-cleaned",
            leaseId: identity.attachmentId,
            requestId: "orphan",
            target: { workspaceName: "orphan", semanticPaneId: "orphan" },
            viewerMode: "read-only",
            at: this.#now(),
          });
        } catch {
          failed.push(identity);
        }
      }
      return { cleaned, failed, skippedCount };
    });
  }

  snapshot(): {
    readonly daemonInstanceId: string;
    readonly leases: readonly AttachmentLeaseDescriptor[];
  } {
    return {
      daemonInstanceId: this.#instanceId,
      leases: [...this.#leases.values()].map((state) => this.#descriptor(state)),
    };
  }

  toJSON(): ReturnType<AttachmentLeaseManager["snapshot"]> {
    return this.snapshot();
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #freshId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.#createId();
      if (z.uuid().safeParse(candidate).success && !this.#leases.has(candidate)) return candidate;
    }
    throw new AttachmentLeaseError(
      "identity-generation-failed",
      "Could not allocate a unique attachment identity.",
    );
  }

  #validateTtl(ttlMs: number): number {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.#maxLeaseTtlMs) {
      throw new AttachmentLeaseError("invalid-ttl", "The requested lease TTL is invalid.");
    }
    return ttlMs;
  }

  #requireLease(leaseId: string, binding: AttachmentLeaseBinding): LeaseState {
    const state = this.#leases.get(leaseId);
    if (!state)
      throw new AttachmentLeaseError("lease-not-found", "The attachment lease is absent.");
    if (!sameBinding(state, binding, this.#instanceId)) {
      throw new AttachmentLeaseError(
        "binding-mismatch",
        "The attachment lease is bound to a different daemon request or project.",
      );
    }
    return state;
  }

  #buildPlan(
    leaseId: string,
    generation: number,
    request: TerminalAttachRequest,
    resolution: SemanticPaneResolution,
  ): GroupedTmuxAttachmentPlan {
    return planGroupedTmuxAttachment({
      attachmentId: leaseId,
      generation,
      target: request.target,
      viewerMode: request.viewerMode,
      viewport: request.viewport,
      source: {
        sessionId: resolution.source.sessionId,
        windowId: resolution.source.windowId,
        runtimePaneId: resolution.source.runtimePaneId,
        paneCount: 1,
      },
    });
  }

  async #applyResolution(state: LeaseState, resolution: SemanticPaneResolution): Promise<void> {
    const oldRuntimeKey = state.interactiveRuntimeKey;
    const newRuntimeKey = runtimePaneKey(resolution);
    if (oldRuntimeKey !== null && oldRuntimeKey !== newRuntimeKey) {
      const owner = this.#interactiveRuntimeOwners.get(newRuntimeKey);
      if (owner !== undefined && owner !== state.leaseId) {
        throw new AttachmentLeaseError(
          "interactive-viewer-conflict",
          "The rebound runtime pane already has an interactive input owner.",
        );
      }
    }
    const linkedWindowChanged = !sameLinkedWindow(state.resolution, resolution);
    const nextViewGeneration = linkedWindowChanged
      ? state.viewGeneration + 1
      : state.viewGeneration;
    if (linkedWindowChanged) {
      if (state.viewGeneration >= GROUPED_TMUX_MAX_GENERATION) {
        throw new AttachmentLeaseError(
          "view-generation-exhausted",
          "The attachment view generation is exhausted.",
        );
      }
    }

    // Build every fallible next-state value before cleanup or state mutation.
    // This keeps resolution, plan and ownership migration transactional.
    const nextPlan = this.#buildPlan(state.leaseId, nextViewGeneration, state.request, resolution);
    if (linkedWindowChanged) {
      const cleanup = await this.#cleanupPlan(state);
      if (cleanup.status !== "cleaned" && cleanup.status !== "absent") {
        throw new AttachmentLeaseError(
          "view-cleanup-failed",
          "The prior marked attachment view could not be safely cleaned.",
        );
      }
    }
    const changed = state.resolution.bindingGeneration !== resolution.bindingGeneration;
    state.resolution = resolution;
    state.viewGeneration = nextViewGeneration;
    state.plan = nextPlan;
    if (oldRuntimeKey !== null && oldRuntimeKey !== newRuntimeKey) {
      if (this.#interactiveRuntimeOwners.get(oldRuntimeKey) === state.leaseId) {
        this.#interactiveRuntimeOwners.delete(oldRuntimeKey);
      }
      this.#interactiveRuntimeOwners.set(newRuntimeKey, state.leaseId);
      state.interactiveRuntimeKey = newRuntimeKey;
    }
    if (changed) this.#audit("rebound", state, this.#now());
  }

  #isExpired(state: LeaseState, now: number): boolean {
    return now >= state.expiresAt || (state.graceExpiresAt !== null && now >= state.graceExpiresAt);
  }

  #effectiveDeadline(state: LeaseState): number {
    return state.graceExpiresAt === null
      ? state.expiresAt
      : Math.min(state.expiresAt, state.graceExpiresAt);
  }

  async #expireTicketOrThrow(state: LeaseState, deadline: number): Promise<void> {
    if (this.#now() < deadline) return;
    this.#removeState(state);
    await this.#cleanupPlan(state);
    throw new AttachmentLeaseError("ticket-expired", "The redemption ticket has expired.");
  }

  async #expireLeaseOrThrow(state: LeaseState): Promise<void> {
    if (!this.#isExpired(state, this.#now())) return;
    this.#removeState(state);
    await this.#cleanupPlan(state);
    throw new AttachmentLeaseError("lease-expired", "The attachment lease has expired.");
  }

  async #expireAndCleanup(now: number): Promise<readonly CleanupResult[]> {
    const expired = [...this.#leases.values()].filter((state) => this.#isExpired(state, now));
    const results: CleanupResult[] = [];
    for (const state of expired) {
      this.#removeState(state);
      const cleanup = await this.#cleanupPlan(state);
      results.push(cleanup);
      this.#audit("expired", state, now);
    }
    return results;
  }

  #removeState(state: LeaseState): void {
    if (this.#leases.get(state.leaseId) !== state) return;
    this.#leases.delete(state.leaseId);
    this.#requests.delete(state.requestId);
    const targetKey = semanticPaneTargetKey(state.request.target);
    if (this.#interactiveOwners.get(targetKey) === state.leaseId) {
      this.#interactiveOwners.delete(targetKey);
    }
    if (
      state.interactiveRuntimeKey !== null &&
      this.#interactiveRuntimeOwners.get(state.interactiveRuntimeKey) === state.leaseId
    ) {
      this.#interactiveRuntimeOwners.delete(state.interactiveRuntimeKey);
    }
    state.interactiveRuntimeKey = null;
    state.ticketDigest?.fill(0);
    state.ticketDigest = null;
    state.ticketExpiresAt = null;
  }

  async #cleanupPlan(state: LeaseState): Promise<CleanupResult> {
    const leaseId = state.leaseId;
    try {
      const status = await this.#viewExecutor.guardedCleanup({
        exactViewSessionTarget: exactViewSessionTarget(state.plan),
        markerEnvironment: state.plan.identity.markerEnvironment,
        expectedMarkerValue: state.plan.identity.markerValue,
        expectedWindowId: state.plan.recover.topology.expectedStdout,
      });
      switch (status) {
        case "cleaned":
        case "absent":
        case "ownership-mismatch":
        case "topology-mismatch":
          return { leaseId, status };
        default:
          throw new TypeError("The guarded cleanup executor returned an invalid result.");
      }
    } catch {
      this.#audit("cleanup-failed", state, this.#now(), "executor-failed");
      return { leaseId, status: "failed" };
    }
  }

  #parseOrphanIdentity(candidate: EnumeratedMarkedAttachmentView): ParsedOrphanIdentity | null {
    if (
      !candidate.viewSessionName.startsWith(GROUPED_TMUX_VIEW_SESSION_PREFIX) ||
      candidate.markerValue === null ||
      candidate.windowIds.length !== 1 ||
      !RuntimeWindowId.test(candidate.windowIds[0] ?? "")
    ) {
      return null;
    }
    const marker = candidate.markerValue.match(MarkerPattern);
    if (!marker) return null;
    const attachmentId = marker[1]!.toLowerCase();
    const generation = Number(marker[2]);
    if (!Number.isSafeInteger(generation) || generation > GROUPED_TMUX_MAX_GENERATION) return null;
    if (groupedTmuxViewSessionName(attachmentId, generation) !== candidate.viewSessionName) {
      return null;
    }
    return {
      attachmentId,
      generation,
      viewSessionName: candidate.viewSessionName,
      markerValue: candidate.markerValue,
      windowId: candidate.windowIds[0]!,
    };
  }

  #descriptor(state: LeaseState): AttachmentLeaseDescriptor {
    return {
      leaseId: state.leaseId,
      requestId: state.requestId,
      target: { ...state.request.target },
      viewerMode: state.request.viewerMode,
      status: state.status,
      issuedAt: state.issuedAt,
      expiresAt: state.expiresAt,
      graceExpiresAt: state.graceExpiresAt,
      bindingGeneration: state.resolution.bindingGeneration,
      viewGeneration: state.viewGeneration,
    };
  }

  #audit(
    type: AttachmentLeaseAuditEvent["type"],
    state: LeaseState,
    at: number,
    reason?: string,
  ): void {
    this.#emitAudit({
      type,
      leaseId: state.leaseId,
      requestId: state.requestId,
      target: { ...state.request.target },
      viewerMode: state.request.viewerMode,
      at,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  #emitAudit(event: AttachmentLeaseAuditEvent): void {
    try {
      this.#onAudit?.(event);
    } catch {
      // Observability must never change lease ownership or ticket semantics.
    }
  }
}
