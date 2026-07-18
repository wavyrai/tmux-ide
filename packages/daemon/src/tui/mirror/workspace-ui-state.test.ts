import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectResolution } from "../../lib/project-resolver.ts";
import { createProjectRuntimeRepository } from "../../lib/project-runtime-repository.ts";
import type { HostedPanelView } from "./panel-host.ts";
import {
  WORKSPACE_UI_STATE_MAX_VIEWS,
  WORKSPACE_UI_STATE_PATH,
  WorkspaceUiStateController,
  absoluteProjectPath,
  chooseInitialWorkspaceView,
  defaultWorkspaceUiState,
  loadWorkspaceUiState,
  mergeWorkspaceUiStateForSave,
  missionsSelection,
  parseWorkspaceUiStateJson,
  relativeProjectPath,
  serializeWorkspaceUiState,
  setMissionsSelection,
  setWorkspaceViewLayoutState,
  shouldHydrateWorkspaceView,
  viewStateFor,
  layoutStateForView,
  writeWorkspaceUiStateWithRetry,
  type WorkspaceUiStateV1,
} from "./workspace-ui-state.ts";

const roots: string[] = [];
const IDENTITY_KEY = `git-${"b".repeat(64)}`;

function temporaryRoot(prefix = "tmux-ide-ui-state-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function resolution(
  projectRoot: string,
  overrides: Partial<ProjectResolution> = {},
): ProjectResolution {
  return {
    inputDir: projectRoot,
    projectRoot,
    identityKey: IDENTITY_KEY,
    identitySource: "git-common-dir",
    identityAnchor: join(projectRoot, ".git"),
    config: { kind: "none", path: null, explicit: false },
    workspaceConfigPath: null,
    legacyConfigPath: null,
    hasLegacyConfigAtInput: false,
    ...overrides,
  };
}

function views(): HostedPanelView[] {
  return [
    {
      id: "home",
      title: "Home",
      panel: "home",
      layout: null,
      glyph: "⌂",
      order: 0,
      shortcut: null,
    },
    {
      id: "files-a",
      title: "Files A",
      panel: "files",
      layout: null,
      glyph: "▤",
      order: 1,
      shortcut: null,
    },
    {
      id: "diff-a",
      title: "Diff A",
      panel: "diff",
      layout: null,
      glyph: "±",
      order: 2,
      shortcut: null,
    },
    {
      id: "files-b",
      title: "Files B",
      panel: "files",
      layout: null,
      glyph: "▤",
      order: 3,
      shortcut: null,
    },
    {
      id: "missions",
      title: "Missions",
      panel: "missions",
      layout: null,
      glyph: "◆",
      order: 4,
      shortcut: null,
    },
  ];
}

