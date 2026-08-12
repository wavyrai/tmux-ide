import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { loadLocalSourceBoundaryGraph } from "../../../../test-support/source-import-boundaries.ts";

describe("production rich-preview optional feature cutover", () => {
  const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");

  it("keeps native rich rendering and asset IO outside the root first-frame closure", async () => {
    const graph = await loadLocalSourceBoundaryGraph(
      process.cwd(),
      ["src/tui/mirror/runtime/application-root.tsx"],
      new Set(["static-runtime"]),
    );
    for (const deferred of [
      "src/tui/mirror/features/rich-preview/feature.tsx",
      "src/tui/mirror/features/rich-preview/session.ts",
      "src/tui/mirror/features/rich-preview/asset-loader.ts",
      "src/tui/mirror/widget-surface.tsx",
      "src/tui/mirror/widget-surface-model.ts",
      "src/lib/widget-asset-store.ts",
    ]) {
      expect(graph.files).not.toContain(deferred);
    }
  });

  it("removes the legacy synchronous cache, IO, model, and eager native style", () => {
    for (const legacy of [
      "richWidgetCache",
      "richWidgetFor",
      "readWidgetAsset",
      "resolveTuiWidgetSurface",
      "markdownSyntaxStyle",
      "ownedMarkdownSyntaxStyle",
      "RichPlacementProjection",
    ]) {
      expect(source).not.toContain(legacy);
    }
    expect(source).not.toMatch(/import\s+\{[^}]*SyntaxStyle/u);
    expect(source).not.toMatch(/from\s+["']\.\.\/widget-surface(?:-model)?\.tsx?["']/u);
  });

  it("requests only admitted visible canonical demand and delegates authority to the session", () => {
    const reconciliation = source.slice(
      source.indexOf("publishRichPreviewChange = markDirty"),
      source.indexOf("// The framebuffer surfaces react directly"),
    );
    expect(reconciliation).toContain("terminalFeaturesAdmitted()");
    expect(reconciliation).toContain('canvasPanel() === "terminals"');
    expect(reconciliation).toContain("collectRichPreviewCanonicalDemand({");
    expect(reconciliation).toContain("placementsFor: richPlacementsFor");
    expect(reconciliation).toContain("semanticView?.canonicalSnapshot(paneId)");
    expect(reconciliation).toContain(
      "feature.richPreviewRequestsFromCanonical(canonical, placements)",
    );
    expect(reconciliation).toContain("session.sync(latestRichPreviewRequests)");
    expect(reconciliation.indexOf("sources.length === 0")).toBeLessThan(
      reconciliation.indexOf("ensureRichPreviewFeature()"),
    );
  });

  it("renders the deferred surface under the stable canonical renderable identity", () => {
    const start = source.indexOf("const richWidgetOverlay =");
    const overlay = source.slice(start, source.indexOf("const interaction =", start));
    expect(overlay).toContain("<RichPreviewOverlay");
    expect(overlay).toContain("placementIds={richPlacementIdsFor(paneId)}");
    expect(overlay).toContain("publicationFor={richPreviewPublicationFor}");
    expect(overlay).toContain("surfaceComponent={richPreviewFeature()?.TuiRichWidgetSurface}");
  });

  it("retires rich authority on attach and feature shutdown", () => {
    expect(source).toContain("richPreviewSession()?.sync([])");
    expect(source).toContain("richPreviewSession()?.dispose()");
    expect(source).toContain("richPreviewFeatureRequest = null");
  });
});
