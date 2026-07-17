import { describe, expect, it } from "vitest";
import type {
  ProjectConfigSource,
  ProjectResolution,
  ResolveProjectOptions,
} from "../project-resolver.ts";
import {
  loadWorkspaceConfig,
  mergeWorkspaceConfigValues,
  WorkspaceConfigLoadError,
  WorkspaceConfigMergeError,
  type LoadWorkspaceConfigOptions,
  type WorkspaceConfigLoaderIo,
} from "../workspace-config-loader.ts";

const BASE_PATH = "/repo/.tmux-ide/workspace.yml";
const LOCAL_PATH = "/repo/.tmux-ide/workspace.local.yml";

function resolution(config: ProjectConfigSource): ProjectResolution {
  return {
    inputDir: "/repo",
    projectRoot: "/repo",
    identityKey: "git-test",
    identitySource: "git-common-dir",
    identityAnchor: "/repo/.git",
    config,
    workspaceConfigPath: config.kind === "workspace" ? config.path : null,
    legacyConfigPath: config.kind === "legacy" ? config.path : null,
    hasLegacyConfigAtInput: config.kind === "legacy",
  };
}

function workspaceResolution(): ProjectResolution {
  return resolution({ kind: "workspace", path: BASE_PATH, explicit: false });
}

function loaderIo(
  files: Record<string, string>,
  resolved: ProjectResolution = workspaceResolution(),
  onResolve?: (options: ResolveProjectOptions) => void,
): WorkspaceConfigLoaderIo {
  return {
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => {
      if (!Object.hasOwn(files, path)) throw new Error("ENOENT");
      return files[path]!;
    },
    realpath: (path) => path,
    resolveProject: async (_dir, options) => {
      onResolve?.(options ?? {});
      return resolved;
    },
  };
}

async function load(
  files: Record<string, string>,
  options: Omit<LoadWorkspaceConfigOptions, "io"> = {},
) {
  return loadWorkspaceConfig("/repo", { ...options, io: loaderIo(files) });
}

