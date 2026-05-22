import type { ProofSchema } from "../types.ts";
import {
  clearMission,
  deleteGoal,
  deleteTask,
  detectCycle,
  ensureTasksDir,
  loadGoal,
  loadMission,
  loadTask,
  loadTasks,
  loadTasksForGoal,
  nextGoalId,
  nextTaskId,
  saveGoal,
  saveMission,
  saveTask,
  type Goal,
  type Milestone,
  type Mission,
  type Task,
} from "./task-store.ts";
import { checkCoverage } from "./validation.ts";

export type TaskActionErrorCode =
  | "task_not_found"
  | "goal_not_found"
  | "milestone_not_found"
  | "mission_not_set"
  | "task_dependency_unmet"
  | "task_already_assigned"
  | "validation_failed";

export class TaskActionError extends Error {
  readonly code: TaskActionErrorCode;
  readonly details: unknown | undefined;

  constructor(args: { code: TaskActionErrorCode; message: string; details?: unknown }) {
    super(args.message);
    this.name = "TaskActionError";
    this.code = args.code;
    this.details = args.details;
  }
}

export type ProofInput = string | ProofSchema;

export function parseProof(raw: string, existing: ProofSchema | null): ProofSchema {
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return mergeProof(parsed, existing);
    } catch {
      // Not JSON; fall through to notes.
    }
  }
  return { ...existing, notes: raw };
}

function mergeProof(raw: Record<string, unknown>, existing: ProofSchema | null): ProofSchema {
  const proof: ProofSchema = { ...existing };
  if (raw.tests && typeof raw.tests === "object") {
    const t = raw.tests as Record<string, unknown>;
    if (typeof t.passed === "number" && typeof t.total === "number") {
      proof.tests = { passed: t.passed, total: t.total };
    }
  }
  if (raw.pr && typeof raw.pr === "object") {
    const p = raw.pr as Record<string, unknown>;
    if (typeof p.number === "number") {
      proof.pr = { number: p.number };
      if (typeof p.url === "string") proof.pr.url = p.url;
      if (typeof p.status === "string") proof.pr.status = p.status;
    }
  }
  if (raw.ci && typeof raw.ci === "object") {
    const c = raw.ci as Record<string, unknown>;
    if (typeof c.status === "string") {
      proof.ci = { status: c.status };
      if (typeof c.url === "string") proof.ci.url = c.url;
    }
  }
  if (typeof raw.notes === "string") proof.notes = raw.notes;
  return proof;
}

function normalizeProof(input: ProofInput, existing: ProofSchema | null): ProofSchema {
  return typeof input === "string" ? parseProof(input, existing) : mergeProof(input, existing);
}

function cleanList(values: string[] | string | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const raw = Array.isArray(values) ? values : values.split(",");
  return raw.map((value) => value.trim()).filter(Boolean);
}

function validTaskStatus(status: string): status is Task["status"] {
  return status === "todo" || status === "in-progress" || status === "review" || status === "done";
}

function validGoalStatus(status: string): status is Goal["status"] {
  return status === "todo" || status === "in-progress" || status === "done";
}

function validMilestoneStatus(status: string): status is Milestone["status"] {
  return status === "locked" || status === "active" || status === "validating" || status === "done";
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  goalId?: string | null;
  priority?: number;
  assign?: string | null;
  tags?: string[] | string;
  depends?: string[] | string;
  milestone?: string | null;
  specialty?: string | null;
  fulfills?: string[] | string;
}