function writeRaw(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf-8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace UI-state contract", () => {
  it("parses defaults, malformed input, unsupported versions, caps, and mistyped fields", () => {
    expect(parseWorkspaceUiStateJson("{").state).toEqual(defaultWorkspaceUiState());
    expect(parseWorkspaceUiStateJson('{"version":2,"active":null,"views":{}}')).toMatchObject({
      state: defaultWorkspaceUiState(),
      diagnostics: [{ code: "UNSUPPORTED_VERSION", path: "$.version" }],
    });

    const oversizedViews: Record<string, unknown> = {};
    for (let i = 0; i < WORKSPACE_UI_STATE_MAX_VIEWS + 2; i++) {
      oversizedViews[`view-${i}`] = { panel: "files", openPath: `src/${i}.ts`, selectedPath: 1 };
    }
    oversizedViews["bad\0id"] = { panel: "diff", selectedPath: "x" };
    const parsed = parseWorkspaceUiStateJson(
      JSON.stringify({
        version: 1,
        active: { viewId: "", panel: "files" },
        views: oversizedViews,
      }),
    );

    expect(Object.keys(parsed.state.views)).toHaveLength(WORKSPACE_UI_STATE_MAX_VIEWS);
    expect(parsed.state.views["view-0"]).toEqual({
      panel: "files",
      openPath: "src/0.ts",
      selectedPath: null,
    });
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain("OVERSIZED");
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain("INVALID_FIELD");
  });

  it("serializes with stable keys, stable field order, and detached output", () => {
    const state: WorkspaceUiStateV1 = {
      version: 1,
      active: { viewId: "z", panel: "diff" },
      views: {
        z: { panel: "diff", selectedPath: "z.ts" },
        a: { panel: "missions", selectedMissionId: "m1", selectedTaskId: "t1" },
      },
    };

    const serialized = serializeWorkspaceUiState(state);

    expect(serialized).toBe(
      [
        "{",
        '  "version": 1,',
        '  "active": {',
        '    "viewId": "z",',
        '    "panel": "diff"',
        "  },",
        '  "views": {',
        '    "a": {',
        '      "panel": "missions",',
        '      "selectedMissionId": "m1",',
        '      "selectedTaskId": "t1"',
        "    },",
        '    "z": {',
        '      "panel": "diff",',
        '      "selectedPath": "z.ts"',
        "    }",
        "  }",
        "}\n",
      ].join("\n"),
    );

    const reparsed = parseWorkspaceUiStateJson(serialized).state;
    reparsed.views.z = { panel: "diff", selectedPath: "changed.ts" };
    expect(state.views.z).toEqual({ panel: "diff", selectedPath: "z.ts" });
  });

  it("rejects hostile object keys without prototype mutation or inherited view state", () => {
    const parsed = parseWorkspaceUiStateJson(
      '{"version":1,"active":null,"views":{"__proto__":{"panel":"files","openPath":"polluted.ts","selectedPath":null},"prototype":{"panel":"diff","selectedPath":"polluted.ts"},"constructor":{"panel":"missions","selectedMissionId":"m","selectedTaskId":"t"},"safe":{"panel":"diff","selectedPath":"safe.ts"}}}',
    );

    expect(parsed.state.views).toEqual({ safe: { panel: "diff", selectedPath: "safe.ts" } });
    expect(Object.prototype).not.toHaveProperty("panel");
    expect(Object.prototype).not.toHaveProperty("openPath");
    expect("polluted" in parsed.state.views).toBe(false);
    expect(parsed.state.views.__proto__).not.toEqual({
      panel: "files",
      openPath: "polluted.ts",
      selectedPath: null,
    });
    expect(parsed.diagnostics.filter((entry) => entry.code === "INVALID_FIELD")).toHaveLength(3);
  });

  it("round-trips reserved missions selection helpers without mission runtime data", () => {
    const state = setMissionsSelection(
      defaultWorkspaceUiState(),
      "missions",
      "mission-1",
      "task-1",
    );

    expect(missionsSelection(state, "missions")).toEqual({
      selectedMissionId: "mission-1",
      selectedTaskId: "task-1",
    });
    expect(missionsSelection(state, "other")).toEqual({
      selectedMissionId: null,
      selectedTaskId: null,
    });
  });

  it("round-trips bounded composite layout pointers without YAML/runtime state", () => {
    const state = setWorkspaceViewLayoutState(defaultWorkspaceUiState(), views()[1]!, {
      focusedLeafId: "files-tab",
      activeTabs: { dock: "diff-tab" },
      splitWeights: { root: [70, 30] },
    });

    expect(layoutStateForView(state, "files-a")).toEqual({
      focusedLeafId: "files-tab",
      activeTabs: { dock: "diff-tab" },
      splitWeights: { root: [70, 30] },
    });
    const parsed = parseWorkspaceUiStateJson(serializeWorkspaceUiState(state));
    expect(parsed.state.views["files-a"]).toEqual({
      panel: "files",
      openPath: null,
      selectedPath: null,
      layout: {
        focusedLeafId: "files-tab",
        activeTabs: { dock: "diff-tab" },
        splitWeights: { root: [70, 30] },
      },
    });
    const bad = parseWorkspaceUiStateJson(
      '{"version":1,"active":null,"views":{"ide":{"panel":"files","layout":{"focusedLeafId":"bad\\u0000","activeTabs":{"dock":"files"},"splitWeights":{"root":[1,-1]}}}}}',
    );
    expect(layoutStateForView(bad.state, "ide")).toEqual({
      focusedLeafId: null,
      activeTabs: { dock: "files" },
      splitWeights: {},
    });
  });

  it("chooses initial restore deterministically and rejects ID/panel mismatches", () => {
    expect(
      chooseInitialWorkspaceView(views(), {
        requestedPanel: "diff",
        persisted: {
          version: 1,
          active: { viewId: "files-a", panel: "files" },
          views: {},
        },
        legacyLastTab: "files",
      }),
    ).toMatchObject({ reason: "explicit", view: { id: "diff-a" } });

    expect(
      chooseInitialWorkspaceView(views(), {
        requestedPanel: null,
        persisted: { version: 1, active: { viewId: "files-b", panel: "files" }, views: {} },
        legacyLastTab: "diff",
      }),
    ).toMatchObject({ reason: "persisted-id", view: { id: "files-b" } });

    expect(
      chooseInitialWorkspaceView(views(), {
        requestedPanel: null,
        persisted: { version: 1, active: { viewId: "diff-a", panel: "files" }, views: {} },
        legacyLastTab: "diff",
      }),
    ).toMatchObject({ reason: "persisted-panel", view: { id: "files-a" } });

    expect(
      chooseInitialWorkspaceView(views(), {
        requestedPanel: null,
        persisted: defaultWorkspaceUiState(),
        legacyLastTab: "diff",
      }),
    ).toMatchObject({ reason: "legacy-tab", view: { id: "diff-a" } });
  });

  it("hydrates only matching per-view panel state for duplicate views", () => {
    const state: WorkspaceUiStateV1 = {
      version: 1,
      active: null,
      views: {
        "files-a": { panel: "files", openPath: "src/a.ts", selectedPath: "src" },
        "files-b": { panel: "files", openPath: "src/b.ts", selectedPath: "src/b.ts" },
        "diff-a": { panel: "files", openPath: "wrong.ts", selectedPath: null },
      },
    };

    expect(viewStateFor(state, views()[1])).toEqual({
      panel: "files",
      openPath: "src/a.ts",
      selectedPath: "src",
    });
    expect(viewStateFor(state, views()[3])).toEqual({
      panel: "files",
      openPath: "src/b.ts",
      selectedPath: "src/b.ts",
    });
    expect(viewStateFor(state, views()[2])).toBeNull();
  });

  it("converts project-relative paths safely", () => {
    const root = temporaryRoot();
    expect(relativeProjectPath(root, join(root, "src/a.ts"))).toBe("src/a.ts");
    expect(relativeProjectPath(root, join(root, "..env"))).toBe("..env");
    expect(relativeProjectPath(root, dirname(root))).toBeNull();
    expect(absoluteProjectPath(root, "src/a.ts")).toBe(join(root, "src/a.ts"));
    expect(absoluteProjectPath(root, "..env")).toBe(join(root, "..env"));
    expect(absoluteProjectPath(root, "/tmp/a.ts")).toBeNull();
    expect(absoluteProjectPath(root, "../outside.ts")).toBeNull();
    expect(absoluteProjectPath(root, "src/../../outside.ts")).toBeNull();
    expect(absoluteProjectPath(root, "src/../inside.ts")).toBe(join(root, "inside.ts"));
    expect(absoluteProjectPath(root, "src/\0bad.ts")).toBeNull();
  });

  it("keeps explicit --edit file intent ahead of first-load persisted Files hydration", () => {
    const view = views()[1]!;
    const entry = { panel: "files" as const, openPath: "persisted.ts", selectedPath: "src" };

    expect(
      shouldHydrateWorkspaceView({
        firstProjectLoad: true,
        explicitEditPath: "cli.ts",
        view,
        entry,
      }),
    ).toBe(false);
    expect(
      shouldHydrateWorkspaceView({
        firstProjectLoad: false,
        explicitEditPath: "cli.ts",
        view,
        entry,
      }),
    ).toBe(true);
    expect(
      shouldHydrateWorkspaceView({
        firstProjectLoad: true,
        explicitEditPath: "cli.ts",
        view,
        entry: { panel: "files", openPath: null, selectedPath: "src" },
      }),
    ).toBe(true);
  });
});

