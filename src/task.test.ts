import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureTasksDir,
  loadMission,
  saveMission,
  clearMission,
  loadGoals,
  loadGoal,
  saveGoal,
  deleteGoal,
  nextGoalId,
  loadTasks,
  loadTask,
  saveTask,
  deleteTask,
  nextTaskId,
  loadTasksForGoal,
} from "./lib/task-store.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-task-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ensureTasksDir", () => {
  it("creates .tasks/, goals/, and tasks/ directories", () => {
    ensureTasksDir(tmpDir);
    assert.ok(existsSync(join(tmpDir, ".tasks")));
    assert.ok(existsSync(join(tmpDir, ".tasks", "goals")));
    assert.ok(existsSync(join(tmpDir, ".tasks", "tasks")));
  });

  it("is idempotent", () => {
    ensureTasksDir(tmpDir);
    ensureTasksDir(tmpDir);
    assert.ok(existsSync(join(tmpDir, ".tasks")));
  });
});

describe("mission", () => {
  it("returns null when no mission exists", () => {
    ensureTasksDir(tmpDir);
    assert.strictEqual(loadMission(tmpDir), null);
  });

  it("saves and loads a mission", () => {
    const mission = {
      title: "Ship the auth overhaul",
      description: "Before Q2 audit",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    };
    saveMission(tmpDir, mission);
    const loaded = loadMission(tmpDir);
    assert.deepStrictEqual(loaded, mission);
  });

  it("clears a mission", () => {
    saveMission(tmpDir, {
      title: "Test",
      description: "",
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    clearMission(tmpDir);
    assert.strictEqual(loadMission(tmpDir), null);
  });

  it("clear is safe when no mission exists", () => {
    ensureTasksDir(tmpDir);
    clearMission(tmpDir);
    assert.strictEqual(loadMission(tmpDir), null);
  });
});

describe("goals", () => {
  it("returns empty array when no goals exist", () => {
    ensureTasksDir(tmpDir);
    assert.deepStrictEqual(loadGoals(tmpDir), []);
  });

  it("auto-increments goal IDs", () => {
    ensureTasksDir(tmpDir);
    assert.strictEqual(nextGoalId(tmpDir), "01");
    saveGoal(tmpDir, {
      id: "01",
      title: "First goal",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    assert.strictEqual(nextGoalId(tmpDir), "02");
  });

  it("saves with slugified filename", () => {
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, {
      id: "01",
      title: "Replace Session Storage",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    const files = readdirSync(join(tmpDir, ".tasks", "goals"));
    assert.strictEqual(files.length, 1);
    assert.ok(files[0]!.startsWith("01-"));
    assert.ok(files[0]!.includes("replace-session-storage"));
  });

  it("loads a goal by ID", () => {
    ensureTasksDir(tmpDir);
    const goal = {
      id: "01",
      title: "Test Goal",
      description: "desc",
      status: "todo" as const,
      acceptance: "acc",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    };
    saveGoal(tmpDir, goal);
    assert.deepStrictEqual(loadGoal(tmpDir, "01"), goal);
  });

  it("returns null for non-existent goal", () => {
    ensureTasksDir(tmpDir);
    assert.strictEqual(loadGoal(tmpDir, "99"), null);
  });

  it("updates a goal in place", () => {
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, {
      id: "01",
      title: "Original",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    const goal = loadGoal(tmpDir, "01")!;
    goal.status = "done";
    goal.title = "Updated Title";
    saveGoal(tmpDir, goal);
    const files = readdirSync(join(tmpDir, ".tasks", "goals"));
    assert.strictEqual(files.length, 1); // no duplicate
    assert.strictEqual(loadGoal(tmpDir, "01")!.status, "done");
  });

  it("deletes a goal", () => {
    ensureTasksDir(tmpDir);
    saveGoal(tmpDir, {
      id: "01",
      title: "To Delete",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
    });
    assert.strictEqual(deleteGoal(tmpDir, "01"), true);
    assert.strictEqual(loadGoal(tmpDir, "01"), null);
  });

  it("returns false when deleting non-existent goal", () => {
    ensureTasksDir(tmpDir);
    assert.strictEqual(deleteGoal(tmpDir, "99"), false);
  });

  it("lists goals sorted by filename", () => {
    ensureTasksDir(tmpDir);
    const now = "2026-01-01T00:00:00Z";
    saveGoal(tmpDir, {
      id: "02",
      title: "Second",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 2,
      created: now,
      updated: now,
    });
    saveGoal(tmpDir, {
      id: "01",
      title: "First",
      description: "",
      status: "todo",
      acceptance: "",
      priority: 1,
      created: now,
      updated: now,
    });
    const goals = loadGoals(tmpDir);
    assert.strictEqual(goals.length, 2);
    assert.strictEqual(goals[0]!.id, "01");
    assert.strictEqual(goals[1]!.id, "02");
  });
});

describe("tasks", () => {
  it("returns empty array when no tasks exist", () => {
    ensureTasksDir(tmpDir);
    assert.deepStrictEqual(loadTasks(tmpDir), []);
  });

  it("auto-increments task IDs with 3-digit padding", () => {
    ensureTasksDir(tmpDir);
    assert.strictEqual(nextTaskId(tmpDir), "001");
    saveTask(tmpDir, {
      id: "001",
      title: "First task",
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
    });
    assert.strictEqual(nextTaskId(tmpDir), "002");
  });

  it("creates task with all fields", () => {
    ensureTasksDir(tmpDir);
    const task = {
      id: "001",
      title: "Fix auth middleware",
      description: "Token storage issue",
      goal: "01",
      status: "todo" as const,
      assignee: "Agent 1",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      branch: "fix/auth",
      tags: ["security", "compliance"],
      proof: null,
    };
    saveTask(tmpDir, task);
    assert.deepStrictEqual(loadTask(tmpDir, "001"), task);
  });

  it("loads tasks for a specific goal", () => {
    ensureTasksDir(tmpDir);
    const now = "2026-01-01T00:00:00Z";
    saveTask(tmpDir, {
      id: "001",
      title: "Task for goal 01",
      description: "",
      goal: "01",
      status: "todo",
      assignee: null,
      priority: 1,
      created: now,
      updated: now,
      branch: null,
      tags: [],
      proof: null,
    });
    saveTask(tmpDir, {
      id: "002",
      title: "Task for goal 02",
      description: "",
      goal: "02",
      status: "todo",
      assignee: null,
      priority: 1,
      created: now,
      updated: now,
      branch: null,
      tags: [],
      proof: null,
    });
    saveTask(tmpDir, {
      id: "003",
      title: "Another for goal 01",
      description: "",
      goal: "01",
      status: "done",
      assignee: null,
      priority: 2,
      created: now,
      updated: now,
      branch: null,
      tags: [],
      proof: null,
    });
    const goal01Tasks = loadTasksForGoal(tmpDir, "01");
    assert.strictEqual(goal01Tasks.length, 2);
    assert.ok(goal01Tasks.every((t) => t.goal === "01"));
  });

  it("deletes a task", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, {
      id: "001",
      title: "To Delete",
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
    });
    assert.strictEqual(deleteTask(tmpDir, "001"), true);
    assert.strictEqual(loadTask(tmpDir, "001"), null);
  });

  it("returns false when deleting non-existent task", () => {
    ensureTasksDir(tmpDir);
    assert.strictEqual(deleteTask(tmpDir, "999"), false);
  });

  it("updates task in place without duplicating file", () => {
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, {
      id: "001",
      title: "Original Title",
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
    });
    const task = loadTask(tmpDir, "001")!;
    task.title = "New Title";
    task.status = "in-progress";
    saveTask(tmpDir, task);
    const files = readdirSync(join(tmpDir, ".tasks", "tasks"));
    assert.strictEqual(files.length, 1);
    assert.strictEqual(loadTask(tmpDir, "001")!.title, "New Title");
  });
});
