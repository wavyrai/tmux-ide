import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";

describe("deferred Files feature boundary", () => {
  it("keeps the production root free of eager Files implementation imports", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    for (const specifier of [
      "../files-surface-view.tsx",
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
    expect(source).not.toContain("RGBA, EditBuffer");
    expect(source).not.toContain("createSignal<FileNode");
    expect(source).not.toContain("setFileNodes(");
    expect(source).not.toContain("setFileStatusEntries(");
    expect(source).not.toContain("writeFile(");
    expect(source).not.toContain("void rename(m.filePath");
    expect(source).not.toContain("void rm(m.filePath");
    expect(source).toContain("feature.createFilesFeatureSession({");
    expect(source).toContain("filesSession()?.dispose()");
  });

  it("keeps Files state, IO, projection, and native buffer lifecycle together", () => {
    const source = readFileSync(new URL("../features/files/session.ts", import.meta.url), "utf8");
    expect(source).toContain('import { EditBuffer } from "@opentui/core"');
    expect(source).toContain('from "node:fs/promises"');
    expect(source).toContain("createMemo<FilesSurfaceProjection>");
    expect(source).toContain("createRoot((dispose)");
    expect(source).toContain("this.#buffer?.destroy()");
    expect(source).toContain("this.#disposeReactiveOwner()");
  });

  it("keeps the non-git palette fallback on the ignore-aware Files directory port", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    const start = source.indexOf("loadRepoFiles: async");
    const end = source.indexOf("loadBuffers: async", start);
    const fallback = source.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(fallback).toContain("await ensureFilesFeature()");
    expect(fallback).toMatch(/await\s+listDir\([^)]*\)/u);
    expect(fallback).toMatch(/feature\.relPath\(identity\.directory,\s*absolute\)/u);
    expect(fallback).not.toContain("readdir(");
    expect(fallback).not.toContain("alwaysIgnore");
  });

  it("generation-fences deferred editor opens before applying loaded Files state", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const openEditor = (");
    const end = source.indexOf("const toggleEditor =", start);
    const openEditor = source.slice(start, end);
    expect(openEditor).toContain("intent = editorOpenIntent.issue(editorOpenScope())");
    expect(
      openEditor.match(/editorOpenIntent\.isCurrent\(intent, editorOpenScope\(\)\)/gu),
    ).toHaveLength(2);
    expect(openEditor).toContain("openEditor(rawPath, line, origin, intent)");
  });

  it("treats hydration as passive retained intent canceled by navigation or workspace change", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    expect(source).toContain('openEditor(openPath, undefined, "workspace-hydration")');
    expect(source).toContain("const editorOpenScope = () => `${contextSession()}\\u0000${");
    const canvasActivation = source.slice(
      source.indexOf("const activateCanvasPanelContent"),
      source.indexOf("const activateCanvasPanel ="),
    );
    expect(canvasActivation).toContain("editorOpenIntent.retire()");
    const workspaceActivation = source.slice(
      source.indexOf("const openWorkspace ="),
      source.indexOf("const jumpToAgent ="),
    );
    expect(workspaceActivation).toContain("editorOpenIntent.retire()");
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
