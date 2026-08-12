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
      "../features/files/feature.tsx",
      "../features/changes/feature.tsx",
      "../features/missions-activity/feature.tsx",
      "../features/dialogs/feature.tsx",
      "../features/settings/feature.ts",
      "../features/palette/feature.ts",
      "../features/rich-preview/feature.tsx",
      "../features/performance-hud/feature.tsx",
    ]) {
      expect(source).toContain(`() => import("${specifier}")`);
    }
  });

  it("constructs without loading any optional module", () => {
    const registry = createApplicationOptionalFeatureRegistry();
    expect(registry.getMetrics()).toMatchObject({ requests: 0, loadsStarted: 0, publications: 0 });
    registry.dispose();
  });

  it("evaluates and publishes the real Files module exactly once after admission", async () => {
    const registry = createApplicationOptionalFeatureRegistry();
    const first = registry.request("files");
    const second = registry.request("files");
    expect(first).toBe(second);
    expect(registry.getMetrics()).toMatchObject({ loadsStarted: 0, retainedIntents: 1 });

    registry.admit();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left?.createFilesFeatureSession).toBeTypeOf("function");
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 1,
      loadsSucceeded: 1,
      publications: 1,
      joinedRequests: 1,
    });
    registry.dispose();
  });

  it("evaluates and publishes the real Changes module exactly once after admission", async () => {
    const registry = createApplicationOptionalFeatureRegistry();
    const first = registry.request("changes");
    const second = registry.request("changes");
    expect(first).toBe(second);
    expect(registry.getMetrics()).toMatchObject({ loadsStarted: 0, retainedIntents: 1 });

    registry.admit();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left?.createChangesFeatureController).toBeTypeOf("function");
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 1,
      loadsSucceeded: 1,
      publications: 1,
      joinedRequests: 1,
    });
    registry.dispose();
  });

  it("evaluates and publishes one shared Missions and Activity module exactly once", async () => {
    const registry = createApplicationOptionalFeatureRegistry();
    const first = registry.request("missionsActivity");
    const second = registry.request("missionsActivity");
    expect(first).toBe(second);
    expect(registry.getMetrics()).toMatchObject({ loadsStarted: 0, retainedIntents: 1 });

    registry.admit();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left?.createMissionsActivityFeatureSession).toBeTypeOf("function");
    expect(left?.MissionsSurface).toBeTypeOf("function");
    expect(left?.ActivitySurface).toBeTypeOf("function");
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 1,
      loadsSucceeded: 1,
      publications: 1,
      joinedRequests: 1,
    });
    registry.dispose();
  });

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
