/**
 * Regression test for the v1 → v2 wire-event bridge.
 *
 * Pre-fix: thread-manager's `chat.thread.update` events were broadcast
 * to /ws/events but the dashboard's chat-v2 store ignored them
 * (filter list only covers v2 types). Live assistant streaming never
 * surfaced in the UI without a reload.
 *
 * Post-fix: each chat.thread.update with a renderable SessionUpdate
 * yields a paired chat.activity.appended that the dashboard reducer
 * consumes verbatim.
 */

import { describe, expect, it } from "vitest";
import { translateLegacyToV2 } from "./legacy-to-v2.ts";
import type { ChatEvent } from "./types.ts";

function update(sessionUpdate: string, extra: Record<string, unknown> = {}): ChatEvent {
  return {
    type: "chat.thread.update",
    threadId: "t1",
    update: { sessionUpdate, ...extra } as never,
    seq: 17,
  } as unknown as ChatEvent;
}

describe("translateLegacyToV2", () => {
  it("translates agent_message_chunk into chat.activity.appended with the streamed text", () => {
    const out = translateLegacyToV2(
      update("agent_message_chunk", { content: { text: "hello world" } }),
    );
    expect(out).toHaveLength(1);
    const ev = out[0] as {
      type: string;
      threadId: string;
      activity: Record<string, unknown>;
      seq: number;
    };
    expect(ev.type).toBe("chat.activity.appended");
    expect(ev.threadId).toBe("t1");
    expect(ev.seq).toBe(17);
    expect(ev.activity.kind).toBe("agent_message");
    expect(ev.activity.tone).toBe("info");
    expect(ev.activity.summary).toBe("hello world");
    expect(ev.activity.turnId).toBeNull();
    // Deterministic id so the dashboard reducer's dedup-by-id path
    // drops replays cleanly.
    expect(ev.activity.id).toBe("legacy:t1:17");
    expect(ev.activity.sequence).toBe(17);
  });

  it("maps tool_call into a tool-toned activity carrying the call title", () => {
    const out = translateLegacyToV2(update("tool_call", { title: "Read", toolCallId: "tc1" }));
    expect(out).toHaveLength(1);
    const ev = out[0] as { activity: Record<string, unknown> };
    expect(ev.activity.kind).toBe("tool_call");
    expect(ev.activity.tone).toBe("tool");
    expect(ev.activity.summary).toBe("Read");
  });

  it("flags failed tool_call_update as error tone", () => {
    const out = translateLegacyToV2(
      update("tool_call_update", { title: "Edit", status: "failed" }),
    );
    const ev = out[0] as { activity: Record<string, unknown> };
    expect(ev.activity.kind).toBe("tool_call_update");
    expect(ev.activity.tone).toBe("error");
    expect(ev.activity.summary).toBe("Edit · failed");
  });

  it("falls back to a streaming placeholder for agent_message_chunk without text", () => {
    const out = translateLegacyToV2(update("agent_message_chunk", { content: {} }));
    const ev = out[0] as { activity: Record<string, unknown> };
    expect(ev.activity.summary).toBe("(streaming)");
  });

  it("returns an empty array for chat.thread.stop until turn tracking lands", () => {
    const out = translateLegacyToV2({
      type: "chat.thread.stop",
      threadId: "t1",
      promptId: "p1",
      stopReason: "end_turn",
    } as unknown as ChatEvent);
    expect(out).toEqual([]);
  });

  it("returns an empty array for events that already are v2", () => {
    const out = translateLegacyToV2({
      type: "chat.activity.appended",
      threadId: "t1",
      activity: {
        id: "a1",
        tone: "info",
        kind: "agent_message",
        summary: "x",
        payload: null,
        turnId: null,
        sequence: 0,
        createdAt: new Date().toISOString(),
      },
      seq: 0,
    } as unknown as ChatEvent);
    expect(out).toEqual([]);
  });
});
