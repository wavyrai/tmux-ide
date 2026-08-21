import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createApplicationOptionalFeatureRegistry } from "./application-optional-features.ts";
import { changesIdentityKey, resolveDeferredChangesIdentity } from "./changes-deferred-identity.ts";
import { LatestIntentFence } from "./latest-intent-fence.ts";

describe("deferred Changes feature boundary", () => {
  it("keeps the production root free of eager Changes implementation imports", () => {
    const source = readFileSync(new URL("./application-root.tsx", import.meta.url), "utf8");
    for (const specifier of [
      "../changes-surface-view.tsx",
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
    expect(source).toContain("resolveDeferredChangesIdentity({");
    expect(source).toContain("startup: startupChangesIdentity");
    const committedWorkspaceActivation = source.slice(
      source.indexOf("const applyWorkspaceContext ="),
      source.indexOf("let pendingWorkspaceSwitch", source.indexOf("const applyWorkspaceContext =")),
    );
    expect(committedWorkspaceActivation).toContain("setContextDir(wd)");
    expect(committedWorkspaceActivation).toContain("changesHydrationIntent.retire()");
  });

  it("deterministically rejects A hydration after a same-directory switch to B", () => {
    const fence = new LatestIntentFence<string>();
    const alpha = { workspaceName: "alpha", directory: "/repo" };
    const beta = { workspaceName: "beta", directory: "/repo" };
    const intent = fence.issue(changesIdentityKey(alpha));

    expect(fence.isCurrent(intent, changesIdentityKey(alpha))).toBe(true);
    expect(fence.isCurrent(intent, changesIdentityKey(beta))).toBe(false);
  });

  it("drops startup --diff after a pre-readiness workspace switch", () => {
    const startup = { workspaceName: "alpha", directory: "/alpha-explicit" };
    expect(
      resolveDeferredChangesIdentity({
        workspaceName: "alpha",
        directory: "",
        fallbackDirectory: "/cwd",
        startup,
      }),
    ).toEqual(startup);
    expect(
      resolveDeferredChangesIdentity({
        workspaceName: "beta",
        directory: "/repo",
        fallbackDirectory: "/cwd",
        startup,
      }),
    ).toEqual({ workspaceName: "beta", directory: "/repo" });
  });

  it("rejects quarantined Changes demand without retaining or loading it", async () => {
    const registry = createApplicationOptionalFeatureRegistry();
    await expect(registry.request("changes")).resolves.toBeUndefined();
    await expect(registry.request("changes")).resolves.toBeUndefined();
    expect(registry.getMetrics()).toMatchObject({
      requests: 2,
      retainedIntents: 0,
      joinedRequests: 0,
      unavailableRequests: 2,
      loadsStarted: 0,
      publications: 0,
    });
    registry.dispose();
  });
});
