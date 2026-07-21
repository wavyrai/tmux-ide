import {
  ApplicationShellResourceV1SchemaZ,
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DesktopDaemonEventSchemaZ,
  DesktopDaemonEventSubscriptionRequestSchemaZ,
  DesktopDaemonFetchApplicationShellRequestSchemaZ,
  DesktopDaemonFetchApplicationShellResultSchemaZ,
  DesktopDaemonHostStateSchemaZ,
  DesktopDaemonListWorkspacesResultSchemaZ,
  DesktopWorkspaceNameSchemaZ,
  WorkspaceCatalogResourceV1SchemaZ,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type DesktopDaemonCapabilityError,
  type DesktopDaemonCapabilityErrorCode,
  type DesktopDaemonEvent,
  type DesktopDaemonFetchApplicationShellResult,
  type DesktopDaemonHostState,
  type DesktopDaemonListWorkspacesResult,
} from "@tmux-ide/contracts";

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;
const DEFAULT_EVENT_HANDSHAKE_TIMEOUT_MS = 3_000;
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
      const request = DesktopDaemonFetchApplicationShellRequestSchemaZ.safeParse({ workspaceName });
      if (!request.success) throw new BrokerFailure(daemonCapabilityError("invalid-request"));
      const workspaces = await this.#loadWorkspaceCatalog();
      const workspace = workspaces.find(
        (candidate) => candidate.workspaceName === request.data.workspaceName,
      );
      if (!workspace) throw new BrokerFailure(daemonCapabilityError("workspace-not-found"));
      const raw = await this.#requestJson(
        `/api/project/${encodeURIComponent(workspace.sessionName)}/application-shell`,
      );
      const envelope = ApplicationShellResourceV1SchemaZ.parse(raw);
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
    if (required.size === 0) {
      this.#closeSocket();
      return;
    }
    if (!this.#socket) {
      if (this.#daemon.status !== "connected") return;
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
      this.#closeSocket(1002, "event frame before open");
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
      this.#closeSocket(1009, "invalid event frame");
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
      this.#closeSocket(1002, "invalid event frame");
      return;
    }
    const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
    if (!parsed.success) {
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: daemonCapabilityError("invalid-response"),
      });
      this.#closeSocket(1002, "invalid event frame");
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
        this.#closeSocket(1008, "daemon generation mismatch");
        return;
      }
      this.#socketPeerVerified = true;
      this.#clearSocketHandshakeTimer();
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
      this.#closeSocket(1002, "duplicate hello frame");
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
  }

  #socketErrored(socket: BrokerEventSocket): void {
    if (this.#socket !== socket) return;
    this.#emit({
      type: "connection.changed",
      state: "degraded",
      error: daemonCapabilityError("event-unavailable"),
    });
    this.#closeSocket(1011, "event connection failed");
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
      this.#closeSocket(1008, "event handshake timeout");
    }, this.#eventHandshakeTimeoutMs);
    this.#socketHandshakeTimer.unref?.();
  }

  #clearSocketHandshakeTimer(): void {
    if (!this.#socketHandshakeTimer) return;
    clearTimeout(this.#socketHandshakeTimer);
    this.#socketHandshakeTimer = null;
  }

  #rejectSocketFrame(reason: string): void {
    this.#emit({
      type: "connection.changed",
      state: "degraded",
      error: daemonCapabilityError("invalid-response"),
    });
    this.#closeSocket(1002, reason);
  }

  #rejectWorkspaceUpdate(reason: string): void {
    this.#rejectSocketFrame(reason);
    void this.#refreshCatalogAfterRejectedUpdate();
  }

  async #refreshCatalogAfterRejectedUpdate(): Promise<void> {
    try {
      await this.#loadWorkspaceCatalog();
      if (!this.#disposed) this.#synchronizeSocket();
    } catch (error) {
      if (this.#disposed) return;
      this.#emit({
        type: "connection.changed",
        state: "degraded",
        error: this.#boundedError(error),
      });
    }
  }

  #closeSocket(code = 1000, reason = "renderer released"): void {
    const socket = this.#socket;
    this.#clearSocketHandshakeTimer();
    this.#socket = null;
    this.#socketPeerVerified = false;
    this.#socketOpened = false;
    this.#sentSessions.clear();
    if (socket && (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN)) {
      socket.close(code, reason);
    }
  }
}
