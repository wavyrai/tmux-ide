import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  RevisionConflictError,
  type JsonValue,
  type ProjectRuntimeDocument,
  type ProjectRuntimeRepository,
} from "../../lib/project-runtime-repository.ts";
import type { HostedPanelKind, HostedPanelView } from "./panel-host.ts";
import { findFirstHostedViewForPanel, findHostedViewById } from "./panel-host.ts";
import type { Tab } from "./app-state.ts";
import { panelKindFromLegacyTab } from "./panel-host.ts";
import type { CompositeLayoutState } from "./composite-layout.ts";
import type {
  WorkbenchDockMode,
  WorkbenchDockTabId,
  WorkbenchFocusZone,
} from "./workspace/workbench-shell.ts";

export const WORKSPACE_UI_STATE_PATH = "ui/workspace.json";
export const WORKSPACE_UI_STATE_VERSION = 2;
export const LEGACY_WORKSPACE_UI_STATE_VERSION = 1;
export const WORKSPACE_UI_STATE_MAX_VIEWS = 64;
export const WORKSPACE_UI_STATE_MAX_ID_LENGTH = 128;
export const WORKSPACE_UI_STATE_MAX_PATH_LENGTH = 4096;

export type WorkspaceUiStateDiagnosticCode =
  | "MISSING"
  | "MALFORMED"
  | "UNSUPPORTED_VERSION"
  | "MIGRATED"
  | "OVERSIZED"
  | "INVALID_FIELD"
  | "READ_FAILED"
  | "WRITE_FAILED"
  | "STALE"
  | "NOT_LOADED"
  | "WRITE_PROTECTED";

export interface WorkspaceUiStateDiagnostic {
  code: WorkspaceUiStateDiagnosticCode;
  path: string;
  message: string;
}

export interface WorkspaceActiveViewState {
  viewId: string;
  panel: HostedPanelKind;
}

export interface WorkspaceFilesViewState {
  panel: "files";
  openPath: string | null;
  selectedPath: string | null;
  layout?: WorkspaceCompositeLayoutViewState;
}

export interface WorkspaceDiffViewState {
  panel: "diff";
  selectedPath: string | null;
  layout?: WorkspaceCompositeLayoutViewState;
}

export interface WorkspaceMissionsViewState {
  panel: "missions";
  selectedMissionId: string | null;
  selectedTaskId: string | null;
  navigation?: WorkspaceMissionsNavigationState;
  layout?: WorkspaceCompositeLayoutViewState;
}

export interface WorkspaceMissionsNavigationState {
  mode: "board" | "history" | "detail";
  density: "compact" | "comfortable" | "detailed";
  selectedColumn: "planned" | "running" | "blocked" | "review" | "done";
  preferredRow: number;
  columnScroll: Record<"planned" | "running" | "blocked" | "review" | "done", number>;
  historyScroll: number;
  horizontalOffset: number;
  detailReturnMode: "board" | "history";
  detailSection: "tasks" | "timeline" | "attempts" | "proof";
  detailScroll: Record<"tasks" | "timeline" | "attempts" | "proof", number>;
  collapsedColumns: Record<"planned" | "running" | "blocked" | "review" | "done", boolean>;
  zoomColumn: "planned" | "running" | "blocked" | "review" | "done" | null;
  zoomRestoreHorizontalOffset: number | null;
}

export interface WorkspaceEmptyViewState {
  panel: "home" | "terminals";
  layout?: WorkspaceCompositeLayoutViewState;
}

export type WorkspaceCompositeLayoutViewState = CompositeLayoutState;

export type WorkspaceViewState =
  | WorkspaceFilesViewState
  | WorkspaceDiffViewState
  | WorkspaceMissionsViewState
  | WorkspaceEmptyViewState;

/** V2 keeps view-scoped composite layout only; dock surface memory lives in `surfaces`. */
export interface WorkspaceLayoutViewState {
  panel: HostedPanelKind;
  layout?: WorkspaceCompositeLayoutViewState;
}

export interface WorkspaceActivitySurfaceState {
  selectedRowId: string | null;
  scrollOffset: number;
}

export interface WorkspaceSurfaceStates {
  files: Omit<WorkspaceFilesViewState, "panel" | "layout">;
  diff: Omit<WorkspaceDiffViewState, "panel" | "layout">;
  missions: Omit<WorkspaceMissionsViewState, "panel" | "layout">;
  activity: WorkspaceActivitySurfaceState;
}

export interface WorkspaceDockState {
  activeTab: WorkbenchDockTabId;
  mode: WorkbenchDockMode;
  preferredHeight: number | null;
  focusZone: WorkbenchFocusZone;
}

export interface WorkspaceUiStateV2 {
  version: typeof WORKSPACE_UI_STATE_VERSION;
  active: WorkspaceActiveViewState | null;
  dock: WorkspaceDockState;
  surfaces: WorkspaceSurfaceStates;
  views: Record<string, WorkspaceLayoutViewState>;
}

/** Exact legacy payload accepted only by the deterministic V1 migration path. */
export interface WorkspaceUiStateV1 {
  version: typeof LEGACY_WORKSPACE_UI_STATE_VERSION;
  active: WorkspaceActiveViewState | null;
  views: Record<string, WorkspaceViewState>;
}

export interface ParsedWorkspaceUiState {
  state: WorkspaceUiStateV2;
  diagnostics: WorkspaceUiStateDiagnostic[];
}

export interface LoadedWorkspaceUiState extends ParsedWorkspaceUiState {
  revision: number | null;
  writeProtected: boolean;
}

