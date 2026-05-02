"use client";

import { useSyncExternalStore } from "react";
import { Persist } from "./persist";

export interface TerminalTab {
  id: string;
  title: string;
  projectName: string;
  paneId?: string;
}

export type WorkspaceTabKind = "project" | "settings";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  projectName: string | null;
  title: string;
}

export type ActivitySection = "sessions" | "settings";

export interface LayoutState {
  terminalOpen: boolean;
  /**
   * Active tab id per project. Each project keeps its own active tab so
   * switching projects in the sidebar restores the right terminal in the
   * full-screen mode. A missing entry means "use the first tab in this
   * project's tab list" (resolved by getActiveTabId).
   */
  activeTabIdByProject: Record<string, string | null>;
  tabs: TerminalTab[];
  workspaceTabs: WorkspaceTab[];
  activeWorkspaceTabId: string | null;
  activitySection: ActivitySection;
}

export interface LayoutQueries {
  /** Tabs filtered to a single project, in current order. */
  getProjectTabs(projectName: string): TerminalTab[];
  /** Active tab id for a project, falling back to the first tab in that project. */
  getActiveTabId(projectName: string): string | null;
}

export interface LayoutActions {
  toggleTerminal(): void;
  openTerminalMode(): void;
  closeTerminalMode(): void;
  /** Active state is scoped per-project so each project remembers its own focused tab. */
  setActiveTab(projectName: string, id: string): void;
  newTab(projectName: string, title?: string): TerminalTab;
  newPaneTab(projectName: string, paneId: string, title?: string): TerminalTab;
  closeTab(id: string): void;
  reorderTabs(orderedIds: string[]): void;
  openWorkspaceTab(
    kind: WorkspaceTabKind,
    projectName: string | null,
    title?: string,
  ): WorkspaceTab;
  closeWorkspaceTab(id: string): void;
  setActiveWorkspaceTab(id: string): void;
  reorderWorkspaceTabs(orderedIds: string[]): void;
  setActivitySection(section: ActivitySection): void;
}

type PersistedLayoutState = Pick<
  LayoutState,
  "activeTabIdByProject" | "tabs" | "workspaceTabs" | "activeWorkspaceTabId" | "activitySection"
>;
type LayoutStore = LayoutState & LayoutActions & LayoutQueries;

const defaults: PersistedLayoutState = {
  activeTabIdByProject: {},
  tabs: [],
  workspaceTabs: [],
  activeWorkspaceTabId: null,
  activitySection: "sessions",
};

const persist = Persist.global<PersistedLayoutState>(
  "tmux-ide.layout",
  ["v1", "v2", "v3", "v4"],
  defaults,
  {
    // Migrating INTO v2: legacy `activeTabId` (single global) → `activeTabIdByProject` map.
    v2: (prev: unknown) => {
      if (!isRecord(prev)) return defaults;
      const tabs = Array.isArray(prev.tabs) ? prev.tabs : [];
      const legacyActive = typeof prev.activeTabId === "string" ? prev.activeTabId : null;
      const activeTabIdByProject: Record<string, string | null> = {};
      if (legacyActive) {
        const tab = tabs.find(
          (t): t is { id: string; projectName: string } =>
            isRecord(t) &&
            typeof t["id"] === "string" &&
            t["id"] === legacyActive &&
            typeof t["projectName"] === "string",
        );
        if (tab) activeTabIdByProject[tab.projectName] = legacyActive;
      }
      return { tabs, activeTabIdByProject };
    },
    // Migrating INTO v3: keep existing terminal state and initialize workspace tabs.
    v3: (prev: unknown) => ({
      ...(isRecord(prev) ? prev : {}),
      workspaceTabs: isRecord(prev) && Array.isArray(prev.workspaceTabs) ? prev.workspaceTabs : [],
      activeWorkspaceTabId:
        isRecord(prev) && typeof prev.activeWorkspaceTabId === "string"
          ? prev.activeWorkspaceTabId
          : null,
      activitySection:
        isRecord(prev) && isActivitySection(prev.activitySection)
          ? prev.activitySection
          : "sessions",
    }),
    // Migrating INTO v4: terminal pane tabs carry an optional paneId. Legacy
    // bash tabs pass through unchanged with paneId omitted.
    v4: (prev: unknown) => (isRecord(prev) ? prev : defaults),
  },
);
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceTabKind(value: unknown): value is WorkspaceTabKind {
  return value === "project" || value === "settings";
}

