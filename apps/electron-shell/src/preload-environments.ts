import {
  DesktopEnvironmentConnectionIdSchemaZ,
  DesktopEnvironmentListSchemaZ,
  DesktopEnvironmentOpenWireResultSchemaZ,
  DesktopHostBootstrapSchemaZ,
  type DesktopEnvironmentConnection,
  type HostCapabilities,
} from "@tmux-ide/contracts";
import { HOST_IPC, scopedHostChannel } from "./ipc-channels.ts";
import { createPreloadDaemonBridge, type PreloadDaemonIpc } from "./preload-daemon.ts";

/** Public opaque-ID facade; native authority scope stays private to preload. */
export function createPreloadEnvironments(ipc: PreloadDaemonIpc) {
  let disposed = false;
  const epochs = new Map<string, number>();
  const openTickets = new Map<string, number>();
  const committedTickets = new Map<string, number>();
  const scopes = new Map<
    string,
    { connectionId: string; facade: DesktopEnvironmentConnection; dispose: () => void }
  >();
  const listeners = new Set<() => void>();
  const assertLive = () => {
    if (disposed) throw new Error("Environment bridge is disposed.");
  };
  const receive = () => {
    if (disposed) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Isolate application listeners. */
      }
    }
  };
  ipc.on(HOST_IPC.environmentChanged, receive);
  const retireConnection = (connectionId: string) => {
    for (const entry of scopes.values()) if (entry.connectionId === connectionId) entry.dispose();
  };
  const environments: NonNullable<HostCapabilities["environments"]> = Object.freeze({
    async list() {
      assertLive();
      const result = DesktopEnvironmentListSchemaZ.parse(
        await ipc.invoke(HOST_IPC.environmentList),
      );
      assertLive();
      return result;
    },
    async open(connectionId: string) {
      assertLive();
      const id = DesktopEnvironmentConnectionIdSchemaZ.parse(connectionId);
      const epoch = epochs.get(id) ?? 0;
      const ticket = (openTickets.get(id) ?? 0) + 1;
      openTickets.set(id, ticket);
      const result = DesktopEnvironmentOpenWireResultSchemaZ.parse(
        await ipc.invoke(HOST_IPC.environmentOpen, id),
      );
      assertLive();
      if ((epochs.get(id) ?? 0) !== epoch)
        throw new Error("Environment open was superseded by disconnect.");
      if (result.connectionId !== id) throw new Error("Environment connection identity mismatch.");
      const cached = scopes.get(result.scope);
      if (cached) {
        if (cached.connectionId !== id)
          throw new Error("Environment authority scope identity mismatch.");
        committedTickets.set(id, Math.max(committedTickets.get(id) ?? 0, ticket));
        return cached.facade;
      }
      if (ticket < (committedTickets.get(id) ?? 0))
        throw new Error("Environment open was superseded.");
      const bridge = createPreloadDaemonBridge(ipc, result.scope);
      committedTickets.set(id, ticket);
      // A replacement scope retires only this connection's older authority.
      retireConnection(id);
      let active = true;
      const dispose = () => {
        if (!active) return;
        active = false;
        bridge.dispose();
        scopes.delete(result.scope);
      };
      const facade: DesktopEnvironmentConnection = Object.freeze({
        async bootstrap() {
          assertLive();
          if (!active) throw new Error("Environment connection is disposed.");
          const value = DesktopHostBootstrapSchemaZ.parse(
            await ipc.invoke(scopedHostChannel(result.scope, HOST_IPC.bootstrap)),
          );
          assertLive();
          if (!active) throw new Error("Environment connection is disposed.");
          return value;
        },
        daemon: bridge.daemon,
        dispose,
      });
      scopes.set(result.scope, { connectionId: id, facade, dispose });
      return facade;
    },
    async disconnect(connectionId: string) {
      assertLive();
      const id = DesktopEnvironmentConnectionIdSchemaZ.parse(connectionId);
      epochs.set(id, (epochs.get(id) ?? 0) + 1);
      retireConnection(id);
      const result = await ipc.invoke(HOST_IPC.environmentDisconnect, id);
      if (result !== undefined) throw new Error("Invalid environment disconnect response.");
    },
    onChanged(listener: () => void) {
      assertLive();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  return Object.freeze({
    environments,
    dispose() {
      if (disposed) return;
      disposed = true;
      ipc.removeListener(HOST_IPC.environmentChanged, receive);
      listeners.clear();
      for (const entry of scopes.values()) entry.dispose();
      scopes.clear();
    },
  });
}
