"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * NavigationState — the single source of truth for "what the user is
 * looking at". Replaces the old quintet of pathname / ?tab= / activitySection /
 * activeWorkspaceTabId / module-portal stores that constantly disagreed.
 *
 * Inspired by craft-agents-oss's NavigationState union — discriminated by
 * `type`, with type guards (`isOverview`, `isSettings`, `isSkills`,
 * `isSessions`) for narrowing.
 *
 * URL is OUTPUT, state is INPUT: state updates derive a pathname via
 * `pathFromState(...)` and the store calls `history.replaceState(...)` so
 * back/forward + reload still work. Browser navigation events (popstate)
 * are observed and re-parsed via `stateFromPath(...)`.
 */

export type ProjectTab =
  | "kanban"
  | "mission"
  | "diffs"
  | "plans"
  | "validation"
  | "metrics"
  | "activity";

export const PROJECT_TABS: readonly ProjectTab[] = [
  "kanban",
  "mission",
  "diffs",
  "plans",
  "validation",
  "metrics",
  "activity",
];

export type SettingsSection =
  | "general"
  | "appearance"
  | "keybinds"
  | "terminal"
  | "sounds"
  | "about";

export type NavigationState =
  | { type: "overview" }
  | { type: "settings"; section?: SettingsSection }
  | { type: "skills"; sessionName?: string; skillName?: string }
  | { type: "sessions"; sessionName?: string; tab?: ProjectTab };

// ---------- Type guards ----------

export function isOverview(
  state: NavigationState,
): state is Extract<NavigationState, { type: "overview" }> {
  return state.type === "overview";
}

export function isSettings(
  state: NavigationState,
): state is Extract<NavigationState, { type: "settings" }> {
  return state.type === "settings";
}

export function isSkills(
  state: NavigationState,
): state is Extract<NavigationState, { type: "skills" }> {
  return state.type === "skills";
}

export function isSessions(
  state: NavigationState,
): state is Extract<NavigationState, { type: "sessions" }> {
  return state.type === "sessions";
}

// ---------- URL <-> state ----------

function isProjectTab(value: string | null | undefined): value is ProjectTab {
  return typeof value === "string" && (PROJECT_TABS as readonly string[]).includes(value);
}

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "general",
  "appearance",
  "keybinds",
  "terminal",
  "sounds",
  "about",
];

function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Compute the URL for a navigation state. Pathname is derived from `type`;
 * tabs / settings sections / skill name ride along as query params so the
 * URL is shareable + bookmarkable.
 */
export function pathFromState(state: NavigationState): string {
  switch (state.type) {
    case "overview":
      return "/";
    case "settings": {
      const params = new URLSearchParams();
      params.set("mode", "settings");
      if (state.section && state.section !== "general") params.set("section", state.section);
      const qs = params.toString();
      return qs ? `/?${qs}` : "/";
    }
    case "skills": {
      if (!state.sessionName) {
        const params = new URLSearchParams();
        params.set("mode", "skills");
        return `/?${params.toString()}`;
      }
      const base = `/project/${encodeURIComponent(state.sessionName)}`;
      const params = new URLSearchParams();
      params.set("mode", "skills");
      if (state.skillName) params.set("skill", state.skillName);
      return `${base}?${params.toString()}`;
    }
    case "sessions": {
      if (!state.sessionName) return "/";
      const base = `/project/${encodeURIComponent(state.sessionName)}`;
      const params = new URLSearchParams();
      if (state.tab && state.tab !== "kanban") params.set("tab", state.tab);
      const qs = params.toString();
      return qs ? `${base}?${qs}` : base;
    }
  }
}

/**
 * Parse a pathname + search string into a NavigationState. Inverse of
 * `pathFromState`. Unknown / malformed inputs collapse to "overview".
 */
