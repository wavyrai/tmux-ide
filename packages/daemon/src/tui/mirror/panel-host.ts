import type {
  WorkspaceConfigV1,
  WorkspaceFullPanelView,
  WorkspacePanelKind,
} from "@tmux-ide/contracts";
import stringWidth from "string-width";
import type { ResolvedConfig } from "../../lib/resolved-config.ts";
import type { Tab } from "./app-state.ts";
import type { Span } from "./spans.ts";

export type HostedPanelKind = WorkspacePanelKind;

export interface HostedPanelShortcut {
  key: `f${number}`;
  label: `F${number}`;
}

export interface HostedPanelView {
  id: string;
  title: string;
  panel: HostedPanelKind;
  glyph: string;
  order: number;
  shortcut: HostedPanelShortcut | null;
}

export interface PreviousHostedSelection {
  id: string | null;
  panel: HostedPanelKind | null;
}

export interface HostedNavigationResult {
  activeViewId: string;
  view: HostedPanelView;
  changed: boolean;
  note: string | null;
}

export type HostedActivationEffect = "load-files" | "catch-up-files" | "enter-diff";

export interface HostedActivationState {
  filesLoaded: boolean;
  diffLoaded: boolean;
}

export interface HostedActivationPlan {
  activeViewId: string | null;
  view: HostedPanelView | null;
  effects: HostedActivationEffect[];
  note: string | null;
}

export const PANEL_TITLES: Readonly<Record<HostedPanelKind, string>> = {
  home: "Home",
  terminals: "Terminals",
  files: "Files",
  diff: "Diff",
  missions: "Missions",
};

export const PANEL_GLYPHS: Readonly<Record<HostedPanelKind, string>> = {
  home: "⌂",
  terminals: "❯",
  files: "▤",
  diff: "±",
  missions: "◆",
};

export const CANONICAL_PANEL_VIEWS: readonly WorkspaceFullPanelView[] = [
  { id: "home", title: "Home", panel: "home" },
  { id: "terminals", title: "Terminals", panel: "terminals" },
  { id: "files", title: "Files", panel: "files" },
  { id: "diff", title: "Diff", panel: "diff" },
  { id: "missions", title: "Missions", panel: "missions" },
];

export const MISSIONS_PLACEHOLDER_LINES = [
  "Mission workspace view",
  "Mission state, proof history, board, and timeline projections are ready.",
  "The interactive Missions board arrives in C10; this placeholder does not start harnesses or read mission runtime data.",
] as const;

export const HOSTED_VIEW_SHORTCUT_KEYS = [
  "f1",
  "f2",
  "f3",
  "f4",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "f13",
] as const;

export function panelCell(view: Pick<HostedPanelView, "glyph" | "title">): string {
  return ` ${view.glyph} ${view.title} `;
}

export function terminalDisplayWidth(text: string): number {
  return stringWidth(text);
}

export function panelSpans(views: readonly HostedPanelView[]): Span[] {
  const out: Span[] = [];
  let x = 0;
  for (const view of views) {
    const width = terminalDisplayWidth(panelCell(view));
    out.push({ start: x, width });
    x += width;
  }
  return out;
}

export function buildHostedPanelViews(
  configuredViews: readonly WorkspaceFullPanelView[] | null | undefined,
): HostedPanelView[] {
  const source =
    configuredViews && configuredViews.length > 0 ? configuredViews : CANONICAL_PANEL_VIEWS;
  return source.map((view, index) => ({
    id: view.id,
    title: view.title ?? PANEL_TITLES[view.panel],
    panel: view.panel,
    glyph: PANEL_GLYPHS[view.panel],
    order: index,
    shortcut: shortcutForHostedViewIndex(index),
  }));
}

export function shortcutForHostedViewIndex(index: number): HostedPanelShortcut | null {
  const key = HOSTED_VIEW_SHORTCUT_KEYS[index];
  if (!key) return null;
  return { key, label: key.toUpperCase() as `F${number}` };
}

export function viewsFromWorkspaceConfig(
  config: WorkspaceConfigV1 | null | undefined,
): HostedPanelView[] {
  return buildHostedPanelViews(config?.app?.views);
}

export function viewsFromResolvedConfig(
  resolved: Pick<ResolvedConfig, "workspace"> | null | undefined,
): HostedPanelView[] {
  return viewsFromWorkspaceConfig(resolved?.workspace);
}

export function findHostedViewById(
  views: readonly HostedPanelView[],
  id: string | null | undefined,
): HostedPanelView | null {
  if (!id) return null;
  return views.find((view) => view.id === id) ?? null;
}

