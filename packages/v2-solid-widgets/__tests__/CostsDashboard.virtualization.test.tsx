/**
 * Contracts test for the virtualized CostsDashboard timeline.
 *
 * Seeds a 5000-entry snapshot timeline (timelineLimit raised) and
 * asserts only a viewport-sized window of rows lands in the DOM
 * inside the bounded 192px-tall scroll region.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { CostsDashboardView } from "../src/widgets/CostsDashboard";
import type {
  CostsDashboardMountOptions,
  CostsDashboardSnapshot,
  CostsTimelineEntry,
} from "../src/types";

function entry(i: number): CostsTimelineEntry {
  return {
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    completedTasks: i,
    activeTasks: i % 5,
    busyAgents: i % 3,
    idleAgents: i % 4,
  };
}

function snapshot(timeline: CostsTimelineEntry[]): CostsDashboardSnapshot {
  return {
    session: { startedAt: null, durationMs: 0, status: "idle", agentCount: 0 },
    tasks: {
      total: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      completionRate: 0,
      retryRate: 0,
      avgDurationMs: 0,
      medianDurationMs: 0,
      p90DurationMs: 0,
      byMilestone: [],
    },
    agents: [],
    mission: {
      title: null,
      status: null,
      milestonesCompleted: 0,
      validationPassRate: 0,
      wallClockMs: 0,
    },
    timeline,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CostsDashboard timeline virtualization", () => {
  it("renders only a viewport-sized window of timeline rows for 5000 entries", () => {
    const timeline = Array.from({ length: 5000 }, (_, i) => entry(i));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<CostsDashboardMountOptions>({
      snapshot: snapshot(timeline),
      timelineLimit: 5000,
    });
    const dispose = render(() => <CostsDashboardView options={opts} />, container);

    const rendered = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(300);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='costs-dashboard-timeline-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 5000 × at least 20px = 100000px.
    expect(h).toBeGreaterThan(90_000);

    dispose();
  });
});
