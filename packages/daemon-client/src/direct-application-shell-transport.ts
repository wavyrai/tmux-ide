import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  APPLICATION_SHELL_RESOURCE_V3_VERSION,
  ApplicationShellResourceV2SchemaZ,
  ApplicationShellResourceV3SchemaZ,
  DaemonEventClientFrameSchemaZ,
  DaemonEventServerFrameSchemaZ,
  DesktopApplicationShellTargetSchemaZ,
  DesktopDaemonHostDescriptorSchemaZ,
  TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION,
  TerminalRuntimeInventoryResourceV1SchemaZ,
  isDaemonWireProtocolCompatible,
  type DaemonEventServerFrame,
  type DaemonInstanceIdentity,
  type DesktopApplicationShellTarget,
  type DesktopDaemonHostDescriptor,
  type TerminalRuntimeInventoryProjectionV1,
} from "@tmux-ide/contracts";
import {
  advanceResourceReplica,
  initialResourceReplica,
  type ResourceReplicaState,
} from "./resource-replica.ts";
import {
  ApplicationShellTransportError,
  type ApplicationShellEventConnection,
  type ApplicationShellEventHandlers,
  type ApplicationShellTransport,
  type ApplicationShellTransportErrorKind,
} from "./application-shell-session.ts";
import {
  createWorkspaceEventSupervisor,
  type PreparedTerminalRuntimeInventory,
  type WorkspaceEventSupervisor,
  type WorkspaceEventSocketOptions,
} from "./workspace-event-supervisor.ts";

export type DaemonTransportErrorKind = ApplicationShellTransportErrorKind;

