import type { SemanticThemeSnapshot } from "../theme.ts";
import { componentPalette, type ComponentInteractionState } from "./state.ts";

/** Shared surface treatment for command and appearance lists. */
export function overlayRowPalette(
  theme: SemanticThemeSnapshot,
  state: ComponentInteractionState = {},
) {
  const palette = componentPalette(theme, state);
  return {
    ...palette,
    // Current is a marker, not a second selection background.
    background:
      state.selected || state.disabled || state.attention
        ? palette.background
        : theme.roles.surfaces.command,
    accent: state.selected && !state.disabled ? palette.foreground : palette.accent,
  };
}
