import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { config } from "./config.ts";

let tmpDir;
let origLog;
let logged;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-config-test-"));
  logged = [];
  origLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
});

afterEach(() => {
  console.log = origLog;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeIdeYml(obj) {
  writeFileSync(
    join(tmpDir, "ide.yml"),
    yaml.dump(obj, { lineWidth: -1, noRefs: true, quotingType: '"' }),
  );
}

function readWorkspaceYml() {
  return yaml.load(readFileSync(join(tmpDir, ".tmux-ide", "workspace.yml"), "utf-8"));
}

function readWorkspaceYmlAt(dir) {
  return yaml.load(readFileSync(join(dir, ".tmux-ide", "workspace.yml"), "utf-8"));
}

function legacyProjection(workspace) {
  return {
    name: workspace.name,
    rows: workspace.terminal.rows,
  };
}

describe("config dump", () => {
  it("outputs config as JSON", async () => {
    const cfg = { name: "test", rows: [{ panes: [{ title: "Shell" }] }] };
    writeIdeYml(cfg);
    await config(tmpDir, { json: true, action: "dump", args: [] });
    const output = JSON.parse(logged[0]);
    expect(output.name).toBe("test");
    expect(output.rows[0].panes[0].title).toBe("Shell");
  });
});

describe("config set", () => {
  it("updates a top-level value", async () => {
    writeIdeYml({ name: "old", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["name", "new-name"] });
    const output = JSON.parse(logged[0]);
    expect(output.ok).toBe(true);
    expect(output.value).toBe("new-name");
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.name).toBe("new-name");
  });

  it("updates a nested value", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.title", "Editor"] });
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[0].panes[0].title).toBe("Editor");
  });

  it("writes beside the winning nested workspace config instead of creating a root config", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    const appDir = join(tmpDir, "apps", "web");
    const nestedDir = join(appDir, "src");
    mkdirSync(join(appDir, ".tmux-ide"), { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(appDir, ".tmux-ide", "workspace.yml"),
      "version: 1\nname: web\nterminal:\n  rows:\n    - panes:\n        - title: Shell\n",
    );

    await config(nestedDir, { json: true, action: "set", args: ["name", "renamed-web"] });

    expect(readWorkspaceYmlAt(appDir).name).toBe("renamed-web");
    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBe(false);
  });

  it("writes beside the winning nested legacy config instead of creating a root config", async () => {
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    const appDir = join(tmpDir, "apps", "api");
    const nestedDir = join(appDir, "src");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(join(appDir, "ide.yml"), "name: api\nrows:\n  - panes:\n      - title: Shell\n");

    await config(nestedDir, { json: true, action: "set", args: ["name", "renamed-api"] });

    expect(readWorkspaceYmlAt(appDir).name).toBe("renamed-api");
    expect(existsSync(join(tmpDir, ".tmux-ide", "workspace.yml"))).toBe(false);
  });

  it("coerces boolean strings", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.focus", "true"] });
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[0].panes[0].focus).toBe(true);
  });

  it("coerces numeric strings", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, {
      json: true,
      action: "set",
      args: ["rows.0.panes.0.env.PORT", "120"],
    });
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[0].panes[0].env.PORT).toBe(120);
  });

  it("rejects unsupported pane fields instead of reporting a lossy set", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });

    await expect(
      config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.width", "120"] }),
    ).rejects.toMatchObject({
      code: "LEGACY_CONFIG_MUTATION_UNSUPPORTED",
    });
  });
});

describe("config add-pane", () => {
  it("adds pane to existing row", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, {
      json: true,
      action: "add-pane",
      args: ["--row", "0", "--title", "Tests", "--command", "pnpm test"],
    });
    const output = JSON.parse(logged[0]);
    expect(output.ok).toBe(true);
    expect(output.pane.title).toBe("Tests");
    expect(output.pane.command).toBe("pnpm test");
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[0].panes.length).toBe(2);
    expect(saved.rows[0].panes[1].title).toBe("Tests");
  });

  it("adds pane with size", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, {
      json: true,
      action: "add-pane",
      args: ["--row", "0", "--title", "Wide", "--size", "60%"],
    });
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[0].panes[1].size).toBe("60%");
  });
});

describe("config remove-pane", () => {
  it("removes pane by index", async () => {
    writeIdeYml({
      name: "test",
      rows: [{ panes: [{ title: "A" }, { title: "B" }, { title: "C" }] }],
    });
    await config(tmpDir, {
      json: true,
      action: "remove-pane",
      args: ["--row", "0", "--pane", "1"],
    });
    const output = JSON.parse(logged[0]);
    expect(output.ok).toBe(true);
    expect(output.removed.title).toBe("B");
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[0].panes.length).toBe(2);
    expect(saved.rows[0].panes[0].title).toBe("A");
    expect(saved.rows[0].panes[1].title).toBe("C");
  });
});

describe("config add-row", () => {
  it("creates row with default Shell pane", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "add-row", args: [] });
    const output = JSON.parse(logged[0]);
    expect(output.ok).toBe(true);
    expect(output.row).toBe(1);
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows.length).toBe(2);
    expect(saved.rows[1].panes).toEqual([{ title: "Shell" }]);
  });

  it("creates row with size", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "add-row", args: ["--size", "30%"] });
    const saved = legacyProjection(readWorkspaceYml());
    expect(saved.rows[1].size).toBe("30%");
  });

  it("initializes rows array when it doesn't exist", async () => {
    writeIdeYml({ name: "test" });
    await expect(config(tmpDir, { json: true, action: "add-row", args: [] })).rejects.toThrow(
      /Invalid legacy ide\.yml/,
    );
  });
});

describe("config enable-team", () => {
  it("rejects legacy-only team metadata instead of dropping it", async () => {
    writeIdeYml({
      name: "my-app",
      rows: [
        {
          panes: [
            { title: "Lead", command: "claude" },
            { title: "Worker", command: "claude" },
            { title: "Shell" },
          ],
        },
      ],
    });
    await expect(config(tmpDir, { json: true, action: "enable-team", args: [] })).rejects.toThrow(
      /legacy-only fields/,
    );
  });
});

describe("config disable-team", () => {
  it("rejects mutation when legacy config already contains unsupported team fields", async () => {
    writeIdeYml({
      name: "my-app",
      team: { name: "my-app" },
      rows: [
        {
          panes: [
            { title: "Lead", command: "claude", role: "lead" },
            { title: "Worker", command: "claude", role: "teammate", task: "Build UI" },
          ],
        },
      ],
    });
    await expect(config(tmpDir, { json: true, action: "disable-team", args: [] })).rejects.toThrow(
      /unsupported fields/,
    );
  });
});
