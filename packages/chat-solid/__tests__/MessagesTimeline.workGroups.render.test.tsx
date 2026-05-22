/**
 * Render-level coverage for the structural enrichment on
 * MessagesTimeline:
 *
 *   - `work` rows surface a "Worked on N step(s)" chip + bullet list
 *   - work rows with > MAX_VISIBLE_WORK_ENTRIES entries show
 *     a "+N more" affordance that expands inline
 *   - assistant rows tagged `showCompletionDivider` render the
 *     "Completed turn" divider above them
 *   - user rows tagged `revertTurnCount` surface the revert button
 *     that dispatches `onRevertFromMessage(userMessageId)`
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { ChatMessage, MessagesTimelineRow, ThreadMessage, WorkLogEntry } from "../src/types";

function userMsg(id: string, text = "hi"): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-05-14T10:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

function assistantMsg(id: string, text = "done"): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-05-14T10:00:05.000Z",
    streaming: false,
    text,
    toolCalls: [],
  };
}

function messageRow(
  message: ChatMessage,
  extra: Record<string, unknown> = {},
): MessagesTimelineRow {
  return {
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    ...(extra as object),
  };
}

function workRow(id: string, entries: WorkLogEntry[]): MessagesTimelineRow {
  return {
    kind: "work",
    id,
    createdAt: "2026-05-14T10:00:01.000Z",
    entries,
  };
}

let mounted: { container: HTMLElement; dispose: () => void } | null = null;
afterEach(() => {
  mounted?.dispose();
  if (mounted?.container.parentNode) mounted.container.parentNode.removeChild(mounted.container);
  mounted = null;
});

function mount(initial: {
  rows: MessagesTimelineRow[];
  onRevertFromMessage?: (id: string) => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [rows] = createSignal<MessagesTimelineRow[]>(initial.rows);
  const [messages] = createSignal<ThreadMessage[]>([]);
  const dispose = render(
    () => (
      <MessagesTimeline
        rows={rows}
        messages={messages}
        providerName={() => "Claude"}
        onRevertFromMessage={initial.onRevertFromMessage}
      />
    ),
    container,
  );
  return { container, dispose };
}

describe("MessagesTimeline work-group row", () => {
  it("renders a single chip + bullet list for a work row", () => {
    const entries: WorkLogEntry[] = [
      { id: "e1", label: "read file: src/foo.ts" },
      { id: "e2", label: "ran tests" },
    ];
    mounted = mount({ rows: [workRow("w1", entries)] });
    const row = mounted.container.querySelector("[data-testid='message-row'][data-kind='work']");
    expect(row).toBeTruthy();
    expect(
      mounted.container.querySelector("[data-testid='work-group-summary']")?.textContent,
    ).toContain("Worked on 2 steps");
    const bullets = mounted.container.querySelectorAll("[data-testid='work-group-entry']");
    expect(bullets.length).toBe(2);
  });

  it("singularizes the chip label for a single entry", () => {
    mounted = mount({ rows: [workRow("w1", [{ id: "e1", label: "x" }])] });
    expect(
      mounted.container.querySelector("[data-testid='work-group-summary']")?.textContent,
    ).toContain("Worked on 1 step");
  });

  it("collapses overflow past 6 entries and expands on click", () => {
    const entries: WorkLogEntry[] = Array.from({ length: 9 }, (_, i) => ({
      id: `e${i}`,
      label: `step ${i}`,
    }));
    mounted = mount({ rows: [workRow("w1", entries)] });
    expect(mounted.container.querySelectorAll("[data-testid='work-group-entry']").length).toBe(6);
    const expand = mounted.container.querySelector<HTMLButtonElement>(
      "[data-testid='work-group-expand']",
    );
    expect(expand?.textContent).toContain("+3 more");
    expand!.click();
    expect(mounted.container.querySelectorAll("[data-testid='work-group-entry']").length).toBe(9);
    expect(mounted.container.querySelector("[data-testid='work-group-expand']")).toBeNull();
  });
});

describe("MessagesTimeline completion divider", () => {
  it("renders the divider above a tagged assistant message", () => {
    mounted = mount({
      rows: [
        messageRow(userMsg("u1", "go")),
        messageRow(assistantMsg("a1"), { showCompletionDivider: true }),
      ],
    });
    expect(
      mounted.container.querySelector("[data-testid='message-completion-divider']"),
    ).toBeTruthy();
  });

  it("does not render the divider when the flag is missing", () => {
    mounted = mount({
      rows: [messageRow(userMsg("u1", "go")), messageRow(assistantMsg("a1"))],
    });
    expect(
      mounted.container.querySelector("[data-testid='message-completion-divider']"),
    ).toBeNull();
  });
});

describe("MessagesTimeline revert-from-here", () => {
  it("renders the revert button on a tagged user row", () => {
    mounted = mount({
      rows: [messageRow(userMsg("u1", "hi"), { revertTurnCount: 2 })],
      onRevertFromMessage: vi.fn(),
    });
    const btn = mounted.container.querySelector("[data-testid='message-revert-from-here']");
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute("data-revert-count")).toBe("2");
    expect(btn?.textContent).toContain("Revert 2 turns");
  });

  it("singularizes the label for a single turn", () => {
    mounted = mount({
      rows: [messageRow(userMsg("u1", "hi"), { revertTurnCount: 1 })],
      onRevertFromMessage: vi.fn(),
    });
    const btn = mounted.container.querySelector("[data-testid='message-revert-from-here']");
    expect(btn?.textContent).toContain("Revert 1 turn");
  });

  it("dispatches onRevertFromMessage with the userMessageId after confirming", () => {
    const onRevert = vi.fn();
    mounted = mount({
      rows: [messageRow(userMsg("u1", "hi"), { revertTurnCount: 3 })],
      onRevertFromMessage: onRevert,
    });
    // First click opens the inline confirm prompt; the destructive
    // dispatch lands on the second click (Yes).
    mounted.container
      .querySelector<HTMLButtonElement>("[data-testid='message-revert-from-here']")!
      .click();
    expect(onRevert).not.toHaveBeenCalled();
    mounted.container
      .querySelector<HTMLButtonElement>("[data-testid='message-revert-from-here-yes']")!
      .click();
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("u1");
  });

  it("omits the revert button when no count is supplied", () => {
    mounted = mount({
      rows: [messageRow(userMsg("u1", "hi"))],
      onRevertFromMessage: vi.fn(),
    });
    expect(mounted.container.querySelector("[data-testid='message-revert-from-here']")).toBeNull();
  });

  it("omits the revert button when no handler is supplied even if count is set", () => {
    mounted = mount({
      rows: [messageRow(userMsg("u1", "hi"), { revertTurnCount: 2 })],
      // onRevertFromMessage intentionally omitted
    });
    expect(mounted.container.querySelector("[data-testid='message-revert-from-here']")).toBeNull();
  });
});
