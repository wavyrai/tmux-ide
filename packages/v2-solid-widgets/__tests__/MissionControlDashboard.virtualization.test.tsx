/**
 * Contracts test for the virtualized MissionControl event stream.
 *
 * The widget caps the visible event count at `eventLimit` (default
 * 20). When the host passes a large limit (e.g. after the user
 * clicks "show all"), the events render inside a max-height: 400px
 * scroll region that virtualizes the row list so the dashboard
 * doesn't pay for thousands of event divs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MissionControlDashboardView } from "../src/widgets/MissionControlDashboard";
import type {
  DashboardAgent,
  DashboardEvent,
  DashboardMilestone,
  MissionControlDashboardMountOptions,
  MissionControlDashboardSnapshot,
} from "../src/types";

function ev(i: number): DashboardEvent {
  return {
    type: "dispatch",
    relative: `${i}s`,
    agent: `agent-${i % 4}`,
    message: `event ${i}`,
  };
}

function snapshot(events: DashboardEvent[]): MissionControlDashboardSnapshot {
  return {
    mission: {
      title: "Test mission",
      status: "active",
      description: "test",
    },
    milestones: [],
    agents: [],
    events,
    kpis: { agentsActive: 0, tasksDone: 0, runtime: "0", validationPercent: 0 },
    validation: null,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

function milestone(i: number): DashboardMilestone {
  return {
    id: `M${i.toString().padStart(3, "0")}`,
    title: `Milestone ${i}`,
    status: i % 4 === 0 ? "done" : "active",
    order: i,
    taskCount: 10,
    tasksDone: i % 11,
  };
}

function agent(i: number): DashboardAgent {
  return {
    paneTitle: `pane-${i}`,
    paneId: `p${i}`,
    isBusy: i % 2 === 0,
    taskTitle: i % 3 === 0 ? `task ${i}` : null,
    taskId: i % 3 === 0 ? `T${i}` : null,
    elapsed: `${i}m`,
  };
}

describe("MissionControlDashboard event-stream virtualization", () => {
  it("renders only a viewport-sized window for a high event limit", () => {
    const events = Array.from({ length: 5000 }, (_, i) => ev(i));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<MissionControlDashboardMountOptions>({
      snapshot: snapshot(events),
      eventLimit: 5000,
    });
    const dispose = render(() => <MissionControlDashboardView options={opts} />, container);

    const eventNodes = container.querySelectorAll<HTMLElement>("[data-index]");
    expect(eventNodes.length).toBeGreaterThan(0);
    expect(eventNodes.length).toBeLessThan(200);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='mission-control-events-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 5000 × ~26px = 130000 px of virtual content.
    expect(h).toBeGreaterThan(100_000);

    dispose();
  });

  it("renders only a viewport-sized window of milestone rows for 1000 milestones", () => {
    const milestones = Array.from({ length: 1000 }, (_, i) => milestone(i));
    const snap: MissionControlDashboardSnapshot = {
      ...snapshot([]),
      milestones,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<MissionControlDashboardMountOptions>({ snapshot: snap });
    const dispose = render(() => <MissionControlDashboardView options={opts} />, container);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='mission-control-milestones-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 milestones × at least 80px estimate = 80000px.
    expect(h).toBeGreaterThan(70_000);

    const rows = container.querySelectorAll<HTMLElement>(
      "[data-testid='mission-control-milestones'] [data-index]",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);

    dispose();
  });

  it("renders only a viewport-sized window of agent rows for 1000 agents", () => {
    const agents = Array.from({ length: 1000 }, (_, i) => agent(i));
    const snap: MissionControlDashboardSnapshot = {
      ...snapshot([]),
      agents,
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const [opts] = createSignal<MissionControlDashboardMountOptions>({ snapshot: snap });
    const dispose = render(() => <MissionControlDashboardView options={opts} />, container);

    const spacer = container.querySelector<HTMLElement>(
      "[data-testid='mission-control-agents-spacer']",
    );
    expect(spacer).toBeTruthy();
    const h = parseInt(spacer!.style.height, 10);
    // 1000 agents × at least 56px estimate = 56000px.
    expect(h).toBeGreaterThan(50_000);

    const rows = container.querySelectorAll<HTMLElement>(
      "[data-testid='mission-control-agents'] [data-index]",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(200);

    dispose();
  });
});
