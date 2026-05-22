import { describe, expect, it } from "vitest";
import { deriveChangedFiles } from "../src/lib/changedFiles";
import type { ThreadMessage } from "../src/types";

type AgentUpdate = Extract<ThreadMessage, { _tag: "AgentUpdate" }>["update"];

function update(id: string, createdAt: string, update: AgentUpdate): ThreadMessage {
  return { _tag: "AgentUpdate", id, createdAt, update };
}

describe("deriveChangedFiles", () => {
  it("groups diff content and computes additions and deletions", () => {
    const files = deriveChangedFiles([
      update("edit-1", "2026-01-01T00:00:00.000Z", {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Edit file",
        kind: "edit",
        content: [
          {
            type: "diff",
            path: "src/App.tsx",
            oldText: "one\ntwo\n",
            newText: "one\nthree\nfour\n",
          },
        ],
      }),
      update("edit-2", "2026-01-01T00:00:01.000Z", {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        content: [
          {
            type: "diff",
            path: "src/App.tsx",
            oldText: "four\n",
            newText: "four\nfive\n",
          },
        ],
      }),
    ]);

    expect(files).toEqual([
      {
        path: "src/App.tsx",
        kind: "write",
        edits: [
          {
            oldText: "one\ntwo\n",
            newText: "one\nthree\nfour\n",
            toolCallId: "tool-1",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            oldText: "four\n",
            newText: "four\nfive\n",
            toolCallId: "tool-1",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
        totalAdditions: 3,
        totalDeletions: 1,
      },
    ]);
  });

  it("detects read paths from raw input", () => {
    const files = deriveChangedFiles([
      update("read-1", "2026-01-01T00:00:00.000Z", {
        sessionUpdate: "tool_call",
        toolCallId: "tool-read",
        title: "Read file",
        rawInput: { path: "README.md" },
      }),
    ]);

    expect(files).toEqual([
      {
        path: "README.md",
        kind: "read",
        edits: [],
        totalAdditions: 0,
        totalDeletions: 0,
      },
    ]);
  });
});