describe("workspace UI-state repository", () => {
  it("uses C04 ui/workspace.json and isolates or shares by C01 identity", () => {
    const home = temporaryRoot();
    const main = temporaryRoot();
    const linked = temporaryRoot();
    const other = temporaryRoot();
    const commonAnchor = join(main, ".git");
    const first = createProjectRuntimeRepository(
      resolution(main, { identityAnchor: commonAnchor }),
      { home },
    );
    const second = createProjectRuntimeRepository(
      resolution(linked, { identityAnchor: commonAnchor }),
      { home },
    );
    const isolated = createProjectRuntimeRepository(
      resolution(other, {
        identityKey: `path-${"c".repeat(64)}`,
        identitySource: "canonical-realpath",
        identityAnchor: other,
      }),
      { home },
    );

    const state: WorkspaceUiStateV1 = {
      version: 1,
      active: { viewId: "files-a", panel: "files" },
      views: { "files-a": { panel: "files", openPath: "src/a.ts", selectedPath: null } },
    };
    writeWorkspaceUiStateWithRetry({
      repository: first,
      revision: null,
      current: defaultWorkspaceUiState(),
      next: state,
      touchedViewIds: new Set(["files-a"]),
    });

    expect(existsSync(join(first.runtimeRoot, WORKSPACE_UI_STATE_PATH))).toBe(true);
    expect(loadWorkspaceUiState(second).state).toEqual(state);
    expect(loadWorkspaceUiState(isolated).state).toEqual(defaultWorkspaceUiState());
    expect(existsSync(join(main, ".tmux-ide"))).toBe(false);
  });

  it("creates, reads, updates, reopens, and retries a bounded revision-conflict merge", () => {
    const home = temporaryRoot();
    const project = temporaryRoot();
    const first = createProjectRuntimeRepository(resolution(project), { home });
    const second = createProjectRuntimeRepository(resolution(project), { home });

    const firstState: WorkspaceUiStateV1 = {
      version: 1,
      active: { viewId: "files-a", panel: "files" },
      views: { "files-a": { panel: "files", openPath: "a.ts", selectedPath: null } },
    };
    const created = writeWorkspaceUiStateWithRetry({
      repository: first,
      revision: null,
      current: defaultWorkspaceUiState(),
      next: firstState,
      touchedViewIds: new Set(["files-a"]),
    });
    expect(created.revision).toBe(1);

    const loadedSecond = loadWorkspaceUiState(second);
    const latestState: WorkspaceUiStateV1 = {
      version: 1,
      active: { viewId: "diff-a", panel: "diff" },
      views: {
        ...firstState.views,
        "diff-a": { panel: "diff", selectedPath: "b.ts" },
      },
    };
    const updated = writeWorkspaceUiStateWithRetry({
      repository: first,
      revision: created.revision,
      current: firstState,
      next: latestState,
      touchedViewIds: new Set(["diff-a"]),
    });
    expect(updated.revision).toBe(2);

    const localSecond: WorkspaceUiStateV1 = {
      version: 1,
      active: { viewId: "files-a", panel: "files" },
      views: {
        "files-a": { panel: "files", openPath: "a2.ts", selectedPath: "src" },
      },
    };
    const retried = writeWorkspaceUiStateWithRetry({
      repository: second,
      revision: loadedSecond.revision,
      current: loadedSecond.state,
      next: localSecond,
      touchedViewIds: new Set(["files-a"]),
    });

    expect(retried.revision).toBe(3);
    expect(loadWorkspaceUiState(first).state).toEqual({
      version: 1,
      active: { viewId: "files-a", panel: "files" },
      views: {
        "files-a": { panel: "files", openPath: "a2.ts", selectedPath: "src" },
        "diff-a": { panel: "diff", selectedPath: "b.ts" },
      },
    });
  });

  it("tolerates missing, malformed, and unreadable runtime documents", () => {
    const home = temporaryRoot();
    const project = temporaryRoot();
    const repository = createProjectRuntimeRepository(resolution(project), { home });
    expect(loadWorkspaceUiState(repository)).toMatchObject({
      state: defaultWorkspaceUiState(),
      revision: null,
      diagnostics: [{ code: "MISSING" }],
    });

    writeRaw(join(repository.runtimeRoot, WORKSPACE_UI_STATE_PATH), "not-json");
    expect(loadWorkspaceUiState(repository)).toMatchObject({
      state: defaultWorkspaceUiState(),
      revision: null,
      diagnostics: [{ code: "READ_FAILED" }],
    });
  });

  it("merges untouched latest view entries only when requested", () => {
    const merged = mergeWorkspaceUiStateForSave(
      {
        version: 1,
        active: { viewId: "diff-a", panel: "diff" },
        views: {
          "files-a": { panel: "files", openPath: "old.ts", selectedPath: null },
          "diff-a": { panel: "diff", selectedPath: "latest.ts" },
        },
      },
      {
        version: 1,
        active: { viewId: "files-a", panel: "files" },
        views: {
          "files-a": { panel: "files", openPath: "local.ts", selectedPath: null },
          "diff-a": { panel: "diff", selectedPath: "stale.ts" },
        },
      },
      new Set(["files-a"]),
    );

    expect(merged).toEqual({
      version: 1,
      active: { viewId: "files-a", panel: "files" },
      views: {
        "files-a": { panel: "files", openPath: "local.ts", selectedPath: null },
        "diff-a": { panel: "diff", selectedPath: "latest.ts" },
      },
    });
  });
});

