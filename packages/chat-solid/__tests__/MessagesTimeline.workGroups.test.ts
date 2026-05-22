/**
 * Pure-helper coverage for the structural enrichment added to the
 * timeline: work-group collapsing, completion-divider tagging,
 * revert-turn count annotation, and the visible/overflow split.
 *
 * Keeps the renderer untouched — these tests pin the data shape
 * `MessagesTimeline.tsx` consumes so a future refactor of the
 * render code can't silently drop a feature.
 */

import { describe, expect, it } from "vitest";
import {
  deriveMessagesTimelineRows,
  MAX_VISIBLE_WORK_ENTRIES,
  rowSignature,
  splitWorkEntries,
  type TimelineSourceEntry,
} from "../src/components/MessagesTimeline.logic";
import type { ChatMessage, MessagesTimelineRow, WorkLogEntry } from "../src/types";

function userMessage(id: string, text: string, ts = "2026-05-14T10:00:00.000Z"): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: ts,
    content: [{ type: "text", text }],
  };
}

function assistantMessage(id: string, text: string, ts = "2026-05-14T10:00:05.000Z"): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: ts,
    streaming: false,
    text,
    toolCalls: [],
  };
}

function workEntry(id: string, label = `entry ${id}`): WorkLogEntry {
  return { id, label };
}

describe("deriveMessagesTimelineRows", () => {
  it("passes message entries through unchanged when no overlays are set", () => {
    const entries: TimelineSourceEntry[] = [
      {
        kind: "message",
        id: "m1",
        createdAt: "2026-05-14T10:00:00.000Z",
        message: userMessage("u1", "hi"),
      },
      {
        kind: "message",
        id: "m2",
        createdAt: "2026-05-14T10:00:05.000Z",
        message: assistantMessage("a1", "hello"),
      },
    ];
    const rows = deriveMessagesTimelineRows({ entries });
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.kind === "message")).toBe(true);
    const first = rows[0] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(first.showCompletionDivider).toBeUndefined();
    expect(first.revertTurnCount).toBeUndefined();
  });

  it("collapses adjacent work entries into a single row with concatenated entries", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "work", id: "w1", createdAt: "t1", entry: workEntry("e1") },
      { kind: "work", id: "w2", createdAt: "t2", entry: workEntry("e2") },
      { kind: "work", id: "w3", createdAt: "t3", entries: [workEntry("e3"), workEntry("e4")] },
      {
        kind: "message",
        id: "m1",
        createdAt: "t4",
        message: assistantMessage("a1", "ok"),
      },
    ];
    const rows = deriveMessagesTimelineRows({ entries });
    expect(rows.length).toBe(2);
    const workRow = rows[0] as Extract<MessagesTimelineRow, { kind: "work" }>;
    expect(workRow.kind).toBe("work");
    expect(workRow.id).toBe("w1");
    expect(workRow.entries.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4"]);
    expect(rows[1]?.kind).toBe("message");
  });

  it("splits work groups across non-work entries", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "work", id: "w1", createdAt: "t1", entry: workEntry("e1") },
      { kind: "message", id: "m1", createdAt: "t2", message: userMessage("u1", "follow up") },
      { kind: "work", id: "w2", createdAt: "t3", entry: workEntry("e2") },
    ];
    const rows = deriveMessagesTimelineRows({ entries });
    expect(rows.length).toBe(3);
    expect(rows[0]?.kind).toBe("work");
    expect(rows[1]?.kind).toBe("message");
    expect(rows[2]?.kind).toBe("work");
  });

  it("tags the targeted assistant message with showCompletionDivider", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "m-user", createdAt: "t1", message: userMessage("u1", "go") },
      {
        kind: "message",
        id: "m-assistant",
        createdAt: "t2",
        message: assistantMessage("a1", "done"),
      },
    ];
    const rows = deriveMessagesTimelineRows({
      entries,
      completionDividerBeforeEntryId: "m-assistant",
    });
    const a = rows[1] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(a.showCompletionDivider).toBe(true);
    // The user row never gets the divider — only assistant messages can.
    const u = rows[0] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(u.showCompletionDivider).toBeUndefined();
  });

  it("does not tag user messages even if the divider target points at one", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "m-user", createdAt: "t1", message: userMessage("u1", "go") },
    ];
    const rows = deriveMessagesTimelineRows({
      entries,
      completionDividerBeforeEntryId: "m-user",
    });
    const u = rows[0] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(u.showCompletionDivider).toBeUndefined();
  });

  it("annotates user messages listed in the revert map with their turn count", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "m1", createdAt: "t1", message: userMessage("u1", "first") },
      { kind: "message", id: "m2", createdAt: "t2", message: userMessage("u2", "second") },
    ];
    const rows = deriveMessagesTimelineRows({
      entries,
      revertTurnCountByUserMessageId: new Map([
        ["u1", 3],
        ["u2", 0],
      ]),
    });
    const first = rows[0] as Extract<MessagesTimelineRow, { kind: "message" }>;
    const second = rows[1] as Extract<MessagesTimelineRow, { kind: "message" }>;
    expect(first.revertTurnCount).toBe(3);
    // zero count is suppressed — the row stays clean.
    expect(second.revertTurnCount).toBeUndefined();
  });

  it("appends the working row when isWorking is true", () => {
    const entries: TimelineSourceEntry[] = [
      { kind: "message", id: "m1", createdAt: "t1", message: userMessage("u1", "hi") },
    ];
    const rows = deriveMessagesTimelineRows({
      entries,
      isWorking: true,
      activeTurnStartedAt: "2026-05-14T10:01:00.000Z",
    });
    expect(rows.length).toBe(2);
    const trailing = rows[1]!;
    expect(trailing.kind).toBe("working");
    expect(trailing.createdAt).toBe("2026-05-14T10:01:00.000Z");
  });
});

