import { randomUUID } from "node:crypto";
import type { CanonicalDaemonInfo } from "@tmux-ide/contracts";
import {
  DaemonActionInvocationError,
  dispatchOwnerAction,
} from "@tmux-ide/daemon-client/owner-action-client";

import {
  canonicalDaemonUrl,
  isCanonicalDaemonAlive,
  readCanonicalDaemonInfo,
} from "../../lib/canonical-daemon.ts";
import { fetchCanonicalWorkspaceRouting } from "./canonical-workspace-routing.ts";
import { OPEN_TUI_HOST_CLIENT_ID } from "./open-tui-workspace-runtime-port.ts";

export interface OpenTuiSessionBootstrapDependencies {
  readonly readDaemon: () => CanonicalDaemonInfo | null;
  readonly isAlive: (daemon: CanonicalDaemonInfo) => Promise<boolean>;
  readonly fetchRouting: typeof fetchCanonicalWorkspaceRouting;
  readonly request: typeof fetch;
  readonly promote: typeof dispatchOwnerAction;
  readonly createOperationId: () => string;
}

const DEFAULT_DEPENDENCIES: OpenTuiSessionBootstrapDependencies = {
  readDaemon: readCanonicalDaemonInfo,
  isAlive: isCanonicalDaemonAlive,
  fetchRouting: fetchCanonicalWorkspaceRouting,
  request: fetch,
  promote: dispatchOwnerAction,
  createOperationId: randomUUID,
};

export type OpenTuiSessionWorkspaceEnsureResult =
  | {
      readonly status: "ready";
      readonly operationId: string;
      readonly resolution: "promoted" | "recovered";
    }
  | {
      readonly status: "unavailable";
      readonly operationId: string | null;
      readonly reason:
        | "daemon-unavailable"
        | "routing-unavailable"
        | "daemon-generation-changed"
        | "session-unavailable"
        | "promotion-rejected"
        | "promotion-unconfirmed";
      readonly code?: string;
    };

const PROMOTION_MAXIMUM_ATTEMPTS = 4;
const PROMOTION_ATTEMPT_TIMEOUT_MS = 2_500;
const PROMOTION_RETRY_DELAYS_MS = [100, 250, 500] as const;

function hasLiveWorkspaceRoute(
  routing: Awaited<ReturnType<typeof fetchCanonicalWorkspaceRouting>>,
  sessionName: string,
): boolean {
  return routing.intents.some(
    (intent) => intent.sessionName === sessionName && intent.availability === "live",
  );
}

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
  return (await ensureOpenTuiSessionWorkspaceResult(sessionName, overrides)).status === "ready";
}

/**
 * Typed, bounded promotion handshake for one exact live tmux session.
 *
 * Ambiguous transport attempts retain one operation id so the daemon can
 * replay a commit whose first HTTP response was lost. When the session had no
 * route before the request, a fresh generation-fenced catalog route is also a
 * valid recovery receipt. Existing routes cannot serve as that receipt because
 * promotion may still need to repair pane-local semantic stamps.
 */
export async function ensureOpenTuiSessionWorkspaceResult(
  sessionName: string,
  overrides: Partial<OpenTuiSessionBootstrapDependencies> = {},
): Promise<OpenTuiSessionWorkspaceEnsureResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const daemon = dependencies.readDaemon();
  if (!daemon) return { status: "unavailable", operationId: null, reason: "daemon-unavailable" };
  try {
    if (!(await dependencies.isAlive(daemon)))
      return { status: "unavailable", operationId: null, reason: "daemon-unavailable" };
  } catch {
    return { status: "unavailable", operationId: null, reason: "daemon-unavailable" };
  }
  let routing: Awaited<ReturnType<typeof fetchCanonicalWorkspaceRouting>>;
  try {
    routing = await dependencies.fetchRouting(daemon, dependencies.request);
  } catch {
    return { status: "unavailable", operationId: null, reason: "routing-unavailable" };
  }
  if (routing.daemon.instanceId !== daemon.instanceId)
    return {
      status: "unavailable",
      operationId: null,
      reason: "daemon-generation-changed",
    };
  const liveSession = routing.liveSessions.find((session) => session.sessionName === sessionName);
  if (!liveSession)
    return { status: "unavailable", operationId: null, reason: "session-unavailable" };
  const routeExistedBeforePromotion = hasLiveWorkspaceRoute(routing, sessionName);
  const operationId = dependencies.createOperationId();
  // A registry entry outlives the tmux server and can therefore point at a
  // newly re-created session whose panes have none of the old semantic stamps.
  // Promotion is intentionally idempotent: replaying it reconciles missing
  // pane/window stamps without overwriting valid intent. Always pass through
  // that repair boundary instead of treating a routed name as proof that this
  // exact live pane inventory is attachable.
  try {
    const promoted = await dependencies.promote({
      baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
      ownerToken: daemon.authToken ?? "",
      hostClientId: OPEN_TUI_HOST_CLIENT_ID,
      name: "workspace.promote",
      input: { sessionId: liveSession.fleetSessionId },
      operationId,
      timeoutMs: PROMOTION_ATTEMPT_TIMEOUT_MS,
      maximumAttempts: PROMOTION_MAXIMUM_ATTEMPTS,
      retryDelayMs: (completedAttempts) =>
        PROMOTION_RETRY_DELAYS_MS[completedAttempts - 1] ?? PROMOTION_RETRY_DELAYS_MS.at(-1)!,
    });
    if (promoted !== null) return { status: "ready", operationId, resolution: "promoted" };
  } catch (error) {
    if (error instanceof DaemonActionInvocationError)
      return {
        status: "unavailable",
        operationId,
        reason: "promotion-rejected",
        code: error.code,
      };
    return { status: "unavailable", operationId, reason: "promotion-unconfirmed" };
  }

  // If promotion created the route, current catalog truth is a durable receipt
  // even when every HTTP response was lost. A pre-existing route is not enough:
  // the action may still be repairing stamps after a tmux server recreation.
  if (!routeExistedBeforePromotion) {
    try {
      const recovered = await dependencies.fetchRouting(daemon, dependencies.request);
      if (
        recovered.daemon.instanceId === daemon.instanceId &&
        recovered.liveSessions.some(
          (session) =>
            session.sessionName === sessionName &&
            session.fleetSessionId === liveSession.fleetSessionId,
        ) &&
        hasLiveWorkspaceRoute(recovered, sessionName)
      )
        return { status: "ready", operationId, resolution: "recovered" };
      if (recovered.daemon.instanceId !== daemon.instanceId)
        return {
          status: "unavailable",
          operationId,
          reason: "daemon-generation-changed",
        };
    } catch {
      // The typed terminal outcome below distinguishes an unconfirmed commit
      // from a daemon refusal without leaking a fire-and-forget rejection.
    }
  }
  return { status: "unavailable", operationId, reason: "promotion-unconfirmed" };
}
