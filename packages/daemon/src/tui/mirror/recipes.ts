import type { RGBA } from "@opentui/core";
import {
  VISUAL_RECIPE_REGISTRY,
  resolvePaneAppearance,
  statusToneForDomainStatus,
  type CanonicalDomainStatus,
  type PaneVisualStateV1,
  type StatusToneRole,
  type VisualRecipeId,
} from "@tmux-ide/contracts";
import {
  createSemanticThemeSnapshot,
  type ResolvedThemeMode,
  type SemanticThemeSnapshot,
} from "./theme.ts";
import { clipTerminal } from "./missions-workspace.ts";
import { terminalDisplayWidth } from "./panel-host.ts";

export type RecipeTone = "neutral" | "accent" | "blocked" | "working" | "done" | "idle" | "unknown";

export interface RecipeInteractionState {
  selected?: boolean;
  focused?: boolean;
  hovered?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  attention?: boolean;
  loading?: boolean;
  empty?: boolean;
  status?: Exclude<RecipeTone, "neutral" | "accent">;
}

export type RecipeResolvedState =
  | "disabled"
  | "pressed"
  | "selected"
  | "focused"
  | "hovered"
  | "attention"
  | "loading"
  | "empty"
  | "status"
  | "base";

export interface RecipePalette {
  state: RecipeResolvedState;
  foreground: RGBA;
  background: RGBA;
  border: RGBA;
  accent: RGBA;
  marker: string;
}

