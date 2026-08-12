import {
  APPLICATION_SHELL_RESOURCE_V2_VERSION,
  type CanonicalDaemonInfo,
  type DesktopApplicationShellTarget,
  type DesktopDaemonHostDescriptor,
  type InteractionReceipt,
} from "@tmux-ide/contracts";
import {
  createApplicationShellSession,
  type ApplicationShellSession,
  type ApplicationShellTransport,
} from "@tmux-ide/daemon-client/application-shell-session";
import { createDirectLoopbackDaemonTransport } from "@tmux-ide/daemon-client/direct-application-shell-transport";

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

export interface OpenTuiApplicationShellAuthority {
  readonly workspaceName: string;
  readonly target: DesktopApplicationShellTarget;
  readonly session: ApplicationShellSession;
  readonly routing: OpenTuiVerifiedRoutingContext | null;
  dispose(): void;
}

interface OpenTuiApplicationShellAuthorityDependencies {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly isCanonicalDaemonAlive: (daemon: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetchCanonicalWorkspaceRouting: typeof fetchCanonicalWorkspaceRouting;
  readonly createTransport: (options: {
    readonly descriptor: DesktopDaemonHostDescriptor;
    readonly workspaceName: string;
    readonly sessionName: string;
    readonly ownerToken?: string;
    readonly applicationShellResourceVersion: typeof APPLICATION_SHELL_RESOURCE_V2_VERSION;
  }) => ApplicationShellTransport;
  readonly createSession: typeof createApplicationShellSession;
  readonly onInteractionReceipt?: (receipt: InteractionReceipt) => void;
}

const DEFAULT_DEPENDENCIES: OpenTuiApplicationShellAuthorityDependencies = {
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
  createSession: createApplicationShellSession,
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

/**
 * Attach the OpenTUI semantic lane to the canonical daemon. The control-mode
 * client remains the byte/geometry fast lane; all workspace facts and event
 * recovery come from this shared daemon-client session.
 */
export async function connectOpenTuiApplicationShellAuthority(
  sessionName: string,
  overrides: Partial<OpenTuiApplicationShellAuthorityDependencies> = {},
): Promise<OpenTuiApplicationShellAuthority | null> {
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
    // consumes V3 appWindows. V2 still requires the same authenticated,
    // attachability-bearing terminal inventory used to admit that lane.
    applicationShellResourceVersion: APPLICATION_SHELL_RESOURCE_V2_VERSION,
  });
  const session = dependencies.createSession({
    target,
    transport,
    ...(dependencies.onInteractionReceipt
      ? { onInteractionReceipt: dependencies.onInteractionReceipt }
      : {}),
  });
  const routing = createOpenTuiVerifiedRoutingContext(daemon, workspaceName, sessionName);
  let disposed = false;
  return {
    workspaceName,
    target,
    session,
    routing,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      routing?.retire();
      session.dispose();
    },
  };
}
