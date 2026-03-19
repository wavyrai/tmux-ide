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
  ensureTasksDir,
  getTasksDir,
  type Task,
} from "./task-model.ts";

let tmpDir: string;

function writeTask(task: Partial<Task> & { id: string; title: string; status: string }) {
  const dir = join(tmpDir, ".tasks");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const full: Task = {
    description: "",
    assignee: null,
    priority: 2,
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    branch: null,
    tags: [],
    proof: null,
    ...task,
  } as Task;
  writeFileSync(join(dir, `${task.id}-test.json`), JSON.stringify(full, null, 2) + "\n");
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

  it("loads tasks from .tasks/ directory", () => {
    writeTask({ id: "001", title: "First task", status: "todo" });
    writeTask({ id: "002", title: "Second task", status: "in-progress" });
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 2);
    assert.strictEqual(tasks[0]!.id, "001");
    assert.strictEqual(tasks[1]!.id, "002");
  });

  it("skips invalid JSON files", () => {
    const dir = join(tmpDir, ".tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.json"), "not json");
    writeTask({ id: "001", title: "Good task", status: "todo" });
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0]!.title, "Good task");
  });

  it("skips files missing required fields", () => {
    const dir = join(tmpDir, ".tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "incomplete.json"), JSON.stringify({ id: "001" }) + "\n");
    const tasks = loadTasks(tmpDir);
    assert.strictEqual(tasks.length, 0);
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
    const all = loadTasks(tmpDir);
    assert.strictEqual(all.length, 2);
  });

  it("creates .tasks/ directory if it does not exist", () => {
    const task = createTask(tmpDir, []);
    assert.strictEqual(task.id, "001");
    assert.ok(existsSync(getTasksDir(tmpDir)));
  });
});

describe("groupTasks", () => {
  it("groups tasks by status in display order", () => {
    const tasks: Task[] = [
      {
        id: "1",
        title: "A",
        description: "",
        status: "done",
        assignee: null,
        priority: 1,
        created: "",
        updated: "",
        branch: null,
        tags: [],
        proof: null,
      },
      {
        id: "2",
        title: "B",
        description: "",
        status: "todo",
        assignee: null,
        priority: 2,
        created: "",
        updated: "",
        branch: null,
        tags: [],
        proof: null,
      },
      {
        id: "3",
        title: "C",
        description: "",
        status: "in-progress",
        assignee: null,
        priority: 1,
        created: "",
        updated: "",
        branch: null,
        tags: [],
        proof: null,
      },
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
      {
        id: "1",
        title: "Low",
        description: "",
        status: "todo",
        assignee: null,
        priority: 3,
        created: "",
        updated: "",
        branch: null,
        tags: [],
        proof: null,
      },
      {
        id: "2",
        title: "High",
        description: "",
        status: "todo",
        assignee: null,
        priority: 1,
        created: "",
        updated: "",
        branch: null,
        tags: [],
        proof: null,
      },
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
  it("produces flat list with section indices", () => {
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
    assert.strictEqual(flat.length, 3);
    assert.strictEqual(flat[0]!.task.id, "1");
    assert.strictEqual(flat[0]!.sectionIdx, 0);
    assert.strictEqual(flat[1]!.task.id, "2");
    assert.strictEqual(flat[1]!.sectionIdx, 1);
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