export interface WriteWorkspaceUiStateResult {
  state: WorkspaceUiStateV2;
  revision: number | null;
  diagnostics: WorkspaceUiStateDiagnostic[];
}

export interface WorkspaceViewRestoreChoice {
  view: HostedPanelView | null;
  reason: "explicit" | "persisted-id" | "persisted-panel" | "legacy-tab" | "first" | "none";
}

export interface WorkspaceUiSaveRequest {
  repository: ProjectRuntimeRepository;
  revision: number | null;
  current: WorkspaceUiStateV2;
  next: WorkspaceUiStateV2;
  touchedViewIds: ReadonlySet<string>;
  touchedSurfaceIds?: ReadonlySet<keyof WorkspaceSurfaceStates>;
  touchedDock?: boolean;
  touchedActiveView?: boolean;
}

export interface WorkspaceUiControllerSnapshot {
  loaded: boolean;
  repository: ProjectRuntimeRepository | null;
  revision: number | null;
  state: WorkspaceUiStateV2;
  generation: number;
}

export interface WorkspaceUiControllerSaveResult {
  saved: boolean;
  skipped: boolean;
  diagnostics: WorkspaceUiStateDiagnostic[];
}

const PANELS: readonly HostedPanelKind[] = ["home", "terminals", "files", "diff", "missions"];
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MISSION_COLUMNS = ["planned", "running", "blocked", "review", "done"] as const;
const MISSION_MODES = ["board", "history", "detail"] as const;
const MISSION_DENSITIES = ["compact", "comfortable", "detailed"] as const;
const MISSION_DETAIL_SECTIONS = ["tasks", "timeline", "attempts", "proof"] as const;
const DOCK_TABS = ["files", "changes", "missions", "activity"] as const;
const DOCK_MODES = ["collapsed", "open", "maximized"] as const;
const FOCUS_ZONES = ["canvas", "dock-tabs", "dock-body"] as const;

export const DEFAULT_WORKSPACE_UI_STATE: WorkspaceUiStateV2 = Object.freeze({
  version: WORKSPACE_UI_STATE_VERSION,
  active: null,
  dock: Object.freeze({
    activeTab: "files",
    mode: "open",
    preferredHeight: null,
    focusZone: "canvas",
  }),
  surfaces: Object.freeze({
    files: Object.freeze({ openPath: null, selectedPath: null }),
    diff: Object.freeze({ selectedPath: null }),
    missions: Object.freeze({ selectedMissionId: null, selectedTaskId: null }),
    activity: Object.freeze({ selectedRowId: null, scrollOffset: 0 }),
  }),
  views: Object.freeze({}),
});

function diagnostic(
  code: WorkspaceUiStateDiagnosticCode,
  path: string,
  message: string,
): WorkspaceUiStateDiagnostic {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPanel(value: unknown): value is HostedPanelKind {
  return typeof value === "string" && (PANELS as readonly string[]).includes(value);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > WORKSPACE_UI_STATE_MAX_ID_LENGTH) return null;
  if (value.includes("\0")) return null;
  if (RESERVED_OBJECT_KEYS.has(value)) return null;
  return value;
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

function cleanPath(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > WORKSPACE_UI_STATE_MAX_PATH_LENGTH) return null;
  if (value.includes("\0")) return null;
  return value;
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : null;
}

function cleanNonnegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function cleanDockState(
  value: unknown,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceDockState {
  if (!isRecord(value)) {
    if (value !== undefined) {
      diagnostics.push(diagnostic("INVALID_FIELD", "$.dock", "dock state must be an object"));
    }
    return { ...DEFAULT_WORKSPACE_UI_STATE.dock };
  }
  return {
    activeTab: oneOf(value.activeTab, DOCK_TABS) ?? "files",
    mode: oneOf(value.mode, DOCK_MODES) ?? "open",
    preferredHeight:
      value.preferredHeight === null ? null : cleanNonnegativeInt(value.preferredHeight),
    focusZone: oneOf(value.focusZone, FOCUS_ZONES) ?? "canvas",
  };
}

function cleanSurfaceStates(
  value: unknown,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceSurfaceStates {
  if (!isRecord(value)) {
    if (value !== undefined) {
      diagnostics.push(
        diagnostic("INVALID_FIELD", "$.surfaces", "surface state must be an object"),
      );
    }
    return defaultWorkspaceSurfaceStates();
  }
  const files = isRecord(value.files) ? value.files : {};
  const diff = isRecord(value.diff) ? value.diff : {};
  const missions = isRecord(value.missions) ? value.missions : {};
  const activity = isRecord(value.activity) ? value.activity : {};
  const navigation = cleanMissionsNavigation(
    missions.navigation,
    "$.surfaces.missions.navigation",
    diagnostics,
  );
  return {
    files: {
      openPath: cleanPath(files.openPath),
      selectedPath: cleanPath(files.selectedPath),
    },
    diff: { selectedPath: cleanPath(diff.selectedPath) },
    missions: {
      selectedMissionId: cleanId(missions.selectedMissionId),
      selectedTaskId: cleanId(missions.selectedTaskId),
      ...(navigation ? { navigation } : {}),
    },
    activity: {
      selectedRowId: cleanId(activity.selectedRowId),
      scrollOffset: cleanNonnegativeInt(activity.scrollOffset) ?? 0,
    },
  };
}

function cleanNumberRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], number> {
  const out = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Keys[number], number>;
  if (!isRecord(value)) return out;
  for (const key of keys as readonly Keys[number][]) {
    const clean = cleanNonnegativeInt(value[key]);
    if (clean !== null) out[key] = clean;
  }
  return out;
}

function cleanBooleanRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], boolean> {
  const out = Object.fromEntries(keys.map((key) => [key, false])) as Record<Keys[number], boolean>;
  if (!isRecord(value)) return out;
  for (const key of keys as readonly Keys[number][]) out[key] = value[key] === true;
  return out;
}

