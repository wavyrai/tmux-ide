import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  type CanonicalDaemonInfo,
  type DesktopApplicationShellTarget,
  type DesktopDaemonHostDescriptor,
  type WorkspaceCatalogResourceV2,
  type WorkspaceCatalogResourceV3,
} from "@tmux-ide/contracts";
import {
  createDirectLoopbackDaemonTransport,
  type DaemonTransportDependencies,
  type TerminalFirstDaemonTransport,
} from "@tmux-ide/daemon-client/direct-application-shell-transport";
import type { PreparedTerminalRuntimeInventory } from "@tmux-ide/daemon-client/workspace-event-supervisor";
import type { WorkspaceClientCatalogPort } from "@tmux-ide/daemon-client/workspace-client-types";
import { WebSocket } from "ws";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import {
  fetchCanonicalLiveWorkspaceRouting,
  workspaceNameForLiveSession,
} from "./canonical-workspace-routing.ts";
import { ensureOpenTuiSessionWorkspace } from "./configless-session-bootstrap.ts";
import {
  createOpenTuiVerifiedRoutingContext,
  type OpenTuiVerifiedRoutingContext,
} from "./open-tui-verified-routing.ts";

/**
 * Generation-bound host capabilities used by the shared WorkspaceClient.
 *
 * This module deliberately has no client-session lifecycle dependency. The
 * production OpenTUI root constructs exactly one shared WorkspaceClient and
 * owns its lifecycle/replay boundary itself.
 */
export interface OpenTuiApplicationShellConnection {
  readonly workspaceName: string;
  /** Incarnation captured by the connection's routing read, never copied from a later catalog. */
  readonly liveSessionId?: string | null;
  readonly target: DesktopApplicationShellTarget;
  readonly transport: TerminalFirstDaemonTransport;
  readonly catalog: WorkspaceClientCatalogPort;
  readonly routing: OpenTuiVerifiedRoutingContext | null;
  /** Terminal-first observer barrier/read. Settled state is one-shot and generation-fenced. */
  prepareTerminalRuntimeInventory(): Promise<PreparedTerminalRuntimeInventory | null>;
  dispose(): void;
}

export interface OpenTuiApplicationShellConnectionDependencies {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly isCanonicalDaemonAlive: (daemon: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetchCanonicalWorkspaceRouting: (
    daemon: CanonicalDaemonInfo,
    request?: typeof fetch,
    signal?: AbortSignal,
  ) => Promise<WorkspaceCatalogResourceV2 | WorkspaceCatalogResourceV3>;
  readonly createTransport: (options: {
    readonly descriptor: DesktopDaemonHostDescriptor;
    readonly workspaceName: string;
    readonly sessionName: string;
    readonly ownerToken?: string;
    readonly applicationShellResourceVersion: typeof APPLICATION_SHELL_RESOURCE_V2_VERSION;
    readonly terminalRuntimeDiagnostic?: DaemonTransportDependencies["terminalRuntimeDiagnostic"];
  }) => TerminalFirstDaemonTransport;
  readonly ensureSessionWorkspace: (sessionName: string) => Promise<boolean>;
  /** Opt-in lifecycle evidence. Ordinary product connections leave this absent. */
  readonly onDiagnostic?: (phase: string, details: Readonly<Record<string, unknown>>) => void;
}

const DEFAULT_DEPENDENCIES: OpenTuiApplicationShellConnectionDependencies = {
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  fetchCanonicalWorkspaceRouting: fetchCanonicalLiveWorkspaceRouting,
  createTransport: ({
    descriptor,
    workspaceName,
    sessionName,
    ownerToken,
    applicationShellResourceVersion,
    terminalRuntimeDiagnostic,
  }) =>
    createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken,
      terminalRuntimeAuthority: true,
      createWebSocket: (url, options) =>
        new WebSocket(url, {
          headers: options?.headers ? { ...options.headers } : undefined,
        }) as unknown as import("@tmux-ide/daemon-client/workspace-event-supervisor").WorkspaceEventSocket,
      applicationShellResourceVersion,
      resolveSessionName: (candidate) => {
        if (candidate !== workspaceName) {
          throw new Error("application-shell transport received another workspace");
        }
        return sessionName;
      },
      ...(terminalRuntimeDiagnostic ? { terminalRuntimeDiagnostic } : {}),
    }) as TerminalFirstDaemonTransport,
  ensureSessionWorkspace: ensureOpenTuiSessionWorkspace,
};

export function openTuiDaemonDescriptor(daemon: CanonicalDaemonInfo): DesktopDaemonHostDescriptor {
  return {
    apiBaseUrl: new URL(canonicalDaemonUrl("http", daemon.bindHostname, daemon.port)).toString(),
    protocolVersion: daemon.protocolVersion,
    productVersion: daemon.productVersion,
    instanceId: daemon.instanceId,
    startedAt: daemon.startedAt,
    ...(daemon.environmentId ? { environmentId: daemon.environmentId } : {}),
  };
}

