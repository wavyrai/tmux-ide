import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatch,
  detectStalls,
  detectCompletions,
  buildTaskPrompt,
  runHook,
  createOrchestrator,
  isAgentPane,
  isAgentBusy,
  isIdleForDispatch,
  saveOrchestratorState,
  loadOrchestratorState,
  gracefulShutdown,
  reloadConfig,
  reconcile,
  type OrchestratorConfig,
  type OrchestratorState,
} from "./orchestrator.ts";
import { readEvents } from "./event-log.ts";
import {
  ensureTasksDir,
  saveMission,
  saveGoal,
  saveTask,
  loadTask,
  loadTasks,
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
    beforeRun: null,
    afterRun: null,
    cleanupOnDone: false,
    maxConcurrentAgents: 10,
    ...overrides,
  };
}

function makeState(overrides: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    lastActivity: new Map(),
    previousTasks: new Map(),
    claimedTasks: new Set(),
    taskClaimTimes: new Map(),
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
  // Create worktree root so validateWorktreePath succeeds in dispatch tests
  mkdirSync(join(tmpDir, ".worktrees"), { recursive: true });
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

    // Agent pane is busy (spinner in title indicates active work)
    const panes: PaneInfo[] = [
      makePane({ id: "%1", title: "⠙ Agent 1", currentCommand: "claude" }),
    ];
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
    const task = makeTask({ status: "done", assignee: "Agent 1", proof: { notes: "tests pass" } });

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

describe("runHook", () => {
  it("returns ok:true for successful command", () => {
    const result = runHook("true", tmpDir);
    assert.deepStrictEqual(result, { ok: true });
  });

  it("returns ok:false with error for failing command", () => {
    const result = runHook("false", tmpDir);
    assert.strictEqual(result.ok, false);
    assert.ok("error" in result && result.error.length > 0);
  });

  it("runs command in the specified cwd", () => {
    // Create a marker file, then check it exists via the hook
    writeFileSync(join(tmpDir, "marker.txt"), "hello");
    const result = runHook("test -f marker.txt", tmpDir);
    assert.deepStrictEqual(result, { ok: true });
  });

  it("fails when cwd does not contain expected file", () => {
    const result = runHook("test -f nonexistent.txt", tmpDir);
    assert.strictEqual(result.ok, false);
  });
});

describe("dispatch with hooks", () => {
  it("skips task when before_run fails", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    // Create the worktree directory so the hook can attempt to run
    mkdirSync(join(tmpDir, ".worktrees", "001-test-task"), { recursive: true });

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    // before_run that always fails
    const config = makeConfig({ beforeRun: "false" });
    const state = makeState();

    dispatch(config, state, [task], panes);

    // Task should NOT be assigned
    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.assignee, null);
    assert.strictEqual(loaded?.status, "todo");
  });

  it("dispatches task when before_run succeeds", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    // Create the worktree directory so the hook can run in it
    mkdirSync(join(tmpDir, ".worktrees", "001-test-task"), { recursive: true });

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    // before_run that always succeeds
    const config = makeConfig({ beforeRun: "true" });
    const state = makeState();

    dispatch(config, state, [task], panes);

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.assignee, "Agent 1");
    assert.strictEqual(loaded?.status, "in-progress");
  });
});

describe("detectCompletions with after_run", () => {
  it("runs after_run hook when task completes", () => {
    // Create worktree directory so after_run can find it
    const wtDir = join(tmpDir, ".worktrees", "001-test-task");
    mkdirSync(wtDir, { recursive: true });

    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    // after_run creates a marker file — proves it ran in the worktree
    const config = makeConfig({ afterRun: "touch after_run_marker" });
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    assert.ok(existsSync(join(wtDir, "after_run_marker")));
  });

  it("does not crash when after_run fails", () => {
    const wtDir = join(tmpDir, ".worktrees", "001-test-task");
    mkdirSync(wtDir, { recursive: true });

    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    // after_run that fails — should not throw
    const config = makeConfig({ afterRun: "false" });
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    // Should not throw
    detectCompletions(config, state, [task], panes);

    // Master should still get notified despite hook failure
    const sendCalls = tmuxCalls.filter(
      (c) => c.args.includes("send-keys") && c.args.includes("%0"),
    );
    assert.ok(sendCalls.length > 0);
  });
});

