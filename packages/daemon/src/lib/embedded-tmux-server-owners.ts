import type { LocalImageOwner } from "../terminal/graphics/local-image-owner.ts";
import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmuxServerPaneStreamPath, type TmuxServerScope } from "@tmux-ide/contracts";
import {
  TmuxServerOwners,
  MAX_TMUX_SERVER_OWNERS,
  isTmuxServerObservation,
  retirementKeepsGeneration,
  type TmuxServerOwnerRetirement,
  type TmuxServerOwnersEvent,
  type TmuxServerProbeResult,
  type TmuxServerRegistration,
} from "./tmux-server-owners.ts";
import { paneStreamCloseForRetirement } from "../terminal/pane-stream/pane-stream-websocket.ts";
import { logger } from "./log.ts";
import type { TrackTeardownStep } from "./daemon-stop-progress.ts";
import {
  createDiagnosedTmuxServerProbe,
  tmuxSelectorSocketPath,
  tmuxServerProcessReplaced,
  tmuxServerSocketPresent,
  unixSocketRefusesConnections,
  readTmuxServerRegistrations,
  writeTmuxServerRegistrations,
} from "./tmux-server-registration.ts";
import { createNativeTmuxServerOwner, type NativeTmuxServerOwner } from "./tmux-server-owner.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import {
  attachPaneStreamWebSocket,
  type PaneStreamWebSocketBoundary,
} from "../server/pane-stream-upgrade.ts";

/** Startup decides once whether the default owner is adopted, so a slow first answer is asked again. */
export const DEFAULT_SERVER_STARTUP_PROBE_ATTEMPTS = 3;

/** How often the background liveness check looks at sockets and server pids (no subprocess). */
export const OWNER_SWEEP_INTERVAL_MS = 2_000;

/** Every owner decision as one structured line: what was retired, kept or built, and why (#840). */
export function logTmuxServerOwnersEvent(event: TmuxServerOwnersEvent): void {
  const { type, ...fields } = event;
  if (type === "owner-kept")
    logger.warn("tmux-server-owners", "probe failed; healthy owner kept", fields);
  else if (type === "owner-retired" && event.trigger === "owners-disposed")
    logger.debug("tmux-server-owners", "owner disposed with its daemon generation", fields);
  else if (type === "owner-retired")
    logger.warn("tmux-server-owners", "owner retired; its streams were closed", fields);
  else if (type === "retirement-unconfirmed")
    logger.warn("tmux-server-owners", "retirement evidence not confirmed; owner kept", fields);
  else if (type === "owner-create-failed")
    logger.warn("tmux-server-owners", "owner could not be built; server stays offline", fields);
  else logger.info("tmux-server-owners", "owner built", fields);
}

