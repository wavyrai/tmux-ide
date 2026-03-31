import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatch,
  detectStalls,
  detectCompletions,
  buildTaskPrompt,
  buildGoalPrompt,
  runHook,
  createOrchestrator,
  isAgentPane,
  isAgentBusy,
  isIdleForDispatch,
  saveOrchestratorState,
  loadOrchestratorState,
  syncClaims,
  gracefulShutdown,
  reloadConfig,
  reconcile,
  agentIdentifier,
  normalizePaneTitle,
  getPaneSpecialties,
  dispatchGoals,
} from "./orchestrator.ts";
import { readEvents } from "./event-log.ts";
import {
  ensureTasksDir,
  saveMission,
  saveGoal,
  saveTask,
  loadTask,
  loadGoal,
  type Goal,
} from "./task-store.ts";
import { _setExecutor, type PaneInfo } from "../widgets/lib/pane-comms.ts";
import {
  makeTask,
  makePane,
  makeOrchestratorConfig,
  makeOrchestratorState,
} from "../__tests__/support.ts";

let tmpDir: string;
let restoreTmux: () => void;
let tmuxCalls: { args: string[] }[];
let mockPanes: PaneInfo[];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-orch-test-"));
  ensureTasksDir(tmpDir);
  tmuxCalls = [];
  mockPanes = [];

  restoreTmux = _setExecutor((_cmd: string, args: string[]) => {
    tmuxCalls.push({ args });
    // Mock list-panes to return mockPanes as tab-separated output
    if (args[0] === "list-panes") {
      return mockPanes
        .map(
          (p) =>
            `${p.id}\t${p.index}\t${p.title}\t${p.currentCommand}\t${p.width}\t${p.height}\t${p.active ? "1" : "0"}\t${p.role ?? ""}\t${p.name ?? ""}\t${p.type ?? ""}`,
        )
        .join("\n");
    }
    return "";
  });
});

afterEach(() => {
  restoreTmux();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dispatch", () => {
  it("assigns highest-priority task to idle agent", () => {
    const task1 = makeTask({ id: "001", title: "Low priority", priority: 2 });
    const task2 = makeTask({ id: "002", title: "High priority", priority: 1 });
    saveTask(tmpDir, task1);
    saveTask(tmpDir, task2);

    const pane = makePane({ id: "%1", index: 0, title: "Agent 1", currentCommand: "zsh" });
    const expectedName = agentIdentifier(pane);
    const panes: PaneInfo[] = [pane];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    dispatch(config, state, [task1, task2], panes);

    // Task 002 (higher priority) should be assigned first
    const assigned = loadTask(tmpDir, "002");
    expect(assigned?.assignee).toBe(expectedName);
    expect(assigned?.status).toBe("in-progress");
  });

  it("skips master pane", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const agentPane = makePane({ id: "%1", index: 1, title: "Agent 1", currentCommand: "zsh" });
    const expectedName = agentIdentifier(agentPane);
    const panes: PaneInfo[] = [
      makePane({ id: "%0", index: 0, title: "Master", currentCommand: "zsh", role: "lead" }),
      agentPane,
    ];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    const assigned = loadTask(tmpDir, "001");
    expect(assigned?.assignee).toBe(expectedName);
  });

  it("does not assign when no idle agents", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    // Agent pane is busy (spinner in title indicates active work)
    const panes: PaneInfo[] = [
      makePane({ id: "%1", title: "⠙ Agent 1", currentCommand: "claude" }),
    ];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    const notAssigned = loadTask(tmpDir, "001");
    expect(notAssigned?.assignee).toBe(null);
  });

  it("does not assign when no todo tasks", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [makePane({ id: "%2", title: "Agent 2", currentCommand: "zsh" })];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    // No send-keys calls for Agent 2
    const sendCalls = tmuxCalls.filter(
      (c) => c.args.includes("send-keys") && c.args.includes("%2"),
    );
    expect(sendCalls.length).toBe(0);
  });
});

