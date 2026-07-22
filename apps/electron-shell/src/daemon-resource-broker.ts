import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  ApplicationShellResourceV2SchemaZ,
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DesktopDaemonEventSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonFetchApplicationShellResultSchemaZ,
  DesktopDaemonHostStateSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopWorkspaceNameSchemaZ,
  TERMINAL_ATTACHMENT_ISSUE_PATH,
  TERMINAL_ATTACHMENT_MAX_ISSUE_DESCRIPTOR_LIFETIME_MS,
  TerminalAttachmentIssueDescriptorSchemaZ,
  TerminalAttachmentIssueMutationRequestSchemaZ,
  TerminalAttachmentIssueResultSchemaZ,
  type TerminalAttachmentIssueError,
  type TerminalAttachmentIssueErrorCode,
  type TerminalAttachmentIssueMutationRequest,
  type TerminalAttachmentIssueResult,
  WorkspaceCatalogResourceV1SchemaZ,
  WorkspacePaneCreateArgumentsSchemaZ,
  WorkspacePaneCreateMutationRequestSchemaZ,
  WorkspacePaneCreateMutationResultSchemaZ,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonHostState,
  type DesktopDaemonListWorkspacesResult,
  type WorkspacePaneCreateMutationRequest,
  type WorkspacePaneCreateMutationResult,
} from "@tmux-ide/contracts";
import { z } from "zod";

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TERMINAL_ATTACHMENT_ISSUE_RESPONSE_BYTES = 16 * 1024;
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

export function daemonCapabilityError(
  code: DesktopDaemonCapabilityErrorCode,
): DesktopDaemonCapabilityError {
  return { code, reason: ERROR_REASON[code] };
}