export function createTaskRecord(
  dir: string,
  input: CreateTaskInput,
): { taskId: string; task: Task } {
  const title = input.title.trim();
  if (!title) {
    throw new TaskActionError({ code: "validation_failed", message: "Task title is required" });
  }

  ensureTasksDir(dir);
  const id = nextTaskId(dir);
  const now = new Date().toISOString();
  const depends = cleanList(input.depends) ?? [];
  const task: Task = {
    id,
    title,
    description: input.description ?? "",
    goal: input.goalId ?? null,
    status: "todo",
    assignee: input.assign ?? null,
    priority: input.priority ?? 2,
    created: now,
    updated: now,
    tags: cleanList(input.tags) ?? [],
    proof: null,
    depends_on: depends,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    milestone: input.milestone ?? null,
    specialty: input.specialty ?? null,
    fulfills: cleanList(input.fulfills) ?? [],
    discoveredIssues: [],
    salientSummary: null,
  };

  if (depends.length > 0) {
    const cycle = detectCycle(dir, task.id, depends);
    if (cycle) {
      throw new TaskActionError({
        code: "validation_failed",
        message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
        details: { cycle },
      });
    }
  }

  saveTask(dir, task);
  return { taskId: id, task };
}

export interface UpdateTaskInput {
  taskId: string;
  status?: string;
  proof?: ProofInput;
  title?: string;
  description?: string;
  priority?: number;
  assign?: string | null;
  assignee?: string | null;
  goalId?: string | null;
  tags?: string[] | string;
  depends?: string[] | string;
  milestone?: string | null;
  specialty?: string | null;
  fulfills?: string[] | string;
  summary?: string | null;
}

export function updateTaskRecord(dir: string, input: UpdateTaskInput): { task: Task } {
  const task = loadTask(dir, input.taskId);
  if (!task) {
    throw new TaskActionError({
      code: "task_not_found",
      message: `Task ${input.taskId} not found`,
      details: { taskId: input.taskId },
    });
  }

  if (input.status !== undefined) {
    if (!validTaskStatus(input.status)) {
      throw new TaskActionError({
        code: "validation_failed",
        message: `Invalid task status: ${input.status}`,
        details: { status: input.status },
      });
    }
    task.status = input.status;
  }
  if (input.title !== undefined) task.title = input.title;
  if (input.description !== undefined) task.description = input.description;
  if (input.priority !== undefined) task.priority = input.priority;
  if (input.assign !== undefined) task.assignee = input.assign || null;
  if (input.assignee !== undefined) task.assignee = input.assignee || null;
  if (input.goalId !== undefined) task.goal = input.goalId;
  if (input.tags !== undefined) task.tags = cleanList(input.tags) ?? [];
  if (input.depends !== undefined) {
    const newDeps = cleanList(input.depends) ?? [];
    const cycle = detectCycle(dir, task.id, newDeps);
    if (cycle) {
      throw new TaskActionError({
        code: "validation_failed",
        message: `Dependency cycle detected: ${cycle.join(" -> ")}`,
        details: { cycle },
      });
    }
    task.depends_on = newDeps;
  }
  if (input.proof !== undefined) task.proof = normalizeProof(input.proof, task.proof);
  if (input.milestone !== undefined) task.milestone = input.milestone;
  if (input.specialty !== undefined) task.specialty = input.specialty;
  if (input.fulfills !== undefined) task.fulfills = cleanList(input.fulfills) ?? [];
  if (input.summary !== undefined) task.salientSummary = input.summary;

  task.updated = new Date().toISOString();
  saveTask(dir, task);
  return { task };
}

export function claimTaskRecord(dir: string, taskId: string, assign: string): { task: Task } {
  const task = loadTask(dir, taskId);
  if (!task) {
    throw new TaskActionError({
      code: "task_not_found",
      message: `Task ${taskId} not found`,
      details: { taskId },
    });
  }

  if (task.assignee && task.assignee !== assign) {
    throw new TaskActionError({
      code: "task_already_assigned",
      message: `Task ${taskId} is already assigned to ${task.assignee}`,
      details: { taskId, assignee: task.assignee },
    });
  }

  const allTasks = loadTasks(dir);
  const unmet = task.depends_on.filter((depId) => {
    const dep = allTasks.find((candidate) => candidate.id === depId);
    return !dep || dep.status !== "done";
  });
  if (unmet.length > 0) {
    throw new TaskActionError({
      code: "task_dependency_unmet",
      message: `Task ${taskId} has unmet dependencies: ${unmet.join(", ")}`,
      details: { taskId, unmet },
    });
  }

  task.assignee = assign;
  task.status = "in-progress";
  task.updated = new Date().toISOString();
  saveTask(dir, task);
  return { task };
}

