import { z } from "zod";

const MissionIdPattern = /^mis_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
const TaskIdPattern = /^tsk_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
const AttemptIdPattern = /^att_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
const ProofIdPattern = /^prf_[A-Za-z0-9][A-Za-z0-9_-]{0,96}$/u;
const ReferenceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
const TmuxPaneIdPattern = /^%[0-9]{1,20}$/u;
const TimestampSchemaZ = z.string().refine(
  (value) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  },
  { message: "must be a canonical ISO timestamp" },
);

function checkUnique(
  values: string[],
  path: Array<string | number>,
  label: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `duplicate ${label} are not allowed`,
      });
      return;
    }
    seen.add(value);
  }
}

export const MissionDomainVersionSchemaZ = z.literal(1);
export const MissionIdSchemaZ = z.string().regex(MissionIdPattern);
export const MissionTaskIdSchemaZ = z.string().regex(TaskIdPattern);
export const MissionAttemptIdSchemaZ = z.string().regex(AttemptIdPattern);
export const MissionProofIdSchemaZ = z.string().regex(ProofIdPattern);
export const MissionReferenceIdSchemaZ = z.string().regex(ReferenceIdPattern);
export const MissionTerminalReferenceSchemaZ = z
  .string()
  .refine((value) => ReferenceIdPattern.test(value) || TmuxPaneIdPattern.test(value), {
    message: "must be a mission reference id or canonical tmux pane id",
  });

export const MissionActorSchemaZ = z.strictObject({
  type: z.enum(["user", "system", "agent", "service"]),
  id: MissionReferenceIdSchemaZ.optional(),
  profile: MissionReferenceIdSchemaZ.optional(),
  displayName: z.string().min(1).max(200).optional(),
});

export const MissionSourceSchemaZ = z.strictObject({
  type: z.enum(["user", "system", "import", "service"]),
  id: MissionReferenceIdSchemaZ.optional(),
});

export const MissionStatusSchemaZ = z.enum([
  "created",
  "planned",
  "started",
  "blocked",
  "review",
  "completed",
  "failed",
  "cancelled",
]);

export const MissionTaskStatusSchemaZ = z.enum([
  "added",
  "ready",
  "claimed",
  "started",
  "blocked",
  "submitted",
  "completed",
  "failed",
  "cancelled",
]);

export const MissionAttemptStatusSchemaZ = z.enum([
  "started",
  "submitted",
  "approved",
  "rejected",
  "failed",
  "interrupted",
]);

export const MissionAttemptOutcomeSchemaZ = z.enum([
  "submitted",
  "approved",
  "rejected",
  "failed",
  "interrupted",
]);

const MissionProofTestSchemaZ = z
  .strictObject({
    name: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    passed: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    url: z.string().url().optional(),
    notes: z.string().min(1).optional(),
  })
  .superRefine((test, ctx) => {
    if (test.passed !== undefined && test.total !== undefined && test.passed > test.total) {
      ctx.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed must not exceed total",
      });
    }
  });

export const MissionProofSchemaZ = z
  .strictObject({
    tests: z.array(MissionProofTestSchemaZ).optional(),
    commits: z
      .array(
        z.strictObject({
          sha: z.string().regex(/^[A-Fa-f0-9]{7,64}$/u),
          repo: MissionReferenceIdSchemaZ.optional(),
          url: z.string().url().optional(),
        }),
      )
      .optional(),
    diff: z
      .strictObject({
        summary: z.string().min(1).optional(),
        stats: z
          .strictObject({
            filesChanged: z.number().int().nonnegative().optional(),
            insertions: z.number().int().nonnegative().optional(),
            deletions: z.number().int().nonnegative().optional(),
          })
          .optional(),
        url: z.string().url().optional(),
      })
      .optional(),
    pr: z
      .strictObject({
        number: z.number().int().positive().optional(),
        url: z.string().url().optional(),
        status: z.enum(["draft", "open", "merged", "closed"]).optional(),
      })
      .optional(),
    artifacts: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          uri: z.string().min(1),
          kind: z.string().min(1).optional(),
        }),
      )
      .optional(),
    notes: z.string().min(1).optional(),
    noProofReason: z.string().min(1).optional(),
  })
  .superRefine((proof, ctx) => {
    const hasEvidence = Boolean(
      proof.noProofReason ||
      proof.notes ||
      (proof.tests?.length ?? 0) > 0 ||
      (proof.commits?.length ?? 0) > 0 ||
      proof.diff?.summary ||
      proof.diff?.url ||
      proof.diff?.stats?.filesChanged !== undefined ||
      proof.diff?.stats?.insertions !== undefined ||
      proof.diff?.stats?.deletions !== undefined ||
      proof.pr?.url ||
      proof.pr?.number ||
      proof.pr?.status ||
      (proof.artifacts?.length ?? 0) > 0,
    );
    if (!hasEvidence) {
      ctx.addIssue({
        code: "custom",
        message: "proof must include meaningful evidence or an explicit noProofReason",
      });
    }
  });

