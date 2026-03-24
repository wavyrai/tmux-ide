import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTasks,
  updateTaskStatus,
  updateTaskAssignee,
  createTask,
  groupTasks,
  nextStatus,
  flattenTaskList,
  isBlocked,
  ensureTasksDir,
  getTasksDir,
  type Task,
} from "./task-model.ts";
import {
  saveTask as cliSaveTask,
  ensureTasksDir as cliEnsure,
  loadTask as cliLoadTask,
} from "../../lib/task-store.ts";

let tmpDir: string;

function writeTask(task: Partial<Task> & { id: string; title: string; status: string }) {
  const dir = join(tmpDir, ".tasks", "tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full: Task = {
    description: "",
    goal: null,
    assignee: null,
    priority: 2,
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
    ...task,
  } as Task;
  writeFileSync(join(dir, `${task.id}-test.json`), JSON.stringify(full, null, 2) + "\n");
}

// Write raw JSON without new fields to simulate legacy task files
function writeLegacyTask(task: { id: string; title: string; status: string }) {
  const dir = join(tmpDir, ".tasks", "tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const legacy = {
    id: task.id,
    title: task.title,
    description: "",
    status: task.status,
    assignee: null,
    priority: 2,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    branch: null,
    tags: [],
    proof: null,
  };
  writeFileSync(join(dir, `${task.id}-test.json`), JSON.stringify(legacy, null, 2) + "\n");
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-tasks-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadTasks", () => {
  it("returns empty array when .tasks/ does not exist", () => {
    assert.deepStrictEqual(loadTasks(tmpDir), []);
  });

  it("loads tasks from .tasks/tasks/ directory", () => {
    writeTask({ id: "001", title: "First task", status: "todo" });
    writeTask({ id: "002", title: "Second task", status: "in-progress" });
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0]!.id, "001");
    assert.strictEqual(tasks[1]!.id, "002");
  });

  it("includes goal field from loaded tasks", () => {
    writeTask({ id: "001", title: "With goal", status: "todo", goal: "01" });
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks[0]!.goal, "01");
  });

  it("defaults goal to null for legacy tasks", () => {
    writeLegacyTask({ id: "001", title: "Legacy", status: "todo" });
    const tasks = loadTasks(tmpDir);
    // goal is not in legacy JSON, normalizeTask in task-store should handle it
    assert.ok(tasks[0]!.goal === null || tasks[0]!.goal === undefined);
  });
});

describe("updateTaskStatus", () => {
  it("updates status and updated timestamp", () => {
    writeTask({ id: "001", title: "Test", status: "todo" });
    updateTaskStatus(tmpDir, "001", "in-progress");
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks[0]!.status, "in-progress");
    assert.notStrictEqual(tasks[0]!.updated, "2026-01-01T00:00:00Z");
  });

  it("does nothing for non-existent task ID", () => {
    writeTask({ id: "001", title: "Test", status: "todo" });
    updateTaskStatus(tmpDir, "999", "done");
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks[0]!.status, "todo");
  });
});

describe("updateTaskAssignee", () => {
  it("sets assignee", () => {
    writeTask({ id: "001", title: "Test", status: "todo" });
    updateTaskAssignee(tmpDir, "001", "Agent 1");
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks[0]!.assignee, "Agent 1");
  });

  it("clears assignee with null", () => {
    writeTask({ id: "001", title: "Test", status: "todo", assignee: "Agent 1" });
    updateTaskAssignee(tmpDir, "001", null);
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks[0]!.assignee, null);
  });
});

describe("createTask", () => {
  it("creates a new task file with incremented ID", () => {
    writeTask({ id: "001", title: "Existing", status: "todo" });
    const existing = loadTasks(tmpDir);
    const task = createTask(tmpDir, existing);
    assert.strictEqual(task.id, "002");
    assert.strictEqual(task.status, "todo");
    assert.strictEqual(task.goal, null);
    const all = loadTasks(tmpDir);
    assert.strictEqual(all.length, 2);
  });

  it("creates .tasks/ directory if it does not exist", () => {
    const task = createTask(tmpDir, []);
    assert.strictEqual(task.id, "001");
    assert.ok(existsSync(getTasksDir(tmpDir)));
  });

  it("created task is loadable via loadTasks", () => {
    const task = createTask(tmpDir, []);
    const loaded = loadTasks(tmpDir);
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0]!.id, task.id);
    assert.strictEqual(loaded[0]!.goal, null);
  });
});

