import { expect, test, type Page } from "@playwright/test";
import { fulfillSnapshotStream } from "./sse";

const PROJECT = "X";

const project = {
  session: PROJECT,
  dir: "/tmp/x",
  mission: {
    title: "Ship v2",
    description: "Deliver the dashboard release",
    status: "active",
    branch: "feat/v2.5.0",
  },
  goals: [],
  tasks: [
    { id: "001", title: "Done task", status: "done", priority: 1, goal: null },
    { id: "002", title: "Active task", status: "in-progress", priority: 2, goal: null },
  ],
  agents: [
    {
      paneTitle: "Agent 1",
      paneId: "%1",
      isBusy: true,
      taskTitle: "Build status bar",
      taskId: "002",
      elapsed: "4m",
    },
    {
      paneTitle: "Agent 2",
      paneId: "%2",
      isBusy: true,
      taskTitle: "Remove chrome",
      taskId: "003",
      elapsed: "7m",
    },
    {
      paneTitle: "Agent 3",
      paneId: "%3",
      isBusy: false,
      taskTitle: null,
      taskId: null,
      elapsed: "idle",
    },
  ],
};

const mission = {
  mission: {
    title: "Ship v2",
    description: "Deliver the dashboard release",
    status: "active",
    branch: "feat/v2.5.0",
    milestones: [],
  },
  validationSummary: {
    total: 5,
    passing: 4,
    failing: 1,
    pending: 0,
    blocked: 0,
  },
};

const milestones = [
  {
    id: "M1",
    title: "Foundation",
    description: "Complete the base",
    status: "done",
    order: 1,
    taskCount: 3,
    tasksDone: 3,
  },
  {
    id: "M2",
    title: "Dashboard",
    description: "Finish dashboard slices",
    status: "active",
    order: 2,
    taskCount: 7,
    tasksDone: 4,
  },
];

const skills = [
  {
    name: "react",
    specialties: ["ui"],
    role: "frontend",
    description: "React UI work",
    body: "",
  },
  {
    name: "playwright",
    specialties: ["e2e"],
    role: "testing",
    description: "Browser tests",
    body: "",
  },
];

async function mockApi(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/sessions") {
      await route.fulfill({
        json: {
          sessions: [
            {
              name: PROJECT,
              dir: "/tmp/x",
              mission: project.mission,
              stats: { totalTasks: 2, doneTasks: 1, agents: 3, activeAgents: 2 },
              goals: [],
            },
          ],
        },
      });
      return;
    }

    const match = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
      await route.continue();
      return;
    }

    const name = decodeURIComponent(match[1]!);
    const sub = match[2];
    if (name !== PROJECT) {
      await route.fulfill({ status: 404, json: { error: "Session not found" } });
      return;
    }

    if (!sub) {
      await route.fulfill({ json: project });
      return;
    }
    if (sub === "stream") {
      await fulfillSnapshotStream(route, {
        project,
        mission,
        milestones,
        goals: project.goals,
        tasks: project.tasks,
        skills,
        agents: project.agents,
        events: [],
      });
      return;
    }
    if (sub === "mission") {
      await route.fulfill({ json: mission });
      return;
    }
    if (sub === "milestones") {
      await route.fulfill({ json: { milestones } });
      return;
    }
    if (sub === "skills") {
      await route.fulfill({ json: { skills } });
      return;
    }
    if (sub === "events") {
      await route.fulfill({ json: { events: [] } });
      return;
    }

    await route.fulfill({ json: [] });
  });
}

test.describe("status bar project segments", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("shows contextual project segments and dismisses popovers", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await expect(page.getByTestId("status-segment-mission")).toContainText("Ship v2 - active");
    await expect(page.getByTestId("status-segment-milestones")).toContainText("M2 · 4/7");
    await expect(page.getByTestId("status-segment-agents")).toContainText("2/3 agents");

    await page.getByTestId("status-segment-mission").click();
    await expect(page.getByTestId("status-popover")).toContainText("Deliver the dashboard release");
    await expect(page.getByTestId("status-popover")).toContainText("4/5 passing, 1 failing");

    await page.mouse.click(5, 5);
    await expect(page.getByTestId("status-popover")).toBeHidden();
  });
});
