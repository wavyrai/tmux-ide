import { describe, expect, test } from "bun:test";

import { RequestPermissionRequestZ, SessionNotificationZ } from "./schema.ts";

describe("ACP schema boundary validation", () => {
  test("decodes a session notification", () => {
    const decoded = SessionNotificationZ.parse({
      sessionId: "s1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        messageId: "m1",
      },
    });

    expect(decoded.update.sessionUpdate).toBe("agent_message_chunk");
  });

  test("rejects a bad session notification", () => {
    expect(() =>
      SessionNotificationZ.parse({ sessionId: "s1", update: { content: "nope" } }),
    ).toThrow();
  });

  test("decodes a permission request", () => {
    const decoded = RequestPermissionRequestZ.parse({
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Edit file" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    expect(decoded.options[0]?.optionId).toBe("allow");
  });

  test("decodes tool call terminal content", () => {
    const decoded = SessionNotificationZ.parse({
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Run tests",
        content: [{ type: "terminal", terminalId: "term-1" }],
      },
    });

    expect(decoded.update.sessionUpdate).toBe("tool_call");
  });
});