describe("groupTasks", () => {
  const taskBase = {
    description: "",
    goal: null,
    assignee: null,
    created: "",
    updated: "",
    branch: null,
    tags: [],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
  } as const;

  it("groups tasks by status in display order", () => {
    const tasks: Task[] = [
      { ...taskBase, id: "1", title: "A", status: "done", priority: 1 },
      { ...taskBase, id: "2", title: "B", status: "todo", priority: 2 },
      { ...taskBase, id: "3", title: "C", status: "in-progress", priority: 1 },
    ];
    const groups = groupTasks(tasks);
    assert.strictEqual(groups[0]!.status, "in-progress");
    assert.strictEqual(groups[0]!.tasks.length, 1);
    assert.strictEqual(groups[1]!.status, "todo");
    assert.strictEqual(groups[1]!.tasks.length, 1);
    assert.strictEqual(groups[3]!.status, "done");
    assert.strictEqual(groups[3]!.tasks.length, 1);
  });

  it("sorts by priority within each group", () => {
    const tasks: Task[] = [
      { ...taskBase, id: "1", title: "Low", status: "todo", priority: 3 },
      { ...taskBase, id: "2", title: "High", status: "todo", priority: 1 },
    ];
    const groups = groupTasks(tasks);
    const todo = groups.find((g) => g.status === "todo")!;
    assert.strictEqual(todo.tasks[0]!.title, "High");
    assert.strictEqual(todo.tasks[1]!.title, "Low");
  });
});

describe("nextStatus", () => {
  it("cycles through statuses", () => {
    assert.strictEqual(nextStatus("todo"), "in-progress");
    assert.strictEqual(nextStatus("in-progress"), "review");
    assert.strictEqual(nextStatus("review"), "done");
    assert.strictEqual(nextStatus("done"), "todo");
  });
});

describe("flattenTaskList", () => {
  it("produces flat list with headers and tasks interleaved", () => {
    const groups = [
      { status: "in-progress" as const, tasks: [{ id: "1", title: "A" } as Task] },
      {
        status: "todo" as const,
        tasks: [{ id: "2", title: "B" } as Task, { id: "3", title: "C" } as Task],
      },
      { status: "review" as const, tasks: [] },
      { status: "done" as const, tasks: [] },
    ];
    const flat = flattenTaskList(groups);
    assert.strictEqual(flat.length, 5);
    assert.strictEqual(flat[0]!.kind, "header");
    assert.strictEqual(flat[1]!.kind, "task");
    if (flat[1]!.kind === "task") assert.strictEqual(flat[1]!.task.id, "1");
    assert.strictEqual(flat[2]!.kind, "header");
    assert.strictEqual(flat[3]!.kind, "task");
    if (flat[3]!.kind === "task") assert.strictEqual(flat[3]!.task.id, "2");
    assert.strictEqual(flat[4]!.kind, "task");
    if (flat[4]!.kind === "task") assert.strictEqual(flat[4]!.task.id, "3");
  });
});

describe("ensureTasksDir", () => {
  it("creates .tasks/ directory", () => {
    ensureTasksDir(tmpDir);
    assert.ok(existsSync(getTasksDir(tmpDir)));
  });

  it("does nothing if already exists", () => {
    ensureTasksDir(tmpDir);
    ensureTasksDir(tmpDir);
    assert.ok(existsSync(getTasksDir(tmpDir)));
  });
});

describe("retry field defaults", () => {
  it("loadTasks applies retry defaults to legacy JSON without retry fields", () => {
    writeLegacyTask({ id: "001", title: "Legacy", status: "todo" });
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 1);
    const t = tasks[0]!;
    assert.strictEqual(t.retryCount, 0);
    assert.strictEqual(t.maxRetries, 5);
    assert.strictEqual(t.lastError, null);
    assert.strictEqual(t.nextRetryAt, null);
  });

  it("preserves explicit retry values from JSON", () => {
    writeTask({
      id: "001",
      title: "Retried",
      status: "in-progress",
      retryCount: 3,
      maxRetries: 10,
      lastError: "timeout",
      nextRetryAt: "2026-01-01T01:00:00Z",
    });
    const tasks = loadTasks(tmpDir);
    const t = tasks[0]!;
    assert.strictEqual(t.retryCount, 3);
    assert.strictEqual(t.maxRetries, 10);
    assert.strictEqual(t.lastError, "timeout");
    assert.strictEqual(t.nextRetryAt, "2026-01-01T01:00:00Z");
  });

  it("createTask includes retry defaults", () => {
    const task = createTask(tmpDir, []);
    assert.strictEqual(task.retryCount, 0);
    assert.strictEqual(task.maxRetries, 5);
    assert.strictEqual(task.lastError, null);
    assert.strictEqual(task.nextRetryAt, null);
  });
});

