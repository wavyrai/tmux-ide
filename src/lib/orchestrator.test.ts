import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatch,
  detectStalls,
  detectCompletions,
  buildTaskPrompt,
  type OrchestratorConfig,
  type OrchestratorState,
} from "./orchestrator.ts";
import {
  ensureTasksDir,
  saveMission,
  saveGoal,
  saveTask,
  loadTask,
  type Task,
} from "./task-store.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import { _setGitExecutor } from "./worktree.ts";

let tmpDir: string;
let restoreTmux: () => void;
let restoreGit: () => void;
let tmuxCalls: { args: string[] }[];
let gitCalls: { args: string[]; cwd: string }[];
let mockPanes: PaneInfo[];

function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    session: "test",
    dir: tmpDir,
    autoDispatch: true,
    stallTimeout: 300000,
    pollInterval: 5000,
    worktreeRoot: ".worktrees",
    masterPane: "Master",
    ...overrides,
  };
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    lastActivity: new Map(),
    previousTasks: new Map(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "001",
    title: "Test task",
    description: "",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 1,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    branch: null,
    tags: [],
    proof: null,
    ...overrides,
  };
}

function makePane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: "%1",
    index: 0,
    title: "Agent 1",
    currentCommand: "zsh",
    width: 80,
    height: 24,
    active: false,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-orch-test-"));
  ensureTasksDir(tmpDir);
  tmuxCalls = [];
  gitCalls = [];
  mockPanes = [];

  restoreTmux = _setExecutor((_cmd: string, args: string[]) => {
    tmuxCalls.push({ args });
    // Mock list-panes to return mockPanes as tab-separated output
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}`,
        )
        .join("\n");
    }
    return "";
  });

  restoreGit = _setGitExecutor((args: string[], cwd: string) => {
    gitCalls.push({ args, cwd });
    if (args[0] === "worktree" && args[1] === "list") return `worktree ${tmpDir}\n`;
    return "";
  });
});

afterEach(() => {
  restoreTmux();
  restoreGit();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dispatch", () => {
  it("assigns highest-priority task to idle agent", () => {
    const task1 = makeTask({ id: "001", title: "Low priority", priority: 2 });
    const task2 = makeTask({ id: "002", title: "High priority", priority: 1 });
    saveTask(tmpDir, task1);
    saveTask(tmpDir, task2);

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    const config = makeConfig();
    const state = makeState();

    dispatch(config, state, [task1, task2], panes);

    // Task 002 (higher priority) should be assigned first
    const assigned = loadTask(tmpDir, "002");
    assert.strictEqual(assigned?.assignee, "Agent 1");
    assert.strictEqual(assigned?.status, "in-progress");
  });

  it("skips master pane", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [
      makePane({ id: "%0", title: "Master", currentCommand: "zsh" }),
      makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" }),
    ];
    mockPanes = panes;

    const config = makeConfig();
    const state = makeState();

    dispatch(config, state, [task], panes);

    const assigned = loadTask(tmpDir, "001");
    assert.strictEqual(assigned?.assignee, "Agent 1");
  });

  it("does not assign when no idle agents", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    // All panes are busy (not running shell)
    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "claude" })];
    mockPanes = panes;

    const config = makeConfig();
    const state = makeState();

    dispatch(config, state, [task], panes);

    const notAssigned = loadTask(tmpDir, "001");
    assert.strictEqual(notAssigned?.assignee, null);
  });

  it("does not assign when no todo tasks", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [makePane({ id: "%2", title: "Agent 2", currentCommand: "zsh" })];
    mockPanes = panes;

    const config = makeConfig();
    const state = makeState();

    dispatch(config, state, [task], panes);

    // No send-keys calls for Agent 2
    const sendCalls = tmuxCalls.filter(
      (c) => c.args.includes("send-keys") && c.args.includes("%2"),
    );
    assert.strictEqual(sendCalls.length, 0);
  });
});

describe("detectStalls", () => {
  it("sends nudge after timeout", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1" })];

    const config = makeConfig({ stallTimeout: 1000 });
    const state = makeState({
      lastActivity: new Map([["%1", Date.now() - 2000]]),
    });

    detectStalls(config, state, [task], panes);

    // Should have sent a nudge via send-keys
    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    assert.ok(sendCalls.length > 0);
  });

  it("does not nudge before timeout", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1" })];

    const config = makeConfig({ stallTimeout: 300000 });
    const state = makeState({
      lastActivity: new Map([["%1", Date.now()]]),
    });

    detectStalls(config, state, [task], panes);

    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    assert.strictEqual(sendCalls.length, 0);
  });
});

describe("detectCompletions", () => {
  it("notifies master when task goes from in-progress to done", () => {
    const task = makeTask({ status: "done", assignee: "Agent 1", proof: { note: "tests pass" } });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeConfig();
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    // Should have sent notification to master
    const sendCalls = tmuxCalls.filter(
      (c) => c.args.includes("send-keys") && c.args.includes("%0"),
    );
    assert.ok(sendCalls.length > 0);
  });

  it("does not notify when task was already done", () => {
    const task = makeTask({ status: "done" });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeConfig();
    const state = makeState({
      previousTasks: new Map([["001", "done"]]),
    });

    detectCompletions(config, state, [task], panes);

    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    assert.strictEqual(sendCalls.length, 0);
  });
});

describe("buildTaskPrompt", () => {
  it("includes mission + goal + task context", () => {
    saveMission(tmpDir, {
      title: "Build auth",
      description: "Before Q2 audit",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    saveGoal(tmpDir, {
      id: "01",
      title: "Token storage",
      description: "",
      status: "in-progress",
      acceptance: "All tokens encrypted",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const task = makeTask({
      title: "Fix middleware",
      goal: "01",
      tags: ["security"],
      priority: 1,
    });

    const prompt = buildTaskPrompt(tmpDir, task, "/worktrees/001", "task/001-fix");

    assert.ok(prompt.includes("Mission: Build auth"));
    assert.ok(prompt.includes("Goal: Token storage"));
    assert.ok(prompt.includes("Acceptance: All tokens encrypted"));
    assert.ok(prompt.includes("Your Task: Fix middleware"));
    assert.ok(prompt.includes("Priority: P1"));
    assert.ok(prompt.includes("Tags: security"));
    assert.ok(prompt.includes("Workspace: /worktrees/001"));
    assert.ok(prompt.includes("Branch: task/001-fix"));
    assert.ok(prompt.includes("tmux-ide task done 001"));
  });

  it("works without mission or goal", () => {
    const task = makeTask({ title: "Standalone task" });
    const prompt = buildTaskPrompt(tmpDir, task, "/work", "branch");
    assert.ok(prompt.includes("Your Task: Standalone task"));
    assert.ok(!prompt.includes("Mission:"));
    assert.ok(!prompt.includes("Goal:"));
  });
});
