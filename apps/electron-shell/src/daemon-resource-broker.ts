import { randomUUID } from "node:crypto";
import {
  AppWindowMutationArgumentsSchemaZ,
  AppWindowMutationRequestSchemaZ,
  WorkspaceMultiplexerMutationRequestSchemaZ,
  WorkspaceMultiplexerMutationResultSchemaZ,
  type WorkspaceMultiplexerMutationRequest,
  type WorkspaceMultiplexerMutationResult,
  daemonWorkspaceRouteName,
  type DaemonWorkspaceResourceKind,
  AppWindowMutationResultSchemaZ,
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellResourceV2SchemaZ,
  ApplicationShellResourceV3SchemaZ,
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DesktopDaemonEventSchemaZ,
  DesktopDaemonCapabilitiesResultSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonFetchApplicationShellResultSchemaZ,
  DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ,
  DesktopDaemonFetchWorkspaceChangesRequestSchemaZ,
  DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ,
  DesktopDaemonFetchWorkspaceFilesRequestSchemaZ,
  DesktopDaemonHostStateSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopWorkspaceNameSchemaZ,
  WorkspaceChangeDiffEnvelopeV1SchemaZ,
  WorkspaceChangesCatalogEnvelopeV1SchemaZ,
  WorkspaceFilePreviewEnvelopeV1SchemaZ,
  WorkspaceFilesCatalogEnvelopeV1SchemaZ,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TERMINAL_ATTACHMENT_MAX_ISSUE_DESCRIPTOR_LIFETIME_MS,
  TerminalAttachmentIssueDescriptorSchemaZ,
  TerminalAttachmentIssueMutationRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
  type TerminalAttachmentIssueError,
  type TerminalAttachmentIssueErrorCode,
  type TerminalAttachmentIssueMutationRequest,
  type TerminalAttachmentIssueResult,
  PANE_STREAM_ISSUE_PATH,
  PaneStreamIssueDescriptorSchemaZ,
  PaneStreamIssueMutationRequestSchemaZ,
  PaneStreamIssueResultSchemaZ,
  type PaneStreamIssueError,
  type PaneStreamIssueErrorCode,
  type TerminalIssueErrorCode,
  type PaneStreamIssueMutationRequest,
  type PaneStreamIssueResult,
  type DesktopDaemonFetchApplicationShellRequest,
  WorkspaceCatalogResourceV1SchemaZ,
  WorkspaceOpenArgumentsSchemaZ,
  WorkspaceOpenMutationRequestSchemaZ,
  WorkspaceOpenMutationResultSchemaZ,
  WorkspacePaneCreateArgumentsSchemaZ,
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  WorkspacePromoteArgumentsSchemaZ,
  WorkspacePromoteMutationRequestSchemaZ,
  WorkspacePromoteMutationResultSchemaZ,
  WorkspacePromotionFailureSchemaZ,
  FleetCatalogResourceV1SchemaZ,
  type WorkspacePromotionFailure,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type DesktopDaemonCapabilitiesResult,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonFetchWorkspaceChangeDiffResult,
  type DesktopDaemonFetchWorkspaceChangesResult,
  type DesktopDaemonFetchWorkspaceFilePreviewResult,
  type DesktopDaemonFetchWorkspaceFilesResult,
  type DesktopDaemonHostState,
  type DesktopDaemonListWorkspacesResult,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
  type WorkspaceOpenMutationRequest,
  type WorkspaceOpenMutationResult,
  type WorkspacePromoteMutationRequest,
  type WorkspacePromoteMutationResult,
  type DesktopDaemonFetchFleetCatalogResult,
  type DesktopDaemonTransportState,
  type AppWindowMutationRequest,
  type AppWindowMutationResult,
  type DaemonChildOutputTail,
  type StartupReadinessLadder,
  WidgetAssetResultSchemaZ,
  type WidgetAssetRequest,
  type WidgetAssetResult,
} from "@tmux-ide/contracts";
import {
  advanceResourceReplica,
  initialResourceReplica,
  type ResourceReplicaState,
} from "@tmux-ide/daemon-client/resource-replica";
import { z } from "zod";

import { DaemonEventSupervisor } from "./daemon-event-supervisor.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
// Promotion is a heavier mutation than open/pane-create: it captures the pane
// inventory TWICE (stamp scan + verification proof) and issues an
// `@tmux_ide_pane_id` set-option per pane plus per-window/session stamps, so a
// large adopted session can outrun the 3s default. A bounded 15s ceiling — used
// for this mutation only — keeps a genuinely stuck request from hanging forever
// while giving a big real fleet room to finish.
const PROMOTE_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * V3 can carry 33 schema-bounded app-window scenes: the current scene plus
 * 32 named layouts, each with 128 windows and a 255-node dock tree. A fixture
 * using every maximum, bounded nanosecond timestamps, and worst-case
 * JSON-escaped text is about 10.2 MiB.
 * Keep a finite power-of-two ceiling with headroom for the rest of the shell
 * projection while leaving catalog, V2, and mutation limits unchanged.
 */
