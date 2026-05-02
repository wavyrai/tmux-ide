import { expect, test, type Page } from "@playwright/test";

const PROJECTS = ["tmux-ide", "docs"];
const MOD_KEY = process.platform === "darwin" ? "Meta" : "Control";

function session(name: string) {
  return {
    name,
    dir: `/tmp/${name}`,
    mission: null,
    stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
  };
}

function project(name: string) {
  return {
    session: name,
    dir: `/tmp/${name}`,
    mission: null,
    goals: [],
    tasks: [],
    agents: [],
  };
}

async function mockApi(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/sessions") {
      await route.fulfill({ json: { sessions: PROJECTS.map(session) } });
      return;
    }

    const projectMatch = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const [, encodedName, sub] = projectMatch;
      const name = decodeURIComponent(encodedName);
      if (!PROJECTS.includes(name)) {
        await route.fulfill({ status: 404, json: null });
        return;
      }
      if (!sub) {
        await route.fulfill({ json: project(name) });
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

test.describe("workspace tabs shell", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("clicking a project opens a workspace tab", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId(`sidebar-session-${PROJECTS[0]}`).click();

    await expect(page).toHaveURL(new RegExp(`/project/${PROJECTS[0]}`));
    await expect(page.getByTestId("workspace-tabs-bar")).toBeVisible();
    await expect(page.getByTestId("workspace-tab")).toHaveText(new RegExp(PROJECTS[0]!));
  });

  test("tabs persist across nav and close returns to the previous project", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId(`sidebar-session-${PROJECTS[0]}`).click();
    await page.getByTestId(`sidebar-session-${PROJECTS[1]}`).click();

    await expect(page.getByTestId("workspace-tab")).toHaveCount(2);
    await expect(page.getByTestId("workspace-tab").nth(0)).toContainText(PROJECTS[0]!);
    await expect(page.getByTestId("workspace-tab").nth(1)).toContainText(PROJECTS[1]!);

    await page.getByRole("button", { name: `Close ${PROJECTS[1]}`, exact: true }).click();

    await expect(page.getByTestId("workspace-tab")).toHaveCount(1);
    await expect(page.getByTestId("workspace-tab")).toContainText(PROJECTS[0]!);
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECTS[0]}`));
  });

  test("settings activity opens a settings tab", async ({ page }) => {
    await page.goto("/");

    await page.getByTestId("activity-section-settings").click();

    await expect(page.getByTestId("workspace-tabs-bar")).toBeVisible();
    await expect(page.getByTestId("workspace-tab")).toContainText("Settings");
    await expect(page.getByTestId("sidebar-settings")).toBeVisible();
  });

  test("Cmd-J still opens terminal mode", async ({ page }) => {
    await page.goto(`/project/${PROJECTS[0]}`);
    await expect(page.getByTestId("terminal-toggle")).toBeVisible();

    await page.keyboard.press(`${MOD_KEY}+KeyJ`);

    await expect(page.getByTestId("full-screen-terminal")).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("terminal-frame")).toHaveAttribute("data-state", "connected", {
      timeout: 30_000,
    });
  });
});
