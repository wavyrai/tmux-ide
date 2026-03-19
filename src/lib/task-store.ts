import { resolve, join } from "node:path";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";

const TASKS_DIR = ".tasks";

export interface Mission {
  title: string;
  description: string;
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
  branch: string | null;
  tags: string[];
  proof: Record<string, string> | null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
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
  return JSON.parse(readFileSync(path, "utf-8")) as Mission;
}

export function saveMission(dir: string, mission: Mission): void {
  ensureTasksDir(dir);
  writeFileSync(join(getTasksRoot(dir), "mission.json"), JSON.stringify(mission, null, 2) + "\n");
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
    .map((f) => JSON.parse(readFileSync(join(goalsDir, f), "utf-8")) as Goal);
}

export function loadGoal(dir: string, id: string): Goal | null {
  const file = findFileById(join(getTasksRoot(dir), "goals"), id);
  if (!file) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as Goal;
}

export function saveGoal(dir: string, goal: Goal): void {
  ensureTasksDir(dir);
  const goalsDir = join(getTasksRoot(dir), "goals");
  // Remove old file if ID exists under different name
  const existing = findFileById(goalsDir, goal.id);
  if (existing) unlinkSync(existing);
  const filename = `${goal.id}-${slugify(goal.title)}.json`;
  writeFileSync(join(goalsDir, filename), JSON.stringify(goal, null, 2) + "\n");
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
    .map((f) => JSON.parse(readFileSync(join(tasksDir, f), "utf-8")) as Task);
}

export function loadTask(dir: string, id: string): Task | null {
  const file = findFileById(join(getTasksRoot(dir), "tasks"), id);
  if (!file) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as Task;
}

export function saveTask(dir: string, task: Task): void {
  ensureTasksDir(dir);
  const tasksDir = join(getTasksRoot(dir), "tasks");
  const existing = findFileById(tasksDir, task.id);
  if (existing) unlinkSync(existing);
  const filename = `${task.id}-${slugify(task.title)}.json`;
  writeFileSync(join(tasksDir, filename), JSON.stringify(task, null, 2) + "\n");
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
