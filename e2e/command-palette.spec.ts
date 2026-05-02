import { expect, test, type Page } from "@playwright/test";

const PROJECT = "tmux-ide";
const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control";

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
        await route.fulfill({
          json: {
            session: PROJECT,
            dir: "/tmp/tmux-ide",
            mission: null,
            goals: [],
            tasks: [],
            agents: [],
          },
        });
        return;
      }
      if (sub === "mission") {
        await route.fulfill({ json: null });
        return;
      }
      await route.fulfill({ json: [] });
      return;
    }

    await route.continue();
  });
}

test.describe("command palette", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("Mod-K opens, filters, runs a terminal action, and Escape closes", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.keyboard.press(`${MOD_KEY}+KeyK`);
    await expect(page.getByTestId("command-palette")).toBeVisible();

    await page.getByTestId("palette-input").fill("term");
    await expect(page.getByTestId("palette-item").first()).toContainText(/terminal/i);

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
    await expect(page.getByTestId("full-screen-terminal")).toBeVisible();

    await page.getByTestId("command-palette-button").click();
    await expect(page.getByTestId("command-palette")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-palette")).toHaveCount(0);
  });
});
