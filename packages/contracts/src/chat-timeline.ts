/**
 * Server-materialized chat timeline.
 *
 * The daemon reduces ACP session-update chunks into the canonical
 * transcript (one object per message, streaming text append-grown in
 * place) and the dashboard / chat-solid render it directly — no
 * client-side reduction. This module is the wire shape for that
 * materialized projection:
 *
 *   - `chat.thread.get` returns `timeline: TimelineRow[]` alongside the
 *     raw `thread` (the durable event log stays untouched).
 *   - The daemon broadcasts `chat.timeline.upsert` / `chat.timeline.reset`
 *     deltas as a turn streams; the client merges by row id.
 *
 * Shapes mirror chat-solid's `MessagesTimelineRow` 1:1 so the renderer
 * consumes the payload without a translation layer. Loose `z.unknown()`
 * is used for content/tool payloads (already opaque passthrough on the
 * legacy `SessionUpdate` contract) so the dispatcher's result validation
 * never rejects a structurally-valid frame.
 */

import { z } from "zod";

const IsoDateTimeZ = z.string().min(1);

// Content blocks / tool payloads ride through opaque — they are already
// `.passthrough()` on the legacy ContentBlock/SessionUpdate contracts.
const OpaqueBlockZ = z.unknown();

export const TimelineToolCallZ = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "failed"]),
  content: z.array(OpaqueBlockZ),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});
export type TimelineToolCall = z.infer<typeof TimelineToolCallZ>;

export const TimelinePlanEntryZ = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]).optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});
export type TimelinePlanEntry = z.infer<typeof TimelinePlanEntryZ>;

export const TimelineUserMessageZ = z.object({
  id: z.string(),
  role: z.literal("user"),
  createdAt: IsoDateTimeZ,
  content: z.array(OpaqueBlockZ),
});

export const TimelineAssistantMessageZ = z.object({
  id: z.string(),
  role: z.literal("assistant"),
  createdAt: IsoDateTimeZ,
  completedAt: IsoDateTimeZ.optional(),
  streaming: z.boolean(),
  text: z.string(),
  thoughtText: z.string().optional(),
  toolCalls: z.array(TimelineToolCallZ),
  // Loose: passes through ACP stop reasons verbatim.
  stopReason: z.string().optional(),
});

export const TimelineMessageZ = z.discriminatedUnion("role", [
  TimelineUserMessageZ,
  TimelineAssistantMessageZ,
]);
export type TimelineMessage = z.infer<typeof TimelineMessageZ>;

export const TimelineRowZ = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message"),
    id: z.string(),
    createdAt: IsoDateTimeZ,
    message: TimelineMessageZ,
    revertTurnCount: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("plan"),
    id: z.string(),
    createdAt: IsoDateTimeZ,
    entries: z.array(TimelinePlanEntryZ),
  }),
  z.object({
    kind: z.literal("working"),
    id: z.string(),
    createdAt: IsoDateTimeZ,
  }),
]);
export type TimelineRow = z.infer<typeof TimelineRowZ>;

// ---------------------------------------------------------------------------
// WS deltas. Not added to the strict `ChatThreadEventZ` discriminated
// union (that golden is pinned by chat-thread.test.ts) — the daemon's
// `ChatEvent` union carries these directly and `/ws/events` forwards
// them raw, so a Zod variant is unnecessary. Types only.
// ---------------------------------------------------------------------------

/**
 * Per-thread monotonic sequence stamped on every materialized timeline
 * frame by the daemon's broadcast layer (Step 2: WS reconnect/resume).
 * The client tracks the last applied `seq`; on (re)connect it sends a
 * `ChatResumeSubscribe` carrying that value and the daemon replays the
 * missed frames in order. Optional on the type because producers
 * (message-pipe) construct frames without it — the broadcast choke
 * point assigns it before the bytes leave the daemon, so on the wire it
 * is always present.
 */
export type ChatTimelineSeq = number;

/**
 * Incremental delta: `rows` are the changed/added rows; `order` is the
 * full authoritative ordered list of row ids. The client reuses prior
 * row objects for ids absent from `rows` (referential stability) and
 * splices to `order`.
 */
export interface ChatTimelineUpsertEvent {
  type: "chat.timeline.upsert";
  threadId: string;
  rows: TimelineRow[];
  order: string[];
  seq?: ChatTimelineSeq;
}

/** Full replacement — bootstrap after a structural rewind (editFromTurn)
 *  or the baseline snapshot a resuming client receives. A reset is a new
 *  per-thread baseline: it supersedes every earlier buffered frame. */
export interface ChatTimelineResetEvent {
  type: "chat.timeline.reset";
  threadId: string;
  rows: TimelineRow[];
  seq?: ChatTimelineSeq;
}

export type ChatTimelineEvent = ChatTimelineUpsertEvent | ChatTimelineResetEvent;

// ---------------------------------------------------------------------------
// Client → server resume subscribe. Sent on every (re)connect: the
// daemon replays buffered materialized timeline frames for `threadId`
// with `seq > lastSeq`, in order, then resumes live. `lastSeq: 0`
// (or omitted) means "give me everything buffered for this thread".
// Strict — an unknown key is a protocol bug, not a silent no-op.
// ---------------------------------------------------------------------------

export const ChatResumeSubscribeZ = z
  .object({
    type: z.literal("chat.subscribe"),
    threadId: z.string().min(1),
    lastSeq: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChatResumeSubscribe = z.infer<typeof ChatResumeSubscribeZ>;
