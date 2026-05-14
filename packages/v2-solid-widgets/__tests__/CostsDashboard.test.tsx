import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { CostsDashboardView } from "../src/widgets/CostsDashboard";
import type { CostsDashboardMountOptions, CostsDashboardSnapshot } from "../src/types";

function mountWidget(initial: CostsDashboardMountOptions) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [options, setOptions] = createSignal<CostsDashboardMountOptions>(initial);
  const dispose = render(() => <CostsDashboardView options={options} />, container);
  return {
    container,
    dispose,
    setOptions: (next: Partial<CostsDashboardMountOptions>) =>
      setOptions((cur) => ({ ...cur, ...next })),
  };
}

const emptySnapshot: CostsDashboardSnapshot = {
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
  timeline: [],
};

const singleAgentSnapshot: CostsDashboardSnapshot = {
  session: {
    startedAt: "2026-05-12T10:00:00Z",
    durationMs: 1_800_000, // 30 min
    status: "active",
    agentCount: 1,
  },
  tasks: {
    total: 10,
    completed: 7,
    failed: 1,
    retried: 1,
    completionRate: 0.7,
    retryRate: 0.1,
    avgDurationMs: 240_000, // 4 min
    medianDurationMs: 180_000,
    p90DurationMs: 540_000,
    byMilestone: [
      {
        id: "M1",
        title: "Foundation",
        status: "done",
        taskCount: 5,
        completedCount: 5,
        durationMs: 1_500_000,
      },
    ],
  },
  agents: [
    {
      name: "Camille",
      totalTimeMs: 1_800_000,
      activeTimeMs: 1_500_000,
      idleTimeMs: 300_000,
      taskCount: 7,
      retryCount: 1,
      utilization: 0.83,
      specialties: ["frontend"],
    },
  ],
  mission: {
    title: "Ship v2.5",
    status: "active",
    milestonesCompleted: 1,
    validationPassRate: 0.92,
    wallClockMs: 1_800_000,
  },
  timeline: [
    {
      timestamp: "2026-05-12T10:00:00Z",
      completedTasks: 0,
      activeTasks: 1,
      busyAgents: 1,
      idleAgents: 0,
    },
    {
      timestamp: "2026-05-12T10:30:00Z",
      completedTasks: 7,
      activeTasks: 0,
      busyAgents: 0,
      idleAgents: 1,
    },
  ],
};