describe("detectStalls", () => {
  it("sends nudge after timeout", () => {
    const pane = makePane({ id: "%1", index: 0, title: "Agent 1" });
    const name = agentIdentifier(pane);
    const task = makeTask({ status: "in-progress", assignee: name });

    const panes: PaneInfo[] = [pane];

    const config = makeOrchestratorConfig(tmpDir, { stallTimeout: 1000 });
    const state = makeOrchestratorState({
      lastActivity: new Map([["%1", Date.now() - 2000]]),
    });

    detectStalls(config, state, [task], panes);

    // Should have sent a nudge via send-keys
    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    expect(sendCalls.length > 0).toBeTruthy();
  });

  it("does not nudge before timeout", () => {
    const pane = makePane({ id: "%1", index: 0, title: "Agent 1" });
    const name = agentIdentifier(pane);
    const task = makeTask({ status: "in-progress", assignee: name });

    const panes: PaneInfo[] = [pane];

    const config = makeOrchestratorConfig(tmpDir, { stallTimeout: 300000 });
    const state = makeOrchestratorState({
      lastActivity: new Map([["%1", Date.now()]]),
    });

    detectStalls(config, state, [task], panes);

    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    expect(sendCalls.length).toBe(0);
  });
});

describe("detectCompletions", () => {
  it("notifies master when task goes from in-progress to done", () => {
    const task = makeTask({ status: "done", assignee: "Agent 1", proof: { notes: "tests pass" } });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    // Should have sent notification to master
    const sendCalls = tmuxCalls.filter(
      (c) => c.args.includes("send-keys") && c.args.includes("%0"),
    );
    expect(sendCalls.length > 0).toBeTruthy();
  });

  it("does not notify when task was already done", () => {
    const task = makeTask({ status: "done" });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState({
      previousTasks: new Map([["001", "done"]]),
    });

    detectCompletions(config, state, [task], panes);

    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    expect(sendCalls.length).toBe(0);
  });
});

describe("buildTaskPrompt", () => {
  it("includes mission + goal + task context", () => {
    saveMission(tmpDir, {
      title: "Build auth",
      description: "Before Q2 audit",
      status: "active",
      branch: null,
      milestones: [],
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
      assignee: null,
      specialty: null,
      milestone: null,
    });

    const task = makeTask({
      title: "Fix middleware",
      goal: "01",
      tags: ["security"],
      priority: 1,
    });

    const prompt = buildTaskPrompt(tmpDir, task);

    expect(prompt.includes("Mission: Build auth")).toBeTruthy();
    expect(prompt.includes("Goal: Token storage")).toBeTruthy();
    expect(prompt.includes("Acceptance: All tokens encrypted")).toBeTruthy();
    expect(prompt.includes("Your Task: Fix middleware")).toBeTruthy();
    expect(prompt.includes("Priority: P1")).toBeTruthy();
    expect(prompt.includes("Tags: security")).toBeTruthy();
    expect(prompt.includes(`Workspace: ${tmpDir}`)).toBeTruthy();
    expect(prompt.includes("tmux-ide task done 001")).toBeTruthy();
  });

  it("works without mission or goal", () => {
    const task = makeTask({ title: "Standalone task" });
    const prompt = buildTaskPrompt(tmpDir, task);
    expect(prompt.includes("Your Task: Standalone task")).toBeTruthy();
    expect(!prompt.includes("Mission:")).toBeTruthy();
    expect(!prompt.includes("Goal:")).toBeTruthy();
  });
});

describe("runHook", () => {
  it("returns ok:true for successful command", () => {
    const result = runHook("true", tmpDir);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:false with error for failing command", () => {
    const result = runHook("false", tmpDir);
    expect(result.ok).toBe(false);
    expect("error" in result && result.error.length > 0).toBeTruthy();
  });

  it("runs command in the specified cwd", () => {
    // Create a marker file, then check it exists via the hook
    writeFileSync(join(tmpDir, "marker.txt"), "hello");
    const result = runHook("test -f marker.txt", tmpDir);
    expect(result).toEqual({ ok: true });
  });

  it("fails when cwd does not contain expected file", () => {
    const result = runHook("test -f nonexistent.txt", tmpDir);
    expect(result.ok).toBe(false);
  });
});

