import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDevelopmentInstance } from "../lib/development-instance.ts";
import {
  developmentFileHash,
  developmentNativeObservationOption,
  developmentNativeObservationMode,
  developmentTreeHash,
  readDevelopmentBuild,
  verifyDevelopmentBuild,
  developmentBuildLaunch,
  type DevelopmentBuildManifest,
} from "../lib/development-build.ts";
import { developmentOwnerEnvironment } from "../lib/development-lifecycle.ts";
import type { DevelopmentIdentityRecord } from "../lib/development-state.ts";
import { developmentNamespaceEnvironment } from "../lib/runtime-namespace.ts";
import {
  findCompiledTui,
  ensureTuiLaunchAvailable,
  openTuiLaunchEnvironment,
} from "../tui/compiled.ts";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "development-build-test-"));
  roots.push(root);
  mkdirSync(join(root, "home"));
  const tree = join(root, "tree");
  mkdirSync(tree);
  mkdirSync(join(tree, ".git"));
  writeFileSync(join(tree, "pnpm-workspace.yaml"), "packages: []\n");
  const instance = resolveDevelopmentInstance({
    worktree: tree,
    store: join(root, "store"),
    userHome: join(root, "home"),
  });
  const generation = `build-${randomUUID()}`;
  const artifact = join(instance.root, "artifacts", generation);
  for (const dir of [
    "bin",
    "tui",
    "dependencies/a",
    "node_modules",
    "packages/daemon/dist/native",
    "templates",
    "skill",
  ])
    mkdirSync(join(artifact, dir), { recursive: true, mode: 0o700 });
  for (const name of [
    "bin/cli.js",
    "tui/tmux-ide-tui",
    "package.json",
    "dependencies/a/index.js",
    "templates/sample.yml",
    "skill/SKILL.md",
  ])
    writeFileSync(join(artifact, name), name);
  symlinkSync("../dependencies/a", join(artifact, "node_modules/a"));
  const tool = join(root, "tool");
  writeFileSync(tool, "tool");
  const manifest: DevelopmentBuildManifest = {
    version: 1,
    generation,
    instance: {
      id: instance.id,
      digest: instance.digest,
      worktree: instance.worktree,
      name: instance.name,
    },
    source: {
      commit: "a".repeat(40),
      digest: "b".repeat(64),
      dirty: true,
      files: 1,
      lockfileHash: "c".repeat(64),
    },
    packageVersion: "2.9.0-beta.18",
    execution: "packaged-development",
    host: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      nodeAbi: process.versions.modules!,
      bunVersion: process.versions.bun ?? "1.4.2",
    },
    tools: {
      node: tool,
      bun: tool,
      nodeHash: developmentFileHash(tool),
      bunHash: developmentFileHash(tool),
    },
    cli: join(artifact, "bin/cli.js"),
    tui: join(artifact, "tui/tmux-ide-tui"),
    dependencies: join(artifact, "dependencies"),
    assets: join(artifact, "packages/daemon/dist/native"),
    hashes: {
      cli: developmentFileHash(join(artifact, "bin/cli.js")),
      tui: developmentFileHash(join(artifact, "tui/tmux-ide-tui")),
      dependencies: developmentTreeHash(join(artifact, "dependencies")),
      assets: developmentTreeHash(join(artifact, "packages/daemon/dist/native")),
      metadata: developmentFileHash(join(artifact, "package.json")),
      payload: developmentTreeHash(artifact, true),
    },
    packages: [],
    native: [],
    buildInputs: [],
    qualification: {
      provenance: {},
      signature: process.platform === "darwin" ? "verified" : "not-applicable",
    },
  };
  writeFileSync(join(artifact, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(instance.root, "build.json"),
    JSON.stringify({
      version: 1,
      generation,
      sha256: developmentFileHash(join(artifact, "manifest.json")),
    }),
  );
  return { instance, artifact, manifest, root };
}
it("binds exact instance and ABI but preserves last good build after source edits", () => {
  const f = fixture();
  expect(readDevelopmentBuild(f.instance, {}).generation).toBe(f.manifest.generation);
  writeFileSync(join(f.instance.worktree, "untracked.ts"), "new source");
  expect(readDevelopmentBuild(f.instance, {}).source.digest).toBe(f.manifest.source.digest);
  expect(() => verifyDevelopmentBuild({ ...f.instance, name: "sibling" }, f.manifest)).toThrow(
    "another instance",
  );
  expect(() =>
    verifyDevelopmentBuild(f.instance, {
      ...f.manifest,
      host: { ...f.manifest.host, nodeAbi: "wrong", bunVersion: "wrong" },
    }),
  ).toThrow("ABI");
});
it.each(["templates/sample.yml", "skill/SKILL.md", "bin/cli.js", "tui/tmux-ide-tui"])(
  "rejects changed payload %s",
  (path) => {
    const f = fixture();
    writeFileSync(join(f.artifact, path), "tampered");
    expect(() => readDevelopmentBuild(f.instance, {})).toThrow("No verified");
  },
);
it("rejects changed root dependency links and pointer symlinks", () => {
  const f = fixture();
  unlinkSync(join(f.artifact, "node_modules/a"));
  symlinkSync(f.root, join(f.artifact, "node_modules/a"));
  expect(() => readDevelopmentBuild(f.instance, {})).toThrow("No verified");
  const g = fixture();
  const pointer = join(g.instance.root, "build.json");
  writeFileSync(join(g.root, "pointer"), readFileSync(pointer));
  unlinkSync(pointer);
  symlinkSync(join(g.root, "pointer"), pointer);
  expect(() => readDevelopmentBuild(g.instance, {})).toThrow("No verified");
});
it("retains a pinned old generation after pointer replacement and rejects partial pins", () => {
  const f = fixture();
  const launch = developmentBuildLaunch(readDevelopmentBuild(f.instance, {}));
  writeFileSync(join(f.instance.root, "build.json"), "invalid replacement");
  expect(readDevelopmentBuild(f.instance, launch.environment).generation).toBe(
    f.manifest.generation,
  );
  expect(() =>
    readDevelopmentBuild(f.instance, { TMUX_IDE_DEVELOPMENT_BUILD: f.manifest.generation }),
  ).toThrow("No verified");
});
it("selects exact compiled artifacts without downloading and fences child overlays", async () => {
  const f = fixture();
  const env = developmentNamespaceEnvironment(f.instance, "fixture-capability-1234567890");
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("TMUX_IDE_TUI_BIN", "/some/installed/binary");
  vi.stubEnv("TMUX_IDE_TUI_SOURCE", "1");
  expect(findCompiledTui()).toBe(f.manifest.tui);
  const download = vi.fn();
  expect(
    await ensureTuiLaunchAvailable(
      {
        surface: "app",
        scriptPath: "/source.tsx",
        args: [],
        checkoutExists: true,
        bunAvailable: true,
        compiledBinary: "/installed",
        preferSource: true,
      },
      { download },
    ),
  ).toEqual({ mode: "binary", bin: f.manifest.tui, argv: ["app"] });
  expect(download).not.toHaveBeenCalled();
  const child = openTuiLaunchEnvironment(env);
  expect(child.TMUX_IDE_CLI).toBe(f.manifest.cli);
  expect(child.TMUX_IDE_DEVELOPMENT_BUILD).toBe(f.manifest.generation);
  expect(() => openTuiLaunchEnvironment(env, { TMUX_IDE_CLI: "/sibling/cli.js" })).toThrow(
    "build authority",
  );
  expect(() => openTuiLaunchEnvironment(env, { TMUX_IDE_DEVELOPMENT_BUILD: "sibling" })).toThrow(
    "build authority",
  );
});