describe("isAgentPane", () => {
  it("detects claude command", () => {
    assert.ok(isAgentPane(makePane({ currentCommand: "claude" })));
  });

  it("detects codex command", () => {
    assert.ok(isAgentPane(makePane({ currentCommand: "codex" })));
  });

  it("detects Claude Code via version string + title", () => {
    assert.ok(isAgentPane(makePane({ currentCommand: "2.1.80", title: "Claude Code" })));
  });

  it("detects Claude Code via title pattern", () => {
    assert.ok(isAgentPane(makePane({ currentCommand: "node", title: "Claude Code" })));
  });

  it("does not match a plain shell", () => {
    assert.ok(!isAgentPane(makePane({ currentCommand: "zsh", title: "Shell" })));
  });

  it("does not match version string without Claude in title", () => {
    assert.ok(!isAgentPane(makePane({ currentCommand: "2.1.80", title: "Dev Server" })));
  });
});

describe("isAgentBusy", () => {
  it("returns true when spinner in title", () => {
    assert.ok(isAgentBusy(makePane({ title: "⠙ Working..." })));
  });

  it("returns false for normal title", () => {
    assert.ok(!isAgentBusy(makePane({ title: "Claude Code" })));
  });
});

describe("isIdleForDispatch", () => {
  it("returns true for shell command", () => {
    assert.ok(isIdleForDispatch(makePane({ currentCommand: "zsh" })));
    assert.ok(isIdleForDispatch(makePane({ currentCommand: "bash" })));
    assert.ok(isIdleForDispatch(makePane({ currentCommand: "fish" })));
  });

  it("returns true for agent pane without spinner", () => {
    assert.ok(isIdleForDispatch(makePane({ currentCommand: "claude", title: "Agent 1" })));
  });

  it("returns true for Claude with version command and no spinner", () => {
    assert.ok(
      isIdleForDispatch(makePane({ currentCommand: "2.1.80", title: "Claude Code" })),
    );
  });

  it("returns false for agent pane with spinner", () => {
    assert.ok(
      !isIdleForDispatch(makePane({ currentCommand: "claude", title: "⠹ Thinking..." })),
    );
  });

  it("returns false for non-agent non-shell command", () => {
    assert.ok(!isIdleForDispatch(makePane({ currentCommand: "vim", title: "Editor" })));
  });
});

describe("claim locking", () => {
  it("prevents double-dispatch of same task across two calls", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [
      makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" }),
      makePane({ id: "%2", title: "Agent 2", currentCommand: "zsh" }),
    ];
    mockPanes = panes;

    const config = makeConfig();
    const state = makeState();

    // First dispatch claims the task
    dispatch(config, state, [task], panes);
    assert.ok(state.claimedTasks.has("001"));

    // Reset task to todo to simulate a race (file not yet updated)
    const raceTask = makeTask({ status: "todo", assignee: null });

    // Second dispatch should skip claimed task
    dispatch(config, state, [raceTask], panes);

    // Only one send-keys call with the task prompt (not two)
    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    // First dispatch: send-keys text + send-keys Enter = 2 calls
    assert.strictEqual(sendCalls.length, 2);
  });

  it("clears claim on task completion", () => {
    const config = makeConfig();
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
      claimedTasks: new Set(["001"]),
    });

    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    detectCompletions(config, state, [task], panes);

    assert.ok(!state.claimedTasks.has("001"));
  });

  it("releases claim when before_run hook fails", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    mkdirSync(join(tmpDir, ".worktrees", "001-test-task"), { recursive: true });

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    const config = makeConfig({ beforeRun: "false" });
    const state = makeState();

    dispatch(config, state, [task], panes);

    // Claim should be released so the task can be retried
    assert.ok(!state.claimedTasks.has("001"));
  });
});

describe("cleanupOnDone", () => {
  it("calls removeWorktree when cleanupOnDone is true", () => {
    const wtDir = join(tmpDir, ".worktrees", "001-test-task");
    mkdirSync(wtDir, { recursive: true });

    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeConfig({ cleanupOnDone: true });
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    // Should have called git worktree remove
    const removeCall = gitCalls.find(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    assert.ok(removeCall, "expected git worktree remove call");
    assert.ok(removeCall!.args.includes(wtDir));
  });

  it("does not call removeWorktree when cleanupOnDone is false", () => {
    const wtDir = join(tmpDir, ".worktrees", "001-test-task");
    mkdirSync(wtDir, { recursive: true });

    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeConfig({ cleanupOnDone: false });
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    const removeCall = gitCalls.find(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    assert.strictEqual(removeCall, undefined);
  });
});

describe("createOrchestrator timer", () => {
  it("auto-assigns a task within poll interval", async () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    // Set up mock panes for listSessionPanes
    mockPanes = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];

    const config = makeConfig({ pollInterval: 50, masterPane: null });

    const stop = createOrchestrator(config);

    // Wait for a few ticks
    await new Promise((resolve) => setTimeout(resolve, 200));

    stop();

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.status, "in-progress");
    assert.strictEqual(loaded?.assignee, "Agent 1");
  });

  it("stops polling when returned function is called", async () => {
    mockPanes = [];

    const config = makeConfig({ pollInterval: 50 });

    const stop = createOrchestrator(config);
    stop();

    // Create a task after stopping — it should not be assigned
    const task = makeTask();
    saveTask(tmpDir, task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.status, "todo");
    assert.strictEqual(loaded?.assignee, null);
  });
});

