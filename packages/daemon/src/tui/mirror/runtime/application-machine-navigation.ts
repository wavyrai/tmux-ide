import { fleetHostColor } from "./fleet-presentation.ts";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import { createFleetTabs, type FleetTabTarget } from "./application-fleet-tabs.ts";
import { readFleetPreview } from "./application-fleet-preview.ts";
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
  resetWorkspace(machineId: string, expectedLiveSessionId?: string): void;
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
  const [tabRevision, setTabRevision] = createSignal(0);
  const history: string[] = [...saved().recent].reverse();
  let historyIndex = history.length - 1;
  const select = (id: string, expectedLiveSessionId?: string) => {
    if (!manager.getMachine(id)) return false;
    if (manager.snapshot().selectedMachineId !== id) {
      navigation++;
      options.cancelOpen();
      // Synchronously remove the old input/shell owner before changing the route.
      options.resetWorkspace(id, expectedLiveSessionId);
      manager.select(id);
    } else if (expectedLiveSessionId) {
      options.resetWorkspace(id, expectedLiveSessionId);
    }
    return true;
  };
  const open = async (
    id: string,
    name: string,
    source: "keyboard" | "mouse",
    remember = true,
    expectedLiveSessionId?: string,
  ) => {
    // A same-machine session click supersedes any pending exact-agent focus too.
    if (manager.snapshot().selectedMachineId === id) options.cancelOpen();
    if (!select(id, expectedLiveSessionId)) return;
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
        .groups.find((group) => group.id === id || group.routeIds?.includes(id))
        ?.sessions.find((row) => row.name === name && !row.disabled);
      if (session) {
        if (session.liveSessionId)
          tabs.remember({
            key: JSON.stringify([id, session.liveSessionId]),
            machineId: id,
            liveSessionId: session.liveSessionId,
            label: session.name,
            hostLabel: manager.getMachine(id)?.label ?? id,
          });
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
  const resolveTab = (target: FleetTabTarget): FleetTabTarget | null => {
    if (manager.getMachine(target.machineId)?.endpoint().state !== "ready") return null;
    const group = snapshot().groups.find(
      (g) => g.id === target.machineId || g.routeIds?.includes(target.machineId),
    );
    const row = group?.sessions.find(
      (s) => s.liveSessionId === target.liveSessionId && !s.disabled,
    );
    return row ? { ...target, label: row.name } : null;
  };
  const tabs = createFleetTabs({
    resolve: resolveTab,
    retireActive: () => {
      navigation++;
      options.cancelOpen();
      options.resetWorkspace(manager.snapshot().selectedMachineId);
      options.setSurface("home");
    },
    open: async (target) =>
      !!(await open(target.machineId, target.label, "keyboard", true, target.liveSessionId)),
    publish: () => setTabRevision((value) => value + 1),
    unavailable: () => options.setNote("That tab's session is unavailable or has been replaced."),
  });
  const sidebar: ApplicationMachineSidebarModel = {
    groups: () =>
      snapshot().groups.map((group) => ({
        ...group,
        agentsAvailable:
          agentGroups().find((value) => value.machineId === group.id)?.available ?? false,
        agents: agentGroups().find((value) => value.machineId === group.id)?.agents ?? [],
      })),
    tabs: () => {
      tabRevision();
      const value = tabs.snapshot();
      return value.tabs.map((tab) => ({
        ...tab,
        active: value.active === tab.key,
        available: !!resolveTab(tab),
      }));
    },
    onOpenTab: (key) => {
      void tabs.activate(key);
    },
    onCloseTab: (key) => tabs.close(key),
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
      tabs.suspend();
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
    tabs.dispose();
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
    cycleTab(direction: -1 | 1, close = false) {
      const value = tabs.snapshot();
      if (close) {
        if (value.active) tabs.close(value.active);
        return;
      }
      if (!value.tabs.length) return;
      const current = value.tabs.findIndex((tab) => tab.key === value.active);
      const target = value.tabs[(current + direction + value.tabs.length) % value.tabs.length];
      if (target) void tabs.activate(target.key);
    },
    closeSwitcher: () => setSwitching(false),
    paletteCommands(): readonly ApplicationPaletteCommand[] {
      return snapshot().groups.flatMap((group) => {
        const daemon = manager.getMachine(group.id)?.read();
        const sessions = group.sessions.flatMap((session): ApplicationPaletteCommand[] => {
          if (!session.liveSessionId) return [];
          const fleet = {
            machineId: group.id,
            liveSessionId: session.liveSessionId,
            hostLabel: group.label,
            agentActivities: agentGroups().find((g) => g.machineId === group.id)?.available
              ? (agentGroups().find((g) => g.machineId === group.id)?.agents ?? [])
                  .filter((a) => a.liveSessionId === session.liveSessionId && a.paneId)
                  .map((a) => ({ paneId: a.paneId!, attention: a.attention, activity: a.activity }))
              : undefined,
            daemonInstanceId: daemon?.instanceId ?? "",
            disabled: session.disabled || group.state !== "ready",
          };
          return [
            { kind: "open-session", sessionName: session.name, label: session.name, fleet },
            ...(agentGroups().find((g) => g.machineId === group.id)?.agents ?? [])
              .filter((a) => a.liveSessionId === session.liveSessionId && a.paneId)
              .map((a) => ({
                kind: "jump-agent" as const,
                sessionName: session.name,
                paneId: a.paneId!,
                label: a.name,
                fleet: { ...fleet, disabled: fleet.disabled || a.disabled },
              })),
          ];
        });
        return [
          {
            kind: "open-machine" as const,
            sessionName: "" as const,
            label: group.label,
            fleet: {
              machineId: group.id,
              hostLabel: group.label,
              liveSessionId: "",
              daemonInstanceId: daemon?.instanceId ?? "",
              disabled: group.state !== "ready",
            },
          },
          ...sessions,
        ];
      });
    },
    async openPalette(
      command: Exclude<ApplicationPaletteCommand, string>,
      source: "keyboard" | "mouse",
    ) {
      const target = command.fleet;
      if (!target) return;
      const handle = manager.getMachine(target.machineId);
      if (command.kind === "open-machine") {
        if (
          handle?.endpoint().state === "ready" &&
          handle.read()?.instanceId === target.daemonInstanceId
        )
          sidebar.onSelectMachine(target.machineId, source);
        else options.setNote("That machine is unavailable.");
        return;
      }
      const group = snapshot().groups.find(
        (g) => g.id === target.machineId || g.routeIds?.includes(target.machineId),
      );
      const session = group?.sessions.find(
        (s) => s.liveSessionId === target.liveSessionId && !s.disabled,
      );
      if (
        !session ||
        handle?.endpoint().state !== "ready" ||
        handle.read()?.instanceId !== target.daemonInstanceId
      ) {
        options.setNote("That fleet target changed. Select it again.");
        return;
      }
      if (command.kind === "jump-agent")
        sidebar.onOpenAgent?.(target.machineId, session.name, command.paneId, source);
      else await open(target.machineId, session.name, source, true, target.liveSessionId);
    },
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
            previewKey: JSON.stringify([
              session.id,
              manager.getMachine(group.id)?.endpoint().epoch,
            ]),
            preview: session.liveSessionId
              ? (signal) => {
                  const handle = manager.getMachine(group.id);
                  return handle
                    ? readFleetPreview(handle, session.liveSessionId!, signal)
                    : Promise.resolve("Preview unavailable");
                }
              : undefined,
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
    color: () => {
      const group = snapshot().groups.find((g) => g.id === snapshot().selectedMachineId);
      return fleetHostColor(group ?? { id: snapshot().selectedMachineId });
    },
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
  event: {
    name: string;
    ctrl?: boolean;
    shift?: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  },
  navigation: Pick<
    ReturnType<typeof createApplicationMachineNavigation>,
    "goHistory" | "showSwitcher" | "cycleTab"
  >,
): boolean {
  const key = event.name.toLowerCase();
  if (key !== "f6" && key !== "f7" && key !== "f8" && key !== "f9") return false;
  event.preventDefault();
  event.stopPropagation();
  if (key === "f9") navigation.cycleTab(event.shift ? -1 : 1, event.ctrl);
  else if (key === "f8") void navigation.goHistory(event.shift ? 1 : -1);
  else navigation.showSwitcher(key === "f7");
  return true;
}
