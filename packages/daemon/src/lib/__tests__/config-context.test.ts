import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../errors.ts";
import { resolveProjectConfigContext } from "../config-context.ts";

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function tempDir(): string {
  const root = join(
    tmpdir(),
    `tmux-ide-context-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.add(root);
  return root;
}

describe("resolveProjectConfigContext", () => {
  it("returns configKind none only for a normal no-config resolution", async () => {
    const dir = tempDir();

    await expect(resolveProjectConfigContext(dir)).resolves.toMatchObject({
      configExists: false,
      configKind: "none",
      configPath: null,
      configWriteRoot: realpathSync(dir),
    });
  });

  it("preserves invalid config failures instead of falling back to configKind none", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ide.yml"), "name: broken\nrows: []\n");

    await expect(resolveProjectConfigContext(dir)).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    await expect(resolveProjectConfigContext(dir)).rejects.toBeInstanceOf(ConfigError);
  });

  it("writes beside a winning workspace config found below the git root", async () => {
    const dir = tempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const app = join(dir, "apps", "web");
    mkdirSync(join(app, ".tmux-ide"), { recursive: true });
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(
      join(app, ".tmux-ide", "workspace.yml"),
      "version: 1\nname: web\nterminal:\n  rows:\n    - panes:\n        - title: Shell\n",
    );

    await expect(resolveProjectConfigContext(join(app, "src"))).resolves.toMatchObject({
      configKind: "workspace",
      projectRoot: realpathSync(dir),
      configWriteRoot: realpathSync(app),
    });
  }, 15_000);

  it("writes beside an explicit custom workspace config instead of stripping two directories", async () => {
    const dir = tempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const configDir = join(dir, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "custom.yml"),
      "version: 1\nname: custom\nterminal:\n  rows:\n    - panes:\n        - title: Shell\n",
    );

    await expect(
      resolveProjectConfigContext(dir, { explicitConfigPath: "config/custom.yml" }),
    ).resolves.toMatchObject({
      configKind: "workspace",
      projectRoot: realpathSync(dir),
      configPath: join(realpathSync(configDir), "custom.yml"),
      configWriteRoot: realpathSync(configDir),
    });
  }, 15_000);

  it("writes beside a winning legacy config found below the git root", async () => {
    const dir = tempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const app = join(dir, "apps", "api");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "ide.yml"), "name: api\nrows:\n  - panes:\n      - title: Shell\n");

    await expect(resolveProjectConfigContext(join(app, "src"))).resolves.toMatchObject({
      configKind: "legacy",
      projectRoot: realpathSync(dir),
      configWriteRoot: realpathSync(app),
    });
  });

  it("falls back to the project root for new config writes when no config exists", async () => {
    const dir = tempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const nested = join(dir, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    await expect(resolveProjectConfigContext(nested)).resolves.toMatchObject({
      configKind: "none",
      projectRoot: realpathSync(dir),
      configWriteRoot: realpathSync(dir),
    });
  });

  it("threads a config-free project root hint through the normal config context path", async () => {
    const dir = tempDir();
    const nested = join(dir, "packages", "app", "src");
    mkdirSync(nested, { recursive: true });

    await expect(
      resolveProjectConfigContext(nested, { resolveOptions: { projectRootHint: dir } }),
    ).resolves.toMatchObject({
      configKind: "none",
      projectRoot: realpathSync(dir),
      configWriteRoot: realpathSync(dir),
    });
  });
});
