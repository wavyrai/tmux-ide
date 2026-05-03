import { expect, test, type Page } from "@playwright/test";

const PROJECT = "tmux-ide";

const stubProject = {
  session: PROJECT,
  dir: "/tmp/tmux-ide",
  mission: null,
  goals: [],
  agents: [],
  tasks: [
    {
      id: "001",
      title: "Make dashboard responsive",
      description: "Stack mobile kanban columns",
      status: "todo",
      priority: 1,
      assignee: null,
      goal: null,
      tags: [],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    },
    {
      id: "002",
      title: "Verify drawer chrome",
      description: "Open mobile navigation",
      status: "in-progress",
      priority: 2,
      assignee: null,
      goal: null,
      tags: [],
      createdAt: "2026-05-02T00:00:00.000Z",
      updatedAt: "2026-05-02T00:00:00.000Z",
    },
  ],
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
              stats: { totalTasks: 2, doneTasks: 0, agents: 0, activeAgents: 0 },
            },
          ],
        },
      });
      return;
    }

    const projectMatch = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
    if (!projectMatch) {
      await route.continue();
      return;
    }

    const [, encodedName, sub] = projectMatch;
    if (decodeURIComponent(encodedName!) !== PROJECT) {
      await route.fulfill({ status: 404, json: null });
      return;
    }

    if (!sub) {
      await route.fulfill({ json: stubProject });
      return;
    }

    if (sub === "mission" || sub === "validation") {
      await route.fulfill({ json: null });
      return;
    }
    if (sub === "milestones") {
      await route.fulfill({ json: { milestones: [] } });
      return;
    }
    if (sub === "skills") {
      await route.fulfill({ json: { skills: [] } });
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
    if (sub === "validation/coverage") {
      await route.fulfill({ json: { unclaimed: [], duplicates: {} } });
      return;
    }

    await route.fulfill({ json: [] });
  });
}

test.describe("responsive dashboard", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("uses drawer chrome and stacks kanban columns on mobile", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await expect(page.getByTestId("mobile-nav-toggle")).toBeVisible();
    await expect(page.getByTestId("activity-bar-inline")).toBeHidden();

    await page.getByTestId("mobile-nav-toggle").click();
    await expect(page.getByTestId("mobile-shell-drawer")).toBeVisible();
    await expect(page.getByTestId("activity-bar-drawer")).toBeVisible();
    await expect(page.getByTestId("sidebar-drawer")).toBeVisible();

    await expect(page.getByTestId("kanban-board")).toBeVisible();
    await expect
      .poll(async () =>
        page.getByTestId("kanban-board").evaluate((element) => {
          const columns = getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean);
          return columns.length;
        }),
      )
      .toBe(1);
  });
});
