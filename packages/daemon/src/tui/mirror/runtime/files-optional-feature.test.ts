import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";

describe("deferred Files feature boundary", () => {
  it("keeps the production root free of eager Files implementation imports", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    for (const specifier of [
      "../files-surface.tsx",
      "../files-surface.ts",
      "../editor-buffer.ts",
      "../editor-open-policy.ts",
      "../file-tree.ts",
    ]) {
      expect(source).not.toContain(`from "${specifier}"`);
    }
    expect(source).toContain('optionalFeatures.request("files")');
    expect(source).toContain('activeDockTab() === "files"');
    expect(source).toContain("component={feature().FilesSurface}");
    expect(source).toContain('"Loading Files…"');
  });

  it("keeps the non-git palette fallback on the ignore-aware Files directory port", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const walkRepoFiles = async");
    const end = source.indexOf("const loadRepoFiles =", start);
    const fallback = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(fallback).toContain("await ensureFilesFeature()");
    expect(fallback).toContain("await listDir(dir)");
    expect(fallback).toContain("feature.relPath(root, abs)");
    expect(fallback).not.toContain("readdir(");
    expect(fallback).not.toContain("alwaysIgnore");
  });

  it("generation-fences deferred editor opens before applying loaded Files state", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const openEditor = (");
    const end = source.indexOf("const toggleEditor =", start);
    const openEditor = source.slice(start, end);
    expect(openEditor).toContain("intent = editorOpenIntent.issue()");
    expect(openEditor.match(/editorOpenIntent\.isCurrent\(intent\)/gu)).toHaveLength(2);
    expect(openEditor).toContain("openEditor(rawPath, line, origin, intent)");
  });

  it("retains Files demand without starting its literal loader before admission", () => {
    const registry = createApplicationOptionalFeatureRegistry();
    const request = registry.request("files");
    expect(registry.getMetrics()).toMatchObject({
      requests: 1,
      retainedIntents: 1,
      loadsStarted: 0,
      publications: 0,
    });
    registry.dispose();
    void request.catch(() => undefined);
  });
});