describe("dispatch with hooks", () => {
  it("skips task when before_run fails", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    // before_run that always fails
    const config = makeOrchestratorConfig(tmpDir, { beforeRun: "false" });
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    // Task should NOT be assigned
    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.assignee).toBe(null);
    expect(loaded?.status).toBe("todo");
  });

  it("dispatches task when before_run succeeds", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const pane = makePane({ id: "%1", index: 0, title: "Agent 1", currentCommand: "zsh" });
    const expectedName = agentIdentifier(pane);
    const panes: PaneInfo[] = [pane];
    mockPanes = panes;

    // before_run that always succeeds
    const config = makeOrchestratorConfig(tmpDir, { beforeRun: "true" });
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.assignee).toBe(expectedName);
    expect(loaded?.status).toBe("in-progress");
  });
});

describe("detectCompletions with after_run", () => {
  it("runs after_run hook when task completes", () => {
    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    // after_run creates a marker file — proves it ran in the project dir
    const config = makeOrchestratorConfig(tmpDir, { afterRun: "touch after_run_marker" });
    const state = makeOrchestratorState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    expect(existsSync(join(tmpDir, "after_run_marker"))).toBeTruthy();
  });

  it("does not crash when after_run fails", () => {
    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    // after_run that fails — should not throw
    const config = makeOrchestratorConfig(tmpDir, { afterRun: "false" });
    const state = makeOrchestratorState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    // Should not throw
    detectCompletions(config, state, [task], panes);

    // Master should still get notified despite hook failure
    const sendCalls = tmuxCalls.filter(
      (c) => c.args.includes("send-keys") && c.args.includes("%0"),
    );
    expect(sendCalls.length > 0).toBeTruthy();
  });
});

describe("isAgentPane", () => {
  it("detects claude command", () => {
    expect(isAgentPane(makePane({ currentCommand: "claude" }))).toBeTruthy();
  });

  it("detects codex command", () => {
    expect(isAgentPane(makePane({ currentCommand: "codex" }))).toBeTruthy();
  });

  it("detects Claude Code via version string + title", () => {
    expect(isAgentPane(makePane({ currentCommand: "2.1.80", title: "Claude Code" }))).toBeTruthy();
  });

  it("detects Claude Code via title pattern", () => {
    expect(isAgentPane(makePane({ currentCommand: "node", title: "Claude Code" }))).toBeTruthy();
  });

  it("does not match a plain shell", () => {
    expect(!isAgentPane(makePane({ currentCommand: "zsh", title: "Shell" }))).toBeTruthy();
  });

  it("matches version string regardless of title (Claude Code reports version as command)", () => {
    expect(isAgentPane(makePane({ currentCommand: "2.1.80", title: "Dev Server" }))).toBeTruthy();
  });
});

describe("isAgentBusy", () => {
  it("returns true when spinner in title", () => {
    expect(isAgentBusy(makePane({ title: "⠙ Working..." }))).toBeTruthy();
  });

  it("returns false for normal title", () => {
    expect(!isAgentBusy(makePane({ title: "Claude Code" }))).toBeTruthy();
  });
});