const MissionEventBaseSchemaZ = z.strictObject({
  version: MissionDomainVersionSchemaZ,
  actor: MissionActorSchemaZ,
});

const MissionEventSchemas = [
  MissionEventBaseSchemaZ.extend({
    type: z.literal("mission.created"),
    missionId: MissionIdSchemaZ,
    title: z.string().min(1),
    objective: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).default([]),
    constraints: z.array(z.string().min(1)).default([]),
    labels: z.array(z.string().min(1)).default([]),
    source: MissionSourceSchemaZ,
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.enum([
      "mission.planned",
      "mission.started",
      "mission.review",
      "mission.completed",
      "mission.failed",
      "mission.cancelled",
    ]),
    missionId: MissionIdSchemaZ,
    reason: z.string().min(1).optional(),
    proofId: MissionProofIdSchemaZ.optional(),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("mission.blocked"),
    missionId: MissionIdSchemaZ,
    reason: z.string().min(1),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("task.added"),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    title: z.string().min(1),
    description: z.string().min(1).optional(),
    priority: z.number().int().default(0),
    dependencies: z.array(MissionTaskIdSchemaZ).default([]),
    assignee: MissionReferenceIdSchemaZ.optional(),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("task.updated"),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    priority: z.number().int().optional(),
    dependencies: z.array(MissionTaskIdSchemaZ).optional(),
    assignee: MissionReferenceIdSchemaZ.nullable().optional(),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.enum([
      "task.ready",
      "task.started",
      "task.submitted",
      "task.completed",
      "task.failed",
      "task.cancelled",
    ]),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    reason: z.string().min(1).optional(),
    proofId: MissionProofIdSchemaZ.optional(),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("task.claimed"),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    assignee: MissionReferenceIdSchemaZ,
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("task.blocked"),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    reason: z.string().min(1),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("attempt.started"),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    attemptId: MissionAttemptIdSchemaZ,
    agent: MissionReferenceIdSchemaZ,
    harness: MissionReferenceIdSchemaZ,
    model: MissionReferenceIdSchemaZ.optional(),
    terminal: MissionTerminalReferenceSchemaZ.optional(),
    session: MissionReferenceIdSchemaZ.optional(),
    worktree: z.string().min(1).optional(),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.enum([
      "attempt.submitted",
      "attempt.approved",
      "attempt.rejected",
      "attempt.failed",
      "attempt.interrupted",
    ]),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    attemptId: MissionAttemptIdSchemaZ,
    proofId: MissionProofIdSchemaZ.optional(),
    reason: z.string().min(1).optional(),
  }),
  MissionEventBaseSchemaZ.extend({
    type: z.literal("proof.recorded"),
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ.optional(),
    attemptId: MissionAttemptIdSchemaZ.optional(),
    proofId: MissionProofIdSchemaZ,
    proof: MissionProofSchemaZ,
  }),
] as const;

export const MissionEventSchemaZ = z.discriminatedUnion("type", MissionEventSchemas);

