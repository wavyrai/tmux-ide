/**
 * Polish layer for the revert button + completion divider duration
 * label rendered inside `MessagesTimeline`:
 *
 *   1. Clicking the revert button first surfaces an inline
 *      "Revert N turns? [Yes] [No]" confirm without firing the
 *      callback.
 *   2. Confirming "Yes" dispatches `onRevertFromMessage`; "No"
 *      collapses the prompt without firing.
 *   3. Completion divider renders with the humanized duration
 *      ("Completed in 3.2s") when `completionTurnStartedAt` is set.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { ChatMessage, MessagesTimelineRow, ThreadMessage } from "../src/types";

function userMessage(id: string): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-05-14T10:00:00.000Z",
    content: [{ type: "text", text: "go" }],
  };
}

function assistantMessage(id: string, completedAt?: string): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-05-14T10:00:05.000Z",
    completedAt: completedAt ?? "2026-05-14T10:00:05.000Z",
    streaming: false,
    text: "done",
    toolCalls: [],
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

describe("MessagesTimeline — revert confirm", () => {
  it("opens the confirm prompt on first click without dispatching", () => {
    const onRevert = vi.fn();
    mounted = mount({
      rows: [
        {
          kind: "message",
          id: "m1",
          createdAt: "2026-05-14T10:00:00.000Z",
          message: userMessage("u1"),
          revertTurnCount: 2,
        },
      ],
      onRevertFromMessage: onRevert,
    });
    const btn = mounted.container.querySelector<HTMLButtonElement>(
      "[data-testid='message-revert-from-here']",
    );
    btn!.click();
    expect(onRevert).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelector("[data-testid='message-revert-from-here-confirm']"),
    ).toBeTruthy();
  });

  it("dispatches onRevertFromMessage when Yes is clicked", () => {
    const onRevert = vi.fn();
    mounted = mount({
      rows: [
        {
          kind: "message",
          id: "m1",
          createdAt: "2026-05-14T10:00:00.000Z",
          message: userMessage("u1"),
          revertTurnCount: 3,
        },
      ],
      onRevertFromMessage: onRevert,
    });
    mounted.container
      .querySelector<HTMLButtonElement>("[data-testid='message-revert-from-here']")!
      .click();
    mounted.container
      .querySelector<HTMLButtonElement>("[data-testid='message-revert-from-here-yes']")!
      .click();
    expect(onRevert).toHaveBeenCalledExactlyOnceWith("u1");
    // Confirm collapses after Yes.
    expect(
      mounted.container.querySelector("[data-testid='message-revert-from-here-confirm']"),
    ).toBeNull();
  });

  it("No dismisses the confirm without firing", () => {
    const onRevert = vi.fn();
    mounted = mount({
      rows: [
        {
          kind: "message",
          id: "m1",
          createdAt: "2026-05-14T10:00:00.000Z",
          message: userMessage("u1"),
          revertTurnCount: 1,
        },
      ],
      onRevertFromMessage: onRevert,
    });
    mounted.container
      .querySelector<HTMLButtonElement>("[data-testid='message-revert-from-here']")!
      .click();
    mounted.container
      .querySelector<HTMLButtonElement>("[data-testid='message-revert-from-here-no']")!
      .click();
    expect(onRevert).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelector("[data-testid='message-revert-from-here-confirm']"),
    ).toBeNull();
    // After No the inline button is back.
    expect(
      mounted.container.querySelector("[data-testid='message-revert-from-here']"),
    ).toBeTruthy();
  });
});

describe("MessagesTimeline — completion divider duration", () => {
  it("renders 'Response • <duration>' when completionTurnStartedAt is set", () => {
    mounted = mount({
      rows: [
        {
          kind: "message",
          id: "m1",
          createdAt: "2026-05-14T10:00:05.000Z",
          message: assistantMessage("a1", "2026-05-14T10:00:05.000Z"),
          showCompletionDivider: true,
          completionTurnStartedAt: "2026-05-14T10:00:00.000Z",
        },
      ],
    });
    const divider = mounted.container.querySelector("[data-testid='message-completion-divider']");
    expect(divider?.textContent).toContain("Response");
    expect(divider?.textContent).toContain("5.0s");
    expect(divider?.getAttribute("data-turn-started-at")).toBe("2026-05-14T10:00:00.000Z");
  });

  it("falls back to bare label when no start timestamp is set", () => {
    mounted = mount({
      rows: [
        {
          kind: "message",
          id: "m1",
          createdAt: "2026-05-14T10:00:05.000Z",
          message: assistantMessage("a1"),
          showCompletionDivider: true,
        },
      ],
    });
    const divider = mounted.container.querySelector("[data-testid='message-completion-divider']");
    expect(divider?.textContent?.trim()).toBe("Response");
  });
});
