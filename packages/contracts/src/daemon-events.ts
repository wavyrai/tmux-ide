import { z } from "zod";
import {
  DaemonProjectResponseSchemaZ,
  DaemonSessionOverviewSchemaZ,
  DaemonWorkspaceSchemaZ,
} from "./daemon-resources.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";

/** Shared, browser-safe protocol for the daemon's unified /ws/events socket. */

const SessionNamesSchemaZ = z.array(z.string());

export const DaemonEventSubscribeFrameSchemaZ = z
  .object({
    type: z.literal("subscribe"),
    sessions: SessionNamesSchemaZ,
  })
  .strict();

export const DaemonEventUnsubscribeFrameSchemaZ = z
  .object({
    type: z.literal("unsubscribe"),
    sessions: SessionNamesSchemaZ,
  })
  .strict();

export const DaemonEventPingFrameSchemaZ = z.object({ type: z.literal("ping") }).strict();

export const DaemonEventClientFrameSchemaZ = z.discriminatedUnion("type", [
  DaemonEventSubscribeFrameSchemaZ,
  DaemonEventUnsubscribeFrameSchemaZ,
  DaemonEventPingFrameSchemaZ,
]);
export type DaemonEventClientFrame = z.infer<typeof DaemonEventClientFrameSchemaZ>;

export const DaemonSessionSnapshotSchemaZ = z
  .object({
    project: DaemonProjectResponseSchemaZ,
  })
  .strict();
export type DaemonSessionSnapshot = z.infer<typeof DaemonSessionSnapshotSchemaZ>;

export const DaemonEventHelloFrameSchemaZ = z
  .object({
    type: z.literal("hello"),
    daemon: DaemonInstanceIdentitySchemaZ,
    sessions: z.array(DaemonSessionOverviewSchemaZ),
  })
  .strict();

export const DaemonEventSnapshotFrameSchemaZ = z
  .object({
    type: z.literal("snapshot"),
    sessionName: z.string(),
    data: DaemonSessionSnapshotSchemaZ,
  })
  .strict();

export const DaemonEventSessionsChangedFrameSchemaZ = z
  .object({ type: z.literal("sessions.changed") })
  .strict();

export const DaemonEventProjectsChangedFrameSchemaZ = z
  .object({ type: z.literal("projects.changed") })
  .strict();

export const DaemonEventInitOutputFrameSchemaZ = z
  .object({
    type: z.literal("init.output"),
    jobId: z.string(),
    chunk: z.string(),
    done: z.boolean().optional(),
  })
  .strict();

export const DaemonEventInitErrorFrameSchemaZ = z
  .object({
    type: z.literal("init.error"),
    jobId: z.string(),
    message: z.string(),
  })
  .strict();

export const DaemonEventPongFrameSchemaZ = z.object({ type: z.literal("pong") }).strict();

export const DaemonEventActionCompleteFrameSchemaZ = z
  .object({
    type: z.literal("action.complete"),
    name: z.string(),
    result: z.unknown(),
  })
  .strict();

export const DaemonEventConfigChangedFrameSchemaZ = z
  .object({
    type: z.literal("config.changed"),
    sessionName: z.string(),
  })
  .strict();

export const DaemonEventTerminalsChangedFrameSchemaZ = z
  .object({
    type: z.literal("terminals.changed"),
    sessionName: z.string(),
  })
  .strict();

export const DaemonEventWorkspaceAddedFrameSchemaZ = z
  .object({
    type: z.literal("workspace.added"),
    workspace: DaemonWorkspaceSchemaZ,
  })
  .strict();

export const DaemonEventWorkspaceRemovedFrameSchemaZ = z
  .object({
    type: z.literal("workspace.removed"),
    name: z.string(),
  })
  .strict();

export const DaemonEventProtocolErrorCodeSchemaZ = z.enum(["invalid-json", "invalid-frame"]);
export type DaemonEventProtocolErrorCode = z.infer<typeof DaemonEventProtocolErrorCodeSchemaZ>;

export const DaemonEventProtocolErrorFrameSchemaZ = z
  .object({
    type: z.literal("protocol.error"),
    code: DaemonEventProtocolErrorCodeSchemaZ,
    message: z.string(),
  })
  .strict();

export const DaemonEventServerFrameSchemaZ = z.discriminatedUnion("type", [
  DaemonEventHelloFrameSchemaZ,
  DaemonEventSnapshotFrameSchemaZ,
  DaemonEventSessionsChangedFrameSchemaZ,
  DaemonEventProjectsChangedFrameSchemaZ,
  DaemonEventInitOutputFrameSchemaZ,
  DaemonEventInitErrorFrameSchemaZ,
  DaemonEventPongFrameSchemaZ,
  DaemonEventActionCompleteFrameSchemaZ,
  DaemonEventConfigChangedFrameSchemaZ,
  DaemonEventTerminalsChangedFrameSchemaZ,
  DaemonEventWorkspaceAddedFrameSchemaZ,
  DaemonEventWorkspaceRemovedFrameSchemaZ,
  DaemonEventProtocolErrorFrameSchemaZ,
]);
export type DaemonEventServerFrame = z.infer<typeof DaemonEventServerFrameSchemaZ>;