function cleanMissionsNavigation(
  value: unknown,
  path: string,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceMissionsNavigationState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("INVALID_FIELD", path, "missions navigation must be an object"));
    return null;
  }
  const mode = oneOf(value.mode, MISSION_MODES) ?? "board";
  const density = oneOf(value.density, MISSION_DENSITIES) ?? "comfortable";
  const selectedColumn = oneOf(value.selectedColumn, MISSION_COLUMNS) ?? "planned";
  const detailReturnMode = oneOf(value.detailReturnMode, ["board", "history"] as const) ?? "board";
  const detailSection = oneOf(value.detailSection, MISSION_DETAIL_SECTIONS) ?? "tasks";
  const zoomColumn = oneOf(value.zoomColumn, MISSION_COLUMNS);
  const zoomRestoreHorizontalOffset = cleanNonnegativeInt(value.zoomRestoreHorizontalOffset);
  return {
    mode,
    density,
    selectedColumn,
    preferredRow: cleanNonnegativeInt(value.preferredRow) ?? 0,
    columnScroll: cleanNumberRecord(value.columnScroll, MISSION_COLUMNS),
    historyScroll: cleanNonnegativeInt(value.historyScroll) ?? 0,
    horizontalOffset: cleanNonnegativeInt(value.horizontalOffset) ?? 0,
    detailReturnMode,
    detailSection,
    detailScroll: cleanNumberRecord(value.detailScroll, MISSION_DETAIL_SECTIONS),
    collapsedColumns: cleanBooleanRecord(value.collapsedColumns, MISSION_COLUMNS),
    zoomColumn,
    zoomRestoreHorizontalOffset,
  };
}

function cleanActive(
  value: unknown,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceActiveViewState | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("INVALID_FIELD", "$.active", "active view must be an object"));
    return null;
  }
  const viewId = cleanId(value.viewId);
  const panel = value.panel;
  if (!viewId || !isPanel(panel)) {
    diagnostics.push(
      diagnostic("INVALID_FIELD", "$.active", "active view requires a bounded viewId and panel"),
    );
    return null;
  }
  return { viewId, panel };
}

function cleanViewState(
  key: string,
  value: unknown,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceViewState | null {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("INVALID_FIELD", `$.views.${key}`, "view state must be an object"));
    return null;
  }
  const panel = value.panel;
  if (!isPanel(panel)) {
    diagnostics.push(diagnostic("INVALID_FIELD", `$.views.${key}.panel`, "panel is unsupported"));
    return null;
  }
  const layout = cleanLayoutState(value.layout, `$.views.${key}.layout`, diagnostics);
  if (panel === "files") {
    return {
      panel,
      openPath: cleanPath(value.openPath),
      selectedPath: cleanPath(value.selectedPath),
      ...(layout ? { layout } : {}),
    };
  }
  if (panel === "diff") {
    return {
      panel,
      selectedPath: cleanPath(value.selectedPath),
      ...(layout ? { layout } : {}),
    };
  }
  if (panel === "missions") {
    const navigation = cleanMissionsNavigation(
      value.navigation,
      `$.views.${key}.navigation`,
      diagnostics,
    );
    return {
      panel,
      selectedMissionId: cleanId(value.selectedMissionId),
      selectedTaskId: cleanId(value.selectedTaskId),
      ...(navigation ? { navigation } : {}),
      ...(layout ? { layout } : {}),
    };
  }
  return { panel, ...(layout ? { layout } : {}) };
}

function cleanLayoutViewState(
  key: string,
  value: unknown,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceLayoutViewState | null {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("INVALID_FIELD", `$.views.${key}`, "view state must be an object"));
    return null;
  }
  const panel = value.panel;
  if (!isPanel(panel)) {
    diagnostics.push(diagnostic("INVALID_FIELD", `$.views.${key}.panel`, "panel is unsupported"));
    return null;
  }
  const layout = cleanLayoutState(value.layout, `$.views.${key}.layout`, diagnostics);
  return { panel, ...(layout ? { layout } : {}) };
}

function cleanLayoutState(
  value: unknown,
  path: string,
  diagnostics: WorkspaceUiStateDiagnostic[],
): WorkspaceCompositeLayoutViewState | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("INVALID_FIELD", path, "layout state must be an object"));
    return null;
  }
  const focusedLeafId = cleanId(value.focusedLeafId);
  const activeTabs: Record<string, string> = {};
  if (isRecord(value.activeTabs)) {
    for (const [key, raw] of Object.entries(value.activeTabs).slice(0, 64)) {
      const id = cleanId(key);
      const childId = cleanId(raw);
      if (id && childId) activeTabs[id] = childId;
    }
  } else if (value.activeTabs !== undefined) {
    diagnostics.push(
      diagnostic("INVALID_FIELD", `${path}.activeTabs`, "activeTabs must be an object"),
    );
  }
  const splitWeights: Record<string, number[]> = {};
  if (isRecord(value.splitWeights)) {
    for (const [key, raw] of Object.entries(value.splitWeights).slice(0, 64)) {
      const id = cleanId(key);
      if (
        id &&
        Array.isArray(raw) &&
        raw.length >= 2 &&
        raw.length <= 4 &&
        raw.every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
      ) {
        splitWeights[id] = raw.map((item) => item as number);
      }
    }
  } else if (value.splitWeights !== undefined) {
    diagnostics.push(
      diagnostic("INVALID_FIELD", `${path}.splitWeights`, "splitWeights must be an object"),
    );
  }
  if (
    !focusedLeafId &&
    Object.keys(activeTabs).length === 0 &&
    Object.keys(splitWeights).length === 0
  )
    return null;
  return { focusedLeafId, activeTabs, splitWeights };
}

