/**
 * Streaming-token regression guard. Post-virtualization (commit
 * 1c48cac), the MessagesTimeline body is virtualized via
 * `@tanstack/solid-virtual` with a per-row memo keyed on
 * `rowSignature`. The invariant we pin here:
 *
 *   1. Each token arrival (rebuilt `rows()` array with the streaming
 *      row's text updated) must reflect into the streaming row's
 *      DOM text content.
 *   2. The DOM node identity of an UNRELATED (non-streaming) row
 *      must stay stable across token updates — i.e. the per-row
 *      memo must be returning the previous reference so the
 *      subtree skips re-derivation. Without this, every token
 *      would trigger a full re-render of every visible row.
 *
 * The test mounts MessagesTimeline with two rows (one stable, one
 * streaming), captures the stable row's element after first paint,
 * then pushes a few synthetic token updates and re-asserts.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { ChatMessage, MessagesTimelineRow, ThreadMessage } from "../src/types";

afterEach(() => {
  document.body.innerHTML = "";
});

function userMsg(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: "2026-05-14T10:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

function assistantMsg(id: string, text: string, streaming: boolean): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-05-14T10:00:05.000Z",
    streaming,
    text,
    toolCalls: [],
  };
}

function messageRow(message: ChatMessage): MessagesTimelineRow {
  return {
    kind: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
  };
}

interface MountReturn {
  container: HTMLElement;
  dispose: () => void;
  setRows: (next: MessagesTimelineRow[]) => void;
}

function mount(initialRows: MessagesTimelineRow[]): MountReturn {
  const container = document.createElement("div");
  // happy-dom's virtualizer needs a sized scroll element — pin it so
  // virtualItems isn't empty on first paint.
  Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
  Object.defineProperty(container, "scrollHeight", { value: 800, configurable: true });
  document.body.appendChild(container);
  const [rows, setRows] = createSignal<MessagesTimelineRow[]>(initialRows);
  const [messages] = createSignal<ThreadMessage[]>([]);
  const dispose = render(
    () => <MessagesTimeline rows={rows} messages={messages} providerName={() => "Claude"} />,
    container,
  );
  return { container, dispose, setRows };
}

function findStreamingRow(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
}

describe("MessagesTimeline — streaming token reactivity (post-virtualization)", () => {
  it("reflects new tokens in the streaming row's DOM text", () => {
    const initial = [
      messageRow(userMsg("u1", "hello")),
      messageRow(assistantMsg("a1", "Hi", true)),
    ];
    const { container, dispose, setRows } = mount(initial);

    const assistantRow = findStreamingRow(container, "a1");
    expect(assistantRow?.textContent).toContain("Hi");

    setRows([messageRow(userMsg("u1", "hello")), messageRow(assistantMsg("a1", "Hi th", true))]);
    expect(findStreamingRow(container, "a1")?.textContent).toContain("Hi th");

    setRows([
      messageRow(userMsg("u1", "hello")),
      messageRow(assistantMsg("a1", "Hi there!", true)),
    ]);
    expect(findStreamingRow(container, "a1")?.textContent).toContain("Hi there!");
    dispose();
  });

  it("preserves the stable user row's DOM node across token updates", () => {
    const initial = [
      messageRow(userMsg("u1", "hello")),
      messageRow(assistantMsg("a1", "Hi", true)),
    ];
    const { container, dispose, setRows } = mount(initial);

    const userBefore = findStreamingRow(container, "u1");
    expect(userBefore).toBeTruthy();

    setRows([messageRow(userMsg("u1", "hello")), messageRow(assistantMsg("a1", "Hi there", true))]);
    setRows([
      messageRow(userMsg("u1", "hello")),
      messageRow(assistantMsg("a1", "Hi there, friend.", true)),
    ]);

    const userAfter = findStreamingRow(container, "u1");
    // The non-streaming row's element identity is preserved by the
    // per-row memo + virtualizer key. If the memo were stripped, a
    // new <section data-message-id="u1"> would be minted on every
    // token update and the strict equality below would fail.
    expect(userAfter).toBe(userBefore);
    dispose();
  });

  it("flips the streaming flag off without re-mounting the assistant row", () => {
    const initial = [messageRow(assistantMsg("a1", "Hi there", true))];
    const { container, dispose, setRows } = mount(initial);
    const before = findStreamingRow(container, "a1");
    expect(before?.getAttribute("data-streaming")).toBe("true");
    setRows([messageRow(assistantMsg("a1", "Hi there", false))]);
    const after = findStreamingRow(container, "a1");
    expect(after?.getAttribute("data-streaming")).toBe("false");
    // Same node identity — fine-grained reactivity flipped the
    // attribute, not a re-mount.
    expect(after).toBe(before);
    dispose();
  });
});
