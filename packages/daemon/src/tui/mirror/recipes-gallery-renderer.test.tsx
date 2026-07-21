/* @jsxImportSource @opentui/solid */
import { MouseButtons } from "@opentui/core/testing";
import { testRender } from "@opentui/solid";
import { afterEach, describe, expect, it } from "bun:test";
import { RecipesGallery } from "./recipes-gallery.tsx";
import {
  createRecipeGalleryModel,
  recipeGalleryHitTest,
  recipeGalleryLayout,
  recipeGalleryTheme,
  type RecipeGalleryModel,
} from "./recipes.ts";
import { terminalDisplayWidth } from "./panel-host.ts";
import { colorToThemeBytes } from "./theme.ts";

type TestSetup = Awaited<ReturnType<typeof testRender>>;

let setup: TestSetup | null = null;

afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

function frameLines(frame: string): string[] {
  const lines = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n");
  return lines.map((line) => line.replace(/\r$/u, ""));
}

function stableFrame(frame: string): string {
  return frameLines(frame)
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");
}

function expectFrameBounds(frame: string, width: number, height: number): void {
  const lines = frameLines(frame);
  expect(lines).toHaveLength(height);
  for (const line of lines) {
    expect(terminalDisplayWidth(line)).toBeLessThanOrEqual(width);
  }
}

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

function expectFrameShowsEveryRecipe(frame: string): void {
  const stable = stableFrame(frame);
  for (const label of [
    "Panel",
    "SectionHeader",
    "Blocked selected row",
    "Run action",
    "blocked",
    "Board  History  Detail",
    "Search…",
    "toggle theme",
    "Nothing here",
    "Scroll content",
  ]) {
    expect(stable).toContain(label);
  }
}

function expectSemanticMarkerSpan(mode: "dark" | "light"): void {
  const theme = recipeGalleryTheme(mode);
  const spans = setup!.captureSpans();
  const blockedLine = spans.lines.find((line) =>
    line.spans.some((span) => span.text.includes("Blocked selected row")),
  );
  expect(blockedLine).toBeDefined();
  const marker = blockedLine!.spans.find((span) => span.text === theme.glyphs.active);
  expect(marker).toBeDefined();
  expect(colorKey(marker!.fg)).toBe(colorKey(theme.roles.statusTone.warning));
  expect(colorKey(marker!.bg)).toBe(colorKey(theme.roles.selection.selection));
}

function expectInputPlaceholderSpan(mode: "dark" | "light"): void {
  const theme = recipeGalleryTheme(mode);
  const spans = setup!.captureSpans();
  const inputLine = spans.lines.find((line) =>
    line.spans.some((span) => span.text.includes("Search…")),
  );
  expect(inputLine).toBeDefined();
  const placeholder = inputLine!.spans.find((span) => span.text.includes("Search…"));
  expect(placeholder).toBeDefined();
  expect(colorKey(placeholder!.fg)).toBe(colorKey(theme.roles.text.muted));
}

async function renderGallery(width: number, height: number, initial: RecipeGalleryModel) {
  let model = initial;
  setup = await testRender(
    () => (
      <RecipesGallery
        width={width}
        height={height}
        initial={initial}
        onModel={(next) => {
          model = next;
        }}
      />
    ),
    { width, height },
  );
  await setup.renderOnce();
  return {
    model: () => model,
    frame: () => setup!.captureCharFrame(),
    clickItem: async (id: string) => {
      const layout = recipeGalleryLayout(width, height, model.mode);
      const item = layout.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`No gallery item ${id}`);
      const x = item.x + Math.floor(item.width / 2);
      const y = item.y + Math.floor(item.height / 2);
      expect(recipeGalleryHitTest(layout, x, y)).toBe(id);
      await setup!.mockMouse.click(x, y, MouseButtons.LEFT);
      await setup!.renderOnce();
    },
  };
}

describe("RecipesGallery OpenTUI renderer", () => {
  it.each([
    [80, 24, "dark"],
    [80, 24, "light"],
    [120, 40, "dark"],
    [120, 40, "light"],
  ] as const)("renders deterministic %sx%s %s gallery frame", async (width, height, mode) => {
    const harness = await renderGallery(width, height, createRecipeGalleryModel(mode));
    const frame = harness.frame();
    expectFrameBounds(frame, width, height);
    expect(recipeGalleryLayout(width, height, mode).items.map((item) => item.id)).toEqual([
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
    expectFrameShowsEveryRecipe(frame);
    const input = recipeGalleryLayout(width, height, mode).items.find(
      (item) => item.id === "input",
    );
    const inputShell = stableFrame(frame).match(/│ Search…\s*│/u)?.[0];
    expect(input).toBeDefined();
    expect(inputShell).toBeDefined();
    expect(terminalDisplayWidth(inputShell!)).toBe(input!.width);
    expectInputPlaceholderSpan(mode);
    expectSemanticMarkerSpan(mode);
    expect(stableFrame(frame)).toMatchSnapshot();
    expect(stableFrame(frame)).toContain(`recipe gallery · ${mode}`);
  });

  it("updates the gallery through isolated keyboard commands", async () => {
    const harness = await renderGallery(80, 24, createRecipeGalleryModel("dark"));
    const initial = stableFrame(harness.frame());

    await setup!.mockInput.pressKey("t");
    await setup!.renderOnce();
    expect(harness.model().mode).toBe("light");
    expect(stableFrame(harness.frame())).toContain("light mode");

    await setup!.mockInput.pressKey("j");
    await setup!.renderOnce();
    expect(harness.model().selectedId).toBe("badge");

    setup!.mockInput.pressEnter();
    await setup!.renderOnce();
    expect(harness.model().pressedId).toBe("badge");
    expect(stableFrame(harness.frame())).toContain("activated badge");
    expect(stableFrame(harness.frame())).not.toBe(initial);
  });

  it("routes mouse selection through projected gallery hit geometry", async () => {
    const harness = await renderGallery(120, 40, createRecipeGalleryModel("dark"));
    await harness.clickItem("input");
    expect(harness.model().selectedId).toBe("input");
    expect(harness.model().pressedId).toBe("input");
    const frame = stableFrame(harness.frame());
    expect(frame).toContain("selected input");
    expect(frame).toContain("typed query▏");
  });

  it("destroys cleanly without a hanging renderer", async () => {
    await renderGallery(80, 24, createRecipeGalleryModel("dark"));
    setup!.renderer.destroy();
    setup = null;
  });
});