function cloneState(state: WorkspaceUiStateV2): WorkspaceUiStateV2 {
  return parseWorkspaceUiStateJson(serializeWorkspaceUiState(state)).state;
}

function defaultWorkspaceSurfaceStates(): WorkspaceSurfaceStates {
  return {
    files: { openPath: null, selectedPath: null },
    diff: { selectedPath: null },
    missions: { selectedMissionId: null, selectedTaskId: null },
    activity: { selectedRowId: null, scrollOffset: 0 },
  };
}

export function defaultWorkspaceUiState(): WorkspaceUiStateV2 {
  return {
    version: WORKSPACE_UI_STATE_VERSION,
    active: null,
    dock: { ...DEFAULT_WORKSPACE_UI_STATE.dock },
    surfaces: defaultWorkspaceSurfaceStates(),
    views: {},
  };
}

export function parseWorkspaceUiStateJson(raw: string): ParsedWorkspaceUiState {
  const diagnostics: WorkspaceUiStateDiagnostic[] = [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      state: defaultWorkspaceUiState(),
      diagnostics: [diagnostic("MALFORMED", "$", "workspace UI state is not valid JSON")],
    };
  }
  return parseWorkspaceUiStateValue(value, diagnostics);
}

export function parseWorkspaceUiStateValue(
  value: unknown,
  diagnostics: WorkspaceUiStateDiagnostic[] = [],
): ParsedWorkspaceUiState {
  if (!isRecord(value)) {
    diagnostics.push(diagnostic("MALFORMED", "$", "workspace UI state must be an object"));
    return { state: defaultWorkspaceUiState(), diagnostics };
  }
  if (value.version === LEGACY_WORKSPACE_UI_STATE_VERSION) {
    return migrateWorkspaceUiStateV1(value, diagnostics);
  }
  if (value.version !== WORKSPACE_UI_STATE_VERSION) {
    diagnostics.push(
      diagnostic(
        Number.isInteger(value.version) ? "UNSUPPORTED_VERSION" : "MALFORMED",
        "$.version",
        `unsupported workspace UI state version ${String(value.version)}`,
      ),
    );
    return { state: defaultWorkspaceUiState(), diagnostics };
  }

  const views: Record<string, WorkspaceLayoutViewState> = {};
  if (isRecord(value.views)) {
    const entries = Object.entries(value.views);
    if (entries.length > WORKSPACE_UI_STATE_MAX_VIEWS) {
      diagnostics.push(
        diagnostic(
          "OVERSIZED",
          "$.views",
          `workspace UI state kept the first ${WORKSPACE_UI_STATE_MAX_VIEWS} views`,
        ),
      );
    }
    for (const [key, rawView] of entries.slice(0, WORKSPACE_UI_STATE_MAX_VIEWS)) {
      const id = cleanId(key);
      if (!id) {
        diagnostics.push(diagnostic("INVALID_FIELD", "$.views", "dropped invalid view id"));
        continue;
      }
      const clean = cleanLayoutViewState(id, rawView, diagnostics);
      if (clean) views[id] = clean;
    }
  } else if (value.views !== undefined) {
    diagnostics.push(diagnostic("INVALID_FIELD", "$.views", "views must be an object"));
  }

  return {
    state: {
      version: WORKSPACE_UI_STATE_VERSION,
      active: cleanActive(value.active, diagnostics),
      dock: cleanDockState(value.dock, diagnostics),
      surfaces: cleanSurfaceStates(value.surfaces, diagnostics),
      views,
    },
    diagnostics,
  };
}

function migrateWorkspaceUiStateV1(
  value: Record<string, unknown>,
  diagnostics: WorkspaceUiStateDiagnostic[],
): ParsedWorkspaceUiState {
  const legacyViews: Record<string, WorkspaceViewState> = {};
  if (isRecord(value.views)) {
    for (const [key, rawView] of Object.entries(value.views).slice(
      0,
      WORKSPACE_UI_STATE_MAX_VIEWS,
    )) {
      const id = cleanId(key);
      if (!id) continue;
      const clean = cleanViewState(id, rawView, diagnostics);
      if (clean) legacyViews[id] = clean;
    }
  }
  const active = cleanActive(value.active, diagnostics);
  const pick = <Panel extends WorkspaceViewState["panel"]>(panel: Panel) => {
    const activeEntry = active?.panel === panel ? legacyViews[active.viewId] : null;
    if (activeEntry?.panel === panel) return activeEntry;
    return Object.keys(legacyViews)
      .sort()
      .map((id) => legacyViews[id]!)
      .find((entry) => entry.panel === panel);
  };
  const files = pick("files") as WorkspaceFilesViewState | undefined;
  const diff = pick("diff") as WorkspaceDiffViewState | undefined;
  const missions = pick("missions") as WorkspaceMissionsViewState | undefined;
  const activeTab = dockTabFromPanel(active?.panel) ?? "files";
  diagnostics.push(
    diagnostic("MIGRATED", "$.version", "workspace UI state migrated from version 1 to version 2"),
  );
  return {
    state: {
      version: WORKSPACE_UI_STATE_VERSION,
      active,
      dock: {
        activeTab,
        mode: "open",
        preferredHeight: null,
        focusZone: dockTabFromPanel(active?.panel) ? "dock-body" : "canvas",
      },
      surfaces: {
        files: {
          openPath: files?.openPath ?? null,
          selectedPath: files?.selectedPath ?? null,
        },
        diff: { selectedPath: diff?.selectedPath ?? null },
        missions: {
          selectedMissionId: missions?.selectedMissionId ?? null,
          selectedTaskId: missions?.selectedTaskId ?? null,
          ...(missions?.navigation
            ? { navigation: orderedMissionsNavigation(missions.navigation) }
            : {}),
        },
        activity: { selectedRowId: null, scrollOffset: 0 },
      },
      views: Object.fromEntries(
        Object.entries(legacyViews).map(([id, entry]) => [
          id,
          {
            panel: entry.panel,
            ...(entry.layout ? { layout: orderedLayoutState(entry.layout) } : {}),
          },
        ]),
      ),
    },
    diagnostics,
  };
}

