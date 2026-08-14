import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  type CanonicalDaemonInfo,
  type DesktopApplicationShellTarget,
  type DesktopDaemonHostDescriptor,
} from "@tmux-ide/contracts";
import {
  createDirectLoopbackDaemonTransport,
  type DesktopDaemonTransport,
} from "@tmux-ide/daemon-client/direct-application-shell-transport";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import {
  fetchCanonicalWorkspaceRouting,
  workspaceNameForLiveSession,
} from "./canonical-workspace-routing.ts";
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
  readonly target: DesktopApplicationShellTarget;
  readonly transport: DesktopDaemonTransport;
  readonly routing: OpenTuiVerifiedRoutingContext | null;
  dispose(): void;
}

export interface OpenTuiApplicationShellConnectionDependencies {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly isCanonicalDaemonAlive: (daemon: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetchCanonicalWorkspaceRouting: typeof fetchCanonicalWorkspaceRouting;
  readonly createTransport: (options: {
    readonly descriptor: DesktopDaemonHostDescriptor;
    readonly workspaceName: string;
    readonly sessionName: string;
    readonly ownerToken?: string;
    readonly applicationShellResourceVersion: typeof APPLICATION_SHELL_RESOURCE_V2_VERSION;
  }) => DesktopDaemonTransport;
}

const DEFAULT_DEPENDENCIES: OpenTuiApplicationShellConnectionDependencies = {
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  fetchCanonicalWorkspaceRouting,
  createTransport: ({
    descriptor,
    workspaceName,
    sessionName,
    ownerToken,
    applicationShellResourceVersion,
  }) =>
    createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken,
      applicationShellResourceVersion,
      resolveSessionName: (candidate) => {
        if (candidate !== workspaceName) {
          throw new Error("application-shell transport received another workspace");
        }
        return sessionName;
      },
    }),
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
  const daemon = dependencies.readCanonicalDaemonInfo();
  if (!daemon || !(await dependencies.isCanonicalDaemonAlive(daemon))) return null;

  const catalog = await dependencies.fetchCanonicalWorkspaceRouting(daemon);
  const workspaceName = workspaceNameForLiveSession(catalog, sessionName);
  if (!workspaceName) return null;

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
  const transport = dependencies.createTransport({
    descriptor: openTuiDaemonDescriptor(daemon),
    workspaceName,
    sessionName,
    ...(daemon.authToken ? { ownerToken: daemon.authToken } : {}),
    // OpenTUI lays out terminals from the semantic runtime lane and never
    // consumes V3 appWindows. V2 still carries the authenticated,
    // attachability-bearing inventory used to admit that lane.
    applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
  });
  const routing = createOpenTuiVerifiedRoutingContext(daemon, workspaceName, sessionName);
  let disposed = false;

  return {
    workspaceName,
    target,
    transport,
    routing,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      routing?.retire();
    },
  };
}
