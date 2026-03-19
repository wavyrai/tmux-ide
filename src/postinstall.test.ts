import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const script = join(__dirname, "..", "scripts", "postinstall.js");

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-postinstall-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { root, home };
}

function runPostinstall({ home, env } = {}) {
  return spawnSync("node", [script], {
    env: {
      ...process.env,
      HOME: home,
      ...env,
    },
    encoding: "utf-8",
  });
}

describe("postinstall", () => {
  it("does not create Claude config for non-global installs", () => {
    const { root, home } = makeHome();

    try {
      const result = runPostinstall({ home, env: { npm_config_global: undefined } });

      assert.strictEqual(result.status, 0);
      assert.strictEqual(existsSync(join(home, ".claude")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not create Claude config when Claude is not installed", () => {
    const { root, home } = makeHome();

    try {
      const result = runPostinstall({ home, env: { npm_config_global: "true" } });

      assert.strictEqual(result.status, 0);
      assert.strictEqual(existsSync(join(home, ".claude")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("updates existing Claude settings for global installs", () => {
    const { root, home } = makeHome();
    const claudeDir = join(home, ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify({ env: { KEEP_ME: "1" } }, null, 2)}\n`);

    try {
      const result = runPostinstall({ home, env: { npm_config_global: "true" } });

      assert.strictEqual(result.status, 0);
      assert.strictEqual(existsSync(join(claudeDir, "skills", "tmux-ide", "SKILL.md")), true);

      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      assert.deepStrictEqual(settings.env, {
        KEEP_ME: "1",
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
