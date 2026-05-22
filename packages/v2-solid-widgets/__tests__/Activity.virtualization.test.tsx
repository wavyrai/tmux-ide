/**
 * Contracts test for the virtualized Activity timeline.
 *
 * Mounts the widget with a 10k-event feed and asserts that only a
 * viewport-sized slice lands in the DOM. The day-grouping logic is
 * preserved — day-header rows still appear in the entries stream
 * but they participate in virtualization rather than wrapping
 * the per-day event rows.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { ActivityView } from "../src/widgets/Activity";
import type { ActivityEvent, ActivityMountOptions } from "../src/types";

function event(i: number, offsetSec: number): ActivityEvent {
  return {
    timestamp: new Date(Date.now() - offsetSec * 1000).toISOString(),
    type: "dispatch",
    message: `event-${i}`,
    agent: `agent-${i % 4}`,
    taskId: `T${i}`,
    relative: `${offsetSec}s ago`,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Activity virtualization", () => {
  it("renders only a viewport-sized window of rows for a 10k-event feed", () => {
    const events = Array.from({ length: 10_000 }, (_, i) => event(i, i));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<ActivityMountOptions>({ events });
    const dispose = render(() => <ActivityView options={opts} />, container);

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>("[data-testid='activity-timeline-spacer']");
    expect(spacer).toBeTruthy();
    const spacerHeight = parseInt(spacer!.style.height, 10);
    // 10k events + at least 1 day-header row × ~52px per event,
    // ~28px per header — much larger than any viewport stub.
    expect(spacerHeight).toBeGreaterThan(100_000);

    dispose();
  });
});
