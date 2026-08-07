import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellResourceV2SchemaZ,
  ApplicationShellResourceV3SchemaZ,
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DesktopApplicationShellTargetSchemaZ,
  DesktopDaemonHostDescriptorSchemaZ,
  isDaemonWireProtocolCompatible,
  type ApplicationShellProjectionInputV1,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type DesktopDaemonHostDescriptor,
  type DesktopDaemonTransportState,
} from "@tmux-ide/contracts";
import { browserInitiatedWebSocketCloseCode } from "../browser-websocket.ts";
import {
  advanceResourceReplica,
  initialResourceReplica,
  type ResourceReplicaState,
} from "@tmux-ide/daemon-client/resource-replica";

import type { DesktopApplicationShellTarget } from "./connection-state.ts";

export type DaemonTransportErrorKind =
  | "descriptor-invalid"
  | "daemon-identity-mismatch"
  | "not-found"
  | "network-error"
  | "http-error"
  | "schema-invalid";

export class DaemonTransportError extends Error {
  readonly kind: DaemonTransportErrorKind;
  readonly statusCode?: number;

  constructor(kind: DaemonTransportErrorKind, message: string, statusCode?: number) {
    super(message);
    this.name = "DaemonTransportError";
    this.kind = kind;
    this.statusCode = statusCode;
  }
}

export type DaemonFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type DaemonSocketEventType = "open" | "message" | "close" | "error";
type DaemonSocketEvent = { readonly data?: unknown };
type DaemonSocketListener = (event: DaemonSocketEvent) => void;