export function rendererDaemonState(daemon: DesktopDaemonHostState):
  | { readonly status: "connected"; readonly identity: DaemonInstanceIdentity }
  | {
      readonly status: "unavailable" | "degraded";
      readonly code: Extract<
        DesktopDaemonHostState,
        { status: "unavailable" | "degraded" }
      >["code"];
      readonly reason: string;
    } {
  if (daemon.status === "connected") {
    const { protocolVersion, productVersion, instanceId, startedAt } = daemon.descriptor;
    return {
      status: "connected",
      identity: { protocolVersion, productVersion, instanceId, startedAt },
    };
  }
  return {
    status: daemon.status,
    code: daemon.code,
    reason:
      daemon.status === "degraded"
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
  readonly #controllers = new Set<AbortController>();
  readonly #subscriptions = new Map<number, BrokerSubscription>();

  #disposed = false;
  #rendererGeneration = 0;
  #nextSubscription = 0;
  #workspaceCatalog = new Map<string, WorkspaceCatalogEntry>();
  #socket: BrokerEventSocket | null = null;
  #sentSessions = new Set<string>();
  #socketPeerVerified = false;
  #socketOpened = false;
  #socketHandshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #socketReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #socketReconnectAttempts = 0;

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

  async issueTerminalAttachment(
    request: TerminalAttachmentIssueMutationRequest,
    rendererOrigin: string,
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
        remainingLifetime <= 0 ||
        remainingLifetime > TERMINAL_ATTACHMENT_MAX_ISSUE_DESCRIPTOR_LIFETIME_MS
      ) {
        throw new BrokerFailure(daemonCapabilityError("daemon-identity-mismatch"));
      }
      return { status: "issued", descriptor };
    } catch (error) {
      const bounded = this.#boundedError(error);
      const code: TerminalAttachmentIssueErrorCode =
        bounded.code === "request-timeout" ||
        bounded.code === "response-too-large" ||
        bounded.code === "invalid-response" ||
        bounded.code === "daemon-identity-mismatch" ||
        bounded.code === "disposed" ||
        bounded.code === "daemon-unavailable" ||
        bounded.code === "daemon-degraded" ||
        bounded.code === "invalid-request"
          ? bounded.code
          : "request-failed";
      return { status: "error", error: terminalAttachmentIssueError(code) };
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
  ): Promise<DesktopDaemonFetchApplicationShellResult> {
    if (this.#daemon.status !== "connected") return this.#disconnectedResult();
    try {
      const request = DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse({
        workspaceName,
        resourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
      });
      if (!request.success) throw new BrokerFailure(daemonCapabilityError("invalid-request"));
      const workspaces = await this.#loadWorkspaceCatalog();
      const workspace = workspaces.find(
        (candidate) => candidate.workspaceName === request.data.workspaceName,
      );
      if (!workspace) throw new BrokerFailure(daemonCapabilityError("workspace-not-found"));
      const raw = await this.#requestJson(
        `/api/project/${encodeURIComponent(workspace.sessionName)}/application-shell?version=${APPLICATION_SHELL_RESOURCE_V2_VERSION}`,
      );
      const envelope = ApplicationShellResourceV2SchemaZ.parse(raw);
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
      try {
        this.#synchronizeSocket();
      } catch {
        this.#subscriptions.delete(id);
        this.#scheduleSocketReconnect();
        return { status: "error", error: daemonCapabilityError("event-unavailable") };
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
          try {
            this.#synchronizeSocket();
          } catch {
            this.#scheduleSocketReconnect();
          }
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
    this.#clearSocketReconnect(true);
    this.#closeSocket();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releaseRenderer();
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

  async #requestJson(pathname: string): Promise<unknown> {
    if (this.#disposed) throw new BrokerFailure(daemonCapabilityError("disposed"));
    if (this.#daemon.status !== "connected") {
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
      }, this.#requestTimeoutMs);
      timeout.unref?.();
    });
    const operation = (async (): Promise<unknown> => {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.redirected) throw new BrokerFailure(daemonCapabilityError("request-failed"));
      if (!response.ok) {
        throw new BrokerFailure(
          daemonCapabilityError(response.status === 404 ? "workspace-not-found" : "request-failed"),
        );
      }
      return readBoundedJson(response, this.#maxResponseBytes);
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
      }, this.#requestTimeoutMs);
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
        throw new BrokerFailure(daemonCapabilityError("request-failed"));
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
    const required = this.#requiredSessions();
    if (this.#subscriptions.size === 0) {
      this.#clearSocketReconnect(true);
      this.#closeSocket();
      return;
    }
    if (!this.#socket) {
      if (this.#daemon.status !== "connected") return;
      this.#clearSocketReconnect(false);
      const url = new URL("/ws/events", this.#daemon.descriptor.apiBaseUrl);
      url.protocol = "ws:";
      const socket = this.#createWebSocket(url.toString());
      this.#socket = socket;
      this.#socketPeerVerified = false;
      this.#socketOpened = false;
      this.#sentSessions.clear();
      this.#startSocketHandshakeTimer(socket);
      socket.addEventListener("open", () => {
        if (this.#socket !== socket) return;
        this.#socketOpened = true;
        // The first frame must authenticate the non-secret daemon generation.
      });
      socket.addEventListener("message", (event) => this.#receiveSocketEvent(socket, event.data));
      socket.addEventListener("close", () => this.#socketClosed(socket));
      socket.addEventListener("error", () => this.#socketErrored(socket));
      return;
    }
    if (this.#socket.readyState === WS_OPEN && this.#socketPeerVerified) {
      this.#sendSubscriptionDelta(required);
    }
  }

  #receiveSocketEvent(socket: BrokerEventSocket, data: unknown): void {
    if (this.#socket !== socket) return;
    if (!this.#socketOpened) {
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("invalid-response"),
      });
      this.#closeSocket(1002, "event frame before open", true);
      return;
    }
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).byteLength > this.#maxEventBytes
    ) {
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("invalid-response"),
      });
      this.#closeSocket(1009, "invalid event frame", true);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("invalid-response"),
      });
      this.#closeSocket(1002, "invalid event frame", true);
      return;
    }
    const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
    if (!parsed.success) {
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("invalid-response"),
      });
      this.#closeSocket(1002, "invalid event frame", true);
      return;
    }
    if (!this.#socketPeerVerified) {
      if (
        parsed.data.type !== "hello" ||
        this.#daemon.status !== "connected" ||
        !sameIdentity(parsed.data.daemon, daemonIdentity(this.#daemon))
      ) {
        this.#emit({
          type: "connection.changed",
          state: "degraded",
          error: daemonCapabilityError("daemon-identity-mismatch"),
        });
        this.#closeSocket(1008, "daemon generation mismatch", true);
        return;
      }
      this.#socketPeerVerified = true;
      this.#clearSocketHandshakeTimer();
      this.#clearSocketReconnect(true);
      this.#sendSubscriptionDelta(this.#requiredSessions());
      this.#emit({ type: "connection.changed", state: "live", error: null });
      return;
    }
    if (parsed.data.type === "hello") {
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("invalid-response"),
      });
      this.#closeSocket(1002, "duplicate hello frame", true);
      return;
    }
    this.#projectServerFrame(parsed.data);
  }

  #projectServerFrame(frame: DaemonEventServerFrame): void {
    switch (frame.type) {
      case "snapshot":
      case "config.changed":
      case "terminals.changed":
        this.#emitForSession(frame.sessionName);
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
      case "action.complete":
        this.#emit({ type: "workspaces.changed" });
        for (const workspace of this.#workspaceCatalog.values()) {
          this.#emit({
            type: "application-shell.changed",
            workspaceName: workspace.workspaceName,
          });
        }
        return;
      case "protocol.error":
        this.#emit({
          type: "connection.changed",
          state: "degraded",
          error: daemonCapabilityError("protocol-error"),
        });
        this.#closeSocket(1002, "daemon protocol error", true);
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

  #emit(raw: DesktopDaemonEvent): void {
    const event = DesktopDaemonEventSchemaZ.parse(raw);
    for (const subscription of this.#subscriptions.values()) {
      if (
        event.type === "application-shell.changed" &&
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
    if (added.length > 0) {
      this.#socket.send(
        JSON.stringify(DaemonEventClientFrameSchemaZ.parse({ type: "subscribe", sessions: added })),
      );
    }
    this.#sentSessions = required;
  }

  #socketClosed(socket: BrokerEventSocket): void {
    if (this.#socket !== socket) return;
    this.#clearSocketHandshakeTimer();
    this.#socket = null;
    this.#socketPeerVerified = false;
    this.#socketOpened = false;
    this.#sentSessions.clear();
    this.#emit({
      type: "connection.changed",
      state: "degraded",
      error: daemonCapabilityError("event-unavailable"),
    });
    this.#scheduleSocketReconnect();
  }

  #socketErrored(socket: BrokerEventSocket): void {
    if (this.#socket !== socket) return;
    this.#emit({
      type: "connection.changed",
      state: "degraded",
      error: daemonCapabilityError("event-unavailable"),
    });
    this.#closeSocket(1011, "event connection failed", true);
  }

  #startSocketHandshakeTimer(socket: BrokerEventSocket): void {
    this.#clearSocketHandshakeTimer();
    this.#socketHandshakeTimer = setTimeout(() => {
      if (this.#socket !== socket || this.#socketPeerVerified) return;
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("event-unavailable"),
      });
      this.#closeSocket(1008, "event handshake timeout", true);
    }, this.#eventHandshakeTimeoutMs);
    this.#socketHandshakeTimer.unref?.();
  }

  #clearSocketHandshakeTimer(): void {
    if (!this.#socketHandshakeTimer) return;
    clearTimeout(this.#socketHandshakeTimer);
    this.#socketHandshakeTimer = null;
  }

  #scheduleSocketReconnect(): void {
    if (
      this.#disposed ||
      this.#subscriptions.size === 0 ||
      this.#socket !== null ||
      this.#socketReconnectTimer !== null ||
      this.#socketReconnectAttempts >= this.#eventReconnectMaximumAttempts
    ) {
      return;
    }
    const delay = Math.min(
      this.#eventReconnectMaximumDelayMs,
      this.#eventReconnectInitialDelayMs * 2 ** this.#socketReconnectAttempts,
    );
    this.#socketReconnectAttempts += 1;
    this.#socketReconnectTimer = setTimeout(() => {
      this.#socketReconnectTimer = null;
      if (this.#disposed || this.#subscriptions.size === 0 || this.#socket !== null) return;
      try {
        this.#synchronizeSocket();
      } catch {
        this.#emit({
          type: "connection.changed",
          state: "degraded",
          error: daemonCapabilityError("event-unavailable"),
        });
        this.#scheduleSocketReconnect();
      }
    }, delay);
    this.#socketReconnectTimer.unref?.();
  }

  #clearSocketReconnect(resetAttempts: boolean): void {
    if (this.#socketReconnectTimer) clearTimeout(this.#socketReconnectTimer);
    this.#socketReconnectTimer = null;
    if (resetAttempts) this.#socketReconnectAttempts = 0;
  }

  #rejectSocketFrame(reason: string): void {
    this.#emit({
      type: "connection.changed",
      state: "degraded",
      error: daemonCapabilityError("invalid-response"),
    });
    this.#closeSocket(1002, reason, true);
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

  #closeSocket(code = 1000, reason = "renderer released", reconnect = false): void {
    const socket = this.#socket;
    this.#clearSocketHandshakeTimer();
    this.#socket = null;
    this.#socketPeerVerified = false;
    this.#socketOpened = false;
    this.#sentSessions.clear();
    if (socket && (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN)) {
      socket.close(code, reason);
    }
    if (reconnect) this.#scheduleSocketReconnect();
  }
}