export class DaemonTransportError extends ApplicationShellTransportError {
  constructor(kind: DaemonTransportErrorKind, message: string, statusCode?: number) {
    super(kind, message, statusCode);
    this.name = "DaemonTransportError";
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

export type DaemonWebSocketFactory = (
  url: string,
  options?: WorkspaceEventSocketOptions,
) => DaemonEventSocket;

export interface DaemonTransportDependencies {
  readonly descriptor: DesktopDaemonHostDescriptor;
  /** Semantic workspace → live tmux session resolver; never inferred by name equality. */
  readonly resolveSessionName: (workspaceName: string) => string;
  /** Optional owner credential retained by the host process, never the target. */
  readonly ownerToken?: string;
  /**
   * Application-shell contract requested by this renderer. Native canvas
   * hosts retain the V3 default; terminal-first hosts may select V2 so they do
   * not pay for app-window enrichment they never consume.
   */
  readonly applicationShellResourceVersion?:
    | typeof APPLICATION_SHELL_RESOURCE_V2_VERSION
    | typeof APPLICATION_SHELL_RESOURCE_V3_VERSION;
  readonly fetch?: DaemonFetch;
  readonly createWebSocket?: DaemonWebSocketFactory;
  /** OpenTUI-only terminal-first authority; other hosts retain legacy transport ordering. */
  readonly terminalRuntimeAuthority?: boolean;
  readonly terminalRuntimeDiagnostic?: (
    phase:
      | "terminal-event-socket-create"
      | "terminal-event-socket-open"
      | "terminal-event-hello"
      | "terminal-interest-send"
      | "terminal-interest-ack"
      | "terminal-refresh"
      | "terminal-http-start"
      | "terminal-http-response"
      | "terminal-capability-adopted"
      | "terminal-fallback-selected",
    details: Readonly<Record<string, unknown>>,
  ) => void;
  /** Injectable reconnect scheduler for deterministic lifecycle tests. */
  readonly terminalReconnectClock?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export type DaemonEventHandlers = ApplicationShellEventHandlers;
export type DaemonEventConnection = ApplicationShellEventConnection;
export type DesktopDaemonTransport = ApplicationShellTransport;

export interface TerminalFirstDaemonTransport extends DesktopDaemonTransport {
  prepareTerminalRuntimeInventory(
    target: DesktopApplicationShellTarget,
    signal: AbortSignal,
  ): Promise<PreparedTerminalRuntimeInventory>;
  adoptTerminalRuntimeInventory(
    prepared: PreparedTerminalRuntimeInventory,
    onResource: (resource: TerminalRuntimeInventoryProjectionV1) => void,
  ): TerminalRuntimeInventoryProjectionV1 | null;
  disposeEventSupervisor(): void;
  /** Fully release terminal-first state before selecting the old-daemon V2 authority. */
  selectApplicationShellFallback(
    reason?: "deadline" | "retired" | "preparation-rejected" | "adoption-rejected" | "unknown",
  ): void;
  refreshTerminalRuntimeInventory(): void;
  connectWorkspaceCatalog(
    target: DesktopApplicationShellTarget,
    invalidate: () => void,
    options?: { readonly terminalFirst?: boolean },
  ): {
    readonly ready: Promise<void>;
    close(): void;
  };
}

function clientInitiatedWebSocketCloseCode(code: number | undefined): number | undefined {
  if (code === undefined || code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (Number.isInteger(code) && code >= 1001 && code <= 1999) return code + 3000;
  return 4000;
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

function terminalRuntimeInventoryUrl(
  descriptor: DesktopDaemonHostDescriptor,
  sessionName: string,
): URL {
  const url = new URL(
    `/api/project/${encodeURIComponent(sessionName)}/terminal-runtime-inventory`,
    descriptor.apiBaseUrl,
  );
  url.searchParams.set("version", String(TERMINAL_RUNTIME_INVENTORY_RESOURCE_VERSION));
  return url;
}

function eventSocketUrl(descriptor: DesktopDaemonHostDescriptor, mode?: "semantic"): string {
  const url = new URL("/ws/events", descriptor.apiBaseUrl);
  url.protocol = "ws:";
  if (mode) url.searchParams.set("mode", mode);
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
    case "interaction.receipt":
      return frame.workspaceName === workspaceName;
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
): DesktopDaemonTransport | TerminalFirstDaemonTransport {
  const descriptor = validatedDescriptor(dependencies.descriptor);
  const resolveSessionName = dependencies.resolveSessionName;
  if (typeof resolveSessionName !== "function") {
    throw descriptorError("Direct loopback transport requires a semantic workspace resolver.");
  }
  const fetchImpl = dependencies.fetch ?? defaultFetch;
  const createWebSocket = dependencies.createWebSocket ?? defaultCreateWebSocket;
  const diagnose = dependencies.terminalRuntimeDiagnostic
    ? (
        phase: Parameters<NonNullable<DaemonTransportDependencies["terminalRuntimeDiagnostic"]>>[0],
        details: Readonly<Record<string, unknown>>,
      ): void => {
        try {
          dependencies.terminalRuntimeDiagnostic?.(phase, details);
        } catch {
          // Diagnostics never own transport or authority lifecycle.
        }
      }
    : null;
  const applicationShellResourceVersion =
    dependencies.applicationShellResourceVersion ?? APPLICATION_SHELL_RESOURCE_V3_VERSION;
  const eventReplicas = new Map<string, ResourceReplicaState<null>>();
  let eventSupervisor: WorkspaceEventSupervisor | null = null;
  let supervisorTargetKey: string | null = null;
  let terminalRuntimeEnabled = dependencies.terminalRuntimeAuthority === true;
  let terminalAuthoritySink: ((resource: TerminalRuntimeInventoryProjectionV1) => void) | null =
    null;
  let retainedApplicationShellHandlers: ApplicationShellEventHandlers | null = null;
  let applicationShellSupervisorConnection: ApplicationShellEventConnection | null = null;
  let retainedWorkspaceCatalogInvalidate: (() => void) | null = null;
  let retainedWorkspaceCatalogSubscriber: object | null = null;
  let retainedWorkspaceCatalogReady: {
    readonly subscriber: object;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    settled: boolean;
  } | null = null;
  let retainedWorkspaceCatalogRoute: {
    readonly target: DesktopApplicationShellTarget;
    readonly sessionName: string;
  } | null = null;
  let workspaceCatalogSupervisorConnection: {
    readonly ready: Promise<void>;
    close(): void;
  } | null = null;
  const terminalReconnectClock = dependencies.terminalReconnectClock ?? {
    setTimeout(callback: () => void, delayMs: number): unknown {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return handle;
    },
    clearTimeout(handle: unknown): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  let terminalReconnectTimer: unknown | null = null;
  let terminalReconnectController: AbortController | null = null;
  let catalogReconnectTimer: unknown | null = null;
  let catalogReconnectAttempt = 0;
  let scheduleCatalogOnlyReconnect = (): void => undefined;
  const cancelTerminalReconnect = (): void => {
    if (terminalReconnectTimer !== null)
      terminalReconnectClock.clearTimeout(terminalReconnectTimer);
    terminalReconnectTimer = null;
    terminalReconnectController?.abort(
      new DOMException("Terminal authority reconnect retired", "AbortError"),
    );
    terminalReconnectController = null;
  };
  const cancelCatalogReconnect = (): void => {
    if (catalogReconnectTimer !== null) terminalReconnectClock.clearTimeout(catalogReconnectTimer);
    catalogReconnectTimer = null;
    catalogReconnectAttempt = 0;
  };
  const createCatalogReadiness = (subscriber: object) => {
    let accept = (): void => undefined;
    const readiness = {
      subscriber,
      promise: new Promise<void>((resolve) => {
        accept = resolve;
      }),
      resolve: () => {
        if (readiness.settled) return;
        readiness.settled = true;
        accept();
      },
      settled: false,
    };
    return readiness;
  };
  const resetCatalogReadiness = (): void => {
    const readiness = retainedWorkspaceCatalogReady;
    if (!readiness?.settled) return;
    retainedWorkspaceCatalogReady = createCatalogReadiness(readiness.subscriber);
  };
  const validateBoundTarget = (value: unknown): DesktopApplicationShellTarget => {
    const safeTarget = validatedTarget(value);
    requireMatchingPeer(safeTarget.daemon, descriptor);
    return safeTarget;
  };

  const fetchTerminalRuntimeInventory = async (
    safeTarget: DesktopApplicationShellTarget,
    sessionName: string,
    signal: AbortSignal,
  ): Promise<TerminalRuntimeInventoryProjectionV1> => {
    const responsePending = fetchImpl(terminalRuntimeInventoryUrl(descriptor, sessionName), {
      method: "GET",
      headers: {
        accept: "application/json",
        ...(dependencies.ownerToken ? { Authorization: `Bearer ${dependencies.ownerToken}` } : {}),
      },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal,
    });
    diagnose?.("terminal-http-start", {});
    const response = await responsePending;
    diagnose?.("terminal-http-response", { status: response.status });
    if (!response.ok) {
      throw new DaemonTransportError(
        response.status === 404 ? "not-found" : "http-error",
        `Daemon terminal-runtime inventory returned HTTP ${response.status}.`,
        response.status,
      );
    }
    const parsed = TerminalRuntimeInventoryResourceV1SchemaZ.safeParse(await response.json());
    if (!parsed.success) {
      throw new DaemonTransportError(
        "schema-invalid",
        "Daemon terminal-runtime inventory failed validation.",
      );
    }
    requireMatchingPeer(safeTarget.daemon, parsed.data.daemon);
    if (parsed.data.resource.workspaceName !== safeTarget.workspaceName) {
      throw peerMismatch("Terminal-runtime inventory workspace did not match the target.");
    }
    return parsed.data.resource;
  };
  const ensureEventSupervisor = (
    safeTarget: DesktopApplicationShellTarget,
    sessionName: string,
  ): WorkspaceEventSupervisor => {
    const key = `${safeTarget.daemon.instanceId}\0${safeTarget.workspaceName}\0${sessionName}`;
    if (eventSupervisor && supervisorTargetKey === key) return eventSupervisor;
    eventSupervisor?.dispose();
    const socket = createWebSocket(eventSocketUrl(descriptor, "semantic"), {
      headers: dependencies.ownerToken
        ? { Authorization: `Bearer ${dependencies.ownerToken}` }
        : undefined,
    });
    diagnose?.("terminal-event-socket-create", {});
    let supervisor!: WorkspaceEventSupervisor;
    supervisor = createWorkspaceEventSupervisor({
      socket,
      daemon: safeTarget.daemon,
      workspaceName: safeTarget.workspaceName,
      sessionName,
      fetchTerminalRuntimeInventory: (signal) =>
        fetchTerminalRuntimeInventory(safeTarget, sessionName, signal),
      onRetired: () => {
        if (eventSupervisor !== supervisor) return;
        const retiredDuringReconnect = terminalReconnectController !== null;
        cancelTerminalReconnect();
        resetCatalogReadiness();
        eventSupervisor = null;
        supervisorTargetKey = null;
        applicationShellSupervisorConnection = null;
        workspaceCatalogSupervisorConnection = null;
        supervisor.dispose();
        if (
          retainedWorkspaceCatalogInvalidate &&
          retainedWorkspaceCatalogRoute &&
          (!terminalRuntimeEnabled || terminalAuthoritySink === null)
        ) {
          scheduleCatalogOnlyReconnect();
          return;
        }
        if (!terminalRuntimeEnabled || terminalAuthoritySink === null) return;
        const reconnect = (): void => {
          if (!terminalRuntimeEnabled || terminalAuthoritySink === null) return;
          const replacement = ensureEventSupervisor(safeTarget, sessionName);
          const controller = new AbortController();
          terminalReconnectController = controller;
          void replacement
            .prepareTerminalRuntimeInventory(controller.signal)
            .then((prepared) => {
              if (terminalReconnectController === controller) terminalReconnectController = null;
              if (
                !terminalRuntimeEnabled ||
                terminalAuthoritySink === null ||
                eventSupervisor !== replacement
              ) {
                prepared.dispose();
                return;
              }
              const sink = terminalAuthoritySink;
              const shellHandlers = retainedApplicationShellHandlers;
              const shellConnection = shellHandlers
                ? replacement.connectApplicationShell(shellHandlers)
                : null;
              if (shellConnection) applicationShellSupervisorConnection = shellConnection;
              const catalogInvalidate = retainedWorkspaceCatalogInvalidate;
              const catalogSubscriber = retainedWorkspaceCatalogSubscriber;
              const catalogConnection = catalogInvalidate
                ? replacement.connectWorkspaceCatalog(catalogInvalidate)
                : null;
              if (catalogConnection) workspaceCatalogSupervisorConnection = catalogConnection;
              const retryReplacement = (): void => {
                prepared.dispose();
                if (
                  !terminalRuntimeEnabled ||
                  terminalAuthoritySink !== sink ||
                  eventSupervisor !== replacement ||
                  (catalogConnection !== null &&
                    workspaceCatalogSupervisorConnection !== catalogConnection) ||
                  retainedWorkspaceCatalogSubscriber !== catalogSubscriber
                )
                  return;
                catalogConnection?.close();
                if (workspaceCatalogSupervisorConnection === catalogConnection)
                  workspaceCatalogSupervisorConnection = null;
                shellConnection?.close();
                if (applicationShellSupervisorConnection === shellConnection)
                  applicationShellSupervisorConnection = null;
                replacement.dispose();
                eventSupervisor = null;
                supervisorTargetKey = null;
                if (terminalReconnectTimer === null)
                  terminalReconnectTimer = terminalReconnectClock.setTimeout(() => {
                    terminalReconnectTimer = null;
                    reconnect();
                  }, 1_000);
              };
              const commitReplacement = (): void => {
                if (
                  !terminalRuntimeEnabled ||
                  terminalAuthoritySink !== sink ||
                  eventSupervisor !== replacement ||
                  (catalogConnection !== null &&
                    workspaceCatalogSupervisorConnection !== catalogConnection) ||
                  retainedWorkspaceCatalogSubscriber !== catalogSubscriber
                ) {
                  prepared.dispose();
                  return;
                }
                const resource = replacement.adoptTerminalRuntimeInventory(prepared, sink);
                if (resource === null) {
                  retryReplacement();
                  return;
                }
                sink(resource);
                if (retainedWorkspaceCatalogReady?.subscriber === catalogSubscriber)
                  retainedWorkspaceCatalogReady.resolve();
                catalogInvalidate?.();
              };
              if (catalogConnection)
                void catalogConnection.ready.then(commitReplacement, retryReplacement);
              else commitReplacement();
            })
            .catch(() => {
              if (terminalReconnectController === controller) terminalReconnectController = null;
              if (
                !terminalRuntimeEnabled ||
                terminalAuthoritySink === null ||
                eventSupervisor !== replacement
              ) {
                return;
              }
              replacement.dispose();
              if (eventSupervisor !== replacement) return;
              eventSupervisor = null;
              supervisorTargetKey = null;
              applicationShellSupervisorConnection = null;
              terminalReconnectTimer = terminalReconnectClock.setTimeout(() => {
                terminalReconnectTimer = null;
                reconnect();
              }, 1_000);
            });
        };
        if (retiredDuringReconnect) {
          terminalReconnectTimer = terminalReconnectClock.setTimeout(() => {
            terminalReconnectTimer = null;
            reconnect();
          }, 1_000);
        } else {
          queueMicrotask(reconnect);
        }
      },
      ...(diagnose ? { onDiagnostic: diagnose } : {}),
    });
    eventSupervisor = supervisor;
    supervisorTargetKey = key;
    return supervisor;
  };

  const startCatalogOnlyReconnect = (): void => {
    if (terminalRuntimeEnabled || eventSupervisor !== null) return;
    const invalidate = retainedWorkspaceCatalogInvalidate;
    const route = retainedWorkspaceCatalogRoute;
    const subscriber = retainedWorkspaceCatalogSubscriber;
    if (!invalidate || !route || !subscriber) return;
    const replacement = ensureEventSupervisor(route.target, route.sessionName);
    const connection = replacement.connectWorkspaceCatalog(invalidate, {
      terminalFirst: false,
    });
    workspaceCatalogSupervisorConnection = connection;
    void connection.ready.then(
      () => {
        if (
          eventSupervisor !== replacement ||
          workspaceCatalogSupervisorConnection !== connection ||
          retainedWorkspaceCatalogSubscriber !== subscriber
        )
          return;
        catalogReconnectAttempt = 0;
        if (retainedWorkspaceCatalogReady?.subscriber === subscriber)
          retainedWorkspaceCatalogReady.resolve();
        invalidate();
      },
      () => {
        if (
          workspaceCatalogSupervisorConnection !== connection ||
          retainedWorkspaceCatalogSubscriber !== subscriber
        )
          return;
        connection.close();
        workspaceCatalogSupervisorConnection = null;
        if (eventSupervisor === replacement) {
          replacement.dispose();
          eventSupervisor = null;
          supervisorTargetKey = null;
        }
        scheduleCatalogOnlyReconnect();
      },
    );
  };
  scheduleCatalogOnlyReconnect = (): void => {
    if (
      terminalRuntimeEnabled ||
      eventSupervisor !== null ||
      catalogReconnectTimer !== null ||
      !retainedWorkspaceCatalogInvalidate ||
      !retainedWorkspaceCatalogRoute ||
      !retainedWorkspaceCatalogSubscriber
    )
      return;
    const delayMs = Math.min(1_000 * 2 ** catalogReconnectAttempt, 30_000);
    catalogReconnectAttempt += 1;
    catalogReconnectTimer = terminalReconnectClock.setTimeout(() => {
      catalogReconnectTimer = null;
      startCatalogOnlyReconnect();
    }, delayMs);
  };

  const transport: DesktopDaemonTransport & Partial<TerminalFirstDaemonTransport> = {
    validateTarget: validateBoundTarget,

    async fetchApplicationShell(target, signal) {
      const safeTarget = validateBoundTarget(target);
      const sessionName = resolvedSessionName(resolveSessionName, safeTarget.workspaceName);
      if (terminalRuntimeEnabled) {
        await ensureEventSupervisor(safeTarget, sessionName).awaitApplicationShellBarrier(signal);
      }
      let response: Response;
      let negotiatedVersion = applicationShellResourceVersion as
        | typeof APPLICATION_SHELL_RESOURCE_V2_VERSION
        | typeof APPLICATION_SHELL_RESOURCE_V3_VERSION;
      try {
        const request = (version: typeof negotiatedVersion) =>
          fetchImpl(applicationShellUrl(descriptor, sessionName, version), {
            method: "GET",
            headers: {
              accept: "application/json",
              ...(dependencies.ownerToken
                ? { Authorization: `Bearer ${dependencies.ownerToken}` }
                : {}),
            },
            credentials: "omit",
            cache: "no-store",
            redirect: "error",
            signal,
          });
        response = await request(negotiatedVersion);
        if (
          negotiatedVersion === APPLICATION_SHELL_RESOURCE_V3_VERSION &&
          response.status === 400
        ) {
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
      if (terminalRuntimeEnabled) {
        applicationShellSupervisorConnection?.close();
        retainedApplicationShellHandlers = handlers;
        applicationShellSupervisorConnection = ensureEventSupervisor(
          safeTarget,
          sessionName,
        ).connectApplicationShell(handlers);
        let closed = false;
        return {
          close() {
            if (closed) return;
            closed = true;
            if (retainedApplicationShellHandlers === handlers) {
              retainedApplicationShellHandlers = null;
              applicationShellSupervisorConnection?.close();
              applicationShellSupervisorConnection = null;
            }
          },
        };
      }
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
            socket.close(clientInitiatedWebSocketCloseCode(1008), "Daemon identity mismatch");
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
          const acknowledgement = transition.effects.find(
            (effect) => effect.type === "acknowledge-operation",
          );
          if (
            acknowledgement?.type === "acknowledge-operation" &&
            isRelevantFrame(parsed.data, safeTarget.workspaceName, sessionName)
          ) {
            handlers.onOperationAcknowledged?.({
              daemonInstanceId: acknowledgement.daemonInstanceId,
              operationId: acknowledgement.operationId,
              sequence: acknowledgement.sequence,
              revision: parsed.data.revision,
            });
          }
          if (
            parsed.data.sequence > (previousSequence ?? -1) &&
            isRelevantFrame(parsed.data, safeTarget.workspaceName, sessionName)
          ) {
            handlers.onInvalidate();
          }
          return;
        }
        if (parsed.data.type === "interaction.receipt") {
          const transition = advanceResourceReplica(eventReplica, {
            type: "observed",
            daemonInstanceId: safeTarget.daemon.instanceId,
            sequence: parsed.data.sequence,
          });
          eventReplica = transition.state;
          eventReplicas.set(safeTarget.workspaceName, eventReplica);
          if (transition.effects.some((effect) => effect.type === "request-snapshot")) {
            handlers.onInvalidate();
            establishCursor(safeTarget.daemon.instanceId, parsed.data.sequence);
            return;
          }
          if (isRelevantFrame(parsed.data, safeTarget.workspaceName, sessionName)) {
            handlers.onInteractionReceipt?.(parsed.data);
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
    ...(dependencies.terminalRuntimeAuthority
      ? {
          prepareTerminalRuntimeInventory: (
            target: DesktopApplicationShellTarget,
            signal: AbortSignal,
          ) => {
            const safeTarget = validateBoundTarget(target);
            const sessionName = resolvedSessionName(resolveSessionName, safeTarget.workspaceName);
            return ensureEventSupervisor(safeTarget, sessionName).prepareTerminalRuntimeInventory(
              signal,
            );
          },
          adoptTerminalRuntimeInventory: (
            prepared: PreparedTerminalRuntimeInventory,
            onResource: (resource: TerminalRuntimeInventoryProjectionV1) => void,
          ) => {
            if (!terminalRuntimeEnabled) {
              prepared.dispose();
              return null;
            }
            const resource =
              eventSupervisor?.adoptTerminalRuntimeInventory(prepared, onResource) ?? null;
            if (resource !== null) terminalAuthoritySink = onResource;
            if (resource !== null)
              diagnose?.("terminal-capability-adopted", {
                resourceRevision: resource.resourceRevision,
              });
            return resource;
          },
          disposeEventSupervisor: () => {
            cancelTerminalReconnect();
            cancelCatalogReconnect();
            retainedApplicationShellHandlers = null;
            applicationShellSupervisorConnection?.close();
            applicationShellSupervisorConnection = null;
            retainedWorkspaceCatalogInvalidate = null;
            retainedWorkspaceCatalogSubscriber = null;
            retainedWorkspaceCatalogReady = null;
            retainedWorkspaceCatalogRoute = null;
            workspaceCatalogSupervisorConnection?.close();
            workspaceCatalogSupervisorConnection = null;
            eventSupervisor?.dispose();
            eventSupervisor = null;
            supervisorTargetKey = null;
            terminalAuthoritySink = null;
          },
          selectApplicationShellFallback: (reason = "unknown") => {
            terminalRuntimeEnabled = false;
            cancelTerminalReconnect();
            retainedApplicationShellHandlers = null;
            applicationShellSupervisorConnection?.close();
            applicationShellSupervisorConnection = null;
            terminalAuthoritySink = null;
            if (
              retainedWorkspaceCatalogInvalidate &&
              retainedWorkspaceCatalogSubscriber &&
              retainedWorkspaceCatalogRoute
            ) {
              const selectedSupervisor = eventSupervisor;
              const selectedSubscriber = retainedWorkspaceCatalogSubscriber;
              if (selectedSupervisor)
                void selectedSupervisor.selectWorkspaceCatalogOnly().catch(() => {
                  if (
                    eventSupervisor !== selectedSupervisor ||
                    retainedWorkspaceCatalogSubscriber !== selectedSubscriber
                  )
                    return;
                  selectedSupervisor.dispose();
                  eventSupervisor = null;
                  supervisorTargetKey = null;
                  workspaceCatalogSupervisorConnection = null;
                  scheduleCatalogOnlyReconnect();
                });
              else scheduleCatalogOnlyReconnect();
            } else {
              cancelCatalogReconnect();
              retainedWorkspaceCatalogInvalidate = null;
              retainedWorkspaceCatalogSubscriber = null;
              retainedWorkspaceCatalogReady = null;
              retainedWorkspaceCatalogRoute = null;
              workspaceCatalogSupervisorConnection?.close();
              workspaceCatalogSupervisorConnection = null;
              eventSupervisor?.dispose();
              eventSupervisor = null;
              supervisorTargetKey = null;
            }
            diagnose?.("terminal-fallback-selected", { reason });
          },
          refreshTerminalRuntimeInventory: () => eventSupervisor?.refreshTerminalRuntimeInventory(),
          connectWorkspaceCatalog: (
            target: DesktopApplicationShellTarget,
            invalidate: () => void,
            connectionOptions?: { readonly terminalFirst?: boolean },
          ) => {
            const safeTarget = validateBoundTarget(target);
            const sessionName = resolvedSessionName(resolveSessionName, safeTarget.workspaceName);
            cancelCatalogReconnect();
            const subscriber = Object.freeze({});
            workspaceCatalogSupervisorConnection?.close();
            retainedWorkspaceCatalogInvalidate = invalidate;
            retainedWorkspaceCatalogSubscriber = subscriber;
            retainedWorkspaceCatalogRoute = { target: safeTarget, sessionName };
            const terminalFirst = connectionOptions?.terminalFirst ?? terminalRuntimeEnabled;
            const catalogSupervisor = ensureEventSupervisor(safeTarget, sessionName);
            const connection = catalogSupervisor.connectWorkspaceCatalog(invalidate, {
              terminalFirst,
            });
            workspaceCatalogSupervisorConnection = connection;
            retainedWorkspaceCatalogReady = createCatalogReadiness(subscriber);
            void connection.ready.then(
              () => {
                if (
                  retainedWorkspaceCatalogSubscriber !== subscriber ||
                  eventSupervisor !== catalogSupervisor ||
                  workspaceCatalogSupervisorConnection !== connection
                )
                  return;
                catalogReconnectAttempt = 0;
                retainedWorkspaceCatalogReady?.resolve();
              },
              () => {
                if (
                  retainedWorkspaceCatalogSubscriber !== subscriber ||
                  workspaceCatalogSupervisorConnection !== connection
                )
                  return;
                connection.close();
                workspaceCatalogSupervisorConnection = null;
                if (eventSupervisor === catalogSupervisor) {
                  catalogSupervisor.dispose();
                  eventSupervisor = null;
                  supervisorTargetKey = null;
                }
                if (!terminalRuntimeEnabled) scheduleCatalogOnlyReconnect();
              },
            );
            let closed = false;
            return {
              get ready() {
                if (retainedWorkspaceCatalogSubscriber !== subscriber)
                  return Promise.reject(new Error("workspace catalog subscriber retired"));
                return (
                  retainedWorkspaceCatalogReady?.promise ??
                  Promise.reject(new Error("workspace catalog readiness unavailable"))
                );
              },
              close() {
                if (closed) return;
                closed = true;
                if (retainedWorkspaceCatalogSubscriber !== subscriber) return;
                cancelCatalogReconnect();
                retainedWorkspaceCatalogInvalidate = null;
                retainedWorkspaceCatalogSubscriber = null;
                retainedWorkspaceCatalogReady = null;
                retainedWorkspaceCatalogRoute = null;
                workspaceCatalogSupervisorConnection?.close();
                workspaceCatalogSupervisorConnection = null;
              },
            };
          },
        }
      : {}),
  };
  return transport as DesktopDaemonTransport | TerminalFirstDaemonTransport;
}
