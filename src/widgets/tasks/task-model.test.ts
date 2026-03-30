import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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
    expect(loadTasks(tmpDir)).toEqual([]);
  });

  it("loads tasks from .tasks/tasks/ directory", () => {
    writeTask({ id: "001", title: "First task", status: "todo" });
    writeTask({ id: "002", title: "Second task", status: "in-progress" });
    const tasks = loadTasks(tmpDir);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.id).toBe("001");
    expect(tasks[1]!.id).toBe("002");
  });

  it("includes goal field from loaded tasks", () => {
    writeTask({ id: "001", title: "With goal", status: "todo", goal: "01" });
    const tasks = loadTasks(tmpDir);
    expect(tasks[0]!.goal).toBe("01");
  });

  it("defaults goal to null for legacy tasks", () => {
    writeLegacyTask({ id: "001", title: "Legacy", status: "todo" });
    const tasks = loadTasks(tmpDir);
    // goal is not in legacy JSON, normalizeTask in task-store should handle it
    expect(tasks[0]!.goal === null || tasks[0]!.goal === undefined).toBeTruthy();
  });
});

describe("updateTaskStatus", () => {
  it("updates status and updated timestamp", () => {
    writeTask({ id: "001", title: "Test", status: "todo" });
    updateTaskStatus(tmpDir, "001", "in-progress");
    const tasks = loadTasks(tmpDir);
    expect(tasks[0]!.status).toBe("in-progress");
    expect(tasks[0]!.updated).not.toBe("2026-01-01T00:00:00Z");
  });

  it("does nothing for non-existent task ID", () => {
    writeTask({ id: "001", title: "Test", status: "todo" });
    updateTaskStatus(tmpDir, "999", "done");
    const tasks = loadTasks(tmpDir);
    expect(tasks[0]!.status).toBe("todo");
  });
});

describe("updateTaskAssignee", () => {
  it("sets assignee", () => {
    writeTask({ id: "001", title: "Test", status: "todo" });
    updateTaskAssignee(tmpDir, "001", "Agent 1");
    const tasks = loadTasks(tmpDir);
    expect(tasks[0]!.assignee).toBe("Agent 1");
  });

  it("clears assignee with null", () => {
    writeTask({ id: "001", title: "Test", status: "todo", assignee: "Agent 1" });
    updateTaskAssignee(tmpDir, "001", null);
    const tasks = loadTasks(tmpDir);
    expect(tasks[0]!.assignee).toBe(null);
  });
});

describe("createTask", () => {
  it("creates a new task file with incremented ID", () => {
    writeTask({ id: "001", title: "Existing", status: "todo" });
    const existing = loadTasks(tmpDir);
    const task = createTask(tmpDir, existing);
    expect(task.id).toBe("002");
    expect(task.status).toBe("todo");
    expect(task.goal).toBe(null);
    const all = loadTasks(tmpDir);
    expect(all.length).toBe(2);
  });

  it("creates .tasks/ directory if it does not exist", () => {
    const task = createTask(tmpDir, []);
    expect(task.id).toBe("001");
    expect(existsSync(getTasksDir(tmpDir))).toBeTruthy();
  });

  it("created task is loadable via loadTasks", () => {
    const task = createTask(tmpDir, []);
    const loaded = loadTasks(tmpDir);
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.id).toBe(task.id);
    expect(loaded[0]!.goal).toBe(null);
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
    expect(groups[0]!.status).toBe("in-progress");
    expect(groups[0]!.tasks.length).toBe(1);
    expect(groups[1]!.status).toBe("todo");
    expect(groups[1]!.tasks.length).toBe(1);
    expect(groups[3]!.status).toBe("done");
    expect(groups[3]!.tasks.length).toBe(1);
  });

  it("sorts by priority within each group", () => {
    const tasks: Task[] = [
      { ...taskBase, id: "1", title: "Low", status: "todo", priority: 3 },
      { ...taskBase, id: "2", title: "High", status: "todo", priority: 1 },
    ];
    const groups = groupTasks(tasks);
    const todo = groups.find((g) => g.status === "todo")!;
    expect(todo.tasks[0]!.title).toBe("High");
    expect(todo.tasks[1]!.title).toBe("Low");
  });
});

describe("nextStatus", () => {
  it("cycles through statuses", () => {
    expect(nextStatus("todo")).toBe("in-progress");
    expect(nextStatus("in-progress")).toBe("review");
    expect(nextStatus("review")).toBe("done");
    expect(nextStatus("done")).toBe("todo");
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
    expect(flat.length).toBe(5);
    expect(flat[0]!.kind).toBe("header");
    expect(flat[1]!.kind).toBe("task");
    if (flat[1]!.kind === "task") expect(flat[1]!.task.id).toBe("1");
    expect(flat[2]!.kind).toBe("header");
    expect(flat[3]!.kind).toBe("task");
    if (flat[3]!.kind === "task") expect(flat[3]!.task.id).toBe("2");
    expect(flat[4]!.kind).toBe("task");
    if (flat[4]!.kind === "task") expect(flat[4]!.task.id).toBe("3");
  });
});

describe("ensureTasksDir", () => {
  it("creates .tasks/ directory", () => {
    ensureTasksDir(tmpDir);
    expect(existsSync(getTasksDir(tmpDir))).toBeTruthy();
  });

  it("does nothing if already exists", () => {
    ensureTasksDir(tmpDir);
    ensureTasksDir(tmpDir);
    expect(existsSync(getTasksDir(tmpDir))).toBeTruthy();
  });
});

describe("retry field defaults", () => {
  it("loadTasks applies retry defaults to legacy JSON without retry fields", () => {
    writeLegacyTask({ id: "001", title: "Legacy", status: "todo" });
    const tasks = loadTasks(tmpDir);
    expect(tasks.length).toBe(1);
    const t = tasks[0]!;
    expect(t.retryCount).toBe(0);
    expect(t.maxRetries).toBe(5);
    expect(t.lastError).toBe(null);
    expect(t.nextRetryAt).toBe(null);
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
    expect(t.retryCount).toBe(3);
    expect(t.maxRetries).toBe(10);
    expect(t.lastError).toBe("timeout");
    expect(t.nextRetryAt).toBe("2026-01-01T01:00:00Z");
  });

  it("createTask includes retry defaults", () => {
    const task = createTask(tmpDir, []);
    expect(task.retryCount).toBe(0);
    expect(task.maxRetries).toBe(5);
    expect(task.lastError).toBe(null);
    expect(task.nextRetryAt).toBe(null);
  });
});

describe("depends_on", () => {
  it("defaults depends_on to empty array for legacy tasks", () => {
    writeLegacyTask({ id: "001", title: "Legacy", status: "todo" });
    const tasks = loadTasks(tmpDir);
    expect(tasks[0]!.depends_on).toEqual([]);
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
    expect(tasks[0]!.depends_on).toEqual(["002", "003"]);
  });

  it("createTask sets depends_on to empty array", () => {
    const task = createTask(tmpDir, []);
    expect(task.depends_on).toEqual([]);
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
    expect(isBlocked(task, [])).toBe(false);
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
    expect(isBlocked(task, [task, dep])).toBe(true);
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
    expect(isBlocked(task, [task, dep])).toBe(false);
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
    expect(isBlocked(task, [task])).toBe(true);
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
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.id).toBe("001");
    expect(tasks[0]!.title).toBe("CLI task");
    expect(tasks[0]!.goal).toBe("01");
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
    expect(loaded?.status).toBe("in-progress");
  });
});
