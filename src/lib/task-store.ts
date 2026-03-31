import { resolve, join } from "node:path";
import { slugify } from "./slugify.ts";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import type { ProofSchema } from "../types.ts";

const TASKS_DIR = ".tasks";
const SCHEMA_VERSION = 1;

/**
 * Write JSON data to a file atomically.
 * Writes to a temp file first, then renames (atomic on POSIX).
 * This prevents data loss if the process crashes mid-write.
 */
function atomicWriteJSON(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmpPath, filePath);
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  status: "locked" | "active" | "done" | "validating";
  order: number;
  created: string;
  updated: string;
}

export interface Mission {
  title: string;
  description: string;
  status: "planning" | "active" | "validating" | "complete";
  branch: string | null;
  milestones: Milestone[];
  created: string;
  updated: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "done";
  acceptance: string;
  priority: number;
  created: string;
  updated: string;
  assignee: string | null;
  specialty: string | null;
  milestone: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  goal: string | null;
  status: "todo" | "in-progress" | "review" | "done";
  assignee: string | null;
  priority: number;
  created: string;
  updated: string;
  tags: string[];
  proof: ProofSchema | null;
  retryCount: number;
  maxRetries: number;
  lastError: string | null;
  nextRetryAt: string | null;
  depends_on: string[];
  milestone: string | null;
  specialty: string | null;
  fulfills: string[];
  discoveredIssues: string[];
  salientSummary: string | null;
}

export function normalizeMission(raw: Record<string, unknown>): Mission {
  const epoch = "1970-01-01T00:00:00.000Z";
  return {
    title: (raw.title as string) ?? "",
    description: (raw.description as string) ?? "",
    status: (raw.status as Mission["status"]) ?? "active",
    branch: (raw.branch as string | null) ?? null,
    milestones: Array.isArray(raw.milestones) ? (raw.milestones as Milestone[]) : [],
    created: (raw.created as string) ?? epoch,
    updated: (raw.updated as string) ?? epoch,
  };
}

export function normalizeGoal(raw: Record<string, unknown>): Goal {
  const epoch = "1970-01-01T00:00:00.000Z";
  const rest = { ...raw };
  delete rest._version;
  return {
    ...(rest as Omit<Goal, "assignee" | "specialty" | "created" | "updated">),
    created: (raw.created as string) ?? epoch,
    updated: (raw.updated as string) ?? epoch,
    assignee: (raw.assignee as string) ?? null,
    specialty: (raw.specialty as string) ?? null,
    milestone: (raw.milestone as string | null) ?? null,
  } as Goal;
}

export function normalizeTask(raw: Record<string, unknown>): Task {
  const defaults = {
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [] as string[],
  };

  // Migrate proof.note → proof.notes
  const proof = raw.proof as Record<string, unknown> | null | undefined;
  if (proof && "note" in proof && !("notes" in proof)) {
    proof.notes = proof.note;
    delete proof.note;
  }

  const rest = { ...raw };
  delete rest._version;
  return {
    ...defaults,
    ...(rest as Omit<
      Task,
      "retryCount" | "maxRetries" | "lastError" | "nextRetryAt" | "depends_on"
    >),
    retryCount: (raw.retryCount as number) ?? defaults.retryCount,
    maxRetries: (raw.maxRetries as number) ?? defaults.maxRetries,
    lastError: (raw.lastError as string | null) ?? defaults.lastError,
    nextRetryAt: (raw.nextRetryAt as string | null) ?? defaults.nextRetryAt,
    depends_on: Array.isArray(raw.depends_on) ? (raw.depends_on as string[]) : defaults.depends_on,
    milestone: (raw.milestone as string | null) ?? null,
    specialty: (raw.specialty as string | null) ?? null,
    fulfills: Array.isArray(raw.fulfills) ? (raw.fulfills as string[]) : [],
    discoveredIssues: Array.isArray(raw.discoveredIssues) ? (raw.discoveredIssues as string[]) : [],
    salientSummary: (raw.salientSummary as string | null) ?? null,
  } as Task;
}


export function getTasksRoot(dir: string): string {
  return resolve(dir, TASKS_DIR);
}

