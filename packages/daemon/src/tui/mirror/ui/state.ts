import type { RGBA } from "@opentui/core";

import type { SemanticThemeSnapshot } from "../theme.ts";

export type ComponentTone =
  | "neutral"
  | "accent"
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
  if (state.hovered) return "hovered";
  if (state.loading) return "loading";
  if (state.empty) return "empty";
  if (state.status) return "status";
  return "base";
}

function toneColor(theme: SemanticThemeSnapshot, tone: ComponentTone | undefined): RGBA {
  switch (tone) {
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
      accent: state.status ? statusAccent : theme.roles.borders.focused,
      marker: theme.glyphs.active,
    };
  }
  if (resolved === "focused") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.surfaces.panelRaised,
      border: theme.roles.borders.focused,
      accent: state.status ? statusAccent : theme.roles.borders.focused,
      marker: "›",
    };
  }
  if (resolved === "hovered") {
    return {
      state: resolved,
      foreground: theme.roles.text.primary,
      background: theme.roles.selection.hover,
      border: theme.roles.borders.default,
      accent: state.status ? statusAccent : theme.roles.text.link,
      marker: "·",
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
  return {
    state: resolved,
    foreground: theme.roles.text.primary,
    background: theme.roles.surfaces.panel,
    border: theme.roles.borders.default,
    accent: toneColor(theme, tone),
    marker: theme.glyphs.inactive,
  };
}
