/**
 * Contracts test for the virtualized MessagesTimeline.
 *
 * Asserts that a 1000-row transcript renders only a viewport-sized
 * window of `[data-testid="message-row"]` nodes into the DOM, that
 * the virtualizer spacer reports a non-trivial total height tracking
 * the row count, and that the rendered rows all carry the
 * `data-index` attribute the virtualizer uses for measurement.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MessagesTimeline } from "../src/components/MessagesTimeline";
import type { ChatMessage, MessagesTimelineRow, ThreadMessage } from "../src/types";

function userMsg(i: number): ChatMessage {
  return {
    id: `u${i}`,
    role: "user",
    createdAt: "2026-05-13T08:00:00.000Z",
    content: [{ type: "text", text: `message ${i}` }],
  };
}

function row(message: ChatMessage): MessagesTimelineRow {
  return { kind: "message", id: message.id, createdAt: message.createdAt, message };
}

function mount(initial: { rows: MessagesTimelineRow[] }) {
  const container = document.createElement("div");
  // Constrain viewport via the setup-stubbed offsetHeight by sizing
  // the host element. The setup file caps offsetHeight at 2000px; with
  // a 90px estimate that yields ~22 visible rows + overscan ≈ <50.
  document.body.appendChild(container);
  const [rows, setRows] = createSignal<MessagesTimelineRow[]>(initial.rows);
  const [messages] = createSignal<ThreadMessage[]>([]);
  const dispose = render(
    () => (
      <MessagesTimeline rows={rows} messages={messages} providerName={() => "Claude"} />
    ),
    container,
  );
  return { container, dispose, setRows };
}

let mounted: { container: HTMLElement; dispose: () => void } | null = null;
afterEach(() => {
  mounted?.dispose();
  if (mounted?.container.parentNode) mounted.container.parentNode.removeChild(mounted.container);
  mounted = null;
});

describe("MessagesTimeline virtualization", () => {
  it("renders only a viewport-sized window of rows for a 1000-message thread", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(userMsg(i)));
    mounted = mount({ rows });

    const rendered = mounted.container.querySelectorAll<HTMLElement>(
      '[data-testid="message-row"]',
    );
    expect(rendered.length).toBeGreaterThan(0);
    // Far below the 1000 total — only the visible viewport + overscan.
    expect(rendered.length).toBeLessThan(100);

    // Every rendered row sits inside a virtual-item host carrying
    // the data-index attribute the virtualizer reads back during
    // measurement. (`indexAttribute: "data-index"` is the default.)
    const indexedHosts = mounted.container.querySelectorAll<HTMLElement>("[data-index]");
    expect(indexedHosts.length).toBe(rendered.length);

    // Spacer height tracks row count (estimate × count = 90 × 1000)
    // until real measurements fill in.
    const spacer = mounted.container.querySelector<HTMLElement>(
      '[data-testid="messages-timeline-spacer"]',
    );
    expect(spacer).toBeTruthy();
    const spacerHeight = parseInt(spacer!.style.height, 10);
    expect(spacerHeight).toBeGreaterThanOrEqual(1000 * 90);
  });

  it("keeps the rendered window stable when a sibling row appends (streaming)", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(userMsg(i)));
    mounted = mount({ rows });

    const before = mounted.container.querySelectorAll('[data-testid="message-row"]').length;
    expect(before).toBeGreaterThan(0);

    // Append a new row; spacer should grow and rendered count stays
    // within the viewport window.
    mounted.setRows([...rows, row(userMsg(50))]);

    const after = mounted.container.querySelectorAll('[data-testid="message-row"]').length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(100);
  });
});
