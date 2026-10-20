import { createLocalFleetPreferenceOwner } from "./fleet-preferences-owner.ts";
import { createFleetPreferenceLifecycle } from "./fleet-preference-lifecycle.ts";
import { assertFleetSelectionCurrent } from "./fleet-selection-current.ts";
import { createFleetConnectionOwner } from "./fleet-local-owner.ts";
import { createMachineConnectionManager } from "../../../packages/daemon/src/lib/machine-connection-manager.ts";
import type { SavedMachine } from "../../../packages/contracts/src/saved-machines.ts";
import { createNativeFleet, FleetSelectionError } from "./fleet.ts";
import { discoverPreviewDaemon, discoverPreviewHost, localPreviewHostProof } from "./discovery.ts";
import { createRemotePreviewRoute, type RemotePreviewRoute } from "./remote-route.ts";
import type { PreviewHost } from "./config.ts";

/** Production-local fleet composition. Private host-file previews never instantiate this. */
export function createNativeFleetRuntime(changed: () => void, retired: () => void) {
  const manager = createMachineConnectionManager({ createOwner: createFleetConnectionOwner });
  type Fleet = ReturnType<typeof createNativeFleet>;
  let selected: ReturnType<Fleet["select"]> | ReturnType<Fleet["selectServer"]> | null = null;
  let host: PreviewHost | null = null;
  let remote: RemotePreviewRoute | null = null;
  let attempt = new AbortController();
  let stopped = false;
  let started = false;
  const preferences = createFleetPreferenceLifecycle({
    getLocalOwner: createLocalFleetPreferenceOwner(manager),
    changed: () => {
      if (!stopped) fleet.refreshPreferences();
    },
  });
  let stopPreferences = () => {};
  const clear = () => {
    selected = null;
    fleet.setActiveSession(null);
    host = null;
    attempt.abort();
    attempt = new AbortController();
    remote?.dispose();
    remote = null;
  };
  const invalidate = () => {
    if (!selected || stopped) return;
    clear();
    retired();
  };
  const fleet = createNativeFleet(
    manager,
    () => {
      if (stopped) return;
      if (selected) {
        try {
          assertFleetSelectionCurrent(selected, selectedServer() !== null);
        } catch {
          invalidate();
        }
      }
      changed();
    },
    undefined,
    undefined,
    preferences.preferences,
  );
  const selectedServer = () => {
    if (!selected) return null;
    try {
      selected.assertCurrent();
    } catch {
      return null;
    }
    const scope = "descriptor" in selected ? selected.descriptor : selected.session.server;
    if (!scope) return null;
    const group = fleet.publication().groups.find((group) => group.id === selected!.handle.id);
    const server = group?.servers.find(
      (server) =>
        server.id === scope.serverId &&
        server.generation === scope.generation &&
        server.state === "online" &&
        server.selection,
    );
    return group && server && server.generation
      ? {
          machineId: group.id,
          machineLabel: group.label,
          serverId: server.id,
          generation: server.generation,
          label: server.label,
        }
      : null;
  };
  const connect = async (selection: NonNullable<typeof selected>) => {
    selected = selection;
    fleet.setActiveSession("session" in selection ? selection.session.id : null);
    const signal = attempt.signal;
    const check = () => {
      if (stopped || selected !== selection || signal.aborted) throw new FleetSelectionError();
      selection.assertCurrent();
    };
    const scope =
      "session" in selection
        ? selection.session.server
        : {
            serverId: selection.descriptor.serverId,
            generation: selection.descriptor.generation,
          };
    try {
      let discovered: PreviewHost;
      if (selection.handle.kind === "local") {
        if ("descriptor" in selection) {
          const observed = await discoverPreviewDaemon();
          check();
          const expected = selection.handle.read();
          if (
            !expected ||
            expected.instanceId !== observed.instanceId ||
            expected.startedAt !== observed.startedAt ||
            expected.authToken !== observed.authToken
          )
            throw new FleetSelectionError();
        }
        discovered = await discoverPreviewHost(undefined, undefined, scope);
        if (
          "descriptor" in selection &&
          discovered.ownerToken !== selection.handle.read()?.authToken
        )
          throw new FleetSelectionError();
      } else {
        const route = await createRemotePreviewRoute(
          {
            endpoint: selection.handle.endpoint,
            observe: selection.handle.observe,
            observeConnection: manager.subscribe,
          },
          {
            signal,
            scope,
            diagnostic: (reason) => process.stderr.write(`TMUX_GPUI_ROUTE ${reason}\n`),
          },
        );
        try {
          check();
        } catch (error) {
          route.dispose();
          throw error;
        }
        remote = route;
        route.signal.addEventListener("abort", invalidate, { once: true });
        discovered = route.host;
      }
      check();
      host = discovered;
      return discovered;
    } catch (error) {
      if (selected === selection) clear();
      throw error;
    }
  };
  const attachmentKey = (config: PreviewHost & { liveSessionId: string }) => {
    if (stopped) return null;
    if (selected && host && "session" in selected) {
      try {
        selected.assertCurrent();
      } catch {
        return null;
      }
      if (
        host.baseUrl !== config.baseUrl ||
        host.ownerToken !== config.ownerToken ||
        host.scope.serverId !== config.scope.serverId ||
        host.scope.generation !== config.scope.generation ||
        selected.session.liveSessionId !== config.liveSessionId
      )
        return null;
      return fleet.canonicalKey(
        selected.handle.id,
        config.scope.serverId,
        config.scope.generation,
        config.liveSessionId,
      );
    }
    const local = manager.getMachine("local"),
      info = local?.read();
    if (
      !local ||
      local.kind !== "local" ||
      local.endpoint().state !== "ready" ||
      !info ||
      config.remoteSocketOrigin ||
      config.ownerToken !== info.authToken
    )
      return null;
    const origin = new URL(config.baseUrl);
    if (
      origin.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
      Number(origin.port) !== info.port
    )
      return null;
    return fleet.canonicalKey(
      local.id,
      config.scope.serverId,
      config.scope.generation,
      config.liveSessionId,
    );
  };
  return {
    start: () => {
      if (stopped || started) return;
      started = true;
      fleet.start();
      stopPreferences = manager.subscribe(preferences.observe);
      preferences.observe();
    },
    refreshPreferences: preferences.refresh,
    preferenceSnapshot: preferences.preferences.snapshot,
    recordVisit: preferences.preferences.recordVisit,
    resolveCanonical: fleet.resolveCanonical,
    recoveryRoute: fleet.recoveryRoute,
    retainedTarget: fleet.retainedTarget,
    retainedFrameProof: fleet.retainedFrameProof,
    tabObservation: fleet.tabObservation,
    attachmentKey,
    isSelectedAgent(
      row: import("../../../packages/presentation/src/home-agent-roster.ts").HomeAgentRow,
      config: PreviewHost & { liveSessionId: string; semanticPaneId: string },
    ) {
      if (
        !row.machineId ||
        !row.server ||
        row.paneId !== config.semanticPaneId ||
        row.liveSessionId !== config.liveSessionId ||
        row.server.serverId !== config.scope.serverId ||
        row.server.generation !== config.scope.generation
      )
        return false;
      const key = fleet.canonicalKey(
        row.machineId,
        row.server.serverId,
        row.server.generation,
        row.liveSessionId,
      );
      return key !== null && key === attachmentKey(config);
    },
    async selectCanonical(key: string) {
      clear();
      const selection = fleet.selectCanonical(key);
      return {
        host: await connect(selection),
        sessionId: selection.session.liveSessionId!,
        session: selection.session,
      };
    },
    preferenceCommand: fleet.preferenceCommand,
    publication: fleet.publication,
    observeAgents: fleet.observeAgents,
    observeWorkspaceAgents: fleet.observeWorkspaceAgents,
    observePaletteAgents: fleet.observePaletteAgents,
    observeHomeAgents: fleet.observeHomeAgents,
    filterHomeAgents: fleet.filterHomeAgents,
    recoverAgents: fleet.recoverAgents,
    resolveAgent: fleet.resolveAgent,
    retry: fleet.retry,
    disconnect: fleet.disconnect,
    reconcile: (profiles: readonly SavedMachine[]) => manager.reconcile(profiles),
    clearSelection: clear,
    async select(token: string) {
      clear();
      const selection = fleet.select(token);
      const host = await connect(selection);
      return { host, sessionId: selection.session.liveSessionId!, session: selection.session };
    },
    async selectServer(token: string) {
      clear();
      const selection = fleet.selectServer(token);
      return { host: await connect(selection), descriptor: selection.descriptor };
    },
    selectedServer,
    assertCurrent() {
      if (!selected || !host) throw new FleetSelectionError();
      assertFleetSelectionCurrent(selected, selectedServer() !== null, true);
    },
    async read() {
      const selection = selected;
      const captured = host;
      const signal = attempt.signal;
      if (!selection || !captured) throw new FleetSelectionError();
      const check = () => {
        if (stopped || selected !== selection || signal.aborted) throw new FleetSelectionError();
        try {
          selection.assertCurrent();
        } catch {
          // Server-route guards expose no public error type or private details.
          throw new FleetSelectionError();
        }
      };
      check();
      try {
        if (remote) await remote.verify();
        else await localPreviewHostProof(captured)?.verify(signal);
      } catch (error) {
        // Retirement can abort verification before its normal post-await fence.
        // Only our captured route lifetime qualifies this fixed guidance.
        check();
        localPreviewHostProof(captured)?.assertCurrent();
        throw error;
      }
      check();
      return captured;
    },
    dispose() {
      if (stopped) return;
      stopped = true;
      clear();
      stopPreferences();
      preferences.dispose();
      fleet.dispose();
      manager.dispose();
    },
  };
}
