import type { BrowserWindow } from "electron";
import type {
  PaneStreamIssueDescriptor,
  TerminalAttachmentIssueDescriptor,
} from "@tmux-ide/contracts";
import { loadSavedMachines } from "../../../packages/daemon/src/lib/saved-machines.ts";
import { EnvironmentConnections } from "./environment-connections.ts";
import { EnvironmentHostIpc } from "./environment-host-ipc.ts";
import type { KnownEnvironmentCatalog } from "./environment-catalog.ts";
import type { DaemonConnectionAuthority } from "./daemon-connection-coordinator.ts";
import type { HostIpcDependencies, HostStreamRelayContext } from "./host-ipc.ts";
import type { startEnvironmentStreamRelay } from "./environment-stream-relay.ts";
import { HOST_IPC } from "./ipc-channels.ts";

type StreamRelay = Awaited<ReturnType<typeof startEnvironmentStreamRelay>>;
type Descriptor = PaneStreamIssueDescriptor | TerminalAttachmentIssueDescriptor;

/** Composes the verified connection, scoped IPC, and stream owners in main. */
export async function createDesktopEnvironmentRuntime(input: {
  catalog: KnownEnvironmentCatalog;
  localAuthority: DaemonConnectionAuthority;
  localStreamOrigin(): string | null;
  host: Omit<HostIpcDependencies, "daemonResources" | "channelScope">;
  relay: StreamRelay;
  savedMachines?: typeof loadSavedMachines;
}) {
  await input.catalog.load();
  const allowed = new Set<string>([input.catalog.localCanonical().id]);
  // The daemon owns this registry. The desktop only imports enabled routes and
  // maintains its own observational identity bookkeeping, never registry writes.
  try {
    for (const machine of (input.savedMachines ?? loadSavedMachines)().machines) {
      if (!machine.enabled) continue;
      const entry = await input.catalog.addSsh(machine.sshTarget, machine.label);
      allowed.add(entry.id);
    }
  } catch {
    // Invalid registry data must not prevent local terminals from opening or
    // turn previously disabled/stale routes into active connection authority.
  }
  const connections = new EnvironmentConnections({
    catalog: input.catalog,
    localAuthority: input.localAuthority,
  });
  const hooks = (scope: string, origin: () => string | null, isCurrent = () => true) => {
    const rewrite = <T extends Descriptor>(descriptor: T, context: HostStreamRelayContext): T => {
      const upstreamOrigin = origin();
      if (!upstreamOrigin || !isCurrent() || !context.isCurrent())
        throw new Error("Terminal environment was retired.");
      return input.relay.register(descriptor, {
        upstreamUrl: `${upstreamOrigin}${new URL(descriptor.webSocketUrl).pathname}`,
        scope,
        renderer: context.hostClientId,
        isCurrent: () => isCurrent() && context.isCurrent(),
      });
    };
    return {
      relayPaneStream: rewrite<PaneStreamIssueDescriptor>,
      relayTerminalAttachment: rewrite<TerminalAttachmentIssueDescriptor>,
      rendererDidRelease: (hostClientId: string) => input.relay.releaseRenderer(hostClientId),
    };
  };
  const scoped = new EnvironmentHostIpc({
    connections,
    host: { ...input.host, readStartupReadiness: undefined, rendererDidBootstrap: undefined },
    streamHooks: (capture, scope) =>
      hooks(scope, () => capture.streamOrigin ?? null, capture.isCurrent),
    onRetireScope: (scope) => input.relay.retireScope(scope),
  });
  let disposed = false;
  const publish = () => {
    const window = input.host.getWindow();
    if (!disposed && window && !window.isDestroyed())
      window.webContents.send(HOST_IPC.environmentChanged);
  };
  const stop = connections.subscribe(publish);
  const requireRemote = (id: string) => {
    if (disposed || !allowed.has(id) || input.catalog.entry(id)?.endpoint.kind !== "ssh")
      throw new Error("Unknown or disabled remote environment.");
  };
  return {
    localHooks: hooks("local", input.localStreamOrigin),
    environments: {
      list: async () => connections.snapshots().filter((entry) => allowed.has(entry.connectionId)),
      open: async (id: string) => {
        requireRemote(id);
        return scoped.open(id);
      },
      disconnect: async (id: string) => {
        requireRemote(id);
        connections.disconnect(id);
      },
    },
    localChanged() {
      input.relay.retireScope("local");
      publish();
    },
    bindWindow(window: BrowserWindow) {
      scoped.bindWindow(window);
    },
    releaseRenderer() {
      scoped.releaseRenderer();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      scoped.dispose();
      connections.dispose();
      await input.catalog.flush();
    },
  };
}
