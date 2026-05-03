import { expect, test, type Page } from "@playwright/test";

const PROJECT = "X";
const mission = {
  mission: {
    title: "Ship context injection",
    description: "Make context buttons inject useful prompts.",
    status: "active",
    branch: "feat/v2.5.0",
    milestones: [],
  },
  validationSummary: {
    total: 0,
    passing: 0,
    failing: 0,
    pending: 0,
    blocked: 0,
  },
};

function session(name: string) {
  return {
    name,
    dir: process.cwd(),
    mission: { title: mission.mission.title },
    stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
  };
}

function project(name: string) {
  return {
    session: name,
    dir: process.cwd(),
    mission: { title: mission.mission.title },
    goals: [],
    tasks: [],
    agents: [],
  };
}

async function mockApi(page: Page, injected: Array<Record<string, unknown>>) {
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
        await route.fulfill({ json: mission });
        return;
      }
      if (sub === "inject") {
        injected.push((await route.request().postDataJSON()) as Record<string, unknown>);
        await route.fulfill({ json: { ok: true } });
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

async function mockPty(page: Page) {
  await page.routeWebSocket("**/ws/pty/**", (ws) => {
    ws.send("ready");
  });
}

test.describe("context bar", () => {
  test("injects mission and recap prompts into the active project", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const injected: Array<Record<string, unknown>> = [];
    await mockApi(page, injected);
    await mockPty(page);

    await page.goto(`/project/${encodeURIComponent(PROJECT)}`);
    await page.getByTestId("terminal-toggle").click();

    await expect(page.getByTestId("context-bar")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("context-bar-button-mission").click();
    await expect.poll(() => injected.length).toBe(1);
    expect(String(injected[0]?.text)).toContain(mission.mission.title);

    await page.getByTestId("context-bar-button-recap").click();
    await expect.poll(() => injected.length).toBe(2);
    expect(String(injected[1]?.text)).toContain("Recap");
  });
});
