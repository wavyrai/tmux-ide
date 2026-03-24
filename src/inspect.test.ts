import { describe, it, expect } from "bun:test";
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

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.session).toBe("inspect-session");
      expect(payload.valid).toBe(true);
      expect(payload.summary.rows).toBe(1);
      expect(payload.summary.panes).toBe(2);
      expect(payload.summary.focus).toBe("rows.0.panes.0");
      expect(payload.tmux.running).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports validation errors for invalid pane arrays instead of crashing", () => {
    const dir = makeProject("name: inspect-session\nrows:\n  - panes: nope\n");

    try {
      const result = runCli(["inspect", "--json"], dir);

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(payload.valid).toBe(false);
      expect(JSON.stringify(payload.errors)).toMatch(/rows\[0\]\.panes must be an array/);
      expect(payload.rows).toEqual([
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
