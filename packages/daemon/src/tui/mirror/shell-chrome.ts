import type { RGBA } from "@opentui/core";
import type { HostedPanelView } from "./panel-host.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import type { Rect } from "./recipes.ts";
import type { SemanticThemeSnapshot } from "./theme.ts";
import type { Span } from "./spans.ts";

export type ShellChromeVariant = "compact" | "standard" | "wide";

export interface ShellChromeLayout {
  width: number;
  height: number;
  variant: ShellChromeVariant;
  tabbar: Rect;
  sidebar: Rect;
  main: Rect;
  status: Rect;
  paletteWidth: number;
  dialogWidth: number;
}

export interface ShellTabPresentation {
  id: string;
  label: string;
  span: Span;
  selected: boolean;
  focused: boolean;
  hovered: boolean;
  attention: boolean;
}

export interface ShellSidebarHint {
  pre: string;
  btn: string;
  post: string;
  buttonSpan: Span;
  label: string;
  inset: number;
}

export interface ShellVisualState {
  selected?: boolean;
  focused?: boolean;
  hovered?: boolean;
  context?: boolean;
  attention?: boolean;
  terminalFocus?: boolean;
}

export interface ShellVisualPalette {
  fg: RGBA;
  bg: RGBA;
  border: RGBA;
  marker: string;
  attributes: number;
}

export const SHELL_TABBAR_ROWS = 1;
export const SHELL_STATUS_ROWS = 1;

export function shellChromeVariant(width: number, height: number): ShellChromeVariant {
  if (width >= 160 && height >= 45) return "wide";
  if (width >= 96 && height >= 30) return "standard";
  return "compact";
}

export function shellOverlayWidth(
  terminalWidth: number,
  variant: ShellChromeVariant,
  kind: "palette" | "dialog",
): number {
  const safe = Math.max(20, Math.floor(terminalWidth));
  const margin = variant === "compact" ? 2 : 4;
  const preferred =
    kind === "palette" ? (variant === "wide" ? 72 : 60) : variant === "wide" ? 72 : 60;
  return Math.max(32, Math.min(preferred, safe - margin));
}

export function shellSidebarWidth(
  terminalWidth: number,
  preferredWidth: number,
  variant = shellChromeVariant(terminalWidth, 24),
): number {
  const safe = Math.max(20, Math.floor(terminalWidth));
  const preferred = Math.max(16, Math.min(48, Math.floor(preferredWidth)));
  if (variant === "compact") return Math.min(preferred, Math.max(16, Math.min(20, safe - 48)));
  if (variant === "standard") return Math.min(preferred, 32);
  return preferred;
}

export function shellChromeLayout(
  width: number,
  height: number,
  preferredSidebarWidth: number,
): ShellChromeLayout {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeHeight = Math.max(0, Math.floor(height));
  const variant = shellChromeVariant(safeWidth, safeHeight);
  const sidebarWidth =
    safeHeight > SHELL_TABBAR_ROWS
      ? shellSidebarWidth(safeWidth, preferredSidebarWidth, variant)
      : 0;
  const statusHeight = safeHeight >= 8 ? SHELL_STATUS_ROWS : 0;
  const bodyY = Math.min(SHELL_TABBAR_ROWS, safeHeight);
  const bodyHeight = Math.max(0, safeHeight - bodyY);
  return {
    width: safeWidth,
    height: safeHeight,
    variant,
    tabbar: { x: 0, y: 0, width: safeWidth, height: Math.min(SHELL_TABBAR_ROWS, safeHeight) },
    sidebar: { x: 0, y: bodyY, width: sidebarWidth, height: bodyHeight },
    main: {
      x: sidebarWidth,
      y: bodyY,
      width: Math.max(0, safeWidth - sidebarWidth),
      height: bodyHeight,
    },
    status: {
      x: sidebarWidth,
      y: Math.max(bodyY, safeHeight - statusHeight),
      width: Math.max(0, safeWidth - sidebarWidth),
      height: statusHeight,
    },
    paletteWidth: shellOverlayWidth(safeWidth, variant, "palette"),
    dialogWidth: shellOverlayWidth(safeWidth, variant, "dialog"),
  };
}

export function shellPanelCell(
  view: Pick<HostedPanelView, "glyph" | "title" | "shortcut">,
  variant: ShellChromeVariant,
  attention = false,
): string {
  const glyph = attention ? "!" : view.glyph;
  if (variant === "compact") return ` ${glyph} `;
  const shortcut = view.shortcut ? `${view.shortcut.label} ` : "";
  if (variant === "standard") return ` ${glyph} ${view.title} `;
  return ` ${shortcut}${glyph} ${view.title} `;
}

