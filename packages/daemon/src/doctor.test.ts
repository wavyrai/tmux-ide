import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor.ts";
import {
  ensureTasksDir,
  invalidateAllTaskStore,
  saveGoal,
  saveTask,
  type Goal,
  type Task,
} from "./lib/task-store.ts";

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
  invalidateAllTaskStore();
});

afterEach(() => {
  invalidateAllTaskStore();
  process.chdir(origCwd);
  console.log = origLog;
  process.exitCode = origExitCode;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = "2026-05-02T00:00:00.000Z";
  return {
    id: "01",
    title: "Goal 01",
    description: "",
    status: "todo",
    acceptance: "",
    priority: 1,
    created: now,
    updated: now,
    assignee: null,
    specialty: null,
    milestone: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = "2026-05-02T00:00:00.000Z";
  return {
    id: "001",
    title: "Task 001",
    description: "",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 1,
    created: now,
    updated: now,
    tags: [],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
    milestone: null,
    specialty: null,
    fulfills: [],
    discoveredIssues: [],
    salientSummary: null,
    ...overrides,
  };
}

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

  it("doctor --tasks reports orphan refs, missing proofs, and unclaimed assertions", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, makeGoal({ id: "01" }));
    saveTask(
      tmpDir,
      makeTask({
        id: "001",
        goal: "99",
        status: "done",
        fulfills: [],
      }),
    );
    writeFileSync(join(tmpDir, ".tasks", "validation-contract.md"), "**ASSERT01**: works\n");

    await doctor({ json: true, tasks: true });
    const output = JSON.parse(logged[0]);
    expect(output.ok).toBe(false);
    const types = output.tasks.issues.map((issue) => issue.type);
    expect(types).toContain("orphan-goal");
    expect(types).toContain("missing-proof");
    expect(types).toContain("unclaimed-assertion");
  });

  it("doctor --tasks reports schema errors with file paths", async () => {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "ide.yml"), "name: test\nrows:\n  - panes:\n      - title: Shell\n");
    mkdirSync(join(tmpDir, ".tasks", "tasks"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".tasks", "tasks", "001-bad.json"),
      JSON.stringify({ _version: 1, id: "001", title: "Bad", status: "later" }, null, 2),
    );

    await doctor({ json: true, tasks: true });
    const output = JSON.parse(logged[0]);
    const schema = output.tasks.issues.find((issue) => issue.type === "schema");
    expect(schema).toBeTruthy();
    expect(schema.file).toContain(".tasks/tasks/001-bad.json");
    expect(schema.message).toContain("status");
  });
});
