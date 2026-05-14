import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { MissionControlDashboardView } from "../src/widgets/MissionControlDashboard";
import type {
  MissionControlDashboardMountOptions,
  MissionControlDashboardSnapshot,
} from "../src/types";

function mountWidget(initial: MissionControlDashboardMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<MissionControlDashboardMountOptions>(initial);
  const dispose = render(() => <MissionControlDashboardView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<MissionControlDashboardMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

const emptySnapshot: MissionControlDashboardSnapshot = {
  mission: null,
  validation: null,
  milestones: [],
  tasks: [],
  agents: [],
  events: [],
};

const richSnapshot: MissionControlDashboardSnapshot = {
  mission: {
    title: "Fold src/ + packages/daemon",
    description: "End the monorepo split.",
    status: "active",
    branch: "feat/v2.5.0",
  },
  validation: { total: 12, passing: 8, failing: 1, pending: 2, blocked: 1 },
  milestones: [
    { id: "M1", title: "Foundation", status: "done", order: 1, taskCount: 4, tasksDone: 4 },
    { id: "M2", title: "Reactor + Effect", status: "active", order: 2, taskCount: 6, tasksDone: 3 },
    { id: "M3", title: "Polish", status: "locked", order: 3, taskCount: 5, tasksDone: 0 },
  ],
  tasks: [
    { id: "001", title: "Sqlite event store", status: "done", milestone: "M1", assignee: "Pty" },
    { id: "002", title: "Reactor scaffold", status: "done", milestone: "M2", assignee: "Camille" },
    { id: "003", title: "Effect runtime", status: "done", milestone: "M2", assignee: "Architect" },
    {
      id: "004",
      title: "TurnDiff projection",
      status: "in-progress",
      milestone: "M2",
      assignee: "Pty",
    },
    { id: "005", title: "Provider depth", status: "review", milestone: "M2", assignee: "Camille" },
    { id: "006", title: "ProviderApprovalPolicy", status: "todo", milestone: "M2", assignee: null },
  ],
  agents: [
    {
      paneTitle: "Camille",
      paneId: "%1",
      isBusy: true,
      taskTitle: "Port Mission Control to Solid",
      taskId: "104",
      elapsed: "12m",
    },
    {
      paneTitle: "Pty Agent",
      paneId: "%2",
      isBusy: true,
      taskTitle: "TurnDiff projection",
      taskId: "091",
      elapsed: "1h 4m",
    },
    {
      paneTitle: "Tests",
      paneId: "%3",
      isBusy: false,
      taskTitle: null,
      taskId: null,
      elapsed: "0s",
    },
  ],
  events: [
    {
      timestamp: "2026-05-12T11:00:00Z",
      type: "task.changed",
      message: "Task 091 moved to in-progress",
      agent: "Pty",
      relative: "2m",
    },
    {
      timestamp: "2026-05-12T10:58:00Z",
      type: "milestone.changed",
      message: "Milestone M1 marked done",
      agent: null,
      relative: "4m",
    },
    {
      timestamp: "2026-05-12T10:55:00Z",
      type: "agent.changed",
      message: "Camille became busy on T104",
      agent: "Camille",
      relative: "7m",
    },
  ],
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("MissionControlDashboard (Solid widget)", () => {
  it("renders the empty state when snapshot has no mission", () => {
    const { container, dispose } = mountWidget({ snapshot: emptySnapshot });
    expect(container.querySelector("[data-testid='mission-control-empty']")).toBeTruthy();
    expect(container.querySelector("[data-mission-section='kpis']")).toBeNull();
    expect(container.textContent).toContain("No active mission");
    dispose();
  });

  it("renders an active mission with hero, KPIs, milestones, and mixed task states", () => {
    const { container, dispose } = mountWidget({ snapshot: richSnapshot });

    // Hero — title + status pill + branch
    expect(container.querySelector("[data-testid='mission-control-title']")?.textContent).toBe(
      "Fold src/ + packages/daemon",
    );
    expect(container.querySelector("[data-mission-status='active']")).toBeTruthy();
    expect(container.textContent).toContain("feat/v2.5.0");

    // KPIs — agents 2/3, tasks 3/6, validation 8/12
    const kpiSection = container.querySelector("[data-mission-section='kpis']");
    expect(kpiSection).toBeTruthy();
    const kpiText = kpiSection?.textContent ?? "";
    expect(kpiText).toContain("2/3"); // agents active/total
    expect(kpiText).toContain("3/6"); // tasks done/total
    expect(kpiText).toContain("8/12"); // validation

    // Milestones — three rows, M2 active with progress
    const milestones = container.querySelectorAll("[data-mission-milestone]");
    expect(milestones.length).toBe(3);
    const m2 = container.querySelector("[data-mission-milestone='M2']");
    expect(m2?.getAttribute("data-mission-milestone-status")).toBe("active");
    expect(m2?.textContent).toContain("3/6");

    // Tasks under M2 — mixed statuses (done/in-progress/review/todo)
    const m2Tasks = m2?.querySelectorAll("[data-mission-task]") ?? [];
    expect(m2Tasks.length).toBe(5);
    const statuses = Array.from(m2Tasks).map((t) => t.getAttribute("data-mission-task-status"));
    expect(statuses).toContain("done");
    expect(statuses).toContain("in-progress");
    expect(statuses).toContain("review");
    expect(statuses).toContain("todo");

    dispose();
  });

  it("renders the recent-event stream and routes 'show all' through onShowAllEvents", () => {
    const onShowAllEvents = vi.fn();
    const manyEvents = Array.from({ length: 25 }, (_, i) => ({
      timestamp: `2026-05-12T11:0${i % 10}:00Z`,
      type: "task.changed",
      message: `event ${i}`,
      relative: `${i}m`,
    }));
    const snapshot: MissionControlDashboardSnapshot = {
      ...richSnapshot,
      events: manyEvents,
    };
    const { container, dispose } = mountWidget({
      snapshot,
      eventLimit: 10,
      onShowAllEvents,
    });

    const eventsSection = container.querySelector("[data-mission-section='events']");
    expect(eventsSection).toBeTruthy();
    const eventRows = eventsSection?.querySelectorAll("[data-mission-event]") ?? [];
    // Limited to eventLimit (10)
    expect(eventRows.length).toBe(10);

    // "show all" appears because events.length > limit
    const showAll = container.querySelector<HTMLElement>(
      "[data-testid='mission-control-events-show-all']",
    );
    expect(showAll).toBeTruthy();
    showAll!.click();
    expect(onShowAllEvents).toHaveBeenCalledTimes(1);

    dispose();
  });

  it("renders agent badges with busy/idle state and fires onAgentClick", () => {
    const onAgentClick = vi.fn();
    const { container, dispose } = mountWidget({ snapshot: richSnapshot, onAgentClick });

    const agentSection = container.querySelector("[data-mission-section='agents']");
    expect(agentSection).toBeTruthy();
    const agentCards = agentSection?.querySelectorAll<HTMLElement>("[data-mission-agent]") ?? [];
    expect(agentCards.length).toBe(3);

    // Busy + idle attributes
    const busy = Array.from(agentCards).filter((a) => a.dataset.missionAgentBusy === "true");
    const idle = Array.from(agentCards).filter((a) => a.dataset.missionAgentBusy === "false");
    expect(busy.length).toBe(2);
    expect(idle.length).toBe(1);

    // Idle agent shows "idle" label in body
    expect(idle[0]?.textContent).toContain("idle");
    // Busy agent shows its current task title
    expect(busy[0]?.textContent).toContain("Port Mission Control to Solid");

    // Click fires onAgentClick with paneId
    agentCards[0]?.click();
    expect(onAgentClick).toHaveBeenCalledWith("%1");
    dispose();
  });

  it("fires onTaskClick when a task row is clicked", () => {
    const onTaskClick = vi.fn();
    const { container, dispose } = mountWidget({
      snapshot: richSnapshot,
      onTaskClick,
    });

    const taskRow = container.querySelector<HTMLElement>("[data-mission-task='004']");
    expect(taskRow).toBeTruthy();
    taskRow!.click();
    expect(onTaskClick).toHaveBeenCalledWith("004");
    dispose();
  });

  it("re-renders when snapshot is pushed via setOptions", () => {
    const { container, setOptions, dispose } = mountWidget({ snapshot: emptySnapshot });
    expect(container.querySelector("[data-testid='mission-control-empty']")).toBeTruthy();

    setOptions({ snapshot: richSnapshot });
    expect(container.querySelector("[data-testid='mission-control-empty']")).toBeNull();
    expect(container.querySelector("[data-testid='mission-control-title']")?.textContent).toBe(
      "Fold src/ + packages/daemon",
    );
    dispose();
  });
});
