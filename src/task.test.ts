import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  normalizeTask,
  normalizeGoal,
  normalizeMission,
  type Task,
} from "./lib/task-store.ts";
import { parseProof } from "./task.ts";

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
      assignee: null,
      specialty: null,
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
      assignee: null,
      specialty: null,
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
      assignee: null,
      specialty: null,
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
      assignee: null,
      specialty: null,
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
      assignee: null,
      specialty: null,
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
      assignee: null,
      specialty: null,
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
      assignee: null,
      specialty: null,
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
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
    });
    assert.strictEqual(nextTaskId(tmpDir), "002");
  });

  it("creates task with all fields including retry", () => {
    ensureTasksDir(tmpDir);
    const task: Task = {
      id: "001",
      title: "Fix auth middleware",
      description: "Token storage issue",
      goal: "01",
      status: "todo",
      assignee: "Agent 1",
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      branch: "fix/auth",
      tags: ["security", "compliance"],
      proof: null,
      retryCount: 2,
      maxRetries: 3,
      lastError: "timeout",
      nextRetryAt: "2026-01-02T00:00:00Z",
      depends_on: [],
    };
    saveTask(tmpDir, task);
    assert.deepStrictEqual(loadTask(tmpDir, "001"), task);
  });

  it("loads tasks for a specific goal", () => {
    ensureTasksDir(tmpDir);
    const now = "2026-01-01T00:00:00Z";
    const base = {
      description: "",
      assignee: null,
      priority: 1,
      created: now,
      updated: now,
      branch: null,
      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
    } as const;
    saveTask(tmpDir, { ...base, id: "001", title: "Task for goal 01", goal: "01", status: "todo" });
    saveTask(tmpDir, { ...base, id: "002", title: "Task for goal 02", goal: "02", status: "todo" });
    saveTask(tmpDir, {
      ...base,
      id: "003",
      title: "Another for goal 01",
      goal: "01",
      status: "done",
      priority: 2,
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
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
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
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
    });
    const task = loadTask(tmpDir, "001")!;
    task.title = "New Title";
    task.status = "in-progress";
    saveTask(tmpDir, task);
    const files = readdirSync(join(tmpDir, ".tasks", "tasks"));
    assert.strictEqual(files.length, 1);
    assert.strictEqual(loadTask(tmpDir, "001")!.title, "New Title");
  });

  it("applies retry defaults when loading legacy JSON without retry fields", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    // Write a legacy task JSON that has no retry fields
    const legacyTask = {
      id: "001",
      title: "Legacy task",
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
    };
    writeFileSync(join(tasksDir, "001-legacy-task.json"), JSON.stringify(legacyTask, null, 2) + "\n");

    const loaded = loadTask(tmpDir, "001")!;
    assert.strictEqual(loaded.retryCount, 0);
    assert.strictEqual(loaded.maxRetries, 5);
    assert.strictEqual(loaded.lastError, null);
    assert.strictEqual(loaded.nextRetryAt, null);
    assert.deepStrictEqual(loaded.depends_on, []);
  });

  it("preserves explicit retry values from JSON", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    const taskWithRetry = {
      id: "002",
      title: "Retried task",
      description: "",
      goal: null,
      status: "in-progress",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      branch: null,
      tags: [],
      proof: null,
      retryCount: 3,
      maxRetries: 10,
      lastError: "Connection refused",
      nextRetryAt: "2026-01-01T01:00:00Z",
      depends_on: ["001"],
    };
    writeFileSync(
      join(tasksDir, "002-retried-task.json"),
      JSON.stringify(taskWithRetry, null, 2) + "\n",
    );

    const loaded = loadTask(tmpDir, "002")!;
    assert.strictEqual(loaded.retryCount, 3);
    assert.strictEqual(loaded.maxRetries, 10);
    assert.strictEqual(loaded.lastError, "Connection refused");
    assert.strictEqual(loaded.nextRetryAt, "2026-01-01T01:00:00Z");
  });

  it("saves and loads task with depends_on", () => {
    ensureTasksDir(tmpDir);
    const task = {
      id: "001",
      title: "Depends on others",
      description: "",
      goal: null,
      status: "todo" as const,
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      branch: null,
      tags: [],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: ["002", "003"],
    };
    saveTask(tmpDir, task);
    const loaded = loadTask(tmpDir, "001")!;
    assert.deepStrictEqual(loaded.depends_on, ["002", "003"]);
  });

  it("defaults depends_on to empty array for legacy tasks without the field", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    writeFileSync(
      join(tasksDir, "001-legacy.json"),
      JSON.stringify({
        id: "001",
        title: "No deps field",
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
      }) + "\n",
    );
    const loaded = loadTask(tmpDir, "001")!;
    assert.deepStrictEqual(loaded.depends_on, []);
  });

  it("loadTasks defaults depends_on for all legacy tasks", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    for (const id of ["001", "002"]) {
      writeFileSync(
        join(tasksDir, `${id}-task.json`),
        JSON.stringify({
          id,
          title: `Task ${id}`,
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
        }) + "\n",
      );
    }
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 2);
    for (const t of tasks) {
      assert.strictEqual(t.retryCount, 0);
      assert.strictEqual(t.maxRetries, 5);
      assert.strictEqual(t.lastError, null);
      assert.strictEqual(t.nextRetryAt, null);
      assert.deepStrictEqual(t.depends_on, []);
    }
  });
});

