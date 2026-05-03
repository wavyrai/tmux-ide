import { expect, test } from "@playwright/test";
import { fulfillSnapshotStream } from "./sse";

const PROJECT = "tmux-ide";

const stubProject = {
  session: PROJECT,
  dir: "/tmp/tmux-ide",
  mission: null,
  goals: [],
  tasks: [],
  agents: [],
};

test.describe("project shell", () => {
  test.beforeEach(async ({ page }) => {
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
                stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
              },
            ],
          },
        });
        return;
      }

      const projectMatch = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
      if (projectMatch) {
        const [, name, sub] = projectMatch;
        if (decodeURIComponent(name) !== PROJECT) {
          await route.fulfill({ status: 404, json: null });
          return;
        }
        if (!sub) {
          await route.fulfill({ json: stubProject });
          return;
        }
        if (sub === "mission") {
          await route.fulfill({ json: null });
          return;
        }
        if (sub === "stream") {
          await fulfillSnapshotStream(route, {
            project: stubProject,
            mission: null,
            milestones: [],
            goals: [],
            tasks: [],
            skills: [],
            agents: [],
            events: [],
          });
          return;
        }
        await route.fulfill({ json: [] });
        return;
      }

      await route.continue();
    });
  });

  test("kanban ↔ mission tab navigation", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    const missionTab = page.getByRole("button", { name: "mission", exact: true });
    const kanbanTab = page.getByRole("button", { name: "kanban", exact: true });

    await expect(missionTab).toBeVisible({ timeout: 15_000 });
    await expect(kanbanTab).toBeVisible();

    await missionTab.click();
    await expect(page).toHaveURL(/[?&]tab=mission\b/);
    await expect(page.getByText("No active mission")).toBeVisible();

    await kanbanTab.click();
    await expect(page).not.toHaveURL(/[?&]tab=mission\b/);
  });

  test("deep link to mission tab", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}?tab=mission`);

    await expect(page.getByText("No active mission")).toBeVisible({ timeout: 15_000 });
  });
});
