/**
 * Translates the production runtime's legacy v1 wire events
 * (chat.thread.update / chat.thread.stop) into the canonical v2
 * chat events that the dashboard's chat-v2 store consumes
 * (chat.activity.appended / chat.turn.completed).
 *
 * Why this exists: thread-manager.ts (the production emitter) was
 * written against the v1 ChatBusEvent shape from contracts. The
 * dashboard's chat-v2 store was written against the v2
 * `ChatThreadEvent` shape (contracts/chat-thread.ts) — its reducer
 * `applyEvent` only handles v2 types and drops everything else.
 *
 * Meanwhile chat-integration-harness.ts has a full v2 emitter
 * pipeline (activity-log, turn-store) but isn't wired into
 * production. Migrating thread-manager to the harness is a multi-day
 * refactor; this translator is the minimum bridge that lets the
 * existing production pipeline drive a v2-shaped client today.
 *
 * Idempotency: activity.id is derived from threadId + seq so the
 * dashboard reducer's dedup-by-id path will drop replays. seq passes
 * through from chat.thread.update so the client's lastSeqByThread
 * gate stays correct.
 *
 * Drop after: thread-manager learns to emit v2 events natively, or
 * the production runtime switches to chat-integration-harness.
 */

import type { ChatEvent } from "./types.ts";

type ThreadActivityTone = "info" | "tool" | "approval" | "error";

interface ThreadActivityShape {
  id: string;
  tone: ThreadActivityTone;
  kind: string;
  summary: string;
  payload: unknown;
  turnId: string | null;
  sequence: number;
  createdAt: string;
}

interface ChatThreadUpdateEventShape {
  type: "chat.thread.update";
  threadId: string;
  update: { sessionUpdate?: string } & Record<string, unknown>;
  seq: number;
}

interface ChatThreadStopEventShape {
  type: "chat.thread.stop";
  threadId: string;
  promptId: string;
  stopReason: string;
}

function isChatThreadUpdate(event: ChatEvent): event is ChatEvent & ChatThreadUpdateEventShape {
  return event.type === "chat.thread.update";
}

function isChatThreadStop(event: ChatEvent): event is ChatEvent & ChatThreadStopEventShape {
  return event.type === "chat.thread.stop";
}

interface UpdateSummary {
  kind: string;
  tone: ThreadActivityTone;
  summary: string;
}

/**
 * Summarize a SessionUpdate the same way the dashboard's
 * threadStateToActivities does — keeps live-streamed activities and
 * post-reload-hydrated activities visually identical.
 */
function summarizeUpdate(
  update: { sessionUpdate?: string } & Record<string, unknown>,
): UpdateSummary {
  const sessionUpdate = update.sessionUpdate;
  switch (sessionUpdate) {
    case "agent_message_chunk": {
      const block = (update as { content?: { text?: string } }).content;
      const text = typeof block?.text === "string" ? block.text : "";
      return { kind: "agent_message", tone: "info", summary: text || "(streaming)" };
    }
    case "agent_thought_chunk":
      return { kind: "agent_thought", tone: "info", summary: "(thought)" };
    case "user_message_chunk": {
      const block = (update as { content?: { text?: string } }).content;
      return { kind: "user_message", tone: "info", summary: block?.text ?? "" };
    }
    case "tool_call": {
      const title = (update as { title?: string }).title ?? "tool";
      return { kind: "tool_call", tone: "tool", summary: title };
    }
    case "tool_call_update": {
      const title = (update as { title?: string | null }).title ?? "tool update";
      const status = (update as { status?: string | null }).status;
      return {
        kind: "tool_call_update",
        tone: status === "failed" ? "error" : "tool",
        summary: status ? `${title} · ${status}` : title,
      };
    }
    case "plan":
      return { kind: "plan", tone: "info", summary: "plan updated" };
    case "available_commands_update":
      return { kind: "commands", tone: "info", summary: "commands updated" };
    case "current_mode_update":
      return { kind: "mode", tone: "info", summary: "mode updated" };
    default:
      return { kind: sessionUpdate || "update", tone: "info", summary: "" };
  }
}

/**
 * Translate a single legacy wire event into 0+ v2 wire events.
 * Returns an empty array for events that don't need translation
 * (already v2, or v1 events without a v2 counterpart).
 */
export function translateLegacyToV2(event: ChatEvent): ChatEvent[] {
  if (isChatThreadUpdate(event)) {
    const meta = summarizeUpdate(event.update);
    const activity: ThreadActivityShape = {
      id: `legacy:${event.threadId}:${event.seq}`,
      tone: meta.tone,
      kind: meta.kind,
      summary: meta.summary,
      payload: event.update,
      // turnId stays null until thread-manager grows native turn
      // tracking — the dashboard's group-by-turn renders these as
      // ambient activities, which is acceptable until turn-store is
      // wired in.
      turnId: null,
      sequence: event.seq,
      createdAt: new Date().toISOString(),
    };
    return [
      {
        type: "chat.activity.appended",
        threadId: event.threadId,
        activity,
        seq: event.seq,
      } as unknown as ChatEvent,
    ];
  }

  if (isChatThreadStop(event)) {
    // chat.thread.stop has no turnId in the legacy shape, so we can't
    // emit a tight chat.turn.completed yet. Production runs without
    // turn tracking; the dashboard's group rendering keeps streamed
    // activities visible regardless. Skip for now — flagged for the
    // follow-up when thread-manager grows a turn lifecycle.
    return [];
  }

  return [];
}
