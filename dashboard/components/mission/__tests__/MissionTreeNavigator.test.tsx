import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MissionTreeNavigator } from "../MissionTreeNavigator";

const SNAPSHOT = {
  project: {
    session: "alpha",
    dir: "/repos/alpha",
    mission: { title: "Ship v2", description: "", status: "active", branch: null, milestones: [] },
    goals: [
      {
        id: "01",
        title: "Auth system",
        description: "",
        status: "in-progress",
        acceptance: "",
        priority: 1,
        created: "",
        updated: "",
        assignee: null,
        specialty: null,
        milestone: "M1",
      },
    ],
    tasks: [
      {
        id: "001",
        title: "Implement JWT",
        description: "",
        goal: "01",
        status: "in-progress",
        assignee: null,
        priority: 1,
        created: "",
        updated: "",
        tags: [],
        proof: null,
        retryCount: 0,
        maxRetries: 3,
        lastError: null,
        nextRetryAt: null,
        depends: [],
        fulfills: [],
        salientSummary: null,
      },
    ],
    agents: [],
  },
  mission: {
    mission: {
      title: "Ship v2",
      description: "",
      status: "active",
      branch: null,
      milestones: [],
    },
    validationSummary: { total: 0, passing: 0, failing: 0, pending: 0, blocked: 0 },
  },
  milestones: [
    { id: "M1", title: "Foundation", description: "", status: "active", order: 1, taskCount: 1, tasksDone: 0 },
  ],
  goals: [],
  tasks: [],
  skills: [],
  agents: [],
  events: [],
};

vi.mock("@/lib/useSessionStream", () => ({
  useSessionStream: () => ({
    snapshot: SNAPSHOT,
    lastEventAt: 0,
    connected: true,
  }),
}));

describe("MissionTreeNavigator", () => {
  it("renders mission title, milestone, goal, and task tree", () => {
    render(<MissionTreeNavigator sessionName="alpha" />);
    expect(screen.getByTestId("mission-tree-navigator")).toBeTruthy();
    expect(screen.getAllByText("Ship v2").length).toBeGreaterThan(0);
    expect(screen.getByTestId("navigator-milestone-M1")).toBeTruthy();
    expect(screen.getByTestId("navigator-goal-01")).toBeTruthy();
    expect(screen.getByTestId("navigator-task-001")).toBeTruthy();
  });

  it("collapses a milestone when clicked", async () => {
    render(<MissionTreeNavigator sessionName="alpha" />);
    const milestoneButton = screen.getByTestId("navigator-milestone-M1");
    expect(milestoneButton.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.click(milestoneButton);
    });
    expect(milestoneButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("filters the tree via the search input", async () => {
    render(<MissionTreeNavigator sessionName="alpha" />);
    const search = screen.getByTestId("mission-tree-search") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(search, { target: { value: "no-such-thing" } });
    });
    expect(search.value).toBe("no-such-thing");
    expect(screen.getByText("no matches")).toBeTruthy();
  });

  it("invokes onTaskClick when a task row is selected", async () => {
    const onTaskClick = vi.fn();
    render(<MissionTreeNavigator sessionName="alpha" onTaskClick={onTaskClick} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("navigator-task-001"));
    });
    expect(onTaskClick).toHaveBeenCalled();
    expect(onTaskClick.mock.calls[0]![0].id).toBe("001");
  });
});
