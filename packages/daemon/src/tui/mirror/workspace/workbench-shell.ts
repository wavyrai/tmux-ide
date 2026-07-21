import { terminalDisplayWidth } from "../panel-host.ts";
import type { Rect } from "../recipes.ts";
import { clipWorkspaceText } from "./text.ts";
import {
  workbenchDockNavigationTarget,
  type WorkbenchDockNavigationTabId,
} from "../../../ui/workbench-dock/navigation.ts";

export type WorkbenchVariant = "compact" | "standard" | "wide";
export type WorkbenchDockMode = "collapsed" | "open" | "maximized";
export type WorkbenchFocusZone = "canvas" | "dock-tabs" | "dock-body";
export type WorkbenchDockTabId = WorkbenchDockNavigationTabId;
export { workbenchDockNavigationTarget } from "../../../ui/workbench-dock/navigation.ts";
export type WorkbenchDockActionId = "toggle-collapse" | "toggle-maximize";

export interface WorkbenchShellInput {
  width: number;
  height: number;
  dockMode: WorkbenchDockMode;
  /** Last user-selected open height; null follows the responsive 30% default. */
  persistedDockHeight: number | null;
  activeDockTab: WorkbenchDockTabId;
  focusZone: WorkbenchFocusZone;
  hoveredDockTab?: WorkbenchDockTabId | null;
  attentionDockTabs?: ReadonlySet<WorkbenchDockTabId>;
  disabledDockTabs?: ReadonlySet<WorkbenchDockTabId>;
  dockTabShortcuts?: Partial<Record<WorkbenchDockTabId, string>>;
}

export interface WorkbenchDockConstraints {
  minimumCanvasHeight: number;
  minimumOpenDockHeight: number;
  maximumOpenDockHeight: number;
  preferredOpenDockHeight: number;
}

export interface WorkbenchDockTabProjection {
  id: WorkbenchDockTabId;
  title: string;
  label: string;
  shortcut: string;
  selected: boolean;
  focused: boolean;
  hovered: boolean;
  attention: boolean;
  disabled: boolean;
  x: number;
  width: number;
}

export interface WorkbenchDockActionProjection {
  id: WorkbenchDockActionId;
  label: string;
  description: string;
  nextMode: WorkbenchDockMode;
  active: boolean;
  x: number;
  width: number;
}

export interface WorkbenchShellProjection {
  width: number;
  height: number;
  variant: WorkbenchVariant;
  requestedDockMode: WorkbenchDockMode;
  dockMode: WorkbenchDockMode;
  persistedDockHeight: number | null;
  focusZone: WorkbenchFocusZone;
  constraints: WorkbenchDockConstraints;
  canvas: Rect;
  canvasRail: Rect;
  canvasBody: Rect;
  dock: Rect;
  dockTabs: Rect;
  dockBody: Rect;
  dockBodyRail: Rect;
  dockBodyContent: Rect;
  tabs: readonly WorkbenchDockTabProjection[];
  actions: readonly WorkbenchDockActionProjection[];
  requestedActiveDockTab: WorkbenchDockTabId;
  activeDockTab: WorkbenchDockTabId;
}

export type WorkbenchShellHit =
  | { kind: "canvas"; localX: number; localY: number }
  | { kind: "canvas-rail" }
  | { kind: "dock-tab"; tabId: WorkbenchDockTabId; index: number }
  | {
      kind: "dock-action";
      actionId: WorkbenchDockActionId;
      nextMode: WorkbenchDockMode;
      index: number;
    }
  | { kind: "dock-tabs" }
  | { kind: "dock-body"; tabId: WorkbenchDockTabId; localX: number; localY: number }
  | { kind: "dock-body-rail"; tabId: WorkbenchDockTabId }
  | null;

interface DockTabDefinition {
  id: WorkbenchDockTabId;
  title: string;
  compactTitle: string;
  glyph: string;
  shortcut: string;
}