/** Resolve the canonical daemon transport and verified routing generation. */
export async function resolveOpenTuiApplicationShellConnection(
  sessionName: string,
  overrides: Partial<OpenTuiApplicationShellConnectionDependencies> = {},
): Promise<OpenTuiApplicationShellConnection | null> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const diagnose = dependencies.onDiagnostic
    ? (
        phase: Parameters<NonNullable<typeof dependencies.onDiagnostic>>[0],
        details: Readonly<Record<string, unknown>>,
      ): void => {
        try {
          dependencies.onDiagnostic?.(phase, details);
        } catch {
          // Qualification evidence never owns connection lifecycle.
        }
      }
    : null;
  const daemon = dependencies.readCanonicalDaemonInfo();
  if (!daemon || !(await dependencies.isCanonicalDaemonAlive(daemon))) return null;

  const catalog = await dependencies.fetchCanonicalWorkspaceRouting(daemon);
  if (catalog.daemon.instanceId !== daemon.instanceId) return null;
  const workspaceName = workspaceNameForLiveSession(catalog, sessionName);
  if (!workspaceName) return null;
  const liveSessionId =
    catalog.version === 3
      ? (catalog.liveSessions.find((session) => session.sessionName === sessionName)
          ?.liveSessionId ?? null)
      : null;
  if (catalog.version === 3 && liveSessionId === null) return null;

  const target: DesktopApplicationShellTarget = {
    daemon: {
      protocolVersion: daemon.protocolVersion,
      productVersion: daemon.productVersion,
      instanceId: daemon.instanceId,
      startedAt: daemon.startedAt,
      ...(daemon.environmentId ? { environmentId: daemon.environmentId } : {}),
    },
    workspaceName,
  };
  const baseTransport = dependencies.createTransport({
    descriptor: openTuiDaemonDescriptor(daemon),
    workspaceName,
    sessionName,
    ...(daemon.authToken ? { ownerToken: daemon.authToken } : {}),
    // OpenTUI lays out terminals from the semantic runtime lane and never
    // consumes V3 appWindows. V2 still carries the authenticated,
    // attachability-bearing inventory used to admit that lane.
    applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
    ...(diagnose ? { terminalRuntimeDiagnostic: diagnose } : {}),
  });
  const routing = createOpenTuiVerifiedRoutingContext(daemon, workspaceName, sessionName);
  let disposed = false;
  let diagnosticClientFetchOrdinal = 0;
  let diagnosticPrewarmOrdinal = 0;
  let terminalPreparation: {
    readonly controller: AbortController;
    readonly promise: Promise<PreparedTerminalRuntimeInventory | null>;
  } | null = null;
  const transport: TerminalFirstDaemonTransport = {
    validateTarget: (value) => baseTransport.validateTarget(value),
    connectEvents: (value, handlers) => baseTransport.connectEvents(value, handlers),
    fetchApplicationShell: (value, signal) => {
      baseTransport.validateTarget(value);
      if (signal.aborted) return Promise.reject(signal.reason);
      const request = baseTransport.fetchApplicationShell(value, signal);
      if (diagnose)
        diagnose("application-shell-client-fetch", {
          ordinal: diagnosticClientFetchOrdinal++,
          disposition: "post-resource-barrier",
          daemonGeneration: target.daemon.instanceId,
        });
      return request;
    },
    prepareTerminalRuntimeInventory: (value, signal) =>
      baseTransport.prepareTerminalRuntimeInventory(value, signal),
    adoptTerminalRuntimeInventory: (prepared, onResource) =>
      baseTransport.adoptTerminalRuntimeInventory(prepared, onResource),
    disposeEventSupervisor: () => baseTransport.disposeEventSupervisor(),
    selectApplicationShellFallback: (reason) =>
      baseTransport.selectApplicationShellFallback(reason),
    refreshTerminalRuntimeInventory: () => baseTransport.refreshTerminalRuntimeInventory(),
    connectWorkspaceCatalog: (value, invalidate) =>
      baseTransport.connectWorkspaceCatalog(value, invalidate),
  };
  let catalogEventConnection: ReturnType<
    TerminalFirstDaemonTransport["connectWorkspaceCatalog"]
  > | null = null;
  const awaitCatalogBarrier = (ready: Promise<void>, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      const aborted = (): void => reject(signal.reason);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", aborted, { once: true });
      void ready.then(
        () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", aborted);
          reject(error);
        },
      );
    });
  const catalogPort: WorkspaceClientCatalogPort = {
    async read(value, signal) {
      const safeTarget = transport.validateTarget(value);
      if (
        safeTarget.daemon.instanceId !== target.daemon.instanceId ||
        safeTarget.workspaceName !== target.workspaceName
      )
        throw new Error("WorkspaceClient catalog read escaped its generation target");
      const connection = catalogEventConnection;
      if (!connection) throw new Error("WorkspaceClient catalog read has no event barrier");
      await awaitCatalogBarrier(connection.ready, signal);
      if (signal.aborted) throw signal.reason;
      const resource = await dependencies.fetchCanonicalWorkspaceRouting(daemon, fetch, signal);
      // WorkspaceClient's existing catalog port is V2. Incarnation evidence is
      // retained on the connection, not leaked as an unsupported port version.
      return resource.version === 3
        ? {
            ...resource,
            version: 2,
            liveSessions: resource.liveSessions.map(
              ({ liveSessionId: _liveSessionId, ...session }) => session,
            ),
          }
        : resource;
    },
    subscribe(value, invalidate) {
      const safeTarget = transport.validateTarget(value);
      if (
        safeTarget.daemon.instanceId !== target.daemon.instanceId ||
        safeTarget.workspaceName !== target.workspaceName
      )
        throw new Error("WorkspaceClient catalog subscription escaped its generation target");
      catalogEventConnection?.close();
      const connection = transport.connectWorkspaceCatalog(safeTarget, invalidate);
      catalogEventConnection = connection;
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          if (catalogEventConnection === connection) catalogEventConnection = null;
          connection.close();
        },
      };
    },
  };
  const prepareTerminalRuntimeInventory = (): Promise<PreparedTerminalRuntimeInventory | null> => {
    if (disposed) return Promise.resolve(null);
    if (terminalPreparation) return terminalPreparation.promise;
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(new DOMException("Terminal runtime preparation timed out", "TimeoutError"));
    }, 1_000);
    deadline.unref?.();
    const diagnosticOrdinal = diagnose ? diagnosticPrewarmOrdinal++ : null;
    const request = Promise.resolve().then(() => {
      const preparation = baseTransport.prepareTerminalRuntimeInventory(target, controller.signal);
      diagnose?.("application-shell-prewarm-start", {
        ordinal: diagnosticOrdinal,
        daemonGeneration: target.daemon.instanceId,
      });
      return preparation;
    });
    const promise = request
      .then(
        (value) => {
          diagnose?.("application-shell-prewarm-settled", {
            ordinal: diagnosticOrdinal,
            outcome: "fulfilled",
            resource: "terminal-runtime-inventory",
            daemonGeneration: target.daemon.instanceId,
          });
          return value;
        },
        (error: unknown) => {
          const reason =
            controller.signal.aborted && controller.signal.reason instanceof DOMException
              ? controller.signal.reason.name === "TimeoutError"
                ? "deadline"
                : "retired"
              : error instanceof Error
                ? "preparation-rejected"
                : "unknown";
          // Every failed terminal-first attempt, including the bounded
          // deadline, retires its supervisor before legacy V2 can start.
          baseTransport.selectApplicationShellFallback(reason);
          diagnose?.("application-shell-prewarm-settled", {
            ordinal: diagnosticOrdinal,
            outcome: controller.signal.aborted ? "aborted" : "rejected",
            resource: "terminal-runtime-inventory",
            daemonGeneration: target.daemon.instanceId,
            fallbackReason: reason,
          });
          return null;
        },
      )
      .finally(() => clearTimeout(deadline));
    terminalPreparation = { controller, promise };
    return promise;
  };

  return {
    workspaceName,
    liveSessionId,
    target,
    transport,
    catalog: catalogPort,
    routing,
    prepareTerminalRuntimeInventory,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      terminalPreparation?.controller.abort(
        new DOMException("OpenTUI prepared connection was disposed", "AbortError"),
      );
      terminalPreparation?.promise.then((prepared) => prepared?.dispose()).catch(() => undefined);
      terminalPreparation = null;
      catalogEventConnection?.close();
      catalogEventConnection = null;
      transport.disposeEventSupervisor();
      routing?.retire();
    },
  };
}

/**
 * Prepare the first generation connection once at the session-owner boundary.
 *
 * Every open crosses the idempotent promotion boundary before resolving its
 * route. This is required even when a registry route already exists: registry
 * identity survives a tmux server restart, while the replacement panes do not
 * retain their semantic stamps. Promotion reconciles that exact live inventory
 * without overwriting healthy stamps, after which the connection is resolved
 * against current daemon truth.
 */
export async function prepareOpenTuiApplicationShellConnection(
  sessionName: string,
  overrides: Partial<OpenTuiApplicationShellConnectionDependencies> = {},
): Promise<OpenTuiApplicationShellConnection | null> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  if (!(await dependencies.ensureSessionWorkspace(sessionName))) return null;
  const reconciled = await resolveOpenTuiApplicationShellConnection(sessionName, dependencies);
  if (reconciled) void reconciled.prepareTerminalRuntimeInventory();
  return reconciled;
}