describe("dispatch with version-string agent", () => {
  it("assigns task to agent reporting version string as command", () => {
    const task = makeTask();
    saveTask(tmpDir, task);
    mkdirSync(join(tmpDir, ".worktrees", "001-test-task"), { recursive: true });

    // Simulate Claude Code showing version as command
    const panes: PaneInfo[] = [
      makePane({ id: "%1", title: "Claude Code", currentCommand: "2.1.80" }),
    ];
    mockPanes = panes;

    const config = makeConfig({ masterPane: null });
    const state = makeState();

    dispatch(config, state, [task], panes);

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.assignee, "Claude Code");
    assert.strictEqual(loaded?.status, "in-progress");
  });

  it("does not assign to busy agent with spinner", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [
      makePane({ id: "%1", title: "⠙ Thinking...", currentCommand: "2.1.80" }),
    ];
    mockPanes = panes;

    const config = makeConfig({ masterPane: null });
    const state = makeState();

    dispatch(config, state, [task], panes);

    const loaded = loadTask(tmpDir, "001");
    assert.strictEqual(loaded?.assignee, null);
    assert.strictEqual(loaded?.status, "todo");
  });
});

describe("reloadConfig", () => {
  it("updates pollInterval", () => {
    const config = makeConfig({ pollInterval: 5000 });
    reloadConfig(config, { pollInterval: 1000 });
    assert.strictEqual(config.pollInterval, 1000);
  });

  it("updates stallTimeout", () => {
    const config = makeConfig({ stallTimeout: 300000 });
    reloadConfig(config, { stallTimeout: 60000 });
    assert.strictEqual(config.stallTimeout, 60000);
  });

  it("updates maxConcurrentAgents", () => {
    const config = makeConfig();
    reloadConfig(config, { maxConcurrentAgents: 3 });
    assert.strictEqual(config.maxConcurrentAgents, 3);
  });

  it("updates multiple fields at once", () => {
    const config = makeConfig();
    reloadConfig(config, {
      pollInterval: 2000,
      stallTimeout: 120000,
      autoDispatch: false,
      cleanupOnDone: true,
    });
    assert.strictEqual(config.pollInterval, 2000);
    assert.strictEqual(config.stallTimeout, 120000);
    assert.strictEqual(config.autoDispatch, false);
    assert.strictEqual(config.cleanupOnDone, true);
  });

  it("preserves fields not in the patch", () => {
    const config = makeConfig({ pollInterval: 5000, stallTimeout: 300000 });
    reloadConfig(config, { pollInterval: 1000 });
    assert.strictEqual(config.stallTimeout, 300000); // unchanged
    assert.strictEqual(config.session, "test"); // unchanged
  });
});

describe("event logging integration", () => {
  it("logs dispatch events", () => {
    const task = makeTask();
    saveTask(tmpDir, task);
    mkdirSync(join(tmpDir, ".worktrees", "001-test-task"), { recursive: true });

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    const config = makeConfig({ masterPane: null });
    const state = makeState();

    dispatch(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const dispatchEvent = events.find((e) => e.type === "dispatch");
    assert.ok(dispatchEvent);
    assert.strictEqual(dispatchEvent!.taskId, "001");
    assert.strictEqual(dispatchEvent!.agent, "Agent 1");
    assert.ok(dispatchEvent!.message.includes("Test task"));
  });

  it("logs stall events", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });
    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1" })];

    const config = makeConfig({ stallTimeout: 1000 });
    const state = makeState({
      lastActivity: new Map([["%1", Date.now() - 2000]]),
    });

    detectStalls(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const stallEvent = events.find((e) => e.type === "stall");
    assert.ok(stallEvent);
    assert.strictEqual(stallEvent!.taskId, "001");
    assert.strictEqual(stallEvent!.agent, "Agent 1");
  });

  it("logs completion events", () => {
    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });
    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeConfig();
    const state = makeState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const completionEvent = events.find((e) => e.type === "completion");
    assert.ok(completionEvent);
    assert.strictEqual(completionEvent!.taskId, "001");
    assert.strictEqual(completionEvent!.agent, "Agent 1");
  });

  it("logs reconcile events when agent vanishes", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });
    saveTask(tmpDir, task);

    // No panes — agent has vanished
    const panes: PaneInfo[] = [];

    const config = makeConfig();
    const state = makeState();

    reconcile(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const reconcileEvent = events.find((e) => e.type === "reconcile");
    assert.ok(reconcileEvent);
    assert.strictEqual(reconcileEvent!.taskId, "001");
    assert.strictEqual(reconcileEvent!.agent, "Agent 1");
    assert.ok(reconcileEvent!.message.includes("vanished"));
  });
});

