import { expect, test, type Page } from "@playwright/test";

const PROJECTS = ["tmux-ide", "docs"];

function session(name: string) {
  return {
    name,
    // Point at the repo root so the bridge's tmux-ide spawn has a real
    // cwd (and a real ide.yml). /tmp/<name> doesn't exist → ENOENT.
    dir: process.cwd(),
    mission: null,
    stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
  };
}

function project(name: string) {
  return {
    session: name,
    // Point at the repo root so the bridge's tmux-ide spawn has a real
    // cwd (and a real ide.yml). /tmp/<name> doesn't exist → ENOENT.
    dir: process.cwd(),
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

async function toggleTerminal(page: Page) {
  await page.getByTestId("terminal-toggle").click();
}

function visibleTranscript(page: Page) {
  return page
    .locator('[data-terminal-slot][data-active] [data-testid="terminal-transcript"]')
    .first();
}

async function openTerminalMode(page: Page, mode: "keybind" | "button" = "button") {
  if (mode === "button") {
    await page.getByTestId("terminal-toggle").click();
  } else {
    await toggleTerminal(page);
  }
  const frame = page.getByTestId("terminal-frame");
  await expect(frame).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  return frame;
}

test.describe("full-screen terminal mode", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await mockApi(page);
  });

  test("terminal toggle opens and closes terminal mode while preserving state", async ({
    page,
  }) => {
    await page.goto("/");

    const section = page.getByTestId("full-screen-terminal");

    await openTerminalMode(page, "keybind");
    await expect(section).toHaveAttribute("data-open", "true");

    await toggleTerminal(page);
    // Section stays mounted with data-open="false" so xterm + WS state survives.
    await expect(section).toHaveAttribute("data-open", "false");
    await expect(section).toBeAttached();

    // Re-open: same xterm instance, no reconnect required.
    await toggleTerminal(page);
    await expect(section).toHaveAttribute("data-open", "true");
    await expect(page.getByTestId("terminal-frame")).toHaveAttribute("data-state", "connected");
  });

  test("newTab adds a tab", async ({ page }) => {
    await page.goto("/");

    await openTerminalMode(page);
    await expect(page.getByTestId("terminal-tab")).toHaveCount(1);

    await page.getByTestId("terminal-new-tab").click();
    await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
  });

  test("tabs are scoped per project — switching sidebar shows the other project's tabs", async ({
    page,
  }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECTS[0]!)}`);

    // Open terminal mode for project A; auto-creates one tab there.
    const frameA = await openTerminalMode(page);
    await expect(page.getByTestId("terminal-tab")).toHaveCount(1);

    await frameA.click();
    await page.keyboard.type("echo project-a-content");
    await page.keyboard.press("Enter");
    await expect(visibleTranscript(page)).toContainText("project-a-content");

    // Switch sidebar to project B. Terminal mode stays open. Project B has no
    // tabs of its own, so a fresh tab is auto-created — and it does NOT show
    // project A's content.
    await page
      .getByTestId(`sidebar-session-${PROJECTS[1]}`)
      .evaluate((element: HTMLElement) => element.click());
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECTS[1]}`));
    await expect(page.getByTestId("full-screen-terminal")).toBeVisible();
    await expect(page.getByTestId("terminal-tab")).toHaveCount(1);
    await expect(page.getByTestId("terminal-tab")).toContainText(PROJECTS[1]!);

    // Switch back to project A — its tab + transcript are still there.
    await page
      .getByTestId(`sidebar-session-${PROJECTS[0]}`)
      .evaluate((element: HTMLElement) => element.click());
    await expect(page).toHaveURL(new RegExp(`/project/${PROJECTS[0]}`));
    await expect(page.getByTestId("terminal-tab")).toHaveCount(1);
    await expect(visibleTranscript(page)).toContainText("project-a-content");
  });
});