export function ensureTasksDir(dir: string): void {
  const root = getTasksRoot(dir);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const goalsDir = join(root, "goals");
  if (!existsSync(goalsDir)) mkdirSync(goalsDir);
  const tasksDir = join(root, "tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir);
}

// --- Mission ---

export function loadMission(dir: string): Mission | null {
  const path = join(getTasksRoot(dir), "mission.json");
  if (!existsSync(path)) return null;
  try {
    return normalizeMission(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    console.error("[task-store] Failed to parse mission.json: %s", (err as Error).message);
    return null;
  }
}

export function saveMission(dir: string, mission: Mission): void {
  ensureTasksDir(dir);
  atomicWriteJSON(join(getTasksRoot(dir), "mission.json"), {
    _version: SCHEMA_VERSION,
    ...mission,
  });
}

export function clearMission(dir: string): void {
  const path = join(getTasksRoot(dir), "mission.json");
  if (existsSync(path)) unlinkSync(path);
}

// --- Goals ---

function findFileById(directory: string, id: string): string | null {
  if (!existsSync(directory)) return null;
  const files = readdirSync(directory).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    if (file.startsWith(id + "-") || file === id + ".json") {
      return join(directory, file);
    }
  }
  return null;
}

export function nextGoalId(dir: string): string {
  const goalsDir = join(getTasksRoot(dir), "goals");
  if (!existsSync(goalsDir)) return "01";
  const files = readdirSync(goalsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return "01";
  const maxId = Math.max(...files.map((f) => parseInt(f.split("-")[0]!, 10) || 0));
  return String(maxId + 1).padStart(2, "0");
}

export function loadGoals(dir: string): Goal[] {
  const goalsDir = join(getTasksRoot(dir), "goals");
  if (!existsSync(goalsDir)) return [];
  return readdirSync(goalsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return normalizeGoal(JSON.parse(readFileSync(join(goalsDir, f), "utf-8")));
      } catch (err) {
        console.error("[task-store] Failed to parse %s: %s", f, (err as Error).message);
        return null;
      }
    })
    .filter((g): g is Goal => g !== null);
}

export function loadGoal(dir: string, id: string): Goal | null {
  const file = findFileById(join(getTasksRoot(dir), "goals"), id);
  if (!file) return null;
  try {
    return normalizeGoal(JSON.parse(readFileSync(file, "utf-8")));
  } catch (err) {
    console.error("[task-store] Failed to parse goal %s: %s", id, (err as Error).message);
    return null;
  }
}

export function saveGoal(dir: string, goal: Goal): void {
  ensureTasksDir(dir);
  const goalsDir = join(getTasksRoot(dir), "goals");
  const existing = findFileById(goalsDir, goal.id);
  const filename = `${goal.id}-${slugify(goal.title, 50)}.json`;
  const newPath = join(goalsDir, filename);
  // Write new file atomically first, then remove old file if slug changed
  atomicWriteJSON(newPath, { _version: SCHEMA_VERSION, ...goal });
  if (existing && existing !== newPath) unlinkSync(existing);
}

export function deleteGoal(dir: string, id: string): boolean {
  const file = findFileById(join(getTasksRoot(dir), "goals"), id);
  if (!file) return false;
  unlinkSync(file);
  return true;
}

// --- Tasks ---

export function nextTaskId(dir: string): string {
  const tasksDir = join(getTasksRoot(dir), "tasks");
  if (!existsSync(tasksDir)) return "001";
  const files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return "001";
  const maxId = Math.max(...files.map((f) => parseInt(f.split("-")[0]!, 10) || 0));
  return String(maxId + 1).padStart(3, "0");
}

export function loadTasks(dir: string): Task[] {
  const tasksDir = join(getTasksRoot(dir), "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return normalizeTask(JSON.parse(readFileSync(join(tasksDir, f), "utf-8")));
      } catch (err) {
        console.error("[task-store] Failed to parse %s: %s", f, (err as Error).message);
        return null;
      }
    })
    .filter((t): t is Task => t !== null);
}

export function loadTask(dir: string, id: string): Task | null {
  const file = findFileById(join(getTasksRoot(dir), "tasks"), id);
  if (!file) return null;
  try {
    return normalizeTask(JSON.parse(readFileSync(file, "utf-8")));
  } catch (err) {
    console.error("[task-store] Failed to parse task %s: %s", id, (err as Error).message);
    return null;
  }
}

export function saveTask(dir: string, task: Task): void {
  ensureTasksDir(dir);
  const tasksDir = join(getTasksRoot(dir), "tasks");
  const existing = findFileById(tasksDir, task.id);
  const filename = `${task.id}-${slugify(task.title, 50)}.json`;
  const newPath = join(tasksDir, filename);
  // Write new file atomically first, then remove old file if slug changed
  atomicWriteJSON(newPath, { _version: SCHEMA_VERSION, ...task });
  if (existing && existing !== newPath) unlinkSync(existing);
}

export function deleteTask(dir: string, id: string): boolean {
  const file = findFileById(join(getTasksRoot(dir), "tasks"), id);
  if (!file) return false;
  unlinkSync(file);
  return true;
}

export function loadTasksForGoal(dir: string, goalId: string): Task[] {
  return loadTasks(dir).filter((t) => t.goal === goalId);
}

/**
 * Detect dependency cycles. Builds the full dependency graph, applies
 * the proposed change (taskId → newDeps), then runs DFS from taskId.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycle(dir: string, taskId: string, newDeps: string[]): string[] | null {
  const tasks = loadTasks(dir);
  const depMap = new Map<string, string[]>();
  for (const t of tasks) {
    depMap.set(t.id, [...t.depends_on]);
  }
  // Apply proposed change
  depMap.set(taskId, newDeps);

  // DFS from taskId following depends_on edges
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (path.includes(id)) {
      return [...path.slice(path.indexOf(id)), id];
    }
    if (visited.has(id)) return null;
    visited.add(id);
    path.push(id);
    for (const dep of depMap.get(id) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    path.pop();
    return null;
  }

  return dfs(taskId);
}
