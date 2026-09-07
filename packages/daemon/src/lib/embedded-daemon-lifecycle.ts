import type { EmbeddedDaemonHandle, EmbeddedDaemonOptions } from "./daemon-embed.ts";
import type { RemoteAccessRestartRequest } from "../command-center/actions/handlers/app-set-remote-access.ts";

/** Stable caller-owned handle across standalone settings restarts. */
export async function startOwnedEmbeddedDaemon(
  options: EmbeddedDaemonOptions,
  start: (options: EmbeddedDaemonOptions) => Promise<EmbeddedDaemonHandle>,
): Promise<EmbeddedDaemonHandle> {
  let closed = false;
  let available = false;
  let current: EmbeddedDaemonHandle;
  let restarting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let pendingRequest: RemoteAccessRestartRequest | null = null;

  const launch = async (nextOptions: EmbeddedDaemonOptions): Promise<EmbeddedDaemonHandle> => {
    const generation: EmbeddedDaemonHandle = await start({
      ...nextOptions,
      requestRestart: (request) => restart(generation, request),
    });
    return generation;
  };
  const restart = (
    generation: EmbeddedDaemonHandle,
    request: RemoteAccessRestartRequest,
  ): Promise<void> => {
    if (closed || generation !== current) return Promise.resolve();
    pendingRequest = { ...request };
    if (restarting) return restarting;
    available = false;
    restarting = Promise.resolve().then(async () => {
      // Failure must leave the replacement unstarted: the old listener or
      // canonical claim may still be owned by this generation.
      while (pendingRequest && !closed) {
        const retiring = current;
        await retiring.stop({ gracefulMs: 500 });
        if (closed) return;
        // Settings changes during retirement supersede the earlier intent.
        // Changes during startup remain queued for the new generation.
        const desired = pendingRequest;
        pendingRequest = null;
        const next = await launch({
          ...options,
          takeoverIfRunning: false,
          restoreTmuxWorkspaces: true,
          port: desired.port ?? retiring.port,
          bindHostname: desired.bindHostname,
          authToken: desired.token,
          localBypassToken: retiring.localBypassToken,
        });
        current = next;
        if (closed) await next.stop();
      }
      available = !closed;
    });
    const operation = restarting;
    void operation
      .finally(() => {
        if (restarting === operation) restarting = null;
      })
      .catch(() => {});
    return operation;
  };

  current = await launch(options);
  available = true;
  return {
    get instanceId() {
      return current.instanceId;
    },
    get pid() {
      return current.pid;
    },
    get port() {
      return current.port;
    },
    get apiBaseUrl() {
      return current.apiBaseUrl;
    },
    get wsUrl() {
      return current.wsUrl;
    },
    get localBypassToken() {
      return current.localBypassToken;
    },
    tmuxAuthorityReplaced: () => current.tmuxAuthorityReplaced?.() ?? Promise.resolve(false),
    compatibilityTerminalAttachmentRuntimeConstructed: () =>
      current.compatibilityTerminalAttachmentRuntimeConstructed(),
    activateProject: (name, activationOptions) => {
      if (closed || !available) return Promise.reject(new Error("Embedded daemon is retiring"));
      return current.activateProject(name, activationOptions);
    },
    stop: (stopOptions) => {
      if (stopping) return stopping;
      closed = true;
      stopping = (async () => {
        try {
          await restarting;
        } finally {
          await current.stop(stopOptions);
        }
      })();
      return stopping;
    },
  };
}
