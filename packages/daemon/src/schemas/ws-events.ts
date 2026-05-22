/**
 * Protocol contracts for the unified `/ws/events` WebSocket channel.
 *
 * This is the single push channel used by the dashboard to subscribe to
 * task / mission / milestone / goal / agent / event-log changes for one or
 * more sessions. It replaces a fan of individual SSE streams that hit
 * Chrome's 6-per-origin HTTP/1.1 limit.
 *
 * The shape of these frames is FROZEN — the dashboard imports them via
 * `@tmux-ide/schemas`. Add new frame variants by appending to the union; do
 * not rename existing fields.
 */

import { z } from "zod";
import { SessionOverviewSchemaZ, OrchestratorEventSchemaZ } from "./domain.ts";
import {
  ChatResumeSubscribeZ,
  WorkspaceAddedFrameSchemaZ,
  WorkspaceRemovedFrameSchemaZ,
} from "@tmux-ide/contracts";

// ---------------------------------------------------------------------------
// Snapshot payload — mirrors what `/api/project/<name>/stream` already pushes
// as its `snapshot` SSE event. Kept loose (passthrough) so that adding fields
// on the producer side does not require shipping schema updates lock-step
// with the dashboard. Consumers should validate fields they actually read.
// ---------------------------------------------------------------------------

// The snapshot payload is the existing SSE `snapshot` event body. We accept
// any object shape here because the producer can grow new fields without
// requiring lock-step schema updates on the consumer.
export const SessionSnapshotSchemaZ = z.record(z.string(), z.unknown());
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchemaZ>;

// ---------------------------------------------------------------------------
// Client → Server frames
// ---------------------------------------------------------------------------

const SubscribeFrameZ = z.object({
  type: z.literal("subscribe"),
  sessions: z.array(z.string()),
});

const UnsubscribeFrameZ = z.object({
  type: z.literal("unsubscribe"),
  sessions: z.array(z.string()),
});

const PingFrameZ = z.object({
  type: z.literal("ping"),
});

export const ClientFrameSchemaZ = z.discriminatedUnion("type", [
  SubscribeFrameZ,
  UnsubscribeFrameZ,
  PingFrameZ,
  // Step 2: chat WS reconnect/resume. Carries the last applied
  // per-thread timeline seq so the daemon can replay the gap.
  ChatResumeSubscribeZ,
]);

export type ClientFrame = z.infer<typeof ClientFrameSchemaZ>;

// ---------------------------------------------------------------------------
// Server → Client frames
// ---------------------------------------------------------------------------

const HelloFrameZ = z.object({
  type: z.literal("hello"),
  sessions: z.array(SessionOverviewSchemaZ),
});

const SnapshotFrameZ = z.object({
  type: z.literal("snapshot"),
  sessionName: z.string(),
  data: SessionSnapshotSchemaZ,
});

const TaskChangedFrameZ = z.object({
  type: z.literal("task.changed"),
  sessionName: z.string(),
});

const MissionChangedFrameZ = z.object({
  type: z.literal("mission.changed"),
  sessionName: z.string(),
});

const MilestoneChangedFrameZ = z.object({
  type: z.literal("milestone.changed"),
  sessionName: z.string(),
});

const GoalChangedFrameZ = z.object({
  type: z.literal("goal.changed"),
  sessionName: z.string(),
});

const AgentChangedFrameZ = z.object({
  type: z.literal("agent.changed"),
  sessionName: z.string(),
});

const EventAppendedFrameZ = z.object({
  type: z.literal("event.appended"),
  sessionName: z.string(),
  event: OrchestratorEventSchemaZ,
});

const SessionsChangedFrameZ = z.object({
  type: z.literal("sessions.changed"),
});

// Project-registry has changed (register / unregister / re-probe / init success).
// Clients re-fetch GET /api/projects.
const ProjectsChangedFrameZ = z.object({
  type: z.literal("projects.changed"),
});

// Streaming output from `tmux-ide init` invoked via POST /api/projects/init.
// `chunk` is a single line of stdout/stderr (newline stripped). `done: true`
// is set on the final frame for the job; no more `init.output` frames will
// follow for this jobId.
const InitOutputFrameZ = z.object({
  type: z.literal("init.output"),
  jobId: z.string(),
  chunk: z.string(),
  done: z.boolean().optional(),
});

// Init job failed. Terminal — no `init.output` follow-ups.
const InitErrorFrameZ = z.object({
  type: z.literal("init.error"),
  jobId: z.string(),
  message: z.string(),
});

const PongFrameZ = z.object({
  type: z.literal("pong"),
});

// Broadcast after a successful v2 action dispatch. The dashboard uses these
// frames to invalidate caches without ad-hoc refetches (e.g. invalidate the
// project list after `project.launch` succeeds). `name` matches the action
// name in `command-center/actions/contract.ts`. `result` is loose at the
// schema layer because each action has its own result shape — consumers
// validate against the specific action's contract on their end.
const ActionCompleteFrameZ = z.object({
  type: z.literal("action.complete"),
  name: z.string(),
  result: z.unknown(),
});