const DOCK_TABS: readonly DockTabDefinition[] = [
  { id: "files", title: "Files", compactTitle: "Files", glyph: "▤", shortcut: "F3" },
  { id: "changes", title: "Changes", compactTitle: "Changes", glyph: "±", shortcut: "F4" },
  { id: "missions", title: "Missions", compactTitle: "Missions", glyph: "◆", shortcut: "F6" },
  { id: "activity", title: "Activity", compactTitle: "Activity", glyph: "◌", shortcut: "F9" },
];

const TAB_BAR_ROWS = 1;

export function workbenchVariant(width: number, height: number): WorkbenchVariant {
  if (width >= 160 && height >= 45) return "wide";
  if (width >= 96 && height >= 30) return "standard";
  return "compact";
}

/** Pure agent-canvas and bottom-dock geometry. Runtime stores remain outside. */
export function projectWorkbenchShell(input: WorkbenchShellInput): WorkbenchShellProjection {
  const width = nonNegativeInteger(input.width);
  const height = nonNegativeInteger(input.height);
  const persistedDockHeight =
    input.persistedDockHeight === null ? null : nonNegativeInteger(input.persistedDockHeight);
  const variant = workbenchVariant(width, height);
  const tabBarHeight = Math.min(TAB_BAR_ROWS, height);
  const minimumCanvasHeight = Math.min(
    minimumCanvasRows(variant),
    Math.max(0, height - tabBarHeight - 1),
  );
  const maximumOpenDockHeight = Math.max(tabBarHeight, height - minimumCanvasHeight);
  const minimumOpenDockHeight = Math.min(
    Math.max(tabBarHeight, minimumDockRows(variant)),
    maximumOpenDockHeight,
  );
  const preferredOpenDockHeight = clamp(
    persistedDockHeight ?? Math.round(height * 0.3),
    minimumOpenDockHeight,
    maximumOpenDockHeight,
  );
  const dockMode = effectiveDockMode(input.dockMode, height);
  const dockHeight =
    dockMode === "collapsed"
      ? tabBarHeight
      : dockMode === "maximized"
        ? height
        : preferredOpenDockHeight;
  const dockY = Math.max(0, height - dockHeight);
  const canvas = rect(0, 0, width, dockY);
  const dock = rect(0, dockY, width, dockHeight);
  const dockTabs = rect(0, dockY, width, Math.min(tabBarHeight, dockHeight));
  const dockBody = rect(
    0,
    dockTabs.y + dockTabs.height,
    width,
    Math.max(0, dockHeight - dockTabs.height),
  );
  const canvasRail = contentRail(canvas);
  const canvasBody = contentBody(canvas);
  const dockBodyRail = contentRail(dockBody);
  const dockBodyContent = contentBody(dockBody);
  const focusZone = effectiveFocusZone(input.focusZone, canvas, dockBody);
  const activeDockTab = enabledDockTab(input.activeDockTab, input.disabledDockTabs);
  const actions = projectDockActions(width, variant, dockMode);
  const tabRight = Math.max(0, (actions[0]?.x ?? width) - (actions.length > 0 ? 1 : 0));
  const tabs = projectDockTabs(input, variant, focusZone, tabRight, activeDockTab);

  return {
    width,
    height,
    variant,
    requestedDockMode: input.dockMode,
    dockMode,
    persistedDockHeight,
    focusZone,
    constraints: {
      minimumCanvasHeight,
      minimumOpenDockHeight,
      maximumOpenDockHeight,
      preferredOpenDockHeight,
    },
    canvas,
    canvasRail,
    canvasBody,
    dock,
    dockTabs,
    dockBody,
    dockBodyRail,
    dockBodyContent,
    tabs,
    actions,
    requestedActiveDockTab: input.activeDockTab,
    activeDockTab,
  };
}

