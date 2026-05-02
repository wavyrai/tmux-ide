import { expect, test } from "@playwright/test";

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
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;

      if (path === "/api/sessions") {
        await route.fulfill({ json: [{ session: PROJECT, dir: "/tmp/tmux-ide" }] });
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
        await route.fulfill({ json: [] });
        return;
      }

      await route.continue();
    });
  });

  test("kanban ↔ terminal tab navigation", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    const terminalTab = page.getByRole("button", { name: "terminal", exact: true });
    const kanbanTab = page.getByRole("button", { name: "kanban", exact: true });

    await expect(terminalTab).toBeVisible({ timeout: 15_000 });
    await expect(kanbanTab).toBeVisible();

    await terminalTab.click();
    await expect(page).toHaveURL(/[?&]tab=terminal\b/);
    const frame = page.getByTestId("terminal-frame");
    await expect(frame).toHaveAttribute("data-state", "connected", { timeout: 30_000 });

    await kanbanTab.click();
    await expect(page).not.toHaveURL(/[?&]tab=terminal\b/);
    await expect(page.getByTestId("terminal-frame")).toHaveCount(0);
  });

  test("deep link to terminal tab", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}?tab=terminal`);

    const frame = page.getByTestId("terminal-frame");
    await expect(frame).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  });
});
