import { describe, expect, it } from "vitest";
import {
  COHESION_FIXTURE_V1,
  VISUAL_RECIPE_REGISTRY,
  type VisualRecipeId,
} from "@tmux-ide/contracts";
import {
  applyRecipeGalleryCommand,
  createRecipeGalleryModel,
  recipeGalleryCommandForKey,
  recipeGalleryHitTest,
  recipeGalleryLayout,
  recipeGalleryTheme,
  openTuiRecipeColors,
  recipePalette,
  resolveRecipeState,
  rowText,
  scrollbarGlyphs,
} from "./recipes.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { colorToThemeBytes, createSemanticThemeSnapshot } from "./theme.ts";

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

describe("visual recipes", () => {
  it("resolves recipe state precedence explicitly", () => {
    expect(
      resolveRecipeState({
        disabled: true,
        pressed: true,
        selected: true,
        focused: true,
        hovered: true,
        attention: true,
        loading: true,
        empty: true,
        status: "working",
      }),
    ).toBe("disabled");
    expect(resolveRecipeState({ pressed: true, selected: true })).toBe("pressed");
    expect(resolveRecipeState({ selected: true, focused: true })).toBe("selected");
    expect(resolveRecipeState({ focused: true, hovered: true, attention: true })).toBe("focused");
    expect(resolveRecipeState({ hovered: true, attention: true })).toBe("attention");
    expect(resolveRecipeState({ hovered: true, status: "blocked" })).toBe("hovered");
    expect(resolveRecipeState({ status: "done" })).toBe("status");
  });

  it("keeps semantic status color orthogonal to selected interaction state", () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark" });
    const blockedSelected = recipePalette(theme, {
      selected: true,
      hovered: true,
      status: "blocked",
    });
    expect(blockedSelected.state).toBe("selected");
    expect(colorKey(blockedSelected.background)).toBe(colorKey(theme.roles.selection.selection));
    expect(colorKey(blockedSelected.border)).toBe(colorKey(theme.roles.borders.selected));
    expect(colorKey(blockedSelected.accent)).toBe(colorKey(theme.roles.statusTone.warning));
  });

  it("derives palettes from the semantic theme without a second hard-coded palette", () => {
    const theme = createSemanticThemeSnapshot({ mode: "dark", accent: "#123456" });
    const selected = recipePalette(theme, { selected: true });
    const focused = recipePalette(theme, { focused: true });
    const blocked = recipePalette(theme, { status: "blocked" });

    expect(colorKey(selected.background)).toBe(colorKey(theme.roles.selection.selection));
    expect(colorKey(selected.border)).toBe(colorKey(theme.roles.borders.selected));
    expect(colorKey(focused.accent)).toBe(colorKey(theme.roles.borders.focused));
    expect(colorKey(blocked.accent)).toBe(colorKey(theme.roles.statusTone.warning));
  });

  it("maps canonical recipes through the common fixture in dark, light, and high contrast", () => {
    const fixtureTheme = createSemanticThemeSnapshot({
      mode: "dark",
      userTheme: COHESION_FIXTURE_V1.theme.user,
      projectTheme: COHESION_FIXTURE_V1.theme.project ?? undefined,
      accessibility: COHESION_FIXTURE_V1.theme.accessibility,
    });
    const themes = [
      fixtureTheme,
      createSemanticThemeSnapshot({ mode: "light" }),
      createSemanticThemeSnapshot({
        mode: "dark",
        accessibility: { reducedMotion: false, increasedContrast: true },
      }),
    ];
    for (const theme of themes) {
      for (const recipeId of Object.keys(VISUAL_RECIPE_REGISTRY) as VisualRecipeId[]) {
        const recipe = VISUAL_RECIPE_REGISTRY[recipeId];
        const colors = openTuiRecipeColors(theme, recipeId);
        expect(colorKey(colors.background)).toBe(colorKey(theme.roles.surfaces[recipe.surface]));
        expect(colorKey(colors.foreground)).toBe(colorKey(theme.roles.text[recipe.text]));
        expect(colorKey(colors.border)).toBe(colorKey(theme.roles.borders[recipe.border]));
      }
    }
  });

  it("pins row metadata within the requested terminal width", () => {
    const text = rowText(
      "▶",
      "A very long mission title that must not eat metadata",
      "running · codex",
      30,
    );
    expect(terminalDisplayWidth(text)).toBeLessThanOrEqual(30);
    expect(text).toContain("running · codex");

    const narrow = rowText("▶", "title", "running · codex", 8);
    expect(terminalDisplayWidth(narrow)).toBeLessThanOrEqual(8);
    expect(narrow).toContain("run");
  });

  it("projects scrollbar glyphs deterministically", () => {
    expect(scrollbarGlyphs(5, 10, 0, 3)).toEqual(["░", "░", "░"]);
    expect(scrollbarGlyphs(100, 10, 50, 5)).toEqual(["░", "░", "█", "░", "░"]);
    expect(scrollbarGlyphs(0, 0, 0, 0)).toEqual([]);
  });
});

describe("recipe gallery projection", () => {
  it.each([
    [80, 24, 2],
    [120, 40, 2],
  ] as const)("keeps %sx%s gallery geometry in bounds", (width, height, expectedColumns) => {
    const layout = recipeGalleryLayout(width, height, "dark");
    expect(layout.columns).toHaveLength(expectedColumns);
    expect(layout.items.map((item) => item.id)).toEqual([
      "surface",
      "section",
      "row",
      "button",
      "badge",
      "tabs",
      "input",
      "keyhint",
      "empty",
      "scrollbar",
    ]);
    for (const rect of [layout.header, layout.footer, ...layout.columns, ...layout.items]) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.width).toBeGreaterThanOrEqual(0);
      expect(rect.height).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(width);
      expect(rect.y + rect.height).toBeLessThanOrEqual(height);
    }
  });

  it("hit-tests recipe item rectangles from the same layout projection", () => {
    const layout = recipeGalleryLayout(120, 40, "light");
    const button = layout.items.find((item) => item.id === "button");
    expect(button).toBeDefined();
    expect(recipeGalleryHitTest(layout, button!.x, button!.y)).toBe("button");
    expect(
      recipeGalleryHitTest(
        layout,
        button!.x + Math.max(0, button!.width - 1),
        button!.y + Math.max(0, button!.height - 1),
      ),
    ).toBe("button");
    expect(recipeGalleryHitTest(layout, 119, 39)).toBeNull();
  });

  it("applies gallery commands without owning global routing", () => {
    const model = createRecipeGalleryModel("dark");
    expect(recipeGalleryCommandForKey("tab")).toBe("move-next");
    expect(recipeGalleryCommandForKey("t")).toBe("toggle-mode");
    expect(recipeGalleryCommandForKey("t", true)).toBe("none");

    const next = applyRecipeGalleryCommand(model, "move-next");
    expect(next.selectedId).not.toBe(model.selectedId);
    const toggled = applyRecipeGalleryCommand(next, "toggle-mode");
    expect(toggled.mode).toBe("light");
    const clicked = applyRecipeGalleryCommand(toggled, "none", "input");
    expect(clicked.selectedId).toBe("input");
    expect(clicked.pressedId).toBe("input");
  });

  it("uses stable immutable dark/light gallery theme snapshots", () => {
    const darkA = recipeGalleryTheme("dark");
    const darkB = recipeGalleryTheme("dark");
    const light = recipeGalleryTheme("light");
    expect(darkA).toBe(darkB);
    expect(darkA).not.toBe(light);
    expect(Object.isFrozen(darkA.colors)).toBe(true);
  });
});