describe("isIdleForDispatch", () => {
  it("returns true for shell command", () => {
    expect(isIdleForDispatch(makePane({ currentCommand: "zsh" }))).toBeTruthy();
    expect(isIdleForDispatch(makePane({ currentCommand: "bash" }))).toBeTruthy();
    expect(isIdleForDispatch(makePane({ currentCommand: "fish" }))).toBeTruthy();
  });

  it("returns true for agent pane without spinner", () => {
    expect(
      isIdleForDispatch(makePane({ currentCommand: "claude", title: "Agent 1" })),
    ).toBeTruthy();
  });

  it("returns true for Claude with version command and no spinner", () => {
    expect(
      isIdleForDispatch(makePane({ currentCommand: "2.1.80", title: "Claude Code" })),
    ).toBeTruthy();
  });

  it("returns false for agent pane with spinner", () => {
    expect(
      !isIdleForDispatch(makePane({ currentCommand: "claude", title: "⠹ Thinking..." })),
    ).toBeTruthy();
  });

  it("returns false for non-agent non-shell command", () => {
    expect(!isIdleForDispatch(makePane({ currentCommand: "vim", title: "Editor" }))).toBeTruthy();
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

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    // First dispatch claims the task
    dispatch(config, state, [task], panes);
    expect(state.claimedTasks.has("001")).toBeTruthy();

    // Reset task to todo to simulate a race (file not yet updated)
    const raceTask = makeTask({ status: "todo", assignee: null });

    // Second dispatch should skip claimed task
    dispatch(config, state, [raceTask], panes);

    // Only one send-keys call with the task prompt (not two)
    const sendCalls = tmuxCalls.filter((c) => c.args.includes("send-keys"));
    // First dispatch: send-keys text + send-keys Enter = 2 calls
    expect(sendCalls.length).toBe(2);
  });

  it("clears claim on task completion", () => {
    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState({
      previousTasks: new Map([["001", "in-progress"]]),
      claimedTasks: new Set(["001"]),
    });

    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
    });

    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    detectCompletions(config, state, [task], panes);

    expect(!state.claimedTasks.has("001")).toBeTruthy();
  });

  it("releases claim when before_run hook fails", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [makePane({ id: "%1", title: "Agent 1", currentCommand: "zsh" })];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir, { beforeRun: "false" });
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    // Claim should be released so the task can be retried
    expect(!state.claimedTasks.has("001")).toBeTruthy();
  });
});


describe("createOrchestrator timer", () => {
  it("auto-assigns a task within poll interval", async () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const pane = makePane({ id: "%1", index: 0, title: "Agent 1", currentCommand: "zsh" });
    const expectedName = agentIdentifier(pane);
    mockPanes = [pane];

    const config = makeOrchestratorConfig(tmpDir, { pollInterval: 50, masterPane: null });

    const stop = createOrchestrator(config);

    // Wait for a few ticks
    await new Promise((resolve) => setTimeout(resolve, 200));

    stop();

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.status).toBe("in-progress");
    expect(loaded?.assignee).toBe(expectedName);
  });

  it("stops polling when returned function is called", async () => {
    mockPanes = [];

    const config = makeOrchestratorConfig(tmpDir, { pollInterval: 50 });

    const stop = createOrchestrator(config);
    stop();

    // Create a task after stopping — it should not be assigned
    const task = makeTask();
    saveTask(tmpDir, task);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.status).toBe("todo");
    expect(loaded?.assignee).toBe(null);
  });
});

describe("dispatch with version-string agent", () => {
  it("assigns task to agent reporting version string as command", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    // Simulate Claude Code showing version as command
    const pane = makePane({ id: "%1", index: 0, title: "Claude Code", currentCommand: "2.1.80" });
    const expectedName = agentIdentifier(pane);
    const panes: PaneInfo[] = [pane];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir, { masterPane: null });
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.assignee).toBe(expectedName);
    expect(loaded?.status).toBe("in-progress");
  });

  it("does not assign to busy agent with spinner", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const panes: PaneInfo[] = [
      makePane({ id: "%1", title: "⠙ Thinking...", currentCommand: "2.1.80" }),
    ];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir, { masterPane: null });
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.assignee).toBe(null);
    expect(loaded?.status).toBe("todo");
  });
});

