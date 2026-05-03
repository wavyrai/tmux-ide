import { expect, test, type Page } from "@playwright/test";
import { fulfillSnapshotStream } from "./sse";

const PROJECT = "tmux-ide";

const baseTask = {
  id: "001",
  title: "Open task panel",
  description: "Inspect and edit details",
  goal: null,
  status: "todo",
  assignee: null,
  priority: 2,
  created: "2026-05-03T00:00:00.000Z",
  updated: "2026-05-03T00:00:00.000Z",
  tags: ["panel"],
  proof: null,
  retryCount: 0,
  maxRetries: 5,
  lastError: null,
  nextRetryAt: null,
  depends_on: [],
  milestone: "M1",
  specialty: null,
  fulfills: [],
  discoveredIssues: [],
  salientSummary: null,
};

async function mockApi(page: Page) {
  let task = { ...baseTask };
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
              dir: `/tmp/${PROJECT}`,
              mission: null,
              stats: { totalTasks: 1, doneTasks: task.status === "done" ? 1 : 0, agents: 0 },
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

    const project = {
      session: PROJECT,
      dir: `/tmp/${PROJECT}`,
      mission: null,
      goals: [],
      agents: [],
      tasks: [task],
    };

    if (!sub) {
      await route.fulfill({ json: project });
      return;
    }

    if (sub === "stream") {
      await fulfillSnapshotStream(route, {
        project,
        mission: null,
        milestones: [],
        goals: [],
        tasks: [task],
        skills: [],
        agents: [],
        events: [
          {
            timestamp: "2026-05-03T00:00:00.000Z",
            type: "dispatch",
            taskId: task.id,
            message: "Dispatched task 001",
            relative: "now",
          },
        ],
      });
      return;
    }

    if (sub === "task/001" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Partial<typeof task>;
      task = { ...task, ...body, updated: "2026-05-03T00:01:00.000Z" };
      await route.fulfill({ json: { ok: true, task } });
      return;
    }

    if (sub === "events") {
      await route.fulfill({ json: { events: [] } });
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

    await route.fulfill({ json: [] });
  });
}

test.describe("task detail panel", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("opens from a kanban card, saves title edits, marks done, and closes", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.getByText("Open task panel").click();
    await expect(page.getByTestId("task-detail-panel")).toBeVisible({ timeout: 15_000 });

    const title = page.getByTestId("task-panel-edit-title");
    await title.fill("Updated panel title");
    await expect(page.getByText("saved")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Mark done" }).click();
    await expect(page.getByTestId("task-panel-status")).toHaveText("DONE");

    await page.getByLabel("Close task panel").click();
    await expect(page.getByTestId("task-detail-panel")).toBeHidden({ timeout: 1000 });
  });
});