async function expectLoadError(
  promise: Promise<unknown>,
  code: WorkspaceConfigLoadError["code"],
  stage: WorkspaceConfigLoadError["stage"],
) {
  try {
    await promise;
    throw new Error("Expected loadWorkspaceConfig to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceConfigLoadError);
    const typed = error as WorkspaceConfigLoadError;
    expect(typed.code).toBe(code);
    expect(typed.stage).toBe(stage);
    return typed;
  }
}

describe("loadWorkspaceConfig", () => {
  it("loads a minimal V1 workspace and reports source paths", async () => {
    const result = await load({ [BASE_PATH]: "version: 1\n" });

    expect(result.config).toEqual({ version: 1 });
    expect(result.source.basePath).toBe(BASE_PATH);
    expect(result.source.localPath).toBeNull();
    expect(result.source.resolution.identityKey).toBe("git-test");
  });

  it("passes an explicit config path through to the C01 resolver", async () => {
    let explicitConfigPath: string | null | undefined;
    const io = loaderIo({ [BASE_PATH]: "version: 1\n" }, workspaceResolution(), (options) => {
      explicitConfigPath = options.explicitConfigPath;
    });

    await loadWorkspaceConfig("/repo", {
      explicitConfigPath: "/selected/workspace.yml",
      io,
    });

    expect(explicitConfigPath).toBe("/selected/workspace.yml");
  });

  it("merges nested local objects while retaining untouched base fields", async () => {
    const result = await load({
      [BASE_PATH]: `
version: 1
terminal:
  rows:
    - panes:
        - title: Shell
  theme:
    accent: blue
    border: grey
harnesses:
  custom:
    adapter: generic-pty
    command: [my-agent, --interactive]
    env:
      MODE: base
      KEEP: yes
`,
      [LOCAL_PATH]: `
terminal:
  theme:
    accent: red
harnesses:
  custom:
    env:
      MODE: local
`,
    });

    expect(result.config.terminal?.theme).toEqual({ accent: "red", border: "grey" });
    expect(result.config.terminal?.rows[0]?.panes[0]?.title).toBe("Shell");
    expect(result.config.harnesses?.custom).toEqual({
      adapter: "generic-pty",
      command: ["my-agent", "--interactive"],
      env: { MODE: "local", KEEP: "yes" },
    });
    expect(result.source.localPath).toBe(LOCAL_PATH);
  });

  it("replaces arrays wholesale instead of concatenating them", async () => {
    const result = await load({
      [BASE_PATH]: `
version: 1
app:
  views:
    - { id: home, panel: home }
    - { id: files, panel: files }
harnesses:
  generic: { adapter: generic-pty, command: agent }
agents:
  first: { harness: generic, role: implementer }
  second: { harness: generic, role: implementer }
missions:
  workers: [first]
`,
      [LOCAL_PATH]: `
app:
  views:
    - { id: missions, panel: missions }
missions:
  workers: [second]
`,
    });

    expect(result.config.app?.views).toEqual([{ id: "missions", panel: "missions" }]);
    expect(result.config.missions?.workers).toEqual(["second"]);
  });

  it("validates only after merge so a local document can supply a partial subtree", async () => {
    const result = await load({
      [BASE_PATH]: `
version: 1
harnesses:
  custom:
    adapter: generic-pty
`,
      [LOCAL_PATH]: `
harnesses:
  custom:
    command: [agent]
`,
    });

    expect(result.config.harnesses?.custom).toEqual({
      adapter: "generic-pty",
      command: ["agent"],
    });
  });

  it("returns cloned data and never mutates base or overlay inputs", () => {
    const base = {
      terminal: { theme: { accent: "blue", border: "grey" } },
      views: [{ id: "base" }],
      nullable: "base",
    };
    const overlay = {
      terminal: { theme: { accent: "red" } },
      views: [{ id: "local" }],
      nullable: null,
    };
    const baseSnapshot = structuredClone(base);
    const overlaySnapshot = structuredClone(overlay);

    const merged = mergeWorkspaceConfigValues(base, overlay) as typeof overlay & typeof base;

    expect(base).toEqual(baseSnapshot);
    expect(overlay).toEqual(overlaySnapshot);
    expect(merged).not.toBe(base);
    expect(merged.terminal).not.toBe(base.terminal);
    expect(merged.views).not.toBe(overlay.views);
    expect(merged).toEqual({
      terminal: { theme: { accent: "red", border: "grey" } },
      views: [{ id: "local" }],
      nullable: null,
    });
  });

  it.each(["base", "overlay"] as const)(
    "rejects cyclic programmatic %s input without overflowing",
    (side) => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      const invoke = () =>
        side === "base"
          ? mergeWorkspaceConfigValues(cyclic, {})
          : mergeWorkspaceConfigValues({}, cyclic);

      expect(invoke).toThrow(WorkspaceConfigMergeError);
      try {
        invoke();
      } catch (error) {
        expect(error).not.toBeInstanceOf(RangeError);
        expect((error as WorkspaceConfigMergeError).code).toBe("CYCLIC_VALUE");
        expect((error as WorkspaceConfigMergeError).path).toEqual(["self"]);
      }
    },
  );

  it("allows repeated references that do not form a cycle", () => {
    const shared = { value: "shared" };
    const merged = mergeWorkspaceConfigValues({ first: shared, second: shared }, {}) as {
      first: typeof shared;
      second: typeof shared;
    };

    expect(merged).toEqual({ first: shared, second: shared });
    expect(merged.first).not.toBe(shared);
    expect(merged.second).not.toBe(shared);
  });

  it("reports useful final validation issues for strict keys and values", async () => {
    const error = await expectLoadError(
      load({
        [BASE_PATH]: `
version: 1
unknown_key: true
missions:
  max_concurrent_tasks: 0
`,
      }),
      "FINAL_VALIDATION_FAILED",
      "validation",
    );

    expect(error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["missions.max_concurrent_tasks", ""]),
    );
    expect(error.message).toContain("Effective workspace config is invalid");
  });

  it("reports broken document-local references during final validation", async () => {
    const error = await expectLoadError(
      load({
        [BASE_PATH]: `
version: 1
agents:
  worker: { harness: missing, role: implementer }
missions:
  workers: [missing-worker]
`,
      }),
      "FINAL_VALIDATION_FAILED",
      "validation",
    );

    expect(error.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["agents.worker.harness", "missions.workers.0"]),
    );
  });

  it.each([
    ["version: [\n", "BASE_YAML_INVALID", "base"],
    ["- version: 1\n", "BASE_NOT_MAPPING", "base"],
    ["name: missing-version\n", "BASE_VERSION_INVALID", "base"],
    ["version: 2\n", "BASE_VERSION_INVALID", "base"],
  ] as const)("types base document failures for %j", async (base, code, stage) => {
    await expectLoadError(load({ [BASE_PATH]: base }), code, stage);
  });

  it.each([
    ["value: [\n", "LOCAL_YAML_INVALID", "local"],
    ["- partial\n", "LOCAL_NOT_MAPPING", "local"],
    ["version: 2\n", "LOCAL_VERSION_INVALID", "local"],
    ["version: null\n", "LOCAL_VERSION_INVALID", "local"],
  ] as const)("types local document failures for %j", async (local, code, stage) => {
    await expectLoadError(load({ [BASE_PATH]: "version: 1\n", [LOCAL_PATH]: local }), code, stage);
  });

  it("types a recursive alias in the base document at the base stage", async () => {
    const error = await expectLoadError(
      load({
        [BASE_PATH]: `
version: 1
recursive: &recursive
  self: *recursive
`,
      }),
      "BASE_CYCLIC_REFERENCE",
      "base",
    );

    expect(error.path).toBe(BASE_PATH);
    expect(error.message).toContain("recursive YAML alias");
  });

  it("types a recursive alias in the local document at the local stage", async () => {
    const error = await expectLoadError(
      load({
        [BASE_PATH]: "version: 1\n",
        [LOCAL_PATH]: `
recursive: &recursive
  self: *recursive
`,
      }),
      "LOCAL_CYCLIC_REFERENCE",
      "local",
    );

    expect(error.path).toBe(LOCAL_PATH);
    expect(error.message).toContain("recursive YAML alias");
  });

  it("allows a local document to repeat version: 1 without changing it", async () => {
    const result = await load({
      [BASE_PATH]: "version: 1\nname: base\n",
      [LOCAL_PATH]: "version: 1\nname: local\n",
    });
    expect(result.config).toEqual({ version: 1, name: "local" });
  });

  it.each([
    [resolution({ kind: "legacy", path: "/repo/ide.yml", explicit: false }), "Found legacy config"],
    [resolution({ kind: "none", path: null, explicit: false }), "No .tmux-ide/workspace.yml"],
  ])("rejects legacy/none discovery", async (resolved, message) => {
    const error = await expectLoadError(
      loadWorkspaceConfig("/repo", { io: loaderIo({}, resolved) }),
      "WORKSPACE_CONFIG_REQUIRED",
      "resolution",
    );
    expect(error.message).toContain(message);
  });
});
