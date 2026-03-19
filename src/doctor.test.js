import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor.js";

let tmpDir;
let origCwd;
let origLog;
let logged;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-doctor-test-"));
  origCwd = process.cwd();
  logged = [];
  origLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
});

afterEach(() => {
  process.chdir(origCwd);
  console.log = origLog;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("doctor", () => {
  it("reports tmux installed check", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const tmuxCheck = output.checks.find((c) => c.label === "tmux installed");
    assert.ok(tmuxCheck, "should have a 'tmux installed' check");
    // tmux is installed in this CI/test environment, so it should pass
    assert.strictEqual(tmuxCheck.pass, true);
  });

  it("reports tmux version check", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const versionCheck = output.checks.find((c) => c.label.includes("tmux version"));
    assert.ok(versionCheck, "should have a tmux version check");
  });

  it("reports Node.js version check as passing", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const nodeCheck = output.checks.find((c) => c.label.includes("Node.js"));
    assert.ok(nodeCheck);
    assert.strictEqual(nodeCheck.pass, true);
  });

  it("reports ide.yml exists check as passing when present", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const ideCheck = output.checks.find((c) => c.label.includes("ide.yml"));
    assert.ok(ideCheck);
    assert.strictEqual(ideCheck.pass, true);
  });

  it("reports ide.yml exists check as failing when absent", async () => {
    process.chdir(tmpDir);
    // No ide.yml written
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const ideCheck = output.checks.find((c) => c.label.includes("ide.yml"));
    assert.ok(ideCheck);
    assert.strictEqual(ideCheck.pass, false);
  });

  it("marks agent teams check as optional", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const teamsCheck = output.checks.find((c) => c.label.includes("agent teams"));
    assert.ok(teamsCheck);
    assert.strictEqual(teamsCheck.optional, true);
  });

  it("optional checks don't fail the overall result", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    // Even if agent teams env var is not set, ok should still be true
    const origEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    try {
      await doctor({ json: true });
      const output = JSON.parse(logged[0]);
      // ok depends on required checks, not optional ones
      const requiredFailing = output.checks.filter((c) => !c.pass && !c.optional);
      if (requiredFailing.length === 0) {
        assert.strictEqual(output.ok, true);
      }
    } finally {
      if (origEnv !== undefined) {
        process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = origEnv;
      }
    }
  });

  it("prints human-readable output without --json", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor();
    // Should have printed colored output with ✓ or ✗
    assert.ok(logged.length > 0);
    assert.ok(logged.some((l) => l.includes("tmux installed")));
  });
});
