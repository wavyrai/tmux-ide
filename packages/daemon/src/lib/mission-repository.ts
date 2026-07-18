import { randomUUID } from "node:crypto";
import {
  MissionEventSchemaZ,
  MissionProjectStateSchemaZ,
  type MissionActor,
  type MissionAttempt,
  type MissionAttemptId,
  type MissionAttemptStatus,
  type MissionEvent,
  type MissionHistoryEntry,
  type MissionId,
  type MissionProjectState,
  type MissionProof,
  type MissionProofId,
  type MissionSnapshot,
  type MissionSource,
  type MissionStatus,
  type MissionTask,
  type MissionTaskId,
  type MissionTaskStatus,
} from "@tmux-ide/contracts";

import { IdeError } from "./errors.ts";
import {
  openProjectRuntimeRepository,
  type OpenProjectRuntimeRepositoryOptions,
  type ProjectRuntimeRepository,
  type RuntimeEvent,
} from "./project-runtime-repository.ts";

const MISSIONS_STREAM = "missions";

export type MissionRepositoryErrorCode =
  | "MISSION_HISTORY_INVALID"
  | "MISSION_NOT_FOUND"
  | "MISSION_ALREADY_EXISTS"
  | "MISSION_TERMINAL"
  | "MISSION_INCOMPLETE_TASKS"
  | "TASK_NOT_FOUND"
  | "TASK_ALREADY_EXISTS"
  | "TASK_DEPENDENCY_NOT_FOUND"
  | "TASK_DEPENDENCY_UNMET"
  | "TASK_TERMINAL"
  | "TASK_INVALID_TRANSITION"
  | "TASK_OWNERSHIP_CONFLICT"
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_ALREADY_EXISTS"
  | "ATTEMPT_TERMINAL"
  | "ATTEMPT_INVALID_TRANSITION"
  | "ATTEMPT_OWNERSHIP_CONFLICT"
  | "PROOF_NOT_FOUND"
  | "PROOF_ALREADY_EXISTS"
  | "PROOF_REQUIRED";

export class MissionRepositoryError extends IdeError {
  readonly missionCode: MissionRepositoryErrorCode;

  constructor(
    message: string,
    code: MissionRepositoryErrorCode,
    { cause }: { cause?: Error } = {},
  ) {
    super(message, { code, cause });
    this.name = "MissionRepositoryError";
    this.missionCode = code;
  }
}

export interface MissionMutationOptions {
  expectedPreviousSequence?: number;
}

export interface MissionRepositorySnapshot {
  history: MissionHistoryEntry[];
  state: MissionProjectState;
}

export interface CreateMissionInput {
  id?: MissionId;
  title: string;
  objective: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  labels?: string[];
  source?: MissionSource;
  actor: MissionActor;
}

export interface AddTaskInput {
  id?: MissionTaskId;
  missionId: MissionId;
  title: string;
  description?: string;
  priority?: number;
  dependencies?: MissionTaskId[];
  assignee?: string;
  actor: MissionActor;
}

export interface UpdateTaskInput {
  missionId: MissionId;
  taskId: MissionTaskId;
  title?: string;
  description?: string;
  priority?: number;
  dependencies?: MissionTaskId[];
  assignee?: string | null;
  actor: MissionActor;
}

export interface StartAttemptInput {
  id?: MissionAttemptId;
  missionId: MissionId;
  taskId: MissionTaskId;
  agent: string;
  harness: string;
  model?: string;
  terminal?: string;
  session?: string;
  worktree?: string;
  actor: MissionActor;
}

export interface RecordProofInput {
  id?: MissionProofId;
  missionId: MissionId;
  taskId?: MissionTaskId;
  attemptId?: MissionAttemptId;
  proof: MissionProof;
  actor: MissionActor;
}

type RuntimeMissionEvent = RuntimeEvent<MissionEvent>;

export class MissionRepository {
  constructor(private readonly runtime: ProjectRuntimeRepository) {}

  static async open(
    dir: string,
    options: OpenProjectRuntimeRepositoryOptions = {},
  ): Promise<MissionRepository> {
    return new MissionRepository(await openProjectRuntimeRepository(dir, options));
  }

  metadata(): ProjectRuntimeRepository["metadata"] {
    return clone(this.runtime.metadata);
  }

  history(): MissionHistoryEntry[] {
    const history = this.readHistory();
    replayMissionEvents(history);
    return history.map(({ sequence, timestamp, payload }) => ({
      sequence,
      timestamp,
      event: clone(payload),
    }));
  }

  state(): MissionProjectState {
    return clone(replayMissionEvents(this.readHistory()));
  }

  snapshot(): MissionRepositorySnapshot {
    const history = this.readHistory();
    const state = replayMissionEvents(history);
    return {
      history: history.map(({ sequence, timestamp, payload }) => ({
        sequence,
        timestamp,
        event: clone(payload),
      })),
      state: clone(state),
    };
  }