describe("reloadConfig", () => {
  it("updates pollInterval", () => {
    const config = makeOrchestratorConfig(tmpDir, { pollInterval: 5000 });
    reloadConfig(config, { pollInterval: 1000 });
    expect(config.pollInterval).toBe(1000);
  });

  it("updates stallTimeout", () => {
    const config = makeOrchestratorConfig(tmpDir, { stallTimeout: 300000 });
    reloadConfig(config, { stallTimeout: 60000 });
    expect(config.stallTimeout).toBe(60000);
  });

  it("updates maxConcurrentAgents", () => {
    const config = makeOrchestratorConfig(tmpDir);
    reloadConfig(config, { maxConcurrentAgents: 3 });
    expect(config.maxConcurrentAgents).toBe(3);
  });

  it("updates multiple fields at once", () => {
    const config = makeOrchestratorConfig(tmpDir);
    reloadConfig(config, {
      pollInterval: 2000,
      stallTimeout: 120000,
      autoDispatch: false,
    });
    expect(config.pollInterval).toBe(2000);
    expect(config.stallTimeout).toBe(120000);
    expect(config.autoDispatch).toBe(false);
  });

  it("preserves fields not in the patch", () => {
    const config = makeOrchestratorConfig(tmpDir, { pollInterval: 5000, stallTimeout: 300000 });
    reloadConfig(config, { pollInterval: 1000 });
    expect(config.stallTimeout).toBe(300000); // unchanged
    expect(config.session).toBe("test"); // unchanged
  });
});

