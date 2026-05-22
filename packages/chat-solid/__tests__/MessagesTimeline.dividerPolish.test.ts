/**
 * Polish helpers added on top of CHAT-4's work-group derivation:
 *
 *   - `findActiveCompletionDividerEntryId` — auto-detect the last
 *     completed assistant turn so the divider lands without the host
 *     having to track it.
 *   - `formatTurnDuration` — humanized elapsed string for the
 *     divider label ("Completed in 3.2s", "Completed in 12m").
 *   - `deriveRevertTurnCounts` — per-user-message revert count
 *     ready to slot into `deriveMessagesTimelineRows`.
 *   - `completionTurnStartedAt` plumbed through the derivation so
 *     the renderer can compute its duration label without re-
 *     reading the entry list.
 */

import { describe, expect, it } from "vitest";
import {
  deriveMessagesTimelineRows,
  deriveRevertTurnCounts,
  findActiveCompletionDividerEntryId,
  formatTurnDuration,
  type TimelineSourceEntry,
} from "../src/components/MessagesTimeline.logic";
import type { ChatMessage, MessagesTimelineRow } from "../src/types";

function userMessage(id: string, ts: string): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: ts,
    content: [{ type: "text", text: "go" }],
  };
}

function assistantMessage(
  id: string,
  ts: string,
  overrides: Partial<Extract<ChatMessage, { role: "assistant" }>> = {},
): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: ts,
    streaming: false,
    text: "done",
    toolCalls: [],
    ...overrides,
  };
}

describe("findActiveCompletionDividerEntryId", () => {
  it("returns the id of the last non-streaming assistant message", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: "t1", message: userMessage("um1", "t1") },
      { kind: "message", id: "a1", createdAt: "t2", message: assistantMessage("am1", "t2") },
      { kind: "message", id: "u2", createdAt: "t3", message: userMessage("um2", "t3") },
      { kind: "message", id: "a2", createdAt: "t4", message: assistantMessage("am2", "t4") },
    ];
    expect(findActiveCompletionDividerEntryId(entries)).toBe("a2");
  });

  it("skips streaming assistant messages", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: "t1", message: userMessage("um1", "t1") },
      { kind: "message", id: "a1", createdAt: "t2", message: assistantMessage("am1", "t2") },
      { kind: "message", id: "u2", createdAt: "t3", message: userMessage("um2", "t3") },
      {
        kind: "message",
        id: "a2",
        createdAt: "t4",
        message: assistantMessage("am2", "t4", { streaming: true }),
      },
    ];
    expect(findActiveCompletionDividerEntryId(entries)).toBe("a1");
  });

  it("returns null when no closed turn exists", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: "t1", message: userMessage("um1", "t1") },
      {
        kind: "message",
        id: "a1",
        createdAt: "t2",
        message: assistantMessage("am1", "t2", { streaming: true }),
      },
    ];
    expect(findActiveCompletionDividerEntryId(entries)).toBeNull();
    expect(findActiveCompletionDividerEntryId([])).toBeNull();
  });
});

describe("formatTurnDuration", () => {
  const start = "2026-05-14T10:00:00.000Z";
  it("returns millisecond units below 1s", () => {
    expect(formatTurnDuration(start, "2026-05-14T10:00:00.500Z")).toBe("500ms");
  });
  it("returns seconds with one decimal below 60s", () => {
    expect(formatTurnDuration(start, "2026-05-14T10:00:03.200Z")).toBe("3.2s");
  });
  it("returns minutes below 1h", () => {
    expect(formatTurnDuration(start, "2026-05-14T10:30:00.000Z")).toBe("30m");
  });
  it("returns hours past 1h", () => {
    expect(formatTurnDuration(start, "2026-05-14T13:30:00.000Z")).toBe("3.5h");
  });
  it("returns null for invalid or negative spans", () => {
    expect(formatTurnDuration(start, "bogus")).toBeNull();
    expect(formatTurnDuration("2026-05-14T10:00:01.000Z", start)).toBeNull();
  });
});

describe("deriveRevertTurnCounts", () => {
  it("counts completed assistant turns sitting BELOW each user message", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: "t1", message: userMessage("um1", "t1") },
      { kind: "message", id: "a1", createdAt: "t2", message: assistantMessage("am1", "t2") },
      { kind: "message", id: "u2", createdAt: "t3", message: userMessage("um2", "t3") },
      { kind: "message", id: "a2", createdAt: "t4", message: assistantMessage("am2", "t4") },
      { kind: "message", id: "u3", createdAt: "t5", message: userMessage("um3", "t5") },
      { kind: "message", id: "a3", createdAt: "t6", message: assistantMessage("am3", "t6") },
    ];
    const counts = deriveRevertTurnCounts(entries);
    // u1 has 2 completed turns AFTER its own — reverting nukes them.
    expect(counts.get("um1")).toBe(2);
    // u2 has 1 completed turn AFTER its own.
    expect(counts.get("um2")).toBe(1);
    // u3 is the latest — reverting from it is a no-op, so we drop it.
    expect(counts.get("um3")).toBeUndefined();
  });

  it("returns an empty map when no turns are completed", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: "t1", message: userMessage("um1", "t1") },
    ];
    expect(deriveRevertTurnCounts(entries).size).toBe(0);
  });

  it("ignores streaming assistant messages when counting", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: "t1", message: userMessage("um1", "t1") },
      {
        kind: "message",
        id: "a1",
        createdAt: "t2",
        message: assistantMessage("am1", "t2", { streaming: true }),
      },
      { kind: "message", id: "u2", createdAt: "t3", message: userMessage("um2", "t3") },
    ];
    expect(deriveRevertTurnCounts(entries).size).toBe(0);
  });
});

describe("deriveMessagesTimelineRows — completionTurnStartedAt", () => {
  it("stamps the divider'd assistant row with the matching user turn start", () => {
    const userTs = "2026-05-14T10:00:00.000Z";
    const assistantTs = "2026-05-14T10:00:03.000Z";
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "u1", createdAt: userTs, message: userMessage("um1", userTs) },
      {
        kind: "message",
        id: "a1",
        createdAt: assistantTs,
        message: assistantMessage("am1", assistantTs),
      },
    ];
    const rows = deriveMessagesTimelineRows({
      entries,
      completionDividerBeforeEntryId: "a1",
    });
    const a = rows[1] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(a.showCompletionDivider).toBe(true);
    expect(a.completionTurnStartedAt).toBe(userTs);
  });

  it("does not stamp completionTurnStartedAt when no divider is set", () => {
    const entries: TimelineSourceEntry[] = [
      {
        kind: "message",
        id: "u1",
        createdAt: "t1",
        message: userMessage("um1", "t1"),
      },
      {
        kind: "message",
        id: "a1",
        createdAt: "t2",
        message: assistantMessage("am1", "t2"),
      },
    ];
    const rows = deriveMessagesTimelineRows({ entries });
    const a = rows[1] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(a.showCompletionDivider).toBeUndefined();
    expect(a.completionTurnStartedAt).toBeUndefined();
  });
});
