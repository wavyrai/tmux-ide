import { describe, it, beforeEach, afterEach, expect } from "bun:test";
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
    const saved = readIdeYml();
    expect(saved.name).toBe("new-name");
  });

  it("updates a nested value", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.title", "Editor"] });
    const saved = readIdeYml();
    expect(saved.rows[0].panes[0].title).toBe("Editor");
  });

  it("coerces boolean strings", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.focus", "true"] });
    const saved = readIdeYml();
    expect(saved.rows[0].panes[0].focus).toBe(true);
  });

  it("coerces numeric strings", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "set", args: ["rows.0.panes.0.width", "120"] });
    const saved = readIdeYml();
    expect(saved.rows[0].panes[0].width).toBe(120);
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
    const saved = readIdeYml();
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
    const saved = readIdeYml();
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
    const saved = readIdeYml();
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
    const saved = readIdeYml();
    expect(saved.rows.length).toBe(2);
    expect(saved.rows[1].panes).toEqual([{ title: "Shell" }]);
  });

  it("creates row with size", async () => {
    writeIdeYml({ name: "test", rows: [{ panes: [{ title: "Shell" }] }] });
    await config(tmpDir, { json: true, action: "add-row", args: ["--size", "30%"] });
    const saved = readIdeYml();
    expect(saved.rows[1].size).toBe("30%");
  });

  it("initializes rows array when it doesn't exist", async () => {
    writeIdeYml({ name: "test" });
    await config(tmpDir, { json: true, action: "add-row", args: [] });
    const saved = readIdeYml();
    expect(saved.rows.length).toBe(1);
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
    expect(output.ok).toBe(true);
    expect(output.team.name).toBe("my-app");
    const saved = readIdeYml();
    expect(saved.rows[0].panes[0].role).toBe("lead");
    expect(saved.rows[0].panes[1].role).toBe("teammate");
    expect(saved.rows[0].panes[2].role).toBe(undefined);
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
    expect(output.ok).toBe(true);
    expect(output.disabled).toBe(true);
    const saved = readIdeYml();
    expect(saved.team).toBe(undefined);
    expect(saved.rows[0].panes[0].role).toBe(undefined);
    expect(saved.rows[0].panes[1].role).toBe(undefined);
    expect(saved.rows[0].panes[1].task).toBe(undefined);
  });
});