function dockTabFromPanel(panel: HostedPanelKind | null | undefined): WorkbenchDockTabId | null {
  if (panel === "files") return "files";
  if (panel === "diff") return "changes";
  if (panel === "missions") return "missions";
  return null;
}

export function serializeWorkspaceUiState(state: WorkspaceUiStateV2): string {
  const parsed = parseWorkspaceUiStateValue(state).state;
  const orderedViews: Record<string, WorkspaceLayoutViewState> = {};
  for (const id of Object.keys(parsed.views).sort()) {
    const view = parsed.views[id]!;
    orderedViews[id] = {
      panel: view.panel,
      ...(view.layout ? { layout: orderedLayoutState(view.layout) } : {}),
    };
  }
  const clean: WorkspaceUiStateV2 = {
    version: WORKSPACE_UI_STATE_VERSION,
    active: parsed.active ? { viewId: parsed.active.viewId, panel: parsed.active.panel } : null,
    dock: { ...parsed.dock },
    surfaces: {
      files: { ...parsed.surfaces.files },
      diff: { ...parsed.surfaces.diff },
      missions: {
        selectedMissionId: parsed.surfaces.missions.selectedMissionId,
        selectedTaskId: parsed.surfaces.missions.selectedTaskId,
        ...(parsed.surfaces.missions.navigation
          ? { navigation: orderedMissionsNavigation(parsed.surfaces.missions.navigation) }
          : {}),
      },
      activity: { ...parsed.surfaces.activity },
    },
    views: orderedViews,
  };
  return `${JSON.stringify(clean, null, 2)}\n`;
}

function orderedLayoutState(
  layout: WorkspaceCompositeLayoutViewState,
): WorkspaceCompositeLayoutViewState {
  const activeTabs: Record<string, string> = {};
  for (const key of Object.keys(layout.activeTabs).sort())
    activeTabs[key] = layout.activeTabs[key]!;
  const splitWeights: Record<string, number[]> = {};
  for (const key of Object.keys(layout.splitWeights).sort())
    splitWeights[key] = [...layout.splitWeights[key]!];
  return {
    focusedLeafId: cleanId(layout.focusedLeafId),
    activeTabs,
    splitWeights,
  };
}

function orderedMissionsNavigation(
  navigation: WorkspaceMissionsNavigationState,
): WorkspaceMissionsNavigationState {
  return {
    mode: navigation.mode,
    density: navigation.density,
    selectedColumn: navigation.selectedColumn,
    preferredRow: navigation.preferredRow,
    columnScroll: orderedNumberRecord(navigation.columnScroll, MISSION_COLUMNS),
    historyScroll: navigation.historyScroll,
    horizontalOffset: navigation.horizontalOffset,
    detailReturnMode: navigation.detailReturnMode,
    detailSection: navigation.detailSection,
    detailScroll: orderedNumberRecord(navigation.detailScroll, MISSION_DETAIL_SECTIONS),
    collapsedColumns: orderedBooleanRecord(navigation.collapsedColumns, MISSION_COLUMNS),
    zoomColumn: navigation.zoomColumn,
    zoomRestoreHorizontalOffset: navigation.zoomRestoreHorizontalOffset,
  };
}

function orderedNumberRecord<const Keys extends readonly string[]>(
  record: Record<Keys[number], number>,
  keys: Keys,
): Record<Keys[number], number> {
  return Object.fromEntries(
    (keys as readonly Keys[number][]).map((key) => [key, record[key] ?? 0]),
  ) as Record<Keys[number], number>;
}

function orderedBooleanRecord<const Keys extends readonly string[]>(
  record: Record<Keys[number], boolean>,
  keys: Keys,
): Record<Keys[number], boolean> {
  return Object.fromEntries(
    (keys as readonly Keys[number][]).map((key) => [key, record[key] === true]),
  ) as Record<Keys[number], boolean>;
}

export function workspaceUiStateToJsonValue(state: WorkspaceUiStateV2): JsonValue {
  return JSON.parse(serializeWorkspaceUiState(state)) as JsonValue;
}