describe("saveOrchestratorState / loadOrchestratorState", () => {
  it("round-trips claimed tasks and claim times", () => {
    const state = makeState({
      claimedTasks: new Set(["001", "003"]),
      taskClaimTimes: new Map([
        ["001", 1700000000000],
        ["003", 1700000060000],
      ]),
    });

    saveOrchestratorState(tmpDir, state);

    const restored = makeState();
    loadOrchestratorState(tmpDir, restored);

    assert.ok(restored.claimedTasks.has("001"));
    assert.ok(restored.claimedTasks.has("003"));
    assert.strictEqual(restored.taskClaimTimes.get("001"), 1700000000000);
    assert.strictEqual(restored.taskClaimTimes.get("003"), 1700000060000);
  });

  it("handles missing state file gracefully", () => {
    const state = makeState();
    loadOrchestratorState(tmpDir, state);
    assert.strictEqual(state.claimedTasks.size, 0);
    assert.strictEqual(state.taskClaimTimes.size, 0);
  });

  it("handles corrupted state file gracefully", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    writeFileSync(join(tmpDir, ".tasks", "orchestrator-state.json"), "not json");

    const state = makeState();
    loadOrchestratorState(tmpDir, state);
    assert.strictEqual(state.claimedTasks.size, 0);
  });
});

describe("gracefulShutdown", () => {
  it("releases in-progress tasks back to todo", () => {
    const task = makeTask({
      status: "in-progress",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });
    saveTask(tmpDir, task);

    const config = makeConfig({ cleanupOnDone: false });
    const state = makeState({
      claimedTasks: new Set(["001"]),
    });

    gracefulShutdown(config, state);

    const loaded = loadTask(tmpDir, "001")!;
    assert.strictEqual(loaded.status, "todo");
    assert.strictEqual(loaded.assignee, null);
  });

  it("saves orchestrator state to disk", () => {
    saveTask(tmpDir, makeTask());

    const config = makeConfig();
    const state = makeState({
      claimedTasks: new Set(["002"]),
      taskClaimTimes: new Map([["002", Date.now()]]),
    });

    gracefulShutdown(config, state);

    assert.ok(existsSync(join(tmpDir, ".tasks", "orchestrator-state.json")));

    const restored = makeState();
    loadOrchestratorState(tmpDir, restored);
    assert.ok(restored.claimedTasks.has("002"));
  });

  it("cleans worktrees when cleanupOnDone is true", () => {
    const wtDir = join(tmpDir, ".worktrees", "001-test-task");
    mkdirSync(wtDir, { recursive: true });

    const task = makeTask({
      status: "in-progress",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });
    saveTask(tmpDir, task);

    const config = makeConfig({ cleanupOnDone: true });
    const state = makeState();

    gracefulShutdown(config, state);

    const removeCall = gitCalls.find(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    assert.ok(removeCall);
  });

  it("does not clean worktrees when cleanupOnDone is false", () => {
    const task = makeTask({
      status: "in-progress",
      assignee: "Agent 1",
      branch: "task/001-test-task",
    });
    saveTask(tmpDir, task);

    const config = makeConfig({ cleanupOnDone: false });
    const state = makeState();

    gracefulShutdown(config, state);

    const removeCall = gitCalls.find(
      (c) => c.args[0] === "worktree" && c.args[1] === "remove",
    );
    assert.strictEqual(removeCall, undefined);
  });

  it("leaves done and todo tasks untouched", () => {
    const done = makeTask({ id: "001", status: "done", assignee: "Agent 1" });
    const todo = makeTask({ id: "002", status: "todo", assignee: null });
    saveTask(tmpDir, done);
    saveTask(tmpDir, todo);

    const config = makeConfig();
    const state = makeState();

    gracefulShutdown(config, state);

    assert.strictEqual(loadTask(tmpDir, "001")!.status, "done");
    assert.strictEqual(loadTask(tmpDir, "002")!.status, "todo");
  });
});
