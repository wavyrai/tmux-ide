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
      "../files-surface.tsx",
      "../changes-surface.tsx",
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
});