export interface RecipeRowParts {
  marker: string;
  body: string;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActionChipGeometry {
  label: string;
  width: number;
  markerWidth: number;
  bodyWidth: number;
}

export function actionChipWidth(label: string, width?: number): number {
  return Math.max(0, Math.floor(width ?? terminalDisplayWidth(label) + 4));
}

export function actionChipGeometry(label: string, width?: number): ActionChipGeometry {
  const resolved = actionChipWidth(label, width);
  const markerWidth = Math.min(2, resolved);
  return {
    label,
    width: resolved,
    markerWidth,
    bodyWidth: Math.max(0, resolved - markerWidth),
  };
}

export function actionChipText(label: string, width?: number): string {
  const geometry = actionChipGeometry(label, width);
  if (geometry.bodyWidth <= 0) return "";
  return clipTerminal(` ${label}`, Math.max(0, geometry.bodyWidth - 1)) + " ";
}

/** Gloomberb-style line icon centered in a compact, exact-width hit target. */
export function iconButtonWidth(width?: number): number {
  return Math.max(0, Math.floor(width ?? 3));
}

export function iconButtonText(icon: string, width?: number): string {
  const resolved = iconButtonWidth(width);
  if (resolved <= 0) return "";
  const glyph = clipTerminal(icon, 1);
  if (resolved === 1) return glyph;
  const left = Math.floor((resolved - 1) / 2);
  return `${" ".repeat(left)}${glyph}${" ".repeat(Math.max(0, resolved - left - 1))}`;
}

export function actionChipSpansFromRight<T extends { label: string }>(
  actions: readonly T[],
  rightEdge: number,
  gap: number,
): (T & { start: number; width: number })[] {
  const widths = actions.map((action) => actionChipWidth(action.label));
  const total =
    widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  let x = Math.max(0, rightEdge - total);
  return actions.map((action, index) => {
    const width = widths[index] ?? 0;
    const out = { ...action, start: x, width };
    x += width + gap;
    return out;
  });
}

export interface RecipeGalleryItem extends Rect {
  id: string;
  kind:
    | "surface"
    | "section"
    | "row"
    | "button"
    | "badge"
    | "tabs"
    | "input"
    | "keyhint"
    | "empty"
    | "scrollbar";
  label: string;
}

export interface RecipeGalleryLayout {
  width: number;
  height: number;
  mode: ResolvedThemeMode;
  header: Rect;
  footer: Rect;
  columns: readonly Rect[];
  items: readonly RecipeGalleryItem[];
}

export type RecipeGalleryCommand = "toggle-mode" | "move-next" | "move-prev" | "activate" | "none";

export interface RecipeGalleryModel {
  mode: ResolvedThemeMode;
  selectedId: string;
  pressedId: string | null;
  message: string;
}

const STATE_ORDER: readonly RecipeResolvedState[] = [
  "disabled",
  "pressed",
  "selected",
  "focused",
  "attention",
  "hovered",
  "loading",
  "empty",
  "status",
  "base",
];

export const RECIPE_STATE_PRECEDENCE = STATE_ORDER;

function domainStatusForRecipeTone(tone: RecipeTone | undefined): CanonicalDomainStatus {
  if (tone === "blocked") return "blocked";
  if (tone === "working") return "running";
  if (tone === "done") return "done";
  return "idle";
}

function statusToneForRecipeTone(tone: RecipeTone | undefined): StatusToneRole {
  return statusToneForDomainStatus(domainStatusForRecipeTone(tone));
}

function statusColor(theme: SemanticThemeSnapshot, tone: RecipeTone | undefined): RGBA {
  return theme.roles.statusTone[statusToneForRecipeTone(tone)];
}

function interactionAppearance(state: RecipeInteractionState) {
  const paneState: PaneVisualStateV1 = {
    structure: "docked",
    applicationFocus: {
      pane: Boolean(state.focused),
      terminalInput: false,
      windowActive: true,
    },
    agentActivity: state.loading ? "running" : "idle",
    domainStatus: domainStatusForRecipeTone(state.status),
    attention: state.attention ? "requested" : "none",
    layoutInteraction: {
      editable: true,
      selected: Boolean(state.selected),
      dragging: false,
      resizing: false,
      previewing: false,
    },
    controlInteraction: {
      hover: Boolean(state.hovered),
      focusVisible: Boolean(state.focused),
      pressed: Boolean(state.pressed),
      disabled: Boolean(state.disabled),
      loading: Boolean(state.loading),
    },
  };
  return resolvePaneAppearance(paneState);
}

export function resolveRecipeState(state: RecipeInteractionState): RecipeResolvedState {
  const interaction = interactionAppearance(state);
  if (interaction.action.background === "disabled") return "disabled";
  if (interaction.action.background === "pressed") return "pressed";
  if (state.selected) return "selected";
  if (state.focused) return "focused";
  if (state.attention) return "attention";
  if (interaction.action.background === "hover") return "hovered";
  if (state.loading) return "loading";
  if (state.empty) return "empty";
  if (state.status) return "status";
  return "base";
}

function stateAccent(
  theme: SemanticThemeSnapshot,
  state: RecipeInteractionState,
  fallback: RGBA,
): RGBA {
  return state.status ? statusColor(theme, state.status) : fallback;
}

export function openTuiRecipeColors(theme: SemanticThemeSnapshot, recipeId: VisualRecipeId) {
  const recipe = VISUAL_RECIPE_REGISTRY[recipeId];
  return {
    foreground: theme.roles.text[recipe.text],
    background: theme.roles.surfaces[recipe.surface],
    border: theme.roles.borders[recipe.border],
  } as const;
}

export function recipePalette(
  theme: SemanticThemeSnapshot,
  state: RecipeInteractionState = {},
  tone: RecipeTone = state.status ?? "neutral",
): RecipePalette {
  const resolved = resolveRecipeState(state);
  if (resolved === "disabled") {
    return {
      state: resolved,
      foreground: theme.roles.text.muted,
      background: theme.roles.selection.disabled,
      border: theme.roles.borders.subtle,
      accent: theme.roles.statusTone.neutral,
      marker: "×",
    };
  }
  if (resolved === "pressed") {
    return {
      state: resolved,
      foreground: theme.roles.selection.selectionText,
      background: theme.roles.selection.pressed,
      border: theme.roles.borders.focused,
      accent: theme.roles.borders.focused,
      marker: "◆",
    };
  }
  if (resolved === "selected") {
    return {
      state: resolved,
      foreground: theme.roles.selection.selectionText,
      background: theme.roles.selection.selection,
      border: theme.roles.borders.selected,
      accent: stateAccent(theme, state, theme.roles.borders.focused),
      marker: theme.glyphs.active,
    };
  }
  if (resolved === "focused") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.surfaces.panelRaised,
      border: theme.roles.borders.focused,
      accent: stateAccent(theme, state, theme.roles.borders.focused),
      marker: "›",
    };
  }
  if (resolved === "hovered") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.selection.hover,
      border: theme.roles.borders.default,
      accent: stateAccent(theme, state, theme.roles.text.link),
      marker: "·",
    };
  }
  if (resolved === "attention") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.derived.attentionSurface,
      border: theme.roles.borders.attention,
      accent: stateAccent(theme, state, theme.roles.borders.attention),
      marker: "!",
    };
  }
  if (resolved === "loading") {
    return {
      state: resolved,
      foreground: theme.roles.text.muted,
      background: theme.roles.surfaces.panel,
      border: theme.roles.borders.default,
      accent: theme.roles.statusTone.info,
      marker: "…",
    };
  }
  if (resolved === "empty") {
    return {
      state: resolved,
      foreground: theme.roles.text.muted,
      background: theme.roles.surfaces.canvas,
      border: theme.roles.borders.subtle,
      accent: theme.roles.statusTone.neutral,
      marker: "○",
    };
  }
  if (resolved === "status") {
    const accent = statusColor(theme, state.status);
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.surfaces.panel,
      border: accent,
      accent,
      marker: theme.glyphs.active,
    };
  }
  const accent = tone === "accent" ? theme.roles.text.link : statusColor(theme, tone);
  return {
    state: resolved,
    foreground: theme.roles.text.primary,
    background: theme.roles.surfaces.panel,
    border: theme.roles.borders.default,
    accent,
    marker: theme.glyphs.inactive,
  };
}

