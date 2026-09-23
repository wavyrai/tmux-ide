import type { Server, IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmuxServerPaneStreamPath } from "@tmux-ide/contracts";
import {
  TmuxServerOwners,
  MAX_TMUX_SERVER_OWNERS,
  type TmuxServerRegistration,
} from "./tmux-server-owners.ts";
import {
  createTmuxServerProbe,
  readTmuxServerRegistrations,
  writeTmuxServerRegistrations,
} from "./tmux-server-registration.ts";
import { createNativeTmuxServerOwner, type NativeTmuxServerOwner } from "./tmux-server-owner.ts";
import type { WorkspacePaneTmuxAuthority } from "./workspace-pane-creation.ts";
import {
  attachPaneStreamWebSocket,
  type PaneStreamWebSocketBoundary,
} from "../server/pane-stream-upgrade.ts";

/** Adapts the established default owner without duplicating its control clients. */
export async function createEmbeddedTmuxServerOwners(options: {
  readonly defaultAuthority: WorkspacePaneTmuxAuthority;
  readonly defaultGeneration: string;
  readonly expectedDefaultProofDigest: string | null;
  readonly defaultOwner: Omit<NativeTmuxServerOwner, "serverId" | "generation">;
  readonly stateDirectory: string;
  readonly webSocketBaseUrl: string;
}) {
  const path = join(options.stateDirectory, "tmux-servers.json");
  const persisted = readTmuxServerRegistrations(path);
  const probe = createTmuxServerProbe(options.defaultAuthority.executablePath);
  const defaultObservation = await probe(options.defaultAuthority.socketSelector);
  let established = persisted.find(
    (entry) =>
      JSON.stringify(entry.selector) === JSON.stringify(options.defaultAuthority.socketSelector),
  );
  if (!established && defaultObservation) {
    for (const entry of persisted) {
      const observation = await probe(entry.selector);
      if (observation?.fingerprint === defaultObservation.fingerprint) {
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
  const retireDefault = async () => {
    if (defaultRetired) return;
    defaultRetired = true;
    await options.defaultOwner.dispose();
  };
  const owners = new TmuxServerOwners<NativeTmuxServerOwner>({
    probe,
    persist: (registrations) => writeTmuxServerRegistrations(path, registrations),
    create: async (registration, scope, observation) => {
      if (registration.serverId === defaultRegistration.serverId) await retireDefault();
      const route = tmuxServerPaneStreamPath(scope);
      const owner = await createNativeTmuxServerOwner({
        ...scope,
        tmuxAuthority: observation.authority,
        nativeServerIdentity: observation.nativeServerIdentity,
        stateDirectory: join(options.stateDirectory, "server-owners", registration.serverId),
        webSocketUrl: new URL(route, options.webSocketBaseUrl).href,
      });
      attachOwner(route, owner);
      return {
        ...owner,
        dispose: async () => {
          const boundary = boundaries.get(route);
          boundaries.delete(route);
          pending.delete(route);
          try {
            await boundary?.close();
          } finally {
            await owner.dispose();
          }
        },
      };
    },
  });
  if (defaultObservation && defaultObservation.fingerprint === options.expectedDefaultProofDigest)
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
  try {
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
    await owners.dispose();
    throw error;
  }
  const refuseUnknownScope = (request: IncomingMessage, socket: Socket) => {
    const route = (request.url ?? "").split("?", 1)[0]!;
    if (route.startsWith("/v2/tmux-servers/") && !pending.has(route))
      socket.end("HTTP/1.1 410 Gone\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
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
    async dispose() {
      httpServer?.off("upgrade", refuseUnknownScope);
      await owners.dispose();
    },
    /** Legacy default routes remain bound to their original authority; never retarget. */
    get defaultRetired() {
      return defaultRetired;
    },
  };
}
