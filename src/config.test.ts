import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

function readIdeYml() {
  return yaml.load(readFileSync(join(tmpDir, "ide.yml"), "utf-8"));
}

describe("config dump", () => {
  it("outputs config as JSON", async () => {
    const cfg = { name: "test", rows: [{ panes: [{ title: "Shell" }] }] };
    writeIdeYml(cfg);
    await config(tmpDir, { json: true, action: "dump", args: [] });
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.name, "test");
    assert.strictEqual(output.rows[0].panes[0].title, "Shell");
  });
});

describe("config set", () => {
  it("updates a top-level value", async () => {
    writeIdeYml({ name: "old", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["name", "new-name"] });
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.value, "new-name");
    const saved = readIdeYml();
    assert.strictEqual(saved.name, "new-name");
  });

  it("updates a nested value", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.title", "Editor"] });
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes[0].title, "Editor");
  });

  it("coerces boolean strings", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.focus", "true"] });
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes[0].focus, true);
  });

  it("coerces numeric strings", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.width", "120"] });
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes[0].width, 120);
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
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.pane.title, "Tests");
    assert.strictEqual(output.pane.command, "pnpm test");
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes.length, 2);
    assert.strictEqual(saved.rows[0].panes[1].title, "Tests");
  });

  it("adds pane with size", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, {
      json: true,
      action: "add-pane",
      args: ["--row", "0", "--title", "Wide", "--size", "60%"],
    });
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes[1].size, "60%");
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
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.removed.title, "B");
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes.length, 2);
    assert.strictEqual(saved.rows[0].panes[0].title, "A");
    assert.strictEqual(saved.rows[0].panes[1].title, "C");
  });
});

describe("config add-row", () => {
  it("creates row with default Shell pane", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "add-row", args: [] });
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.row, 1);
    const saved = readIdeYml();
    assert.strictEqual(saved.rows.length, 2);
    assert.deepStrictEqual(saved.rows[1].panes, [{ title: "Shell" }]);
  });

  it("creates row with size", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "add-row", args: ["--size", "30%"] });
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[1].size, "30%");
  });

  it("initializes rows array when it doesn't exist", async () => {
    writeIdeYml({ name: "test" });
    await config(tmpDir, { json: true, action: "add-row", args: [] });
    const saved = readIdeYml();
    assert.strictEqual(saved.rows.length, 1);
  });
});

describe("config enable-team", () => {
  it("assigns roles to Claude panes", async () => {
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
    await config(tmpDir, { json: true, action: "enable-team", args: [] });
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.team.name, "my-app");
    const saved = readIdeYml();
    assert.strictEqual(saved.rows[0].panes[0].role, "lead");
    assert.strictEqual(saved.rows[0].panes[1].role, "teammate");
    assert.strictEqual(saved.rows[0].panes[2].role, undefined);
  });
});

describe("config disable-team", () => {
  it("removes team and role/task fields", async () => {
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
    await config(tmpDir, { json: true, action: "disable-team", args: [] });
    const output = JSON.parse(logged[0]);
    assert.strictEqual(output.ok, true);
    assert.strictEqual(output.disabled, true);
    const saved = readIdeYml();
    assert.strictEqual(saved.team, undefined);
    assert.strictEqual(saved.rows[0].panes[0].role, undefined);
    assert.strictEqual(saved.rows[0].panes[1].role, undefined);
    assert.strictEqual(saved.rows[0].panes[1].task, undefined);
  });
});