export interface DaemonEventSocket {
  readonly readyState: number;
  addEventListener(type: DaemonSocketEventType, listener: DaemonSocketListener): void;
  removeEventListener?(type: DaemonSocketEventType, listener: DaemonSocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type DaemonWebSocketFactory = (url: string) => DaemonEventSocket;

export interface DaemonTransportDependencies {
  readonly descriptor: DesktopDaemonHostDescriptor;
  /** Semantic workspace → live tmux session resolver; never inferred by name equality. */
  readonly resolveSessionName: (workspaceName: string) => string;
  readonly fetch?: DaemonFetch;
  readonly createWebSocket?: DaemonWebSocketFactory;
}

export interface DaemonEventHandlers {
  /** Fires only after a strict hello matches the requested daemon generation. */
  readonly onVerifiedOpen: () => void;
  readonly onInvalidate: () => void;
  readonly onProtocolError: (reason: string) => void;
  readonly onPeerMismatch: (reason: string) => void;
  readonly onMalformedFrame: (reason: string) => void;
  readonly onClose: () => void;
  readonly onError: (reason: string) => void;
  /**
   * Pushed by transports whose physical socket is owned by the main-process
   * connection supervisor. Once a state arrives, the supervisor is the ONE
   * retry owner: the store derives its status from these states and must not
   * run its own reconnect loop. Transports that own their socket directly
   * (the loopback development transport) never call this.
   */
  readonly onTransportStateChanged?: (transport: DesktopDaemonTransportState) => void;
}

export interface DaemonEventConnection {
  close(): void;
}

export interface DesktopDaemonTransport {
  fetchApplicationShell(
    target: DesktopApplicationShellTarget,
    signal: AbortSignal,
  ): Promise<ApplicationShellProjectionInputV1>;
  connectEvents(
    target: DesktopApplicationShellTarget,
    handlers: DaemonEventHandlers,
  ): DaemonEventConnection;
  validateTarget(target: unknown): DesktopApplicationShellTarget;
}

function defaultFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultCreateWebSocket(url: string): DaemonEventSocket {
  return new globalThis.WebSocket(url) as unknown as DaemonEventSocket;
}

function descriptorError(message: string): DaemonTransportError {
  return new DaemonTransportError("descriptor-invalid", message);
}

function peerMismatch(message: string): DaemonTransportError {
  return new DaemonTransportError("daemon-identity-mismatch", message);
}

function validatedDescriptor(value: DesktopDaemonHostDescriptor): DesktopDaemonHostDescriptor {
  const parsed = DesktopDaemonHostDescriptorSchemaZ.safeParse(value);
  if (!parsed.success) {
    throw descriptorError(
      `Daemon descriptor is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.protocolVersion)) {
    throw descriptorError(
      `Daemon protocol ${parsed.data.protocolVersion} is not compatible with this renderer.`,
    );
  }
  // The shared schema already restricts this to an uncredentialed loopback
  // HTTP origin. Keep the explicit check here so this transport remains safe
  // even if the host boundary is bypassed by a test or future caller.
  const origin = new URL(parsed.data.apiBaseUrl);
  if (
    origin.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
    origin.username.length > 0 ||
    origin.password.length > 0
  ) {
    throw descriptorError("Daemon descriptor must use an uncredentialed loopback HTTP origin.");
  }
  return parsed.data;
}

function validatedTarget(value: unknown): DesktopApplicationShellTarget {
  const parsed = DesktopApplicationShellTargetSchemaZ.safeParse(value);
  if (!parsed.success) {
    throw descriptorError(
      `Daemon application-shell target is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  if (!isDaemonWireProtocolCompatible(parsed.data.daemon.protocolVersion)) {
    throw descriptorError(
      `Daemon protocol ${parsed.data.daemon.protocolVersion} is not compatible with this renderer.`,
    );
  }
  return parsed.data;
}

function applicationShellUrl(
  descriptor: DesktopDaemonHostDescriptor,
  sessionName: string,
  version:
    | typeof APPLICATION_SHELL_RESOURCE_V2_VERSION
    | typeof APPLICATION_SHELL_RESOURCE_V3_VERSION,
): URL {
  const url = new URL(
    `/api/project/${encodeURIComponent(sessionName)}/application-shell`,
    descriptor.apiBaseUrl,
  );
  url.searchParams.set("version", String(version));
  return url;
}

function eventSocketUrl(descriptor: DesktopDaemonHostDescriptor): string {
  const url = new URL("/ws/events", descriptor.apiBaseUrl);
  url.protocol = "ws:";
  return url.toString();
}

function sameDaemonGeneration(
  expected: DaemonInstanceIdentity,
  actual: DaemonInstanceIdentity,
): boolean {
  return (
    actual.protocolVersion === expected.protocolVersion &&
    actual.productVersion === expected.productVersion &&
    actual.instanceId === expected.instanceId &&
    actual.startedAt === expected.startedAt
  );
}

function requireMatchingPeer(
  expected: DaemonInstanceIdentity,
  actual: DaemonInstanceIdentity,
): void {
  if (!sameDaemonGeneration(expected, actual)) {
    throw peerMismatch("Daemon generation did not match the desktop host descriptor.");
  }
}

function resolvedSessionName(
  resolveSessionName: (workspaceName: string) => string,
  workspaceName: string,
): string {
  let sessionName: unknown;
  try {
    sessionName = resolveSessionName(workspaceName);
  } catch {
    throw descriptorError("Workspace resolver failed to resolve a live session.");
  }
  if (
    typeof sessionName !== "string" ||
    sessionName.trim().length === 0 ||
    sessionName.trim().length > 160
  ) {
    throw descriptorError("Workspace resolver did not return a valid session name.");
  }
  return sessionName.trim();
}

function isRelevantFrame(
  frame: DaemonEventServerFrame,
  workspaceName: string,
  sessionName: string,
): boolean {
  switch (frame.type) {
    case "snapshot":
    case "config.changed":
    case "terminals.changed":
    case "agent-status.changed":
      return frame.sessionName === sessionName;
    case "sessions.changed":
    case "projects.changed":
    case "action.complete":
      return true;
    case "resource.changed":
      return (
        frame.resource === "application-shell" &&
        (frame.workspaceName === null || frame.workspaceName === workspaceName)
      );
    case "snapshot-required":
      return true;
    case "workspace.added":
      return frame.workspace.name === workspaceName;
    case "workspace.removed":
      return frame.name === workspaceName;
    default:
      return false;
  }
}

/**
 * Direct loopback transport for isolated development and transport tests.
 * Production desktop shells inject a HostCapabilities-backed broker transport
 * so daemon endpoint URLs never need to enter the renderer bootstrap.
 */
export function createDirectLoopbackDaemonTransport(
  dependencies: DaemonTransportDependencies,
): DesktopDaemonTransport {
  const descriptor = validatedDescriptor(dependencies.descriptor);
  const resolveSessionName = dependencies.resolveSessionName;
  if (typeof resolveSessionName !== "function") {
    throw descriptorError("Direct loopback transport requires a semantic workspace resolver.");
  }
  const fetchImpl = dependencies.fetch ?? defaultFetch;
  const createWebSocket = dependencies.createWebSocket ?? defaultCreateWebSocket;
  const eventReplicas = new Map<string, ResourceReplicaState<null>>();
  const validateBoundTarget = (value: unknown): DesktopApplicationShellTarget => {
    const safeTarget = validatedTarget(value);
    requireMatchingPeer(safeTarget.daemon, descriptor);
    return safeTarget;
  };

  return {
    validateTarget: validateBoundTarget,

    async fetchApplicationShell(target, signal) {
      const safeTarget = validateBoundTarget(target);
      const sessionName = resolvedSessionName(resolveSessionName, safeTarget.workspaceName);
      let response: Response;
      let negotiatedVersion = APPLICATION_SHELL_RESOURCE_V3_VERSION as
        | typeof APPLICATION_SHELL_RESOURCE_V2_VERSION
        | typeof APPLICATION_SHELL_RESOURCE_V3_VERSION;
      try {
        const request = (version: typeof negotiatedVersion) =>
          fetchImpl(applicationShellUrl(descriptor, sessionName, version), {
            method: "GET",
            headers: { accept: "application/json" },
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal,
          });
        response = await request(negotiatedVersion);
        if (response.status === 400) {
          negotiatedVersion = APPLICATION_SHELL_RESOURCE_V2_VERSION;
          response = await request(negotiatedVersion);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        throw new DaemonTransportError(
          "network-error",
          error instanceof Error ? error.message : "Daemon application-shell request failed.",
        );
      }
      if (response.status === 404) {
        throw new DaemonTransportError(
          "not-found",
          `Workspace ${JSON.stringify(safeTarget.workspaceName)} is not available from the daemon.`,
          404,
        );
      }
      if (!response.ok) {
        throw new DaemonTransportError(
          "http-error",
          `Daemon application-shell request returned HTTP ${response.status}.`,
          response.status,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new DaemonTransportError(
          "schema-invalid",
          "Daemon application-shell response was not valid JSON.",
        );
      }
      const parsed =
        negotiatedVersion === APPLICATION_SHELL_RESOURCE_V3_VERSION
          ? ApplicationShellResourceV3SchemaZ.safeParse(body)
          : ApplicationShellResourceV2SchemaZ.safeParse(body);
      if (!parsed.success) {
        throw new DaemonTransportError(
          "schema-invalid",
          `Daemon application-shell response failed validation: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
        );
      }
      requireMatchingPeer(safeTarget.daemon, parsed.data.daemon);
      return parsed.data.resource;
    },

    connectEvents(target, handlers) {
      const safeTarget = validateBoundTarget(target);
      const sessionName = resolvedSessionName(resolveSessionName, safeTarget.workspaceName);
      let eventReplica =
        eventReplicas.get(safeTarget.workspaceName) ?? initialResourceReplica<null>();
      const socket = createWebSocket(eventSocketUrl(descriptor));
      let closed = false;
      let socketOpened = false;
      let peerVerified = false;
      let resourceEventsSupported = false;

      const establishCursor = (daemonInstanceId: string, sequence: number): void => {
        eventReplica = advanceResourceReplica(eventReplica, {
          type: "connected",
          daemonInstanceId,
        }).state;
        eventReplica = advanceResourceReplica(eventReplica, {
          type: "snapshot",
          daemonInstanceId,
          sequence,
          revision: sequence,
          value: null,
        }).state;
        eventReplicas.set(safeTarget.workspaceName, eventReplica);
      };

      const onOpen: DaemonSocketListener = () => {
        if (closed) return;
        socketOpened = true;
      };
      const onMessage: DaemonSocketListener = (event) => {
        if (closed) return;
        if (typeof event.data !== "string") {
          handlers.onMalformedFrame("Daemon event frame was not text.");
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(event.data);
        } catch {
          handlers.onMalformedFrame("Daemon event frame was not valid JSON.");
          return;
        }
        const parsed = DaemonEventServerFrameSchemaZ.safeParse(raw);
        if (!parsed.success) {
          handlers.onMalformedFrame("Daemon event frame failed shared protocol validation.");
          return;
        }
        if (!socketOpened) {
          handlers.onMalformedFrame("Daemon event frame arrived before the socket opened.");
          return;
        }
        if (!peerVerified) {
          if (parsed.data.type !== "hello") {
            handlers.onMalformedFrame("Daemon event socket did not begin with a hello frame.");
            return;
          }
          if (!sameDaemonGeneration(safeTarget.daemon, parsed.data.daemon)) {
            const reason = "Daemon event hello did not match the desktop host descriptor.";
            closed = true;
            socket.removeEventListener?.("open", onOpen);
            socket.removeEventListener?.("message", onMessage);
            socket.removeEventListener?.("close", onClose);
            socket.removeEventListener?.("error", onError);
            handlers.onPeerMismatch(reason);
            socket.close(browserInitiatedWebSocketCloseCode(1008), "Daemon identity mismatch");
            return;
          }
          try {
            const resumeSequence =
              eventReplica.daemonInstanceId === parsed.data.daemon.instanceId
                ? (eventReplica.sequence ?? 0)
                : 0;
            establishCursor(parsed.data.daemon.instanceId, resumeSequence);
            resourceEventsSupported = parsed.data.eventSequence !== undefined;
            const subscribe = DaemonEventClientFrameSchemaZ.parse({
              type: "subscribe",
              sessions: [sessionName],
              afterSequence: resumeSequence,
            });
            socket.send(JSON.stringify(subscribe));
            peerVerified = true;
            handlers.onVerifiedOpen();
          } catch (error) {
            handlers.onError(
              error instanceof Error ? error.message : "Daemon event subscription failed.",
            );
          }
          return;
        }
        if (parsed.data.type === "hello") {
          handlers.onMalformedFrame("Daemon event socket sent a duplicate hello frame.");
          return;
        }
        if (parsed.data.type === "protocol.error") {
          handlers.onProtocolError(parsed.data.message);
          return;
        }
        if (parsed.data.type === "snapshot-required") {
          const transition = advanceResourceReplica(eventReplica, {
            type: "gap",
            daemonInstanceId: safeTarget.daemon.instanceId,
            sequence: parsed.data.currentSequence,
          });
          eventReplica = transition.state;
          eventReplicas.set(safeTarget.workspaceName, eventReplica);
          handlers.onInvalidate();
          establishCursor(safeTarget.daemon.instanceId, parsed.data.currentSequence);
          return;
        }
        if (parsed.data.type === "resource.changed") {
          const previousSequence = eventReplica.sequence;
          const transition = advanceResourceReplica(eventReplica, {
            type: "changed",
            daemonInstanceId: safeTarget.daemon.instanceId,
            sequence: parsed.data.sequence,
            // The shared replica owns the global event cursor here; the
            // resource-specific revision remains on the wire frame.
            revision: parsed.data.sequence,
            ...(parsed.data.causeOperationId
              ? { causeOperationId: parsed.data.causeOperationId }
              : {}),
          });
          eventReplica = transition.state;
          eventReplicas.set(safeTarget.workspaceName, eventReplica);
          if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
            handlers.onInvalidate();
            establishCursor(safeTarget.daemon.instanceId, parsed.data.sequence);
            return;
          }
          if (
            parsed.data.sequence > (previousSequence ?? -1) &&
            isRelevantFrame(parsed.data, safeTarget.workspaceName, sessionName)
          ) {
            handlers.onInvalidate();
          }
          return;
        }
        if (
          parsed.data.type === "action.complete" &&
          resourceEventsSupported &&
          parsed.data.name.startsWith("workspace.")
        ) {
          // New daemons follow workspace actions with the scoped, replayable
          // resource frame. Keep this legacy frame only for older peers.
          return;
        }
        if (isRelevantFrame(parsed.data, safeTarget.workspaceName, sessionName)) {
          handlers.onInvalidate();
        }
      };
      const onClose: DaemonSocketListener = () => {
        if (closed) return;
        handlers.onClose();
      };
      const onError: DaemonSocketListener = () => {
        if (closed) return;
        handlers.onError("Daemon event socket reported an error.");
      };

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);

      return {
        close() {
          if (closed) return;
          closed = true;
          socket.removeEventListener?.("open", onOpen);
          socket.removeEventListener?.("message", onMessage);
          socket.removeEventListener?.("close", onClose);
          socket.removeEventListener?.("error", onError);
          socket.close(1000, "Desktop resource store disposed");
        },
      };
    },
  };
}
