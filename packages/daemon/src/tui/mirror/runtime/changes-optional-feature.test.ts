import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";

describe("deferred Changes feature boundary", () => {
  it("keeps the production root free of eager Changes implementation imports", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    for (const specifier of [
      "../changes-surface.tsx",
      "../changes-surface.ts",
      "../diff-model.ts",
      "../features/changes/controller.ts",
    ]) {
      expect(source).not.toContain(`from "${specifier}"`);
    }
    expect(source).toContain('optionalFeatures.request("changes")');
    expect(source).toContain('activeDockTab() === "changes"');
    expect(source).toContain("component={feature().ChangesSurface}");
    expect(source).toContain('"Loading Changes…"');
    expect(source).toContain("feature.createChangesFeatureController(");
    expect(source).toContain("changesSession()?.dispose()");
    expect(source).not.toContain("createSignal<DiffEntry");
    expect(source).not.toContain("setDiffEntries(");
    expect(source).not.toContain("runChangesAction");
    expect(source).not.toContain("changesHitTest(");
  });

  it("keeps Changes state, Git IO, projection, and disposal together", () => {
    const source = readFileSync(
      new URL("../features/changes/controller.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("createRoot((disposeOwner)");
    expect(source).toContain("projectChangesSurface({");
    expect(source).toContain("host.runGit(directory()");
    expect(source).toContain("host.readFile(join(directory(), entry.path))");
    expect(source).toContain("disposeOwner();");
  });

  it("generation-fences deferred Changes prepare before publishing loaded state", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    const start = source.indexOf("const prepareDiff = (");
    const end = source.indexOf("const enterDiff =", start);
    const prepare = source.slice(start, end);
    expect(prepare).toContain("changesPrepareIntent.issue(scope)");
    expect(prepare).toContain("changesPrepareIntent.isCurrent(intent, scope)");
    expect(prepare).toContain("changesSession()?.prepare(identity)");
  });

  it("fences deferred selection hydration by full workspace identity", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    const start = source.indexOf('} else if (entry.panel === "diff")');
    const end = source.indexOf('} else if (entry.panel === "missions")', start);
    const hydration = source.slice(start, end);
    expect(hydration).toContain("changesHydrationIntent.issue(scope)");
    expect(hydration).toContain("changesHydrationIntent.isCurrent(intent, changesIdentityScope())");
    expect(hydration).toContain("changesSession()?.restoreSelectedPath(entry.selectedPath)");
    expect(hydration).toContain("() => undefined");
  });

  it("binds the startup diff directory to its original workspace identity", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    expect(source).toContain("const startupChangesIdentity = values.diff");
    expect(source).toContain("workspaceName === startupChangesIdentity.workspaceName");
    expect(source).toContain("!contextDir()");
    const workspaceActivation = source.slice(
      source.indexOf("const openWorkspace ="),
      source.indexOf("const jumpToAgent ="),
    );
    expect(workspaceActivation).toContain("setContextDir(wd)");
    expect(workspaceActivation).toContain("changesHydrationIntent.retire()");
  });

  it("retains Changes demand without starting its literal loader before admission", () => {
    const registry = createApplicationOptionalFeatureRegistry();
    const first = registry.request("changes");
    const second = registry.request("changes");
    expect(first).toBe(second);
    expect(registry.getMetrics()).toMatchObject({
      requests: 2,
      retainedIntents: 1,
      joinedRequests: 1,
      loadsStarted: 0,
      publications: 0,
    });
    registry.dispose();
    void first.catch(() => undefined);
  });
});
