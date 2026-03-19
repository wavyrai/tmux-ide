import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "bin", "cli.js");

function makeProject(config) {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-config-test-"));
  writeFileSync(join(dir, "ide.yml"), config);
  return dir;
}

function runCli(args, cwd) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

describe("config command hardening", () => {
  it("rejects config set when the YAML root is not an object", () => {
    const dir = makeProject("null\n");

    try {
      const result = runCli(["config", "set", "rows.0.title", "Shell"], dir);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /config root must be an object/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects add-pane when row panes is not an array", () => {
    const dir = makeProject("rows:\n  - panes: nope\n");

    try {
      const result = runCli(["config", "add-pane", "--row", "0", "--title", "Shell"], dir);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /row 0 panes must be an array/);
      assert.doesNotMatch(result.stderr, /TypeError/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses enable-team when there are no Claude panes to assign", () => {
    const dir = makeProject("name: my-app\nrows:\n  - panes:\n      - title: Shell\n");

    try {
      const result = runCli(["config", "enable-team"], dir);

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /no Claude panes found/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("assigns team metadata and Claude pane roles when enable-team succeeds", () => {
    const dir = makeProject(
      "name: my-app\nrows:\n  - panes:\n      - title: Lead\n        command: claude\n      - title: Reviewer\n        command: claude\n",
    );

    try {
      const result = runCli(["config", "enable-team", "--json"], dir);

      assert.strictEqual(result.status, 0);

      const payload = JSON.parse(result.stdout);
      assert.deepStrictEqual(payload.team, { name: "my-app" });
      assert.deepStrictEqual(payload.roles, [
        { row: 0, pane: 0, title: "Lead", role: "lead" },
        { row: 0, pane: 1, title: "Reviewer", role: "teammate" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