describe("parseProof", () => {
  it("treats plain string as proof.notes", () => {
    const result = parseProof("all tests pass", null);
    assert.deepStrictEqual(result, { notes: "all tests pass" });
  });

  it("merges plain string into existing proof", () => {
    const existing = { tests: { passed: 10, total: 10 } };
    const result = parseProof("verified manually", existing);
    assert.deepStrictEqual(result, {
      tests: { passed: 10, total: 10 },
      notes: "verified manually",
    });
  });

  it("parses JSON with tests field", () => {
    const result = parseProof('{"tests":{"passed":5,"total":6}}', null);
    assert.deepStrictEqual(result, { tests: { passed: 5, total: 6 } });
  });

  it("parses JSON with pr field", () => {
    const result = parseProof('{"pr":{"number":42,"url":"https://github.com/pr/42","status":"merged"}}', null);
    assert.deepStrictEqual(result, {
      pr: { number: 42, url: "https://github.com/pr/42", status: "merged" },
    });
  });

  it("parses JSON with ci field", () => {
    const result = parseProof('{"ci":{"status":"passing","url":"https://ci/123"}}', null);
    assert.deepStrictEqual(result, {
      ci: { status: "passing", url: "https://ci/123" },
    });
  });

  it("parses JSON with notes field", () => {
    const result = parseProof('{"notes":"done"}', null);
    assert.deepStrictEqual(result, { notes: "done" });
  });

  it("parses JSON with all fields", () => {
    const input = JSON.stringify({
      tests: { passed: 10, total: 10 },
      pr: { number: 1 },
      ci: { status: "green" },
      notes: "ship it",
    });
    const result = parseProof(input, null);
    assert.deepStrictEqual(result, {
      tests: { passed: 10, total: 10 },
      pr: { number: 1 },
      ci: { status: "green" },
      notes: "ship it",
    });
  });

  it("merges JSON proof into existing proof", () => {
    const existing = { notes: "old note", tests: { passed: 3, total: 5 } };
    const result = parseProof('{"tests":{"passed":5,"total":5}}', existing);
    assert.deepStrictEqual(result, {
      notes: "old note",
      tests: { passed: 5, total: 5 },
    });
  });

  it("falls back to notes for invalid JSON starting with {", () => {
    const result = parseProof("{not valid json", null);
    assert.deepStrictEqual(result, { notes: "{not valid json" });
  });

  it("ignores invalid tests shape in JSON", () => {
    const result = parseProof('{"tests":"not an object","notes":"ok"}', null);
    assert.deepStrictEqual(result, { notes: "ok" });
  });

  it("saves and loads proof schema through task store", () => {
    ensureTasksDir(tmpDir);
    const task: Task = {
      id: "001",
      title: "With proof",
      description: "",
      goal: null,
      status: "done",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      branch: null,
      tags: [],
      proof: {
        tests: { passed: 10, total: 10 },
        pr: { number: 42, url: "https://github.com/pr/42" },
        ci: { status: "passing" },
        notes: "all good",
      },
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
    };
    saveTask(tmpDir, task);
    const loaded = loadTask(tmpDir, "001")!;
    assert.deepStrictEqual(loaded.proof, task.proof);
  });

  it("loads legacy Record<string,string> proof from JSON without error", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    writeFileSync(
      join(tasksDir, "001-legacy-proof.json"),
      JSON.stringify({
        id: "001",
        title: "Legacy proof",
        description: "",
        goal: null,
        status: "done",
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        branch: null,
        tags: [],
        proof: { note: "old format proof" },
      }) + "\n",
    );
    const loaded = loadTask(tmpDir, "001")!;
    assert.ok(loaded.proof !== null);
    assert.strictEqual(loaded.proof!.notes, "old format proof");
  });
});

