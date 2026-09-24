import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type {
  ApplicationMachineAgent,
  ApplicationMachineAgentGroup,
} from "./application-machine-agents.ts";
import type { ApplicationMachineCatalogSnapshot } from "./application-machine-catalog.ts";
import type { HomeAgentRow, HomeAgentSnapshot } from "./application-home-agents.ts";
import { createHomeAgentSelectionOwner } from "./application-home-agent-selection.ts";
import type { ApplicationHomeAgentPresentation } from "./application-home-agents-owner.ts";

export interface HomeFleetFilter {
  readonly machineId: string | null;
  readonly attentionOnly: boolean;
  readonly query?: string;
}
export function projectHomeFleet(
  catalog: ApplicationMachineCatalogSnapshot,
  groups: readonly ApplicationMachineAgentGroup[],
  filter: HomeFleetFilter,
): HomeAgentSnapshot {
  const machines = catalog.groups.filter(
    (group) => filter.machineId === null || group.id === filter.machineId,
  );
  const rows: HomeAgentRow[] = [];
  const unavailable = new Set<string>();
  let observedSessions = 0,
    totalSessions = 0,
    loadingSessions = 0,
    unavailableSessions = 0,
    truncatedSessions = 0;
  const panes = new Set<string>();
  for (const machine of machines) {
    const group = groups.find((group) => group.machineId === machine.id);
    totalSessions += machine.sessions.length;
    const observation = machine.state === "ready" ? group?.observation : undefined;
    observedSessions +=
      observation?.observedSessions ?? (group?.available ? machine.sessions.length : 0);
    loadingSessions +=
      observation?.loadingSessions ??
      (machine.state === "connecting" ? machine.sessions.length : 0);
    unavailableSessions +=
      observation?.unavailableSessions ??
      (machine.state === "disconnected" ? machine.sessions.length : 0);
    truncatedSessions += observation?.truncatedSessions ?? 0;
    for (const key of observation?.unavailableSessionKeys ?? [])
      unavailable.add(JSON.stringify([machine.id, key]));
    for (const agent of [...(group?.agents ?? [])].sort(
      (a, b) => Number(a.disabled) - Number(b.disabled) || a.id.localeCompare(b.id),
    )) {
      const sessionKey = JSON.stringify([machine.id, agent.sessionKey]);
      if (agent.disabled) unavailable.add(sessionKey);
      if (
        filter.attentionOnly &&
        !(agent.attention || agent.activity === "waiting" || agent.activity === "failed")
      )
        continue;
      const paneKey = agent.paneId
        ? JSON.stringify([machine.id, agent.server?.serverId, agent.daemonInstanceId, agent.paneId])
        : agent.id;
      if (panes.has(paneKey)) continue;
      panes.add(paneKey);
      rows.push({ ...agent, key: agent.id, sessionKey, machineLabel: machine.label });
    }
  }
  // Identity order never jumps when an activity signal changes.
  rows.sort((a, b) => a.key.localeCompare(b.key));
  const missing = machines.filter(
    (machine) =>
      machine.state !== "ready" ||
      !groups.find((group) => group.machineId === machine.id)?.available,
  );
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const matching = query
    ? rows.filter((row) =>
        [
          row.name,
          row.harness,
          row.projectName,
          row.sessionName,
          row.machineLabel,
          row.serverLabel,
        ].some((value) => value?.toLocaleLowerCase().includes(query)),
      )
    : rows;
  return {
    phase: missing.length
      ? rows.length || observedSessions
        ? "partial"
        : machines.some((machine) => machine.state === "connecting")
          ? "loading"
          : "unavailable"
      : "live",
    rows: matching,
    observedSessions,
    totalSessions,
    loadingSessions,
    unavailableSessions,
    truncatedSessions,
    refreshingSessionKeys: [],
    unavailableSessionKeys: [...unavailable],
    note: missing.length
      ? `${missing.map((machine) => `${machine.label}: ${machine.state === "ready" ? "partial observations" : machine.state}`).join(" · ")} · unavailable rows show last observed activity`
      : rows.length === 0 && filter.attentionOnly
        ? "No agents need attention in this view."
        : null,
  };
}

/** Reuses resident fleet observations, adding no daemon connections or pane streams. */
export function createApplicationHomeFleetOwner(options: {
  readonly catalog: {
    getSnapshot(): ApplicationMachineCatalogSnapshot;
    subscribe(listener: (value: ApplicationMachineCatalogSnapshot) => void): () => void;
  };
  readonly agents: {
    retry?(): void;
    loadMore?(): void;
    getSnapshot(): readonly ApplicationMachineAgentGroup[];
    subscribe(listener: (value: readonly ApplicationMachineAgentGroup[]) => void): () => void;
  };
  readonly inputActive: () => boolean;
  readonly open: (
    machineId: string,
    agent: ApplicationMachineAgent,
    source: "keyboard" | "mouse",
  ) => Promise<unknown> | void;
}) {
  const [catalog, setCatalog] = createSignal(options.catalog.getSnapshot());
  const [groups, setGroups] = createSignal(options.agents.getSnapshot());
  const [filter, setFilter] = createSignal<HomeFleetFilter>({
    machineId: null,
    attentionOnly: false,
  });
  const selection = createHomeAgentSelectionOwner();
  const [selected, setSelected] = createSignal(selection.snapshot());
  const snapshot = createMemo(() => projectHomeFleet(catalog(), groups(), filter()));
  const stops = [
    options.catalog.subscribe(setCatalog),
    options.agents.subscribe(setGroups),
    selection.subscribe(setSelected),
  ];
  createEffect(() => selection.setRows(snapshot().rows));
  createEffect(() => {
    const id = filter().machineId;
    if (id && !catalog().groups.some((group) => group.id === id))
      setFilter((value) => ({ ...value, machineId: null }));
  });
  onCleanup(() => {
    for (const stop of stops) stop();
    selection.dispose();
  });
  const presentation: ApplicationHomeAgentPresentation = {
    get agentQuery() {
      return filter().query ?? "";
    },
    onAgentQueryChange(query) {
      setFilter((value) => ({ ...value, query }));
    },
    get agentRoster() {
      return snapshot();
    },
    get agentSelection() {
      return selected();
    },
    get agentInputActive() {
      return options.inputActive();
    },
    get agentFilterLabel() {
      return `${catalog().groups.find((group) => group.id === filter().machineId)?.label ?? "All machines"} · ${filter().attentionOnly ? "Needs attention" : "All agents"}`;
    },
    onCycleAgentMachine() {
      const ids = [null, ...catalog().groups.map((group) => group.id)];
      setFilter((value) => ({
        ...value,
        machineId: ids[(ids.indexOf(value.machineId) + 1) % ids.length]!,
      }));
    },
    onToggleAgentAttention() {
      setFilter((value) => ({ ...value, attentionOnly: !value.attentionOnly }));
    },
    onRetryAgents: () => options.agents.retry?.(),
    onLoadMoreAgents: () => options.agents.loadMore?.(),
    onSelectAgent: selection.select,
    onMoveAgent: selection.move,
    onAgentViewport: selection.setViewport,
    onOpenAgent(row, source) {
      if (!options.inputActive()) return;
      const group = groups().find((group) => group.machineId === row.machineId);
      const agent = group?.agents.find((agent) => agent.id === row.key);
      if (agent && !agent.disabled && agent.paneId)
        void options.open(agent.machineId, agent, source);
    },
  };
  return { presentation };
}