export function loadWorkspaceUiState(repository: ProjectRuntimeRepository): LoadedWorkspaceUiState {
  let document: ProjectRuntimeDocument<JsonValue>;
  try {
    document = repository.readDocument<JsonValue>(WORKSPACE_UI_STATE_PATH);
  } catch (error) {
    return {
      state: defaultWorkspaceUiState(),
      revision: null,
      writeProtected: false,
      diagnostics: [
        diagnostic(
          "READ_FAILED",
          WORKSPACE_UI_STATE_PATH,
          `workspace UI state could not be read: ${(error as Error).message}`,
        ),
      ],
    };
  }
  if (!document.found) {
    return {
      state: defaultWorkspaceUiState(),
      revision: null,
      writeProtected: false,
      diagnostics: [diagnostic("MISSING", WORKSPACE_UI_STATE_PATH, "workspace UI state is absent")],
    };
  }
  const parsed = parseWorkspaceUiStateValue(document.payload);
  return {
    ...parsed,
    revision: document.revision,
    writeProtected: parsed.diagnostics.some((entry) => entry.code === "UNSUPPORTED_VERSION"),
  };
}

export function mergeWorkspaceUiStateForSave(
  latest: WorkspaceUiStateV2,
  local: WorkspaceUiStateV2,
  touchedViewIds: ReadonlySet<string>,
  touchedSurfaceIds: ReadonlySet<keyof WorkspaceSurfaceStates> = new Set(),
  touchedDock = false,
  touchedActiveView = false,
): WorkspaceUiStateV2 {
  const views: Record<string, WorkspaceLayoutViewState> = { ...latest.views };
  for (const id of touchedViewIds) {
    const localView = local.views[id];
    if (localView) views[id] = localView;
  }
  const missions = touchedSurfaceIds.has("missions")
    ? local.surfaces.missions
    : latest.surfaces.missions;
  return {
    version: WORKSPACE_UI_STATE_VERSION,
    active: touchedActiveView
      ? local.active
        ? { ...local.active }
        : null
      : latest.active
        ? { ...latest.active }
        : null,
    dock: { ...(touchedDock ? local.dock : latest.dock) },
    surfaces: {
      files: {
        ...(touchedSurfaceIds.has("files") ? local.surfaces.files : latest.surfaces.files),
      },
      diff: {
        ...(touchedSurfaceIds.has("diff") ? local.surfaces.diff : latest.surfaces.diff),
      },
      missions: {
        ...missions,
        ...(missions.navigation
          ? { navigation: orderedMissionsNavigation(missions.navigation) }
          : {}),
      },
      activity: {
        ...(touchedSurfaceIds.has("activity") ? local.surfaces.activity : latest.surfaces.activity),
      },
    },
    views,
  };
}

export function writeWorkspaceUiStateWithRetry(
  request: WorkspaceUiSaveRequest,
): WriteWorkspaceUiStateResult {
  const diagnostics: WorkspaceUiStateDiagnostic[] = [];
  if (request.revision !== null) {
    const existing = loadWorkspaceUiState(request.repository);
    if (existing.writeProtected) {
      return {
        state: request.current,
        revision: request.revision,
        diagnostics: [
          ...existing.diagnostics,
          diagnostic(
            "WRITE_PROTECTED",
            WORKSPACE_UI_STATE_PATH,
            "newer workspace UI state was preserved without writing",
          ),
        ],
      };
    }
  }
  const writePayload = (state: WorkspaceUiStateV2, revision: number | null) =>
    request.repository.writeDocument(WORKSPACE_UI_STATE_PATH, workspaceUiStateToJsonValue(state), {
      expectedRevision: revision,
    });
  try {
    const written = writePayload(request.next, request.revision);
    return { state: cloneState(request.next), revision: written.revision, diagnostics };
  } catch (error) {
    if (!(error instanceof RevisionConflictError)) {
      return {
        state: request.current,
        revision: request.revision,
        diagnostics: [
          diagnostic(
            "WRITE_FAILED",
            WORKSPACE_UI_STATE_PATH,
            `workspace UI state could not be saved: ${(error as Error).message}`,
          ),
        ],
      };
    }
  }

  const latest = loadWorkspaceUiState(request.repository);
  diagnostics.push(...latest.diagnostics.filter((entry) => entry.code !== "MISSING"));
  if (latest.writeProtected) {
    return {
      state: request.current,
      revision: request.revision,
      diagnostics: [
        ...diagnostics,
        diagnostic(
          "WRITE_PROTECTED",
          WORKSPACE_UI_STATE_PATH,
          "newer workspace UI state was preserved without writing",
        ),
      ],
    };
  }
  const merged = mergeWorkspaceUiStateForSave(
    latest.state,
    request.next,
    request.touchedViewIds,
    request.touchedSurfaceIds,
    request.touchedDock,
    request.touchedActiveView,
  );
  try {
    const written = writePayload(merged, latest.revision);
    return { state: cloneState(merged), revision: written.revision, diagnostics };
  } catch (error) {
    return {
      state: request.current,
      revision: request.revision,
      diagnostics: [
        ...diagnostics,
        diagnostic(
          "WRITE_FAILED",
          WORKSPACE_UI_STATE_PATH,
          `workspace UI state retry failed: ${(error as Error).message}`,
        ),
      ],
    };
  }
}

