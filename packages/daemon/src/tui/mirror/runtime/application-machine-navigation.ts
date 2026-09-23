import type { OpenTuiGenerationHostSnapshot } from "./open-tui-generation-host.ts";
import type { TmuxServerScope } from "@tmux-ide/contracts";
import { fleetHostColor } from "./fleet-presentation.ts";
import type { ApplicationPaletteCommand } from "./application-palette-input.ts";
import { createFleetTabs, type FleetTabTarget } from "./application-fleet-tabs.ts";
import { saveMachineProfiles } from "../../../lib/local-fleet-request.ts";
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

/** Exact attached authority; an unscoped default connection still proves its incarnation. */
function attachedMachineNavigationTarget(active: OpenTuiGenerationHostSnapshot | null) {
  if (active?.status !== "live" || !active.connection?.liveSessionId || !active.daemonGeneration)
    return null;
  return {
    liveSessionId: active.connection.liveSessionId,
    daemonGeneration: active.daemonGeneration,
    ...(active.connection.server ? { server: active.connection.server } : {}),
  };
}

export function createApplicationMachineNavigation(options: {
  resetWorkspace(machineId: string, expectedLiveSessionId?: string, server?: TmuxServerScope): void;
  openAgent?(agent: ApplicationMachineAgent, source: "keyboard" | "mouse"): Promise<unknown> | void;
  cancelOpen(): void;
  openSession(name: string, source: "keyboard" | "mouse"): Promise<unknown>;
  sessionName(): string | null;
  activePaneId?(): string | null;
  attachedGeneration?(): OpenTuiGenerationHostSnapshot | null;
  attachedTarget?(): {
    liveSessionId: string;
    daemonGeneration: string;
    server?: TmuxServerScope;
  } | null;
  setSurface(value: "home" | "terminals"): void;
  setNote(value: string | null | ((current: string | null) => string | null)): void;
}) {
  const preferences = createApplicationFleetPreferences({
    onError: options.setNote,
    onRecovered: (message) => options.setNote((current) => (current === message ? null : current)),
  });
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
  const [serverFocus, setServerFocus] = createSignal<{
    machineId: string;
    server: TmuxServerScope;
  } | null>(null);
  const [attentionOnly, setAttentionOnly] = createSignal(false);
  const showSwitcher = (attention: boolean) => {
    navigation++;
    options.cancelOpen();
    setServerFocus(null);
    setAttentionOnly(attention);
    setFocused(false);
    setSwitching(true);
  };
  const [adding, setAdding] = createSignal(false);
  const [alias, setAlias] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  let attemptStartup: (() => void) | null = null;
  const stop = catalog.subscribe((value) => {
    setSnapshot(value);
    attemptStartup?.();
  });
  let navigation = 0;
  const [activeSessionKey, setActiveSessionKey] = createSignal<string | null>(null);
  const [tabRevision, setTabRevision] = createSignal(0);
  const history: string[] = [...saved().recent].reverse();
  let historyIndex = history.length - 1;
  const select = (id: string, expectedLiveSessionId?: string, server?: TmuxServerScope) => {
    if (!manager.getMachine(id)) return false;
    if (manager.snapshot().selectedMachineId !== id) {
      navigation++;
      options.cancelOpen();
      // Synchronously remove the old input/shell owner before changing the route.
      if (server) options.resetWorkspace(id, expectedLiveSessionId, server);
      else options.resetWorkspace(id, expectedLiveSessionId);
      manager.select(id);
    } else if (expectedLiveSessionId) {
      const attached =
        options.attachedTarget?.() ??
        attachedMachineNavigationTarget(options.attachedGeneration?.() ?? null);
      const sameAuthority =
        attached?.liveSessionId === expectedLiveSessionId &&
        (server
          ? attached.server
            ? attached.server.serverId === server.serverId &&
              attached.server.generation === server.generation
            : attached.daemonGeneration === server.generation &&
              manager.getMachine(id)?.read()?.instanceId === server.generation
          : !attached.server);
      if (sameAuthority) return true;
      if (server) options.resetWorkspace(id, expectedLiveSessionId, server);
      else options.resetWorkspace(id, expectedLiveSessionId);
    }
    return true;
  };
  const open = async (
    id: string,
    name: string,
    source: "keyboard" | "mouse",
    remember = true,
    expectedLiveSessionId?: string,
    server?: TmuxServerScope,
    sessionKey?: string,
  ) => {
    // A same-machine session click supersedes any pending exact-agent focus too.
    if (manager.snapshot().selectedMachineId === id) options.cancelOpen();
    // A sidebar selection can leave a tab whose route is pinned to a different
    // live incarnation on this same machine. Select a new exact owner before
    // preparation; never apply that old tab's identity fence to the new name.
    if (manager.getMachine(id)?.endpoint().state !== "ready") {
      select(id);
      options.setNote("This machine is disconnected. Select the session after reconnecting.");
      return false;
    }
    const candidates =
      snapshot()
        .groups.find((group) => group.id === id || group.routeIds?.includes(id))
        ?.sessions.filter(
          (row) =>
            row.name === name &&
            !row.disabled &&
            (!sessionKey || row.id === sessionKey) &&
            (!expectedLiveSessionId || row.liveSessionId === expectedLiveSessionId) &&
            (!server ||
              (row.server?.serverId === server.serverId &&
                row.server.generation === server.generation)),
        ) ?? [];
    if (candidates.length !== 1) {
      options.setNote(
        "Select the session under its tmux server; this target is ambiguous or has changed.",
      );
      return false;
    }
    const selected = candidates[0]!;
    const sameSelection = activeSessionKey() === selected.id && options.sessionName() === name;
    setActiveSessionKey(selected.id);
    expectedLiveSessionId = selected.liveSessionId;
    server = selected.server;
    if (!select(id, sameSelection ? undefined : expectedLiveSessionId, server)) return;
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
        ?.sessions.find((row) => row.id === selected.id && !row.disabled);
      if (session) {
        if (session.liveSessionId)
          tabs.remember({
            key: JSON.stringify([
              id,
              session.server?.serverId,
              session.server?.generation,
              session.liveSessionId,
            ]),
            server: session.server,
            machineId: id,
            liveSessionId: session.liveSessionId,
            label: session.name,
            hostLabel: `${manager.getMachine(id)?.label ?? id}${session.serverLabel ? ` / ${session.serverLabel}` : ""}`,
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
      (s) =>
        s.liveSessionId === target.liveSessionId &&
        !s.disabled &&
        s.server?.serverId === target.server?.serverId &&
        s.server?.generation === target.server?.generation,
    );
    return row ? { ...target, label: row.name } : null;
  };
  const tabs = createFleetTabs({
    resolve: resolveTab,
    retireActive: () => {
      setActiveSessionKey(null);
      navigation++;
      options.cancelOpen();
      options.resetWorkspace(manager.snapshot().selectedMachineId);
      options.setSurface("home");
    },
    open: async (target) =>
      !!(await open(
        target.machineId,
        target.label,
        "keyboard",
        true,
        target.liveSessionId,
        target.server,
      )),
    publish: () => setTabRevision((value) => value + 1),
    unavailable: () => options.setNote("That tab's session is unavailable or has been replaced."),
  });
  const isDefaultSession = (machineId: string, session: { server?: TmuxServerScope }) =>
    !session.server ||
    session.server.generation === manager.getMachine(machineId)?.read()?.instanceId;
  const sidebar: ApplicationMachineSidebarModel = {
    groups: () =>
      snapshot().groups.map((group) => ({
        ...group,
        agentsAvailable:
          group.sessions.some((session) => isDefaultSession(group.id, session)) &&
          (agentGroups().find((value) => value.machineId === group.id)?.available ?? false),
        agents: !group.sessions.some((session) => isDefaultSession(group.id, session))
          ? []
          : (agentGroups().find((value) => value.machineId === group.id)?.agents ?? []).map(
              (agent) => ({
                ...agent,
                server: group.sessions.find(
                  (session) =>
                    session.liveSessionId === agent.liveSessionId &&
                    isDefaultSession(group.id, session),
                )?.server,
              }),
            ),
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
    activeSessionKey,
    activePaneId: options.activePaneId,
    focused,
    onFocus: () => {
      navigation++;
      options.cancelOpen();
      setFocused(true);
    },
    onBlur: () => setFocused(false),
    onOpen: (id, name, source, sessionKey) =>
      void open(id, name, source, true, undefined, undefined, sessionKey),
    onOpenAgent: (id, sessionName, paneId, source) => {
      const sessions = snapshot().groups.find((group) => group.id === id)?.sessions ?? [];
      const selectedSession = sessions.find(
        (session) => session.name === sessionName && isDefaultSession(id, session),
      );
      if (sessions.length && !selectedSession) {
        options.setNote("Open this agent through its server session first.");
        return;
      }
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
      if (!select(id, selectedSession?.liveSessionId, selectedSession?.server)) return;
      if (selectedSession) setActiveSessionKey(selectedSession.id);
      navigation++;
      setFocused(false);
      void options.openAgent?.(row, source);
    },
    onSelectServer: (machineId, server) => {
      showSwitcher(false);
      setServerFocus({ machineId, server });
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
    openHomeAgent: (row: ApplicationMachineAgent, source: "keyboard" | "mouse") => {
      if (!agents.isCurrentTarget(row.machineId, row) || row.disabled) return;
      const session = snapshot()
        .groups.find((group) => group.id === row.machineId)
        ?.sessions.find(
          (session) =>
            session.liveSessionId === row.liveSessionId &&
            !session.disabled &&
            session.server?.serverId === row.server?.serverId &&
            session.server?.generation === row.server?.generation,
        );
      if (!session) {
        options.setNote("That agent session has changed. Select it again.");
        return;
      }
      options.cancelOpen();
      if (!select(row.machineId, row.liveSessionId, row.server)) return;
      setActiveSessionKey(session.id);
      navigation++;
      setFocused(false);
      return options.openAgent?.(row, source);
    },
    openSelectedSession: (name: string, source: "keyboard" | "mouse", key?: string) =>
      open(manager.snapshot().selectedMachineId, name, source, true, undefined, undefined, key),
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
      if (
        await open(
          group.id,
          session.name,
          "keyboard",
          false,
          session.liveSessionId,
          session.server,
          session.id,
        )
      )
        historyIndex = next;
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
    switcherFilter: (command: ApplicationPaletteCommand) => {
      const focus = serverFocus();
      return (
        !focus ||
        (typeof command === "object" &&
          command.fleet?.machineId === focus.machineId &&
          command.fleet?.server?.serverId === focus.server.serverId &&
          command.fleet?.server?.generation === focus.server.generation)
      );
    },
    paletteCommands(): readonly ApplicationPaletteCommand[] {
      const groupsById = new Map(agentGroups().map((group) => [group.machineId, group]));
      return snapshot().groups.flatMap((group) => {
        const agentGroup = !group.sessions.some((session) => isDefaultSession(group.id, session))
          ? undefined
          : groupsById.get(group.id);
        const agentsBySession = new Map<string, ApplicationMachineAgent[]>();
        for (const agent of agentGroup?.agents ?? []) {
          if (!agent.liveSessionId || !agent.paneId) continue;
          const list = agentsBySession.get(agent.liveSessionId) ?? [];
          list.push(agent);
          agentsBySession.set(agent.liveSessionId, list);
        }
        const daemon = manager.getMachine(group.id)?.read();
        const sessions = group.sessions.flatMap((session): ApplicationPaletteCommand[] => {
          if (!session.liveSessionId) return [];
          const fleet = {
            machineId: group.id,
            favorite: saved().favorites.includes(session.id),
            recentRank: saved().recent.includes(session.id)
              ? saved().recent.indexOf(session.id)
              : 1000,
            liveSessionId: session.liveSessionId,
            server: session.server,
            hostLabel: `${group.label}${session.serverLabel ? ` / ${session.serverLabel}` : ""}`,
            agentActivities:
              isDefaultSession(group.id, session) && agentGroup?.available
                ? (agentsBySession.get(session.liveSessionId) ?? []).map((a) => ({
                    paneId: a.paneId!,
                    attention: a.attention,
                    activity: a.activity,
                  }))
                : undefined,
            daemonInstanceId: daemon?.instanceId ?? "",
            disabled: session.disabled || group.state !== "ready",
          };
          return [
            { kind: "open-session", sessionName: session.name, label: session.name, fleet },
            ...(isDefaultSession(group.id, session)
              ? (agentsBySession.get(session.liveSessionId) ?? [])
              : []
            ).map((a) => ({
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
          ...(group.servers ?? []).map((server) => ({
            kind: "open-machine" as const,
            sessionName: "" as const,
            label: `${server.label} · ${server.serverId.slice(-6)} · New session ^N`,
            fleet: {
              machineId: group.id,
              hostLabel: `${group.label} / ${server.label}`,
              liveSessionId: "",
              daemonInstanceId: daemon?.instanceId ?? "",
              disabled: group.state !== "ready" || server.state !== "online",
              ...(server.state === "online"
                ? { server: { serverId: server.serverId, generation: server.generation } }
                : {}),
            },
          })),
          ...sessions,
        ];
      });
    },
    togglePaletteFavorite(command: ApplicationPaletteCommand) {
      if (typeof command !== "object" || command.kind !== "open-session" || !command.fleet) return;
      const target = command.fleet;
      const session = snapshot()
        .groups.find((g) => g.id === target.machineId)
        ?.sessions.find(
          (s) =>
            s.liveSessionId === target.liveSessionId &&
            s.server?.serverId === target.server?.serverId &&
            s.server?.generation === target.server?.generation,
        );
      if (session)
        preferences.change({
          type: "favorite",
          key: session.id,
          enabled: !saved().favorites.includes(session.id),
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
        if (target.server) {
          const descriptor = snapshot()
            .groups.find((group) => group.id === target.machineId)
            ?.servers?.find(
              (server) =>
                server.serverId === target.server?.serverId &&
                server.generation === target.server.generation &&
                server.state === "online",
            );
          if (!descriptor || handle?.read()?.instanceId !== target.daemonInstanceId) {
            options.setNote("That server has changed. Select it again.");
            return;
          }
          sidebar.onSelectServer?.(target.machineId, target.server);
          return;
        }
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
        (s) =>
          s.liveSessionId === target.liveSessionId &&
          !s.disabled &&
          s.server?.serverId === target.server?.serverId &&
          s.server?.generation === target.server?.generation,
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
      else
        await open(
          target.machineId,
          session.name,
          source,
          true,
          target.liveSessionId,
          target.server,
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
    start(target: string | null, serverId?: string | null) {
      agents.start();
      catalog.start();
      if (!target && !serverId) return;
      const id = manager.snapshot().selectedMachineId;
      const token = navigation;

      let machineReady = false;
      const attempt = () => {
        if (!machineReady) return;
        if (token !== navigation) {
          attemptStartup = null;
          return;
        }
        const group = snapshot().groups.find((group) => group.id === id);
        if (group?.state !== "ready") return;
        const matches = group.sessions.filter(
          (row) =>
            !row.disabled &&
            (!serverId || row.server?.serverId === serverId) &&
            (!target || row.name === target),
        );
        if (matches.length !== 1) {
          options.setNote(
            matches.length
              ? "Select a session under the requested tmux server."
              : "Requested server or session is unavailable. Select it again.",
          );
          attemptStartup = null;
          return;
        }
        const row = matches[0]!;
        attemptStartup = null;
        void open(id, row.name, "keyboard", true, row.liveSessionId, row.server, row.id);
      };
      attemptStartup = attempt;
      void manager.getMachine(id)?.ready.then((ready) => {
        machineReady = ready;
        attemptStartup?.();
      });
      attempt();
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
