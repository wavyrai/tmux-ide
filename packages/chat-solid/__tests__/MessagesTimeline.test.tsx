/**
 * Render tests for the flat-transcript MessagesTimeline.
 *
 * Mounts the component with a small fixture and asserts the visible
 * surface — role headers per row, no bubble chrome, tool-calls
 * collapsed by default with a chip toggle, empty state.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { ChatMessage, MessagesTimelineRow, ThreadMessage, ToolCallView } from "../src/types";

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
    text: "**bold**",
    toolCalls: [],
    ...overrides,
  };
}

function row(message: ChatMessage): MessagesTimelineRow {
  return { kind: "message", id: message.id, createdAt: message.createdAt, message };
}

function mount(initial: {
  rows: MessagesTimelineRow[];
  messages?: ThreadMessage[];
  providerName?: string;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [rows, setRows] = createSignal<MessagesTimelineRow[]>(initial.rows);
  const [messages, setMessages] = createSignal<ThreadMessage[]>(initial.messages ?? []);
  const dispose = render(
    () => (
      <MessagesTimeline
        rows={rows}
        messages={messages}
        providerName={() => initial.providerName ?? "Claude"}
      />
    ),
    container,
  );
  return { container, dispose, setRows, setMessages };
}

let mounted: { container: HTMLElement; dispose: () => void } | null = null;
afterEach(() => {
  mounted?.dispose();
  if (mounted?.container.parentNode) mounted.container.parentNode.removeChild(mounted.container);
  mounted = null;
});

describe("MessagesTimeline flat transcript", () => {
  it("renders the empty-state stub when there are no rows", () => {
    mounted = mount({ rows: [] });
    expect(mounted.container.querySelector('[data-testid="messages-timeline-empty"]')).toBeTruthy();
    expect(mounted.container.querySelector('[data-testid="messages-timeline"]')).toBeNull();
  });

  it("renders one flat row per message with no bubble chrome", () => {
    mounted = mount({
      rows: [row(userMsg("u1", "hello")), row(assistantMsg("a1"))],
    });
    const rows = mounted.container.querySelectorAll('[data-testid="message-row"]');
    expect(rows).toHaveLength(2);
    // No `.rounded-2xl` bubble class anywhere — bubble UI is gone.
    expect(mounted.container.querySelector(".rounded-2xl")).toBeNull();
    // Each row carries a role header.
    expect(mounted.container.querySelectorAll('[data-testid="message-role-header"]')).toHaveLength(
      2,
    );
  });

  it("labels the user row as You and the assistant row as the provider name", () => {
    mounted = mount({
      rows: [row(userMsg("u1")), row(assistantMsg("a1"))],
      providerName: "Sonnet",
    });
    const names = Array.from(
      mounted.container.querySelectorAll('[data-testid="message-role-name"]'),
    ).map((n) => n.textContent);
    expect(names).toEqual(["You", "Sonnet"]);
  });

  it("renders the assistant body as markdown HTML inside a .chat-markdown wrapper", () => {
    mounted = mount({ rows: [row(assistantMsg("a1", { text: "**ship it**" }))] });
    const md = mounted.container.querySelector(".chat-markdown");
    expect(md).toBeTruthy();
    expect(md!.querySelector("strong")?.textContent).toBe("ship it");
  });

  it("shows the assistant stop-reason chip when present", () => {
    mounted = mount({
      rows: [row(assistantMsg("a1", { stopReason: "end_turn" }))],
    });
    const badge = mounted.container.querySelector('[data-testid="message-role-badge"]');
    expect(badge?.textContent).toBe("end turn");
  });

  it("renders the empty-output stub when assistant has no text/tools/thought and is not streaming", () => {
    mounted = mount({
      rows: [row(assistantMsg("a1", { text: "", toolCalls: [] }))],
    });
    expect(mounted.container.querySelector('[data-testid="message-empty"]')).toBeTruthy();
  });

  it("shows working dots while streaming + empty body", () => {
    mounted = mount({
      rows: [row(assistantMsg("a1", { text: "", streaming: true, toolCalls: [] }))],
    });
    expect(mounted.container.querySelector('[data-testid="message-working"]')).toBeTruthy();
  });

  it("collapses tool calls into a chip by default and reveals them on click", () => {
    const toolCall: ToolCallView = {
      toolCallId: "tc1",
      title: "Read",
      status: "completed",
      content: [],
    };
    mounted = mount({
      rows: [
        row(assistantMsg("a1", { toolCalls: [toolCall, { ...toolCall, toolCallId: "tc2" }] })),
      ],
    });
    const cluster = mounted.container.querySelector('[data-testid="tool-calls-cluster"]');
    expect(cluster).toBeTruthy();
    expect(cluster!.getAttribute("data-open")).toBe("false");
    expect(mounted.container.querySelector('[data-testid="tool-calls-list"]')).toBeNull();

    const toggle = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-calls-toggle"]',
    );
    expect(toggle!.textContent).toContain("Tool calls (2)");
    toggle!.click();
    expect(
      mounted.container
        .querySelector('[data-testid="tool-calls-cluster"]')!
        .getAttribute("data-open"),
    ).toBe("true");
    expect(mounted.container.querySelector('[data-testid="tool-calls-list"]')).toBeTruthy();
  });

  it("flags failed tool clusters with a `failed` badge", () => {
    const failed: ToolCallView = {
      toolCallId: "tc1",
      title: "Edit",
      status: "failed",
      content: [],
    };
    mounted = mount({ rows: [row(assistantMsg("a1", { toolCalls: [failed] }))] });
    expect(
      mounted.container.querySelector('[data-testid="tool-calls-failure-badge"]'),
    ).toBeTruthy();
  });

  it("renders thought details collapsed", () => {
    mounted = mount({
      rows: [row(assistantMsg("a1", { thoughtText: "considering options" }))],
    });
    const details = mounted.container.querySelector<HTMLDetailsElement>(
      '[data-testid="message-thought"]',
    );
    expect(details).toBeTruthy();
    expect(details!.open).toBe(false);
    expect(details!.textContent).toContain("considering options");
  });

  it("renders a copy button only for terminal assistant messages with text", () => {
    mounted = mount({
      rows: [
        row(userMsg("u1")),
        row(assistantMsg("a1", { text: "first" })),
        row(assistantMsg("a2", { text: "final" })),
      ],
    });
    // The assistant row's copy button shows only on the terminal reply
    // (the LAST assistant message after the user). With a single user
    // prompt + two unkeyed assistant chunks, only a2 is terminal.
    const buttons = mounted.container.querySelectorAll('[data-testid="message-copy-button"]');
    // User row also gets a copy button (hover-revealed) → 1 user + 1 terminal-assistant = 2.
    expect(buttons.length).toBe(2);
  });

  it("renders a working row when a `kind: working` entry is included", () => {
    mounted = mount({
      rows: [{ kind: "working", id: "w1", createdAt: "2026-05-13T08:00:00.000Z" }],
    });
    const rows = mounted.container.querySelectorAll('[data-testid="message-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-kind")).toBe("working");
  });
});
