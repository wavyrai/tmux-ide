import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "bin", "cli.js");

function makeProject(config = "name: inspect-session\nrows:\n  - panes:\n      - title: Shell\n") {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-inspect-test-"));
  writeFileSync(join(dir, "ide.yml"), config);
  return dir;
}

function runCli(args, cwd) {
  return spawnSync("node", [cli, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

describe("inspect command", () => {
  it("prints resolved config state as json", () => {
    const dir = makeProject(
      "name: inspect-session\nrows:\n  - size: 70%\n    panes:\n      - title: Claude\n        command: claude\n        focus: true\n      - title: Shell\n",
    );

    try {
      const result = runCli(["inspect", "--json"], dir);

      assert.strictEqual(result.status, 0);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.session, "inspect-session");
      assert.strictEqual(payload.valid, true);
      assert.strictEqual(payload.summary.rows, 1);
      assert.strictEqual(payload.summary.panes, 2);
      assert.strictEqual(payload.summary.focus, "rows.0.panes.0");
      assert.strictEqual(payload.tmux.running, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports validation errors for invalid pane arrays instead of crashing", () => {
    const dir = makeProject("name: inspect-session\nrows:\n  - panes: nope\n");

    try {
      const result = runCli(["inspect", "--json"], dir);

      assert.strictEqual(result.status, 0);
      const payload = JSON.parse(result.stdout);
      assert.strictEqual(payload.valid, false);
      assert.match(JSON.stringify(payload.errors), /rows\[0\]\.panes must be an array/);
      assert.deepStrictEqual(payload.rows, [
        {
          index: 0,
          size: null,
          panes: [],
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