const multiAgentSnapshot: CostsDashboardSnapshot = {
  ...singleAgentSnapshot,
  session: { ...singleAgentSnapshot.session, agentCount: 4 },
  agents: [
    {
      name: "Camille",
      totalTimeMs: 1_800_000,
      activeTimeMs: 1_500_000,
      idleTimeMs: 300_000,
      taskCount: 7,
      retryCount: 1,
      utilization: 0.83,
      specialties: ["frontend"],
    },
    {
      name: "Pty Agent",
      totalTimeMs: 1_800_000,
      activeTimeMs: 1_200_000,
      idleTimeMs: 600_000,
      taskCount: 5,
      retryCount: 0,
      utilization: 0.67,
      specialties: ["backend", "sqlite"],
    },
    {
      name: "Tests",
      totalTimeMs: 1_800_000,
      activeTimeMs: 600_000,
      idleTimeMs: 1_200_000,
      taskCount: 3,
      retryCount: 2,
      utilization: 0.33,
      specialties: [],
    },
    {
      name: "Wide",
      totalTimeMs: 1_800_000,
      activeTimeMs: 0,
      idleTimeMs: 1_800_000,
      taskCount: 0,
      retryCount: 0,
      utilization: 0,
      specialties: [],
    },
  ],
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CostsDashboard (Solid widget)", () => {
  it("renders the loading state when no snapshot has arrived yet", () => {
    const { container, dispose } = mountWidget({ snapshot: null });
    expect(container.querySelector("[data-testid='costs-dashboard-loading']")).toBeTruthy();
    dispose();
  });

  it("renders the empty state when snapshot has no usage", () => {
    const { container, dispose } = mountWidget({ snapshot: emptySnapshot });
    expect(container.querySelector("[data-testid='costs-dashboard-empty']")).toBeTruthy();
    // Agents / milestones / timeline sections suppressed when empty.
    expect(container.querySelector("[data-costs-section='agents']")).toBeNull();
    expect(container.querySelector("[data-costs-section='milestones']")).toBeNull();
    expect(container.querySelector("[data-costs-section='timeline']")).toBeNull();
    dispose();
  });

  it("renders a single agent with modest usage and a complete milestone", () => {
    const { container, dispose } = mountWidget({ snapshot: singleAgentSnapshot });

    // KPIs visible: completion 70% (yellow), avg util 83% (green),
    // retry rate 10% (green).
    const kpis = container.querySelector("[data-costs-section='kpis']");
    expect(kpis).toBeTruthy();
    const kpiText = kpis?.textContent ?? "";
    expect(kpiText).toContain("70%"); // completion rate
    expect(kpiText).toContain("83%"); // avg utilization
    expect(kpiText).toContain("10%"); // retry rate

    // Tasks summary line: 7/10 done, 1 failed, avg/median/p90 present.
    const tasksSummary = container.querySelector("[data-costs-section='tasks-summary']");
    expect(tasksSummary?.textContent).toContain("7");
    expect(tasksSummary?.textContent).toContain("/10");
    expect(tasksSummary?.textContent).toContain("failed");

    // Milestones: single row, status=done.
    const milestones = container.querySelectorAll("[data-costs-milestone]");
    expect(milestones.length).toBe(1);
    expect(milestones[0]?.getAttribute("data-costs-milestone-status")).toBe("done");
    expect(milestones[0]?.textContent).toContain("M1");
    expect(milestones[0]?.textContent).toContain("Foundation");

    // Agents: single row, Camille @ 83%.
    const agents = container.querySelectorAll("[data-costs-agent]");
    expect(agents.length).toBe(1);
    expect(agents[0]?.getAttribute("data-costs-agent")).toBe("Camille");
    expect(agents[0]?.textContent).toContain("83%");
    expect(agents[0]?.textContent).toContain("7 tasks");

    // Mission card present (title set).
    expect(container.querySelector("[data-costs-section='mission']")).toBeTruthy();

    dispose();
  });

  it("renders a multi-agent breakdown sorted by utilization", () => {
    const { container, dispose } = mountWidget({ snapshot: multiAgentSnapshot });

    const agents = container.querySelectorAll<HTMLElement>("[data-costs-agent]");
    expect(agents.length).toBe(4);
    // Sorted descending by utilization: Camille (83%) -> Pty (67%) -> Tests (33%) -> Wide (0%)
    const names = Array.from(agents).map((a) => a.getAttribute("data-costs-agent"));
    expect(names).toEqual(["Camille", "Pty Agent", "Tests", "Wide"]);

    // Retry badge appears only on the agent with retries (Tests, 2 retries).
    const retryBadge = container.querySelector(
      "[data-costs-agent='Tests'] [data-costs-agent-retries]",
    );
    expect(retryBadge?.textContent).toContain("2 retries");
    // Wide has no retries — no badge.
    expect(
      container.querySelector("[data-costs-agent='Wide'] [data-costs-agent-retries]"),
    ).toBeNull();

    // Timeline rows render (2 rows in the fixture).
    const timelineRows = container.querySelectorAll("[data-costs-timeline-row]");
    expect(timelineRows.length).toBe(2);

    dispose();
  });

  it("re-renders agent rows when the host pushes a new snapshot", () => {
    const { container, setOptions, dispose } = mountWidget({ snapshot: singleAgentSnapshot });

    // Initial: 1 agent (Camille, 7 tasks, 83% utilization).
    let agents = container.querySelectorAll<HTMLElement>("[data-costs-agent]");
    expect(agents.length).toBe(1);
    expect(agents[0]?.textContent).toContain("7 tasks");

    // Push a snapshot where Camille now has 9 tasks and a second agent joined.
    const next: CostsDashboardSnapshot = {
      ...singleAgentSnapshot,
      agents: [
        {
          name: "Camille",
          totalTimeMs: 2_400_000,
          activeTimeMs: 2_000_000,
          idleTimeMs: 400_000,
          taskCount: 9,
          retryCount: 1,
          utilization: 0.83,
          specialties: ["frontend"],
        },
        {
          name: "Pty",
          totalTimeMs: 1_200_000,
          activeTimeMs: 600_000,
          idleTimeMs: 600_000,
          taskCount: 2,
          retryCount: 0,
          utilization: 0.5,
          specialties: ["backend"],
        },
      ],
    };
    setOptions({ snapshot: next });

    agents = container.querySelectorAll<HTMLElement>("[data-costs-agent]");
    expect(agents.length).toBe(2);
    const camille = container.querySelector("[data-costs-agent='Camille']");
    expect(camille?.textContent).toContain("9 tasks");
    expect(container.querySelector("[data-costs-agent='Pty']")).toBeTruthy();

    dispose();
  });

  it("color-codes thresholds: red retry rate, yellow completion rate, green utilization", () => {
    const stressSnapshot: CostsDashboardSnapshot = {
      ...singleAgentSnapshot,
      tasks: {
        ...singleAgentSnapshot.tasks,
        completionRate: 0.4, // yellow (< 0.8)
        retryRate: 0.3, // red (> 0.2)
      },
    };
    const { container, dispose } = mountWidget({ snapshot: stressSnapshot });

    // Look up the inline color on the completion-rate / retry-rate KPI values.
    const completionKpi = container.querySelector<HTMLElement>(
      "[data-costs-kpi='completion rate']",
    );
    const retryKpi = container.querySelector<HTMLElement>("[data-costs-kpi='retry rate']");
    expect(completionKpi).toBeTruthy();
    expect(retryKpi).toBeTruthy();
    // The big value is the second child; assert its inline color reflects the threshold.
    const completionValue = completionKpi!.querySelectorAll("div")[1] as HTMLElement;
    const retryValue = retryKpi!.querySelectorAll("div")[1] as HTMLElement;
    expect(completionValue.style.color).toBe("var(--yellow)");
    expect(retryValue.style.color).toBe("var(--red)");
    dispose();
  });
});
