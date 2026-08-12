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
      "../features/files/feature.tsx",
      "../features/changes/feature.tsx",
      "../missions-surface.tsx",
      "../activity-surface.tsx",
      "../workspace/command-palette-surface.tsx",
      "../widget-surface.tsx",
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
});
