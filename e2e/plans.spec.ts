import { expect, test, type Page } from "@playwright/test";

const PROJECT = "tmux-ide";

const PLAN = `---
title: Plans v2 Polish
status: in-progress
owner: Agent 1
effort: M
tags: [plans, ui]
related: task-001
---
# Overview

Read [task-001] before implementation.

## Code

\`\`\`ts
export const answer = 42;
\`\`\`

## Patch

\`\`\`diff
-old line
+new line
\`\`\`
`;

async function mockApi(page: Page) {
  let savedContent = "";
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
              stats: { totalTasks: 1, doneTasks: 0, agents: 0, activeAgents: 0 },
              goals: [],
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

    if (!sub) {
      await route.fulfill({
        json: {
          session: PROJECT,
          dir: `/tmp/${PROJECT}`,
          mission: null,
          goals: [],
          agents: [],
          tasks: [
            {
              id: "task-001",
              title: "Implement plan reader",
              description: "Render polished plans",
              status: "in-progress",
              priority: 1,
              goal: null,
            },
          ],
        },
      });
      return;
    }

    if (sub === "plans") {
      await route.fulfill({
        json: {
          plans: [
            {
              name: "001-plans-v2",
              path: "001-plans-v2.md",
              title: "Plans v2 Polish",
              status: "in-progress",
              effort: "M",
              owner: "Agent 1",
              updated: "2026-05-02T12:00:00Z",
              completed: null,
            },
          ],
        },
      });
      return;
    }

    if (sub === "plans/001-plans-v2.md/content" && route.request().method() === "POST") {
      savedContent = (route.request().postDataJSON() as { content?: string })?.content ?? "";
      await route.fulfill({ json: { ok: true, mtime: 2 } });
      return;
    }

    if (sub === "plans/001-plans-v2.md") {
      await route.fulfill({
        json: {
          name: "001-plans-v2",
          content: savedContent || PLAN,
          marks: null,
          stats: null,
          mtime: savedContent ? 2 : 1,
        },
      });
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

    await route.fulfill({ json: [] });
  });
}

test.describe("plans reader", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("renders frontmatter header, copyable code blocks, and toc", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}?tab=plans`);

    await expect(page.getByTestId("plans-view")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "Plans v2 Polish" })).toBeVisible();
    await expect(page.getByText("owner Agent 1")).toBeVisible();
    await expect(page.getByRole("button", { name: "in progress", exact: true })).toBeVisible();
    await expect(page.getByTestId("code-copy-button")).toBeVisible();
    await expect(page.getByTestId("plans-toc")).toContainText("Overview");
    await expect(page.getByText("task-001 · Implement plan reader")).toBeVisible();
    await expect(page.getByText("+1")).toBeVisible();
    await expect(page.getByText("-1")).toBeVisible();
  });

  test("toggles edit mode and saves plan content", async ({ page }) => {
    await page.goto(`/project/${encodeURIComponent(PROJECT)}?tab=plans`);

    await expect(page.getByTestId("plans-view")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("plan-edit-toggle").click();

    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible();
    await page.evaluate((content) => {
      document
        .querySelector('[data-testid="markdown-editor"]')
        ?.dispatchEvent(new CustomEvent("tmux-ide:set-markdown", { detail: content }));
    }, `${PLAN}\nSaved from e2e`);

    await expect(page.getByTestId("plan-save-state")).toHaveText("saved", { timeout: 5000 });
  });
});
