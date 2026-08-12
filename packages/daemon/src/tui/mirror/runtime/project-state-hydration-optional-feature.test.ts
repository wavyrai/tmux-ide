import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadLocalSourceBoundaryGraph } from "../../../../test-support/source-import-boundaries.ts";

describe("production project state hydration boundary", () => {
  const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
  const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url));

  it("keeps project config and UI-state repository IO outside the first-frame closure", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      repoRoot,
      ["packages/daemon/src/tui/mirror/runtime/application-root.tsx"],
      new Set(["static-runtime"]),
    );
    expect(graph.files).not.toContain("packages/daemon/src/lib/config-context.ts");
    expect(graph.files).not.toContain("packages/daemon/src/lib/project-runtime-repository.ts");
  });

  it("retains generation fencing and the existing fallback after deferred load failure", () => {
    expect(source).toContain('import("../../../lib/config-context.ts")');
    expect(source).toContain('import("../../../lib/project-runtime-repository.ts")');
    expect(source).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/lib\/config-context\.ts["']/u);
    expect(source).not.toMatch(
      /from\s+["']\.\.\/\.\.\/\.\.\/lib\/project-runtime-repository\.ts["']/u,
    );
    expect(source).toContain("if (!panelGeneration.isCurrent(generation)) return");
    expect(source).toContain("workspaceUiController.failLoad(uiGeneration)");
    expect(source).toContain("config views unavailable (${loadStage})");
  });
});
