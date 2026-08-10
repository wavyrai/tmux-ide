import { z } from "zod";
import {
  DaemonProjectResponseSchemaZ,
  DaemonSessionOverviewSchemaZ,
  DaemonWorkspaceSchemaZ,
} from "./daemon-resources.ts";
import { DaemonInstanceIdentitySchemaZ } from "./daemon-wire.ts";
import { DesktopWorkspaceNameSchemaZ } from "./desktop-host.ts";
import { InteractionReceiptSchemaZ } from "./interaction-receipts.ts";

/** Shared, browser-safe protocol for the daemon's unified /ws/events socket. */

const SessionNamesSchemaZ = z.array(z.string());

export const DaemonEventSubscribeFrameSchemaZ = z
  .object({
    type: z.literal("subscribe"),
    sessions: SessionNamesSchemaZ,
    /**
     * Last resource-event sequence the client applied for this daemon
     * generation. Omitted by legacy clients. The daemon either replays every
     * later retained event or answers `snapshot-required` when the bounded
     * journal no longer covers the requested cursor.
     */
    afterSequence: z.number().int().nonnegative().optional(),
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
    /** Current head of the generation-scoped resource-event journal. */
    eventSequence: z.number().int().nonnegative().optional(),
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

/** Resources that can be invalidated without making every client refetch. */
export const DaemonEventResourceKindSchemaZ = z.enum([
  "workspace-catalog",
  "fleet-catalog",
  "application-shell",
  "workspace-files",
  "workspace-changes",
]);
export type DaemonEventResourceKind = z.infer<typeof DaemonEventResourceKindSchemaZ>;

/**
 * Generation-scoped, replayable invalidation. `sequence` orders the journal;
 * `revision` strictly orders changes to one workspace/resource projection. No
 * path, tmux runtime id, or credential crosses it.
 */
export const DaemonEventResourceChangedFrameSchemaZ = z
  .object({
    type: z.literal("resource.changed"),
    sequence: z.number().int().positive(),
    workspaceName: DesktopWorkspaceNameSchemaZ.nullable(),
    resource: DaemonEventResourceKindSchemaZ,
    revision: z.number().int().nonnegative(),
    causeOperationId: z.uuid().nullable(),
  })
  .strict();
export type DaemonEventResourceChangedFrame = z.infer<
  typeof DaemonEventResourceChangedFrameSchemaZ
>;

/** The requested replay cursor fell outside the bounded generation journal. */
export const DaemonEventSnapshotRequiredFrameSchemaZ = z
  .object({
    type: z.literal("snapshot-required"),
    afterSequence: z.number().int().nonnegative(),
    oldestAvailableSequence: z.number().int().positive().nullable(),
    currentSequence: z.number().int().nonnegative(),
    reason: z.enum(["cursor-ahead", "journal-gap"]),
  })
  .strict();
export type DaemonEventSnapshotRequiredFrame = z.infer<
  typeof DaemonEventSnapshotRequiredFrameSchemaZ
>;

/**
 * A pane's ground-truth agent status (`@agent_state`) transitioned inside a
 * session the daemon serves. Session-scoped like `config.changed` /
 * `terminals.changed`: clients that subscribed to `sessionName` re-fetch the
 * application-shell resource so the agent graph reflects the new status without
 * a manual refresh. tmux has no push for option changes, so the daemon polls
 * and coalesces bursts into a single frame per session.
 */
export const DaemonEventAgentStatusChangedFrameSchemaZ = z
  .object({
    type: z.literal("agent-status.changed"),
    sessionName: z.string(),
  })
  .strict();

/**
 * The adopted-session fleet composition changed — a session was adopted or a
 * tmux session disappeared. Fleet-wide (no `sessionName`) like `sessions.changed`:
 * clients re-fetch the whole fleet-catalog resource to pick up the new set of
 * sessions. This is the ONLY frame that covers an adopted-only session (one the
 * app never created, absent from the workspace registry) appearing or vanishing:
 * `workspace.added` / `workspace.removed` are registry-scoped, and
 * `sessions.changed` is derived from registry-gated discovery, so neither fires
 * for the adopted-only fleet. tmux has no push for the session list, so the
 * daemon polls the adopted-session set and coalesces bursts into one frame.
 */
export const DaemonEventFleetChangedFrameSchemaZ = z
  .object({ type: z.literal("fleet.changed") })
  .strict();

/**
 * RECEIPT — a pane's ground-truth agent authority (`@agent_state`) completed a
 * turn: the daemon's agent-status watcher observed `working` transition to
 * `done` or `idle`. Unlike the `agent-status.changed` invalidation (a re-fetch
 * hint), this is a typed completion event a consumer can WAIT on without
 * polling: the dock chip, the fleet sidebar, and `tmux-ide wait agent-status`
 * all want exactly "an agent finished".
 *
 * `agentId` is the wire-safe durable agent identity — the same
 * `agent.<digest>` id the application-shell sidebar mints from the pane's
 * durable `@tmux_ide_pane_id` stamp — or `null` when the pane carries no valid
 * stamp (receipts still fire; correlation is best-effort). No raw tmux
 * runtime id or path ever crosses this frame. `at` is the daemon's
 * observation time (the watcher polls, so it trails the hook stamp by at most
 * one poll interval). One receipt per completing pane per poll tick; the poll
 * interval is a hard emission floor, so a flapping pane cannot storm clients.
 */
export const DaemonEventAgentTurnCompletedFrameSchemaZ = z
  .object({
    type: z.literal("agent.turn-completed"),
    sessionName: z.string(),
    agentId: z
      .string()
      .regex(/^agent\.[0-9a-f]{20}$/u)
      .nullable(),
    fromStatus: z.literal("working"),
    toStatus: z.enum(["done", "idle"]),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DaemonEventAgentTurnCompletedFrame = z.infer<
  typeof DaemonEventAgentTurnCompletedFrameSchemaZ
>;

/**
 * RECEIPT — a workspace promotion action finished successfully. Emitted by the
 * action dispatcher after `workspace.promote` succeeds, alongside the generic
 * `action.complete` frame: `action.complete` carries an untyped result for
 * cache invalidation, while this frame is the bounded, typed completion event
 * (`promoted` = first promotion, `replayed` = idempotent re-dispatch). Carries
 * only the catalog-visible workspace name — no path, tmux session name, or
 * runtime id.
 */
export const DaemonEventWorkspacePromotionCompletedFrameSchemaZ = z
  .object({
    type: z.literal("workspace.promotion-completed"),
    workspaceName: DesktopWorkspaceNameSchemaZ,
    outcome: z.enum(["promoted", "replayed"]),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DaemonEventWorkspacePromotionCompletedFrame = z.infer<
  typeof DaemonEventWorkspacePromotionCompletedFrameSchemaZ
>;

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
  DaemonEventResourceChangedFrameSchemaZ,
  InteractionReceiptSchemaZ,
  DaemonEventSnapshotRequiredFrameSchemaZ,
  DaemonEventAgentStatusChangedFrameSchemaZ,
  DaemonEventAgentTurnCompletedFrameSchemaZ,
  DaemonEventFleetChangedFrameSchemaZ,
  DaemonEventWorkspacePromotionCompletedFrameSchemaZ,
  DaemonEventWorkspaceAddedFrameSchemaZ,
  DaemonEventWorkspaceRemovedFrameSchemaZ,
  DaemonEventProtocolErrorFrameSchemaZ,
]);
export type DaemonEventServerFrame = z.infer<typeof DaemonEventServerFrameSchemaZ>;
