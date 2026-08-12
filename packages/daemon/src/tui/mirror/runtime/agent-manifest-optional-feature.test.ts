import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadLocalSourceBoundaryGraph } from "../../../../test-support/source-import-boundaries.ts";

describe("production agent manifest demand boundary", () => {
  const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
  const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

  it("keeps agent manifest IO and bundled definitions outside the first-frame closure", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      repoRoot,
      ["packages/daemon/src/tui/mirror/runtime/application-root.tsx"],
      new Set(["static-runtime"]),
    );
    expect(graph.files).not.toContain("packages/daemon/src/tui/detect/manifest-loader.ts");
    expect(graph.files).not.toContain("packages/daemon/src/tui/detect/manifests.ts");
  });

  it("loads definitions only for agent actions and fails without opening a stale flow", () => {
    expect(source).toContain('await import("../../detect/manifest-loader.ts")');
    expect(source).not.toMatch(/import\s+\{\s*getManifests\s*\}\s+from/u);
    expect(source.match(/await loadAgentManifests\(\)/gu)).toHaveLength(2);
    expect(source.match(/if \(!manifests\) return;/gu)).toHaveLength(2);
  });
});
