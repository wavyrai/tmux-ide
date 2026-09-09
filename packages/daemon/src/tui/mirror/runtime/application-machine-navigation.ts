import {
  createApplicationMachineAgents,
  type ApplicationMachineAgent,
} from "./application-machine-agents.ts";
import { createSignal, onCleanup } from "solid-js";
import { applicationMachineAuthorityManager as manager } from "./application-machine-authority.ts";
import { createApplicationMachineCatalog } from "./application-machine-catalog.ts";
import { ephemeralMachineProfile } from "./application-machine-startup.ts";
import type { ApplicationMachineSidebarModel } from "./application-machine-sidebar.tsx";

export function createApplicationMachineNavigation(options: {
  resetWorkspace(machineId: string): void;
  openAgent?(agent: ApplicationMachineAgent, source: "keyboard" | "mouse"): Promise<unknown> | void;
  cancelOpen(): void;
  openSession(name: string, source: "keyboard" | "mouse"): Promise<unknown>;
  sessionName(): string | null;
  activePaneId?(): string | null;
  setSurface(value: "home" | "terminals"): void;
  setNote(value: string | null): void;
}) {
  const catalog = createApplicationMachineCatalog();
  const agents = createApplicationMachineAgents({ catalog });
  const [agentGroups, setAgentGroups] = createSignal(agents.getSnapshot());
  const stopAgents = agents.subscribe(setAgentGroups);
  const [snapshot, setSnapshot] = createSignal(catalog.getSnapshot());
  const [focused, setFocused] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [alias, setAlias] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const stop = catalog.subscribe(setSnapshot);
  let navigation = 0;
  const select = (id: string) => {
    if (!manager.getMachine(id)) return false;
    if (manager.snapshot().selectedMachineId !== id) {
      navigation++;
      options.cancelOpen();
      // Synchronously remove the old input/shell owner before changing the route.
      options.resetWorkspace(id);
      manager.select(id);
    }
    return true;
  };
  const open = async (id: string, name: string, source: "keyboard" | "mouse") => {
    // A same-machine session click supersedes any pending exact-agent focus too.
    if (manager.snapshot().selectedMachineId === id) options.cancelOpen();
    if (!select(id)) return;
    const token = ++navigation;
    setFocused(false);
    options.setSurface("terminals");
    if (manager.getMachine(id)?.endpoint().state !== "ready") {
      options.setNote(
        "This machine is disconnected. Its sessions will become available when it reconnects.",
      );
      return;
    }
    if (token !== navigation) return;
    await options.openSession(name, source);
  };
  const sidebar: ApplicationMachineSidebarModel = {
    groups: () =>
      snapshot().groups.map((group) => ({
        ...group,
        agents: agentGroups().find((value) => value.machineId === group.id)?.agents ?? [],
      })),
    activeMachineId: () => snapshot().selectedMachineId,
    activeSessionName: options.sessionName,
    activePaneId: options.activePaneId,
    focused,
    onFocus: () => {
      navigation++;
      options.cancelOpen();
      setFocused(true);
    },
    onBlur: () => setFocused(false),
    onOpen: (id, name, source) => void open(id, name, source),
    onOpenAgent: (id, sessionName, paneId, source) => {
      const row = agentGroups()
        .find((group) => group.machineId === id)
        ?.agents.find((agent) => agent.sessionName === sessionName && agent.paneId === paneId);
      if (!row || !agents.isCurrentTarget(id, row)) {
        options.setNote(
          "That agent is unavailable or has changed. Wait for its machine to reconnect.",
        );
        return;
      }
      options.cancelOpen();
      if (!select(id)) return;
      navigation++;
      setFocused(false);
      void options.openAgent?.(row, source);
    },
    onSelectMachine: (id) => {
      navigation++;
      options.cancelOpen();
      if (select(id)) {
        options.setSurface("home");
        options.setNote(null);
      }
    },
    onAddMachine: () => {
      navigation++;
      options.cancelOpen();
      setAlias("");
      setError(null);
      setAdding(true);
    },
  };
  onCleanup(() => {
    navigation++;
    stopAgents();
    agents.dispose();
    stop();
    catalog.dispose();
  });
  return {
    catalog,
    agents,
    selectedMachineId: () => manager.snapshot().selectedMachineId,
    automaticOpen: manager.snapshot().machines.length === 1,
    automaticOpenAllowed: () =>
      navigation === 0 && manager.snapshot().selectedMachineId === "local",
    sidebar,
    focused,
    adding,
    alias,
    error,
    setAlias,
    label: () =>
      snapshot().groups.find((g) => g.id === snapshot().selectedMachineId)?.label ?? "This machine",
    isLocal: () => snapshot().selectedMachineId === "local",
    focus: () => {
      navigation++;
      options.cancelOpen();
      setFocused(true);
    },
    cancelAdd: () => {
      setAdding(false);
      setFocused(true);
    },
    add() {
      try {
        const target = alias().trim();
        let existing = manager.snapshot().machines.find((m) => m.sshTarget === target);
        if (!existing) {
          const profiles = manager
            .snapshot()
            .machines.filter((m) => m.sshTarget)
            .map((m) => ({
              id: m.id,
              label: m.label,
              sshTarget: m.sshTarget!,
              enabled: true,
            }));
          const profile = ephemeralMachineProfile(target, profiles);
          manager.add(profile);
          existing = manager.snapshot().machines.find((m) => m.id === profile.id);
        }
        setAdding(false);
        if (existing) sidebar.onSelectMachine(existing.id, "keyboard");
        setFocused(true);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not add this machine.");
      }
    },
    start(target: string | null) {
      agents.start();
      catalog.start();
      if (!target) return;
      const id = manager.snapshot().selectedMachineId;
      const token = navigation;
      void manager.getMachine(id)?.ready.then((ready) => {
        if (ready && token === navigation && manager.snapshot().selectedMachineId === id)
          void open(id, target, "keyboard");
      });
    },
  };
}
