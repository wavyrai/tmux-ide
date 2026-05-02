"use client";

import { useSyncExternalStore } from "react";
import { Persist } from "./persist";

export interface TerminalTab {
  id: string;
  title: string;
  projectName: string;
}

export interface LayoutState {
  terminalOpen: boolean;
  activeTabId: string | null;
  tabs: TerminalTab[];
}

export interface LayoutActions {
  toggleTerminal(): void;
  openTerminalMode(): void;
  closeTerminalMode(): void;
  setActiveTab(id: string): void;
  newTab(projectName: string, title?: string): TerminalTab;
  closeTab(id: string): void;
  reorderTabs(orderedIds: string[]): void;
}

type PersistedLayoutState = Pick<LayoutState, "activeTabId" | "tabs">;
type LayoutStore = LayoutState & LayoutActions;

const defaults: PersistedLayoutState = {
  activeTabId: null,
  tabs: [],
};

const persist = Persist.global<PersistedLayoutState>("tmux-ide.layout", ["v1"], defaults);
const listeners = new Set<() => void>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePersisted(value: unknown): PersistedLayoutState {
  if (!isRecord(value)) return defaults;

  const seen = new Set<string>();
  const rawTabs = Array.isArray(value.tabs) ? value.tabs : [];
  const tabs = rawTabs.flatMap((tab) => {
    if (
      !isRecord(tab) ||
      typeof tab["id"] !== "string" ||
      typeof tab["title"] !== "string" ||
      typeof tab["projectName"] !== "string" ||
      seen.has(tab["id"])
    ) {
      return [];
    }
    seen.add(tab["id"]);
    return [{ id: tab["id"], title: tab["title"], projectName: tab["projectName"] }];
  });
  const activeTabId = typeof value.activeTabId === "string" ? value.activeTabId : null;

  return {
    tabs,
    activeTabId: activeTabId && seen.has(activeTabId) ? activeTabId : (tabs[0]?.id ?? null),
  };
}

function initialState(): LayoutState {
  const persisted = normalizePersisted(persist.read());
  return {
    terminalOpen: false,
    activeTabId: persisted.activeTabId,
    tabs: persisted.tabs,
  };
}

let state = initialState();

function persistState(next: LayoutState): void {
  persist.write({
    activeTabId: next.activeTabId,
    tabs: next.tabs,
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

function activeFallthrough(tabs: TerminalTab[], removedIndex: number): string | null {
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
  setActiveTab(id: string) {
    setState((current) => {
      if (!current.tabs.some((tab) => tab.id === id)) return current;
      return {
        ...current,
        terminalOpen: true,
        activeTabId: id,
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
      activeTabId: tab.id,
      tabs: [...current.tabs, tab],
    }));
    return tab;
  },
  closeTab(id: string) {
    setState((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return current;

      const tabs = current.tabs.filter((tab) => tab.id !== id);
      const activeTabId =
        current.activeTabId === id ? activeFallthrough(tabs, index) : current.activeTabId;

      return {
        ...current,
        terminalOpen: tabs.length > 0 ? current.terminalOpen : false,
        activeTabId,
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
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LayoutState {
  return state;
}

export function useLayoutState(): LayoutStore {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...snapshot, ...actions };
}

export function __resetLayoutStateForTests(next?: Partial<LayoutState>): void {
  state = {
    ...initialState(),
    ...next,
  };
  emit();
}