export function doneTaskRecord(dir: string, taskId: string, proof?: ProofInput): { task: Task } {
  const task = loadTask(dir, taskId);
  if (!task) {
    throw new TaskActionError({
      code: "task_not_found",
      message: `Task ${taskId} not found`,
      details: { taskId },
    });
  }
  task.status = "done";
  if (proof !== undefined) task.proof = normalizeProof(proof, task.proof);
  task.updated = new Date().toISOString();
  saveTask(dir, task);
  return { task };
}

export function deleteTaskRecord(dir: string, taskId: string): { deleted: true } {
  if (!deleteTask(dir, taskId)) {
    throw new TaskActionError({
      code: "task_not_found",
      message: `Task ${taskId} not found`,
      details: { taskId },
    });
  }
  return { deleted: true };
}

export interface CreateGoalInput {
  title: string;
  priority?: number;
  acceptance?: string;
  description?: string;
  milestone?: string | null;
  specialty?: string | null;
}

export function createGoalRecord(
  dir: string,
  input: CreateGoalInput,
): { goalId: string; goal: Goal } {
  const title = input.title.trim();
  if (!title) {
    throw new TaskActionError({ code: "validation_failed", message: "Goal title is required" });
  }

  ensureTasksDir(dir);
  const id = nextGoalId(dir);
  const now = new Date().toISOString();
  const goal: Goal = {
    id,
    title,
    description: input.description ?? "",
    status: "todo",
    acceptance: input.acceptance ?? "",
    priority: input.priority ?? 2,
    created: now,
    updated: now,
    assignee: null,
    specialty: input.specialty ?? null,
    milestone: input.milestone ?? null,
  };
  saveGoal(dir, goal);
  return { goalId: id, goal };
}

export interface UpdateGoalInput {
  goalId: string;
  status?: string;
  title?: string;
  description?: string;
  acceptance?: string;
  priority?: number;
  milestone?: string | null;
  specialty?: string | null;
  assign?: string | null;
}

export function updateGoalRecord(dir: string, input: UpdateGoalInput): { goal: Goal } {
  const goal = loadGoal(dir, input.goalId);
  if (!goal) {
    throw new TaskActionError({
      code: "goal_not_found",
      message: `Goal ${input.goalId} not found`,
      details: { goalId: input.goalId },
    });
  }
  if (input.status !== undefined) {
    if (!validGoalStatus(input.status)) {
      throw new TaskActionError({
        code: "validation_failed",
        message: `Invalid goal status: ${input.status}`,
        details: { status: input.status },
      });
    }
    goal.status = input.status;
  }
  if (input.title !== undefined) goal.title = input.title;
  if (input.description !== undefined) goal.description = input.description;
  if (input.acceptance !== undefined) goal.acceptance = input.acceptance;
  if (input.priority !== undefined) goal.priority = input.priority;
  if (input.milestone !== undefined) goal.milestone = input.milestone;
  if (input.specialty !== undefined) goal.specialty = input.specialty;
  if (input.assign !== undefined) goal.assignee = input.assign || null;
  goal.updated = new Date().toISOString();
  saveGoal(dir, goal);
  return { goal };
}

export function doneGoalRecord(dir: string, goalId: string): { goal: Goal } {
  return updateGoalRecord(dir, { goalId, status: "done" });
}

export function deleteGoalRecord(dir: string, goalId: string): { deleted: true } {
  if (!deleteGoal(dir, goalId)) {
    throw new TaskActionError({
      code: "goal_not_found",
      message: `Goal ${goalId} not found`,
      details: { goalId },
    });
  }
  return { deleted: true };
}