describe("splitWorkEntries", () => {
  it("returns the full list when within the max threshold", () => {
    const entries = Array.from({ length: 3 }, (_, i) => workEntry(`e${i}`));
    const { visible, overflowCount } = splitWorkEntries(entries);
    expect(visible).toBe(entries);
    expect(overflowCount).toBe(0);
  });

  it("splits when there are more than MAX_VISIBLE_WORK_ENTRIES", () => {
    const entries = Array.from({ length: MAX_VISIBLE_WORK_ENTRIES + 4 }, (_, i) =>
      workEntry(`e${i}`),
    );
    const { visible, overflowCount } = splitWorkEntries(entries);
    expect(visible.length).toBe(MAX_VISIBLE_WORK_ENTRIES);
    expect(overflowCount).toBe(4);
  });

  it("honors a custom max", () => {
    const entries = Array.from({ length: 10 }, (_, i) => workEntry(`e${i}`));
    const { visible, overflowCount } = splitWorkEntries(entries, 3);
    expect(visible.length).toBe(3);
    expect(overflowCount).toBe(7);
  });
});

describe("rowSignature covers the new variants", () => {
  it("includes revertTurnCount in the user row signature", () => {
    const base: Extract<MessagesTimelineRow, { kind: "message" }> = {
      kind: "message",
      id: "m1",
      createdAt: "t",
      message: userMessage("u1", "hi"),
    };
    const without = rowSignature(base);
    const withRevert = rowSignature({ ...base, revertTurnCount: 3 });
    expect(without).not.toBe(withRevert);
  });

  it("includes showCompletionDivider in the assistant row signature", () => {
    const base: Extract<MessagesTimelineRow, { kind: "message" }> = {
      kind: "message",
      id: "m2",
      createdAt: "t",
      message: assistantMessage("a1", "ok"),
    };
    const without = rowSignature(base);
    const withDivider = rowSignature({ ...base, showCompletionDivider: true });
    expect(without).not.toBe(withDivider);
  });

  it("changes when a work row's grouped entries change", () => {
    const a: Extract<MessagesTimelineRow, { kind: "work" }> = {
      kind: "work",
      id: "w1",
      createdAt: "t",
      entries: [workEntry("e1")],
    };
    const b: Extract<MessagesTimelineRow, { kind: "work" }> = {
      ...a,
      entries: [workEntry("e1"), workEntry("e2")],
    };
    expect(rowSignature(a)).not.toBe(rowSignature(b));
  });
});
