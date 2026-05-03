import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureTasksDir,
  invalidateAllTaskStore,
  loadTasksByAgentPane,
  loadTasksByMilestone,
  loadTasksByStatus,
  loadTask,
  loadTasks,
  loadTasksForGoal,
  saveTask,
  deleteTask,
  getTaskStoreMetrics,
  startTaskStoreWatcher,
  validateTaskStoreFile,
  type Task,
  TaskStoreValidationError,
} from "./task-store.ts";

let tmpDir: string;

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = "2026-05-02T00:00:00.000Z";
  return {
    id: "001",
    title: "Task 001",
    description: "Test task",
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-task-store-test-"));
  invalidateAllTaskStore();
});

afterEach(() => {
  delete process.env.TMUX_IDE_TASKSTORE_CACHE_SIZE;
  delete process.env.TMUX_IDE_WATCHER_DEBOUNCE_MS;
  invalidateAllTaskStore();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("task-store", () => {
  it("keeps concurrent task writers from losing files", async () => {
    ensureTasksDir(tmpDir);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        Promise.resolve().then(() => {
          const id = String(index + 1).padStart(3, "0");
          saveTask(tmpDir, makeTask({ id, title: `Task ${id}` }));
        }),
      ),
    );

    expect(loadTasks(tmpDir).map((task) => task.id)).toHaveLength(20);
    expect(loadTasks(tmpDir).map((task) => task.id)).toContain("020");
    expect(existsSync(join(tmpDir, ".tasks", "tasks", "020-task-020.json"))).toBeTruthy();
  });

  it("throws a clear validation error for invalid task files", () => {
    ensureTasksDir(tmpDir);
    const file = join(tmpDir, ".tasks", "tasks", "001-bad.json");
    writeFileSync(
      file,
      JSON.stringify({ _version: 1, id: "001", title: "Bad", status: "later" }, null, 2),
    );

    expect(() => validateTaskStoreFile(file, "task")).toThrow(TaskStoreValidationError);
    try {
      validateTaskStoreFile(file, "task");
    } catch (err) {
      expect((err as Error).message).toContain(file);
      expect((err as Error).message).toContain("task schema validation failed");
      expect((err as Error).message).toContain("status");
    }
  });

  it("invalidates cached task reads after external filesystem changes", async () => {
    ensureTasksDir(tmpDir);
    const task = makeTask({ title: "Before external edit" });
    saveTask(tmpDir, task);

    const stopWatcher = startTaskStoreWatcher(tmpDir);
    try {
      expect(loadTask(tmpDir, "001")?.title).toBe("Before external edit");
      await wait(240);
      const file = join(tmpDir, ".tasks", "tasks", "001-before-external-edit.json");
      writeFileSync(
        file,
        JSON.stringify({ _version: 1, ...makeTask({ title: "After external edit" }) }, null, 2) +
          "\n",
      );

      await wait(220);
      expect(loadTask(tmpDir, "001")?.title).toBe("After external edit");
    } finally {
      await stopWatcher();
    }
  });

  it("applies legacy proof.note migration on read", () => {
    ensureTasksDir(tmpDir);
    const file = join(tmpDir, ".tasks", "tasks", "001-legacy-proof.json");
    writeFileSync(
      file,
      JSON.stringify(
        {
          _version: 1,
          ...makeTask({ title: "Legacy proof", proof: null }),
          proof: { note: "done manually" },
        },
        null,
        2,
      ) + "\n",
    );

    const loaded = loadTask(tmpDir, "001");
    expect(loaded?.proof?.notes).toBe("done manually");
    expect(readFileSync(file, "utf-8")).toContain('"note"');
  });

  it("maintains indexed task views after write, status change, and delete", () => {
    saveTask(
      tmpDir,
      makeTask({
        id: "001",
        title: "First",
        status: "todo",
        assignee: "Agent 1",
        goal: "01",
        milestone: "M1",
      }),
    );
    saveTask(
      tmpDir,
      makeTask({
        id: "002",
        title: "Second",
        status: "review",
        assignee: "Agent 2",
        goal: "01",
        milestone: "M2",
      }),
    );

    expect(loadTasksByStatus(tmpDir, "todo").map((task) => task.id)).toEqual(["001"]);
    expect(loadTasksByAgentPane(tmpDir, "Agent 1").map((task) => task.id)).toEqual(["001"]);
    expect(loadTasksForGoal(tmpDir, "01").map((task) => task.id)).toEqual(["001", "002"]);
    expect(loadTasksByMilestone(tmpDir, "M1").map((task) => task.id)).toEqual(["001"]);

    saveTask(
      tmpDir,
      makeTask({
        id: "001",
        title: "First",
        status: "done",
        assignee: "Agent 1",
        goal: "01",
        milestone: "M1",
      }),
    );
    expect(loadTasksByStatus(tmpDir, "todo").map((task) => task.id)).toEqual([]);
    expect(loadTasksByStatus(tmpDir, "done").map((task) => task.id)).toEqual(["001"]);

    expect(deleteTask(tmpDir, "001")).toBe(true);
    expect(loadTasksByStatus(tmpDir, "done").map((task) => task.id)).toEqual([]);
    expect(loadTasksForGoal(tmpDir, "01").map((task) => task.id)).toEqual(["002"]);
  });

  it("evicts least-recently-used cache entries at the configured cap", () => {
    process.env.TMUX_IDE_TASKSTORE_CACHE_SIZE = "2";
    saveTask(tmpDir, makeTask({ id: "001", title: "One" }));
    saveTask(tmpDir, makeTask({ id: "002", title: "Two" }));
    saveTask(tmpDir, makeTask({ id: "003", title: "Three" }));

    const metrics = getTaskStoreMetrics();
    expect(metrics.cache.maxSize).toBe(2);
    expect(metrics.cache.size).toBe(2);
    expect(metrics.cache.evictions).toBeGreaterThanOrEqual(1);
  });

  it("coalesces watcher events into one invalidation batch", async () => {
    process.env.TMUX_IDE_WATCHER_DEBOUNCE_MS = "20";
    ensureTasksDir(tmpDir);
    saveTask(tmpDir, makeTask({ title: "Before watcher edit" }));
    const file = join(tmpDir, ".tasks", "tasks", "001-before-watcher-edit.json");
    expect(loadTask(tmpDir, "001")?.title).toBe("Before watcher edit");

    const stopWatcher = startTaskStoreWatcher(tmpDir);
    try {
      await wait(260);
      writeFileSync(
        file,
        JSON.stringify({ _version: 1, ...makeTask({ title: "External one" }) }, null, 2) + "\n",
      );
      writeFileSync(
        file,
        JSON.stringify({ _version: 1, ...makeTask({ title: "External two" }) }, null, 2) + "\n",
      );
      await wait(260);

      expect(loadTask(tmpDir, "001")?.title).toBe("External two");
      expect(getTaskStoreMetrics().watcher.batchedFlushes).toBeGreaterThanOrEqual(1);
    } finally {
      await stopWatcher();
    }
  });
});
