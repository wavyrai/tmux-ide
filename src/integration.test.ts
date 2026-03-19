import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { launch } from "./launch.ts";
import { restart } from "./restart.ts";

// Skip entire suite unless tmux is installed and we can create sessions.
let tmuxAvailable = false;
try {
  execSync("tmux -V", { stdio: "ignore" });
  const probeSession = `tmux-ide-test-probe-${process.pid}`;
  try {
    execSync(`tmux new-session -d -s "${probeSession}" -x 80 -y 24`, { stdio: "ignore" });
    execSync(`tmux kill-session -t "${probeSession}"`, { stdio: "ignore" });
    tmuxAvailable = true;
  } catch {
    // tmux is installed but session creation is blocked in this environment.
  }
} catch {
  // tmux is not installed.
}

describe(
  "integration",
  { skip: !tmuxAvailable && "tmux is unavailable or session access is blocked" },
  () => {
    let tmpDir;
    const session = "tmux-ide-test-integration";
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cli = join(__dirname, "..", "bin", "cli.js");

    function run(args) {
      return execFileSync("node", [cli, ...args], { cwd: tmpDir, encoding: "utf-8" });
    }

    function runJSON(args) {
      return JSON.parse(run([...args, "--json"]));
    }

    function killSession() {
      try {
        execSync(`tmux kill-session -t "${session}"`, { stdio: "ignore" });
      } catch {
        // Session was already absent.
      }
    }

    function createSession() {
      execSync(`tmux new-session -d -s "${session}" -x 80 -y 24`, { stdio: "ignore" });
    }

    before(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-test-"));
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nrows:\n  - panes:\n      - title: Shell\n`,
      );
    });

    after(() => {
      killSession();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("status --json reports not running when no session exists", () => {
      killSession();
      const result = runJSON(["status"]);
      assert.strictEqual(result.running, false);
    });

    it("status --json reports running after session is created", () => {
      killSession();
      createSession();
      const result = runJSON(["status"]);
      assert.strictEqual(result.running, true);
      killSession();
    });

    it("inspect --json includes live tmux pane state when the session is running", () => {
      killSession();
      createSession();
      const result = runJSON(["inspect"]);

      assert.strictEqual(result.session, session);
      assert.strictEqual(result.tmux.running, true);
      assert.ok(Array.isArray(result.tmux.panes));
      assert.ok(result.tmux.panes.length >= 1);

      killSession();
    });

    it("launch creates the configured session without attaching when requested", async () => {
      killSession();

      await launch(tmpDir, { attach: false });

      const result = runJSON(["status"]);
      assert.strictEqual(result.running, true);
      assert.ok(result.panes.length >= 1);

      killSession();
    });

    it("launch reuses an existing session instead of creating a new layout", async () => {
      killSession();
      await launch(tmpDir, { attach: false });

      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nrows:\n  - panes:\n      - title: Changed\n      - title: Shell\n`,
      );

      await launch(tmpDir, { attach: false });

      const result = runJSON(["status"]);
      assert.strictEqual(result.running, true);
      assert.deepStrictEqual(
        result.panes.map((pane) => pane.title),
        ["Shell"],
      );

      killSession();
    });

    it("launch runs a successful before hook before creating the session", async () => {
      killSession();
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nbefore: node -e "require('node:fs').writeFileSync('before.ok','ok')"\nrows:\n  - panes:\n      - title: Shell\n`,
      );

      await launch(tmpDir, { attach: false });

      assert.strictEqual(runJSON(["status"]).running, true);
      assert.strictEqual(existsSync(join(tmpDir, "before.ok")), true);
      killSession();
    });

    it("launch does not create a session when the before hook fails", async () => {
      killSession();
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nbefore: node -e "process.exit(3)"\nrows:\n  - panes:\n      - title: Shell\n`,
      );

      await assert.rejects(() => launch(tmpDir, { attach: false }), /before hook failed/i);
      assert.strictEqual(runJSON(["status"]).running, false);
    });

    it("restart recreates the session without attaching when requested", async () => {
      killSession();
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nrows:\n  - panes:\n      - title: Shell\n`,
      );
      createSession();

      await restart(tmpDir, { attach: false });

      const result = runJSON(["status"]);
      assert.strictEqual(result.running, true);
      assert.ok(result.panes.length >= 1);

      killSession();
    });

    it("restart applies the updated layout from ide.yml", async () => {
      killSession();
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nrows:\n  - panes:\n      - title: Shell\n`,
      );
      await launch(tmpDir, { attach: false });

      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nrows:\n  - panes:\n      - title: Claude\n      - title: Shell\n`,
      );

      await restart(tmpDir, { attach: false });

      const result = runJSON(["status"]);
      assert.strictEqual(result.running, true);
      assert.strictEqual(result.panes.length, 2);
      assert.deepStrictEqual(
        result.panes.map((pane) => pane.title),
        ["Claude", "Shell"],
      );

      killSession();
    });

    it("launch applies a team layout without interactive attach", async () => {
      killSession();
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nteam:\n  name: test-team\nrows:\n  - panes:\n      - title: Lead\n        command: claude\n        role: lead\n      - title: Worker\n        command: claude\n        role: teammate\n        task: Review changes\n`,
      );

      await launch(tmpDir, { attach: false });

      const result = runJSON(["inspect"]);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.team.name, "test-team");
      assert.strictEqual(result.tmux.running, true);
      assert.deepStrictEqual(
        result.tmux.panes.map((pane) => pane.title),
        ["Lead", "Worker"],
      );

      killSession();
    });

    it("launch creates the expected pane layout for a team config", async () => {
      killSession();
      writeFileSync(
        join(tmpDir, "ide.yml"),
        `name: ${session}\nteam:\n  name: review-team\nrows:\n  - panes:\n      - title: Lead\n        command: claude\n        role: lead\n      - title: Reviewer\n        command: claude\n        role: teammate\n        task: Review the diff\n`,
      );

      await launch(tmpDir, { attach: false });

      const statusResult = runJSON(["status"]);
      const inspectResult = runJSON(["inspect"]);
      assert.strictEqual(statusResult.running, true);
      assert.strictEqual(statusResult.panes.length, 2);
      assert.strictEqual(inspectResult.team.name, "review-team");
      assert.strictEqual(inspectResult.summary.panes, 2);

      killSession();
    });

    it("stop --json kills a running session", () => {
      createSession();
      run(["stop"]);
      // Verify it's gone
      const result = runJSON(["status"]);
      assert.strictEqual(result.running, false);
    });

    it("validate --json reports valid for our test config", () => {
      const result = runJSON(["validate"]);
      assert.strictEqual(result.valid, true);
      assert.deepStrictEqual(result.errors, []);
    });

    it("doctor --json passes checks", () => {
      const result = runJSON(["doctor"]);
      assert.strictEqual(result.ok, true);
    });

    it("config --json dumps config", () => {
      const result = runJSON(["config"]);
      assert.strictEqual(result.name, session);
      assert.ok(Array.isArray(result.rows));
    });

    it("ls --json returns sessions list", () => {
      const result = runJSON(["ls"]);
      assert.ok(Array.isArray(result.sessions));
    });
  },
);