describe("workspace UI-state controller", () => {
  it("does not write before load and rejects stale async load/save generations", () => {
    const home = temporaryRoot();
    const project = temporaryRoot();
    const first = createProjectRuntimeRepository(resolution(project), { home });
    const second = createProjectRuntimeRepository(
      resolution(project, { identityKey: `git-${"d".repeat(64)}` }),
      { home },
    );
    const controller = new WorkspaceUiStateController();
    const stale = controller.beginLoad();
    const current = controller.beginLoad();

    expect(controller.save(current, defaultWorkspaceUiState(), new Set(["files-a"]))).toMatchObject(
      {
        saved: false,
        skipped: true,
        diagnostics: [{ code: "NOT_LOADED" }],
      },
    );

    expect(controller.completeLoad(stale, first, loadWorkspaceUiState(first))).toBe(false);
    expect(controller.completeLoad(current, second, loadWorkspaceUiState(second))).toBe(true);
    const next: WorkspaceUiStateV1 = {
      version: 1,
      active: { viewId: "files-a", panel: "files" },
      views: { "files-a": { panel: "files", openPath: "a.ts", selectedPath: null } },
    };
    expect(controller.save(stale, next, new Set(["files-a"]))).toMatchObject({
      saved: false,
      skipped: true,
      diagnostics: [{ code: "STALE" }],
    });
    expect(controller.save(current, next, new Set(["files-a"]))).toMatchObject({
      saved: true,
      skipped: false,
    });
    expect(readFileSync(join(second.runtimeRoot, WORKSPACE_UI_STATE_PATH), "utf-8")).toContain(
      "a.ts",
    );
    expect(existsSync(join(first.runtimeRoot, WORKSPACE_UI_STATE_PATH))).toBe(false);
  });
});
