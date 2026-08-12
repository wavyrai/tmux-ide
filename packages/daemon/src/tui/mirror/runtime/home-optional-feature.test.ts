import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadLocalSourceBoundaryGraph } from "../../../../test-support/source-import-boundaries.ts";
import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";

const PRE_HOME_SEAM_STATIC_BYTES = 1_263_222;

describe("terminal-first Home optional feature", () => {
  it("keeps Home actions outside the terminal-first static root by at least 50KB", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      process.cwd(),
      ["src/tui/mirror/runtime/application-root.tsx"],
      new Set(["static-runtime"]),
    );
    const bytes = [...graph.sourceByFile.values()].reduce(
      (total, source) => total + Buffer.byteLength(source),
      0,
    );
    expect(PRE_HOME_SEAM_STATIC_BYTES - bytes).toBeGreaterThanOrEqual(50_000);
    for (const deferred of [
      "src/tui/mirror/features/home/feature.tsx",
      "src/tui/mirror/home-surface.tsx",
      "src/tui/mirror/home-surface-model.ts",
      "src/tui/mirror/folder-picker.ts",
      "src/tui/mirror/agent-provisioning-executor.ts",
      "src/lib/project-registry.ts",
    ]) {
      expect(graph.files).not.toContain(deferred);
    }
  });

  it("uses one literal demand loader and retains a single Home module instance", async () => {
    const source = readFileSync(
      new URL("./application-optional-features.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('home: () => import("../features/home/feature.tsx")');

    const registry = createApplicationOptionalFeatureRegistry();
    const first = registry.request("home");
    const second = registry.request("home");
    expect(first).toBe(second);
    expect(registry.getMetrics()).toMatchObject({ loadsStarted: 0, retainedIntents: 1 });
    registry.admit();
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(left?.HomeSurface).toBeTypeOf("function");
    expect(left?.runOpenFolderFlow).toBeTypeOf("function");
    expect(left?.executeTuiAgentProvisioning).toBeTypeOf("function");
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 1,
      loadsSucceeded: 1,
      publications: 1,
      joinedRequests: 1,
    });
    registry.dispose();
  });
});