/** Pure keyboard-order helper. Disabled tabs stay visible but are skipped. */
export function moveWorkbenchDockTab(
  active: WorkbenchDockTabId,
  direction: "next" | "previous",
  disabled: ReadonlySet<WorkbenchDockTabId> = new Set(),
): WorkbenchDockTabId {
  return (
    workbenchDockNavigationTarget(
      DOCK_TABS.map((tab) => ({ id: tab.id, disabled: disabled.has(tab.id) })),
      active,
      { name: direction === "next" ? "right" : "left" },
    ) ?? active
  );
}

export function workbenchShellHitTest(
  projection: WorkbenchShellProjection,
  x: number,
  y: number,
): WorkbenchShellHit {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cellX = Math.floor(x);
  const cellY = Math.floor(y);
  if (cellX < 0 || cellY < 0 || cellX >= projection.width || cellY >= projection.height) {
    return null;
  }

  if (contains(projection.canvasBody, cellX, cellY)) {
    return {
      kind: "canvas",
      localX: cellX - projection.canvasBody.x,
      localY: cellY - projection.canvasBody.y,
    };
  }
  if (contains(projection.canvasRail, cellX, cellY)) return { kind: "canvas-rail" };
  if (contains(projection.dockTabs, cellX, cellY)) {
    const actionIndex = projection.actions.findIndex(
      (action) => cellX >= action.x && cellX < action.x + action.width,
    );
    const action = projection.actions[actionIndex];
    if (action) {
      return {
        kind: "dock-action",
        actionId: action.id,
        nextMode: action.nextMode,
        index: actionIndex,
      };
    }
    const tabIndex = projection.tabs.findIndex(
      (tab) => cellX >= tab.x && cellX < tab.x + tab.width,
    );
    const tab = projection.tabs[tabIndex];
    return tab && !tab.disabled
      ? { kind: "dock-tab", tabId: tab.id, index: tabIndex }
      : { kind: "dock-tabs" };
  }
  if (contains(projection.dockBodyContent, cellX, cellY)) {
    return {
      kind: "dock-body",
      tabId: projection.activeDockTab,
      localX: cellX - projection.dockBodyContent.x,
      localY: cellY - projection.dockBodyContent.y,
    };
  }
  if (contains(projection.dockBodyRail, cellX, cellY)) {
    return { kind: "dock-body-rail", tabId: projection.activeDockTab };
  }
  return null;
}

function projectDockTabs(
  input: WorkbenchShellInput,
  variant: WorkbenchVariant,
  focusZone: WorkbenchFocusZone,
  rightEdge: number,
  activeDockTab: WorkbenchDockTabId,
): WorkbenchDockTabProjection[] {
  let x = 0;
  return DOCK_TABS.map((definition, index) => {
    const selected = definition.id === activeDockTab;
    const attention = input.attentionDockTabs?.has(definition.id) ?? false;
    const disabled = input.disabledDockTabs?.has(definition.id) ?? false;
    const shortcut = input.dockTabShortcuts?.[definition.id] ?? definition.shortcut;
    const desired = dockTabLabel(definition, shortcut, variant, selected, attention, disabled);
    const remainingTabs = DOCK_TABS.length - index;
    const available = Math.max(0, rightEdge - x);
    const fairWidth = remainingTabs > 0 ? Math.floor(available / remainingTabs) : 0;
    const label = clipWorkspaceText(desired, fairWidth);
    const width = terminalDisplayWidth(label);
    const projection: WorkbenchDockTabProjection = {
      id: definition.id,
      title: definition.title,
      label,
      shortcut,
      selected,
      focused: selected && focusZone === "dock-tabs" && !disabled,
      hovered: input.hoveredDockTab === definition.id,
      attention,
      disabled,
      x,
      width,
    };
    x += width;
    return projection;
  });
}