export function shellSurfaceTabs(
  views: readonly HostedPanelView[],
  activeViewId: string,
  variant: ShellChromeVariant,
  hoveredIndex: number | null,
  attentionViewIds: ReadonlySet<string> = new Set(),
): readonly ShellTabPresentation[] {
  let x = 0;
  return views.map((view, index) => {
    const attention = attentionViewIds.has(view.id);
    const label = shellPanelCell(view, variant, attention);
    const width = terminalDisplayWidth(label);
    const item: ShellTabPresentation = {
      id: view.id,
      label,
      span: { start: x, width },
      selected: view.id === activeViewId,
      focused: view.id === activeViewId,
      hovered: hoveredIndex === index,
      attention,
    };
    x += width;
    return item;
  });
}

export function shellSurfaceTabSpans(
  views: readonly HostedPanelView[],
  variant: ShellChromeVariant,
): Span[] {
  return shellSurfaceTabs(views, "", variant, null).map((tab) => tab.span);
}

export function shellSidebarHint(
  variant: ShellChromeVariant,
  quitHint: string,
  width = variant === "compact" ? 20 : 28,
  inset = 2,
): ShellSidebarHint {
  const safeWidth = Math.max(0, Math.floor(width));
  const safeInset = Math.max(0, Math.min(safeWidth, Math.floor(inset)));
  const contentWidth = Math.max(0, safeWidth - safeInset);
  const quit = quitHint.includes("detach") ? "^q detach" : "^q quit";
  const btn = "F5";
  const candidates =
    variant === "compact"
      ? [`${btn} · ${quit}`, `${btn}/${quit}`]
      : [`${btn} palette · ${quit}`, `${btn} pal · ${quit}`, `${btn}/${quit}`];
  const label =
    candidates.find((candidate) => terminalDisplayWidth(candidate) <= contentWidth) ??
    clipToWidth(`${btn}/${quit}`, contentWidth);
  const btnStart = Math.max(0, label.indexOf(btn));
  const btnEnd = btnStart >= 0 ? btnStart + btn.length : 0;
  return {
    pre: label.slice(0, btnStart),
    btn,
    post: label.slice(btnEnd),
    buttonSpan: {
      start: safeInset + terminalDisplayWidth(label.slice(0, btnStart)),
      width: btn.length,
    },
    label,
    inset: safeInset,
  };
}

function clipToWidth(value: string, width: number): string {
  if (width <= 0) return "";
  if (terminalDisplayWidth(value) <= width) return value;
  let out = "";
  for (const char of value) {
    if (terminalDisplayWidth(out + char) > width) break;
    out += char;
  }
  return out;
}

export function shellVisualPalette(
  theme: SemanticThemeSnapshot,
  state: ShellVisualState,
): ShellVisualPalette {
  const attention = Boolean(state.attention);
  if (state.terminalFocus) {
    return {
      fg: theme.roles.text.inverse,
      bg: theme.roles.borders.focused,
      border: attention ? theme.roles.statusTone.warning : theme.roles.borders.focused,
      marker: attention ? "!" : "▣",
      attributes: 1,
    };
  }
  if (state.selected) {
    return {
      fg: theme.roles.selection.selectionText,
      bg: theme.roles.selection.selection,
      border: attention ? theme.roles.statusTone.warning : theme.roles.borders.selected,
      marker: attention ? "!" : theme.glyphs.active,
      attributes: state.focused ? 1 : 0,
    };
  }
  if (attention) {
    return {
      fg: theme.roles.text.primary,
      bg: theme.derived.attentionSurface,
      border: theme.roles.statusTone.warning,
      marker: "!",
      attributes: 1,
    };
  }
  if (state.context) {
    return {
      fg: theme.roles.text.link,
      bg: theme.roles.surfaces.panelRaised,
      border: theme.roles.borders.subtle,
      marker: "⧉",
      attributes: 0,
    };
  }
  if (state.hovered) {
    return {
      fg: theme.roles.text.primary,
      bg: theme.roles.selection.hover,
      border: theme.roles.borders.default,
      marker: "·",
      attributes: 0,
    };
  }
  if (state.focused) {
    return {
      fg: theme.roles.text.primary,
      bg: theme.roles.surfaces.panelRaised,
      border: theme.roles.borders.focused,
      marker: "›",
      attributes: 0,
    };
  }
  return {
    fg: theme.roles.text.muted,
    bg: theme.roles.surfaces.panel,
    border: theme.roles.borders.subtle,
    marker: theme.glyphs.inactive,
    attributes: 0,
  };
}

export function shellStatusLine(
  variant: ShellChromeVariant,
  input: {
    project: string;
    mode: string;
    notification: string | null;
    help: string;
  },
  width: number,
): string {
  const context = variant === "compact" ? `${input.mode}` : `${input.project} · ${input.mode}`;
  const note = input.notification ? ` · ${input.notification}` : "";
  const help = variant === "compact" ? input.help.split(" · ")[0] : input.help;
  const text = ` ${context}${note} · ${help}`;
  if (terminalDisplayWidth(text) <= width) return text;
  let out = "";
  for (const char of text) {
    if (terminalDisplayWidth(`${out}${char}…`) > width) break;
    out += char;
  }
  return `${out}…`;
}