function isActivitySection(value: unknown): value is ActivitySection {
  return value === "sessions" || value === "settings";
}

function normalizePersisted(value: unknown): PersistedLayoutState {
  if (!isRecord(value)) return defaults;

  const seenTerminalTabs = new Set<string>();
  const projectsSeen = new Set<string>();
  const rawTabs = Array.isArray(value.tabs) ? value.tabs : [];
  const tabs = rawTabs.flatMap((tab) => {
    if (
      !isRecord(tab) ||
      typeof tab["id"] !== "string" ||
      typeof tab["title"] !== "string" ||
      typeof tab["projectName"] !== "string" ||
      seenTerminalTabs.has(tab["id"])
    ) {
      return [];
    }
    seenTerminalTabs.add(tab["id"]);
    projectsSeen.add(tab["projectName"]);
    return [
      {
        id: tab["id"],
        title: tab["title"],
        projectName: tab["projectName"],
        ...(typeof tab["paneId"] === "string" ? { paneId: tab["paneId"] } : {}),
      },
    ];
  });

  const activeRaw = isRecord(value.activeTabIdByProject) ? value.activeTabIdByProject : {};
  const activeTabIdByProject: Record<string, string | null> = {};
  for (const [project, id] of Object.entries(activeRaw)) {
    if (typeof id === "string" && seenTerminalTabs.has(id) && projectsSeen.has(project)) {
      activeTabIdByProject[project] = id;
    }
  }

  const seenWorkspaceTabs = new Set<string>();
  const rawWorkspaceTabs = Array.isArray(value.workspaceTabs) ? value.workspaceTabs : [];
  const workspaceTabs = rawWorkspaceTabs.flatMap((tab) => {
    if (
      !isRecord(tab) ||
      typeof tab["id"] !== "string" ||
      !isWorkspaceTabKind(tab["kind"]) ||
      !(typeof tab["projectName"] === "string" || tab["projectName"] === null) ||
      typeof tab["title"] !== "string" ||
      seenWorkspaceTabs.has(tab["id"])
    ) {
      return [];
    }
    seenWorkspaceTabs.add(tab["id"]);
    return [
      {
        id: tab["id"],
        kind: tab["kind"],
        projectName: tab["projectName"],
        title: tab["title"],
      },
    ];
  });

  const activeWorkspaceTabId =
    typeof value.activeWorkspaceTabId === "string" &&
    seenWorkspaceTabs.has(value.activeWorkspaceTabId)
      ? value.activeWorkspaceTabId
      : (workspaceTabs[0]?.id ?? null);

  const activitySection = isActivitySection(value.activitySection)
    ? value.activitySection
    : "sessions";

  return { tabs, activeTabIdByProject, workspaceTabs, activeWorkspaceTabId, activitySection };
}

function initialState(): LayoutState {
  const persisted = normalizePersisted(persist.read());
  return {
    terminalOpen: false,
    activeTabIdByProject: persisted.activeTabIdByProject,
    tabs: persisted.tabs,
    workspaceTabs: persisted.workspaceTabs,
    activeWorkspaceTabId: persisted.activeWorkspaceTabId,
    activitySection: persisted.activitySection,
  };
}

let state = initialState();

function persistState(next: LayoutState): void {
  persist.write({
    activeTabIdByProject: next.activeTabIdByProject,
    tabs: next.tabs,
    workspaceTabs: next.workspaceTabs,
    activeWorkspaceTabId: next.activeWorkspaceTabId,
    activitySection: next.activitySection,
  });
}

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(
  recipe: LayoutState | ((current: LayoutState) => LayoutState),
  options: { persist?: boolean } = {},
): void {
  state = typeof recipe === "function" ? recipe(state) : recipe;
  if (options.persist ?? true) persistState(state);
  emit();
}

function nextSeq(projectName: string, tabs: TerminalTab[]): number {
  let max = 0;
  const prefix = `${projectName}:`;
  for (const tab of tabs) {
    if (!tab.id.startsWith(prefix)) continue;
    const seq = Number.parseInt(tab.id.slice(prefix.length), 10);
    if (Number.isFinite(seq)) max = Math.max(max, seq);
  }
  return max + 1;
}

