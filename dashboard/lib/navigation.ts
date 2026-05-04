"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * NavigationState — the single source of truth for "what the user is
 * looking at". Phase Z collapses the previous discriminated-union shape
 * into a tab-driven model:
 *
 *   { sessionName: string | null, openTabs: Tab[], activeTabId: string | null }
 *
 * The active session is `sessionName`. The main area renders `openTabs`
 * for that session (one strip of heterogeneous tabs: views, files,
 * skills, settings). Selecting a tab updates `activeTabId`. The
 * pre-Phase-Z mode/type union is gone — "settings mode" just means the
 * active tab kind is "settings", "skills mode" means kind is "skill".
 *
 * Compat shims (this file): the type guards `isOverview`, `isSessions`,
 * `isSkills`, `isSettings` are reimplemented on the new shape so
 * Agents 1/2 (TopBar, AppSidebar, ProjectSwitcher) keep compiling.
 * `setNavigation(...)` accepts the legacy discriminated union and
 * translates it into store ops on the new shape. `getNavigationLive()`
 * returns a legacy-shape projection so the existing test fixtures stay
 * green.
 *
 * Persistence: per-session tab strips are stored in
 * `tmux-ide.tabs.<sessionName>` so reopening a session restores its
 * tabs. Global tabs (settings, skill-without-session) live under the
 * synthetic `__global__` slot.
 *
 * URL is OUTPUT, state is INPUT: state changes derive a pathname via
 * `pathFromState(...)` and `history.replaceState(...)` reshapes the URL.
 * popstate re-parses via `stateFromPath(...)`.
 */

// ---------- Types ----------

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

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "general",
  "appearance",
  "keybinds",
  "terminal",
  "sounds",
  "about",
];

export type Tab =
  | { id: string; kind: "view"; sessionName: string; view: ProjectTab; title: string }
  | { id: string; kind: "file"; sessionName: string; path: string; title: string }
  | { id: string; kind: "skill"; sessionName: string; skillName: string; title: string }
  | { id: string; kind: "settings"; section?: SettingsSection; title: string }
  | {
      id: string;
      kind: "terminal";
      sessionName: string;
      cmd?: string[];
      cwd?: string;
      title: string;
    };

export type TabKind = Tab["kind"];

export interface NavigationState {
  sessionName: string | null;
  openTabs: Tab[];
  activeTabId: string | null;
  /**
   * @deprecated Compat field — derived from the active tab. Equivalent
   * to `activeView(state)` for view tabs, defaults to "kanban" for
   * other kinds when the session is set. Kept so legacy reads like
   * `nav.tab` (AppSidebar, ProjectPage) keep working during Phase Z.
   */
  readonly tab?: ProjectTab;
  /**
   * @deprecated Compat field — `activeSkillName(state)` projected.
   */
  readonly skillName?: string;
  /**
   * @deprecated Compat field — `activeSettingsSection(state)` projected.
   */
  readonly section?: SettingsSection;
  /**
   * @deprecated Compat field — synthetic discriminator that lets
   * legacy code do `if (nav.type === "sessions")`. Mirrors the legacy
   * NavigationState type tag for the duration of Phase Z.
   */
  readonly type?: "overview" | "settings" | "skills" | "sessions";
}

/**
 * Legacy discriminated-union shape retained as a compat surface so
 * `setNavigation({ type: "sessions", ... })` calls continue to work
 * during the Phase Z transition.
 */
export type LegacyNavigationState =
  | { type: "overview" }
  | { type: "settings"; section?: SettingsSection }
  | { type: "skills"; sessionName?: string; skillName?: string }
  | { type: "sessions"; sessionName?: string; tab?: ProjectTab };

// ---------- Type guards & accessors ----------