export const APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_TERMINAL_ATTACHMENT_ISSUE_RESPONSE_BYTES = 16 * 1024;
const MAX_PANE_STREAM_ISSUE_RESPONSE_BYTES = 16 * 1024;
/** Local ceiling on a pane-stream delivery ticket; the daemon default is 15s. */
const MAX_PANE_STREAM_ISSUE_DESCRIPTOR_LIFETIME_MS = 60_000;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;
const DEFAULT_EVENT_HANDSHAKE_TIMEOUT_MS = 3_000;
const DEFAULT_EVENT_RECONNECT_INITIAL_DELAY_MS = 250;
const DEFAULT_EVENT_RECONNECT_MAXIMUM_DELAY_MS = 4_000;
const DEFAULT_EVENT_RECONNECT_MAXIMUM_ATTEMPTS = 4;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(
      `daemon resource broker limit must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return candidate;
}

type BrokerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = { readonly data?: unknown };
type SocketListener = (event: SocketEvent) => void;

export interface BrokerEventSocket {
  readonly readyState: number;
  addEventListener(type: SocketEventType, listener: SocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DaemonResourceBrokerDependencies {
  readonly daemon: DesktopDaemonHostState;
  readonly fetch?: BrokerFetch;
  readonly createWebSocket?: (url: string) => BrokerEventSocket;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxEventBytes?: number;
  readonly eventHandshakeTimeoutMs?: number;
  readonly eventReconnectInitialDelayMs?: number;
  readonly eventReconnectMaximumDelayMs?: number;
  readonly eventReconnectMaximumAttempts?: number;
  readonly now?: () => number;
  /** Owner-only canonical capability retained in Electron main. */
  readonly ownerToken?: string | null;
}

export type BrokerSubscriptionResult =
  | { readonly status: "subscribed"; readonly unsubscribe: () => void }
  | { readonly status: "error"; readonly error: DesktopDaemonCapabilityError };

interface WorkspaceCatalogEntry {
  readonly workspaceName: string;
  readonly sessionName: string;
}

interface BrokerSubscription {
  readonly workspaceNames: ReadonlySet<string>;
  readonly listener: (event: DesktopDaemonEvent) => void;
}

class BrokerFailure extends Error {
  constructor(readonly error: DesktopDaemonCapabilityError) {
    super(error.reason);
  }
}

export function daemonCapabilityErrorFromUnknown(error: unknown): DesktopDaemonCapabilityError {
  return error instanceof BrokerFailure ? error.error : daemonCapabilityError("request-failed");
}

/**
 * A typed, deterministic promotion verdict returned by the daemon as an
 * `{ ok: false, error }` envelope. Distinct from a transport `BrokerFailure`:
 * the daemon reached a decision (e.g. session_not_adopted), so the desktop must
 * surface the specific reason rather than the generic request-failed line, and
 * the caller must NOT retry it.
 */
export class BrokerPromotionFailure extends Error {
  constructor(readonly promotion: WorkspacePromotionFailure) {
    super(`promotion ${promotion.code}`);
  }
}

/** The typed promotion verdict carried by an error, or null for a transport failure. */
export function workspacePromotionFailureFromUnknown(
  error: unknown,
): WorkspacePromotionFailure | null {
  return error instanceof BrokerPromotionFailure ? error.promotion : null;
}

/**
 * Parse a daemon `{ ok: false, error: { code, details } }` action envelope into a
 * typed promotion failure, or null when it is not a recognized promotion verdict
 * (an unknown code, a malformed body, or the success envelope). `details.reason`
 * is carried through only when it is a bounded string.
 */
function parsePromotionFailureEnvelope(raw: unknown): WorkspacePromotionFailure | null {
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = raw as { ok?: unknown; error?: unknown };
  if (envelope.ok !== false || typeof envelope.error !== "object" || envelope.error === null) {
    return null;
  }
  const error = envelope.error as { code?: unknown; details?: unknown };
  const details =
    typeof error.details === "object" && error.details !== null
      ? (error.details as { reason?: unknown })
      : undefined;
  const candidate: Record<string, unknown> = { kind: "promotion", code: error.code };
  if (typeof details?.reason === "string") candidate.reason = details.reason;
  const parsed = WorkspacePromotionFailureSchemaZ.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

class BrokerHttpFailure extends BrokerFailure {
  constructor(
    readonly statusCode: number,
    error: DesktopDaemonCapabilityError,
  ) {
    super(error);
  }
}

const ERROR_REASON: Record<DesktopDaemonCapabilityErrorCode, string> = {
  "preview-only": "Live daemon resources are unavailable in browser preview.",
  "daemon-unavailable": "The canonical daemon is unavailable.",
  "daemon-degraded": "The canonical daemon could not be trusted.",
  "invalid-request": "The desktop daemon request was invalid.",
  "workspace-not-found": "The requested workspace is unavailable.",
  "request-timeout": "The daemon resource request timed out.",
  "response-too-large": "The daemon resource response exceeded its size limit.",
  "invalid-response": "The daemon returned an invalid resource response.",
  "daemon-identity-mismatch": "The daemon generation changed during the resource request.",
  "request-failed": "The daemon resource request failed.",
  "resource-changed": "The workspace resource changed before the mutation was applied.",
  "event-unavailable": "The daemon event connection is unavailable.",
  "protocol-error": "The daemon event protocol rejected the subscription.",
  disposed: "The desktop daemon resource broker was disposed.",
};

const TERMINAL_ISSUE_ERROR: Record<
  TerminalAttachmentIssueErrorCode,
  { readonly reason: string; readonly retryable: boolean }
> = {
  "preview-only": {
    reason: "Terminal attachments are unavailable in browser preview.",
    retryable: false,
  },
  "renderer-origin-unavailable": {
    reason: "The current renderer location cannot authorize terminal attachment redemption.",
    retryable: false,
  },
  "daemon-unavailable": { reason: "The canonical daemon is unavailable.", retryable: true },
  "daemon-degraded": {
    reason: "The canonical daemon could not be trusted.",
    retryable: true,
  },
  "invalid-request": { reason: "The terminal attachment request was invalid.", retryable: false },
  "workspace-not-found": {
    reason: "The requested workspace is unavailable.",
    retryable: false,
  },
  "pane-not-found": { reason: "The requested terminal is unavailable.", retryable: false },
  "pane-not-attachable": {
    reason: "The requested pane cannot be attached as a terminal.",
    retryable: false,
  },
  "interactive-viewer-conflict": {
    reason: "The terminal already has an interactive viewer.",
    retryable: true,
  },
  "request-timeout": { reason: "The terminal attachment request timed out.", retryable: true },
  "response-too-large": {
    reason: "The terminal attachment response exceeded its size limit.",
    retryable: false,
  },
  "invalid-response": {
    reason: "The daemon returned an invalid terminal attachment response.",
    retryable: false,
  },
  "daemon-identity-mismatch": {
    reason: "The daemon generation changed during terminal attachment issuance.",
    retryable: true,
  },
  "attachment-unavailable": {
    reason: "The terminal attachment is unavailable.",
    retryable: true,
  },
  "request-failed": { reason: "The terminal attachment request failed.", retryable: true },
  disposed: { reason: "The terminal attachment authority was retired.", retryable: true },
};

export function terminalAttachmentIssueError(
  code: TerminalAttachmentIssueErrorCode,
  retryable = TERMINAL_ISSUE_ERROR[code].retryable,
): TerminalAttachmentIssueError {
  return { code, reason: TERMINAL_ISSUE_ERROR[code].reason, retryable };
}

/**
 * The same vocabulary, worded for the pane-stream product surface. Two tables
 * rather than one because the noun the user reads differs; the KEYS are the one
 * merged enum, so a code can no longer exist on one path and not the other.
 */
const PANE_STREAM_ISSUE_ERROR: Record<
  PaneStreamIssueErrorCode,
  { readonly reason: string; readonly retryable: boolean }
> = {
  "preview-only": {
    reason: "Pane streams are unavailable in browser preview.",
    retryable: false,
  },
  "renderer-origin-unavailable": {
    reason: "The current renderer location cannot authorize pane-stream redemption.",
    retryable: false,
  },
  "daemon-unavailable": { reason: "The canonical daemon is unavailable.", retryable: true },
  "daemon-degraded": { reason: "The canonical daemon could not be trusted.", retryable: true },
  "invalid-request": { reason: "The pane-stream request was invalid.", retryable: false },
  "workspace-not-found": { reason: "The requested workspace is unavailable.", retryable: false },
  "pane-not-found": { reason: "A requested pane is unavailable.", retryable: false },
  "pane-not-attachable": {
    reason: "A requested pane cannot be streamed.",
    retryable: false,
  },
  "interactive-viewer-conflict": {
    reason: "A requested pane already has an interactive viewer.",
    retryable: true,
  },
  "request-timeout": { reason: "The pane-stream request timed out.", retryable: true },
  "response-too-large": {
    reason: "The pane-stream response exceeded its size limit.",
    retryable: false,
  },
  "invalid-response": {
    reason: "The daemon returned an invalid pane-stream response.",
    retryable: false,
  },
  "daemon-identity-mismatch": {
    reason: "The daemon generation changed during pane-stream issuance.",
    retryable: true,
  },
  "attachment-unavailable": { reason: "Pane streaming is unavailable.", retryable: true },
  "request-failed": { reason: "The pane-stream request failed.", retryable: true },
  disposed: { reason: "The pane-stream authority was retired.", retryable: true },
};

/**
 * Broker faults that name themselves honestly in the issue vocabulary and are
 * therefore forwarded rather than flattened. ONE list for both lease families:
 * pane-streams used to forward four of these and collapse the rest, so an
 * identical broker fault reached the user as two different verdicts depending
 * on which pipeline observed it.
 */
const PASS_THROUGH_ISSUE_CODES: ReadonlySet<string> = new Set<TerminalIssueErrorCode>([
  "request-timeout",
  "response-too-large",
  "invalid-response",
  "daemon-identity-mismatch",
  "disposed",
  "daemon-unavailable",
  "daemon-degraded",
  "invalid-request",
]);

function issueCodeForBrokerFailure(error: DesktopDaemonCapabilityError): TerminalIssueErrorCode {
  return PASS_THROUGH_ISSUE_CODES.has(error.code)
    ? (error.code as TerminalIssueErrorCode)
    : "request-failed";
}

export function paneStreamIssueError(
  code: PaneStreamIssueErrorCode,
  retryable = PANE_STREAM_ISSUE_ERROR[code].retryable,
): PaneStreamIssueError {
  return { code, reason: PANE_STREAM_ISSUE_ERROR[code].reason, retryable };
}

export function daemonCapabilityError(
  code: DesktopDaemonCapabilityErrorCode,
): DesktopDaemonCapabilityError {
  return { code, reason: ERROR_REASON[code] };
}

export function rendererDaemonState(
  daemon: DesktopDaemonHostState,
  /**
   * The daemon child's captured last words. Carried on disconnected states so
   * the renderer can show WHY startup is stuck instead of generic copy; ignored
   * on a connected state, where there is nothing to explain.
   */
  childOutput?: DaemonChildOutputTail | null,
  /**
   * The daemon's own readiness ladder, read while this state was composed. A
   * daemon can answer while this desktop cannot use it, and then the ladder is
   * the only thing that knows which rung startup actually stopped at.
   */
  startupReadiness?: StartupReadinessLadder | null,
):
  | { readonly status: "connected"; readonly identity: DaemonInstanceIdentity }
  | {
      readonly status: "unavailable" | "degraded";
      readonly code: Extract<
        DesktopDaemonHostState,
        { status: "unavailable" | "degraded" }
      >["code"];
      readonly reason: string;
      readonly childOutput?: DaemonChildOutputTail;
      readonly startupReadiness?: StartupReadinessLadder;
    } {
  if (daemon.status === "connected") {
    const { protocolVersion, productVersion, instanceId, startedAt, environmentId } =
      daemon.descriptor;
    return {
      status: "connected",
      identity: {
        protocolVersion,
        productVersion,
        instanceId,
        startedAt,
        ...(environmentId !== undefined ? { environmentId } : {}),
      },
    };
  }
  return {
    status: daemon.status,
    code: daemon.code,
    ...(childOutput ? { childOutput } : {}),
    ...(startupReadiness ? { startupReadiness } : {}),
    // Reasons are replaced with fixed copy so probe internals never reach the
    // renderer. The supervisor-halted reason is the one exception: it is
    // composed by the supervisor from typed parts (bounded, no secrets) and
    // the recovery screen must show WHY restarts stopped.
    reason:
      daemon.code === "supervisor-halted"
        ? daemon.reason.slice(0, 240)
        : daemon.status === "degraded"
          ? "Canonical daemon verification is degraded."
          : "The canonical daemon is unavailable.",
  };
}

function daemonIdentity(
  daemon: Extract<DesktopDaemonHostState, { status: "connected" }>,
): DaemonInstanceIdentity {
  const { protocolVersion, productVersion, instanceId, startedAt } = daemon.descriptor;
  return { protocolVersion, productVersion, instanceId, startedAt };
}

function sameIdentity(left: DaemonInstanceIdentity, right: DaemonInstanceIdentity): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.productVersion === right.productVersion &&
    left.instanceId === right.instanceId &&
    left.startedAt === right.startedAt
  );
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultWebSocket(url: string): BrokerEventSocket {
  return new globalThis.WebSocket(url) as unknown as BrokerEventSocket;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    throw new BrokerFailure(daemonCapabilityError("response-too-large"));
  }
  const contentType = response.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new BrokerFailure(daemonCapabilityError("invalid-response"));
  }
  if (!response.body) throw new BrokerFailure(daemonCapabilityError("invalid-response"));

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new BrokerFailure(daemonCapabilityError("response-too-large"));
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new BrokerFailure(daemonCapabilityError("invalid-response"));
  }
}

export class DaemonResourceBroker {
  readonly #daemon: DesktopDaemonHostState;
  readonly #fetch: BrokerFetch;
  readonly #createWebSocket: (url: string) => BrokerEventSocket;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxEventBytes: number;
  readonly #eventHandshakeTimeoutMs: number;
  readonly #eventReconnectInitialDelayMs: number;
  readonly #eventReconnectMaximumDelayMs: number;
  readonly #eventReconnectMaximumAttempts: number;
  readonly #now: () => number;
  readonly #ownerToken: string | null;
  /** Stable for this trusted broker generation; IPC callers normally override per renderer generation. */
  readonly #brokerHostClientId = randomUUID();
  readonly #controllers = new Set<AbortController>();
  readonly #subscriptions = new Map<number, BrokerSubscription>();

  #disposed = false;
  #rendererGeneration = 0;
  #nextSubscription = 0;
  #workspaceCatalog = new Map<string, WorkspaceCatalogEntry>();
  #capabilityCatalog: DesktopDaemonCapabilitiesResult | null = null;
  #socket: BrokerEventSocket | null = null;
  #sentSessions = new Set<string>();
  #socketPeerVerified = false;
  #socketOpened = false;
  #eventCursorSent = false;
  #resourceEventsSupported = false;
  #eventReplica: ResourceReplicaState<null> = initialResourceReplica();
  /** The single owner of event-transport retry, backoff, and the fatal ceiling. */
  readonly #supervisor: DaemonEventSupervisor;

  constructor(dependencies: DaemonResourceBrokerDependencies) {
    this.#daemon = DesktopDaemonHostStateSchemaZ.parse(dependencies.daemon);
    this.#fetch = dependencies.fetch ?? defaultFetch;
    this.#createWebSocket = dependencies.createWebSocket ?? defaultWebSocket;
    this.#requestTimeoutMs = boundedInteger(
      dependencies.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      30_000,
    );
    this.#maxResponseBytes = boundedInteger(
      dependencies.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      8 * 1024 * 1024,
    );
    this.#maxEventBytes = boundedInteger(
      dependencies.maxEventBytes,
      DEFAULT_MAX_EVENT_BYTES,
      1_024,
      4 * 1024 * 1024,
    );
    this.#eventHandshakeTimeoutMs = boundedInteger(
      dependencies.eventHandshakeTimeoutMs,
      DEFAULT_EVENT_HANDSHAKE_TIMEOUT_MS,
      1,
      30_000,
    );
    this.#eventReconnectInitialDelayMs = boundedInteger(
      dependencies.eventReconnectInitialDelayMs,
      DEFAULT_EVENT_RECONNECT_INITIAL_DELAY_MS,
      1,
      60_000,
    );
    this.#eventReconnectMaximumDelayMs = boundedInteger(
      dependencies.eventReconnectMaximumDelayMs,
      Math.max(DEFAULT_EVENT_RECONNECT_MAXIMUM_DELAY_MS, this.#eventReconnectInitialDelayMs),
      this.#eventReconnectInitialDelayMs,
      60_000,
    );
    this.#eventReconnectMaximumAttempts = boundedInteger(
      dependencies.eventReconnectMaximumAttempts,
      DEFAULT_EVENT_RECONNECT_MAXIMUM_ATTEMPTS,
      0,
      10,
    );
    this.#now = dependencies.now ?? Date.now;
    this.#ownerToken = dependencies.ownerToken ?? null;
    this.#supervisor = new DaemonEventSupervisor({
      policy: {
        initialDelayMs: this.#eventReconnectInitialDelayMs,
        maximumDelayMs: this.#eventReconnectMaximumDelayMs,
        maximumAttempts: this.#eventReconnectMaximumAttempts,
        handshakeTimeoutMs: this.#eventHandshakeTimeoutMs,
      },
      hooks: {
        demand: () =>
          !this.#disposed && this.#subscriptions.size > 0 && this.#daemon.status === "connected",
        openSocket: () => this.#openSocket(),
        closeSocket: (code, reason) => this.#closePhysicalSocket(code, reason),
        onStateChanged: (state) => this.#transportStateChanged(state),
      },
      now: this.#now,
    });
  }

  /** Renderer-safe view of the supervisor's derived transport state. */
  transportState(): DesktopDaemonTransportState {
    return this.#supervisor.state();
  }

  /**
   * Explicit wakeup — a user retry or a daemon-record revalidation. Interrupts
   * a scheduled backoff and restarts a transport stopped at the fatal ceiling.
   */
  retryTransport(): void {
    this.#supervisor.retry();
  }

  async openWorkspace(request: WorkspaceOpenMutationRequest): Promise<WorkspaceOpenMutationResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const parsed = WorkspaceOpenMutationRequestSchemaZ.parse(request);
    if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.#mutationJson(
          "/api/v2/action/workspace.open",
          WorkspaceOpenArgumentsSchemaZ.parse(parsed.intent),
          { "X-Tmux-Ide-Operation-Id": parsed.operationId },
        );
        const envelope = z
          .object({ ok: z.literal(true), result: WorkspaceOpenMutationResultSchemaZ })
          .strict()
          .parse(raw);
        if (
          envelope.result.operationId !== parsed.operationId ||
          envelope.result.daemonInstanceId !== this.#daemon.descriptor.instanceId
        ) {
          throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
        }
        return envelope.result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async promoteWorkspace(
    request: WorkspacePromoteMutationRequest,
  ): Promise<WorkspacePromoteMutationResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const parsed = WorkspacePromoteMutationRequestSchemaZ.parse(request);
    if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.#mutationJson(
          "/api/v2/action/workspace.promote",
          WorkspacePromoteArgumentsSchemaZ.parse(parsed.intent),
          { "X-Tmux-Ide-Operation-Id": parsed.operationId },
          this.#maxResponseBytes,
          PROMOTE_REQUEST_TIMEOUT_MS,
        );
        // A typed `{ ok: false }` verdict is a deterministic daemon decision:
        // surface its specific reason to the desktop and never retry it.
        const promotionFailure = parsePromotionFailureEnvelope(raw);
        if (promotionFailure) throw new BrokerPromotionFailure(promotionFailure);
        const envelope = z
          .object({ ok: z.literal(true), result: WorkspacePromoteMutationResultSchemaZ })
          .strict()
          .parse(raw);
        if (
          envelope.result.operationId !== parsed.operationId ||
          envelope.result.daemonInstanceId !== this.#daemon.descriptor.instanceId
        ) {
          throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
        }
        return envelope.result;
      } catch (error) {
        if (error instanceof BrokerPromotionFailure) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  async capabilities(): Promise<DesktopDaemonCapabilitiesResult> {
    if (this.#capabilityCatalog?.status === "ok") return this.#capabilityCatalog;
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      return { status: "error", error: daemonCapabilityError("daemon-unavailable") };
    }
    try {
      const result = DesktopDaemonCapabilitiesResultSchemaZ.parse(
        await this.#mutationJson("/api/v2/capabilities", {}, {}),
      );
      if (result.status === "ok" && !sameIdentity(result.daemon, daemonIdentity(this.#daemon))) {
        return { status: "error", error: daemonCapabilityError("daemon-identity-mismatch") };
      }
      if (result.status === "ok") this.#capabilityCatalog = result;
      return result;
    } catch (error) {
      if (error instanceof BrokerHttpFailure && error.statusCode === 404) {
        const unsupported = {
          status: "ok",
          daemon: daemonIdentity(this.#daemon),
          capabilities: {
            appWindowMutation: {
              available: false,
              reason: "This daemon predates durable AppWindow mutation support.",
            },
          },
        } as const;
        this.#capabilityCatalog = unsupported;
        return unsupported;
      }
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  async createWorkspacePane(
    request: WorkspacePaneCreateMutationRequest,
  ): Promise<WorkspacePaneCreateMutationResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const parsed = WorkspacePaneCreateMutationRequestSchemaZ.parse(request);
    if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.#mutationJson(
          "/api/v2/action/workspace.pane.create",
          WorkspacePaneCreateArgumentsSchemaZ.parse(parsed.intent),
          { "X-Tmux-Ide-Operation-Id": parsed.operationId },
        );
        const envelope = z
          .object({ ok: z.literal(true), result: WorkspacePaneCreateMutationResultSchemaZ })
          .strict()
          .parse(raw);
        if (
          envelope.result.operationId !== parsed.operationId ||
          envelope.result.daemonInstanceId !== this.#daemon.descriptor.instanceId
        ) {
          throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
        }
        return envelope.result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async mutateAppWindow(request: AppWindowMutationRequest): Promise<AppWindowMutationResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const parsed = AppWindowMutationRequestSchemaZ.parse(request);
    if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    await this.#loadWorkspaceCatalog();
    if (!this.#workspaceCatalog.has(parsed.intent.workspaceName)) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await this.#mutationJson(
          "/api/v2/action/workspace.app-window.mutate",
          AppWindowMutationArgumentsSchemaZ.parse(parsed.intent),
          { "X-Tmux-Ide-Operation-Id": parsed.operationId },
        );
        const envelope = z
          .discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), result: AppWindowMutationResultSchemaZ }).strict(),
            z
              .object({
                ok: z.literal(false),
                error: z
                  .object({
                    code: z.string(),
                    message: z.string(),
                    details: z.unknown().optional(),
                  })
                  .strict(),
              })
              .strict(),
          ])
          .parse(raw);
        if (!envelope.ok) {
          throw new BrokerFailure(
            envelope.error.code === "workspace_resource_changed"
              ? daemonCapabilityError("resource-changed")
              : daemonCapabilityError("request-failed"),
          );
        }
        if (
          envelope.result.operationId !== parsed.operationId ||
          envelope.result.daemonInstanceId !== this.#daemon.descriptor.instanceId ||
          envelope.result.workspaceName !== parsed.intent.workspaceName
        ) {
          throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
        }
        return envelope.result;
      } catch (error) {
        lastError = error;
        if (
          error instanceof BrokerFailure &&
          error.error.code !== "request-failed" &&
          error.error.code !== "request-timeout"
        ) {
          break;
        }
      }
    }
    throw lastError;
  }

  /**
   * Run one multiplexer verb.
   *
   * The intent's own `verb` field names the route, so this method does not
   * switch on anything: seven tmux verbs share one path, and an eighth needs no
   * change here. Unlike the AppWindow mutation there is no retry loop — every
   * verb here changes tmux, and while the daemon's operation-id idempotency
   * makes a repeat safe, a silent second attempt would report a failure the
   * user can act on as a success they cannot see.
   */
  async invokeVerb(
    request: WorkspaceMultiplexerMutationRequest,
    hostClientId = this.#brokerHostClientId,
  ): Promise<WorkspaceMultiplexerMutationResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const parsed = WorkspaceMultiplexerMutationRequestSchemaZ.parse(request);
    if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    await this.#loadWorkspaceCatalog();
    if (!this.#workspaceCatalog.has(parsed.intent.workspaceName)) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    const { verb, ...args } = parsed.intent;
    const raw = await this.#mutationJson(`/api/v2/action/${verb}`, args, {
      "X-Tmux-Ide-Operation-Id": parsed.operationId,
      "X-Tmux-Ide-Host-Client-Id": hostClientId,
    });
    const envelope = z
      .discriminatedUnion("ok", [
        z
          .object({ ok: z.literal(true), result: WorkspaceMultiplexerMutationResultSchemaZ })
          .strict(),
        z
          .object({
            ok: z.literal(false),
            error: z
              .object({
                code: z.string(),
                message: z.string(),
                details: z.unknown().optional(),
              })
              .strict(),
          })
          .strict(),
      ])
      .parse(raw);
    if (!envelope.ok) {
      // The two refusals are the daemon declining on purpose. Collapsing them
      // into "request-failed" would tell the user their click broke rather
      // than that the rule they hit exists.
      throw new BrokerFailure(
        envelope.error.code === "last_window_refused" || envelope.error.code === "last_pane_refused"
          ? daemonCapabilityError("invalid-request")
          : daemonCapabilityError("request-failed"),
      );
    }
    if (
      envelope.result.operationId !== parsed.operationId ||
      envelope.result.daemonInstanceId !== this.#daemon.descriptor.instanceId ||
      envelope.result.workspaceName !== parsed.intent.workspaceName ||
      envelope.result.verb !== verb
    ) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    return envelope.result;
  }

  async issueTerminalAttachment(
    request: TerminalAttachmentIssueMutationRequest,
    rendererOrigin: string,
    hostClientId = this.#brokerHostClientId,
  ): Promise<TerminalAttachmentIssueResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      return {
        status: "error",
        error: terminalAttachmentIssueError("daemon-unavailable"),
      };
    }
    try {
      const parsed = TerminalAttachmentIssueMutationRequestSchemaZ.parse(request);
      if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      const origin = this.#canonicalRendererOrigin(rendererOrigin);
      const raw = await this.#mutationJson(
        TERMINAL_ATTACHMENT_ISSUE_PATH,
        parsed,
        {
          Origin: origin,
          "X-Tmux-Ide-Request-Id": parsed.requestId,
          "X-Tmux-Ide-Expected-Daemon-Instance-Id": parsed.expectedDaemonInstanceId,
          "X-Tmux-Ide-Host-Client-Id": hostClientId,
        },
        Math.min(this.#maxResponseBytes, MAX_TERMINAL_ATTACHMENT_ISSUE_RESPONSE_BYTES),
      );
      const parsedResult = TerminalAttachmentIssueResultSchemaZ.safeParse(raw);
      if (!parsedResult.success) {
        throw new BrokerFailure(daemonCapabilityError("invalid-response"));
      }
      const result = parsedResult.data;
      if (result.status === "error") {
        return {
          status: "error",
          error: terminalAttachmentIssueError(result.error.code, result.error.retryable),
        };
      }
      const descriptor = TerminalAttachmentIssueDescriptorSchemaZ.parse(result.descriptor);
      const remainingLifetime = descriptor.expiresAt - this.#now();
      if (
        descriptor.daemonInstanceId !== this.#daemon.descriptor.instanceId ||
        descriptor.requestId !== parsed.requestId ||
        descriptor.effectiveViewerMode !== parsed.attachment.viewerMode ||
        descriptor.effectiveGeometryOwnership !== parsed.attachment.geometryOwnership ||
        remainingLifetime <= 0 ||
        remainingLifetime > TERMINAL_ATTACHMENT_MAX_ISSUE_DESCRIPTOR_LIFETIME_MS
      ) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      return { status: "issued", descriptor };
    } catch (error) {
      const code = issueCodeForBrokerFailure(this.#boundedError(error));
      return { status: "error", error: terminalAttachmentIssueError(code) };
    }
  }

  /**
   * Owner-gated pane-stream lease issuance (m43 card 3). The
   * terminal-attachment issue discipline verbatim: exact daemon-identity and
   * correlation headers, trusted-Origin authorship in main, bounded response,
   * and a descriptor accepted only when it echoes the request exactly.
   */
  async issuePaneStream(
    request: PaneStreamIssueMutationRequest,
    rendererOrigin: string,
    hostClientId = this.#brokerHostClientId,
  ): Promise<PaneStreamIssueResult> {
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      return { status: "error", error: paneStreamIssueError("daemon-unavailable") };
    }
    try {
      const parsed = PaneStreamIssueMutationRequestSchemaZ.parse(request);
      if (parsed.expectedDaemonInstanceId !== this.#daemon.descriptor.instanceId) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      const origin = this.#canonicalRendererOrigin(rendererOrigin);
      const raw = await this.#mutationJson(
        PANE_STREAM_ISSUE_PATH,
        parsed,
        {
          Origin: origin,
          "X-Tmux-Ide-Request-Id": parsed.requestId,
          "X-Tmux-Ide-Expected-Daemon-Instance-Id": parsed.expectedDaemonInstanceId,
          "X-Tmux-Ide-Host-Client-Id": hostClientId,
        },
        Math.min(this.#maxResponseBytes, MAX_PANE_STREAM_ISSUE_RESPONSE_BYTES),
      );
      const parsedResult = PaneStreamIssueResultSchemaZ.safeParse(raw);
      if (!parsedResult.success) {
        throw new BrokerFailure(daemonCapabilityError("invalid-response"));
      }
      const result = parsedResult.data;
      if (result.status === "error") {
        return {
          status: "error",
          error: paneStreamIssueError(result.error.code, result.error.retryable),
        };
      }
      const descriptor = PaneStreamIssueDescriptorSchemaZ.parse(result.descriptor);
      const remainingLifetime = descriptor.expiresAt - this.#now();
      if (
        descriptor.daemonInstanceId !== this.#daemon.descriptor.instanceId ||
        descriptor.requestId !== parsed.requestId ||
        descriptor.effectiveViewerMode !== parsed.stream.viewerMode ||
        descriptor.panes.length !== parsed.stream.panes.length ||
        descriptor.panes.some((pane, index) => pane !== parsed.stream.panes[index]) ||
        remainingLifetime <= 0 ||
        remainingLifetime > MAX_PANE_STREAM_ISSUE_DESCRIPTOR_LIFETIME_MS
      ) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      return { status: "issued", descriptor };
    } catch (error) {
      const code = issueCodeForBrokerFailure(this.#boundedError(error));
      return { status: "error", error: paneStreamIssueError(code) };
    }
  }

  async listWorkspaces(): Promise<DesktopDaemonListWorkspacesResult> {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    try {
      const workspaces = await this.#loadWorkspaceCatalog();
      const result: DesktopDaemonListWorkspacesResult = {
        status: "ok",
        daemon: daemonIdentity(this.#daemon),
        workspaces: workspaces.map(({ workspaceName }) => ({ workspaceName })),
      };
      return DesktopDaemonListWorkspacesResultSchemaZ.parse(result);
    } catch (error) {
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  async fetchApplicationShell(
    workspaceName: string,
    resourceVersion: DesktopDaemonFetchApplicationShellRequest["resourceVersion"] = APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ): Promise<DesktopDaemonFetchApplicationShellResult> {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    try {
      const request = DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse({
        workspaceName,
        resourceVersion,
      });
      if (!request.success) throw new BrokerFailure(daemonCapabilityError("invalid-request"));
      const workspaces = await this.#loadWorkspaceCatalog();
      const workspace = workspaces.find(
        (candidate) => candidate.workspaceName === request.data.workspaceName,
      );
      if (!workspace) throw new BrokerFailure(daemonCapabilityError("workspace-not-found"));
      let negotiatedVersion = request.data.resourceVersion ?? APPLICATION_SHELL_RESOURCE_V3_VERSION;
      let raw: unknown;
      try {
        raw = await this.#requestJson(
          `/api/project/${encodeURIComponent(daemonWorkspaceRouteName("fetchApplicationShell", workspace))}/application-shell?version=${negotiatedVersion}`,
          negotiatedVersion === APPLICATION_SHELL_RESOURCE_V3_VERSION
            ? APPLICATION_SHELL_V3_MAX_RESPONSE_BYTES
            : this.#maxResponseBytes,
        );
      } catch (error) {
        if (
          negotiatedVersion !== APPLICATION_SHELL_RESOURCE_V3_VERSION ||
          !(error instanceof BrokerHttpFailure) ||
          error.statusCode !== 400
        ) {
          throw error;
        }
        negotiatedVersion = APPLICATION_SHELL_RESOURCE_V2_VERSION;
        raw = await this.#requestJson(
          `/api/project/${encodeURIComponent(daemonWorkspaceRouteName("fetchApplicationShell", workspace))}/application-shell?version=${negotiatedVersion}`,
          this.#maxResponseBytes,
        );
      }
      const parsed =
        negotiatedVersion === APPLICATION_SHELL_RESOURCE_V3_VERSION
          ? ApplicationShellResourceV3SchemaZ.safeParse(raw)
          : ApplicationShellResourceV2SchemaZ.safeParse(raw);
      if (!parsed.success) throw new BrokerFailure(daemonCapabilityError("invalid-response"));
      const envelope = parsed.data;
      if (!sameIdentity(envelope.daemon, daemonIdentity(this.#daemon))) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      return DesktopDaemonFetchApplicationShellResultSchemaZ.parse({
        status: "ok",
        envelope,
      });
    } catch (error) {
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  async fetchWorkspaceFiles(request: unknown): Promise<DesktopDaemonFetchWorkspaceFilesResult> {
    const parsed = DesktopDaemonFetchWorkspaceFilesRequestSchemaZ.safeParse(request);
    if (!parsed.success) {
      return { status: "error", error: daemonCapabilityError("invalid-request") };
    }
    const query = parsed.data.directoryId
      ? `?directoryId=${encodeURIComponent(parsed.data.directoryId)}`
      : "";
    return this.#fetchWorkspaceResource(
      "fetchWorkspaceFiles",
      parsed.data.workspaceName,
      (name) => `/api/project/${name}/files${query}`,
      WorkspaceFilesCatalogEnvelopeV1SchemaZ,
    );
  }

  async fetchWorkspaceFilePreview(
    request: unknown,
  ): Promise<DesktopDaemonFetchWorkspaceFilePreviewResult> {
    const parsed = DesktopDaemonFetchWorkspaceFilePreviewRequestSchemaZ.safeParse(request);
    if (!parsed.success) {
      return { status: "error", error: daemonCapabilityError("invalid-request") };
    }
    const fileId = encodeURIComponent(parsed.data.fileId);
    return this.#fetchWorkspaceResource(
      "fetchWorkspaceFilePreview",
      parsed.data.workspaceName,
      (name) => `/api/project/${name}/file-preview?fileId=${fileId}`,
      WorkspaceFilePreviewEnvelopeV1SchemaZ,
    );
  }

  async fetchWorkspaceChanges(request: unknown): Promise<DesktopDaemonFetchWorkspaceChangesResult> {
    const parsed = DesktopDaemonFetchWorkspaceChangesRequestSchemaZ.safeParse(request);
    if (!parsed.success) {
      return { status: "error", error: daemonCapabilityError("invalid-request") };
    }
    return this.#fetchWorkspaceResource(
      "fetchWorkspaceChanges",
      parsed.data.workspaceName,
      (name) => `/api/project/${name}/changes`,
      WorkspaceChangesCatalogEnvelopeV1SchemaZ,
    );
  }

  async fetchWorkspaceChangeDiff(
    request: unknown,
  ): Promise<DesktopDaemonFetchWorkspaceChangeDiffResult> {
    const parsed = DesktopDaemonFetchWorkspaceChangeDiffRequestSchemaZ.safeParse(request);
    if (!parsed.success) {
      return { status: "error", error: daemonCapabilityError("invalid-request") };
    }
    const changeId = encodeURIComponent(parsed.data.changeId);
    return this.#fetchWorkspaceResource(
      "fetchWorkspaceChangeDiff",
      parsed.data.workspaceName,
      (name) => `/api/project/${name}/change-diff?changeId=${changeId}`,
      WorkspaceChangeDiffEnvelopeV1SchemaZ,
    );
  }

  /**
   * Owner-authenticated read of the workspace-free fleet catalog. Unlike the
   * per-workspace resources this needs no catalog resolution — the endpoint is a
   * single generation-stamped resource — but the same owner authorization,
   * bounded read, and daemon-generation check apply.
   */
  async fetchFleetCatalog(): Promise<DesktopDaemonFetchFleetCatalogResult> {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    if (!this.#ownerToken) {
      return { status: "error", error: daemonCapabilityError("daemon-unavailable") };
    }
    try {
      const raw = await this.#requestJson(
        "/api/resources/fleet-catalog",
        this.#maxResponseBytes,
        true,
      );
      const parsed = FleetCatalogResourceV1SchemaZ.safeParse(raw);
      if (!parsed.success) throw new BrokerFailure(daemonCapabilityError("invalid-response"));
      if (!sameIdentity(parsed.data.daemon, daemonIdentity(this.#daemon))) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      return { status: "ok", envelope: parsed.data };
    } catch (error) {
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  async fetchWidgetAsset(request: WidgetAssetRequest): Promise<WidgetAssetResult> {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    if (!this.#ownerToken) {
      return { status: "error", error: daemonCapabilityError("daemon-unavailable") };
    }
    try {
      const raw = await this.#requestJson(
        `/api/widget-assets/${encodeURIComponent(request.assetId)}`,
        24 * 1024 * 1024,
        true,
      );
      const parsed = WidgetAssetResultSchemaZ.safeParse({ status: "ok", asset: raw });
      if (!parsed.success) throw new BrokerFailure(daemonCapabilityError("invalid-response"));
      return parsed.data;
    } catch (error) {
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  /**
   * Owner-authenticated read of a generation-stamped workspace resource.
   *
   * The route parameter is resolved through the private catalog, and WHICH of
   * the entry's two names it is comes from the contracts route-key table rather
   * than from this method or its callers. That fork used to be implicit here —
   * this helper always interpolated the workspace name, while
   * `fetchApplicationShell` separately interpolated the session name — and a
   * wrong choice is a silent 404 rather than a typed refusal.
   */
  async #fetchWorkspaceResource<TEnvelope extends { daemon: DaemonInstanceIdentity }>(
    resource: DaemonWorkspaceResourceKind,
    workspaceName: string,
    buildPath: (encodedRouteName: string) => string,
    envelopeSchema: z.ZodType<TEnvelope>,
  ): Promise<
    { status: "ok"; envelope: TEnvelope } | { status: "error"; error: DesktopDaemonCapabilityError }
  > {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    if (!this.#ownerToken) {
      return { status: "error", error: daemonCapabilityError("daemon-unavailable") };
    }
    try {
      const workspaces = await this.#loadWorkspaceCatalog();
      const workspace = workspaces.find((candidate) => candidate.workspaceName === workspaceName);
      if (!workspace) throw new BrokerFailure(daemonCapabilityError("workspace-not-found"));
      const raw = await this.#requestJson(
        buildPath(encodeURIComponent(daemonWorkspaceRouteName(resource, workspace))),
        this.#maxResponseBytes,
        true,
      );
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) throw new BrokerFailure(daemonCapabilityError("invalid-response"));
      if (!sameIdentity(parsed.data.daemon, daemonIdentity(this.#daemon))) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      return { status: "ok", envelope: parsed.data };
    } catch (error) {
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  async subscribe(
    workspaceNames: readonly string[],
    listener: (event: DesktopDaemonEvent) => void,
  ): Promise<BrokerSubscriptionResult> {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    if (this.#disposed) return { status: "error", error: daemonCapabilityError("disposed") };
    const parsed = DesktopDaemonEventSubscriptionRequestSchemaZ.safeParse({ workspaceNames });
    if (!parsed.success) {
      return { status: "error", error: daemonCapabilityError("invalid-request") };
    }
    try {
      const catalog = await this.#loadWorkspaceCatalog();
      const known = new Set(catalog.map(({ workspaceName }) => workspaceName));
      if (parsed.data.workspaceNames.some((name) => !known.has(name))) {
        return { status: "error", error: daemonCapabilityError("workspace-not-found") };
      }
      const id = ++this.#nextSubscription;
      this.#subscriptions.set(id, {
        workspaceNames: new Set(parsed.data.workspaceNames),
        listener,
      });
      const transportBefore = this.#supervisor.state();
      this.#synchronizeSocket();
      // A late joiner immediately learns the derived transport state instead
      // of inferring health from whether events happen to arrive. When the
      // subscription itself woke the supervisor, the broadcast transition
      // already reached it, so only an unchanged state is snapshotted.
      if (this.#supervisor.state() === transportBefore) {
        this.#deliver(this.#subscriptions.get(id), {
          type: "transport.changed",
          transport: transportBefore,
        });
      }
      if (this.#socket?.readyState === WS_OPEN && this.#socketPeerVerified) {
        this.#deliver(this.#subscriptions.get(id), {
          type: "connection.changed",
          state: "live",
          error: null,
        });
      }
      let active = true;
      return {
        status: "subscribed",
        unsubscribe: () => {
          if (!active) return;
          active = false;
          this.#subscriptions.delete(id);
          this.#synchronizeSocket();
        },
      };
    } catch (error) {
      return { status: "error", error: this.#boundedError(error) };
    }
  }

  /** Releases one renderer generation while keeping the app-level broker reusable. */
  releaseRenderer(): void {
    this.#rendererGeneration += 1;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
    this.#subscriptions.clear();
    this.#closePhysicalSocket(1000, "renderer released");
    this.#supervisor.release();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releaseRenderer();
    this.#supervisor.dispose();
  }

  #disconnectedResult(): { status: "error"; error: DesktopDaemonCapabilityError } {
    return {
      status: "error",
      error: daemonCapabilityError(
        this.#daemon.status === "degraded" ? "daemon-degraded" : "daemon-unavailable",
      ),
    };
  }

  #boundedError(error: unknown): DesktopDaemonCapabilityError {
    if (error instanceof BrokerFailure) return error.error;
    return daemonCapabilityError(this.#disposed ? "disposed" : "request-failed");
  }

  async #loadWorkspaceCatalog(): Promise<WorkspaceCatalogEntry[]> {
    if (this.#daemon.status !== "connected") {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const expectedDaemon = daemonIdentity(this.#daemon);
    const raw = await this.#requestJson("/api/resources/workspace-catalog");
    const parsed = WorkspaceCatalogResourceV1SchemaZ.safeParse(raw);
    if (!parsed.success) throw new BrokerFailure(daemonCapabilityError("invalid-response"));
    if (!sameIdentity(parsed.data.daemon, expectedDaemon)) {
      throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
    }
    const catalog = parsed.data.workspaces.map((entry) => this.#normalizeCatalogEntry(entry));
    const canonicalNames = catalog.map(({ workspaceName }) => workspaceName);
    if (new Set(canonicalNames).size !== canonicalNames.length) {
      throw new BrokerFailure(daemonCapabilityError("invalid-response"));
    }
    this.#workspaceCatalog = new Map(catalog.map((entry) => [entry.workspaceName, entry]));
    return catalog;
  }

  #normalizeCatalogEntry(entry: {
    readonly workspaceName: string;
    readonly sessionName: string;
  }): WorkspaceCatalogEntry {
    const workspaceName = DesktopWorkspaceNameSchemaZ.safeParse(entry.workspaceName);
    const validSessionName =
      entry.sessionName.length <= 160 &&
      [...entry.sessionName].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      });
    if (!workspaceName.success || workspaceName.data !== entry.workspaceName || !validSessionName) {
      throw new BrokerFailure(daemonCapabilityError("invalid-response"));
    }
    return { workspaceName: workspaceName.data, sessionName: entry.sessionName };
  }

  async #requestJson(
    pathname: string,
    maximumResponseBytes = this.#maxResponseBytes,
    authorize = false,
  ): Promise<unknown> {
    if (this.#disposed) throw new BrokerFailure(daemonCapabilityError("disposed"));
    if (this.#daemon.status !== "connected") {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    if (authorize && !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const requestGeneration = this.#rendererGeneration;
    const base = new URL(this.#daemon.descriptor.apiBaseUrl);
    const url = new URL(pathname, base);
    if (url.origin !== base.origin || url.username || url.password) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (authorize && this.#ownerToken) headers.Authorization = `Bearer ${this.#ownerToken}`;
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new BrokerFailure(daemonCapabilityError("request-timeout")));
      }, this.#requestTimeoutMs);
      timeout.unref?.();
    });
    const operation = (async (): Promise<unknown> => {
      const response = await this.#fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected) throw new BrokerFailure(daemonCapabilityError("request-failed"));
      if (!response.ok) {
        throw new BrokerHttpFailure(
          response.status,
          daemonCapabilityError(response.status === 404 ? "workspace-not-found" : "request-failed"),
        );
      }
      return readBoundedJson(response, maximumResponseBytes);
    })();
    try {
      const result = await Promise.race([operation, deadline]);
      if (requestGeneration !== this.#rendererGeneration) {
        throw new BrokerFailure(daemonCapabilityError("disposed"));
      }
      return result;
    } catch (error) {
      if (error instanceof BrokerFailure) throw error;
      if (requestGeneration !== this.#rendererGeneration || this.#disposed) {
        throw new BrokerFailure(daemonCapabilityError("disposed"));
      }
      throw new BrokerFailure(daemonCapabilityError("request-failed"));
    } finally {
      controller.abort();
      this.#controllers.delete(controller);
      if (timeout) clearTimeout(timeout);
    }
  }

  #canonicalRendererOrigin(value: string): string {
    if (
      typeof value !== "string" ||
      value.length < 4 ||
      value.length > 2_048 ||
      value === "null" ||
      value === "*" ||
      /[\0\r\n\t ]/u.test(value)
    ) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    let origin: URL;
    try {
      origin = new URL(value);
    } catch {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    if (
      !/^[a-z][a-z0-9+.-]*:$/u.test(origin.protocol) ||
      origin.protocol === "file:" ||
      origin.username.length > 0 ||
      origin.password.length > 0 ||
      (origin.pathname !== "" && origin.pathname !== "/") ||
      origin.search.length > 0 ||
      origin.hash.length > 0 ||
      !origin.hostname
    ) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    const canonical = `${origin.protocol}//${origin.host}`;
    if (canonical !== value) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    return canonical;
  }

  async #mutationJson(
    pathname: string,
    body: unknown,
    correlationHeaders: Readonly<Record<string, string>>,
    maximumResponseBytes = this.#maxResponseBytes,
    timeoutMs = this.#requestTimeoutMs,
  ): Promise<unknown> {
    if (this.#disposed) throw new BrokerFailure(daemonCapabilityError("disposed"));
    if (this.#daemon.status !== "connected" || !this.#ownerToken) {
      throw new BrokerFailure(daemonCapabilityError("daemon-unavailable"));
    }
    const requestGeneration = this.#rendererGeneration;
    const base = new URL(this.#daemon.descriptor.apiBaseUrl);
    const url = new URL(pathname, base);
    if (url.origin !== base.origin || url.username || url.password) {
      throw new BrokerFailure(daemonCapabilityError("invalid-request"));
    }
    const controller = new AbortController();
    this.#controllers.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new BrokerFailure(daemonCapabilityError("request-timeout")));
      }, timeoutMs);
      timeout.unref?.();
    });
    const operation = (async (): Promise<unknown> => {
      const response = await this.#fetch(url, {
        method: "POST",
        headers: {
          ...correlationHeaders,
          accept: "application/json",
          Authorization: `Bearer ${this.#ownerToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected || !response.ok) {
        throw new BrokerHttpFailure(response.status, daemonCapabilityError("request-failed"));
      }
      return readBoundedJson(response, maximumResponseBytes);
    })();
    try {
      const result = await Promise.race([operation, deadline]);
      if (requestGeneration !== this.#rendererGeneration) {
        throw new BrokerFailure(daemonCapabilityError("disposed"));
      }
      return result;
    } catch (error) {
      if (error instanceof BrokerFailure) throw error;
      if (requestGeneration !== this.#rendererGeneration || this.#disposed) {
        throw new BrokerFailure(daemonCapabilityError("disposed"));
      }
      throw new BrokerFailure(daemonCapabilityError("request-failed"));
    } finally {
      controller.abort();
      this.#controllers.delete(controller);
      if (timeout) clearTimeout(timeout);
    }
  }

  #requiredSessions(): Set<string> {
    const required = new Set<string>();
    for (const subscription of this.#subscriptions.values()) {
      for (const name of subscription.workspaceNames) {
        const sessionName = this.#workspaceCatalog.get(name)?.sessionName;
        if (sessionName) required.add(sessionName);
      }
    }
    return required;
  }

  #synchronizeSocket(): void {
    if (this.#subscriptions.size === 0) {
      this.#closePhysicalSocket(1000, "renderer released");
      this.#supervisor.release();
      return;
    }
    if (!this.#socket) {
      // The supervisor is the ONLY caller allowed to open a socket; demand
      // merely wakes an idle machine, never bypasses backoff or the fatal stop.
      this.#supervisor.ensure();
      return;
    }
    if (this.#socket.readyState === WS_OPEN && this.#socketPeerVerified) {
      this.#sendSubscriptionDelta(this.#requiredSessions());
    }
  }

  /** Supervisor hook: create the physical socket for one connection attempt. */
  #openSocket(): void {
    if (this.#daemon.status !== "connected") {
      throw new Error("the daemon is not connected");
    }
    const url = new URL("/ws/events", this.#daemon.descriptor.apiBaseUrl);
    url.protocol = "ws:";
    const socket = this.#createWebSocket(url.toString());
    this.#socket = socket;
    this.#socketPeerVerified = false;
    this.#socketOpened = false;
    this.#eventCursorSent = false;
    this.#sentSessions.clear();
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#socketOpened = true;
      // The first frame must authenticate the non-secret daemon generation.
    });
    socket.addEventListener("message", (event) => this.#receiveSocketEvent(socket, event.data));
    socket.addEventListener("close", () => this.#socketClosed(socket));
    socket.addEventListener("error", () => this.#socketErrored(socket));
  }

  #transportStateChanged(state: DesktopDaemonTransportState): void {
    this.#emit({ type: "transport.changed", transport: state });
    if (state.phase === "connected") {
      this.#emit({ type: "connection.changed", state: "live", error: null });
    } else if (state.phase === "degraded") {
      this.#emit({ type: "connection.changed", state: "degraded", error: state.error });
    }
  }

  #receiveSocketEvent(socket: BrokerEventSocket, data: unknown): void {
    if (this.#socket !== socket) return;
    if (!this.#socketOpened) {
      this.#failSocket(daemonCapabilityError("invalid-response"), 1002, "event frame before open");
      return;
    }
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).byteLength > this.#maxEventBytes
    ) {
      this.#failSocket(daemonCapabilityError("invalid-response"), 1009, "invalid event frame");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.#failSocket(daemonCapabilityError("invalid-response"), 1002, "invalid event frame");
      return;
    }
    const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
    if (!parsed.success) {
      this.#failSocket(daemonCapabilityError("invalid-response"), 1002, "invalid event frame");
      return;
    }
    if (!this.#socketPeerVerified) {
      if (
        parsed.data.type !== "hello" ||
        this.#daemon.status !== "connected" ||
        !sameIdentity(parsed.data.daemon, daemonIdentity(this.#daemon))
      ) {
        this.#failSocket(
          daemonCapabilityError("daemon-identity-mismatch"),
          1008,
          "daemon generation mismatch",
        );
        return;
      }
      this.#socketPeerVerified = true;
      this.#resourceEventsSupported = parsed.data.eventSequence !== undefined;
      const resumeSequence =
        this.#eventReplica.daemonInstanceId === parsed.data.daemon.instanceId
          ? (this.#eventReplica.sequence ?? 0)
          : 0;
      this.#establishEventCursor(parsed.data.daemon.instanceId, resumeSequence);
      this.#sendSubscriptionDelta(this.#requiredSessions());
      this.#supervisor.verified();
      return;
    }
    if (parsed.data.type === "hello") {
      this.#failSocket(daemonCapabilityError("invalid-response"), 1002, "duplicate hello frame");
      return;
    }
    this.#projectServerFrame(parsed.data);
  }

  #projectServerFrame(frame: DaemonEventServerFrame): void {
    if (this.#daemon.status !== "connected") return;
    if (frame.type === "snapshot-required") {
      const instanceId = this.#daemon.descriptor.instanceId;
      this.#eventReplica = advanceResourceReplica(this.#eventReplica, {
        type: "gap",
        daemonInstanceId: instanceId,
        sequence: frame.currentSequence,
      }).state;
      this.#invalidateEveryResource();
      this.#establishEventCursor(instanceId, frame.currentSequence);
      return;
    }
    if (frame.type === "resource.changed") {
      const instanceId = this.#daemon.descriptor.instanceId;
      const previousSequence = this.#eventReplica.sequence;
      const transition = advanceResourceReplica(this.#eventReplica, {
        type: "changed",
        daemonInstanceId: instanceId,
        sequence: frame.sequence,
        revision: frame.sequence,
        ...(frame.causeOperationId ? { causeOperationId: frame.causeOperationId } : {}),
      });
      this.#eventReplica = transition.state;
      if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
        this.#invalidateEveryResource();
        this.#establishEventCursor(instanceId, frame.sequence);
        return;
      }
      if (frame.sequence <= (previousSequence ?? -1)) return;
      if (frame.resource === "application-shell") {
        if (frame.workspaceName === null) {
          for (const workspace of this.#workspaceCatalog.values()) {
            this.#emit({
              type: "application-shell.changed",
              workspaceName: workspace.workspaceName,
              daemonInstanceId: instanceId,
              sequence: frame.sequence,
              revision: frame.revision,
              causeOperationId: frame.causeOperationId,
            });
          }
        } else if (this.#workspaceCatalog.has(frame.workspaceName)) {
          this.#emit({
            type: "application-shell.changed",
            workspaceName: frame.workspaceName,
            daemonInstanceId: instanceId,
            sequence: frame.sequence,
            revision: frame.revision,
            causeOperationId: frame.causeOperationId,
          });
        }
      } else if (frame.resource === "fleet-catalog") {
        this.#emit({ type: "fleet.changed" });
      } else {
        this.#emit({ type: "workspaces.changed" });
      }
      return;
    }
    if (frame.type === "interaction.receipt") {
      const instanceId = this.#daemon.descriptor.instanceId;
      const transition = advanceResourceReplica(this.#eventReplica, {
        type: "observed",
        daemonInstanceId: instanceId,
        sequence: frame.sequence,
      });
      this.#eventReplica = transition.state;
      if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
        this.#invalidateEveryResource();
        this.#establishEventCursor(instanceId, frame.sequence);
        return;
      }
      if (this.#workspaceCatalog.has(frame.workspaceName)) this.#emit(frame);
      return;
    }
    switch (frame.type) {
      case "snapshot":
      case "config.changed":
      case "terminals.changed":
        this.#emitForSession(frame.sessionName);
        return;
      case "agent-status.changed":
        // Session-scoped ground-truth status: refresh the open workspace's shell
        // (if that session is one) AND invalidate the whole fleet catalog, whose
        // opaque session ids the broker cannot map to a raw tmux session name.
        this.#emitForSession(frame.sessionName);
        this.#emit({ type: "fleet.changed" });
        return;
      case "fleet.changed":
        this.#emit({ type: "fleet.changed" });
        return;
      case "workspace.added":
        try {
          const entry = this.#normalizeCatalogEntry({
            workspaceName: frame.workspace.name,
            sessionName: frame.workspace.sessionName,
          });
          if (this.#workspaceCatalog.has(entry.workspaceName)) {
            this.#rejectWorkspaceUpdate("workspace identity collision");
            return;
          }
          this.#workspaceCatalog.set(entry.workspaceName, entry);
        } catch {
          this.#rejectWorkspaceUpdate("invalid workspace update");
          return;
        }
        this.#emit({ type: "workspaces.changed" });
        this.#synchronizeSocket();
        return;
      case "workspace.removed":
        {
          const name = DesktopWorkspaceNameSchemaZ.safeParse(frame.name);
          if (
            !name.success ||
            name.data !== frame.name ||
            !this.#workspaceCatalog.has(frame.name)
          ) {
            this.#rejectWorkspaceUpdate("invalid workspace update");
            return;
          }
          this.#workspaceCatalog.delete(frame.name);
        }
        this.#emit({ type: "workspaces.changed" });
        this.#synchronizeSocket();
        return;
      case "sessions.changed":
      case "projects.changed":
        this.#emit({ type: "workspaces.changed" });
        for (const workspace of this.#workspaceCatalog.values()) {
          this.#emit({
            type: "application-shell.changed",
            workspaceName: workspace.workspaceName,
          });
        }
        return;
      case "action.complete":
        if (this.#resourceEventsSupported && frame.name.startsWith("workspace.")) return;
        if (frame.name === "workspace.app-window.mutate") {
          const mutation = AppWindowMutationResultSchemaZ.safeParse(frame.result);
          if (mutation.success && this.#workspaceCatalog.has(mutation.data.workspaceName)) {
            this.#emit({
              type: "application-shell.changed",
              workspaceName: mutation.data.workspaceName,
            });
            return;
          }
        }
        this.#emit({ type: "workspaces.changed" });
        for (const workspace of this.#workspaceCatalog.values()) {
          this.#emit({
            type: "application-shell.changed",
            workspaceName: workspace.workspaceName,
          });
        }
        return;
      case "protocol.error":
        this.#failSocket(daemonCapabilityError("protocol-error"), 1002, "daemon protocol error");
        return;
      default:
        // init output and protocol keepalives are not renderer resources.
        return;
    }
  }

  #emitForSession(sessionName: string): void {
    for (const workspace of this.#workspaceCatalog.values()) {
      if (workspace.sessionName === sessionName) {
        this.#emit({
          type: "application-shell.changed",
          workspaceName: workspace.workspaceName,
        });
      }
    }
  }

  #invalidateEveryResource(): void {
    this.#emit({ type: "workspaces.changed" });
    this.#emit({ type: "fleet.changed" });
    for (const workspace of this.#workspaceCatalog.values()) {
      this.#emit({
        type: "application-shell.changed",
        workspaceName: workspace.workspaceName,
      });
    }
  }

  #establishEventCursor(daemonInstanceId: string, sequence: number): void {
    this.#eventReplica = advanceResourceReplica(this.#eventReplica, {
      type: "connected",
      daemonInstanceId,
    }).state;
    this.#eventReplica = advanceResourceReplica(this.#eventReplica, {
      type: "snapshot",
      daemonInstanceId,
      sequence,
      revision: sequence,
      value: null,
    }).state;
  }

  #emit(raw: DesktopDaemonEvent): void {
    const event = DesktopDaemonEventSchemaZ.parse(raw);
    for (const subscription of this.#subscriptions.values()) {
      if (
        (event.type === "application-shell.changed" || event.type === "interaction.receipt") &&
        !subscription.workspaceNames.has(event.workspaceName)
      ) {
        continue;
      }
      this.#deliver(subscription, event);
    }
  }

  #deliver(subscription: BrokerSubscription | undefined, event: DesktopDaemonEvent): void {
    if (!subscription) return;
    try {
      subscription.listener(DesktopDaemonEventSchemaZ.parse(event));
    } catch {
      // A renderer listener cannot destabilize the single physical socket.
    }
  }

  #sendSubscriptionDelta(required: Set<string>): void {
    if (!this.#socket || this.#socket.readyState !== WS_OPEN || !this.#socketPeerVerified) return;
    const removed = [...this.#sentSessions].filter((name) => !required.has(name));
    const added = [...required].filter((name) => !this.#sentSessions.has(name));
    if (removed.length > 0) {
      this.#socket.send(
        JSON.stringify(
          DaemonEventClientFrameSchemaZ.parse({ type: "unsubscribe", sessions: removed }),
        ),
      );
    }
    if (added.length > 0 || !this.#eventCursorSent) {
      this.#socket.send(
        JSON.stringify(
          DaemonEventClientFrameSchemaZ.parse({
            type: "subscribe",
            sessions: added,
            ...(!this.#eventCursorSent ? { afterSequence: this.#eventReplica.sequence ?? 0 } : {}),
          }),
        ),
      );
      this.#eventCursorSent = true;
    }
    this.#sentSessions = required;
  }

  #socketClosed(socket: BrokerEventSocket): void {
    if (this.#socket !== socket) return;
    this.#detachSocket();
    this.#supervisor.failed(daemonCapabilityError("event-unavailable"));
  }

  #socketErrored(socket: BrokerEventSocket): void {
    if (this.#socket !== socket) return;
    this.#failSocket(daemonCapabilityError("event-unavailable"), 1011, "event connection failed");
  }

  #rejectSocketFrame(reason: string): void {
    this.#failSocket(daemonCapabilityError("invalid-response"), 1002, reason);
  }

  #rejectWorkspaceUpdate(reason: string): void {
    this.#rejectSocketFrame(reason);
    void this.#refreshCatalogAfterRejectedUpdate(this.#rendererGeneration);
  }

  async #refreshCatalogAfterRejectedUpdate(expectedRendererGeneration: number): Promise<void> {
    try {
      await this.#loadWorkspaceCatalog();
      if (this.#disposed || this.#rendererGeneration !== expectedRendererGeneration) return;
      this.#synchronizeSocket();
    } catch (error) {
      if (this.#disposed || this.#rendererGeneration !== expectedRendererGeneration) return;
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: this.#boundedError(error),
      });
    }
  }

  #detachSocket(): void {
    this.#socket = null;
    this.#socketPeerVerified = false;
    this.#socketOpened = false;
    this.#sentSessions.clear();
    this.#eventCursorSent = false;
    this.#resourceEventsSupported = false;
  }

  /** Physical teardown only; what happens next is the supervisor's decision. */
  #closePhysicalSocket(code: number, reason: string): void {
    const socket = this.#socket;
    this.#detachSocket();
    if (socket && (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN)) {
      socket.close(code, reason);
    }
  }

  #failSocket(error: DesktopDaemonCapabilityError, code: number, reason: string): void {
    this.#closePhysicalSocket(code, reason);
    this.#supervisor.failed(error);
  }
}
