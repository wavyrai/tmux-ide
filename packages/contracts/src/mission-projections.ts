import { z } from "zod";
import {
  MissionActorSchemaZ,
  MissionAttemptIdSchemaZ,
  MissionAttemptStatusSchemaZ,
  MissionIdSchemaZ,
  MissionProofIdSchemaZ,
  MissionReferenceIdSchemaZ,
  MissionStatusSchemaZ,
  MissionTaskIdSchemaZ,
  MissionTaskStatusSchemaZ,
} from "./domain.ts";

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

const UniqueStringArraySchemaZ = <T extends z.ZodString>(item: T) =>
  z.array(item).superRefine((values, ctx) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "duplicate references are not allowed",
        });
      }
      seen.add(value);
    }
  });

export const MissionProjectionVersionSchemaZ = z.literal(1);
export const MissionBoardColumnSchemaZ = z.enum([
  "planned",
  "running",
  "blocked",
  "review",
  "done",
]);

export const MissionProgressSummarySchemaZ = z.strictObject({
  total: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
});

export const MissionProofSummarySchemaZ = z.strictObject({
  proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ),
  hasProof: z.boolean(),
  noProofReasons: z.array(z.string().min(1)),
  notesCount: z.number().int().nonnegative(),
  tests: z.strictObject({
    suites: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  commits: UniqueStringArraySchemaZ(z.string().min(1)),
  diff: z.strictObject({
    summaries: UniqueStringArraySchemaZ(z.string().min(1)),
    urls: UniqueStringArraySchemaZ(z.string().url()),
    filesChanged: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
  }),
  prs: z.array(
    z.strictObject({
      number: z.number().int().positive().optional(),
      url: z.string().url().optional(),
      status: z.enum(["draft", "open", "merged", "closed"]).optional(),
    }),
  ),
  artifacts: z.array(
    z.strictObject({
      name: z.string().min(1),
      uri: z.string().min(1),
      kind: z.string().min(1).optional(),
    }),
  ),
});

export const MissionAttemptSummarySchemaZ = z.strictObject({
  id: MissionAttemptIdSchemaZ,
  taskId: MissionTaskIdSchemaZ,
  status: MissionAttemptStatusSchemaZ,
  outcome: z.enum(["submitted", "approved", "rejected", "failed", "interrupted"]).optional(),
  agent: MissionReferenceIdSchemaZ,
  harness: MissionReferenceIdSchemaZ,
  model: MissionReferenceIdSchemaZ.optional(),
  terminal: MissionReferenceIdSchemaZ.optional(),
  session: MissionReferenceIdSchemaZ.optional(),
  worktree: z.string().min(1).optional(),
  startedAt: TimestampSchemaZ,
  updatedAt: TimestampSchemaZ,
  finishedAt: TimestampSchemaZ.optional(),
  durationMs: z.number().int().nonnegative().nullable(),
  proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ),
});

export const TaskCardViewSchemaZ = z.strictObject({
  version: MissionProjectionVersionSchemaZ,
  id: MissionTaskIdSchemaZ,
  missionId: MissionIdSchemaZ,
  title: z.string().min(1),
  summary: z.string().min(1),
  status: MissionTaskStatusSchemaZ,
  column: MissionBoardColumnSchemaZ,
  priority: z.number().int(),
  assignee: MissionReferenceIdSchemaZ.optional(),
  dependencies: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
  blockedBy: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
  createdAt: TimestampSchemaZ,
  updatedAt: TimestampSchemaZ,
  startedAt: TimestampSchemaZ.optional(),
  finishedAt: TimestampSchemaZ.optional(),
  durationMs: z.number().int().nonnegative().nullable(),
  latestAttempt: MissionAttemptSummarySchemaZ.nullable(),
  proofSummary: MissionProofSummarySchemaZ,
  refs: z.strictObject({
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    attemptIds: UniqueStringArraySchemaZ(MissionAttemptIdSchemaZ),
    proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ),
    terminal: MissionReferenceIdSchemaZ.optional(),
    session: MissionReferenceIdSchemaZ.optional(),
    worktree: z.string().min(1).optional(),
  }),
});

