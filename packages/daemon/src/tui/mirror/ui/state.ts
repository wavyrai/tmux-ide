import type { RGBA } from "@opentui/core";

import type { SemanticThemeSnapshot } from "../theme.ts";

export type ComponentTone =
  | "neutral"
  | "accent"
  | "warning"
  | "destructive"
  | "blocked"
  | "working"
  | "done"
  | "idle"
  | "unknown";

export interface ComponentInteractionState {
  selected?: boolean;
  focused?: boolean;
  hovered?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  attention?: boolean;
  /** Passive context chip: related scope, but neither selected nor interactive focus. */
  context?: boolean;
  loading?: boolean;
  empty?: boolean;
  status?: Exclude<ComponentTone, "neutral" | "accent">;
}

export type ComponentResolvedState =
  | "disabled"
  | "pressed"
  | "selected"
  | "focused"
  | "hovered"
  | "attention"
  | "context"
  | "loading"
  | "empty"
  | "status"
  | "base";

export interface ComponentPalette {
  state: ComponentResolvedState;
  foreground: RGBA;
  background: RGBA;
  border: RGBA;
  accent: RGBA;
  marker: string;
}

function resolveComponentState(state: ComponentInteractionState): ComponentResolvedState {
  if (state.disabled) return "disabled";
  if (state.pressed) return "pressed";
  if (state.selected) return "selected";
  if (state.focused) return "focused";
  if (state.attention) return "attention";
  if (state.context) return "context";
  if (state.hovered) return "hovered";
  if (state.loading) return "loading";
  if (state.empty) return "empty";
  if (state.status) return "status";
  return "base";
}

function toneColor(theme: SemanticThemeSnapshot, tone: ComponentTone | undefined): RGBA {
  switch (tone) {
    case "warning":
    case "destructive":
    case "blocked":
      return theme.roles.statusTone.warning;
    case "working":
      return theme.roles.statusTone.info;
    case "done":
      return theme.roles.statusTone.success;
    case "idle":
      return theme.roles.statusTone.neutral;
    case "unknown":
      return theme.roles.statusTone.neutral;
    case "accent":
      return theme.roles.statusTone.info;
    case "neutral":
    default:
      return theme.roles.statusTone.neutral;
  }
}

/** Lightweight interaction recipe used by production UI primitives. */
export function componentPalette(
  theme: SemanticThemeSnapshot,
  state: ComponentInteractionState = {},
  tone: ComponentTone = state.status ?? "neutral",
): ComponentPalette {
  const resolved = resolveComponentState(state);
  const statusAccent = toneColor(theme, state.status ?? tone);
  const urgent = Boolean(state.attention || tone === "warning" || tone === "destructive");
  const urgencyBorder = urgent ? theme.roles.borders.attention : undefined;
  const urgencyAccent = urgent ? theme.roles.statusTone.warning : undefined;
  const urgencyMarker = urgent ? "!" : undefined;
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
      border: urgencyBorder ?? theme.roles.borders.focused,
      accent: urgencyAccent ?? theme.roles.borders.focused,
      marker: urgencyMarker ?? "◆",
    };
  }
  if (resolved === "selected") {
    return {
      state: resolved,
      foreground: theme.roles.selection.selectionText,
      background: theme.roles.selection.selection,
      border: urgencyBorder ?? theme.roles.borders.selected,
      accent: urgencyAccent ?? (state.status ? statusAccent : theme.roles.borders.focused),
      marker: urgencyMarker ?? theme.glyphs.active,
    };
  }
  if (resolved === "focused") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.surfaces.panelRaised,
      border: urgencyBorder ?? theme.roles.borders.focused,
      accent: urgencyAccent ?? (state.status ? statusAccent : theme.roles.borders.focused),
      marker: urgencyMarker ?? "›",
    };
  }
  if (resolved === "hovered") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.selection.hover,
      border: urgencyBorder ?? theme.roles.borders.default,
      accent: urgencyAccent ?? (state.status ? statusAccent : theme.roles.text.link),
      marker: urgencyMarker ?? "·",
    };
  }
  if (resolved === "attention") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.derived.attentionSurface,
      border: theme.roles.borders.attention,
      accent: state.status ? statusAccent : theme.roles.borders.attention,
      marker: "!",
    };
  }
  if (resolved === "context") {
    return {
      state: resolved,
      foreground: theme.roles.text.link,
      background: theme.roles.surfaces.panelRaised,
      border: theme.roles.borders.subtle,
      accent: theme.roles.text.link,
      marker: "⧉",
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
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.surfaces.panel,
      border: statusAccent,
      accent: statusAccent,
      marker: theme.glyphs.active,
    };
  }
  if (tone === "destructive") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.derived.attentionSurface,
      border: theme.roles.borders.attention,
      accent: theme.roles.statusTone.warning,
      marker: "!",
    };
  }
  return {
    state: resolved,
    foreground: theme.roles.text.primary,
    background: theme.roles.surfaces.panel,
    border: urgencyBorder ?? theme.roles.borders.default,
    accent: urgencyAccent ?? toneColor(theme, tone),
    marker: urgencyMarker ?? theme.glyphs.inactive,
  };
}
