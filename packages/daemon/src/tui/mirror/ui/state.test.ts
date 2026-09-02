import { describe, expect, it } from "vitest";

import { colorToThemeBytes, createSemanticThemeSnapshot } from "../theme.ts";
import { componentPalette, type ComponentInteractionState } from "./state.ts";

describe("OpenTUI component state recipes", () => {
  const theme = createSemanticThemeSnapshot({ mode: "dark" });
  const colorKey = (color: Parameters<typeof colorToThemeBytes>[0]) =>
    colorToThemeBytes(color).join(",");

  it.each([
    [{ disabled: true, pressed: true, selected: true }, "disabled"],
    [{ pressed: true, selected: true, focused: true }, "pressed"],
    [{ selected: true, focused: true, attention: true }, "selected"],
    [{ focused: true, attention: true, hovered: true }, "focused"],
    [{ attention: true, hovered: true }, "attention"],
    [{ hovered: true }, "hovered"],
    [{ loading: true }, "loading"],
    [{ empty: true }, "empty"],
    [{}, "base"],
  ] as const)("resolves %o to %s", (state, expected) => {
    expect(componentPalette(theme, state as ComponentInteractionState).state).toBe(expected);
  });

  it("preserves urgency when navigation state is stronger than attention", () => {
    const selected = componentPalette(theme, { selected: true, attention: true });
    expect(selected.state).toBe("selected");
    expect(selected.marker).toBe("!");
    expect(colorKey(selected.background)).toBe(colorKey(theme.roles.selection.selection));
    expect(colorKey(selected.border)).toBe(colorKey(theme.roles.borders.attention));
    expect(colorKey(selected.accent)).toBe(colorKey(theme.roles.statusTone.warning));
  });

  it("projects destructive tone through the shared attention recipe", () => {
    const destructive = componentPalette(theme, {}, "destructive");
    expect(destructive.marker).toBe("!");
    expect(colorKey(destructive.background)).toBe(colorKey(theme.derived.attentionSurface));
    expect(colorKey(destructive.border)).toBe(colorKey(theme.roles.borders.attention));
  });
});