export const MissionTaskSchemaZ = z.strictObject({
  id: MissionTaskIdSchemaZ,
  missionId: MissionIdSchemaZ,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  priority: z.number().int(),
  dependencies: z.array(MissionTaskIdSchemaZ),
  assignee: MissionReferenceIdSchemaZ.optional(),
  status: MissionTaskStatusSchemaZ,
  createdAt: TimestampSchemaZ,
  updatedAt: TimestampSchemaZ,
  startedAt: TimestampSchemaZ.optional(),
  finishedAt: TimestampSchemaZ.optional(),
  proofIds: z.array(MissionProofIdSchemaZ),
  attemptIds: z.array(MissionAttemptIdSchemaZ),
});

export const MissionAttemptSchemaZ = z.strictObject({
  id: MissionAttemptIdSchemaZ,
  missionId: MissionIdSchemaZ,
  taskId: MissionTaskIdSchemaZ,
  agent: MissionReferenceIdSchemaZ,
  harness: MissionReferenceIdSchemaZ,
  model: MissionReferenceIdSchemaZ.optional(),
  terminal: MissionTerminalReferenceSchemaZ.optional(),
  session: MissionReferenceIdSchemaZ.optional(),
  worktree: z.string().min(1).optional(),
  status: MissionAttemptStatusSchemaZ,
  outcome: MissionAttemptOutcomeSchemaZ.optional(),
  startedAt: TimestampSchemaZ,
  updatedAt: TimestampSchemaZ,
  finishedAt: TimestampSchemaZ.optional(),
  proofIds: z.array(MissionProofIdSchemaZ),
});

export const MissionSnapshotSchemaZ = z
  .strictObject({
    id: MissionIdSchemaZ,
    title: z.string().min(1),
    objective: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)),
    constraints: z.array(z.string().min(1)),
    labels: z.array(z.string().min(1)),
    source: MissionSourceSchemaZ,
    status: MissionStatusSchemaZ,
    createdAt: TimestampSchemaZ,
    updatedAt: TimestampSchemaZ,
    startedAt: TimestampSchemaZ.optional(),
    finishedAt: TimestampSchemaZ.optional(),
    tasks: z.record(MissionTaskIdSchemaZ, MissionTaskSchemaZ),
    attempts: z.record(MissionAttemptIdSchemaZ, MissionAttemptSchemaZ),
    proofs: z.record(MissionProofIdSchemaZ, MissionProofSchemaZ),
  })
  .superRefine((mission, ctx) => {
    for (const [taskKey, task] of Object.entries(mission.tasks)) {
      if (taskKey !== task.id) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", taskKey, "id"],
          message: "task record key must equal task id",
        });
      }
      if (task.missionId !== mission.id) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", taskKey, "missionId"],
          message: "task missionId must equal parent mission id",
        });
      }
      checkUnique(task.dependencies, ["tasks", taskKey, "dependencies"], "dependency ids", ctx);
      checkUnique(task.proofIds, ["tasks", taskKey, "proofIds"], "proof ids", ctx);
      checkUnique(task.attemptIds, ["tasks", taskKey, "attemptIds"], "attempt ids", ctx);
      for (const dependencyId of task.dependencies) {
        if (!mission.tasks[dependencyId]) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskKey, "dependencies"],
            message: `dependency ${dependencyId} must resolve to a task`,
          });
        }
      }
      for (const proofId of task.proofIds) {
        if (!mission.proofs[proofId]) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskKey, "proofIds"],
            message: `proof ${proofId} must resolve`,
          });
        }
      }
      for (const attemptId of task.attemptIds) {
        const attempt = mission.attempts[attemptId];
        if (!attempt) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskKey, "attemptIds"],
            message: `attempt ${attemptId} must resolve`,
          });
        } else if (attempt.taskId !== task.id) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskKey, "attemptIds"],
            message: `attempt ${attemptId} must point back to task ${task.id}`,
          });
        }
      }
    }

    for (const [attemptKey, attempt] of Object.entries(mission.attempts)) {
      if (attemptKey !== attempt.id) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", attemptKey, "id"],
          message: "attempt record key must equal attempt id",
        });
      }
      if (attempt.missionId !== mission.id) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", attemptKey, "missionId"],
          message: "attempt missionId must equal parent mission id",
        });
      }
      if (!mission.tasks[attempt.taskId]) {
        ctx.addIssue({
          code: "custom",
          path: ["attempts", attemptKey, "taskId"],
          message: "attempt taskId must resolve to a task",
        });
      }
      checkUnique(attempt.proofIds, ["attempts", attemptKey, "proofIds"], "proof ids", ctx);
      for (const proofId of attempt.proofIds) {
        if (!mission.proofs[proofId]) {
          ctx.addIssue({
            code: "custom",
            path: ["attempts", attemptKey, "proofIds"],
            message: `proof ${proofId} must resolve`,
          });
        }
      }
    }
  });