function projectTabs(tabs: TerminalTab[], projectName: string): TerminalTab[] {
  return tabs.filter((tab) => tab.projectName === projectName);
}

function fallbackActive(tabs: TerminalTab[], projectName: string): string | null {
  const first = projectTabs(tabs, projectName)[0];
  return first ? first.id : null;
}

function workspaceTabId(kind: WorkspaceTabKind, projectName: string | null): string {
  return `${kind}:${projectName ?? ""}`;
}

function workspaceTabTitle(
  kind: WorkspaceTabKind,
  projectName: string | null,
  title?: string,
): string {
  if (title) return title;
  if (kind === "settings") return "Settings";
  return projectName || "Project";
}

function workspaceFallthrough(tabs: WorkspaceTab[], removedIndex: number): string | null {
  return tabs[removedIndex - 1]?.id ?? tabs[removedIndex]?.id ?? null;
}

const actions: LayoutActions = {
  toggleTerminal() {
    setState((current) => ({ ...current, terminalOpen: !current.terminalOpen }), {
      persist: false,
    });
  },
  openTerminalMode() {
    setState((current) => ({ ...current, terminalOpen: true }), { persist: false });
  },
  closeTerminalMode() {
    setState((current) => ({ ...current, terminalOpen: false }), { persist: false });
  },
  setActiveTab(projectName: string, id: string) {
    setState((current) => {
      const tab = current.tabs.find((t) => t.id === id);
      if (!tab || tab.projectName !== projectName) return current;
      return {
        ...current,
        terminalOpen: true,
        activeTabIdByProject: { ...current.activeTabIdByProject, [projectName]: id },
      };
    });
  },
  newTab(projectName: string, title?: string) {
    const seq = nextSeq(projectName, state.tabs);
    const tab = {
      id: `${projectName}:${seq}`,
      title: title || `${projectName} ${seq}`,
      projectName,
    };
    setState((current) => ({
      ...current,
      terminalOpen: true,
      activeTabIdByProject: { ...current.activeTabIdByProject, [projectName]: tab.id },
      tabs: [...current.tabs, tab],
    }));
    return tab;
  },
  newPaneTab(projectName: string, paneId: string, title?: string) {
    const id = `${projectName}:${paneId}`;
    const existing = state.tabs.find((tab) => tab.id === id && tab.projectName === projectName);
    if (existing) {
      setState((current) => ({
        ...current,
        terminalOpen: true,
        activeTabIdByProject: { ...current.activeTabIdByProject, [projectName]: existing.id },
      }));
      return existing;
    }

    const tab = {
      id,
      title: title || `${projectName} · ${paneId}`,
      projectName,
      paneId,
    };
    setState((current) => ({
      ...current,
      terminalOpen: true,
      activeTabIdByProject: { ...current.activeTabIdByProject, [projectName]: tab.id },
      tabs: [...current.tabs, tab],
    }));
    return tab;
  },
  closeTab(id: string) {
    setState((current) => {
      const closing = current.tabs.find((tab) => tab.id === id);
      if (!closing) return current;

      const tabs = current.tabs.filter((tab) => tab.id !== id);
      const activeTabIdByProject = { ...current.activeTabIdByProject };
      if (activeTabIdByProject[closing.projectName] === id) {
        const fallback = fallbackActive(tabs, closing.projectName);
        if (fallback) activeTabIdByProject[closing.projectName] = fallback;
        else delete activeTabIdByProject[closing.projectName];
      }

      return {
        ...current,
        terminalOpen: tabs.length > 0 ? current.terminalOpen : false,
        activeTabIdByProject,
        tabs,
      };
    });
  },
  reorderTabs(orderedIds: string[]) {
    setState((current) => {
      const byId = new Map(current.tabs.map((tab) => [tab.id, tab]));
      const ordered = orderedIds.flatMap((id) => {
        const tab = byId.get(id);
        if (!tab) return [];
        byId.delete(id);
        return [tab];
      });
      return {
        ...current,
        tabs: [...ordered, ...byId.values()],
      };
    });
  },
  openWorkspaceTab(kind: WorkspaceTabKind, projectName: string | null, title?: string) {
    const existing = state.workspaceTabs.find(
      (tab) => tab.kind === kind && tab.projectName === projectName,
    );
    if (existing) {
      setState((current) => ({
        ...current,
        activeWorkspaceTabId: existing.id,
      }));
      return existing;
    }

    const tab = {
      id: workspaceTabId(kind, projectName),
      kind,
      projectName,
      title: workspaceTabTitle(kind, projectName, title),
    };
    setState((current) => ({
      ...current,
      activeWorkspaceTabId: tab.id,
      workspaceTabs: [...current.workspaceTabs, tab],
    }));
    return tab;
  },
  closeWorkspaceTab(id: string) {
    setState((current) => {
      const index = current.workspaceTabs.findIndex((tab) => tab.id === id);
      if (index === -1) return current;

      const workspaceTabs = current.workspaceTabs.filter((tab) => tab.id !== id);
      const activeWorkspaceTabId =
        current.activeWorkspaceTabId === id
          ? workspaceFallthrough(workspaceTabs, index)
          : current.activeWorkspaceTabId;

      return {
        ...current,
        activeWorkspaceTabId,
        workspaceTabs,
      };
    });
  },
  setActiveWorkspaceTab(id: string) {
    setState((current) => {
      if (!current.workspaceTabs.some((tab) => tab.id === id)) return current;
      return { ...current, activeWorkspaceTabId: id };
    });
  },
  reorderWorkspaceTabs(orderedIds: string[]) {
    setState((current) => {
      const byId = new Map(current.workspaceTabs.map((tab) => [tab.id, tab]));
      const ordered = orderedIds.flatMap((id) => {
        const tab = byId.get(id);
        if (!tab) return [];
        byId.delete(id);
        return [tab];
      });
      return {
        ...current,
        workspaceTabs: [...ordered, ...byId.values()],
      };
    });
  },
  setActivitySection(section: ActivitySection) {
    setState((current) => ({ ...current, activitySection: section }));
  },
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LayoutState {
  return state;
}

// Returned during SSR AND the first client render before hydration completes.
// Always reflects the persistence-free defaults so server-rendered HTML matches
// the first client render — React then re-renders with getSnapshot once the
// store subscription kicks in. Without this, localStorage-derived state on the
// client diverges from the server's empty defaults and triggers a mismatch.
const serverSnapshot: LayoutState = {
  terminalOpen: false,
  activeTabIdByProject: {},
  tabs: [],
  workspaceTabs: [],
  activeWorkspaceTabId: null,
  activitySection: "sessions",
};

function getServerSnapshot(): LayoutState {
  return serverSnapshot;
}

function queriesForSnapshot(snapshot: LayoutState): LayoutQueries {
  return {
    getProjectTabs(projectName: string) {
      return projectTabs(snapshot.tabs, projectName);
    },
    getActiveTabId(projectName: string) {
      const explicit = snapshot.activeTabIdByProject[projectName];
      if (
        explicit &&
        snapshot.tabs.some((t) => t.id === explicit && t.projectName === projectName)
      ) {
        return explicit;
      }
      return fallbackActive(snapshot.tabs, projectName);
    },
  };
}

// Stable module-level live queries for callers OUTSIDE the render lifecycle
// (e.g., action `run` callbacks registered with the action registry). They
// read the current module state, which mutates in place. Render-time consumers
// must use the snapshot-bound queries returned by useLayoutState() so SSR and
// the first hydration render agree.
export function getProjectTabsLive(projectName: string): TerminalTab[] {
  return projectTabs(state.tabs, projectName);
}

export function getActiveTabIdLive(projectName: string): string | null {
  const explicit = state.activeTabIdByProject[projectName];
  if (explicit && state.tabs.some((t) => t.id === explicit && t.projectName === projectName)) {
    return explicit;
  }
  return fallbackActive(state.tabs, projectName);
}

export function useLayoutState(): LayoutStore {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Queries must close over the React snapshot (not the module-level `state`)
  // so server-rendered HTML and the first client render agree during
  // hydration — otherwise consumers like FullScreenTerminal read live
  // localStorage state and diverge from the SSR defaults.
  return { ...snapshot, ...actions, ...queriesForSnapshot(snapshot) };
}

export function __resetLayoutStateForTests(next?: Partial<LayoutState>): void {
  state = {
    ...initialState(),
    ...next,
  };
  emit();
}