export function findFirstHostedViewForPanel(
  views: readonly HostedPanelView[],
  panel: HostedPanelKind | null | undefined,
): HostedPanelView | null {
  if (!panel) return null;
  return views.find((view) => view.panel === panel) ?? null;
}

export function reconcileHostedSelection(
  views: readonly HostedPanelView[],
  previous: PreviousHostedSelection,
): HostedPanelView | null {
  return (
    findHostedViewById(views, previous.id) ??
    findFirstHostedViewForPanel(views, previous.panel) ??
    views[0] ??
    null
  );
}

export function initialHostedSelection(
  views: readonly HostedPanelView[],
  requestedPanel: HostedPanelKind | null | undefined,
  persistedPanel: HostedPanelKind | null | undefined,
): HostedPanelView | null {
  return (
    findFirstHostedViewForPanel(views, requestedPanel) ??
    findFirstHostedViewForPanel(views, persistedPanel) ??
    views[0] ??
    null
  );
}

export function navigateHostedPanel(
  views: readonly HostedPanelView[],
  currentViewId: string,
  panel: HostedPanelKind,
): HostedNavigationResult {
  const current = findHostedViewById(views, currentViewId) ?? views[0] ?? null;
  const next = findFirstHostedViewForPanel(views, panel);
  if (next) {
    return {
      activeViewId: next.id,
      view: next,
      changed: next.id !== currentViewId,
      note: null,
    };
  }
  const fallback = current ?? buildHostedPanelViews(null)[0]!;
  return {
    activeViewId: fallback.id,
    view: fallback,
    changed: false,
    note: `No configured ${PANEL_TITLES[panel]} view`,
  };
}

export function hostedActivationEffects(
  panel: HostedPanelKind,
  state: HostedActivationState,
): HostedActivationEffect[] {
  if (panel === "files") return [state.filesLoaded ? "catch-up-files" : "load-files"];
  if (panel === "diff" && !state.diffLoaded) return ["enter-diff"];
  return [];
}

export function planHostedViewActivation(
  views: readonly HostedPanelView[],
  viewId: string,
  state: HostedActivationState,
): HostedActivationPlan {
  const view = findHostedViewById(views, viewId);
  if (!view) {
    return {
      activeViewId: null,
      view: null,
      effects: [],
      note: "that view is no longer configured",
    };
  }
  return {
    activeViewId: view.id,
    view,
    effects: hostedActivationEffects(view.panel, state),
    note: null,
  };
}

export function planHostedReconciledActivation(
  views: readonly HostedPanelView[],
  previous: PreviousHostedSelection,
  state: HostedActivationState,
): HostedActivationPlan {
  const view = reconcileHostedSelection(views, previous);
  if (!view) {
    return {
      activeViewId: null,
      view: null,
      effects: [],
      note: "no configured views",
    };
  }
  return {
    activeViewId: view.id,
    view,
    effects: previous.panel === view.panel ? [] : hostedActivationEffects(view.panel, state),
    note: null,
  };
}

export function planHostedInitialActivation(
  views: readonly HostedPanelView[],
  requestedPanel: HostedPanelKind | null | undefined,
  persistedPanel: HostedPanelKind | null | undefined,
  state: HostedActivationState,
  previousPanel: HostedPanelKind | null | undefined,
): HostedActivationPlan {
  const view = initialHostedSelection(views, requestedPanel, persistedPanel);
  if (!view) {
    return {
      activeViewId: null,
      view: null,
      effects: [],
      note: "no configured views",
    };
  }
  return {
    activeViewId: view.id,
    view,
    effects: previousPanel === view.panel ? [] : hostedActivationEffects(view.panel, state),
    note: null,
  };
}

export function panelKindFromLegacyTab(tab: Tab | null | undefined): HostedPanelKind | null {
  switch (tab) {
    case "home":
      return "home";
    case "terminal":
      return "terminals";
    case "files":
      return "files";
    case "diff":
      return "diff";
    default:
      return null;
  }
}

export function legacyTabFromPanelKind(panel: HostedPanelKind): Tab {
  return panel === "terminals" ? "terminal" : panel === "missions" ? "home" : panel;
}

export function panelMode(
  panel: HostedPanelKind,
): "home" | "mirror" | "editor" | "diff" | "missions" {
  switch (panel) {
    case "terminals":
      return "mirror";
    case "files":
      return "editor";
    case "diff":
      return "diff";
    case "missions":
      return "missions";
    case "home":
      return "home";
  }
}

export function isHostedPanelInert(panel: HostedPanelKind): boolean {
  return panel === "missions";
}

export class PanelHostLoadGeneration {
  #current = 0;

  next(): number {
    this.#current += 1;
    return this.#current;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#current;
  }
}