export const MissionProjectStateSchemaZ = z
  .strictObject({
    sequence: z.number().int().nonnegative(),
    missions: z.record(MissionIdSchemaZ, MissionSnapshotSchemaZ),
  })
  .superRefine((state, ctx) => {
    for (const [missionKey, mission] of Object.entries(state.missions)) {
      if (missionKey !== mission.id) {
        ctx.addIssue({
          code: "custom",
          path: ["missions", missionKey, "id"],
          message: "mission record key must equal mission id",
        });
      }
    }
  });

export const MissionHistoryEntrySchemaZ = z.strictObject({
  sequence: z.number().int().positive(),
  timestamp: TimestampSchemaZ,
  event: MissionEventSchemaZ,
});

export type MissionDomainVersion = z.infer<typeof MissionDomainVersionSchemaZ>;
export type MissionId = z.infer<typeof MissionIdSchemaZ>;
export type MissionTaskId = z.infer<typeof MissionTaskIdSchemaZ>;
export type MissionAttemptId = z.infer<typeof MissionAttemptIdSchemaZ>;
export type MissionProofId = z.infer<typeof MissionProofIdSchemaZ>;
export type MissionReferenceId = z.infer<typeof MissionReferenceIdSchemaZ>;
export type MissionTerminalReference = z.infer<typeof MissionTerminalReferenceSchemaZ>;
export type MissionActor = z.infer<typeof MissionActorSchemaZ>;
export type MissionSource = z.infer<typeof MissionSourceSchemaZ>;
export type MissionStatus = z.infer<typeof MissionStatusSchemaZ>;
export type MissionTaskStatus = z.infer<typeof MissionTaskStatusSchemaZ>;
export type MissionAttemptStatus = z.infer<typeof MissionAttemptStatusSchemaZ>;
export type MissionAttemptOutcome = z.infer<typeof MissionAttemptOutcomeSchemaZ>;
export type MissionProof = z.infer<typeof MissionProofSchemaZ>;
export type MissionEvent = z.infer<typeof MissionEventSchemaZ>;
export type MissionTask = z.infer<typeof MissionTaskSchemaZ>;
export type MissionAttempt = z.infer<typeof MissionAttemptSchemaZ>;
export type MissionSnapshot = z.infer<typeof MissionSnapshotSchemaZ>;
export type MissionProjectState = z.infer<typeof MissionProjectStateSchemaZ>;
export type MissionHistoryEntry = z.infer<typeof MissionHistoryEntrySchemaZ>;

// ---------------------------------------------------------------------------
// PaneInfo — live tmux pane metadata (from src/command-center/discovery.ts)
// ---------------------------------------------------------------------------

export const PaneInfoSchemaZ = z.object({
  id: z.string(),
  index: z.number(),
  title: z.string(),
  currentCommand: z.string(),
  width: z.number(),
  height: z.number(),
  active: z.boolean(),
  role: z
    .enum(["lead", "teammate", "planner", "validator", "researcher", "widget", "shell"])
    .nullable(),
  name: z.string().nullable(),
  type: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// SessionOverview — minimal session listing entry
// ---------------------------------------------------------------------------

export const SessionOverviewSchemaZ = z.object({
  name: z.string(),
  dir: z.string(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type PaneInfo = z.infer<typeof PaneInfoSchemaZ>;
export type SessionOverview = z.infer<typeof SessionOverviewSchemaZ>;
