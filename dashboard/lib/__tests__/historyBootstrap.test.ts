import { describe, expect, it } from "vitest";

import {
  activitiesToChatMessages,
  buildBootstrapInput,
  type ChatMessage,
} from "../historyBootstrap";
import type { ActivityView } from "@/components/chat-v2/useChatStore";

function msg(role: ChatMessage["role"], text: string, id = `${role}-${text}`): ChatMessage {
  return { id, role, text, createdAt: "2026-02-09T00:00:00.000Z" };
}

describe("buildBootstrapInput", () => {
  it("includes the full transcript when under budget", () => {
    const result = buildBootstrapInput(
      [msg("user", "hello"), msg("assistant", "world")],
      "what's next?",
      1_500,
    );
    expect(result.includedCount).toBe(2);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("USER:\nhello");
    expect(result.text).toContain("ASSISTANT:\nworld");
    expect(result.text).toContain("Latest user request (answer this now):");
    expect(result.text).toContain("what's next?");
    // Order check — user before assistant, both before the latest prompt.
    const userIdx = result.text.indexOf("USER:\nhello");
    const asstIdx = result.text.indexOf("ASSISTANT:\nworld");
    const promptIdx = result.text.indexOf("what's next?");
    expect(userIdx).toBeLessThan(asstIdx);
    expect(asstIdx).toBeLessThan(promptIdx);
  });

  it("drops oldest messages first when the budget is tight", () => {
    const messages: ChatMessage[] = [];
    for (let i = 1; i <= 6; i++) {
      messages.push(msg("user", `Q${i} ` + "X".repeat(40)));
      messages.push(msg("assistant", `A${i} ` + "Y".repeat(40)));
    }
    // Budget allows preamble + new prompt + a few messages + omitted summary.
    const result = buildBootstrapInput(messages, "follow-up", 600);
    expect(result.includedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(messages.length);
    expect(result.omittedCount).toBe(messages.length - result.includedCount);
    expect(result.truncated).toBe(true);
    // Newest content kept; oldest dropped.
    expect(result.text).toContain(`Q${6} `);
    expect(result.text).not.toContain(`Q${1} `);
    expect(result.text).toContain(`${result.omittedCount} earlier message`);
    // Total length stays within budget.
    expect(result.text.length).toBeLessThanOrEqual(600);
  });

  it("falls back to prompt-only when even one message + prompt overflows", () => {
    const huge = msg("assistant", "Z".repeat(1_000));
    const result = buildBootstrapInput([huge], "hi", 50);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("hi");
  });

  it("truncates an oversize latest prompt", () => {
    const result = buildBootstrapInput([], "P".repeat(200), 50);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("P".repeat(50));
  });

  it("includes image-attachment summary lines", () => {
    const result = buildBootstrapInput(
      [
        {
          id: "u",
          role: "user",
          text: "look",
          attachments: [
            { type: "image", name: "a.png" },
            { type: "image", name: "b.png" },
            { type: "image", name: "c.png" },
            { type: "image", name: "d.png" },
          ],
          createdAt: "2026-02-09T00:00:00.000Z",
        },
      ],
      "describe",
      1_500,
    );
    expect(result.text).toContain("Attached images: a.png, b.png, c.png (+1 more)");
  });

  it("returns empty-state when no messages and prompt fits", () => {
    const result = buildBootstrapInput([], "ping", 100);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("ping");
  });
});

// ---------------------------------------------------------------------------
// chat-v2 adapter
// ---------------------------------------------------------------------------

function act(over: Partial<ActivityView>): ActivityView {
  return {
    id: "act-" + (over.id ?? Math.random().toString(36).slice(2, 8)),
    tone: "info",
    kind: "text",
    summary: "",
    payload: null,
    turnId: null,
    sequence: 0,
    createdAt: "2026-02-09T00:00:00.000Z",
    ...over,
  };
}

describe("activitiesToChatMessages", () => {
  it("collapses activities into one user + one assistant block per turn", () => {
    const activities: ActivityView[] = [
      act({ id: "1", turnId: "t1", tone: "info", summary: "Thinking…", sequence: 1 }),
      act({ id: "2", turnId: "t1", tone: "info", summary: "Here is the plan.", sequence: 2 }),
      act({ id: "3", turnId: "t2", tone: "tool", kind: "bash", summary: "ls -la", sequence: 1 }),
      act({ id: "4", turnId: "t2", tone: "info", summary: "Done.", sequence: 2 }),
    ];

    const messages = activitiesToChatMessages(activities, {
      userMessageByTurnId: { t1: "make a plan", t2: "now do it" },
    });

    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0].text).toBe("make a plan");
    expect(messages[1].text).toBe("Thinking…\nHere is the plan.");
    expect(messages[2].text).toBe("now do it");
    expect(messages[3].text).toContain("[tool: bash] ls -la");
    expect(messages[3].text).toContain("Done.");
  });

  it("sorts activities within a turn by sequence", () => {
    const activities: ActivityView[] = [
      act({ id: "B", turnId: "t1", summary: "second", sequence: 2 }),
      act({ id: "A", turnId: "t1", summary: "first", sequence: 1 }),
    ];
    const messages = activitiesToChatMessages(activities, {
      userMessageByTurnId: { t1: "go" },
    });
    expect(messages[1].text).toBe("first\nsecond");
  });

  it("uses the missing-prompt placeholder when no userMessage is provided", () => {
    const activities: ActivityView[] = [
      act({ turnId: "t1", summary: "ok", sequence: 1 }),
    ];
    const messages = activitiesToChatMessages(activities);
    expect(messages[0].role).toBe("user");
    expect(messages[0].text).toBe("(user prompt)");
  });

  it("emits ambient activities as standalone assistant messages before any turn", () => {
    const activities: ActivityView[] = [
      act({ id: "amb", turnId: null, summary: "session started", sequence: 0 }),
      act({ id: "x", turnId: "t1", summary: "reply", sequence: 1 }),
    ];
    const messages = activitiesToChatMessages(activities, {
      userMessageByTurnId: { t1: "hi" },
    });
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].text).toBe("session started");
    expect(messages[1].role).toBe("user");
  });

  it("composes cleanly with buildBootstrapInput (end-to-end)", () => {
    const activities: ActivityView[] = [
      act({ turnId: "t1", tone: "info", summary: "Reading file.", sequence: 1 }),
      act({ turnId: "t1", tone: "tool", kind: "read", summary: "src/foo.ts", sequence: 2 }),
    ];
    const prior = activitiesToChatMessages(activities, {
      userMessageByTurnId: { t1: "summarize foo.ts" },
    });
    const result = buildBootstrapInput(prior, "now rename it", 2_000);
    expect(result.text).toContain("summarize foo.ts");
    expect(result.text).toContain("[tool: read] src/foo.ts");
    expect(result.text).toContain("Latest user request");
    expect(result.text).toContain("now rename it");
    expect(result.truncated).toBe(false);
  });
});