describe("event logging integration", () => {
  it("logs dispatch events", () => {
    const task = makeTask();
    saveTask(tmpDir, task);

    const pane = makePane({ id: "%1", index: 0, title: "Agent 1", currentCommand: "zsh" });
    const panes: PaneInfo[] = [pane];
    mockPanes = panes;

    const config = makeOrchestratorConfig(tmpDir, { masterPane: null });
    const state = makeOrchestratorState();

    dispatch(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const dispatchEvent = events.find((e) => e.type === "dispatch");
    expect(dispatchEvent).toBeTruthy();
    expect(dispatchEvent!.taskId).toBe("001");
    expect(dispatchEvent!.agent).toBe(pane.title);
    expect(dispatchEvent!.message.includes("Test task")).toBeTruthy();
  });

  it("logs stall events", () => {
    const pane = makePane({ id: "%1", index: 0, title: "Agent 1" });
    const name = agentIdentifier(pane);
    const task = makeTask({ status: "in-progress", assignee: name });
    const panes: PaneInfo[] = [pane];

    const config = makeOrchestratorConfig(tmpDir, { stallTimeout: 1000 });
    const state = makeOrchestratorState({
      lastActivity: new Map([["%1", Date.now() - 2000]]),
    });

    detectStalls(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const stallEvent = events.find((e) => e.type === "stall");
    expect(stallEvent).toBeTruthy();
    expect(stallEvent!.taskId).toBe("001");
    expect(stallEvent!.agent).toBe(name);
  });

  it("logs completion events", () => {
    const task = makeTask({
      status: "done",
      assignee: "Agent 1",
    });
    const panes: PaneInfo[] = [makePane({ id: "%0", title: "Master" })];

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState({
      previousTasks: new Map([["001", "in-progress"]]),
    });

    detectCompletions(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const completionEvent = events.find((e) => e.type === "completion");
    expect(completionEvent).toBeTruthy();
    expect(completionEvent!.taskId).toBe("001");
    expect(completionEvent!.agent).toBe("Agent 1");
  });

  it("logs reconcile events when agent vanishes", () => {
    const task = makeTask({ status: "in-progress", assignee: "Agent 1" });
    saveTask(tmpDir, task);

    // No panes — agent has vanished
    const panes: PaneInfo[] = [];

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    reconcile(config, state, [task], panes);

    const events = readEvents(tmpDir);
    const reconcileEvent = events.find((e) => e.type === "reconcile");
    expect(reconcileEvent).toBeTruthy();
    expect(reconcileEvent!.taskId).toBe("001");
    expect(reconcileEvent!.agent).toBe("Agent 1");
    expect(reconcileEvent!.message.includes("vanished")).toBeTruthy();
  });
});

describe("saveOrchestratorState / loadOrchestratorState", () => {
  it("round-trips claimed tasks and claim times", () => {
    const state = makeOrchestratorState({
      claimedTasks: new Set(["001", "003"]),
      taskClaimTimes: new Map([
        ["001", 1700000000000],
        ["003", 1700000060000],
      ]),
    });

    saveOrchestratorState(tmpDir, state);

    const restored = makeOrchestratorState();
    loadOrchestratorState(tmpDir, restored);

    expect(restored.claimedTasks.has("001")).toBeTruthy();
    expect(restored.claimedTasks.has("003")).toBeTruthy();
    expect(restored.taskClaimTimes.get("001")).toBe(1700000000000);
    expect(restored.taskClaimTimes.get("003")).toBe(1700000060000);
  });

  it("handles missing state file gracefully", () => {
    const state = makeOrchestratorState();
    loadOrchestratorState(tmpDir, state);
    expect(state.claimedTasks.size).toBe(0);
    expect(state.taskClaimTimes.size).toBe(0);
  });

  it("handles corrupted state file gracefully", () => {
    mkdirSync(join(tmpDir, ".tasks"), { recursive: true });
    writeFileSync(join(tmpDir, ".tasks", "orchestrator-state.json"), "not json");

    const state = makeOrchestratorState();
    loadOrchestratorState(tmpDir, state);
    expect(state.claimedTasks.size).toBe(0);
  });
});

describe("syncClaims", () => {
  it("removes stale claims for tasks no longer in-progress", () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "done", assignee: "Agent 1" }));
    saveTask(tmpDir, makeTask({ id: "002", status: "todo" }));
    saveTask(tmpDir, makeTask({ id: "003", status: "in-progress", assignee: "Agent 2" }));

    const state = makeOrchestratorState({
      claimedTasks: new Set(["001", "002", "003"]),
    });

    syncClaims(tmpDir, state);

    expect(!state.claimedTasks.has("001")).toBeTruthy();
    expect(!state.claimedTasks.has("002")).toBeTruthy();
    expect(state.claimedTasks.has("003")).toBeTruthy();
  });

  it("adds missing claims for in-progress tasks", () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "in-progress", assignee: "Agent 1" }));
    saveTask(tmpDir, makeTask({ id: "002", status: "in-progress", assignee: "Agent 2" }));

    const state = makeOrchestratorState({
      claimedTasks: new Set(),
    });

    syncClaims(tmpDir, state);

    expect(state.claimedTasks.has("001")).toBeTruthy();
    expect(state.claimedTasks.has("002")).toBeTruthy();
  });

  it("rebuilds claims from mixed task statuses", () => {
    saveTask(tmpDir, makeTask({ id: "001", status: "done", assignee: "Agent 1" }));
    saveTask(tmpDir, makeTask({ id: "002", status: "in-progress", assignee: "Agent 2" }));
    saveTask(tmpDir, makeTask({ id: "003", status: "todo" }));
    saveTask(tmpDir, makeTask({ id: "004", status: "in-progress", assignee: "Agent 3" }));
    saveTask(tmpDir, makeTask({ id: "005", status: "review", assignee: "Agent 1" }));

    // Stale state: claims 001 (done) and 003 (todo), missing 004 (in-progress)
    const state = makeOrchestratorState({
      claimedTasks: new Set(["001", "003"]),
    });

    syncClaims(tmpDir, state);

    expect(state.claimedTasks.size).toBe(2);
    expect(state.claimedTasks.has("002")).toBeTruthy();
    expect(state.claimedTasks.has("004")).toBeTruthy();
    expect(!state.claimedTasks.has("001")).toBeTruthy();
    expect(!state.claimedTasks.has("003")).toBeTruthy();
    expect(!state.claimedTasks.has("005")).toBeTruthy();
  });

  it("handles empty task store", () => {
    const state = makeOrchestratorState({
      claimedTasks: new Set(["001", "002"]),
    });

    syncClaims(tmpDir, state);

    expect(state.claimedTasks.size).toBe(0);
  });
});

