import { saveMachineProfiles } from "../../../lib/local-fleet-request.ts";
import type { FleetSwitcherRow } from "./application-fleet-switcher.tsx";
import { createApplicationFleetPreferences } from "./application-fleet-preferences.ts";
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
  const preferences = createApplicationFleetPreferences({ onError: options.setNote });
  const [saved, setSaved] = createSignal(preferences.getSnapshot());
  const stopPreferences = preferences.subscribe(setSaved);
  const cacheSignatures = new Map<string, string>();
  const catalog = createApplicationMachineCatalog({
    cachedRoutes: saved().catalog,
    onCache: (route) => {
      const signature = JSON.stringify([route.environmentId, route.generation, route.sessions]);
      if (cacheSignatures.get(route.routeId) === signature) return;
      cacheSignatures.set(route.routeId, signature);
      preferences.change({ type: "cache", route });
    },
  });
  const agents = createApplicationMachineAgents({ catalog });
  const [agentGroups, setAgentGroups] = createSignal(agents.getSnapshot());
  const stopAgents = agents.subscribe(setAgentGroups);
  const [snapshot, setSnapshot] = createSignal(catalog.getSnapshot());
  const [focused, setFocused] = createSignal(false);
  const [switching, setSwitching] = createSignal(false);
  const [attentionOnly, setAttentionOnly] = createSignal(false);
  const showSwitcher = (attention: boolean) => {
    navigation++;
    options.cancelOpen();
    setAttentionOnly(attention);
    setFocused(false);
    setSwitching(true);
  };
  const [adding, setAdding] = createSignal(false);
  const [alias, setAlias] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const stop = catalog.subscribe(setSnapshot);
  let navigation = 0;
  const history: string[] = [...saved().recent].reverse();
  let historyIndex = history.length - 1;
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
  const open = async (id: string, name: string, source: "keyboard" | "mouse", remember = true) => {
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
    const result = await options.openSession(name, source);
    if (
      result === false ||
      (result && typeof result === "object" && "opened" in result && !result.opened)
    )
      return false;
    if (token === navigation) {
      const session = snapshot()
        .groups.find((group) => group.id === id)
        ?.sessions.find((row) => row.name === name && !row.disabled);
      if (session) {
        preferences.change({ type: "visit", key: session.id });
        if (remember && history[historyIndex] !== session.id) {
          history.splice(historyIndex + 1);
          history.push(session.id);
          if (history.length > 64) history.shift();
          historyIndex = history.length - 1;
        }
      }
      return true;
    }
  };
  const sidebar: ApplicationMachineSidebarModel = {
    groups: () =>
      snapshot().groups.map((group) => ({
        ...group,
        agents: agentGroups().find((value) => value.machineId === group.id)?.agents ?? [],
      })),
    favorites: () => saved().favorites,
    collapsed: () => saved().collapsed,
    onFavorite: (key, enabled) => preferences.change({ type: "favorite", key, enabled }),
    onCollapse: (key, enabled) => preferences.change({ type: "collapse", key, enabled }),
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
    onOpenSwitcher: () => showSwitcher(false),
    onOpenAttention: () => showSwitcher(true),
    onRetryMachine: (id) => manager.retry(id),
    onDisconnectMachine: (id) => manager.disconnect(id),
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
    stopPreferences();
    preferences.dispose();
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
    switching,
    attentionOnly,
    showSwitcher,
    async goHistory(direction: -1 | 1) {
      const next = historyIndex + direction;
      const key = history[next];
      if (!key) return;
      const group = snapshot().groups.find((group) =>
        group.sessions.some((session) => session.id === key && !session.disabled),
      );
      const session = group?.sessions.find((session) => session.id === key && !session.disabled);
      if (!group || !session) {
        options.setNote("That session is unavailable or has been replaced.");
        return;
      }
      if (await open(group.id, session.name, "keyboard", false)) historyIndex = next;
    },
    closeSwitcher: () => setSwitching(false),
    switcherRows: (): readonly FleetSwitcherRow[] => {
      const favorite = new Set(saved().favorites);
      const recent = saved().recent;
      const rows: FleetSwitcherRow[] = snapshot().groups.flatMap((group) => [
        {
          key: `machine:${group.id}`,
          label: group.label,
          detail: `Machine · ${group.state}`,
          favorite: false,
          attention: false,
          disabled: false,
          canFavorite: false,
          open: () => sidebar.onSelectMachine(group.id, "keyboard"),
          toggleFavorite: () => {},
        },
        ...group.sessions.map(
          (session): FleetSwitcherRow => ({
            key: session.id,
            label: session.name,
            detail: group.label,
            favorite: favorite.has(session.id),
            attention: false,
            disabled: session.disabled,
            canFavorite: true,
            open: () => {
              const current = catalog
                .getSnapshot()
                .groups.find((g) => g.id === group.id)
                ?.sessions.find((s) => s.id === session.id && !s.disabled);
              if (current) void open(group.id, current.name, "keyboard");
            },
            toggleFavorite: () =>
              preferences.change({
                type: "favorite",
                key: session.id,
                enabled: !favorite.has(session.id),
              }),
          }),
        ),
        ...(agentGroups().find((g) => g.machineId === group.id)?.agents ?? []).map(
          (agent): FleetSwitcherRow => ({
            key: agent.id,
            label: agent.name,
            detail: `${group.label} / ${agent.sessionName}`,
            favorite: false,
            attention: agent.attention && !agent.disabled,
            disabled: agent.disabled || group.state !== "ready",
            canFavorite: false,
            open: () => {
              if (agent.paneId)
                sidebar.onOpenAgent?.(group.id, agent.sessionName, agent.paneId, "keyboard");
            },
            toggleFavorite: () => {},
          }),
        ),
      ]);
      return rows.sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          Number(b.attention) - Number(a.attention) ||
          (recent.includes(a.key) ? recent.indexOf(a.key) : 1000) -
            (recent.includes(b.key) ? recent.indexOf(b.key) : 1000) ||
          a.label.localeCompare(b.label),
      );
    },
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
          void saveMachineProfiles([profile]).catch(() =>
            options.setNote(
              "Connected for this TUI only. Start or update the local daemon to save this machine.",
            ),
          );
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

export function handleFleetShortcut(
  event: { name: string; shift?: boolean; preventDefault(): void; stopPropagation(): void },
  navigation: Pick<
    ReturnType<typeof createApplicationMachineNavigation>,
    "goHistory" | "showSwitcher"
  >,
): boolean {
  const key = event.name.toLowerCase();
  if (key !== "f6" && key !== "f7" && key !== "f8") return false;
  event.preventDefault();
  event.stopPropagation();
  if (key === "f8") void navigation.goHistory(event.shift ? 1 : -1);
  else navigation.showSwitcher(key === "f7");
  return true;
}