function activeTab(state: NavigationState): Tab | null {
  if (!state.activeTabId) return null;
  return state.openTabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

export function isOverview(state: NavigationState): boolean {
  return state.sessionName === null && activeTab(state) === null;
}

export function isSettings(state: NavigationState): boolean {
  return activeTab(state)?.kind === "settings";
}

export function isSkills(state: NavigationState): boolean {
  return activeTab(state)?.kind === "skill";
}

export function isSessions(state: NavigationState): boolean {
  if (state.sessionName === null) return false;
  return !isSettings(state) && !isSkills(state);
}

export function activeView(state: NavigationState): ProjectTab | null {
  const tab = activeTab(state);
  return tab && tab.kind === "view" ? tab.view : null;
}

export function activeSessionName(state: NavigationState): string | null {
  return state.sessionName;
}

export function activeSkillName(state: NavigationState): string | null {
  const tab = activeTab(state);
  return tab && tab.kind === "skill" ? tab.skillName : null;
}

export function activeSettingsSection(state: NavigationState): SettingsSection | null {
  const tab = activeTab(state);
  return tab && tab.kind === "settings" ? (tab.section ?? "general") : null;
}

// ---------- URL <-> legacy projection ----------

function isProjectTab(value: string | null | undefined): value is ProjectTab {
  return typeof value === "string" && (PROJECT_TABS as readonly string[]).includes(value);
}

function isSettingsSection(value: string | null | undefined): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Project NavigationState into the legacy discriminated union for URL
 * synthesis and back-compat call sites.
 */
function toLegacy(state: NavigationState): LegacyNavigationState {
  const tab = activeTab(state);
  if (tab) {
    if (tab.kind === "settings") {
      return tab.section ? { type: "settings", section: tab.section } : { type: "settings" };
    }
    if (tab.kind === "skill") {
      const next: Extract<LegacyNavigationState, { type: "skills" }> = {
        type: "skills",
        sessionName: tab.sessionName,
        skillName: tab.skillName,
      };
      return next;
    }
    if (tab.kind === "view") {
      return { type: "sessions", sessionName: tab.sessionName, tab: tab.view };
    }
    if (tab.kind === "file") {
      return { type: "sessions", sessionName: tab.sessionName, tab: "kanban" };
    }
    if (tab.kind === "terminal") {
      return { type: "sessions", sessionName: tab.sessionName, tab: "kanban" };
    }
  }
  if (state.sessionName) return { type: "sessions", sessionName: state.sessionName, tab: "kanban" };
  return { type: "overview" };
}

/**
 * Compute the URL for a navigation state. Input is the legacy
 * discriminated union; the store calls `toLegacy(...)` first so callers
 * outside this file can read the URL form via `pathFromState(legacy)`.
 */
export function pathFromState(state: LegacyNavigationState): string {
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
 * Parse a pathname + search string into the legacy discriminated union.
 * Inverse of `pathFromState`. Unknown / malformed inputs collapse to
 * "overview". Callers translate into a NavigationState via
 * `applyLegacy(...)` if they need to mutate the store.
 */
export function stateFromPath(pathname: string, search: string): LegacyNavigationState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const mode = params.get("mode");

  const projectMatch = /^\/project\/([^/]+)/.exec(pathname);
  if (projectMatch) {
    const sessionName = decodeURIComponent(projectMatch[1]!);
    if (mode === "skills") {
      const skill = params.get("skill") ?? undefined;
      const next: Extract<LegacyNavigationState, { type: "skills" }> = {
        type: "skills",
        sessionName,
      };
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
      const next: Extract<LegacyNavigationState, { type: "settings" }> = { type: "settings" };
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

// ---------- Tab construction helpers ----------

function viewTabId(sessionName: string, view: ProjectTab): string {
  return `view:${sessionName}:${view}`;
}

function skillTabId(sessionName: string, skillName: string): string {
  return `skill:${sessionName}:${skillName}`;
}

function fileTabId(sessionName: string, path: string): string {
  return `file:${sessionName}:${path}`;
}

function settingsTabId(section?: SettingsSection): string {
  return section ? `settings:${section}` : "settings:";
}

/** Stable id for the project's "default" terminal tab (the tmux-ide one). */
export function defaultTerminalTabId(sessionName: string): string {
  return `terminal:${sessionName}:default`;
}

function adhocTerminalTabId(sessionName: string): string {
  // Browser-only random id avoids collisions across persisted strips.
  const seed =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `terminal:${sessionName}:${seed}`;
}

export function viewTab(sessionName: string, view: ProjectTab, title?: string): Tab {
  return {
    id: viewTabId(sessionName, view),
    kind: "view",
    sessionName,
    view,
    title: title ?? view,
  };
}

export function skillTab(sessionName: string, skillName: string, title?: string): Tab {
  return {
    id: skillTabId(sessionName, skillName),
    kind: "skill",
    sessionName,
    skillName,
    title: title ?? `Skill · ${skillName}`,
  };
}

export function fileTab(sessionName: string, path: string, title?: string): Tab {
  return {
    id: fileTabId(sessionName, path),
    kind: "file",
    sessionName,
    path,
    title: title ?? path.split("/").pop() ?? path,
  };
}

export function settingsTab(section?: SettingsSection, title?: string): Tab {
  return {
    id: settingsTabId(section),
    kind: "settings",
    title: title ?? "Settings",
    ...(section ? { section } : {}),
  };
}

export interface TerminalTabOptions {
  /** Stable id (e.g. defaultTerminalTabId(...)). When omitted a fresh ad-hoc id is generated. */
  id?: string;
  cmd?: string[];
  cwd?: string;
  title?: string;
}

export function terminalTab(sessionName: string, options: TerminalTabOptions = {}): Tab {
  return {
    id: options.id ?? adhocTerminalTabId(sessionName),
    kind: "terminal",
    sessionName,
    title: options.title ?? "shell",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.cmd ? { cmd: options.cmd } : {}),
  };
}

// ---------- Persistence ----------

const GLOBAL_TABS_KEY = "__global__";

interface PersistedTabStrip {
  openTabs: Tab[];
  activeTabId: string | null;
}

function persistKey(sessionName: string | null): string {
  return `tmux-ide.tabs.${sessionName ?? GLOBAL_TABS_KEY}`;
}

function readPersistedStrip(sessionName: string | null): PersistedTabStrip | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(persistKey(sessionName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as { openTabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(value.openTabs)) return null;
    const tabs = value.openTabs.filter(isValidTab);
    const id =
      typeof value.activeTabId === "string" && tabs.some((t) => t.id === value.activeTabId)
        ? value.activeTabId
        : (tabs[0]?.id ?? null);
    return { openTabs: tabs, activeTabId: id };
  } catch {
    return null;
  }
}

function writePersistedStrip(sessionName: string | null, strip: PersistedTabStrip): void {
  if (typeof window === "undefined") return;
  try {
    if (strip.openTabs.length === 0) {
      window.localStorage.removeItem(persistKey(sessionName));
      return;
    }
    window.localStorage.setItem(persistKey(sessionName), JSON.stringify(strip));
  } catch {
    // localStorage unavailable / quota — silent.
  }
}

function isValidTab(value: unknown): value is Tab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Record<string, unknown>;
  if (typeof tab.id !== "string" || typeof tab.title !== "string") return false;
  switch (tab.kind) {
    case "view":
      return (
        typeof tab.sessionName === "string" &&
        typeof tab.view === "string" &&
        (PROJECT_TABS as readonly string[]).includes(tab.view as string)
      );
    case "file":
      return typeof tab.sessionName === "string" && typeof tab.path === "string";
    case "skill":
      return typeof tab.sessionName === "string" && typeof tab.skillName === "string";
    case "settings":
      return tab.section === undefined || isSettingsSection(tab.section as string);
    case "terminal":
      return (
        typeof tab.sessionName === "string" &&
        (tab.cwd === undefined || typeof tab.cwd === "string") &&
        (tab.cmd === undefined ||
          (Array.isArray(tab.cmd) && tab.cmd.every((part) => typeof part === "string")))
      );
    default:
      return false;
  }
}

// ---------- Store ----------

interface InternalState extends NavigationState {
  /** Per-session tab strips so switching sessions restores their tabs. */
  tabsBySession: Map<string | null, PersistedTabStrip>;
}

function emptyState(): InternalState {
  return {
    sessionName: null,
    openTabs: [],
    activeTabId: null,
    tabsBySession: new Map(),
  };
}

function readFromWindow(): InternalState {
  if (typeof window === "undefined") return emptyState();
  const legacy = stateFromPath(window.location.pathname, window.location.search);
  return applyLegacyToFresh(legacy);
}

function applyLegacyToFresh(legacy: LegacyNavigationState): InternalState {
  const next = emptyState();
  applyLegacy(next, legacy);
  return next;
}

/**
 * Translate a legacy-shape navigation update into mutations on the
 * given internal state. Used by `setNavigation`, popstate, and the
 * fresh-state initializer.
 */
function applyLegacy(state: InternalState, legacy: LegacyNavigationState): void {
  switch (legacy.type) {
    case "overview": {
      saveCurrentStrip(state);
      state.sessionName = null;
      // Restore global strip if any.
      const strip = state.tabsBySession.get(null) ?? readPersistedStrip(null);
      if (strip) {
        state.openTabs = strip.openTabs;
        state.activeTabId = strip.activeTabId;
      } else {
        state.openTabs = [];
        state.activeTabId = null;
      }
      return;
    }
    case "settings": {
      saveCurrentStrip(state);
      state.sessionName = null;
      const strip = state.tabsBySession.get(null) ?? readPersistedStrip(null) ?? {
        openTabs: [],
        activeTabId: null,
      };
      state.openTabs = strip.openTabs;
      state.activeTabId = strip.activeTabId;
      const tab = settingsTab(legacy.section, "Settings");
      ensureTab(state, tab);
      state.activeTabId = tab.id;
      return;
    }
    case "skills": {
      saveCurrentStrip(state);
      state.sessionName = legacy.sessionName ?? null;
      const strip =
        state.tabsBySession.get(state.sessionName) ?? readPersistedStrip(state.sessionName);
      state.openTabs = strip?.openTabs ?? [];
      state.activeTabId = strip?.activeTabId ?? null;
      if (legacy.sessionName && legacy.skillName) {
        const tab = skillTab(legacy.sessionName, legacy.skillName);
        ensureTab(state, tab);
        state.activeTabId = tab.id;
      } else if (state.openTabs.length === 0 && legacy.sessionName) {
        // Skills-without-skill on a session: open default kanban so the
        // shell has something to render.
        const fallback = viewTab(legacy.sessionName, "kanban");
        ensureTab(state, fallback);
        state.activeTabId = fallback.id;
      }
      return;
    }
    case "sessions": {
      saveCurrentStrip(state);
      state.sessionName = legacy.sessionName ?? null;
      if (!legacy.sessionName) {
        const strip = state.tabsBySession.get(null) ?? readPersistedStrip(null);
        state.openTabs = strip?.openTabs ?? [];
        state.activeTabId = strip?.activeTabId ?? null;
        return;
      }
      const strip =
        state.tabsBySession.get(legacy.sessionName) ?? readPersistedStrip(legacy.sessionName);
      state.openTabs = strip?.openTabs ?? [];
      state.activeTabId = strip?.activeTabId ?? null;
      const tab = viewTab(legacy.sessionName, legacy.tab ?? "kanban");
      ensureTab(state, tab);
      state.activeTabId = tab.id;
      return;
    }
  }
}

function saveCurrentStrip(state: InternalState): void {
  const strip: PersistedTabStrip = {
    openTabs: state.openTabs,
    activeTabId: state.activeTabId,
  };
  state.tabsBySession.set(state.sessionName, strip);
  writePersistedStrip(state.sessionName, strip);
}

function ensureTab(state: InternalState, tab: Tab): void {
  const existing = state.openTabs.find((t) => t.id === tab.id);
  if (existing) return;
  state.openTabs = [...state.openTabs, tab];
}

let state: InternalState = readFromWindow();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(): void {
  saveCurrentStrip(state);
  if (typeof window !== "undefined") {
    const target = pathFromState(toLegacy(state));
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", target);
    }
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publicSnapshot(): NavigationState {
  const projection: NavigationState = {
    sessionName: state.sessionName,
    openTabs: state.openTabs,
    activeTabId: state.activeTabId,
  };
  // Derive legacy compat fields. These mirror the discriminated-union
  // shape so call sites doing `nav.tab` / `nav.skillName` / `nav.type`
  // keep working without churn. Mutable assignment is fine because the
  // returned snapshot is fresh per refresh.
  const legacy = toLegacy(state);
  (projection as { type?: NavigationState["type"] }).type = legacy.type;
  if (legacy.type === "sessions" && legacy.tab) {
    (projection as { tab?: ProjectTab }).tab = legacy.tab;
  }
  if (legacy.type === "skills" && legacy.skillName) {
    (projection as { skillName?: string }).skillName = legacy.skillName;
  }
  if (legacy.type === "settings" && legacy.section) {
    (projection as { section?: SettingsSection }).section = legacy.section;
  }
  return projection;
}

let cachedSnapshot: NavigationState = publicSnapshot();

function getSnapshot(): NavigationState {
  return cachedSnapshot;
}

const serverSnapshot: NavigationState = {
  sessionName: null,
  openTabs: [],
  activeTabId: null,
  type: "overview",
};

function getServerSnapshot(): NavigationState {
  return serverSnapshot;
}

function refreshSnapshot(): void {
  cachedSnapshot = publicSnapshot();
}

let popstateBound = false;

function ensureBrowserSync(): void {
  if (popstateBound || typeof window === "undefined") return;
  popstateBound = true;
  const onPop = () => {
    const legacy = stateFromPath(window.location.pathname, window.location.search);
    applyLegacy(state, legacy);
    refreshSnapshot();
    emit();
  };
  window.addEventListener("popstate", onPop);
}

// ---------- Public API ----------

/**
 * Imperative legacy entrypoint. Accepts the discriminated-union shape
 * for compat with Z1/Z2 call sites and translates into the new tabbed
 * state. Also accepts the structural NavigationState for forward-compat
 * with new code paths that already build the new shape.
 */
export function setNavigation(next: LegacyNavigationState | NavigationState): void {
  if (isStructuralState(next)) {
    saveCurrentStrip(state);
    state.sessionName = next.sessionName;
    state.openTabs = [...next.openTabs];
    state.activeTabId = next.activeTabId;
  } else {
    applyLegacy(state, next);
  }
  refreshSnapshot();
  commit();
}

function isStructuralState(value: LegacyNavigationState | NavigationState): value is NavigationState {
  return "openTabs" in value && Array.isArray((value as NavigationState).openTabs);
}

export function setActiveSession(name: string | null): void {
  if (state.sessionName === name) return;
  saveCurrentStrip(state);
  state.sessionName = name;
  const strip = state.tabsBySession.get(name) ?? readPersistedStrip(name);
  state.openTabs = strip?.openTabs ?? [];
  state.activeTabId = strip?.activeTabId ?? null;
  // Default project: open kanban tab.
  if (name && state.openTabs.length === 0) {
    const tab = viewTab(name, "kanban");
    ensureTab(state, tab);
    state.activeTabId = tab.id;
  }
  refreshSnapshot();
  commit();
}

export function openTab(tab: Tab): void {
  const existing = state.openTabs.find((candidate) => candidate.id === tab.id);
  if (!existing) {
    state.openTabs = [...state.openTabs, tab];
  }
  state.activeTabId = tab.id;
  refreshSnapshot();
  commit();
}

export function closeTab(tabId: string): void {
  const index = state.openTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return;
  const remaining = state.openTabs.filter((tab) => tab.id !== tabId);
  state.openTabs = remaining;
  if (state.activeTabId === tabId) {
    const fallback = remaining[index - 1] ?? remaining[index] ?? null;
    state.activeTabId = fallback?.id ?? null;
  }
  refreshSnapshot();
  commit();
}

export function activateTab(tabId: string): void {
  if (state.activeTabId === tabId) return;
  if (!state.openTabs.some((tab) => tab.id === tabId)) return;
  state.activeTabId = tabId;
  refreshSnapshot();
  commit();
}

/**
 * Open a terminal tab for the given session. If a tab with the same id
 * already exists (e.g. the project's default terminal id), it is
 * activated rather than recreated. Generated ad-hoc terminals always get
 * a fresh id, so each call to `openTerminalTab` without an explicit id
 * creates a new shell instance.
 */
export function openTerminalTab(
  sessionName: string,
  options: TerminalTabOptions = {},
): Tab {
  const tab = terminalTab(sessionName, options);
  openTab(tab);
  return tab;
}

/**
 * Ensure the project's default tmux-ide terminal tab exists and is
 * active. Idempotent — if the tab already exists this just activates it.
 * Returns the active terminal tab.
 */
export function ensureDefaultTerminal(sessionName: string, cwd?: string): Tab {
  const id = defaultTerminalTabId(sessionName);
  const existing = state.openTabs.find((t) => t.id === id);
  if (existing) {
    activateTab(id);
    return existing;
  }
  return openTerminalTab(sessionName, {
    id,
    title: "tmux-ide",
    cmd: ["__login_shell__", "tmux-ide"],
    ...(cwd ? { cwd } : {}),
  });
}

export function reorderTabs(orderedIds: string[]): void {
  const byId = new Map(state.openTabs.map((tab) => [tab.id, tab]));
  const ordered: Tab[] = [];
  for (const id of orderedIds) {
    const tab = byId.get(id);
    if (tab) {
      ordered.push(tab);
      byId.delete(id);
    }
  }
  for (const tab of byId.values()) ordered.push(tab);
  state.openTabs = ordered;
  refreshSnapshot();
  commit();
}

export function useNavigation(): NavigationState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    ensureBrowserSync();
    const next = readFromWindow();
    // If the in-memory state is already aligned with the URL session,
    // keep the active-tab choice from memory — the URL only encodes
    // session + view tab; it cannot describe which terminal / skill /
    // settings tab the user has focused. Only re-seed from URL when the
    // session itself differs (cold load, popstate to a different route).
    if (next.sessionName !== state.sessionName) {
      state = next;
      refreshSnapshot();
      emit();
      return;
    }
    if (
      state.openTabs.length === 0 &&
      (next.openTabs.length > 0 || next.activeTabId !== null)
    ) {
      state = next;
      refreshSnapshot();
      emit();
    }
  }, []);
  return snapshot;
}