export function stateFromPath(pathname: string, search: string): NavigationState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const mode = params.get("mode");

  const projectMatch = /^\/project\/([^/]+)/.exec(pathname);
  if (projectMatch) {
    const sessionName = decodeURIComponent(projectMatch[1]!);
    if (mode === "skills") {
      const skill = params.get("skill") ?? undefined;
      const next: Extract<NavigationState, { type: "skills" }> = { type: "skills", sessionName };
      if (skill) next.skillName = skill;
      return next;
    }
    const tab = params.get("tab");
    return {
      type: "sessions",
      sessionName,
      tab: isProjectTab(tab) ? tab : "kanban",
    };
  }

  if (pathname === "/" || pathname === "") {
    if (mode === "settings") {
      const section = params.get("section");
      const next: Extract<NavigationState, { type: "settings" }> = { type: "settings" };
      if (isSettingsSection(section)) next.section = section;
      return next;
    }
    if (mode === "skills") {
      return { type: "skills" };
    }
    return { type: "overview" };
  }

  return { type: "overview" };
}

// ---------- Equality helper ----------

function navEquals(a: NavigationState, b: NavigationState): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "overview":
      return true;
    case "settings":
      return a.section === (b as typeof a).section;
    case "skills": {
      const bb = b as typeof a;
      return a.sessionName === bb.sessionName && a.skillName === bb.skillName;
    }
    case "sessions": {
      const bb = b as typeof a;
      return a.sessionName === bb.sessionName && a.tab === bb.tab;
    }
  }
}

// ---------- External store ----------

function readFromWindow(): NavigationState {
  if (typeof window === "undefined") return { type: "overview" };
  return stateFromPath(window.location.pathname, window.location.search);
}

let state: NavigationState = readFromWindow();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): NavigationState {
  return state;
}

// SSR + first-render snapshot. Always returns the persistence-free default
// so server HTML matches the first client render. The URL parse runs once
// the popstate listener kicks in client-side.
const serverSnapshot: NavigationState = { type: "overview" };
function getServerSnapshot(): NavigationState {
  return serverSnapshot;
}

let popstateBound = false;

function ensureBrowserSync(): void {
  if (popstateBound || typeof window === "undefined") return;
  popstateBound = true;
  // Re-read state on browser-driven URL changes (back/forward, anchor
  // navigation, manual history.pushState elsewhere). Only updates when the
  // parsed state differs to avoid spurious renders.
  const onPop = () => {
    const next = readFromWindow();
    if (navEquals(next, state)) return;
    state = next;
    emit();
  };
  window.addEventListener("popstate", onPop);
}

/**
 * Imperatively update navigation state. Writes the new URL via
 * history.replaceState (so reloads + share-links work) and fires listeners
 * for all subscribers. No-op if the new state is structurally equal to the
 * current one.
 *
 * NOTE: this does NOT call Next.js's router. Next's internal router state
 * stays in sync with `pathname` via popstate. Most consumers care about
 * NavigationState; the few that need `usePathname()` continue to read it
 * directly and stay in lockstep.
 */
export function setNavigation(next: NavigationState): void {
  if (navEquals(next, state)) return;
  state = next;
  if (typeof window !== "undefined") {
    const target = pathFromState(next);
    if (target !== `${window.location.pathname}${window.location.search}`) {
      // We use replaceState — pushState would litter history with every
      // sidebar click. The browser back button still works because real
      // route transitions (via Next router) push entries.
      window.history.replaceState(null, "", target);
    }
  }
  emit();
}

/**
 * Subscribe to NavigationState. Returns the current snapshot and
 * re-renders on change.
 *
 * Auto-binds the popstate listener on first mount. Components listing this
 * hook get back/forward sync for free.
 */
export function useNavigation(): NavigationState {
  // Safe across SSR thanks to getServerSnapshot. The hook below installs
  // the popstate listener once on the client.
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureBrowserSync();
    // Re-sync on mount in case the URL changed before the listener bound
    // (e.g. SSR → first client render path mismatch).
    const next = readFromWindow();
    if (!navEquals(next, state)) {
      state = next;
      emit();
    }
  }, []);
  return snapshot;
}

/**
 * Read the live navigation state from outside React (action callbacks,
 * imperative code paths). Not reactive — pair with setNavigation.
 */
export function getNavigationLive(): NavigationState {
  return state;
}

/** Test-only reset. */
export function __resetNavigationForTests(next: NavigationState = { type: "overview" }): void {
  state = next;
  emit();
}