  list(): MissionSnapshot[] {
    return Object.values(this.state().missions)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  get(missionId: MissionId): MissionSnapshot | null {
    return clone(this.state().missions[missionId] ?? null);
  }

  create(input: CreateMissionInput, options: MissionMutationOptions = {}): MissionSnapshot {
    const missionId = input.id ?? makeId("mis");
    return this.appendGuarded(
      {
        version: 1,
        type: "mission.created",
        missionId,
        title: input.title,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        constraints: input.constraints ?? [],
        labels: input.labels ?? [],
        source: input.source ?? { type: "user" },
        actor: input.actor,
      },
      options,
      (state) => {
        if (state.missions[missionId]) {
          throw new MissionRepositoryError(
            `Mission "${missionId}" already exists`,
            "MISSION_ALREADY_EXISTS",
          );
        }
      },
      (state) => state.missions[missionId]!,
    );
  }

  planMission(missionId: MissionId, actor: MissionActor, options: MissionMutationOptions = {}) {
    return this.transitionMission(missionId, "mission.planned", "planned", actor, options);
  }

  startMission(missionId: MissionId, actor: MissionActor, options: MissionMutationOptions = {}) {
    return this.transitionMission(missionId, "mission.started", "started", actor, options);
  }

  blockMission(
    missionId: MissionId,
    reason: string,
    actor: MissionActor,
    options: MissionMutationOptions = {},
  ) {
    return this.transitionMission(missionId, "mission.blocked", "blocked", actor, options, {
      reason,
    });
  }

  reviewMission(missionId: MissionId, actor: MissionActor, options: MissionMutationOptions = {}) {
    return this.transitionMission(missionId, "mission.review", "review", actor, options);
  }

  completeMission(
    missionId: MissionId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionMission(missionId, "mission.completed", "completed", actor, options, {
      proofId: options.proofId,
      reason: options.reason,
    });
  }

  failMission(
    missionId: MissionId,
    actor: MissionActor,
    options: MissionMutationOptions & { reason?: string } = {},
  ) {
    return this.transitionMission(missionId, "mission.failed", "failed", actor, options, {
      reason: options.reason,
    });
  }

  cancelMission(
    missionId: MissionId,
    actor: MissionActor,
    options: MissionMutationOptions & { reason?: string } = {},
  ) {
    return this.transitionMission(missionId, "mission.cancelled", "cancelled", actor, options, {
      reason: options.reason,
    });
  }

  addTask(input: AddTaskInput, options: MissionMutationOptions = {}): MissionTask {
    const taskId = input.id ?? makeId("tsk");
    return this.appendGuarded(
      {
        version: 1,
        type: "task.added",
        missionId: input.missionId,
        taskId,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        priority: input.priority ?? 0,
        dependencies: input.dependencies ?? [],
        ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
        actor: input.actor,
      },
      options,
      (state) => {
        const mission = requireMission(state, input.missionId);
        ensureMissionOpen(mission);
        if (mission.tasks[taskId]) {
          throw new MissionRepositoryError(
            `Task "${taskId}" already exists`,
            "TASK_ALREADY_EXISTS",
          );
        }
        ensureDependenciesValid(mission, input.dependencies ?? [], taskId);
      },
      (state) => state.missions[input.missionId]!.tasks[taskId]!,
    );
  }

  updateTask(input: UpdateTaskInput, options: MissionMutationOptions = {}): MissionTask {
    return this.appendGuarded(
      {
        version: 1,
        type: "task.updated",
        missionId: input.missionId,
        taskId: input.taskId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.dependencies === undefined ? {} : { dependencies: input.dependencies }),
        ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
        actor: input.actor,
      },
      options,
      (state) => {
        const mission = requireMission(state, input.missionId);
        ensureMissionOpen(mission);
        const task = ensureTask(mission, input.taskId);
        if (input.dependencies) {
          ensureTaskMetadataCanChangeDependencies(task);
          ensureDependenciesValid(mission, input.dependencies, input.taskId);
        }
      },
      (state) => state.missions[input.missionId]!.tasks[input.taskId]!,
    );
  }

  readyTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    actor: MissionActor,
    options: MissionMutationOptions = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.ready", "ready", actor, options);
  }

  claimTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    assignee: string,
    actor: MissionActor,
    options: MissionMutationOptions = {},
  ) {
    return this.appendGuarded(
      { version: 1, type: "task.claimed", missionId, taskId, assignee, actor },
      options,
      (state) => {
        const mission = requireMission(state, missionId);
        ensureMissionOpen(mission);
        const task = ensureTask(mission, taskId);
        ensureTaskCanTransition(task, ["added", "ready", "blocked"], "claimed");
        if (task.status === "blocked") ensureTaskDependenciesComplete(mission, task);
        if (task.assignee && task.assignee !== assignee) {
          throw new MissionRepositoryError(
            `Task "${taskId}" is already assigned to "${task.assignee}"`,
            "TASK_OWNERSHIP_CONFLICT",
          );
        }
      },
      (state) => state.missions[missionId]!.tasks[taskId]!,
    );
  }

  startTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    actor: MissionActor,
    options: MissionMutationOptions = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.started", "started", actor, options);
  }

  blockTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    reason: string,
    actor: MissionActor,
    options: MissionMutationOptions = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.blocked", "blocked", actor, options, {
      reason,
    });
  }

  submitTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.submitted", "submitted", actor, options, {
      proofId: options.proofId,
      reason: options.reason,
    });
  }

  completeTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.completed", "completed", actor, options, {
      proofId: options.proofId,
      reason: options.reason,
    });
  }

  failTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    actor: MissionActor,
    options: MissionMutationOptions & { reason?: string } = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.failed", "failed", actor, options, {
      reason: options.reason,
    });
  }

  cancelTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    actor: MissionActor,
    options: MissionMutationOptions & { reason?: string } = {},
  ) {
    return this.transitionTask(missionId, taskId, "task.cancelled", "cancelled", actor, options, {
      reason: options.reason,
    });
  }

  startAttempt(input: StartAttemptInput, options: MissionMutationOptions = {}): MissionAttempt {
    const attemptId = input.id ?? makeId("att");
    return this.appendGuarded(
      {
        version: 1,
        type: "attempt.started",
        missionId: input.missionId,
        taskId: input.taskId,
        attemptId,
        agent: input.agent,
        harness: input.harness,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.terminal === undefined ? {} : { terminal: input.terminal }),
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
        actor: input.actor,
      },
      options,
      (state) => {
        const mission = requireMission(state, input.missionId);
        ensureMissionOpen(mission);
        const task = ensureTask(mission, input.taskId);
        ensureTaskCanTransition(task, ["claimed", "started", "blocked"], "attempt.started");
        ensureTaskDependenciesComplete(mission, task);
        if (task.assignee && task.assignee !== input.agent) {
          throw new MissionRepositoryError(
            `Attempt agent "${input.agent}" does not match task assignee "${task.assignee}"`,
            "ATTEMPT_OWNERSHIP_CONFLICT",
          );
        }
        if (mission.attempts[attemptId]) {
          throw new MissionRepositoryError(
            `Attempt "${attemptId}" already exists`,
            "ATTEMPT_ALREADY_EXISTS",
          );
        }
      },
      (state) => state.missions[input.missionId]!.attempts[attemptId]!,
    );
  }

  submitAttempt(
    missionId: MissionId,
    taskId: MissionTaskId,
    attemptId: MissionAttemptId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionAttempt(
      missionId,
      taskId,
      attemptId,
      "attempt.submitted",
      "submitted",
      actor,
      options,
    );
  }

  approveAttempt(
    missionId: MissionId,
    taskId: MissionTaskId,
    attemptId: MissionAttemptId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionAttempt(
      missionId,
      taskId,
      attemptId,
      "attempt.approved",
      "approved",
      actor,
      options,
    );
  }

  rejectAttempt(
    missionId: MissionId,
    taskId: MissionTaskId,
    attemptId: MissionAttemptId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionAttempt(
      missionId,
      taskId,
      attemptId,
      "attempt.rejected",
      "rejected",
      actor,
      options,
    );
  }

  failAttempt(
    missionId: MissionId,
    taskId: MissionTaskId,
    attemptId: MissionAttemptId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionAttempt(
      missionId,
      taskId,
      attemptId,
      "attempt.failed",
      "failed",
      actor,
      options,
    );
  }

  interruptAttempt(
    missionId: MissionId,
    taskId: MissionTaskId,
    attemptId: MissionAttemptId,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ) {
    return this.transitionAttempt(
      missionId,
      taskId,
      attemptId,
      "attempt.interrupted",
      "interrupted",
      actor,
      options,
    );
  }

  recordProof(input: RecordProofInput, options: MissionMutationOptions = {}): MissionProof {
    const proofId = input.id ?? makeId("prf");
    return this.appendGuarded(
      {
        version: 1,
        type: "proof.recorded",
        missionId: input.missionId,
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        proofId,
        proof: input.proof,
        actor: input.actor,
      },
      options,
      (state) => {
        const mission = requireMission(state, input.missionId);
        ensureMissionOpen(mission);
        if (mission.proofs[proofId]) {
          throw new MissionRepositoryError(
            `Proof "${proofId}" already exists`,
            "PROOF_ALREADY_EXISTS",
          );
        }
        if (input.taskId) ensureTask(mission, input.taskId);
        if (input.attemptId) {
          const attempt = ensureAttempt(mission, input.attemptId);
          if (input.taskId && attempt.taskId !== input.taskId) {
            throw new MissionRepositoryError(
              `Attempt "${input.attemptId}" does not belong to task "${input.taskId}"`,
              "ATTEMPT_OWNERSHIP_CONFLICT",
            );
          }
        }
      },
      (state) => state.missions[input.missionId]!.proofs[proofId]!,
    );
  }

  private transitionMission(
    missionId: MissionId,
    eventType: MissionEvent["type"],
    nextStatus: MissionStatus,
    actor: MissionActor,
    options: MissionMutationOptions = {},
    extras: { proofId?: MissionProofId; reason?: string } = {},
  ): MissionSnapshot {
    return this.appendGuarded(
      { version: 1, type: eventType, missionId, actor, ...definedExtras(extras) } as MissionEvent,
      options,
      (state) => {
        const mission = requireMission(state, missionId);
        validateMissionTransition(mission, nextStatus, extras.proofId);
      },
      (state) => state.missions[missionId]!,
    );
  }

  private transitionTask(
    missionId: MissionId,
    taskId: MissionTaskId,
    eventType: MissionEvent["type"],
    nextStatus: MissionTaskStatus,
    actor: MissionActor,
    options: MissionMutationOptions = {},
    extras: { proofId?: MissionProofId; reason?: string } = {},
  ): MissionTask {
    return this.appendGuarded(
      {
        version: 1,
        type: eventType,
        missionId,
        taskId,
        actor,
        ...definedExtras(extras),
      } as MissionEvent,
      options,
      (state) => {
        const mission = requireMission(state, missionId);
        ensureMissionOpen(mission);
        const task = ensureTask(mission, taskId);
        validateTaskTransition(mission, task, nextStatus, extras.proofId);
      },
      (state) => state.missions[missionId]!.tasks[taskId]!,
    );
  }

  private transitionAttempt(
    missionId: MissionId,
    taskId: MissionTaskId,
    attemptId: MissionAttemptId,
    eventType: MissionEvent["type"],
    nextStatus: MissionAttemptStatus,
    actor: MissionActor,
    options: MissionMutationOptions & { proofId?: MissionProofId; reason?: string } = {},
  ): MissionAttempt {
    return this.appendGuarded(
      {
        version: 1,
        type: eventType,
        missionId,
        taskId,
        attemptId,
        actor,
        ...definedExtras({ proofId: options.proofId, reason: options.reason }),
      } as MissionEvent,
      options,
      (state) => {
        const mission = requireMission(state, missionId);
        ensureMissionOpen(mission);
        const task = ensureTask(mission, taskId);
        const attempt = ensureAttempt(mission, attemptId);
        if (attempt.taskId !== task.id) {
          throw new MissionRepositoryError(
            `Attempt "${attemptId}" does not belong to task "${taskId}"`,
            "ATTEMPT_OWNERSHIP_CONFLICT",
          );
        }
        ensureAttemptCanTransition(attempt, nextStatus);
        if (nextStatus === "submitted" || nextStatus === "approved") {
          ensureTaskDependenciesComplete(mission, task);
        }
        if ((nextStatus === "submitted" || nextStatus === "approved") && !options.proofId) {
          throw new MissionRepositoryError(
            `Attempt "${attemptId}" requires proof or an explicit no-proof reason`,
            "PROOF_REQUIRED",
          );
        }
        if (options.proofId && !mission.proofs[options.proofId]) {
          throw new MissionRepositoryError(
            `Proof "${options.proofId}" does not exist`,
            "PROOF_NOT_FOUND",
          );
        }
      },
      (state) => state.missions[missionId]!.attempts[attemptId]!,
    );
  }

  private appendGuarded<T>(
    event: MissionEvent,
    options: MissionMutationOptions,
    guard: (state: MissionProjectState) => void,
    select: (state: MissionProjectState) => T,
  ): T {
    const history = this.readHistory();
    const state = replayMissionEvents(history);
    guard(state);
    const expectedPreviousSequence = options.expectedPreviousSequence ?? state.sequence;
    const appended = this.runtime.appendEvent(MISSIONS_STREAM, parseMissionEventInput(event), {
      expectedPreviousSequence,
    });
    const nextState = replayMissionEvents([...history, parseRuntimeEvent(appended)]);
    return clone(select(nextState));
  }

  private readHistory(): RuntimeMissionEvent[] {
    return this.runtime.readEvents(MISSIONS_STREAM).map(parseRuntimeEvent);
  }
}