describe("gracefulShutdown", () => {
  it("releases in-progress tasks back to todo", () => {
    const task = makeTask({
      status: "in-progress",
      assignee: "Agent 1",
    });
    saveTask(tmpDir, task);

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState({
      claimedTasks: new Set(["001"]),
    });

    gracefulShutdown(config, state);

    const loaded = loadTask(tmpDir, "001")!;
    expect(loaded.status).toBe("todo");
    expect(loaded.assignee).toBe(null);
  });

  it("saves orchestrator state to disk", () => {
    saveTask(tmpDir, makeTask());

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState({
      claimedTasks: new Set(["002"]),
      taskClaimTimes: new Map([["002", Date.now()]]),
    });

    gracefulShutdown(config, state);

    expect(existsSync(join(tmpDir, ".tasks", "orchestrator-state.json"))).toBeTruthy();

    const restored = makeOrchestratorState();
    loadOrchestratorState(tmpDir, restored);
    expect(restored.claimedTasks.has("002")).toBeTruthy();
  });

  it("leaves done and todo tasks untouched", () => {
    const done = makeTask({ id: "001", status: "done", assignee: "Agent 1" });
    const todo = makeTask({ id: "002", status: "todo", assignee: null });
    saveTask(tmpDir, done);
    saveTask(tmpDir, todo);

    const config = makeOrchestratorConfig(tmpDir);
    const state = makeOrchestratorState();

    gracefulShutdown(config, state);

    expect(loadTask(tmpDir, "001")!.status).toBe("done");
    expect(loadTask(tmpDir, "002")!.status).toBe("todo");
  });
});

describe("normalizePaneTitle", () => {
  it("strips spinner prefix from pane title", () => {
    expect(normalizePaneTitle("⠂ Claude Code")).toBe("Claude Code");
    expect(normalizePaneTitle("⠋ Working...")).toBe("Working...");
    expect(normalizePaneTitle("✳ Claude Code")).toBe("Claude Code");
    expect(normalizePaneTitle("◐ Thinking")).toBe("Thinking");
  });

  it("returns title unchanged when no spinner prefix", () => {
    expect(normalizePaneTitle("Agent 1")).toBe("Agent 1");
    expect(normalizePaneTitle("Claude Code")).toBe("Claude Code");
  });

  it("handles empty string", () => {
    expect(normalizePaneTitle("")).toBe("");
  });
});

describe("getPaneSpecialties", () => {
  it("returns specialties from config map", () => {
    const config = makeOrchestratorConfig(tmpDir, {
      paneSpecialties: new Map([["Frontend Agent", ["frontend", "css", "react"]]]),
    });
    const pane = makePane({ title: "Frontend Agent" });
    const specs = getPaneSpecialties(config, pane);
    expect(specs).toEqual(["frontend", "css", "react"]);
  });

  it("returns empty array for pane with no specialties", () => {
    const config = makeOrchestratorConfig(tmpDir, { paneSpecialties: new Map() });
    const pane = makePane({ title: "Generic Agent" });
    const specs = getPaneSpecialties(config, pane);
    expect(specs).toEqual([]);
  });

  it("matches by pane title", () => {
    const config = makeOrchestratorConfig(tmpDir, {
      paneSpecialties: new Map([
        ["Backend", ["api", "database"]],
        ["Frontend", ["ui", "css"]],
      ]),
    });
    expect(getPaneSpecialties(config, makePane({ title: "Backend" }))).toEqual(["api", "database"]);
    expect(getPaneSpecialties(config, makePane({ title: "Frontend" }))).toEqual(["ui", "css"]);
    expect(getPaneSpecialties(config, makePane({ title: "Other" }))).toEqual([]);
  });
});

