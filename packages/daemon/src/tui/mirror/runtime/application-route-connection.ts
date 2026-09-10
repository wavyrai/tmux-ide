import { fetchCanonicalLiveWorkspaceRouting } from "../canonical-workspace-routing.ts";
import type { ApplicationMachineAuthorityHandle } from "./application-machine-authority.ts";
import { prepareOpenTuiApplicationShellConnection } from "../application-shell-daemon-connection.ts";
import { ensureOpenTuiSessionWorkspace } from "../configless-session-bootstrap.ts";

/** Every retained tab gets this fixed route, including promotion and reconnect paths. */
export function applicationRouteConnection(
  handle: ApplicationMachineAuthorityHandle,
  expectedLiveSessionId?: string,
  onDiagnostic?: (phase: string, details: Readonly<Record<string, unknown>>) => void,
) {
  return {
    readDaemon: handle.read,
    observeCanonicalGeneration: handle.observe,
    resolveConnection: async (sessionName: string) => {
      const connection = await prepareOpenTuiApplicationShellConnection(sessionName, {
        ...(onDiagnostic ? { onDiagnostic } : {}),
        readCanonicalDaemonInfo: handle.read,
        isCanonicalDaemonAlive: handle.isAlive,
        ensureSessionWorkspace: (name) =>
          ensureOpenTuiSessionWorkspace(name, {
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