it("keeps compiler provenance after cached Bun removal but rejects a changed runtime Node", () => {
  const f = fixture();
  const compiler = join(f.root, "compiler");
  writeFileSync(compiler, "compiler");
  const manifest = {
    ...f.manifest,
    tools: { ...f.manifest.tools, bun: compiler, bunHash: developmentFileHash(compiler) },
  };
  unlinkSync(compiler);
  expect(verifyDevelopmentBuild(f.instance, manifest).generation).toBe(f.manifest.generation);
  writeFileSync(manifest.tools.node, "replacement");
  expect(() => verifyDevelopmentBuild(f.instance, manifest)).toThrow("toolchain changed");
});

it("keeps CI and release compiler selection on the same central Bun pin", () => {
  const repository = new URL("../../../../", import.meta.url);
  expect(readFileSync(new URL(".bun-version", repository), "utf8").trim()).toBe("1.4.2");
  for (const name of ["ci", "release", "release-binaries"]) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}.yml`, repository), "utf8");
    const count = workflow.match(/uses: oven-sh\/setup-bun@v2/gu)?.length;
    // YAML permits the exact filename as a plain, single-quoted or double-quoted scalar.
    expect(
      workflow.match(
        /^\s*bun-version-file: (?:"\.bun-version"|'\.bun-version'|\.bun-version)\s*$/gmu,
      )?.length,
    ).toBe(count);
  }
});

it("native observation is explicit, closed, and preserves the selected generation choice", () => {
  expect(developmentNativeObservationMode(undefined)).toBe("disabled");
  expect(developmentNativeObservationMode(undefined, {})).toBe("disabled");
  expect(developmentNativeObservationMode("enabled")).toBe("enabled");
  expect(developmentNativeObservationMode(undefined, { nativeObservation: "enabled" })).toBe(
    "enabled",
  );
  expect(developmentNativeObservationMode("disabled", { nativeObservation: "enabled" })).toBe(
    "disabled",
  );
  expect(developmentNativeObservationMode(undefined, { nativeObservation: "disabled" })).toBe(
    "disabled",
  );
  for (const bad of ["1", "true", "", false, null, {}])
    expect(() => developmentNativeObservationOption(bad)).toThrow("enabled|disabled");
  for (const command of [
    "up",
    "down",
    "status",
    "restart",
    "app",
    "shell",
    "reset",
    "ssh-info",
    "list",
    "logs",
    "diagnostics",
  ])
    expect(() => developmentNativeObservationOption("enabled", command)).toThrow(
      "requires rebuild",
    );
  expect(() => developmentNativeObservationOption("enabled", "rebuild", true)).toThrow("container");
});
it("manifest hash pins observation mode and malformed manifest modes are refused", () => {
  const f = fixture();
  expect(readDevelopmentBuild(f.instance, {}).nativeObservation).toBeUndefined();
  writeFileSync(
    join(f.artifact, "manifest.json"),
    JSON.stringify({ ...f.manifest, nativeObservation: "enabled" }),
  );
  expect(() => readDevelopmentBuild(f.instance, {})).toThrow();
  expect(() =>
    verifyDevelopmentBuild(f.instance, { ...f.manifest, nativeObservation: "ambient" }),
  ).toThrow("enabled|disabled");
});
it("actual owner environment ignores ambient opt-in and derives only the selected manifest mode", () => {
  const f = fixture();
  const identity = { capability: randomUUID() } as DevelopmentIdentityRecord;
  vi.stubEnv("TMUX_IDE_NATIVE_OBSERVATION", "1");
  vi.stubEnv("TMUX_IDE_UNREVIEWED_OPTION", "unsafe");
  const legacy = developmentOwnerEnvironment(f.instance, identity, f.manifest);
  expect(legacy.TMUX_IDE_NATIVE_OBSERVATION).toBe("0");
  expect(legacy).not.toHaveProperty("TMUX_IDE_UNREVIEWED_OPTION");
  vi.stubEnv("TMUX_IDE_NATIVE_OBSERVATION", "0");
  const enabled = developmentOwnerEnvironment(f.instance, identity, {
    ...f.manifest,
    nativeObservation: "enabled",
  });
  const disabled = developmentOwnerEnvironment(f.instance, identity, {
    ...f.manifest,
    nativeObservation: "disabled",
  });
  expect(enabled.TMUX_IDE_NATIVE_OBSERVATION).toBe("1");
  expect(disabled.TMUX_IDE_NATIVE_OBSERVATION).toBe("0");
  expect({ ...enabled, TMUX_IDE_NATIVE_OBSERVATION: "0" }).toEqual(legacy);
  expect(disabled).toEqual(legacy);
});

it("manager CLI rejects invalid observation switches before resolving or creating an instance", () => {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  for (const args of [
    ["up", "--native-observation", "enabled"],
    ["rebuild", "--native-observation", "true"],
    ["rebuild", "--container", "--native-observation", "disabled"],
  ]) {
    try {
      execFileSync(
        process.execPath,
        [
          "--import",
          join(root, "node_modules/tsx/dist/loader.mjs"),
          join(root, "scripts/development-instance.ts"),
          ...args,
        ],
        { encoding: "utf8", stdio: "pipe", timeout: 10000 },
      );
      throw new Error("Unexpected CLI admission");
    } catch (error) {
      expect((error as { status: number }).status).toBe(1);
      expect(String((error as { stderr: string }).stderr)).toContain(
        "native-observation requires rebuild",
      );
    }
  }
});
