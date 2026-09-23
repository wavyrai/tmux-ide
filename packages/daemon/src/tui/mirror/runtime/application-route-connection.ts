import {
  listTmuxServers,
  createTmuxServerClient,
} from "@tmux-ide/daemon-client/tmux-server-client";
import { canonicalDaemonUrl } from "../../../lib/canonical-daemon.ts";
import type { TmuxServerScope } from "@tmux-ide/contracts";
import { fetchCanonicalLiveWorkspaceRouting } from "../canonical-workspace-routing.ts";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";
import { prepareOpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import { ensureOpenTuiSessionWorkspaceResult } from "../configless-session-bootstrap.ts";

/** Every retained tab gets this fixed route, including promotion and reconnect paths. */
export function applicationRouteConnection(
  handle: ApplicationMachineAuthorityHandle,
  expectedLiveSessionId?: string,
  onDiagnostic?: (phase: string, details: Readonly<Record<string, unknown>>) => void,
  server?: TmuxServerScope,
) {
  let rootInstanceId = handle.read()?.instanceId;
  let selectedServer = server;
  let refresh: { root: string; promise: Promise<TmuxServerScope> } | null = null;
  const refreshAfterDaemonReplacement = async (nextRoot: string): Promise<TmuxServerScope> => {
    if (!selectedServer) throw new Error("Select the server session again");
    if (rootInstanceId === nextRoot) return selectedServer;
    if (!expectedLiveSessionId) throw new Error("Select the server session again");
    if (refresh?.root === nextRoot) return refresh.promise;
    const stableServerId = selectedServer.serverId;
    const promise = (async () => {
      const daemon = handle.read();
      const epoch = handle.endpoint()?.epoch;
      if (!daemon?.authToken || daemon.instanceId !== nextRoot)
        throw new Error("Daemon changed during reconnect");
      const options = {
        baseUrl: canonicalDaemonUrl("http", daemon.bindHostname, daemon.port),
        ownerToken: daemon.authToken,
        hostClientId: `opentui-reconnect:${process.pid}`,
        origin: "tmux-ide://opentui",
      };
      const catalog = await listTmuxServers(options);
      const descriptor = catalog.servers.find((candidate) => candidate.serverId === stableServerId);
      if (!descriptor || descriptor.state !== "online")
        throw new Error("Selected tmux server is unavailable");
      const scope = { serverId: descriptor.serverId, generation: descriptor.generation };
      const client = createTmuxServerClient(options, scope);
      try {
        const sessions = await client.sessions();
        if (!sessions.sessions.some((session) => session.liveSessionId === expectedLiveSessionId))
          throw new Error("Selected tmux session was replaced");
      } finally {
        client.dispose();
      }
      if (handle.read()?.instanceId !== nextRoot || handle.endpoint()?.epoch !== epoch)
        throw new Error("Daemon changed during reconnect");
      rootInstanceId = nextRoot;
      selectedServer = scope;
      return scope;
    })();
    refresh = { root: nextRoot, promise };
    try {
      return await promise;
    } finally {
      if (refresh?.promise === promise) refresh = null;
    }
  };
  return {
    readDaemon: handle.read,
    observeCanonicalGeneration: server
      ? async (listener: (generation: string | null) => void) => {
          let stopped = false;
          let revision = 0;
          const stop = await handle.observe((generation) => {
            const token = ++revision;
            if (!generation) {
              listener(null);
              return;
            }
            if (generation === rootInstanceId) {
              listener(selectedServer!.generation);
              return;
            }
            // Retire old input before reading the replacement daemon's registration.
            listener(null);
            void refreshAfterDaemonReplacement(generation).then(
              (scope) => {
                if (!stopped && token === revision && handle.read()?.instanceId === generation)
                  listener(scope.generation);
              },
              () => {
                if (!stopped && token === revision) listener(null);
              },
            );
          });
          return () => {
            stopped = true;
            revision++;
            stop();
          };
        }
      : handle.observe,
    resolveConnection: async (sessionName: string) => {
      if (selectedServer) {
        const currentRoot = handle.read()?.instanceId;
        if (!currentRoot) return null;
        await refreshAfterDaemonReplacement(currentRoot);
      }
      const connection = await prepareOpenTuiApplicationShellConnection(sessionName, {
        ...(onDiagnostic ? { onDiagnostic } : {}),
        ...(selectedServer ? { server: selectedServer, expectedLiveSessionId } : {}),
        readCanonicalDaemonInfo: handle.read,
        readDaemonEndpoint: handle.endpoint,
        isCanonicalDaemonAlive: handle.isAlive,
        ensureSessionWorkspace: (name) =>
          ensureOpenTuiSessionWorkspaceResult(name, {
            readDaemon: handle.read,
            isAlive: handle.isAlive,
            ...(expectedLiveSessionId
              ? {
                  fetchRouting: async (daemon, request, signal) => {
                    const catalog = await fetchCanonicalLiveWorkspaceRouting(
                      daemon,
                      request,
                      signal,
                    );
                    if (
                      !catalog.liveSessions.some(
                        (s) => s.sessionName === name && s.liveSessionId === expectedLiveSessionId,
                      )
                    )
                      throw new Error("Tab session was replaced");
                    return { ...catalog, version: 2 as const };
                  },
                }
              : {}),
          }),
      });
      if (
        connection &&
        expectedLiveSessionId &&
        connection.liveSessionId !== expectedLiveSessionId
      ) {
        connection.dispose();
        return null;
      }
      return connection;
    },
  };
}