export function replayMissionEvents(events: RuntimeMissionEvent[]): MissionProjectState {
  const state: MissionProjectState = { sequence: 0, missions: {} };
  for (const runtimeEvent of events) {
    const parsed = parseRuntimeEvent(runtimeEvent);
    validateRuntimeEventEnvelope(parsed, state.sequence + 1);
    applyMissionEvent(state, parsed);
  }
  return parseProjectedState(state);
}

export function applyMissionEvent(
  state: MissionProjectState,
  runtimeEvent: RuntimeMissionEvent,
): void {
  validateRuntimeEventEnvelope(runtimeEvent);
  const event = runtimeEvent.payload;
  const timestamp = runtimeEvent.timestamp;

  switch (event.type) {
    case "mission.created":
      if (state.missions[event.missionId]) {
        throw new MissionRepositoryError(
          `Mission "${event.missionId}" already exists`,
          "MISSION_ALREADY_EXISTS",
        );
      }
      state.missions[event.missionId] = {
        id: event.missionId,
        title: event.title,
        objective: event.objective,
        acceptanceCriteria: [...event.acceptanceCriteria],
        constraints: [...event.constraints],
        labels: [...event.labels],
        source: clone(event.source),
        status: "created",
        createdAt: timestamp,
        updatedAt: timestamp,
        tasks: {},
        attempts: {},
        proofs: {},
      };
      state.sequence = runtimeEvent.sequence;
      return;
    case "mission.planned":
    case "mission.started":
    case "mission.blocked":
    case "mission.review":
    case "mission.completed":
    case "mission.failed":
    case "mission.cancelled": {
      const mission = requireMission(state, event.missionId);
      const nextStatus = event.type.split(".")[1] as MissionStatus;
      validateMissionTransition(
        mission,
        nextStatus,
        "proofId" in event ? event.proofId : undefined,
      );
      mission.status = nextStatus;
      mission.updatedAt = timestamp;
      if (event.type === "mission.started") mission.startedAt = timestamp;
      if (["mission.completed", "mission.failed", "mission.cancelled"].includes(event.type)) {
        mission.finishedAt = timestamp;
      }
      state.sequence = runtimeEvent.sequence;
      return;
    }
    case "task.added": {
      const mission = requireMission(state, event.missionId);
      ensureMissionOpen(mission);
      if (mission.tasks[event.taskId]) {
        throw new MissionRepositoryError(
          `Task "${event.taskId}" already exists`,
          "TASK_ALREADY_EXISTS",
        );
      }
      ensureDependenciesValid(mission, event.dependencies, event.taskId);
      mission.tasks[event.taskId] = {
        id: event.taskId,
        missionId: event.missionId,
        title: event.title,
        ...(event.description === undefined ? {} : { description: event.description }),
        priority: event.priority,
        dependencies: [...event.dependencies],
        ...(event.assignee === undefined ? {} : { assignee: event.assignee }),
        status: "added",
        createdAt: timestamp,
        updatedAt: timestamp,
        proofIds: [],
        attemptIds: [],
      };
      mission.updatedAt = timestamp;
      state.sequence = runtimeEvent.sequence;
      return;
    }
    case "task.updated": {
      const mission = requireMission(state, event.missionId);
      ensureMissionOpen(mission);
      const task = ensureTask(mission, event.taskId);
      if (event.dependencies !== undefined) {
        ensureTaskMetadataCanChangeDependencies(task);
        ensureDependenciesValid(mission, event.dependencies, event.taskId);
      }
      if (event.title !== undefined) task.title = event.title;
      if (event.description !== undefined) task.description = event.description;
      if (event.priority !== undefined) task.priority = event.priority;
      if (event.dependencies !== undefined) task.dependencies = [...event.dependencies];
      if ("assignee" in event) {
        if (event.assignee === null) delete task.assignee;
        else task.assignee = event.assignee;
      }
      task.updatedAt = timestamp;
      mission.updatedAt = timestamp;
      state.sequence = runtimeEvent.sequence;
      return;
    }
    case "task.ready":
    case "task.claimed":
    case "task.started":
    case "task.blocked":
    case "task.submitted":
    case "task.completed":
    case "task.failed":
    case "task.cancelled": {
      const mission = requireMission(state, event.missionId);
      ensureMissionOpen(mission);
      const task = ensureTask(mission, event.taskId);
      const nextStatus = event.type.split(".")[1] as MissionTaskStatus;
      validateTaskTransition(
        mission,
        task,
        nextStatus,
        "proofId" in event ? event.proofId : undefined,
      );
      if (event.type === "task.claimed" && task.status === "blocked") {
        ensureTaskDependenciesComplete(mission, task);
      }
      task.status = nextStatus;
      if (event.type === "task.claimed") task.assignee = event.assignee;
      if (event.type === "task.started") task.startedAt = timestamp;
      if (event.type === "task.submitted" || event.type === "task.completed") {
        if (event.proofId) pushUnique(task.proofIds, event.proofId);
      }
      if (["task.completed", "task.failed", "task.cancelled"].includes(event.type)) {
        task.finishedAt = timestamp;
      }
      task.updatedAt = timestamp;
      mission.updatedAt = timestamp;
      state.sequence = runtimeEvent.sequence;
      return;
    }
    case "attempt.started": {
      const mission = requireMission(state, event.missionId);
      ensureMissionOpen(mission);
      const task = ensureTask(mission, event.taskId);
      if (mission.attempts[event.attemptId]) {
        throw new MissionRepositoryError(
          `Attempt "${event.attemptId}" already exists`,
          "ATTEMPT_ALREADY_EXISTS",
        );
      }
      ensureTaskCanTransition(task, ["claimed", "started", "blocked"], "attempt.started");
      ensureTaskDependenciesComplete(mission, task);
      if (task.assignee && task.assignee !== event.agent) {
        throw new MissionRepositoryError(
          `Attempt agent "${event.agent}" does not match task assignee "${task.assignee}"`,
          "ATTEMPT_OWNERSHIP_CONFLICT",
        );
      }
      mission.attempts[event.attemptId] = {
        id: event.attemptId,
        missionId: event.missionId,
        taskId: event.taskId,
        agent: event.agent,
        harness: event.harness,
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.terminal === undefined ? {} : { terminal: event.terminal }),
        ...(event.session === undefined ? {} : { session: event.session }),
        ...(event.worktree === undefined ? {} : { worktree: event.worktree }),
        status: "started",
        startedAt: timestamp,
        updatedAt: timestamp,
        proofIds: [],
      };
      task.attemptIds.push(event.attemptId);
      task.updatedAt = timestamp;
      mission.updatedAt = timestamp;
      state.sequence = runtimeEvent.sequence;
      return;
    }
    case "attempt.submitted":
    case "attempt.approved":
    case "attempt.rejected":
    case "attempt.failed":
    case "attempt.interrupted": {
      const mission = requireMission(state, event.missionId);
      ensureMissionOpen(mission);
      const task = ensureTask(mission, event.taskId);
      const attempt = ensureAttempt(mission, event.attemptId);
      if (attempt.taskId !== task.id) {
        throw new MissionRepositoryError(
          `Attempt "${event.attemptId}" does not belong to task "${event.taskId}"`,
          "ATTEMPT_OWNERSHIP_CONFLICT",
        );
      }
      const nextStatus = event.type.split(".")[1] as MissionAttemptStatus;
      validateAttemptTransition(mission, attempt, nextStatus, event.proofId);
      attempt.status = nextStatus;
      if (nextStatus !== "started") attempt.outcome = nextStatus;
      if (event.proofId) pushUnique(attempt.proofIds, event.proofId);
      if (
        ["attempt.approved", "attempt.rejected", "attempt.failed", "attempt.interrupted"].includes(
          event.type,
        )
      ) {
        attempt.finishedAt = timestamp;
      }
      attempt.updatedAt = timestamp;
      mission.updatedAt = timestamp;
      state.sequence = runtimeEvent.sequence;
      return;
    }
    case "proof.recorded": {
      const mission = requireMission(state, event.missionId);
      ensureMissionOpen(mission);
      if (mission.proofs[event.proofId]) {
        throw new MissionRepositoryError(
          `Proof "${event.proofId}" already exists`,
          "PROOF_ALREADY_EXISTS",
        );
      }
      const task = event.taskId ? ensureTask(mission, event.taskId) : null;
      const attempt = event.attemptId ? ensureAttempt(mission, event.attemptId) : null;
      if (task && attempt && attempt.taskId !== task.id) {
        throw new MissionRepositoryError(
          `Attempt "${event.attemptId}" does not belong to task "${event.taskId}"`,
          "ATTEMPT_OWNERSHIP_CONFLICT",
        );
      }
      mission.proofs[event.proofId] = clone(event.proof);
      if (event.taskId) {
        pushUnique(task!.proofIds, event.proofId);
        task!.updatedAt = timestamp;
      }
      if (event.attemptId) {
        pushUnique(attempt!.proofIds, event.proofId);
        attempt!.updatedAt = timestamp;
      }
      mission.updatedAt = timestamp;
      state.sequence = runtimeEvent.sequence;
      return;
    }
  }
}