export function createMilestoneRecord(
  dir: string,
  input: { title: string; sequence?: number; description?: string },
): { milestoneId: string; milestone: Milestone } {
  const title = input.title.trim();
  if (!title) {
    throw new TaskActionError({
      code: "validation_failed",
      message: "Milestone title is required",
    });
  }

  const mission = loadMission(dir);
  if (!mission) {
    throw new TaskActionError({ code: "mission_not_set", message: "No mission set" });
  }

  const sequence = input.sequence ?? mission.milestones.length + 1;
  const id = `M${sequence}`;
  if (mission.milestones.some((milestone) => milestone.id === id)) {
    throw new TaskActionError({
      code: "validation_failed",
      message: `Milestone ${id} already exists`,
      details: { milestoneId: id },
    });
  }

  const now = new Date().toISOString();
  const hasActive = mission.milestones.some(
    (milestone) => milestone.status === "active" || milestone.status === "done",
  );
  const milestone: Milestone = {
    id,
    title,
    description: input.description ?? "",
    status: hasActive ? "locked" : "active",
    order: sequence,
    created: now,
    updated: now,
  };
  mission.milestones.push(milestone);
  mission.milestones.sort((a, b) => a.order - b.order);
  mission.updated = now;
  saveMission(dir, mission);
  return { milestoneId: id, milestone };
}

export function updateMilestoneRecord(
  dir: string,
  input: { milestoneId: string; status?: string; title?: string; description?: string },
): { milestone: Milestone } {
  const mission = loadMission(dir);
  if (!mission) {
    throw new TaskActionError({ code: "mission_not_set", message: "No mission set" });
  }

  const milestone = mission.milestones.find((candidate) => candidate.id === input.milestoneId);
  if (!milestone) {
    throw new TaskActionError({
      code: "milestone_not_found",
      message: `Milestone ${input.milestoneId} not found`,
      details: { milestoneId: input.milestoneId },
    });
  }

  if (input.status !== undefined) {
    if (!validMilestoneStatus(input.status)) {
      throw new TaskActionError({
        code: "validation_failed",
        message: `Invalid milestone status: ${input.status}`,
        details: { status: input.status },
      });
    }
    milestone.status = input.status;
  }
  if (input.title !== undefined) milestone.title = input.title;
  if (input.description !== undefined) milestone.description = input.description;
  milestone.updated = new Date().toISOString();
  mission.updated = milestone.updated;
  saveMission(dir, mission);
  return { milestone };
}

export function setMissionRecord(
  dir: string,
  input: { title: string; description?: string },
): { mission: Mission } {
  const title = input.title.trim();
  if (!title) {
    throw new TaskActionError({ code: "validation_failed", message: "Mission title is required" });
  }
  ensureTasksDir(dir);
  const now = new Date().toISOString();
  const mission: Mission = {
    title,
    description: input.description ?? "",
    status: "active",
    branch: null,
    milestones: [],
    created: now,
    updated: now,
  };
  saveMission(dir, mission);
  return { mission };
}

export function completeMissionPlanRecord(dir: string): {
  mission: Mission;
  coverageGaps: string[];
} {
  const mission = loadMission(dir);
  if (!mission) {
    throw new TaskActionError({ code: "mission_not_set", message: "No mission set" });
  }
  if (mission.status !== "planning") {
    throw new TaskActionError({
      code: "validation_failed",
      message: `Mission is "${mission.status}", expected "planning"`,
      details: { status: mission.status },
    });
  }

  mission.status = "active";
  const sorted = [...mission.milestones].sort((a, b) => a.order - b.order);
  const first = sorted[0] ?? null;
  const now = new Date().toISOString();
  for (const milestone of sorted) {
    milestone.status = first && milestone.id === first.id ? "active" : "locked";
    milestone.updated = now;
  }
  mission.updated = now;
  saveMission(dir, mission);
  const { unclaimed } = checkCoverage(dir);
  return { mission, coverageGaps: unclaimed };
}

export function clearMissionRecord(dir: string): { cleared: true } {
  clearMission(dir);
  return { cleared: true };
}

export function areGoalTasksDone(dir: string, goalId: string): boolean {
  const tasks = loadTasksForGoal(dir, goalId);
  return tasks.length > 0 && tasks.every((task) => task.status === "done");
}
