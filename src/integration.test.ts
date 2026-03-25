import { describe, it, beforeAll, afterAll, expect } from "bun:test";
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

const describeIntegration = tmuxAvailable ? describe : describe.skip;

describeIntegration("integration", () => {
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
    // Stop the session monitor before killing the tmux session
    // to prevent orphaned monitor processes from accumulating.
    try {
      const pid = execSync(`tmux show-option -gqvt "${session}" @monitor_pid`, {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (pid) {
        try {
          process.kill(-parseInt(pid, 10), "SIGTERM");
        } catch {
          try {
            process.kill(parseInt(pid, 10), "SIGTERM");
          } catch {
            /* already gone */
          }
        }
      }
    } catch {
      // No monitor PID or session gone
    }
    try {
      execSync(`tmux kill-session -t "${session}"`, { stdio: "ignore" });
    } catch {
      // Session was already absent.
    }
  }

  function createSession() {
    execSync(`tmux new-session -d -s "${session}" -x 80 -y 24`, { stdio: "ignore" });
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-test-"));
    writeFileSync(
      join(tmpDir, "ide.yml"),
      `name: ${session}\nrows:\n  - panes:\n      - title: Shell\n`,
    );
  });

  afterAll(() => {
    killSession();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("status --json reports not running when no session exists", () => {
    killSession();
    const result = runJSON(["status"]);
    expect(result.running).toBe(false);
  });

  it("status --json reports running after session is created", () => {
    killSession();
    createSession();
    const result = runJSON(["status"]);
    expect(result.running).toBe(true);
    killSession();
  });

  it("inspect --json includes live tmux pane state when the session is running", () => {
    killSession();
    createSession();
    const result = runJSON(["inspect"]);

    expect(result.session).toBe(session);
    expect(result.tmux.running).toBe(true);
    expect(Array.isArray(result.tmux.panes)).toBeTruthy();
    expect(result.tmux.panes.length >= 1).toBeTruthy();

    killSession();
  });

  it("launch creates the configured session without attaching when requested", async () => {
    killSession();

    await launch(tmpDir, { attach: false });

    const result = runJSON(["status"]);
    expect(result.running).toBe(true);
    expect(result.panes.length >= 1).toBeTruthy();

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
    expect(result.running).toBe(true);
    expect(result.panes.map((pane) => pane.title)).toEqual(["Shell"]);

    killSession();
  });

  it("launch runs a successful before hook before creating the session", async () => {
    killSession();
    writeFileSync(
      join(tmpDir, "ide.yml"),
      `name: ${session}\nbefore: node -e "require('node:fs').writeFileSync('before.ok','ok')"\nrows:\n  - panes:\n      - title: Shell\n`,
    );

    await launch(tmpDir, { attach: false });

    expect(runJSON(["status"]).running).toBe(true);
    expect(existsSync(join(tmpDir, "before.ok"))).toBe(true);
    killSession();
  });

  it("launch does not create a session when the before hook fails", async () => {
    killSession();
    writeFileSync(
      join(tmpDir, "ide.yml"),
      `name: ${session}\nbefore: node -e "process.exit(3)"\nrows:\n  - panes:\n      - title: Shell\n`,
    );

    await expect(launch(tmpDir, { attach: false })).rejects.toThrow(/before hook failed/i);
    expect(runJSON(["status"]).running).toBe(false);
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
    expect(result.running).toBe(true);
    expect(result.panes.length >= 1).toBeTruthy();

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
    expect(result.running).toBe(true);
    expect(result.panes.length).toBe(2);
    expect(result.panes.map((pane) => pane.title)).toEqual(["Claude", "Shell"]);

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
    expect(result.valid).toBe(true);
    expect(result.team.name).toBe("test-team");
    expect(result.tmux.running).toBe(true);
    expect(result.tmux.panes.map((pane) => pane.title)).toEqual(["Lead", "Worker"]);

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
    expect(statusResult.running).toBe(true);
    expect(statusResult.panes.length).toBe(2);
    expect(inspectResult.team.name).toBe("review-team");
    expect(inspectResult.summary.panes).toBe(2);

    killSession();
  });

  it("stop --json kills a running session", () => {
    createSession();
    run(["stop"]);
    // Verify it's gone
    const result = runJSON(["status"]);
    expect(result.running).toBe(false);
  });

  it("validate --json reports valid for our test config", () => {
    const result = runJSON(["validate"]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("doctor --json passes checks", () => {
    const result = runJSON(["doctor"]);
    expect(result.ok).toBe(true);
  });

  it("config --json dumps config", () => {
    const result = runJSON(["config"]);
    expect(result.name).toBe(session);
    expect(Array.isArray(result.rows)).toBeTruthy();
  });

  it("ls --json returns sessions list", () => {
    const result = runJSON(["ls"]);
    expect(Array.isArray(result.sessions)).toBeTruthy();
  });
});