describe("normalizer snapshots", () => {
  it("normalizeTask produces exact default shape", () => {
    const raw = {
      id: "001", title: "Test", description: "desc", goal: null,
      status: "todo", assignee: null, priority: 1,
      created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
      branch: null, tags: [], proof: null,
    };
    const result = normalizeTask(raw as any);
    assert.deepStrictEqual(result, {
      id: "001", title: "Test", description: "desc", goal: null,
      status: "todo", assignee: null, priority: 1,
      created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
      branch: null, tags: [], proof: null,
      retryCount: 0, maxRetries: 5, lastError: null, nextRetryAt: null,
      depends_on: [],
    });
  });

  it("normalizeTask migrates proof.note to proof.notes", () => {
    const raw = {
      id: "001", title: "Test", description: "", goal: null,
      status: "todo", assignee: null, priority: 1,
      created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
      branch: null, tags: [], proof: { note: "legacy note" },
    };
    const result = normalizeTask(raw as any);
    assert.strictEqual(result.proof?.notes, "legacy note");
    assert.strictEqual((result.proof as any).note, undefined);
  });

  it("normalizeGoal defaults missing fields", () => {
    const raw = { id: "01", title: "G", description: "", status: "todo", acceptance: "", priority: 1 };
    const result = normalizeGoal(raw as any);
    assert.strictEqual(result.assignee, null);
    assert.strictEqual(result.specialty, null);
    assert.strictEqual(result.created, "1970-01-01T00:00:00.000Z");
    assert.strictEqual(result.updated, "1970-01-01T00:00:00.000Z");
  });

  it("normalizeMission defaults missing timestamps", () => {
    const raw = { title: "M", description: "desc" };
    const result = normalizeMission(raw as any);
    assert.deepStrictEqual(result, {
      title: "M", description: "desc",
      created: "1970-01-01T00:00:00.000Z",
      updated: "1970-01-01T00:00:00.000Z",
    });
  });

  it("normalizeTask preserves explicit retry values", () => {
    const raw = {
      id: "001", title: "Test", description: "", goal: null,
      status: "todo", assignee: null, priority: 1,
      created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
      branch: null, tags: [], proof: null,
      retryCount: 3, maxRetries: 10, lastError: "timeout",
      nextRetryAt: "2026-01-02T00:00:00Z", depends_on: ["002"],
    };
    const result = normalizeTask(raw as any);
    assert.strictEqual(result.retryCount, 3);
    assert.strictEqual(result.maxRetries, 10);
    assert.strictEqual(result.lastError, "timeout");
    assert.strictEqual(result.nextRetryAt, "2026-01-02T00:00:00Z");
    assert.deepStrictEqual(result.depends_on, ["002"]);
  });
});

describe("corrupted JSON resilience", () => {
  it("loadTasks skips corrupted files and returns valid tasks", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    // Write a valid task
    writeFileSync(
      join(tasksDir, "001-valid.json"),
      JSON.stringify({
        id: "001", title: "Valid", description: "", goal: null,
        status: "todo", assignee: null, priority: 1,
        created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
        branch: null, tags: [], proof: null,
      }) + "\n",
    );
    // Write corrupted JSON
    writeFileSync(join(tasksDir, "002-corrupt.json"), "{not valid json\n");
    // Write another valid task
    writeFileSync(
      join(tasksDir, "003-also-valid.json"),
      JSON.stringify({
        id: "003", title: "Also Valid", description: "", goal: null,
        status: "done", assignee: null, priority: 2,
        created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
        branch: null, tags: [], proof: null,
      }) + "\n",
    );

    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0]!.id, "001");
    assert.strictEqual(tasks[1]!.id, "003");
  });

  it("loadTask returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    const tasksDir = join(tmpDir, ".tasks", "tasks");
    writeFileSync(join(tasksDir, "001-corrupt.json"), "%%%broken%%%\n");

    assert.strictEqual(loadTask(tmpDir, "001"), null);
  });

  it("loadGoals skips corrupted files and returns valid goals", () => {
    ensureTasksDir(tmpDir);
    const goalsDir = join(tmpDir, ".tasks", "goals");
    writeFileSync(
      join(goalsDir, "01-valid.json"),
      JSON.stringify({
        id: "01", title: "Valid Goal", description: "", status: "todo",
        acceptance: "", priority: 1,
        created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z",
        assignee: null, specialty: null,
      }) + "\n",
    );
    writeFileSync(join(goalsDir, "02-corrupt.json"), "not json at all\n");

    const goals = loadGoals(tmpDir);
    assert.strictEqual(goals.length, 1);
    assert.strictEqual(goals[0]!.id, "01");
  });

  it("loadGoal returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    const goalsDir = join(tmpDir, ".tasks", "goals");
    writeFileSync(join(goalsDir, "01-corrupt.json"), "{{{bad\n");

    assert.strictEqual(loadGoal(tmpDir, "01"), null);
  });

  it("loadMission returns null for corrupted file", () => {
    ensureTasksDir(tmpDir);
    writeFileSync(join(tmpDir, ".tasks", "mission.json"), "totally broken\n");

    assert.strictEqual(loadMission(tmpDir), null);
  });
});
