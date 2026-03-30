/**
 * Widget-specific task utilities.
 *
 * Re-exports core Task type and CRUD functions from the canonical task-store,
 * and adds widget-only helpers for grouping, sorting, and display logic.
 */
import {
  loadTasks as storeLoadTasks,
  loadTask as storeLoadTask,
  saveTask,
  ensureTasksDir as storeEnsureTasksDir,
  getTasksRoot,
  type Task,
} from "../../lib/task-store.ts";

// Re-export the canonical Task type and CRUD functions
export type { Task };
export type TaskStatus = Task["status"];

export { storeEnsureTasksDir as ensureTasksDir };

export function getTasksDir(projectDir: string): string {
  return getTasksRoot(projectDir);
}

export function loadTasks(projectDir: string): Task[] {
  return storeLoadTasks(projectDir);
}

export function updateTaskStatus(projectDir: string, taskId: string, status: TaskStatus): void {
  const task = storeLoadTask(projectDir, taskId);
  if (!task) return;
  task.status = status;
  task.updated = new Date().toISOString();
  saveTask(projectDir, task);
}

export function updateTaskAssignee(
  projectDir: string,
  taskId: string,
  assignee: string | null,
): void {
  const task = storeLoadTask(projectDir, taskId);
  if (!task) return;
  task.assignee = assignee;
  task.updated = new Date().toISOString();
  saveTask(projectDir, task);
}

export function updateTaskField(
  projectDir: string,
  taskId: string,
  fields: Partial<Pick<Task, "title" | "description" | "branch" | "tags" | "priority">>,
): void {
  const task = storeLoadTask(projectDir, taskId);
  if (!task) return;
  if (fields.title !== undefined) task.title = fields.title;
  if (fields.description !== undefined) task.description = fields.description;
  if (fields.branch !== undefined) task.branch = fields.branch;
  if (fields.tags !== undefined) task.tags = fields.tags;
  if (fields.priority !== undefined) task.priority = fields.priority;
  task.updated = new Date().toISOString();
  saveTask(projectDir, task);
}

export function createTask(projectDir: string, tasks: Task[]): Task {
  storeEnsureTasksDir(projectDir);

  // Find next ID
  let maxId = 0;
  for (const t of tasks) {
    const num = parseInt(t.id, 10);
    if (num > maxId) maxId = num;
  }
  const nextId = String(maxId + 1).padStart(3, "0");

  const task: Task = {
    id: nextId,
    title: "New task",
    description: "",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 2,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    branch: null,
    tags: [],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
  };

  saveTask(projectDir, task);
  return task;
}

// --- Widget-specific helpers ---

const STATUS_ORDER: TaskStatus[] = ["in-progress", "todo", "review", "done"];

export function groupTasks(tasks: Task[]): { status: TaskStatus; tasks: Task[] }[] {
  const groups: Record<TaskStatus, Task[]> = {
    "in-progress": [],
    todo: [],
    review: [],
    done: [],
  };

  for (const task of tasks) {
    const group = groups[task.status];
    if (group) group.push(task);
  }

  // Sort each group by priority (1 = highest)
  for (const group of Object.values(groups)) {
    group.sort((a, b) => a.priority - b.priority);
  }

  return STATUS_ORDER.map((status) => ({ status, tasks: groups[status] }));
}

export function nextStatus(current: TaskStatus): TaskStatus {
  const cycle: TaskStatus[] = ["todo", "in-progress", "review", "done"];
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length]!;
}

export function isBlocked(task: Task, allTasks: Task[]): boolean {
  if (task.depends_on.length === 0) return false;
  const statusMap = new Map(allTasks.map((t) => [t.id, t.status]));
  return task.depends_on.some((depId) => statusMap.get(depId) !== "done");
}

export type FlatItem =
  | { kind: "header"; status: TaskStatus; count: number }
  | { kind: "task"; task: Task; taskIndex: number };

// Build a flat list with headers interleaved — indices match DOM order
export function flattenTaskList(groups: { status: TaskStatus; tasks: Task[] }[]): FlatItem[] {
  const result: FlatItem[] = [];
  let taskIdx = 0;
  for (const group of groups) {
    if (group.tasks.length === 0) continue;
    result.push({ kind: "header", status: group.status, count: group.tasks.length });
    for (const task of group.tasks) {
      result.push({ kind: "task", task, taskIndex: taskIdx++ });
    }
  }
  return result;
}
