import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

    assert.notStrictEqual(result.status, 0);
    assert.match(result.stderr, /No ide\.yml found in/);
    assert.doesNotMatch(result.stderr, /Unknown command:/);
  });

  it("returns a structured start json error when ide.yml is missing", () => {
    const missingDir = join(tmpdir(), "tmux-ide-missing-project-json");
    const result = runCli([missingDir, "--json"]);

    assert.notStrictEqual(result.status, 0);
    const payload = JSON.parse(result.stderr);
    assert.strictEqual(payload.code, "CONFIG_NOT_FOUND");
    assert.match(payload.error, /No ide\.yml found in/);
    assert.match(payload.error, /tmux-ide init/);
    assert.match(payload.error, /tmux-ide detect --write/);
  });

  it("prints help for --help without trying to launch tmux", () => {
    const result = runCli(["--help"]);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /tmux-ide <path>/);
    assert.doesNotMatch(result.stderr, /tmux new-session/);
  });

  it("includes inspect in the CLI help output", () => {
    const result = runCli(["--help"]);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /tmux-ide inspect/);
  });

  it("returns the full non-running status json shape", () => {
    const dir = makeProject();

    try {
      const result = runCli(["status", "--json"], { cwd: dir });

      assert.strictEqual(result.status, 0);
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        session: "test-session",
        running: false,
        configExists: true,
        panes: [],
      });
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

      assert.strictEqual(result.status, 0);
      const payload = JSON.parse(result.stdout);
      assert.deepStrictEqual(Object.keys(payload).sort(), ["detected", "suggestedConfig"]);
      assert.ok(Array.isArray(payload.detected.reasons));
      assert.ok(Array.isArray(payload.suggestedConfig.rows));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clean attach error without throwing a TypeError", () => {
    const dir = makeProject();

    try {
      const result = runCli(["attach"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Session "test-session" is not running/);
      assert.doesNotMatch(result.stderr, /ERR_INVALID_ARG_TYPE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a clean init error when ide.yml already exists", () => {
    const dir = makeProject();

    try {
      const result = runCli(["init"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /ide\.yml already exists/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured init json error when ide.yml already exists", () => {
    const dir = makeProject();

    try {
      const result = runCli(["init", "--json"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(JSON.parse(result.stderr), {
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

      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(JSON.parse(result.stderr), {
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

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /Invalid ide\.yml/);
      assert.match(result.stderr, /tmux-ide validate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured start json error for invalid config", () => {
    const dir = makeProject("name: broken\nrows: []\n");

    try {
      const result = runCli(["--json"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      const payload = JSON.parse(result.stderr);
      assert.strictEqual(payload.code, "INVALID_CONFIG");
      assert.match(payload.error, /Invalid ide\.yml/);
      assert.match(payload.error, /tmux-ide validate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured restart json error for invalid config", () => {
    const dir = makeProject("name: broken\nrows: []\n");

    try {
      const result = runCli(["restart", "--json"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      const payload = JSON.parse(result.stderr);
      assert.strictEqual(payload.code, "INVALID_CONFIG");
      assert.match(payload.error, /Invalid ide\.yml/);
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

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /before.*hook failed/i);
      assert.match(result.stderr, /node -e/);
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

      assert.notStrictEqual(result.status, 0);
      const payload = JSON.parse(result.stderr);
      assert.strictEqual(payload.code, "BEFORE_HOOK_FAILED");
      assert.match(payload.error, /before.*hook/i);
      assert.match(payload.error, /node -e/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured attach json error with a non-zero exit code", () => {
    const dir = makeProject();

    try {
      const result = runCli(["attach", "--json"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(JSON.parse(result.stderr), {
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

      assert.notStrictEqual(result.status, 0);
      assert.match(result.stderr, /No active session "test-session" found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured stop json error with a non-zero exit code", () => {
    const dir = makeProject();

    try {
      const result = runCli(["stop", "--json"], { cwd: dir });

      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(JSON.parse(result.stderr), {
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

      assert.strictEqual(human.status === 0, JSON.parse(json.stdout).ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