/**
 * Live (non-reactive) accessor. Returns the legacy discriminated-union
 * projection so existing test fixtures (`ProjectSwitcher.test.tsx`)
 * keep asserting on `next.type`. New consumers should read
 * `useNavigation()` for the structural shape.
 */
export function getNavigationLive(): LegacyNavigationState {
  return toLegacy(state);
}

/**
 * Live (non-reactive) accessor for the structural NavigationState.
 * Returns the new shape `{ sessionName, openTabs, activeTabId }`. Pair
 * with the imperative actions for tests + outside-React code paths.
 */
export function getNavigationStateLive(): NavigationState {
  return publicSnapshot();
}

/** Test-only reset. Accepts the legacy shape for back-compat. */
export function __resetNavigationForTests(
  next: LegacyNavigationState | NavigationState = { type: "overview" },
): void {
  if (typeof window !== "undefined") {
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith("tmux-ide.tabs.")) keys.push(key);
      }
      for (const key of keys) window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }
  if (isStructuralState(next)) {
    state = {
      sessionName: next.sessionName,
      openTabs: [...next.openTabs],
      activeTabId: next.activeTabId,
      tabsBySession: new Map(),
    };
  } else {
    state = applyLegacyToFresh(next);
  }
  refreshSnapshot();
  emit();
}