export const MissionCardViewSchemaZ = z.strictObject({
  version: MissionProjectionVersionSchemaZ,
  id: MissionIdSchemaZ,
  title: z.string().min(1),
  summary: z.string().min(1),
  status: MissionStatusSchemaZ,
  column: MissionBoardColumnSchemaZ,
  labels: z.array(z.string().min(1)),
  createdAt: TimestampSchemaZ,
  updatedAt: TimestampSchemaZ,
  startedAt: TimestampSchemaZ.optional(),
  finishedAt: TimestampSchemaZ.optional(),
  durationMs: z.number().int().nonnegative().nullable(),
  progress: MissionProgressSummarySchemaZ,
  blockedBy: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
  latestAttempt: MissionAttemptSummarySchemaZ.nullable(),
  proofSummary: MissionProofSummarySchemaZ,
  refs: z.strictObject({
    missionId: MissionIdSchemaZ,
    taskIds: UniqueStringArraySchemaZ(MissionTaskIdSchemaZ),
    attemptIds: UniqueStringArraySchemaZ(MissionAttemptIdSchemaZ),
    proofIds: UniqueStringArraySchemaZ(MissionProofIdSchemaZ),
  }),
});

export const MissionBoardViewSchemaZ = z.strictObject({
  version: MissionProjectionVersionSchemaZ,
  columns: z.strictObject({
    planned: z.array(MissionCardViewSchemaZ),
    running: z.array(MissionCardViewSchemaZ),
    blocked: z.array(MissionCardViewSchemaZ),
    review: z.array(MissionCardViewSchemaZ),
    done: z.array(MissionCardViewSchemaZ),
  }),
  counts: z.strictObject({
    planned: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    review: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export const MissionTimelineEntrySchemaZ = z.strictObject({
  version: MissionProjectionVersionSchemaZ,
  sequence: z.number().int().positive(),
  timestamp: TimestampSchemaZ,
  missionId: MissionIdSchemaZ,
  taskId: MissionTaskIdSchemaZ.optional(),
  attemptId: MissionAttemptIdSchemaZ.optional(),
  proofId: MissionProofIdSchemaZ.optional(),
  type: z.string().min(1),
  label: z.string().min(1),
  actor: MissionActorSchemaZ,
  reason: z.string().min(1).optional(),
  refs: z.strictObject({
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ.optional(),
    attemptId: MissionAttemptIdSchemaZ.optional(),
    proofId: MissionProofIdSchemaZ.optional(),
    terminal: MissionReferenceIdSchemaZ.optional(),
    session: MissionReferenceIdSchemaZ.optional(),
    worktree: z.string().min(1).optional(),
  }),
});

export const MissionHistorySummarySchemaZ = z.strictObject({
  version: MissionProjectionVersionSchemaZ,
  mission: MissionCardViewSchemaZ,
  outcome: z.enum(["completed", "failed", "cancelled"]),
  startedAt: TimestampSchemaZ.optional(),
  finishedAt: TimestampSchemaZ,
  durationMs: z.number().int().nonnegative().nullable(),
  taskTotals: MissionProgressSummarySchemaZ,
  attemptTotals: z.strictObject({
    total: z.number().int().nonnegative(),
    submitted: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    interrupted: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
  }),
  proofSummary: MissionProofSummarySchemaZ,
  lastEvent: MissionTimelineEntrySchemaZ.nullable(),
});

export const MissionDetailViewSchemaZ = z.strictObject({
  version: MissionProjectionVersionSchemaZ,
  mission: MissionCardViewSchemaZ,
  taskBoard: z.strictObject({
    columns: z.strictObject({
      planned: z.array(TaskCardViewSchemaZ),
      running: z.array(TaskCardViewSchemaZ),
      blocked: z.array(TaskCardViewSchemaZ),
      review: z.array(TaskCardViewSchemaZ),
      done: z.array(TaskCardViewSchemaZ),
    }),
    counts: z.strictObject({
      planned: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      review: z.number().int().nonnegative(),
      done: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
  }),
  attempts: z.array(MissionAttemptSummarySchemaZ),
  proofSummary: MissionProofSummarySchemaZ,
  progress: MissionProgressSummarySchemaZ,
  timeline: z.array(MissionTimelineEntrySchemaZ),
});

export type MissionBoardColumn = z.infer<typeof MissionBoardColumnSchemaZ>;
export type MissionProgressSummary = z.infer<typeof MissionProgressSummarySchemaZ>;
export type MissionProofSummary = z.infer<typeof MissionProofSummarySchemaZ>;
export type MissionAttemptSummary = z.infer<typeof MissionAttemptSummarySchemaZ>;
export type MissionCardView = z.infer<typeof MissionCardViewSchemaZ>;
export type TaskCardView = z.infer<typeof TaskCardViewSchemaZ>;
export type MissionBoardView = z.infer<typeof MissionBoardViewSchemaZ>;
export type MissionTimelineEntry = z.infer<typeof MissionTimelineEntrySchemaZ>;
export type MissionHistorySummary = z.infer<typeof MissionHistorySummarySchemaZ>;
export type MissionDetailView = z.infer<typeof MissionDetailViewSchemaZ>;