/** Adapts the established default owner without duplicating its control clients. */
export async function createEmbeddedTmuxServerOwners(options: {
  readonly localImages?: LocalImageOwner;
  readonly environmentId: string;
  readonly onDefaultScope?: (scope: TmuxServerScope) => Promise<void>;
  readonly defaultAuthority: WorkspacePaneTmuxAuthority;
  readonly defaultGeneration: string;
  readonly expectedDefaultProofDigest: string | null;
  readonly defaultOwner: Omit<NativeTmuxServerOwner, "serverId" | "generation">;
  readonly stateDirectory: string;
  readonly webSocketBaseUrl: string;
  readonly trackTeardown?: TrackTeardownStep;
  /**
   * The set of online servers changed while the daemon runs: one came online,
   * or one was retired. Clients that list servers only when told (the Home
   * view) would otherwise keep showing the old answer.
   */
  readonly onServersChanged?: () => void;
}) {
  const path = join(options.stateDirectory, "tmux-servers.json");
  const persisted = readTmuxServerRegistrations(path);
  const probe = createDiagnosedTmuxServerProbe(options.defaultAuthority.executablePath);
  // A missed answer here would leave the default owner unadopted, and the
  // next server list would then replace it and drop its streams.
  let defaultProbe: TmuxServerProbeResult = null;
  for (let attempt = 1; attempt <= DEFAULT_SERVER_STARTUP_PROBE_ATTEMPTS; attempt += 1) {
    defaultProbe = await probe(options.defaultAuthority.socketSelector);
    if (isTmuxServerObservation(defaultProbe) || defaultProbe?.failure === "no-server") break;
    logger.warn("tmux-server-owners", "default server probe failed at startup", {
      attempt,
      attempts: DEFAULT_SERVER_STARTUP_PROBE_ATTEMPTS,
      ...(defaultProbe ?? { failure: "unknown" }),
    });
  }
  const defaultObservation = isTmuxServerObservation(defaultProbe) ? defaultProbe : null;
  let established = persisted.find(
    (entry) =>
      JSON.stringify(entry.selector) === JSON.stringify(options.defaultAuthority.socketSelector),
  );
  if (!established && defaultObservation) {
    for (const entry of persisted) {
      const observation = await probe(entry.selector);
      if (
        isTmuxServerObservation(observation) &&
        observation.fingerprint === defaultObservation.fingerprint
      ) {
        established = entry;
        break;
      }
    }
  }
  const defaultRegistration: TmuxServerRegistration = established ?? {
    serverId: `tmux-server.${randomUUID().replaceAll("-", "")}`,
    label: "Default",
    selector: options.defaultAuthority.socketSelector,
  };
  let httpServer: Server | null = null;
  const boundaries = new Map<string, PaneStreamWebSocketBoundary>();
  const pending = new Map<string, NativeTmuxServerOwner>();
  const isCurrent = (owner: NativeTmuxServerOwner): boolean => {
    try {
      return (
        owners.current({ serverId: owner.serverId, generation: owner.generation })
          .paneStreamRuntime === owner.paneStreamRuntime
      );
    } catch {
      return false;
    }
  };
  const attachOwner = (route: string, owner: NativeTmuxServerOwner) => {
    pending.set(route, owner);
    if (httpServer)
      boundaries.set(
        route,
        attachPaneStreamWebSocket(httpServer, owner.paneStreamRuntime.coordinator, route, () =>
          isCurrent(owner),
        ),
      );
  };
  let defaultRetired = false;
  let defaultAdopted = false;
  const retireDefault = async (retirement?: TmuxServerOwnerRetirement) => {
    if (defaultRetired) return;
    defaultRetired = true;
    if (retirementKeepsGeneration(retirement))
      logger.warn(
        "tmux-server-owners",
        "default owner retired; legacy default routes now answer 410",
        {
          serverId: defaultRegistration.serverId,
          generation: options.defaultGeneration,
          retirement,
        },
      );
    await options.defaultOwner.dispose(retirement);
  };
  const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe,
    serverSocketPresent: tmuxServerSocketPresent,
    selectorSocketRefuses: (selector) =>
      unixSocketRefusesConnections(tmuxSelectorSocketPath(selector)),
    serverProcessReplaced: tmuxServerProcessReplaced,
    onEvent: (event) => {
      logTmuxServerOwnersEvent(event);
      if (
        event.type === "owner-created" ||
        (event.type === "owner-retired" && event.trigger !== "owners-disposed")
      ) {
        try {
          options.onServersChanged?.();
        } catch {
          /* An announcement never decides ownership. */
        }
      }
    },
    persist: (registrations) => writeTmuxServerRegistrations(path, registrations),
    create: async (registration, scope, observation) => {
      // The default owner was never adopted (or already retired): the native
      // owner about to be built replaces it while the daemon stays up.
      if (registration.serverId === defaultRegistration.serverId)
        await retireDefault("server-replaced");
      const route = tmuxServerPaneStreamPath(scope);
      const owner = await createNativeTmuxServerOwner({
        localImages: options.localImages,
        environmentId: options.environmentId,
        ...scope,
        tmuxAuthority: observation.authority,
        nativeServerIdentity: observation.nativeServerIdentity,
        ...(options.trackTeardown ? { trackTeardown: options.trackTeardown } : {}),
        stateDirectory: join(options.stateDirectory, "server-owners", registration.serverId),
        webSocketUrl: new URL(route, options.webSocketBaseUrl).href,
      });
      attachOwner(route, owner);
      return {
        ...owner,
        dispose: async (retirement?: TmuxServerOwnerRetirement) => {
          const boundary = boundaries.get(route);
          boundaries.delete(route);
          pending.delete(route);
          // The first shutdown call names the close reason; the boundary and
          // the owner then only join it.
          const streamsClosed = owner.paneStreamRuntime.coordinator.shutdown(
            paneStreamCloseForRetirement(retirement),
          );
          streamsClosed.catch(() => undefined);
          try {
            await boundary?.close();
          } finally {
            await owner.dispose(retirement);
          }
        },
      };
    },
  });
  try {
    if (
      defaultObservation &&
      defaultObservation.fingerprint === options.expectedDefaultProofDigest
    ) {
      await options.onDefaultScope?.({
        serverId: defaultRegistration.serverId,
        generation: options.defaultGeneration,
      });
      defaultAdopted = true;
      owners.adopt(
        defaultRegistration,
        { serverId: defaultRegistration.serverId, generation: options.defaultGeneration },
        defaultObservation,
        {
          ...options.defaultOwner,
          serverId: defaultRegistration.serverId,
          generation: options.defaultGeneration,
          dispose: retireDefault,
        },
      );
    }
    if (
      !defaultObservation ||
      defaultObservation.fingerprint !== options.expectedDefaultProofDigest
    )
      await owners.register(defaultRegistration);
    for (const registration of persisted) {
      if (registration.serverId !== defaultRegistration.serverId)
        await owners.register(registration);
    }
    writeTmuxServerRegistrations(path, owners.registrations());
  } catch (error) {
    await Promise.allSettled([owners.dispose(), retireDefault()]);
    throw error;
  }
  const refuseUnknownScope = (request: IncomingMessage, socket: Socket) => {
    const route = (request.url ?? "").split("?", 1)[0]!;
    if (route.startsWith("/v2/tmux-servers/") && !pending.has(route))
      socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
  // Read routes no longer check liveness, so this does. While the adopted
  // default is the only server, its replacement belongs to the embedder's
  // restart adapter (tmuxAuthorityReplaced), which rebuilds the generation.
  const sweepTimer = setInterval(() => {
    if (defaultAdopted && !defaultRetired && owners.list().length <= 1) return;
    void owners.sweep().catch(() => undefined);
  }, OWNER_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  return {
    owners,
    isDefaultCurrent() {
      if (defaultRetired) return false;
      if (
        !defaultObservation ||
        defaultObservation.fingerprint !== options.expectedDefaultProofDigest
      )
        return true;
      try {
        owners.current({
          serverId: defaultRegistration.serverId,
          generation: options.defaultGeneration,
        });
        return true;
      } catch {
        return false;
      }
    },
    attach(server: Server) {
      if (httpServer) throw new Error("Server owner transport already attached");
      httpServer = server;
      server.on("upgrade", refuseUnknownScope);
      server.setMaxListeners(
        Math.max(
          server.getMaxListeners(),
          MAX_TMUX_SERVER_OWNERS + server.listenerCount("upgrade") + 4,
        ),
      );
      for (const [route, owner] of pending)
        boundaries.set(
          route,
          attachPaneStreamWebSocket(server, owner.paneStreamRuntime.coordinator, route, () =>
            isCurrent(owner),
          ),
        );
    },
    async dispose(retirement: "shutdown" | "generation-restart" = "shutdown") {
      clearInterval(sweepTimer);
      httpServer?.off("upgrade", refuseUnknownScope);
      await owners.dispose(retirement);
    },
    /** Legacy default routes remain bound to their original authority; never retarget. */
    get defaultRetired() {
      return defaultRetired;
    },
  };
}
