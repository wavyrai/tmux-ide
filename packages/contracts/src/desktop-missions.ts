import { z } from "zod";

import {
  MissionAttemptIdSchemaZ,
  MissionAttemptOutcomeSchemaZ,
  MissionAttemptStatusSchemaZ,
  MissionIdSchemaZ,
  MissionReferenceIdSchemaZ,
  MissionStatusSchemaZ,
  MissionTaskIdSchemaZ,
} from "./domain.ts";
import { MissionBoardColumnSchemaZ, MissionProgressSummarySchemaZ } from "./mission-projections.ts";
import { SemanticProductIdSchemaZ } from "./pane-appearance.ts";

export const DESKTOP_MISSION_MAX_VISIBLE = 64;
export const DESKTOP_MISSION_MAX_HISTORY = 64;
export const DESKTOP_MISSION_MAX_ACTIVITY = 128;

const TimestampSchemaZ = z.string().datetime({ offset: false });
const BoundedReasonSchemaZ = z.string().min(1).max(240);

export const DesktopMissionProofSummarySchemaZ = z
  .object({
    hasProof: z.boolean(),
    proofCount: z.number().int().nonnegative(),
    notesCount: z.number().int().nonnegative(),
    noProofReasons: z.array(z.string().min(1).max(160)).max(4),
    tests: z
      .object({
        suites: z.number().int().nonnegative(),
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    commitCount: z.number().int().nonnegative(),
    filesChanged: z.number().int().nonnegative(),
    insertions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    pullRequestCount: z.number().int().nonnegative(),
    artifactCount: z.number().int().nonnegative(),
  })
  .strict();

export const DesktopMissionLatestAttemptSchemaZ = z
  .object({
    id: MissionAttemptIdSchemaZ,
    taskId: MissionTaskIdSchemaZ,
    status: MissionAttemptStatusSchemaZ,
    outcome: MissionAttemptOutcomeSchemaZ.optional(),
    agent: MissionReferenceIdSchemaZ,
    harness: MissionReferenceIdSchemaZ,
    model: MissionReferenceIdSchemaZ.optional(),
    updatedAt: TimestampSchemaZ,
    durationMs: z.number().int().nonnegative().nullable(),
    proofCount: z.number().int().nonnegative(),
  })
  .strict();

export const DesktopMissionSummarySchemaZ = z
  .object({
    id: MissionIdSchemaZ,
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(512),
    status: MissionStatusSchemaZ,
    column: MissionBoardColumnSchemaZ,
    updatedAt: TimestampSchemaZ,
    startedAt: TimestampSchemaZ.optional(),
    finishedAt: TimestampSchemaZ.optional(),
    durationMs: z.number().int().nonnegative().nullable(),
    progress: MissionProgressSummarySchemaZ,
    blockedCount: z.number().int().nonnegative(),
    latestAttempt: DesktopMissionLatestAttemptSchemaZ.nullable(),
    proof: DesktopMissionProofSummarySchemaZ,
  })
  .strict();

export const DesktopMissionHistorySummarySchemaZ = z
  .object({
    mission: DesktopMissionSummarySchemaZ,
    outcome: z.enum(["completed", "failed", "cancelled"]),
    startedAt: TimestampSchemaZ.optional(),
    finishedAt: TimestampSchemaZ,
    durationMs: z.number().int().nonnegative().nullable(),
    attempts: z
      .object({
        total: z.number().int().nonnegative(),
        approved: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        interrupted: z.number().int().nonnegative(),
      })
      .strict(),
    lastEventLabel: z.string().min(1).max(160).nullable(),
  })
  .strict();

export const DesktopMissionActivityEventSchemaZ = z
  .object({
    id: SemanticProductIdSchemaZ,
    sequence: z.number().int().positive(),
    timestamp: TimestampSchemaZ,
    missionId: MissionIdSchemaZ,
    taskId: MissionTaskIdSchemaZ.optional(),
    type: z.string().min(1).max(80),
    label: z.string().min(1).max(160),
    reason: z.string().min(1).max(240).optional(),
    actor: z
      .object({
        type: z.enum(["user", "system", "agent", "service"]),
        label: z.string().min(1).max(200),
      })
      .strict(),
  })
  .strict();

const DesktopMissionCountsSchemaZ = z
  .object({
    missions: z.number().int().nonnegative(),
    history: z.number().int().nonnegative(),
    activity: z.number().int().nonnegative(),
  })
  .strict();

const DesktopMissionWorkspacePayloadSchemaZ = z.object({
  counts: DesktopMissionCountsSchemaZ,
  missions: z.array(DesktopMissionSummarySchemaZ).max(DESKTOP_MISSION_MAX_VISIBLE),
  history: z.array(DesktopMissionHistorySummarySchemaZ).max(DESKTOP_MISSION_MAX_HISTORY),
  activity: z.array(DesktopMissionActivityEventSchemaZ).max(DESKTOP_MISSION_MAX_ACTIVITY),
  truncated: z.boolean(),
});

export const DesktopMissionWorkspaceResourceSchemaZ = z.discriminatedUnion("status", [
  DesktopMissionWorkspacePayloadSchemaZ.extend({ status: z.literal("ready") }).strict(),
  DesktopMissionWorkspacePayloadSchemaZ.extend({ status: z.literal("empty") })
    .strict()
    .refine(
      (value) =>
        value.counts.missions === 0 &&
        value.counts.history === 0 &&
        value.counts.activity === 0 &&
        value.missions.length === 0 &&
        value.history.length === 0 &&
        value.activity.length === 0 &&
        !value.truncated,
      "empty mission resources cannot contain durable mission data",
    ),
  z.object({ status: z.literal("degraded"), reason: BoundedReasonSchemaZ }).strict(),
]);

export type DesktopMissionProofSummary = z.infer<typeof DesktopMissionProofSummarySchemaZ>;
export type DesktopMissionLatestAttempt = z.infer<typeof DesktopMissionLatestAttemptSchemaZ>;
export type DesktopMissionSummary = z.infer<typeof DesktopMissionSummarySchemaZ>;
export type DesktopMissionHistorySummary = z.infer<typeof DesktopMissionHistorySummarySchemaZ>;
export type DesktopMissionActivityEvent = z.infer<typeof DesktopMissionActivityEventSchemaZ>;
export type DesktopMissionWorkspaceResource = z.infer<
  typeof DesktopMissionWorkspaceResourceSchemaZ
>;
