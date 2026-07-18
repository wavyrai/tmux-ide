import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdeConfig } from "../../types.ts";
import { convertLegacyConfigToWorkspace } from "../legacy-config-migration.ts";
import {
  resolveConfig,
  UnsupportedLegacyConfigMutationError,
  WorkspaceConfigWriteError,
} from "../resolved-config.ts";
import { writeConfig } from "../yaml-io.ts";
import { migrate } from "../../migrate.ts";
import { IdeError } from "../errors.ts";

const roots = new Set<string>();

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function tempDir(): string {
  const root = join(
    tmpdir(),
    `tmux-ide-c03-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.add(root);
  return root;
}

function writeYaml(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, yaml.dump(value, { lineWidth: -1, noRefs: true, quotingType: '"' }));
}

function readYaml(path: string): unknown {
  return yaml.load(readFileSync(path, "utf-8"));
}

describe("legacy config migration", () => {
  it("maps legacy layout, theme, numeric env, widgets, and before without mutating input", () => {
    const legacy: IdeConfig = {
      name: "legacy-app",
      before: "pnpm install",
      rows: [
        {
          size: "70%",
          panes: [
            {
              title: "App",
              command: "pnpm dev",
              dir: "apps/web",
              size: "60%",
              focus: true,
              env: { PORT: 3000 },
            },
            { title: "Files", type: "explorer", target: "src" },
          ],
        },
      ],
      theme: { accent: "colour75" },
    };
    const before = structuredClone(legacy);

    const result = convertLegacyConfigToWorkspace(legacy);

    expect(legacy).toEqual(before);
    expect(result.workspace).toMatchObject({
      version: 1,
      name: "legacy-app",
      before: "pnpm install",
      terminal: {
        rows: [
          {
            size: "70%",
            panes: [
              {
                title: "App",
                command: "pnpm dev",
                dir: "apps/web",
                size: "60%",
                focus: true,
                env: { PORT: 3000 },
              },
              { title: "Files", type: "explorer", target: "src" },
            ],
          },
        ],
        theme: { accent: "colour75" },
      },
    });
    expect(result.workspace.app?.views.map((view) => view.panel)).toEqual([
      "home",
      "terminals",
      "files",
      "diff",
      "missions",
    ]);
  });

  it("reports every unsupported root section and pane metadata field with stable codes and paths", () => {
    const result = convertLegacyConfigToWorkspace({
      name: "legacy",
      team: { name: "team" },
      orchestrator: { enabled: true },
      command_center: { enabled: true },
      dashboard: { port: 4000 },
      auth: { method: "ssh" },
      tunnel: { provider: "ngrok", port: 4040 },
      hq: { enabled: true, role: "hq" },
      sidebar: true,
      rows: [
        { panes: [{ title: "Lead", role: "lead", task: "ship", specialty: "ui", skill: "x" }] },
      ],
    });

    expect(result.diagnostics.map(({ code, path }) => [code, path])).toEqual([
      ["UNSUPPORTED_PANE_ROLE", "rows.0.panes.0.role"],
      ["UNSUPPORTED_PANE_TASK", "rows.0.panes.0.task"],
      ["UNSUPPORTED_PANE_SPECIALTY", "rows.0.panes.0.specialty"],
      ["UNSUPPORTED_PANE_SKILL", "rows.0.panes.0.skill"],
      ["UNSUPPORTED_TEAM", "team"],
      ["UNSUPPORTED_ORCHESTRATOR", "orchestrator"],
      ["UNSUPPORTED_COMMAND_CENTER", "command_center"],
      ["UNSUPPORTED_DASHBOARD", "dashboard"],
      ["UNSUPPORTED_AUTH", "auth"],
      ["UNSUPPORTED_TUNNEL", "tunnel"],
      ["UNSUPPORTED_HQ", "hq"],
      ["UNSUPPORTED_SIDEBAR", "sidebar"],
    ]);
  });

  it("dry-runs and writes JSON without changing ide.yml or overwriting workspace", async () => {
    const dir = tempDir();
    const legacyPath = join(dir, "ide.yml");
    const original = "name: legacy\nrows:\n  - panes:\n      - title: Lead\n        role: lead\n";
    writeFileSync(legacyPath, original);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await migrate(dir, { json: true, dryRun: true });

    expect(existsSync(join(dir, ".tmux-ide", "workspace.yml"))).toBe(false);
    expect(readFileSync(legacyPath, "utf-8")).toBe(original);
    const dryRunPayload = JSON.parse(logs[0]!);
    const canonicalDir = realpathSync(dir);
    expect(dryRunPayload).toMatchObject({
      ok: true,
      mode: "dry-run",
      legacyPath: join(canonicalDir, "ide.yml"),
      workspacePath: join(canonicalDir, ".tmux-ide", "workspace.yml"),
      written: null,
      workspace: { version: 1, name: "legacy" },
    });
    expect(dryRunPayload.workspaceYaml).toContain("version: 1");
    expect(dryRunPayload.diagnostics).toEqual([
      expect.objectContaining({ code: "UNSUPPORTED_PANE_ROLE", path: "rows.0.panes.0.role" }),
    ]);
    expect(dryRunPayload.warnings).toEqual([]);

    logs.length = 0;
    await migrate(dir, { json: true, write: true });

    const writePayload = JSON.parse(logs[0]!);
    expect(writePayload).toMatchObject({
      ok: true,
      mode: "write",
      legacyPath: join(canonicalDir, "ide.yml"),
      workspacePath: join(canonicalDir, ".tmux-ide", "workspace.yml"),
      written: join(canonicalDir, ".tmux-ide", "workspace.yml"),
      workspace: { version: 1, name: "legacy" },
    });
    expect(readYaml(join(dir, ".tmux-ide", "workspace.yml"))).toMatchObject({
      version: 1,
      name: "legacy",
      terminal: { rows: [{ panes: [{ title: "Lead" }] }] },
    });
    expect(readFileSync(legacyPath, "utf-8")).toBe(original);
    await expect(migrate(dir, { json: true, write: true })).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
  }, 10_000);

  it("migrates a nested legacy config beside the winning source in a git monorepo", async () => {
    const root = tempDir();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const appDir = join(root, "apps", "api");
    mkdirSync(join(appDir, "src"), { recursive: true });
    writeYaml(join(appDir, "ide.yml"), {
      name: "api",
      rows: [{ panes: [{ title: "API", command: "pnpm dev" }] }],
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await migrate(join(appDir, "src"), { json: true, write: true });

    const canonicalAppDir = realpathSync(appDir);
    const payload = JSON.parse(logs[0]!);
    expect(payload).toMatchObject({
      ok: true,
      mode: "write",
      legacyPath: join(canonicalAppDir, "ide.yml"),
      workspacePath: join(canonicalAppDir, ".tmux-ide", "workspace.yml"),
      written: join(canonicalAppDir, ".tmux-ide", "workspace.yml"),
    });
    expect(existsSync(join(appDir, ".tmux-ide", "workspace.yml"))).toBe(true);
    expect(existsSync(join(root, ".tmux-ide", "workspace.yml"))).toBe(false);
  }, 10_000);

  it("fails invalid YAML, invalid schema, unreadable legacy input, write conflict, and write errors with no partial workspace", async () => {
    const invalidYaml = tempDir();
    writeFileSync(join(invalidYaml, "ide.yml"), "name: broken\nrows: [\n");
    await expect(migrate(invalidYaml, { json: true, write: true })).rejects.toMatchObject({
      code: "LEGACY_YAML_INVALID",
    });
    expect(existsSync(join(invalidYaml, ".tmux-ide", "workspace.yml"))).toBe(false);

    const invalidSchema = tempDir();
    writeFileSync(join(invalidSchema, "ide.yml"), "name: broken\nrows: []\n");
    await expect(migrate(invalidSchema, { json: true, write: true })).rejects.toMatchObject({
      code: "LEGACY_SCHEMA_INVALID",
    });
    expect(existsSync(join(invalidSchema, ".tmux-ide", "workspace.yml"))).toBe(false);

    const unreadable = tempDir();
    mkdirSync(join(unreadable, "ide.yml"));
    await expect(migrate(unreadable, { json: true, write: true })).rejects.toMatchObject({
      code: "LEGACY_READ_FAILED",
    });
    expect(existsSync(join(unreadable, ".tmux-ide", "workspace.yml"))).toBe(false);

    const conflict = tempDir();
    const existingWorkspace = {
      version: 1,
      name: "existing",
      terminal: { rows: [{ panes: [{}] }] },
    };
    writeYaml(join(conflict, "ide.yml"), {
      name: "legacy",
      rows: [{ panes: [{ title: "Legacy" }] }],
    });
    writeYaml(join(conflict, ".tmux-ide", "workspace.yml"), existingWorkspace);
    await expect(migrate(conflict, { json: true, write: true })).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
    expect(readYaml(join(conflict, ".tmux-ide", "workspace.yml"))).toEqual(existingWorkspace);

    const writeFailure = tempDir();
    writeFileSync(
      join(writeFailure, "ide.yml"),
      "name: legacy\nrows:\n  - panes:\n      - title: Shell\n",
    );
    writeFileSync(join(writeFailure, ".tmux-ide"), "not a directory");
    try {
      await migrate(writeFailure, { json: true, write: true });
      throw new Error("expected migrate to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceConfigWriteError);
      expect((error as WorkspaceConfigWriteError).code).toBe("WORKSPACE_WRITE_FAILED");
    }
    expect(existsSync(join(writeFailure, ".tmux-ide", "workspace.yml"))).toBe(false);
  }, 20_000);

  it("aborts write if legacy source changes after it is read", async () => {
    const dir = tempDir();
    const legacyPath = join(dir, "ide.yml");
    writeFileSync(legacyPath, "name: original\nrows:\n  - panes:\n      - title: Shell\n");

    await expect(
      migrate(dir, {
        json: true,
        write: true,
        onAfterRead: () => {
          writeFileSync(legacyPath, "name: changed\nrows:\n  - panes:\n      - title: Shell\n");
        },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_CHANGED" });
    expect(existsSync(join(dir, ".tmux-ide", "workspace.yml"))).toBe(false);
    expect(readFileSync(legacyPath, "utf-8")).toContain("name: changed");
  });

  it("emits a gitignore warning when .tmux-ide/workspace.yml is ignored", async () => {
    const dir = tempDir();
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, ".gitignore"), ".tmux-ide/\n");
    writeFileSync(join(dir, "ide.yml"), "name: legacy\nrows:\n  - panes:\n      - title: Shell\n");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

    await migrate(dir, { json: true, dryRun: true });

    expect(JSON.parse(logs[0]!).warnings).toEqual([
      expect.objectContaining({
        code: "TMUX_IDE_DIR_IGNORED",
        message: expect.stringContaining(".tmux-ide/workspace.local.yml"),
      }),
    ]);
    expect(existsSync(join(dir, ".tmux-ide", "workspace.yml"))).toBe(false);
  });

  it("resolves workspace over legacy and applies workspace.local.yml overlay", async () => {
    const dir = tempDir();
    writeYaml(join(dir, "ide.yml"), { name: "legacy", rows: [{ panes: [{ title: "Legacy" }] }] });
    writeYaml(join(dir, ".tmux-ide", "workspace.yml"), {
      version: 1,
      name: "base",
      terminal: { rows: [{ panes: [{ title: "Base" }] }] },
    });
    writeYaml(join(dir, ".tmux-ide", "workspace.local.yml"), {
      terminal: { rows: [{ panes: [{ title: "Local" }] }] },
    });

    const resolved = await resolveConfig(dir);

    expect(resolved.kind).toBe("workspace");
    expect(resolved.path).toBe(join(realpathSync(dir), ".tmux-ide", "workspace.yml"));
    expect(resolved.launchConfig?.name).toBe("base");
    expect(resolved.launchConfig?.rows[0]?.panes[0]?.title).toBe("Local");
    expect(resolved.migrationHint).toBeNull();
  });

  it("preserves legacy launch parity while surfacing a migration hint", async () => {
    const dir = tempDir();
    const legacy = {
      name: "legacy",
      before: "pnpm install",
      rows: [
        {
          size: "70%",
          panes: [{ title: "Shell", command: "pnpm dev", env: { PORT: 3000 } }],
        },
      ],
      theme: { accent: "colour75" },
    };
    writeYaml(join(dir, "ide.yml"), legacy);

    const resolved = await resolveConfig(dir);

    expect(resolved.kind).toBe("legacy");
    expect(resolved.launchConfig).toEqual(legacy);
    expect(resolved.workspace).toMatchObject({
      version: 1,
      name: "legacy",
      terminal: {
        rows: [
          { size: "70%", panes: [{ title: "Shell", command: "pnpm dev", env: { PORT: 3000 } }] },
        ],
        theme: { accent: "colour75" },
      },
    });
    expect(resolved.migrationHint).toMatch(/tmux-ide migrate --dry-run/);
  });

  it("preserves existing app, harnesses, agents, missions, and local overlay during config writes", () => {
    const dir = tempDir();
    writeYaml(join(dir, ".tmux-ide", "workspace.yml"), {
      version: 1,
      name: "base",
      terminal: { rows: [{ panes: [{ title: "Shell" }] }] },
      app: { views: [{ id: "home", panel: "home" }] },
      harnesses: { h: { adapter: "custom", command: "agent" } },
      agents: { worker: { harness: "h", role: "implementer" } },
      missions: { workers: ["worker"] },
    });
    writeYaml(join(dir, ".tmux-ide", "workspace.local.yml"), {
      terminal: { rows: [{ panes: [{ title: "Local" }] }] },
    });

    writeConfig(dir, { name: "changed", rows: [{ panes: [{ title: "Changed" }] }] });

    const saved = readYaml(join(dir, ".tmux-ide", "workspace.yml")) as Record<string, unknown>;
    expect(saved.name).toBe("changed");
    expect(saved.app).toEqual({ views: [{ id: "home", panel: "home" }] });
    expect(saved.harnesses).toEqual({ h: { adapter: "custom", command: "agent" } });
    expect(saved.agents).toEqual({ worker: { harness: "h", role: "implementer" } });
    expect(saved.missions).toEqual({ workers: ["worker"] });
    expect(existsSync(join(dir, ".tmux-ide", "workspace.local.yml"))).toBe(true);
  });

  it("reports unknown root, row, and pane mutation fields with a truthful generic diagnostic code", () => {
    const dir = tempDir();
    writeYaml(join(dir, "ide.yml"), { name: "legacy", rows: [{ panes: [{ title: "Shell" }] }] });

    expect(() =>
      writeConfig(dir, {
        name: "legacy",
        rows: [
          {
            height: "70%",
            panes: [{ title: "Shell", width: 120 } as unknown as IdeConfig["rows"][0]["panes"][0]],
          } as unknown as IdeConfig["rows"][0],
        ],
        experimental: true,
      } as unknown as IdeConfig),
    ).toThrow(UnsupportedLegacyConfigMutationError);

    try {
      writeConfig(dir, {
        name: "legacy",
        rows: [
          {
            height: "70%",
            panes: [{ title: "Shell", width: 120 } as unknown as IdeConfig["rows"][0]["panes"][0]],
          } as unknown as IdeConfig["rows"][0],
        ],
        experimental: true,
      } as unknown as IdeConfig);
    } catch (error) {
      expect(error).toBeInstanceOf(IdeError);
      expect((error as UnsupportedLegacyConfigMutationError).code).toBe(
        "LEGACY_CONFIG_MUTATION_UNSUPPORTED",
      );
      expect((error as UnsupportedLegacyConfigMutationError).diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "UNSUPPORTED_UNKNOWN_FIELD", path: "experimental" }),
          expect.objectContaining({ code: "UNSUPPORTED_UNKNOWN_FIELD", path: "rows.0.height" }),
          expect.objectContaining({
            code: "UNSUPPORTED_UNKNOWN_FIELD",
            path: "rows.0.panes.0.width",
          }),
        ]),
      );
    }
  });
});
