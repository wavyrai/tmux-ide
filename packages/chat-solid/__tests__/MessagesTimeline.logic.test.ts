/**
 * Pure-logic tests for MessagesTimeline.logic.
 *
 * No Solid, no DOM. Each helper is exercised with a small fixture so
 * the renderer can stay narrow.
 */

import { describe, expect, it } from "vitest";
import {
  deriveMessageTone,
  deriveTerminalAssistantMessageIds,
  formatTimestamp,
  messageRows,
  resolveAssistantCopyState,
  rowSignature,
  summarizeToolCalls,
} from "../src/components/MessagesTimeline.logic";
import type { ChatMessage, MessagesTimelineRow, ToolCallView } from "../src/types";

function userMsg(id: string, text = "hi"): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-05-13T08:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

function assistantMsg(
  id: string,
  overrides: Partial<Extract<ChatMessage, { role: "assistant" }>> = {},
): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-05-13T08:00:00.000Z",
    streaming: false,
    text: "reply",
    toolCalls: [],
    ...overrides,
  };
}

function messageRow(message: ChatMessage): MessagesTimelineRow {
  return { kind: "message", id: message.id, createdAt: message.createdAt, message };
}

describe("MessagesTimeline.logic", () => {
  describe("rowSignature", () => {
    it("hashes assistant rows on text/thought/tool fingerprints", () => {
      const a = messageRow(assistantMsg("a", { text: "one", streaming: true }));
      const b = messageRow(assistantMsg("a", { text: "one two", streaming: true }));
      expect(rowSignature(a)).not.toBe(rowSignature(b));
    });

    it("hashes user rows on content-block count", () => {
      const a = messageRow(userMsg("u1", "hi"));
      const b = messageRow(userMsg("u1", "hi"));
      expect(rowSignature(a)).toBe(rowSignature(b));
    });

    it("returns stable signatures for working + plan rows", () => {
      const working: MessagesTimelineRow = {
        kind: "working",
        id: "w1",
        createdAt: "2026-05-13T08:00:00.000Z",
      };
      const plan: MessagesTimelineRow = {
        kind: "plan",
        id: "p1",
        createdAt: "2026-05-13T08:00:00.000Z",
        entries: [{ content: "ship", status: "in_progress" }],
      };
      expect(rowSignature(working)).toBe("w1:working");
      expect(rowSignature(plan)).toContain("plan:ship:in_progress");
    });
  });

  describe("deriveTerminalAssistantMessageIds", () => {
    it("returns the last assistant id per user-prompt cursor when turns are unkeyed", () => {
      const rows = [
        messageRow(userMsg("u1")),
        messageRow(assistantMsg("a1a")),
        messageRow(assistantMsg("a1b")),
        messageRow(userMsg("u2")),
        messageRow(assistantMsg("a2a")),
      ];
      const ids = deriveTerminalAssistantMessageIds(rows);
      expect(ids.has("a1b")).toBe(true);
      expect(ids.has("a1a")).toBe(false);
      expect(ids.has("a2a")).toBe(true);
    });

    it("returns the last assistant id per turnId when present", () => {
      const rows = [
        messageRow(userMsg("u1")),
        messageRow({ ...assistantMsg("a1"), turnId: "t1" } as ChatMessage),
        messageRow({ ...assistantMsg("a2"), turnId: "t1" } as ChatMessage),
        messageRow({ ...assistantMsg("a3"), turnId: "t2" } as ChatMessage),
      ];
      const ids = deriveTerminalAssistantMessageIds(rows);
      expect(ids.has("a2")).toBe(true);
      expect(ids.has("a3")).toBe(true);
      expect(ids.has("a1")).toBe(false);
    });
  });

  describe("resolveAssistantCopyState", () => {
    it("hides while streaming", () => {
      const state = resolveAssistantCopyState({
        text: "hi",
        showCopyButton: true,
        streaming: true,
      });
      expect(state.visible).toBe(false);
    });
    it("hides when the message has no text", () => {
      const state = resolveAssistantCopyState({
        text: "   ",
        showCopyButton: true,
        streaming: false,
      });
      expect(state.visible).toBe(false);
      expect(state.text).toBe(null);
    });
    it("shows when terminal, non-streaming, has text", () => {
      const state = resolveAssistantCopyState({
        text: "ok",
        showCopyButton: true,
        streaming: false,
      });
      expect(state.visible).toBe(true);
      expect(state.text).toBe("ok");
    });
    it("hides when not a terminal message", () => {
      const state = resolveAssistantCopyState({
        text: "ok",
        showCopyButton: false,
        streaming: false,
      });
      expect(state.visible).toBe(false);
    });
  });

  describe("summarizeToolCalls", () => {
    const call = (status: ToolCallView["status"]): ToolCallView => ({
      toolCallId: status,
      title: "tool",
      status,
      content: [],
    });
    it("counts + flags failures", () => {
      expect(summarizeToolCalls([call("failed"), call("completed")])).toEqual({
        count: 2,
        hasFailure: true,
        hasInProgress: false,
      });
    });
    it("flags in-flight when pending/in_progress present", () => {
      expect(summarizeToolCalls([call("in_progress")])).toEqual({
        count: 1,
        hasFailure: false,
        hasInProgress: true,
      });
    });
    it("returns zero counts for empty list", () => {
      expect(summarizeToolCalls([])).toEqual({ count: 0, hasFailure: false, hasInProgress: false });
    });
  });

  describe("deriveMessageTone", () => {
    it("maps user → user, assistant → assistant", () => {
      expect(deriveMessageTone(userMsg("u"))).toBe("user");
      expect(deriveMessageTone(assistantMsg("a"))).toBe("assistant");
    });
  });

  describe("formatTimestamp", () => {
    it("returns empty string for missing input", () => {
      expect(formatTimestamp(undefined)).toBe("");
      expect(formatTimestamp(null)).toBe("");
      expect(formatTimestamp("not-a-date")).toBe("");
    });
    it("formats a valid iso into h:mm", () => {
      expect(formatTimestamp("2026-05-13T08:42:00.000Z")).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe("messageRows filter", () => {
    it("drops working + plan rows", () => {
      const rows: MessagesTimelineRow[] = [
        messageRow(userMsg("u1")),
        { kind: "working", id: "w", createdAt: "" },
        { kind: "plan", id: "p", createdAt: "", entries: [] },
      ];
      expect(messageRows(rows)).toHaveLength(1);
    });
  });
});