describe("depends_on", () => {
  it("defaults depends_on to empty array for legacy tasks", () => {
    writeLegacyTask({ id: "001", title: "Legacy", status: "todo" });
    const tasks = loadTasks(tmpDir);
    assert.deepStrictEqual(tasks[0]!.depends_on, []);
  });

  it("preserves depends_on when present in JSON", () => {
    const dir = join(tmpDir, ".tasks", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "001-with-deps.json"),
      JSON.stringify({
        id: "001",
        title: "Has deps",
        status: "todo",
        description: "",
        goal: null,
        assignee: null,
        priority: 1,
        created: "2026-01-01T00:00:00Z",
        updated: "2026-01-01T00:00:00Z",
        branch: null,
        tags: [],
        proof: null,
        depends_on: ["002", "003"],
      }) + "\n",
    );
    const tasks = loadTasks(tmpDir);
    assert.deepStrictEqual(tasks[0]!.depends_on, ["002", "003"]);
  });

  it("createTask sets depends_on to empty array", () => {
    const task = createTask(tmpDir, []);
    assert.deepStrictEqual(task.depends_on, []);
  });
});

describe("isBlocked", () => {
  const base = {
    description: "",
    goal: null,
    assignee: null,
    created: "",
    updated: "",
    branch: null,
    tags: [],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
  } as const;

  it("returns false when depends_on is empty", () => {
    const task: Task = {
      ...base,
      id: "001",
      title: "A",
      status: "todo",
      priority: 1,
      depends_on: [],
    };
    assert.strictEqual(isBlocked(task, []), false);
  });

  it("returns true when a dependency is not done", () => {
    const dep: Task = {
      ...base,
      id: "002",
      title: "Dep",
      status: "in-progress",
      priority: 1,
      depends_on: [],
    };
    const task: Task = {
      ...base,
      id: "001",
      title: "A",
      status: "todo",
      priority: 1,
      depends_on: ["002"],
    };
    assert.strictEqual(isBlocked(task, [task, dep]), true);
  });

  it("returns false when all dependencies are done", () => {
    const dep: Task = {
      ...base,
      id: "002",
      title: "Dep",
      status: "done",
      priority: 1,
      depends_on: [],
    };
    const task: Task = {
      ...base,
      id: "001",
      title: "A",
      status: "todo",
      priority: 1,
      depends_on: ["002"],
    };
    assert.strictEqual(isBlocked(task, [task, dep]), false);
  });

  it("returns true when dependency ID is missing from task list", () => {
    const task: Task = {
      ...base,
      id: "001",
      title: "A",
      status: "todo",
      priority: 1,
      depends_on: ["999"],
    };
    assert.strictEqual(isBlocked(task, [task]), true);
  });
});

describe("CLI interop", () => {
  it("widget loadTasks reads tasks created by CLI saveTask", () => {
    cliEnsure(tmpDir);
    cliSaveTask(tmpDir, {
      id: "001",
      title: "CLI task",
      description: "created by CLI",
      goal: "01",
      status: "todo",
      assignee: null,
      priority: 1,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      branch: null,
      tags: ["test"],
      proof: null,
      retryCount: 0,
      maxRetries: 5,
      lastError: null,
      nextRetryAt: null,
      depends_on: [],
    });

    // Widget loadTasks should see it
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0]!.id, "001");
    assert.strictEqual(tasks[0]!.title, "CLI task");
    assert.strictEqual(tasks[0]!.goal, "01");
  });

  it("widget updateTaskStatus changes are visible to CLI loadTask", () => {
    cliEnsure(tmpDir);
    cliSaveTask(tmpDir, {
      id: "001",
      title: "Test",
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

    // Widget updates the task
    updateTaskStatus(tmpDir, "001", "in-progress");

    // CLI should see the change
    const loaded = cliLoadTask(tmpDir, "001");
    assert.strictEqual(loaded?.status, "in-progress");
  });
});