export function rowText(marker: string, label: string, meta: string, width: number): string {
  const parts = rowParts(marker, label, meta, width);
  return `${parts.marker}${parts.body}`;
}

export function rowParts(
  marker: string,
  label: string,
  meta: string,
  width: number,
): RecipeRowParts {
  if (width <= 0) return { marker: "", body: "" };
  const markerPart = clipTerminal(marker, width);
  const markerWidth = terminalDisplayWidth(markerPart);
  const bodyWidth = Math.max(0, width - markerWidth);
  if (bodyWidth <= 0) return { marker: markerPart, body: "" };
  const prefix = " ";
  const textWidth = Math.max(0, bodyWidth - 1);
  if (!meta) return { marker: markerPart, body: `${prefix}${clipTerminal(label, textWidth)}` };
  const metaWidth = terminalDisplayWidth(meta);
  if (metaWidth + 1 >= textWidth) {
    return { marker: markerPart, body: `${prefix}${clipTerminal(meta, textWidth)}` };
  }
  const titleWidth = Math.max(0, textWidth - metaWidth - 1);
  const title = clipTerminal(label, titleWidth);
  const gap = " ".repeat(Math.max(1, textWidth - terminalDisplayWidth(title) - metaWidth));
  return { marker: markerPart, body: `${prefix}${title}${gap}${meta}` };
}

export function scrollbarGlyphs(
  contentRows: number,
  viewportRows: number,
  top: number,
  height: number,
): readonly string[] {
  if (height <= 0) return [];
  if (contentRows <= viewportRows || contentRows <= 0)
    return Array.from({ length: height }, () => "░");
  const thumbHeight = Math.max(1, Math.floor((viewportRows / contentRows) * height));
  const maxTop = Math.max(1, contentRows - viewportRows);
  const thumbTop = Math.min(
    height - thumbHeight,
    Math.floor((top / maxTop) * (height - thumbHeight)),
  );
  return Array.from({ length: height }, (_, index) =>
    index >= thumbTop && index < thumbTop + thumbHeight ? "█" : "░",
  );
}

const GALLERY_ITEMS: readonly Omit<RecipeGalleryItem, keyof Rect>[] = [
  { id: "surface", kind: "surface", label: "Surface / Panel" },
  { id: "section", kind: "section", label: "SectionHeader" },
  { id: "row", kind: "row", label: "SelectableRow" },
  { id: "button", kind: "button", label: "Button / ActionChip" },
  { id: "badge", kind: "badge", label: "Badge / StatusChip" },
  { id: "tabs", kind: "tabs", label: "Tabs / SegmentedControl" },
  { id: "input", kind: "input", label: "InputShell" },
  { id: "keyhint", kind: "keyhint", label: "KeyHint" },
  { id: "empty", kind: "empty", label: "EmptyState" },
  { id: "scrollbar", kind: "scrollbar", label: "Scrollbar" },
];

export function createRecipeGalleryModel(mode: ResolvedThemeMode = "dark"): RecipeGalleryModel {
  return { mode, selectedId: "button", pressedId: null, message: "ready" };
}

