import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadLocalSourceBoundaryGraph } from "../../../../test-support/source-import-boundaries.ts";

describe("production palette optional feature cutover", () => {
  const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");

  it("keeps the whole palette graph outside the root first-frame closure", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      process.cwd(),
      ["src/tui/mirror/runtime/application-root.tsx"],
      new Set(["static-runtime"]),
    );
    for (const deferred of [
      "src/tui/mirror/features/palette/feature.ts",
      "src/tui/mirror/features/palette/session.ts",
      "src/tui/mirror/features/palette/surface.tsx",
      "src/tui/mirror/palette.ts",
      "src/tui/mirror/palette-surface-adapter.ts",
      "src/tui/mirror/workspace/command-palette-surface.ts",
      "src/tui/mirror/workspace/command-palette-surface.tsx",
    ]) {
      expect(graph.files).not.toContain(deferred);
    }
  });

  it("removes legacy palette state, models, rendering, and routing from root", () => {
    for (const legacy of [
      "paletteQuery",
      "paletteSelectedCommandId",
      "paletteBufferLoadGate",
      "paletteProjection",
      "paletteGeom",
      "CommandPaletteSurface",
      "commandPaletteHitTest",
      "adaptPaletteRowsToCommands",
      "dispatchPaletteCommand",
      "paletteBuffers",
    ]) {
      expect(source).not.toContain(legacy);
    }
    expect(source).not.toMatch(/from\s+["']\.\.\/palette(?:-surface-adapter)?\.ts["']/u);
  });

  it("reserves admission before requesting and delegates state/input/render", () => {
    const opener = source.slice(
      source.indexOf("const openPalette ="),
      source.indexOf("const retryPalette ="),
    );
    expect(opener.indexOf('reserveModal("palette")')).toBeLessThan(
      opener.indexOf("ensurePaletteFeature()"),
    );
    expect(source).toContain("paletteSession()?.handleKey(evt)");
    expect(source).toContain("paletteSession()?.handlePaste(text)");
    expect(source).toContain("paletteSession()?.handlePointer({");
    expect(source).toContain("component={paletteFeature()!.PaletteFeatureSurface}");
    expect(source).toContain("paletteSession()?.switchWorkspace(identity)");
  });

  it("releases palette admission before semantic settings transfer and records usage once", () => {
    const execute = source.slice(
      source.indexOf("executePaletteHostIntent ="),
      source.indexOf("const paletteKey ="),
    );
    expect(execute.indexOf("closePalette(intent.reason)")).toBeLessThan(
      execute.indexOf("runSettingsCommand(intent.command)"),
    );
    expect(execute.match(/recordPaletteUse\(/gu)).toHaveLength(1);
  });
});
