import { expect, test, type Page } from "@playwright/test";

const PROJECT = "tmux-ide";

const PANES = [
  {
    id: "%1",
    index: 0,
    title: "Master",
    currentCommand: "zsh",
    width: 120,
    height: 32,
    active: false,
    role: "lead",
    name: "Master",
    type: null,
  },
  {
    id: "%2",
    index: 1,
    title: "Agent 1",
    currentCommand: "claude",
    width: 120,
    height: 32,
    active: true,
    role: "teammate",
    name: "Agent 1",
    type: null,
  },
];

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
      await route.fulfill({ json: { sessions: [session(PROJECT)] } });
      return;
    }

    const projectMatch = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const name = decodeURIComponent(projectMatch[1]!);
      const sub = projectMatch[2];
      if (name !== PROJECT) {
        await route.fulfill({ status: 404, json: { error: "Session not found" } });
        return;
      }
      if (!sub) {
        await route.fulfill({ json: project(name) });
        return;
      }
      if (sub === "panes") {
        await route.fulfill({ json: { panes: PANES } });
        return;
      }
      await route.fulfill({ json: [] });
      return;
    }

    await route.continue();
  });
}

async function mockPty(page: Page): Promise<string[]> {
  const wsIds: string[] = [];
  await page.routeWebSocket("**/ws/pty/**", (ws) => {
    const encodedId = ws.url().split("/").pop() ?? "";
    const id = decodeURIComponent(encodedId);
    wsIds.push(id);
    ws.send(`attached ${id}`);
    ws.onMessage((message) => {
      if (typeof message === "string" && message.startsWith("{")) return;
      ws.send(`echo ${id}`);
    });
  });
  return wsIds;
}

test.describe("tmux pane-backed terminal tabs", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("opening terminal mode auto-creates a tab per live tmux pane", async ({ page }) => {
    const wsIds = await mockPty(page);
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.getByTestId("terminal-toggle").click();

    await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
    await expect(page.getByTestId("terminal-tab").nth(0)).toContainText("tmux-ide · Master");
    await expect(page.getByTestId("terminal-tab").nth(1)).toContainText("tmux-ide · Agent 1");
    await expect
      .poll(() => wsIds)
      .toEqual(expect.arrayContaining([`${PROJECT}:%1`, `${PROJECT}:%2`]));
  });

  test("+ button lists panes that are not already attached", async ({ page }) => {
    await mockPty(page);
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
    await page.getByLabel("Close tmux-ide · Agent 1").click();

    await page.getByTestId("terminal-new-tab").click();
    await expect(page.getByTestId("terminal-pane-picker")).toBeVisible();
    await expect(page.getByTestId("terminal-pane-option-%2")).toContainText("Agent 1");
    await expect(page.getByTestId("terminal-pane-picker")).not.toContainText("Master");
  });

  test("clicking a pane option opens a pane-backed tab title", async ({ page }) => {
    await mockPty(page);
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
    await page.getByLabel("Close tmux-ide · Master").click();
    await page.getByTestId("terminal-new-tab").click();
    await page.getByTestId("terminal-pane-option-%1").click();

    await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
    await expect(page.getByTestId("terminal-tab").last()).toContainText("tmux-ide · Master");
  });
});