const GALLERY_THEME_DARK = createSemanticThemeSnapshot({ mode: "dark" });
const GALLERY_THEME_LIGHT = createSemanticThemeSnapshot({ mode: "light" });

export function recipeGalleryTheme(mode: ResolvedThemeMode): SemanticThemeSnapshot {
  return mode === "light" ? GALLERY_THEME_LIGHT : GALLERY_THEME_DARK;
}

export function recipeGalleryLayout(
  width: number,
  height: number,
  mode: ResolvedThemeMode,
): RecipeGalleryLayout {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  const header = { x: 0, y: 0, width: safeWidth, height: Math.min(2, safeHeight) };
  const footerHeight = safeHeight > 0 ? 1 : 0;
  const footer = {
    x: 0,
    y: Math.max(0, safeHeight - footerHeight),
    width: safeWidth,
    height: footerHeight,
  };
  const bodyY = header.height;
  const bodyHeight = Math.max(0, safeHeight - header.height - footer.height);
  const gap = safeWidth >= 96 ? 2 : 1;
  const columnCount = safeWidth >= 80 && bodyHeight >= 15 ? 2 : 1;
  const columnWidth = columnCount === 2 ? Math.floor((safeWidth - gap) / 2) : safeWidth;
  const columns: Rect[] =
    columnCount === 2
      ? [
          { x: 0, y: bodyY, width: columnWidth, height: bodyHeight },
          {
            x: columnWidth + gap,
            y: bodyY,
            width: safeWidth - columnWidth - gap,
            height: bodyHeight,
          },
        ]
      : [{ x: 0, y: bodyY, width: safeWidth, height: bodyHeight }];
  const rowsPerColumn = Math.max(1, Math.ceil(GALLERY_ITEMS.length / columnCount));
  const items: RecipeGalleryItem[] = [];
  for (const [index, item] of GALLERY_ITEMS.entries()) {
    const columnIndex = Math.min(columns.length - 1, Math.floor(index / rowsPerColumn));
    const row = index % rowsPerColumn;
    const column = columns[columnIndex];
    if (!column) continue;
    const y = column.y + row * 3;
    if (y >= column.y + column.height) continue;
    items.push({
      ...item,
      x: column.x,
      y,
      width: column.width,
      height: Math.min(3, column.y + column.height - y),
    });
  }
  return Object.freeze({
    width: safeWidth,
    height: safeHeight,
    mode,
    header,
    footer,
    columns: Object.freeze(columns),
    items: Object.freeze(items),
  });
}

export function recipeGalleryHitTest(
  layout: RecipeGalleryLayout,
  x: number,
  y: number,
): string | null {
  for (const item of layout.items) {
    if (x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height) {
      return item.id;
    }
  }
  return null;
}

export function recipeGalleryCommandForKey(
  name: string,
  ctrl = false,
  meta = false,
): RecipeGalleryCommand {
  if (ctrl || meta) return "none";
  if (name === "tab" || name === "down" || name === "right" || name === "j") return "move-next";
  if (name === "up" || name === "left" || name === "k") return "move-prev";
  if (name === "space" || name === "return" || name === "enter") return "activate";
  if (name === "t") return "toggle-mode";
  return "none";
}

export function applyRecipeGalleryCommand(
  model: RecipeGalleryModel,
  command: RecipeGalleryCommand,
  itemId?: string | null,
): RecipeGalleryModel {
  const ids = GALLERY_ITEMS.map((item) => item.id);
  const current = Math.max(0, ids.indexOf(model.selectedId));
  if (itemId && ids.includes(itemId)) {
    return { ...model, selectedId: itemId, pressedId: itemId, message: `selected ${itemId}` };
  }
  if (command === "toggle-mode") {
    const mode = model.mode === "dark" ? "light" : "dark";
    return { ...model, mode, message: `${mode} mode` };
  }
  if (command === "move-next") {
    const selectedId = ids[(current + 1) % ids.length]!;
    return { ...model, selectedId, pressedId: null, message: `focus ${selectedId}` };
  }
  if (command === "move-prev") {
    const selectedId = ids[(current - 1 + ids.length) % ids.length]!;
    return { ...model, selectedId, pressedId: null, message: `focus ${selectedId}` };
  }
  if (command === "activate") {
    return { ...model, pressedId: model.selectedId, message: `activated ${model.selectedId}` };
  }
  return model;
}