const SkillsChangedFrameZ = z.object({
  type: z.literal("skills.changed"),
  sessionName: z.string(),
});

const ValidationChangedFrameZ = z.object({
  type: z.literal("validation.changed"),
  sessionName: z.string(),
});

const ConfigChangedFrameZ = z.object({
  type: z.literal("config.changed"),
  sessionName: z.string(),
});

const TerminalsChangedFrameZ = z.object({
  type: z.literal("terminals.changed"),
  sessionName: z.string(),
});

const FileChangedFrameZ = z.object({
  type: z.literal("file.changed"),
  sessionName: z.string(),
  path: z.string(),
  kind: z.enum(["modify", "delete"]),
});

const ChatSessionUpdateZ = z.object({ sessionUpdate: z.string() }).passthrough();

const ChatThreadIndexEntryZ = z
  .object({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    providerKind: z.enum(["claude-code", "codex", "gemini", "custom"]),
    projectDir: z.string().optional(),
    messageCount: z.number(),
    lastStopReason: z
      .enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
      .optional(),
  })
  .passthrough();

const ChatThreadUpdateFrameZ = z.object({
  type: z.literal("chat.thread.update"),
  threadId: z.string(),
  update: ChatSessionUpdateZ,
  seq: z.number().int().min(0),
});

const ChatThreadUsageSummaryZ = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0).optional(),
  cacheWriteTokens: z.number().int().min(0).optional(),
  totalCostUsd: z.number().min(0).optional(),
  contextWindowMaxTokens: z.number().int().min(0).optional(),
  contextWindowUsedTokens: z.number().int().min(0).optional(),
});

const ChatThreadUsageFrameZ = z.object({
  type: z.literal("chat.thread.usage"),
  threadId: z.string(),
  usage: ChatThreadUsageSummaryZ,
});

const ChatThreadStopFrameZ = z.object({
  type: z.literal("chat.thread.stop"),
  threadId: z.string(),
  promptId: z.string(),
  stopReason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
});

const ChatThreadIndexFrameZ = z.object({
  type: z.literal("chat.thread.index"),
  threads: z.array(ChatThreadIndexEntryZ),
});

// Server-materialized timeline deltas (e177bda). Rows ride through
// opaque (`.passthrough()`) — the canonical shape is pinned in
// @tmux-ide/contracts (TimelineRowZ); validating it twice here would
// only risk a stricter copy silently dropping a valid frame, which is
// exactly the regression class this contract row guards against.
const ChatTimelineRowZ = z
  .object({ kind: z.string(), id: z.string(), createdAt: z.string() })
  .passthrough();

// `seq` is the per-thread monotonic sequence the broadcast layer
// stamps for reconnect/resume (Step 2). Optional in the schema so a
// pre-Step-2 emitter / replay-less path still validates.
const ChatTimelineUpsertFrameZ = z.object({
  type: z.literal("chat.timeline.upsert"),
  threadId: z.string(),
  rows: z.array(ChatTimelineRowZ),
  order: z.array(z.string()),
  seq: z.number().int().nonnegative().optional(),
});

const ChatTimelineResetFrameZ = z.object({
  type: z.literal("chat.timeline.reset"),
  threadId: z.string(),
  rows: z.array(ChatTimelineRowZ),
  seq: z.number().int().nonnegative().optional(),
});

const ChatPermissionRequestFrameZ = z.object({
  type: z.literal("chat.permission.request"),
  threadId: z.string(),
  requestId: z.string(),
  toolCall: z.object({ toolCallId: z.string(), title: z.string() }).passthrough(),
  options: z.array(
    z.object({
      optionId: z.string(),
      name: z.string(),
      kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
    }),
  ),
});

export const ServerFrameSchemaZ = z.discriminatedUnion("type", [
  HelloFrameZ,
  SnapshotFrameZ,
  TaskChangedFrameZ,
  MissionChangedFrameZ,
  MilestoneChangedFrameZ,
  GoalChangedFrameZ,
  AgentChangedFrameZ,
  EventAppendedFrameZ,
  SessionsChangedFrameZ,
  ProjectsChangedFrameZ,
  InitOutputFrameZ,
  InitErrorFrameZ,
  PongFrameZ,
  ActionCompleteFrameZ,
  SkillsChangedFrameZ,
  ValidationChangedFrameZ,
  ConfigChangedFrameZ,
  TerminalsChangedFrameZ,
  FileChangedFrameZ,
  ChatThreadUpdateFrameZ,
  ChatThreadUsageFrameZ,
  ChatThreadStopFrameZ,
  ChatThreadIndexFrameZ,
  ChatPermissionRequestFrameZ,
  ChatTimelineUpsertFrameZ,
  ChatTimelineResetFrameZ,
  WorkspaceAddedFrameSchemaZ,
  WorkspaceRemovedFrameSchemaZ,
]);

export type ServerFrame = z.infer<typeof ServerFrameSchemaZ>;
