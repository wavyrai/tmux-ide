import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor.ts";

let tmpDir: string;
let origCwd: string;
let origLog: typeof console.log;
let logged: string[];
let origExitCode: number | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-doctor-test-"));
  origCwd = process.cwd();
  logged = [];
  origLog = console.log;
  origExitCode = process.exitCode;
  console.log = (...a: string[]) => logged.push(a.join(" "));
});

afterEach(() => {
  process.chdir(origCwd);
  console.log = origLog;
  process.exitCode = origExitCode;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("doctor", () => {
  it("reports tmux installed check", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const tmuxCheck = output.checks.find((c) => c.label === "tmux installed");
    expect(tmuxCheck).toBeTruthy();
    // tmux is installed in this CI/test environment, so it should pass
    expect(tmuxCheck.pass).toBe(true);
  });

  it("reports tmux version check", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const versionCheck = output.checks.find((c) => c.label.includes("tmux version"));
    expect(versionCheck).toBeTruthy();
  });

  it("reports Node.js version check as passing", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const nodeCheck = output.checks.find((c) => c.label.includes("Node.js"));
    expect(nodeCheck).toBeTruthy();
    expect(nodeCheck.pass).toBe(true);
  });

  it("reports ide.yml exists check as passing when present", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const ideCheck = output.checks.find((c) => c.label.includes("ide.yml"));
    expect(ideCheck).toBeTruthy();
    expect(ideCheck.pass).toBe(true);
  });

  it("reports ide.yml exists check as failing when absent", async () => {
    process.chdir(tmpDir);
    // No ide.yml written
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const ideCheck = output.checks.find((c) => c.label.includes("ide.yml"));
    expect(ideCheck).toBeTruthy();
    expect(ideCheck.pass).toBe(false);
  });

  it("marks agent teams check as optional", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    await doctor({ json: true });
    const output = JSON.parse(logged[0]);
    const teamsCheck = output.checks.find((c) => c.label.includes("agent teams"));
    expect(teamsCheck).toBeTruthy();
    expect(teamsCheck.optional).toBe(true);
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
        expect(output.ok).toBe(true);
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
    expect(logged.length > 0).toBeTruthy();
    expect(logged.some((l) => l.includes("tmux installed"))).toBeTruthy();
  });
});
