import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "bin", "cli.js");

function makeProject(config = "name: test-session\nrows:\n  - panes:\n      - title: Shell\n") {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-cli-test-"));
  writeFileSync(join(dir, "ide.yml"), config);
  return dir;
}

function runCli(args, { cwd, env } = {}) {
  const mergedEnv = { ...process.env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      delete mergedEnv[key];
    } else {
      mergedEnv[key] = value;
    }
  }

  return spawnSync("node", [cli, ...args], {
    cwd,
    env: mergedEnv,
    encoding: "utf-8",
  });
}

describe("cli contract regressions", () => {
  it("treats an unknown first positional as a start target path", () => {
    const missingDir = join(tmpdir(), "tmux-ide-missing-project");
    const result = runCli([missingDir]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No ide\.yml found in/);
    expect(result.stderr).not.toMatch(/Unknown command:/);
  });

  it("returns a structured start json error when ide.yml is missing", () => {
    const missingDir = join(tmpdir(), "tmux-ide-missing-project-json");
    const result = runCli([missingDir, "--json"]);

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(result.stderr);
    expect(payload.code).toBe("CONFIG_NOT_FOUND");
    expect(payload.error).toMatch(/No ide\.yml found in/);
    expect(payload.error).toMatch(/tmux-ide init/);
    expect(payload.error).toMatch(/tmux-ide detect --write/);
  });

  it("prints help for --help without trying to launch tmux", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stdout).toMatch(/tmux-ide <path>/);
    expect(result.stderr).not.toMatch(/tmux new-session/);
  });

  it("includes inspect in the CLI help output", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/tmux-ide inspect/);
  });

  it("returns the full non-running status json shape", () => {
    const dir = makeProject();

    try {
      const result = runCli(["status", "--json"], { cwd: dir });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.session).toBe("test-session");
      expect(output.running).toBe(false);
      expect(output.configExists).toBe(true);
      expect(output.panes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the detect json envelope with reasoning", () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-detect-json-test-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { dev: "vite" },
        dependencies: { vite: "^5.0.0" },
      }),
    );

    try {
      const result = runCli(["detect", "--json"], { cwd: dir });

      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout);
      expect(Object.keys(payload).sort()).toEqual(["detected", "suggestedConfig"]);
      expect(Array.isArray(payload.detected.reasons)).toBeTruthy();
      expect(Array.isArray(payload.suggestedConfig.rows)).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clean attach error without throwing a TypeError", () => {
    const dir = makeProject();

    try {
      const result = runCli(["attach"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Session "test-session" is not running/);
      expect(result.stderr).not.toMatch(/ERR_INVALID_ARG_TYPE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clean init error when ide.yml already exists", () => {
    const dir = makeProject();

    try {
      const result = runCli(["init"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/ide\.yml already exists/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured init json error when ide.yml already exists", () => {
    const dir = makeProject();

    try {
      const result = runCli(["init", "--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr)).toEqual({
        error: "ide.yml already exists in this directory",
        code: "EXISTS",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured init json error for an unknown template", () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-cli-init-test-"));

    try {
      const result = runCli(["init", "--template", "missing-template", "--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr)).toEqual({
        error: 'Template "missing-template" not found',
        code: "NOT_FOUND",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clean start error for invalid config", () => {
    const dir = makeProject("name: broken\nrows: []\n");

    try {
      const result = runCli([], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Invalid ide\.yml/);
      expect(result.stderr).toMatch(/tmux-ide validate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured start json error for invalid config", () => {
    const dir = makeProject("name: broken\nrows: []\n");

    try {
      const result = runCli(["--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stderr);
      expect(payload.code).toBe("INVALID_CONFIG");
      expect(payload.error).toMatch(/Invalid ide\.yml/);
      expect(payload.error).toMatch(/tmux-ide validate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured restart json error for invalid config", () => {
    const dir = makeProject("name: broken\nrows: []\n");

    try {
      const result = runCli(["restart", "--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stderr);
      expect(payload.code).toBe("INVALID_CONFIG");
      expect(payload.error).toMatch(/Invalid ide\.yml/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clean launch error when the before hook fails", () => {
    const dir = makeProject(
      'name: before-fails\nbefore: node -e "process.exit(3)"\nrows:\n  - panes:\n      - title: Shell\n',
    );

    try {
      const result = runCli([], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/before.*hook failed/i);
      expect(result.stderr).toMatch(/node -e/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured start json error when the before hook fails", () => {
    const dir = makeProject(
      'name: before-fails\nbefore: node -e "process.exit(3)"\nrows:\n  - panes:\n      - title: Shell\n',
    );

    try {
      const result = runCli(["--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      const payload = JSON.parse(result.stderr);
      expect(payload.code).toBe("BEFORE_HOOK_FAILED");
      expect(payload.error).toMatch(/before.*hook/i);
      expect(payload.error).toMatch(/node -e/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured attach json error with a non-zero exit code", () => {
    const dir = makeProject();

    try {
      const result = runCli(["attach", "--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr)).toEqual({
        error: 'Session "test-session" is not running. Start it with: tmux-ide',
        code: "NOT_RUNNING",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a non-zero exit code when stop cannot find the session", () => {
    const dir = makeProject();

    try {
      const result = runCli(["stop"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/No active session "test-session" found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured stop json error with a non-zero exit code", () => {
    const dir = makeProject();

    try {
      const result = runCli(["stop", "--json"], { cwd: dir });

      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stderr)).toEqual({
        error: 'No active session "test-session" found',
        code: "NOT_RUNNING",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps doctor human and json success semantics aligned for optional checks", () => {
    const dir = makeProject();

    try {
      const human = runCli(["doctor"], {
        cwd: dir,
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: undefined },
      });
      const json = runCli(["doctor", "--json"], {
        cwd: dir,
        env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: undefined },
      });

      expect(human.status === 0).toBe(JSON.parse(json.stdout).ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
