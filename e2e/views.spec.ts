import { expect, test, type Page } from "@playwright/test";
import { fulfillSnapshotStream } from "./sse";

const PROJECT = "tmux-ide";

const stubProject = {
  session: PROJECT,
  dir: "/tmp/tmux-ide",
  mission: null,
  goals: [],
  tasks: [
    {
      id: "001",
      title: "Collapse project chrome",
      description: "Extract tab views",
      status: "todo",
      priority: 1,
      assignee: null,
      goal: null,
      tags: [],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    },
  ],
  agents: [],
};

const stubMetrics = {
  session: {
    startedAt: "2026-05-02T00:00:00.000Z",
    durationMs: 3_600_000,
    status: "running",
    agentCount: 2,
  },
  tasks: {
    total: 4,
    completed: 2,
    failed: 0,
    retried: 0,
    completionRate: 0.5,
    retryRate: 0,
    avgDurationMs: 600_000,
    medianDurationMs: 500_000,
    p90DurationMs: 900_000,
    byMilestone: [
      {
        id: "M1",
        title: "Foundation",
        status: "active",
        taskCount: 4,
        completedCount: 2,
        durationMs: 3_600_000,
      },
    ],
  },
  agents: [
    {
      name: "Agent 1",
      totalTimeMs: 3_600_000,
      activeTimeMs: 2_400_000,
      idleTimeMs: 1_200_000,
      taskCount: 2,
      retryCount: 0,
      utilization: 0.67,
      specialties: ["dashboard", "layout", "metrics", "overflow", "regression"],
    },
  ],
  mission: {
    title: "Ship v2.5.0",
    status: "active",
    milestonesCompleted: 0,
    validationPassRate: 0.75,
    wallClockMs: 3_600_000,
  },
  timeline: Array.from({ length: 24 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 4, 2, 12, index)).toISOString(),
    completedTasks: index,
    activeTasks: 1,
    busyAgents: 2,
    idleAgents: 0,
  })),
};

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
              dir: "/tmp/tmux-ide",
              mission: null,
              stats: { totalTasks: 1, doneTasks: 0, agents: 0, activeAgents: 0 },
            },
          ],
        },
      });
      return;
    }

    const projectMatch = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const [, encodedName, sub] = projectMatch;
      if (decodeURIComponent(encodedName) !== PROJECT) {
        await route.fulfill({ status: 404, json: null });
        return;
      }

      if (!sub) {
        await route.fulfill({ json: stubProject });
        return;
      }

      if (sub === "stream") {
        await fulfillSnapshotStream(route, {
          project: stubProject,
          mission: null,
          milestones: [],
          goals: stubProject.goals,
          tasks: stubProject.tasks,
          skills: [],
          agents: stubProject.agents,
          events: [],
        });
        return;
      }

      if (sub === "metrics") {
        await route.fulfill({ json: stubMetrics });
        return;
      }

      if (sub === "events") {
        await route.fulfill({ json: { events: [] } });
        return;
      }

      if (sub === "diff") {
        await route.fulfill({ json: { diff: "", files: [] } });
        return;
      }

      if (sub === "plans") {
        await route.fulfill({ json: { plans: [] } });
        return;
      }

      if (sub === "validation" || sub === "mission") {
        await route.fulfill({ json: null });
        return;
      }

      if (sub === "validation/coverage") {
        await route.fulfill({ json: { unclaimed: [], duplicates: {} } });
        return;
      }

      await route.fulfill({ json: [] });
      return;
    }

    await route.continue();
  });
}

test.describe("project views", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("defaults to KanbanView under the thin view tab bar", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await expect(page.getByTestId("project-view-tabs")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("TODO", { exact: true })).toBeVisible();
    await expect(page.getByText("Collapse project chrome")).toBeVisible();
  });

  test("metrics cards stay inside the metrics container", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);
    await page.getByRole("button", { name: "metrics", exact: true }).click();

    const metricsView = page.getByTestId("metrics-view");
    await expect(metricsView).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("kpi-card")).toHaveCount(4);

    await expect
      .poll(async () =>
        metricsView.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);

    const viewportWidth = page.viewportSize()?.width ?? 1280;
    for (const box of await page.getByTestId("kpi-card").evaluateAll((cards) =>
      cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    )) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(viewportWidth);
    }
  });
});
