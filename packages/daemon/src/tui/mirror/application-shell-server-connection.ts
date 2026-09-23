import type { DesktopApplicationShellTarget } from "@tmux-ide/contracts";
import { createTmuxServerClient } from "@tmux-ide/daemon-client/tmux-server-client";
import {
  createScopedTmuxServerTransport,
  createScopedTmuxServerCatalogPort,
  createScopedTmuxServerOwnerActions,
} from "@tmux-ide/daemon-client/scoped-tmux-server-transport";
import { canonicalDaemonUrl } from "../../lib/canonical-daemon.ts";
import type {
  OpenTuiApplicationShellConnection,
  OpenTuiApplicationShellConnectionDependencies,
} from "./application-shell-daemon-connection.ts";
import { createOpenTuiVerifiedRoutingContext } from "./open-tui-verified-routing.ts";
import { OPEN_TUI_HOST_CLIENT_ID } from "./open-tui-workspace-runtime-port.ts";
import { OpenTuiStartupError } from "./startup-failure.ts";

/** A selected registration never falls through to a name-only/default-server route. */
export async function prepareScopedOpenTuiConnection(
  sessionName: string,
  dependencies: OpenTuiApplicationShellConnectionDependencies,
  prepareDefault: () => Promise<OpenTuiApplicationShellConnection | null>,
): Promise<OpenTuiApplicationShellConnection | null> {
  const scope = dependencies.server!;
  const daemon = dependencies.readCanonicalDaemonInfo();
  if (!daemon || !daemon.authToken || !(await dependencies.isCanonicalDaemonAlive(daemon)))
    throw new OpenTuiStartupError({ reason: "daemon-unavailable" });
  const clientOptions = {
    baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
    ownerToken: daemon.authToken,
    hostClientId: OPEN_TUI_HOST_CLIENT_ID,
    origin: "tmux-ide://opentui",
  };
  const client = createTmuxServerClient(clientOptions, scope);
  try {
    const catalog = await client.sessions();
    const candidates = catalog.sessions.filter(
      (session) =>
        session.sessionName === sessionName &&
        (!dependencies.expectedLiveSessionId ||
          session.liveSessionId === dependencies.expectedLiveSessionId),
    );
    if (candidates.length !== 1) throw new OpenTuiStartupError({ reason: "session-unavailable" });
    const liveSessionId = candidates[0]!.liveSessionId;
    // The borrowed default owner has the daemon's original generation. Its existing
    // transport preserves the full app surface while the scoped read proves routing.
    if (scope.generation === daemon.instanceId) {
      const connection = await prepareDefault();
      if (!connection || connection.liveSessionId !== liveSessionId) {
        connection?.dispose();
        throw new OpenTuiStartupError({ reason: "session-unavailable" });
      }
      try {
        const current = await client.sessions();
        if (
          !current.sessions.some(
            (session) =>
              session.liveSessionId === liveSessionId && session.sessionName === sessionName,
          )
        )
          throw new OpenTuiStartupError({ reason: "session-unavailable" });
        const options = {
          clientOptions,
          scope,
          target: connection.target,
          sessionName,
          liveSessionId,
        };
        const routing = createOpenTuiVerifiedRoutingContext(
          daemon,
          connection.workspaceName,
          sessionName,
          undefined,
          dependencies.readDaemonEndpoint,
          scope,
          liveSessionId,
        );
        connection.routing?.retire();
        return {
          ...connection,
          server: scope,
          routing,
          ownerActions: createScopedTmuxServerOwnerActions(options, connection.transport),
          dispose() {
            routing?.retire();
            connection.dispose();
          },
        };
      } catch (error) {
        connection.dispose();
        throw error;
      }
    }
    const opened = await client.openSession(liveSessionId);
    if (opened.liveSessionId !== liveSessionId)
      throw new OpenTuiStartupError({ reason: "session-unavailable" });
    const workspaceName = opened.workspaceName;
    const target: DesktopApplicationShellTarget = {
      daemon: {
        protocolVersion: daemon.protocolVersion,
        productVersion: daemon.productVersion,
        instanceId: scope.generation,
        startedAt: daemon.startedAt,
        ...(daemon.environmentId ? { environmentId: daemon.environmentId } : {}),
      },
      workspaceName,
    };
    const options = { clientOptions, scope, target, sessionName, liveSessionId };
    const transport = createScopedTmuxServerTransport(options);
    const routing = createOpenTuiVerifiedRoutingContext(
      daemon,
      workspaceName,
      sessionName,
      undefined,
      dependencies.readDaemonEndpoint,
      scope,
      liveSessionId,
    );
    const controller = new AbortController();
    let preparation: ReturnType<
      OpenTuiApplicationShellConnection["prepareTerminalRuntimeInventory"]
    > | null = null;
    return {
      workspaceName,
      liveSessionId,
      target,
      server: scope,
      transport,
      routing,
      catalog: createScopedTmuxServerCatalogPort(options, transport),
      ownerActions: createScopedTmuxServerOwnerActions(options, transport),
      prepareTerminalRuntimeInventory() {
        preparation ??= transport
          .prepareTerminalRuntimeInventory(
            target,
            AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
          )
          .catch(() => {
            // Fallback remains inside this owner; never use the legacy default resource.
            transport.selectApplicationShellFallback("preparation-rejected");
            return null;
          });
        return preparation;
      },
      dispose() {
        controller.abort(new DOMException("Selected server connection retired", "AbortError"));
        void preparation?.then((prepared) => prepared?.dispose()).catch(() => undefined);
        transport.disposeEventSupervisor();
        routing?.retire();
      },
    };
  } finally {
    client.dispose();
  }
}
