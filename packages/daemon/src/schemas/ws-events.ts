/**
 * Protocol contracts for the unified `/ws/events` WebSocket channel.
 *
 * Single push channel clients subscribe to for session / pane / workspace
 * changes. One socket replaces a fan of individual SSE streams that hit
 * Chrome's 6-per-origin HTTP/1.1 limit.
 *
 * Add new frame variants by appending to the union; do not rename existing
 * fields.
 */

import { z } from "zod";
import { SessionOverviewSchemaZ } from "./domain.ts";
import { WorkspaceAddedFrameSchemaZ, WorkspaceRemovedFrameSchemaZ } from "@tmux-ide/contracts";

// ---------------------------------------------------------------------------
// Snapshot payload — mirrors what `/api/project/<name>/stream` already pushes
// as its `snapshot` SSE event. Kept loose (passthrough) so that adding fields
// on the producer side does not require shipping schema updates lock-step
// with consumers. Consumers should validate fields they actually read.
// ---------------------------------------------------------------------------

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

// Broadcast after a successful v2 action dispatch. Clients use these frames to
// invalidate caches without ad-hoc refetches (e.g. invalidate the project list
// after `project.launch` succeeds). `name` matches the action name in
// `command-center/actions/contract.ts`. `result` is loose at the schema layer
// because each action has its own result shape.
const ActionCompleteFrameZ = z.object({
  type: z.literal("action.complete"),
  name: z.string(),
  result: z.unknown(),
});

const ConfigChangedFrameZ = z.object({
  type: z.literal("config.changed"),
  sessionName: z.string(),
});

const TerminalsChangedFrameZ = z.object({
  type: z.literal("terminals.changed"),
  sessionName: z.string(),
});

export const ServerFrameSchemaZ = z.discriminatedUnion("type", [
  HelloFrameZ,
  SnapshotFrameZ,
  SessionsChangedFrameZ,
  ProjectsChangedFrameZ,
  InitOutputFrameZ,
  InitErrorFrameZ,
  PongFrameZ,
  ActionCompleteFrameZ,
  ConfigChangedFrameZ,
  TerminalsChangedFrameZ,
  WorkspaceAddedFrameSchemaZ,
  WorkspaceRemovedFrameSchemaZ,
]);

export type ServerFrame = z.infer<typeof ServerFrameSchemaZ>;
