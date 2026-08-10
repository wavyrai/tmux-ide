/* @jsxImportSource @opentui/solid */
import type { TestRendererSetup } from "@opentui/core/testing";
import { describe, expect, it } from "bun:test";
import { Sidebar, sidebarThemePalette } from "./sidebar.tsx";
import {
  colorToThemeBytes,
  createSemanticThemeSnapshot,
  themeContrastRatio,
  type SemanticThemeSnapshot,
} from "./theme.ts";
import { expectFrameBounds, renderForTest, stableFrame } from "./testing/renderer-harness.test.ts";

let setup: TestRendererSetup | null = null;

function colorKey(color: Parameters<typeof colorToThemeBytes>[0]): string {
  return colorToThemeBytes(color).join(",");
}

async function renderSidebar(theme: SemanticThemeSnapshot) {
  setup = await renderForTest(
    () => (
      <Sidebar
        theme={theme}
        width={32}
        sessions={[
          { name: "workspace", status: "working" },
          { name: "docs", status: "idle" },
        ]}
        agents={[
          {
            paneId: "%7",
            windowIndex: 0,
            session: "workspace",
            kind: "codex",
            state: "working",
            since: 90,
          },
        ]}
        current="workspace"
        nowSec={120}
        isHovered={() => false}
        flashed={() => false}
        hint={{ pre: " ", btn: "F5", post: " palette" }}
      />
    ),
    { width: 32, height: 14 },
  );
  await setup.renderOnce();
  return setup;
}

function spanContaining(text: string) {
  return setup!
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes(text));
}

describe("Sidebar OpenTUI renderer", () => {
  it.each(["dark", "light"] as const)(
    "renders legible owned navigation in %s mode",
    async (mode) => {
      const theme = createSemanticThemeSnapshot({ mode });
      const palette = sidebarThemePalette(theme);
      const renderer = await renderSidebar(theme);
      const frame = renderer.captureCharFrame();

      expectFrameBounds(frame, 32, 14);
      expect(stableFrame(frame)).toContain("agents · 1");
      expect(stableFrame(frame)).toContain("codex · workspace");

      const selected = spanContaining("workspace");
      const heading = spanContaining("agents · 1");
      const agent = spanContaining("codex · workspace");
      expect(selected).toBeDefined();
      expect(heading).toBeDefined();
      expect(agent).toBeDefined();
      expect(colorKey(selected!.fg)).toBe(colorKey(palette.selectedLabel));
      expect(colorKey(selected!.bg)).toBe(colorKey(palette.selectedSurface));
      expect(colorKey(heading!.fg)).toBe(colorKey(palette.label));
      expect(colorKey(agent!.fg)).toBe(colorKey(palette.label));
      expect(themeContrastRatio(heading!.fg, heading!.bg)).toBeGreaterThanOrEqual(4.5);
      expect(themeContrastRatio(agent!.fg, agent!.bg)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("repairs a custom theme whose navigation and selection text match their surfaces", async () => {
    const panel = { space: "srgb" as const, red: 19, green: 19, blue: 26, alpha: 255 };
    const selection = { space: "srgb" as const, red: 49, green: 95, blue: 137, alpha: 255 };
    const theme = createSemanticThemeSnapshot({
      mode: "dark",
      userTheme: {
        version: 1,
        id: "adversarial-sidebar",
        name: "Adversarial sidebar",
        appearance: "dark",
        overrides: {
          surfaces: { panel },
          text: { primary: panel, secondary: panel, muted: panel },
          selection: { selection, selectionText: selection },
        },
      },
    });
    const palette = sidebarThemePalette(theme);
    await renderSidebar(theme);

    const heading = spanContaining("agents · 1");
    const selected = spanContaining("workspace");
    expect(heading).toBeDefined();
    expect(selected).toBeDefined();
    expect(colorKey(heading!.fg)).toBe(colorKey(palette.label));
    expect(colorKey(selected!.fg)).toBe(colorKey(palette.selectedLabel));
    expect(themeContrastRatio(heading!.fg, heading!.bg)).toBeGreaterThanOrEqual(4.5);
    expect(themeContrastRatio(selected!.fg, selected!.bg)).toBeGreaterThanOrEqual(4.5);
    expect(colorKey(heading!.fg)).not.toBe(colorKey(theme.roles.surfaces.panel));
    expect(colorKey(selected!.fg)).not.toBe(colorKey(theme.roles.selection.selection));
  });
});
