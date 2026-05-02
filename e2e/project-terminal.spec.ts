import { expect, test, type Page } from "@playwright/test";

const PROJECT = "X";
const PROJECT_DIR = "/tmp/X-dir";

function session(name: string) {
  return {
    name,
    dir: PROJECT_DIR,
    mission: null,
    stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
    goals: [],
  };
}

function project(name: string) {
  return {
    session: name,
    dir: PROJECT_DIR,
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
      if (sub === "mission") {
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
      await route.fulfill({ json: [] });
      return;
    }

    await route.continue();
  });
}

async function mockPty(page: Page): Promise<Array<Record<string, unknown>>> {
  const initFrames: Array<Record<string, unknown>> = [];
  await page.routeWebSocket("**/ws/pty/**", (ws) => {
    ws.send("tmux-ide ready");
    ws.onMessage((message) => {
      if (typeof message !== "string" || !message.startsWith("{")) return;
      const frame = JSON.parse(message) as Record<string, unknown>;
      if (frame.type === "init") initFrames.push(frame);
    });
  });
  return initFrames;
}

test.describe("project terminal tabs", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("opening terminal mode for a project spawns one shell tab in the project dir", async ({
    page,
  }) => {
    const initFrames = await mockPty(page);
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.getByTestId("terminal-toggle").click();

    await expect(page.getByTestId("terminal-tab")).toHaveCount(1);
    await expect(page.getByTestId("terminal-tab")).toContainText(PROJECT);
    await expect.poll(() => initFrames.length).toBe(1);
    // No `cmd` is sent — server falls back to $SHELL -l so users land in
    // their actual login shell (zsh, etc.). Just verify the project dir
    // is forwarded as cwd.
    expect(initFrames[0]).toMatchObject({ type: "init", cwd: PROJECT_DIR });
    expect((initFrames[0] as { cmd?: string[] }).cmd).toBeUndefined();
  });

  test("+ button creates a second tab in the same project dir", async ({ page }) => {
    const initFrames = await mockPty(page);
    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);

    await page.getByTestId("terminal-toggle").click();
    await expect(page.getByTestId("terminal-tab")).toHaveCount(1);
    await expect.poll(() => initFrames.length).toBe(1);

    await page.getByTestId("terminal-new-tab").click();

    await expect(page.getByTestId("terminal-tab")).toHaveCount(2);
    await expect.poll(() => initFrames.length).toBe(2);
    for (const frame of initFrames) {
      expect(frame).toMatchObject({ cwd: PROJECT_DIR });
      expect((frame as { cmd?: string[] }).cmd).toBeUndefined();
    }
  });
});
