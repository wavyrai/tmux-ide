import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";

describe("application optional feature loaders", () => {
  it("uses literal imports for every deferred module in the standalone Bun graph", () => {
    const source = readFileSync(
      new URL("./application-optional-features.ts", import.meta.url),
      "utf8",
    );
    for (const specifier of [
      "../features/home/feature.tsx",
      "../features/dialogs/feature.tsx",
      "../features/settings/feature.ts",
      "../features/palette/feature.ts",
      "../features/rich-preview/feature.tsx",
      "../features/performance-hud/feature.tsx",
    ]) {
      expect(source).toContain(`() => import("${specifier}")`);
    }
    for (const quarantined of ["files", "changes", "missions-activity"]) {
      expect(source).not.toMatch(
        new RegExp(
          `^[ \\t]*${quarantined === "missions-activity" ? "missionsActivity" : quarantined}:[ \\t]*\\(\\)[ \\t]*=>[ \\t]*import\\(`,
          "mu",
        ),
      );
    }
  });

  it("constructs without loading any optional module", () => {
    const registry = createApplicationOptionalFeatureRegistry();
    expect(registry.getMetrics()).toMatchObject({ requests: 0, loadsStarted: 0, publications: 0 });
    registry.dispose();
  });

  it.each(["files", "changes", "missionsActivity"] as const)(
    "keeps the quarantined %s feature outside the executable loader graph",
    async (key) => {
      const registry = createApplicationOptionalFeatureRegistry();
      const result = await registry.request(key);
      registry.admit();
      expect(result).toBeUndefined();
      expect(registry.getMetrics()).toMatchObject({
        requests: 1,
        unavailableRequests: 1,
        loadsStarted: 0,
        publications: 0,
      });
      registry.dispose();
    },
  );

  it.each([
    ["home", "runOpenFolderFlow"],
    ["dialogs", "createDialogFeatureSession"],
    ["settings", "createSettingsFeatureSession"],
    ["palette", "createPaletteFeatureSession"],
    ["richPreview", "createRichPreviewFeatureSession"],
    ["performanceHud", "createPerformanceHudSession"],
  ] as const)(
    "retains and publishes the real %s feature after admission",
    async (key, exportName) => {
      const registry = createApplicationOptionalFeatureRegistry();
      const request = registry.request(key);
      expect(registry.getMetrics()).toMatchObject({ loadsStarted: 0, retainedIntents: 1 });
      registry.admit();
      const feature = await request;
      expect(feature?.[exportName]).toBeTypeOf("function");
      expect(registry.getMetrics()).toMatchObject({
        loadsStarted: 1,
        loadsSucceeded: 1,
        publications: 1,
      });
      registry.dispose();
    },
  );
});
