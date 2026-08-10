import type {
  CanonicalDaemonInfo,
  DesktopApplicationShellTarget,
  DesktopDaemonHostDescriptor,
  InteractionReceipt,
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
  fetchCanonicalWorkspaceCatalog,
  workspaceNameForSession,
} from "./canonical-workspace-routing.ts";

export interface OpenTuiApplicationShellAuthority {
  readonly workspaceName: string;
  readonly target: DesktopApplicationShellTarget;
  readonly session: ApplicationShellSession;
}

interface OpenTuiApplicationShellAuthorityDependencies {
  readonly readCanonicalDaemonInfo: () => CanonicalDaemonInfo | null;
  readonly isCanonicalDaemonAlive: (daemon: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetchCanonicalWorkspaceCatalog: typeof fetchCanonicalWorkspaceCatalog;
  readonly createTransport: (options: {
    readonly descriptor: DesktopDaemonHostDescriptor;
    readonly workspaceName: string;
    readonly sessionName: string;
    readonly ownerToken?: string;
  }) => ApplicationShellTransport;
  readonly createSession: typeof createApplicationShellSession;
  readonly onInteractionReceipt?: (receipt: InteractionReceipt) => void;
}

const DEFAULT_DEPENDENCIES: OpenTuiApplicationShellAuthorityDependencies = {
  readCanonicalDaemonInfo,
  isCanonicalDaemonAlive,
  fetchCanonicalWorkspaceCatalog,
  createTransport: ({ descriptor, workspaceName, sessionName, ownerToken }) =>
    createDirectLoopbackDaemonTransport({
      descriptor,
      ownerToken,
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
  const catalog = await dependencies.fetchCanonicalWorkspaceCatalog(daemon);
  const workspaceName = workspaceNameForSession(catalog, sessionName);
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
  });
  return {
    workspaceName,
    target,
    session: dependencies.createSession({
      target,
      transport,
      ...(dependencies.onInteractionReceipt
        ? { onInteractionReceipt: dependencies.onInteractionReceipt }
        : {}),
    }),
  };
}