describe("buildGoalPrompt", () => {
  it("includes goal title, acceptance criteria, and planner name", () => {
    saveMission(tmpDir, {
      title: "Ship v2",
      description: "Major release",
      status: "active",
      branch: null,
      milestones: [],
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });

    const goal: Goal = {
      id: "01",
      title: "Build REST API",
      description: "Create CRUD endpoints",
      status: "todo",
      acceptance: "All endpoints return 200 with correct data",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: "backend",
    };

    const planner = makePane({ id: "%2", index: 1, title: "Backend Planner" });
    const prompt = buildGoalPrompt(tmpDir, goal, planner);

    expect(prompt.includes("Build REST API")).toBeTruthy();
    expect(prompt.includes("All endpoints return 200 with correct data")).toBeTruthy();
    expect(prompt.includes("backend planner")).toBeTruthy();
    expect(prompt.includes("Ship v2")).toBeTruthy();
    expect(prompt.includes(agentIdentifier(planner))).toBeTruthy();
  });

  it("works without mission", () => {
    const goal: Goal = {
      id: "01",
      title: "Setup CI",
      description: "",
      status: "todo",
      acceptance: "CI passes",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    };

    const planner = makePane({ id: "%1", index: 0 });
    const prompt = buildGoalPrompt(tmpDir, goal, planner);

    expect(prompt.includes("Setup CI")).toBeTruthy();
    expect(prompt.includes("general planner")).toBeTruthy();
    expect(!prompt.includes("Mission:")).toBeTruthy();
  });
});

describe("dispatchGoals", () => {
  it("assigns goal to idle planner pane", () => {
    const goal: Goal = {
      id: "01",
      title: "Build Frontend",
      description: "React components",
      status: "todo",
      acceptance: "UI renders",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    };
    saveGoal(tmpDir, goal);

    const planner = makePane({ id: "%2", index: 1, title: "Planner", currentCommand: "claude" });
    const config = makeOrchestratorConfig(tmpDir, {
      paneSpecialties: new Map([["Planner", ["frontend"]]]),
    });
    const state = makeOrchestratorState();

    dispatchGoals(config, state, [goal], [], [planner]);

    const updated = loadGoal(tmpDir, "01")!;
    expect(updated.status).toBe("in-progress");
    expect(updated.assignee).toBe(agentIdentifier(planner));

    const events = readEvents(tmpDir);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("dispatch");
    expect(events[0]!.message.includes("Build Frontend")).toBeTruthy();
  });

  it("skips master pane", () => {
    const goal: Goal = {
      id: "01",
      title: "Test Goal",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: null,
      specialty: null,
      milestone: null,
    };
    saveGoal(tmpDir, goal);

    // Only pane is the master — should not be used as planner
    const masterPane = makePane({
      id: "%1",
      index: 0,
      title: "Master",
      currentCommand: "claude",
      role: "lead",
    });
    const config = makeOrchestratorConfig(tmpDir, { masterPane: "Master" });
    const state = makeOrchestratorState();

    dispatchGoals(config, state, [goal], [], [masterPane]);

    const unchanged = loadGoal(tmpDir, "01")!;
    expect(unchanged.status).toBe("todo");
    expect(unchanged.assignee).toBe(null);
  });

  it("does not assign already-assigned goals", () => {
    const goal: Goal = {
      id: "01",
      title: "Already assigned",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      assignee: "Someone",
      specialty: null,
      milestone: null,
    };
    saveGoal(tmpDir, goal);

    const planner = makePane({ id: "%2", index: 1, title: "Planner", currentCommand: "claude" });
    const config = makeOrchestratorConfig(tmpDir, {
      paneSpecialties: new Map([["Planner", []]]),
    });
    const state = makeOrchestratorState();

    dispatchGoals(config, state, [goal], [], [planner]);

    // Goal should remain unchanged — assignee filter excludes it
    const events = readEvents(tmpDir);
    expect(events.length).toBe(0);
  });
});