function projectDockActions(
  width: number,
  variant: WorkbenchVariant,
  mode: WorkbenchDockMode,
): WorkbenchDockActionProjection[] {
  const compact = variant === "compact" || width < 56;
  const definitions: Omit<WorkbenchDockActionProjection, "x" | "width">[] = [
    {
      id: "toggle-collapse",
      label: compact
        ? mode === "collapsed"
          ? " ▴ "
          : " ▾ "
        : mode === "collapsed"
          ? " ▴ open "
          : " ▾ close ",
      description: mode === "collapsed" ? "Open bottom dock" : "Collapse bottom dock",
      nextMode: mode === "collapsed" ? "open" : "collapsed",
      active: mode !== "collapsed",
    },
    {
      id: "toggle-maximize",
      label: compact
        ? mode === "maximized"
          ? " ▣ "
          : " □ "
        : mode === "maximized"
          ? " ▣ restore "
          : " □ max ",
      description: mode === "maximized" ? "Restore bottom dock" : "Maximize bottom dock",
      nextMode: mode === "maximized" ? "open" : "maximized",
      active: mode === "maximized",
    },
  ];
  let gap = definitions.length > 1 ? 1 : 0;
  let widths = definitions.map((definition) => terminalDisplayWidth(definition.label));
  let total = widths.reduce((sum, value) => sum + value, 0) + gap;
  if (total > width) {
    definitions[0]!.label = mode === "collapsed" ? "▴" : "▾";
    definitions[1]!.label = mode === "maximized" ? "▣" : "□";
    gap = width >= 3 ? 1 : 0;
    widths = definitions.map((definition) => terminalDisplayWidth(definition.label));
    total = widths.reduce((sum, value) => sum + value, 0) + gap;
  }
  while (definitions.length > 0 && total > width) {
    definitions.pop();
    widths = definitions.map((definition) => terminalDisplayWidth(definition.label));
    gap = definitions.length > 1 && width >= 3 ? 1 : 0;
    total = widths.reduce((sum, value) => sum + value, 0) + gap;
  }
  let x = Math.max(0, width - total);
  return definitions.map((definition, index) => {
    const action = { ...definition, x, width: widths[index]! };
    x += action.width + gap;
    return action;
  });
}

function dockTabLabel(
  definition: DockTabDefinition,
  shortcut: string,
  variant: WorkbenchVariant,
  selected: boolean,
  attention: boolean,
  disabled: boolean,
): string {
  const marker = disabled ? "×" : attention ? "!" : selected ? "●" : " ";
  const title = variant === "compact" ? definition.compactTitle : definition.title;
  const shortcutLabel = variant === "wide" && shortcut ? `${shortcut} ` : "";
  return ` ${shortcutLabel}${marker}${definition.glyph} ${title} `;
}

function enabledDockTab(
  requested: WorkbenchDockTabId,
  disabled: ReadonlySet<WorkbenchDockTabId> | undefined,
): WorkbenchDockTabId {
  if (!disabled?.has(requested)) return requested;
  return moveWorkbenchDockTab(requested, "next", disabled);
}

function minimumCanvasRows(variant: WorkbenchVariant): number {
  if (variant === "wide") return 16;
  if (variant === "standard") return 12;
  return 8;
}

function minimumDockRows(variant: WorkbenchVariant): number {
  if (variant === "wide") return 14;
  if (variant === "standard") return 10;
  return 7;
}

function effectiveDockMode(mode: WorkbenchDockMode, height: number): WorkbenchDockMode {
  if (height <= TAB_BAR_ROWS) return "collapsed";
  return mode;
}

function effectiveFocusZone(
  requested: WorkbenchFocusZone,
  canvas: Rect,
  dockBody: Rect,
): WorkbenchFocusZone {
  if (requested === "canvas" && canvas.height === 0) {
    return dockBody.height > 0 ? "dock-body" : "dock-tabs";
  }
  if (requested === "dock-body" && dockBody.height === 0) return "dock-tabs";
  return requested;
}

function contentRail(area: Rect): Rect {
  return rect(area.x, area.y, Math.min(1, area.width), area.height);
}

function contentBody(area: Rect): Rect {
  const railWidth = Math.min(1, area.width);
  return rect(area.x + railWidth, area.y, Math.max(0, area.width - railWidth), area.height);
}

function contains(area: Rect, x: number, y: number): boolean {
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height;
}

function nonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}
