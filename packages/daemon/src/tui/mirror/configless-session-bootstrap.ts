import { randomUUID } from "node:crypto";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import { dispatchOwnerAction } from "@tmux-ide/daemon-client/owner-action-client";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import {
  fetchCanonicalWorkspaceRouting,
  workspaceNameForLiveSession,
} from "./canonical-workspace-routing.ts";
import { OPEN_TUI_HOST_CLIENT_ID } from "./open-tui-workspace-runtime-port.ts";

export interface OpenTuiSessionBootstrapDependencies {
  readonly readDaemon: () => CanonicalDaemonInfo | null;
  readonly isAlive: (daemon: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetchRouting: typeof fetchCanonicalWorkspaceRouting;
  readonly request: typeof fetch;
  readonly promote: typeof dispatchOwnerAction;
}

const DEFAULT_DEPENDENCIES: OpenTuiSessionBootstrapDependencies = {
  readDaemon: readCanonicalDaemonInfo,
  isAlive: isCanonicalDaemonAlive,
  fetchRouting: fetchCanonicalWorkspaceRouting,
  request: fetch,
  promote: dispatchOwnerAction,
};

/** Daemon-authoritative discovery for the configless Home surface. */
export async function discoverOpenTuiLiveSessions(
  overrides: Partial<OpenTuiSessionBootstrapDependencies> = {},
): Promise<readonly string[]> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const daemon = dependencies.readDaemon();
  if (!daemon || !(await dependencies.isAlive(daemon))) return Object.freeze([]);
  const catalog = await dependencies.fetchRouting(daemon, dependencies.request);
  if (catalog.daemon.instanceId !== daemon.instanceId) return Object.freeze([]);
  return Object.freeze(
    [...new Set(catalog.liveSessions.map(({ sessionName }) => sessionName))].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
}

/**
 * Ensure an ordinary discovered tmux session has a daemon workspace identity.
 * Promotion uses the opaque id paired with the exact trusted routing name;
 * FleetCatalog labels remain display-only and never participate in identity.
 */
export async function ensureOpenTuiSessionWorkspace(
  sessionName: string,
  overrides: Partial<OpenTuiSessionBootstrapDependencies> = {},
): Promise<boolean> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const daemon = dependencies.readDaemon();
  if (!daemon || !(await dependencies.isAlive(daemon))) return false;
  const routing = await dependencies.fetchRouting(daemon, dependencies.request);
  if (routing.daemon.instanceId !== daemon.instanceId) return false;
  const liveSession = routing.liveSessions.find((session) => session.sessionName === sessionName);
  if (!liveSession) return false;
  if (workspaceNameForLiveSession(routing, sessionName)) return true;
  const promoted = await dependencies.promote({
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken ?? "",
    hostClientId: OPEN_TUI_HOST_CLIENT_ID,
    name: "workspace.promote",
    input: { sessionId: liveSession.fleetSessionId },
    operationId: randomUUID(),
  });
  return promoted !== null;
}
