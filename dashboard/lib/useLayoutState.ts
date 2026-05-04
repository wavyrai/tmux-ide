"use client";

import { useSyncExternalStore } from "react";
import {
  defaultTerminalTabId,
  ensureDefaultTerminal as ensureDefaultTerminalInNav,
  closeTab as closeNavTab,
  getNavigationStateLive,
} from "./navigation";

/**
 * @deprecated Phase Z+1: terminal tabs migrated into NavigationState
 * (see `@/lib/navigation`). Each terminal is a `Tab` of `kind ===
 * "terminal"` rendered by `<TerminalsHost>` at the AppShell level.
 *
 * This module remains as a thin shim because legacy call sites
 * (TopBar, navigators, KeybindRoot) still read `terminalOpen` and
 * call `toggleTerminal()` / `openWorkspaceTab(...)`. New code should
 * use the imperative actions in `@/lib/navigation` directly.
 */
export interface TerminalTab {
  id: string;
  title: string;
  projectName: string;
  cwd?: string;
  cmd?: string[];
}

export interface TerminalTabOptions {
  title?: string;
  cwd?: string;
  cmd?: string[];
}

/**
 * @deprecated Workspace tabs moved into NavigationState as part of
 * Phase Z. This kind union remains so legacy call sites in
 * `sessions/SessionsNavigator.tsx`, `skills/SkillsNavigator.tsx`, and
 * `KeybindRoot.tsx` keep compiling — the shims below route through the
 * new navigation tab store when given a project workspace tab.
 */
export type WorkspaceTabKind = "project" | "settings" | "notifications" | "skill";

/**
 * @deprecated Surface preserved for legacy navigators that still call
 * `openWorkspaceTab(...)`. New code should construct `Tab` values via
 * `viewTab/skillTab/settingsTab/terminalTab` and call `openTab(...)`
 * from `@/lib/navigation`.
 */
export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  projectName: string | null;
  title: string;
  ref?: string;
}

/**
 * @deprecated Activity section is no longer part of layout state; modes
 * (sessions/skills/settings) are derived from the active tab kind in
 * NavigationState. Keep the type alias so legacy imports still compile.
 */
export type ActivitySection = "sessions" | "settings" | "skills";

export interface LayoutState {
  /**
   * @deprecated Always `false`. Terminal tabs are now part of
   * NavigationState and have no separate "open" flag — a terminal is
   * either in `openTabs` or it is not. Legacy components that toggled
   * a full-screen overlay should switch to `ensureDefaultTerminal(...)`
   * from `@/lib/navigation`.
   */
  readonly terminalOpen: false;
}

export interface LayoutActions {
  /**
   * @deprecated Pre-Z behaviour toggled a full-screen terminal overlay.
   * In the unified-tabs world this opens / focuses the project's
   * default terminal tab when a session is active. No-op otherwise.
   */
  toggleTerminal(): void;
  /** @deprecated Routes to `ensureDefaultTerminal(sessionName)`. */
  openTerminalMode(): void;
  /** @deprecated Closes the active project's default terminal tab if it is open. */
  closeTerminalMode(): void;
  /**
   * @deprecated Use `openTab(...)` from `@/lib/navigation` instead. This
   * shim routes project/settings/skill tabs through the new navigation
   * store so legacy call sites keep working.
   */
  openWorkspaceTab(
    kind: WorkspaceTabKind,
    projectName: string | null,
    title?: string,
    ref?: string,
  ): WorkspaceTab;
  /** @deprecated No-op shim. */
  closeWorkspaceTab(id: string): void;
  /** @deprecated No-op shim. */
  setActiveWorkspaceTab(id: string): void;
  /** @deprecated No-op shim. */
  reorderWorkspaceTabs(orderedIds: string[]): void;
  /** @deprecated No-op shim. */
  setActivitySection(section: ActivitySection): void;
}

type LayoutStore = LayoutState &
  LayoutActions & {
    /** @deprecated Always empty — workspace tabs migrated to NavigationState. */
    readonly workspaceTabs: WorkspaceTab[];
    /** @deprecated Always null — workspace tabs migrated to NavigationState. */
    readonly activeWorkspaceTabId: string | null;
    /** @deprecated Always "sessions" — modes derived from NavigationState. */
    readonly activitySection: ActivitySection;
  };

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

const state: LayoutState = { terminalOpen: false };

const actions: LayoutActions = {
  toggleTerminal() {
    if (typeof window === "undefined") return;
    const nav = getNavigationStateLive();
    if (!nav.sessionName) return;
    const id = defaultTerminalTabId(nav.sessionName);
    const isActiveTerminal = nav.activeTabId === id;
    if (isActiveTerminal) {
      closeNavTab(id);
      return;
    }
    ensureDefaultTerminalInNav(nav.sessionName);
  },
  openTerminalMode() {
    if (typeof window === "undefined") return;
    const nav = getNavigationStateLive();
    if (!nav.sessionName) return;
    ensureDefaultTerminalInNav(nav.sessionName);
  },
  closeTerminalMode() {
    if (typeof window === "undefined") return;
    const nav = getNavigationStateLive();
    if (!nav.sessionName) return;
    const id = defaultTerminalTabId(nav.sessionName);
    if (nav.activeTabId === id) closeNavTab(id);
  },
  openWorkspaceTab(
    kind: WorkspaceTabKind,
    projectName: string | null,
    title?: string,
    ref?: string,
  ) {
    void kind;
    void title;
    void ref;
    // Route through the new navigation store so legacy call sites still
    // open the right tab. Lazy-imported to avoid a circular module load.
    if (typeof window !== "undefined") {
      void import("./navigation").then((nav) => {
        if (kind === "project" && projectName) {
          nav.setActiveSession(projectName);
        } else if (kind === "settings") {
          nav.openTab(nav.settingsTab());
        } else if (kind === "skill" && projectName && ref) {
          nav.openTab(nav.skillTab(projectName, ref, title));
        }
      });
    }
    return {
      id: `${kind}:${projectName ?? ""}${ref ? `:${ref}` : ""}`,
      kind,
      projectName,
      title:
        title ??
        (kind === "settings" ? "Settings" : kind === "skill" && ref ? `Skill · ${ref}` : "Tab"),
      ...(ref ? { ref } : {}),
    };
  },
  closeWorkspaceTab(_id: string) {
    // No-op: workspace tabs moved into NavigationState.
  },
  setActiveWorkspaceTab(_id: string) {
    // No-op: workspace tabs moved into NavigationState.
  },
  reorderWorkspaceTabs(_orderedIds: string[]) {
    // No-op: workspace tabs moved into NavigationState.
  },
  setActivitySection(_section: ActivitySection) {
    // No-op: activity section concept retired; modes derive from
    // NavigationState's active tab kind.
  },
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LayoutState {
  return state;
}

function getServerSnapshot(): LayoutState {
  return state;
}

export function useLayoutState(): LayoutStore {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot,
    ...actions,
    workspaceTabs: [],
    activeWorkspaceTabId: null,
    activitySection: "sessions",
  };
}

/** @deprecated Test-only reset. Always returns terminalOpen=false now. */
export function __resetLayoutStateForTests(_next?: Partial<LayoutState>): void {
  emit();
}