export function chooseInitialWorkspaceView(
  views: readonly HostedPanelView[],
  options: {
    requestedPanel: HostedPanelKind | null | undefined;
    persisted: WorkspaceUiStateV2 | null | undefined;
    legacyLastTab: Tab | null | undefined;
  },
): WorkspaceViewRestoreChoice {
  const requested = findFirstHostedViewForPanel(views, options.requestedPanel);
  if (requested) return { view: requested, reason: "explicit" };

  const persistedActive = options.persisted?.active;
  if (persistedActive) {
    const exact = findHostedViewById(views, persistedActive.viewId);
    if (exact && exact.panel === persistedActive.panel) {
      return { view: exact, reason: "persisted-id" };
    }
    const byPanel = findFirstHostedViewForPanel(views, persistedActive.panel);
    if (byPanel) return { view: byPanel, reason: "persisted-panel" };
  }

  const legacyPanel = panelKindFromLegacyTab(options.legacyLastTab);
  const legacy = findFirstHostedViewForPanel(views, legacyPanel);
  if (legacy) return { view: legacy, reason: "legacy-tab" };

  return { view: views[0] ?? null, reason: views[0] ? "first" : "none" };
}

export function viewStateFor(
  state: WorkspaceUiStateV2,
  view: Pick<HostedPanelView, "id" | "panel"> | null | undefined,
): WorkspaceViewState | null {
  if (!view) return null;
  const layout = state.views[view.id]?.layout;
  if (view.panel === "files")
    return { panel: "files", ...state.surfaces.files, ...(layout ? { layout } : {}) };
  if (view.panel === "diff")
    return { panel: "diff", ...state.surfaces.diff, ...(layout ? { layout } : {}) };
  if (view.panel === "missions") {
    return { panel: "missions", ...state.surfaces.missions, ...(layout ? { layout } : {}) };
  }
  return view.panel === "home"
    ? { panel: "home", ...(layout ? { layout } : {}) }
    : { panel: "terminals", ...(layout ? { layout } : {}) };
}

export function workspaceSurfaceState(
  state: WorkspaceUiStateV2,
  panel: "files" | "diff" | "missions" | "activity",
):
  | WorkspaceFilesViewState
  | WorkspaceDiffViewState
  | WorkspaceMissionsViewState
  | WorkspaceActivitySurfaceState {
  if (panel === "files") return { panel: "files", ...state.surfaces.files };
  if (panel === "diff") return { panel: "diff", ...state.surfaces.diff };
  if (panel === "missions") return { panel: "missions", ...state.surfaces.missions };
  return { ...state.surfaces.activity };
}

export function setWorkspaceSurfaceState(
  state: WorkspaceUiStateV2,
  entry:
    | WorkspaceFilesViewState
    | WorkspaceDiffViewState
    | WorkspaceMissionsViewState
    | ({ panel: "activity" } & WorkspaceActivitySurfaceState),
): WorkspaceUiStateV2 {
  const next = cloneState(state);
  if (entry.panel === "files") {
    next.surfaces.files = {
      openPath: cleanPath(entry.openPath),
      selectedPath: cleanPath(entry.selectedPath),
    };
  } else if (entry.panel === "diff") {
    next.surfaces.diff = { selectedPath: cleanPath(entry.selectedPath) };
  } else if (entry.panel === "missions") {
    next.surfaces.missions = {
      selectedMissionId: cleanId(entry.selectedMissionId),
      selectedTaskId: cleanId(entry.selectedTaskId),
      ...(entry.navigation ? { navigation: orderedMissionsNavigation(entry.navigation) } : {}),
    };
  } else {
    next.surfaces.activity = {
      selectedRowId: cleanId(entry.selectedRowId),
      scrollOffset: cleanNonnegativeInt(entry.scrollOffset) ?? 0,
    };
  }
  return next;
}

export function setWorkspaceDockState(
  state: WorkspaceUiStateV2,
  dock: WorkspaceDockState,
): WorkspaceUiStateV2 {
  const next = cloneState(state);
  next.dock = cleanDockState(dock, []);
  return next;
}

export function setMissionsSelection(
  state: WorkspaceUiStateV2,
  viewId: string,
  missionId: string | null,
  taskId: string | null,
): WorkspaceUiStateV2 {
  const id = cleanId(viewId);
  if (!id) return cloneState(state);
  const next = cloneState(state);
  next.surfaces.missions = {
    selectedMissionId: cleanId(missionId),
    selectedTaskId: cleanId(taskId),
    ...(state.surfaces.missions.navigation
      ? { navigation: orderedMissionsNavigation(state.surfaces.missions.navigation) }
      : {}),
  };
  return next;
}

export function setMissionsNavigation(
  state: WorkspaceUiStateV2,
  viewId: string,
  selection: Pick<WorkspaceMissionsViewState, "selectedMissionId" | "selectedTaskId">,
  navigation: WorkspaceMissionsNavigationState,
): WorkspaceUiStateV2 {
  const id = cleanId(viewId);
  if (!id) return cloneState(state);
  const next = cloneState(state);
  next.surfaces.missions = {
    selectedMissionId: cleanId(selection.selectedMissionId),
    selectedTaskId: cleanId(selection.selectedTaskId),
    navigation: orderedMissionsNavigation(navigation),
  };
  return next;
}

export function layoutStateForView(
  state: WorkspaceUiStateV2,
  viewId: string,
): WorkspaceCompositeLayoutViewState | null {
  return state.views[viewId]?.layout ?? null;
}

function workspaceViewStateWithLayout(
  entry: WorkspaceLayoutViewState,
  layout: WorkspaceCompositeLayoutViewState,
): WorkspaceLayoutViewState {
  const cleanLayout = orderedLayoutState(layout);
  return { panel: entry.panel, layout: cleanLayout };
}

