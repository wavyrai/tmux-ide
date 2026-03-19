import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type TaskStatus = "todo" | "in-progress" | "review" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string | null;
  priority: number;
  created: string;
  updated: string;
  branch: string | null;
  tags: string[];
  proof: Record<string, string> | null;
}

export function getTasksDir(projectDir: string): string {
  return join(projectDir, ".tasks");
}

export function ensureTasksDir(projectDir: string): void {
  const dir = getTasksDir(projectDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadTasks(projectDir: string): Task[] {
  const dir = getTasksDir(projectDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const tasks: Task[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const task = JSON.parse(raw) as Task;
      if (task.id && task.title && task.status) {
        tasks.push(task);
      }
    } catch {
      // Skip invalid files
    }
  }

  return tasks;
}

export function updateTaskStatus(projectDir: string, taskId: string, status: TaskStatus): void {
  const dir = getTasksDir(projectDir);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const task = JSON.parse(raw) as Task;
      if (task.id === taskId) {
        task.status = status;
        task.updated = new Date().toISOString();
        writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n");
        return;
      }
    } catch {}
  }
}

export function updateTaskAssignee(
  projectDir: string,
  taskId: string,
  assignee: string | null,
): void {
  const dir = getTasksDir(projectDir);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const task = JSON.parse(raw) as Task;
      if (task.id === taskId) {
        task.assignee = assignee;
        task.updated = new Date().toISOString();
        writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n");
        return;
      }
    } catch {}
  }
}

export function updateTaskField(
  projectDir: string,
  taskId: string,
  fields: Partial<Pick<Task, "title" | "description" | "branch" | "tags">>,
): void {
  const dir = getTasksDir(projectDir);
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const task = JSON.parse(raw) as Task;
      if (task.id === taskId) {
        if (fields.title !== undefined) task.title = fields.title;
        if (fields.description !== undefined) task.description = fields.description;
        if (fields.branch !== undefined) task.branch = fields.branch;
        if (fields.tags !== undefined) task.tags = fields.tags;
        task.updated = new Date().toISOString();
        writeFileSync(filePath, JSON.stringify(task, null, 2) + "\n");
        return;
      }
    } catch {}
  }
}

export function createTask(projectDir: string, tasks: Task[]): Task {
  ensureTasksDir(projectDir);
  const dir = getTasksDir(projectDir);

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
    status: "todo",
    assignee: null,
    priority: 2,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    branch: null,
    tags: [],
    proof: null,
  };

  writeFileSync(join(dir, `${nextId}-new-task.json`), JSON.stringify(task, null, 2) + "\n");
  return task;
}

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

export type FlatItem =
  | { kind: "header"; status: TaskStatus; count: number }
  | { kind: "task"; task: Task; taskIndex: number };

// Build a flat list with headers interleaved — indices match DOM order
export function flattenTaskList(
  groups: { status: TaskStatus; tasks: Task[] }[],
): FlatItem[] {
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
