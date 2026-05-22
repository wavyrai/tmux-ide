import { resolve } from "node:path";
import { discoverSessions } from "../../discovery.ts";
import {
  claimTaskRecord,
  clearMissionRecord,
  completeMissionPlanRecord,
  createGoalRecord,
  createMilestoneRecord,
  createTaskRecord,
  deleteGoalRecord,
  deleteTaskRecord,
  doneGoalRecord,
  doneTaskRecord,
  setMissionRecord,
  TaskActionError,
  updateGoalRecord,
  updateMilestoneRecord,
  updateTaskRecord,
} from "../../../lib/task-actions.ts";
import { ActionError } from "../errors.ts";
import type { ActionInput, ActionResult } from "../contract.ts";

export interface TaskSystemDeps {
  dir?: string;
  discoverSessions?: typeof discoverSessions;
}

type ProjectScopedInput = {
  name?: string;
  sessionName?: string;
};

function resolveActionDir(input: ProjectScopedInput, deps: TaskSystemDeps = {}): string {
  if (deps.dir) return deps.dir;
  const name = input.name ?? input.sessionName;
  if (!name) return resolve(".");

  const sessions = (deps.discoverSessions ?? discoverSessions)();
  const session = sessions.find((candidate) => candidate.name === name);
  if (!session) {
    throw new ActionError({
      code: "project_not_found",
      message: `Project "${name}" not found`,
      details: { name },
    });
  }
  return session.dir;
}

function mapTaskActionError(err: unknown): never {
  if (err instanceof TaskActionError) {
    throw new ActionError({
      code: err.code,
      message: err.message,
      details: err.details,
      cause: err,
    });
  }
  throw err;
}

function runMutation<R>(
  input: ProjectScopedInput,
  deps: TaskSystemDeps,
  fn: (dir: string) => R,
): R {
  try {
    return fn(resolveActionDir(input, deps));
  } catch (err) {
    mapTaskActionError(err);
  }
}

export function taskCreateHandler(
  input: ActionInput<"task.create">,
  deps: TaskSystemDeps = {},
): ActionResult<"task.create"> {
  return runMutation(input, deps, (dir) =>
    createTaskRecord(dir, {
      title: input.title,
      description: input.description,
      goalId: input.goalId,
      priority: input.priority,
      assign: input.assign,
      tags: input.tags,
      depends: input.depends,
      milestone: input.milestone,
      specialty: input.specialty,
      fulfills: input.fulfills,
    }),
  );
}

export function taskUpdateHandler(
  input: ActionInput<"task.update">,
  deps: TaskSystemDeps = {},
): ActionResult<"task.update"> {
  return runMutation(input, deps, (dir) =>
    updateTaskRecord(dir, {
      taskId: input.taskId,
      status: input.status,
      proof: input.proof,
      title: input.title,
      description: input.description,
      priority: input.priority,
      assign: input.assign,
      assignee: input.assignee,
      goalId: input.goalId,
      tags: input.tags,
      depends: input.depends,
      milestone: input.milestone,
      specialty: input.specialty,
      fulfills: input.fulfills,
      summary: input.summary,
    }),
  );
}

export function taskClaimHandler(
  input: ActionInput<"task.claim">,
  deps: TaskSystemDeps = {},
): ActionResult<"task.claim"> {
  return runMutation(input, deps, (dir) => claimTaskRecord(dir, input.taskId, input.assign));
}

export function taskDoneHandler(
  input: ActionInput<"task.done">,
  deps: TaskSystemDeps = {},
): ActionResult<"task.done"> {
  return runMutation(input, deps, (dir) => doneTaskRecord(dir, input.taskId, input.proof));
}

export function taskDeleteHandler(
  input: ActionInput<"task.delete">,
  deps: TaskSystemDeps = {},
): ActionResult<"task.delete"> {
  return runMutation(input, deps, (dir) => deleteTaskRecord(dir, input.taskId));
}

export function goalCreateHandler(
  input: ActionInput<"goal.create">,
  deps: TaskSystemDeps = {},
): ActionResult<"goal.create"> {
  return runMutation(input, deps, (dir) =>
    createGoalRecord(dir, {
      title: input.title,
      priority: input.priority,
      acceptance: input.acceptance,
      description: input.description,
      milestone: input.milestone,
      specialty: input.specialty,
    }),
  );
}

export function goalUpdateHandler(
  input: ActionInput<"goal.update">,
  deps: TaskSystemDeps = {},
): ActionResult<"goal.update"> {
  return runMutation(input, deps, (dir) =>
    updateGoalRecord(dir, {
      goalId: input.goalId,
      status: input.status,
      title: input.title,
      description: input.description,
      acceptance: input.acceptance,
      priority: input.priority,
      milestone: input.milestone,
      specialty: input.specialty,
      assign: input.assign,
    }),
  );
}

export function goalDoneHandler(
  input: ActionInput<"goal.done">,
  deps: TaskSystemDeps = {},
): ActionResult<"goal.done"> {
  return runMutation(input, deps, (dir) => doneGoalRecord(dir, input.goalId));
}

export function goalDeleteHandler(
  input: ActionInput<"goal.delete">,
  deps: TaskSystemDeps = {},
): ActionResult<"goal.delete"> {
  return runMutation(input, deps, (dir) => deleteGoalRecord(dir, input.goalId));
}

export function milestoneCreateHandler(
  input: ActionInput<"milestone.create">,
  deps: TaskSystemDeps = {},
): ActionResult<"milestone.create"> {
  return runMutation(input, deps, (dir) =>
    createMilestoneRecord(dir, {
      title: input.title,
      sequence: input.sequence,
      description: input.description,
    }),
  );
}

export function milestoneUpdateHandler(
  input: ActionInput<"milestone.update">,
  deps: TaskSystemDeps = {},
): ActionResult<"milestone.update"> {
  return runMutation(input, deps, (dir) =>
    updateMilestoneRecord(dir, { milestoneId: input.milestoneId, status: input.status }),
  );
}

export function missionSetHandler(
  input: ActionInput<"mission.set">,
  deps: TaskSystemDeps = {},
): ActionResult<"mission.set"> {
  return runMutation(input, deps, (dir) =>
    setMissionRecord(dir, { title: input.title, description: input.description }),
  );
}

export function missionPlanCompleteHandler(
  input: ActionInput<"mission.planComplete">,
  deps: TaskSystemDeps = {},
): ActionResult<"mission.planComplete"> {
  return runMutation(input, deps, (dir) => {
    const { mission } = completeMissionPlanRecord(dir);
    return { mission };
  });
}

export function missionClearHandler(
  input: ActionInput<"mission.clear">,
  deps: TaskSystemDeps = {},
): ActionResult<"mission.clear"> {
  return runMutation(input, deps, (dir) => clearMissionRecord(dir));
}