export function setWorkspaceViewLayoutState(
  state: WorkspaceUiStateV2,
  view: Pick<HostedPanelView, "id" | "panel">,
  layout: WorkspaceCompositeLayoutViewState,
): WorkspaceUiStateV2 {
  const id = cleanId(view.id);
  if (!id) return cloneState(state);
  const existing = state.views[id] ?? workspaceViewStateForPanel(view.panel);
  return {
    version: WORKSPACE_UI_STATE_VERSION,
    active: state.active ? { ...state.active } : null,
    dock: { ...state.dock },
    surfaces: cloneState(state).surfaces,
    views: {
      ...state.views,
      [id]: workspaceViewStateWithLayout(existing, layout),
    },
  };
}

function workspaceViewStateForPanel(panel: HostedPanelKind): WorkspaceLayoutViewState {
  return { panel };
}

export function missionsSelection(
  state: WorkspaceUiStateV2,
  viewId: string,
): Pick<WorkspaceMissionsViewState, "selectedMissionId" | "selectedTaskId"> {
  void viewId;
  return {
    selectedMissionId: state.surfaces.missions.selectedMissionId,
    selectedTaskId: state.surfaces.missions.selectedTaskId,
  };
}

export function relativeProjectPath(projectRoot: string, path: string | null): string | null {
  if (!path) return null;
  const absolute = resolve(path);
  const root = resolve(projectRoot);
  const rel = relative(root, absolute);
  if (rel === "") return null;
  if (isOutsideRoot(rel)) return null;
  return cleanPath(rel);
}

export function absoluteProjectPath(projectRoot: string, path: string | null): string | null {
  const clean = cleanPath(path);
  if (!clean) return null;
  if (isAbsolute(clean)) return null;
  const root = resolve(projectRoot);
  const absolute = resolve(root, clean);
  const rel = relative(root, absolute);
  if (rel === "" || isOutsideRoot(rel)) return null;
  return absolute;
}

export function shouldHydrateWorkspaceView(options: {
  firstProjectLoad: boolean;
  explicitEditPath: string | null | undefined;
  view: Pick<HostedPanelView, "panel"> | null | undefined;
  entry: WorkspaceViewState | null | undefined;
}): boolean {
  if (
    options.firstProjectLoad &&
    options.explicitEditPath &&
    options.view?.panel === "files" &&
    options.entry?.panel === "files" &&
    options.entry.openPath
  ) {
    return false;
  }
  return true;
}

export class WorkspaceUiStateController {
  #generation = 0;
  #repository: ProjectRuntimeRepository | null = null;
  #revision: number | null = null;
  #state: WorkspaceUiStateV2 = defaultWorkspaceUiState();
  #loaded = false;
  #writeProtected = false;

  beginLoad(): number {
    this.#generation += 1;
    this.#loaded = false;
    this.#repository = null;
    this.#revision = null;
    this.#state = defaultWorkspaceUiState();
    this.#writeProtected = false;
    return this.#generation;
  }

  completeLoad(
    generation: number,
    repository: ProjectRuntimeRepository,
    loaded: LoadedWorkspaceUiState,
  ): boolean {
    if (generation !== this.#generation) return false;
    this.#repository = repository;
    this.#revision = loaded.revision;
    this.#state = cloneState(loaded.state);
    this.#loaded = true;
    this.#writeProtected = loaded.writeProtected;
    return true;
  }

  failLoad(generation: number): boolean {
    if (generation !== this.#generation) return false;
    this.#repository = null;
    this.#revision = null;
    this.#state = defaultWorkspaceUiState();
    this.#loaded = true;
    this.#writeProtected = false;
    return true;
  }

  snapshot(): WorkspaceUiControllerSnapshot {
    return {
      loaded: this.#loaded,
      repository: this.#repository,
      revision: this.#revision,
      state: cloneState(this.#state),
      generation: this.#generation,
    };
  }

  save(
    generation: number,
    next: WorkspaceUiStateV2,
    touchedViewIds: ReadonlySet<string>,
    touchedSurfaceIds: ReadonlySet<keyof WorkspaceSurfaceStates> = new Set(),
    touchedDock = false,
    touchedActiveView = false,
  ): WorkspaceUiControllerSaveResult {
    if (generation !== this.#generation) {
      return {
        saved: false,
        skipped: true,
        diagnostics: [diagnostic("STALE", WORKSPACE_UI_STATE_PATH, "stale UI state save skipped")],
      };
    }
    if (!this.#loaded || !this.#repository) {
      return {
        saved: false,
        skipped: true,
        diagnostics: [
          diagnostic("NOT_LOADED", WORKSPACE_UI_STATE_PATH, "UI state has not loaded yet"),
        ],
      };
    }
    if (this.#writeProtected) {
      return {
        saved: false,
        skipped: false,
        diagnostics: [
          diagnostic(
            "WRITE_PROTECTED",
            WORKSPACE_UI_STATE_PATH,
            "newer workspace UI state was preserved without writing",
          ),
        ],
      };
    }
    const result = writeWorkspaceUiStateWithRetry({
      repository: this.#repository,
      revision: this.#revision,
      current: this.#state,
      next,
      touchedViewIds,
      touchedSurfaceIds,
      touchedDock,
      touchedActiveView,
    });
    if (
      result.diagnostics.some(
        (entry) => entry.code === "WRITE_FAILED" || entry.code === "WRITE_PROTECTED",
      )
    ) {
      return { saved: false, skipped: false, diagnostics: result.diagnostics };
    }
    this.#state = cloneState(result.state);
    this.#revision = result.revision;
    return { saved: true, skipped: false, diagnostics: result.diagnostics };
  }
}