function parseRuntimeEvent(event: RuntimeEvent<unknown>): RuntimeMissionEvent {
  validateRuntimeEventEnvelope(event);
  const parsed = MissionEventSchemaZ.safeParse(event.payload);
  if (!parsed.success) {
    throw new MissionRepositoryError(
      `Invalid mission event at sequence ${event.sequence}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "MISSION_HISTORY_INVALID",
    );
  }
  return { ...event, payload: parsed.data };
}

function validateRuntimeEventEnvelope(
  event: RuntimeEvent<unknown>,
  expectedSequence?: number,
): void {
  if (event.version !== 1) {
    throw new MissionRepositoryError(
      `Invalid mission event envelope version ${String(event.version)}`,
      "MISSION_HISTORY_INVALID",
    );
  }
  if (
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    (expectedSequence !== undefined && event.sequence !== expectedSequence)
  ) {
    throw new MissionRepositoryError(
      `Invalid mission event sequence ${String(event.sequence)}`,
      "MISSION_HISTORY_INVALID",
    );
  }
  if (!isCanonicalTimestamp(event.timestamp)) {
    throw new MissionRepositoryError(
      `Invalid mission event timestamp at sequence ${event.sequence}`,
      "MISSION_HISTORY_INVALID",
    );
  }
}

function requireMission(state: MissionProjectState, missionId: MissionId): MissionSnapshot {
  const mission = state.missions[missionId];
  if (!mission)
    throw new MissionRepositoryError(`Mission "${missionId}" not found`, "MISSION_NOT_FOUND");
  return mission;
}

function ensureTask(mission: MissionSnapshot, taskId: MissionTaskId): MissionTask {
  const task = mission.tasks[taskId];
  if (!task) throw new MissionRepositoryError(`Task "${taskId}" not found`, "TASK_NOT_FOUND");
  return task;
}

function ensureAttempt(mission: MissionSnapshot, attemptId: MissionAttemptId): MissionAttempt {
  const attempt = mission.attempts[attemptId];
  if (!attempt) {
    throw new MissionRepositoryError(`Attempt "${attemptId}" not found`, "ATTEMPT_NOT_FOUND");
  }
  return attempt;
}

function ensureMissionOpen(mission: MissionSnapshot): void {
  if (["completed", "failed", "cancelled"].includes(mission.status)) {
    throw new MissionRepositoryError(`Mission "${mission.id}" is terminal`, "MISSION_TERMINAL");
  }
}

const MISSION_TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  created: ["planned", "started", "cancelled"],
  planned: ["started", "blocked", "cancelled"],
  started: ["blocked", "review", "failed", "cancelled"],
  blocked: ["started", "failed", "cancelled"],
  review: ["started", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TASK_TRANSITIONS: Record<MissionTaskStatus, MissionTaskStatus[]> = {
  added: ["ready", "claimed", "blocked", "failed", "cancelled"],
  ready: ["claimed", "blocked", "failed", "cancelled"],
  claimed: ["started", "blocked", "failed", "cancelled"],
  started: ["blocked", "submitted", "failed", "cancelled"],
  blocked: ["ready", "claimed", "started", "failed", "cancelled"],
  submitted: ["blocked", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

function validateMissionTransition(
  mission: MissionSnapshot,
  next: MissionStatus,
  proofId?: MissionProofId,
): void {
  ensureMissionOpen(mission);
  if (!MISSION_TRANSITIONS[mission.status].includes(next)) {
    throw new MissionRepositoryError(
      `Mission "${mission.id}" cannot transition from ${mission.status} to ${next}`,
      "MISSION_HISTORY_INVALID",
    );
  }
  if (next === "completed") {
    if (mission.status !== "review") {
      throw new MissionRepositoryError(
        `Mission "${mission.id}" must be in review before completion`,
        "MISSION_HISTORY_INVALID",
      );
    }
    const incomplete = Object.values(mission.tasks).filter((task) => task.status !== "completed");
    if (incomplete.length > 0) {
      throw new MissionRepositoryError(
        `Mission "${mission.id}" cannot complete with incomplete tasks`,
        "MISSION_INCOMPLETE_TASKS",
      );
    }
    if (proofId && !mission.proofs[proofId]) {
      throw new MissionRepositoryError(`Proof "${proofId}" does not exist`, "PROOF_NOT_FOUND");
    }
  }
}

function ensureDependenciesValid(
  mission: MissionSnapshot,
  dependencies: MissionTaskId[],
  self?: MissionTaskId,
): void {
  const seen = new Set<MissionTaskId>();
  for (const dependency of dependencies) {
    if (dependency === self) {
      throw new MissionRepositoryError("Task cannot depend on itself", "TASK_DEPENDENCY_UNMET");
    }
    if (seen.has(dependency)) {
      throw new MissionRepositoryError(
        `Task dependency "${dependency}" is duplicated`,
        "TASK_DEPENDENCY_UNMET",
      );
    }
    seen.add(dependency);
    if (!mission.tasks[dependency]) {
      throw new MissionRepositoryError(
        `Dependency task "${dependency}" not found`,
        "TASK_DEPENDENCY_NOT_FOUND",
      );
    }
  }
  if (self) ensureNoDependencyCycle(mission, self, dependencies);
}

function ensureNoDependencyCycle(
  mission: MissionSnapshot,
  taskId: MissionTaskId,
  nextDependencies: MissionTaskId[],
): void {
  const dependenciesFor = (candidate: MissionTaskId): MissionTaskId[] =>
    candidate === taskId ? nextDependencies : (mission.tasks[candidate]?.dependencies ?? []);

  const visiting = new Set<MissionTaskId>();
  const visited = new Set<MissionTaskId>();

  function visit(candidate: MissionTaskId): void {
    if (visiting.has(candidate)) {
      throw new MissionRepositoryError(
        "Task dependencies must not contain a cycle",
        "TASK_DEPENDENCY_UNMET",
      );
    }
    if (visited.has(candidate)) return;
    visiting.add(candidate);
    for (const dependency of dependenciesFor(candidate)) visit(dependency);
    visiting.delete(candidate);
    visited.add(candidate);
  }

  visit(taskId);
}

function ensureTaskMetadataCanChangeDependencies(task: MissionTask): void {
  if (!["added", "ready", "blocked"].includes(task.status)) {
    throw new MissionRepositoryError(
      `Task "${task.id}" dependencies cannot change after execution begins`,
      "TASK_INVALID_TRANSITION",
    );
  }
}

function validateTaskTransition(
  mission: MissionSnapshot,
  task: MissionTask,
  next: MissionTaskStatus,
  proofId?: MissionProofId,
): void {
  if (["completed", "failed", "cancelled"].includes(task.status)) {
    throw new MissionRepositoryError(`Task "${task.id}" is terminal`, "TASK_TERMINAL");
  }
  if (!TASK_TRANSITIONS[task.status].includes(next)) {
    throw new MissionRepositoryError(
      `Task "${task.id}" cannot transition from ${task.status} to ${next}`,
      "TASK_INVALID_TRANSITION",
    );
  }
  if (["ready", "started", "submitted", "completed"].includes(next)) {
    ensureTaskDependenciesComplete(mission, task);
  }
  if ((next === "submitted" || next === "completed") && !proofId) {
    throw new MissionRepositoryError(
      `Task "${task.id}" requires proof or an explicit no-proof reason`,
      "PROOF_REQUIRED",
    );
  }
  if (proofId && !mission.proofs[proofId]) {
    throw new MissionRepositoryError(`Proof "${proofId}" does not exist`, "PROOF_NOT_FOUND");
  }
}

function ensureTaskDependenciesComplete(mission: MissionSnapshot, task: MissionTask): void {
  for (const dependencyId of task.dependencies) {
    const dependency = ensureTask(mission, dependencyId);
    if (dependency.status !== "completed") {
      throw new MissionRepositoryError(
        `Task "${task.id}" dependency "${dependencyId}" is not complete`,
        "TASK_DEPENDENCY_UNMET",
      );
    }
  }
}

function ensureTaskCanTransition(
  task: MissionTask,
  allowed: MissionTaskStatus[],
  next: string,
): void {
  if (["completed", "failed", "cancelled"].includes(task.status)) {
    throw new MissionRepositoryError(`Task "${task.id}" is terminal`, "TASK_TERMINAL");
  }
  if (!allowed.includes(task.status)) {
    throw new MissionRepositoryError(
      `Task "${task.id}" cannot transition from ${task.status} to ${next}`,
      "TASK_INVALID_TRANSITION",
    );
  }
}

function validateAttemptTransition(
  mission: MissionSnapshot,
  attempt: MissionAttempt,
  next: MissionAttemptStatus,
  proofId?: MissionProofId,
): void {
  ensureAttemptCanTransition(attempt, next);
  if ((next === "submitted" || next === "approved") && !proofId) {
    throw new MissionRepositoryError(
      `Attempt "${attempt.id}" requires proof or an explicit no-proof reason`,
      "PROOF_REQUIRED",
    );
  }
  if (proofId && !mission.proofs[proofId]) {
    throw new MissionRepositoryError(`Proof "${proofId}" does not exist`, "PROOF_NOT_FOUND");
  }
}

function ensureAttemptCanTransition(attempt: MissionAttempt, next: MissionAttemptStatus): void {
  if (["approved", "rejected", "failed", "interrupted"].includes(attempt.status)) {
    throw new MissionRepositoryError(`Attempt "${attempt.id}" is terminal`, "ATTEMPT_TERMINAL");
  }
  const allowed: Record<MissionAttemptStatus, MissionAttemptStatus[]> = {
    started: [],
    submitted: ["started"],
    approved: ["submitted"],
    rejected: ["submitted"],
    failed: ["started", "submitted"],
    interrupted: ["started", "submitted"],
  };
  if (!allowed[next].includes(attempt.status)) {
    throw new MissionRepositoryError(
      `Attempt "${attempt.id}" cannot transition from ${attempt.status} to ${next}`,
      "ATTEMPT_INVALID_TRANSITION",
    );
  }
}

function parseMissionEventInput(event: MissionEvent): MissionEvent {
  const parsed = MissionEventSchemaZ.safeParse(event);
  if (!parsed.success) {
    throw new MissionRepositoryError(
      `Invalid mission event input: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "MISSION_HISTORY_INVALID",
    );
  }
  return parsed.data;
}

function parseProjectedState(state: MissionProjectState): MissionProjectState {
  const parsed = MissionProjectStateSchemaZ.safeParse(state);
  if (!parsed.success) {
    throw new MissionRepositoryError(
      `Invalid projected mission state: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      "MISSION_HISTORY_INVALID",
    );
  }
  return parsed.data;
}

function definedExtras<T extends Record<string, unknown>>(extras: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(extras).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function pushUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function makeId(prefix: "mis" | "tsk" | "att" | "prf"): string {
  return `${prefix}_${randomUUID()}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export { MISSIONS_STREAM };
export type {
  MissionAttempt,
  MissionHistoryEntry,
  MissionProjectState,
  MissionSnapshot,
  MissionTask,
} from "@tmux-ide/contracts";
