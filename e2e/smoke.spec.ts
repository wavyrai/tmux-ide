/**
 * T3 — dev-server smoke test.
 *
 * Catches SSR / hydration / build-cache regressions before they ship.
 * The suite walks every `/v2/*` route the app exposes, asserts the
 * page reached `data-testid` anchor visible (proves React mounted),
 * and accumulates console errors across the run. A single console.error
 * is treated as a smoke failure — broken bundles, hydration mismatches,
 * and missing client-only guards all surface as console.error on first
 * paint.
 *
 * API is stubbed so the smoke isolates frontend regressions from
 * daemon flake. The daemon still boots (the workflow needs it for
 * resolveApiBase to succeed during SSR) but the network is short-
 * circuited at the browser layer.
 */

import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { fulfillSnapshotStream } from "./sse";

const PROJECT = "smoke-project";

const stubProject = {
  session: PROJECT,
  dir: "/tmp/smoke-project",
  mission: null,
  goals: [],
  tasks: [] as unknown[],
  agents: [] as unknown[],
};

const stubThreads = [
  {
    id: "thr_smoke_1",
    title: "Smoke thread",
    createdAt: "2026-05-13T10:00:00Z",
    updatedAt: "2026-05-13T10:00:00Z",
    providerKind: "claude-code",
    messageCount: 0,
  },
];

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
              dir: "/tmp/smoke-project",
              mission: null,
              stats: { totalTasks: 0, doneTasks: 0, agents: 0, activeAgents: 0 },
            },
          ],
        },
      });
      return;
    }

    if (path === "/api/projects") {
      await route.fulfill({ json: { projects: [] } });
      return;
    }

    if (path === "/api/threads") {
      await route.fulfill({ json: { threads: stubThreads } });
      return;
    }

    if (path.startsWith("/api/threads/")) {
      await route.fulfill({
        json: {
          id: "thr_smoke_1",
          providerKind: "claude-code",
          messages: [],
          plans: [],
          checkpoints: [],
        },
      });
      return;
    }

    if (path === "/api/chat/providers") {
      await route.fulfill({ json: { providers: [] } });
      return;
    }

    if (path === "/api/widgets") {
      await route.fulfill({ json: { widgets: [] } });
      return;
    }

    const projectMatch = path.match(/^\/api\/project\/([^/]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const [, encodedName, sub] = projectMatch;
      if (decodeURIComponent(encodedName) !== PROJECT) {
        await route.fulfill({ status: 404, json: null });
        return;
      }

      if (!sub) {
        await route.fulfill({ json: stubProject });
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

      if (sub === "metrics") {
        await route.fulfill({
          json: {
            session: {
              startedAt: null,
              durationMs: 0,
              status: "idle",
              agentCount: 0,
            },
            tasks: {
              total: 0,
              completed: 0,
              failed: 0,
              retried: 0,
              completionRate: 0,
              retryRate: 0,
              avgDurationMs: 0,
              medianDurationMs: 0,
              p90DurationMs: 0,
              byMilestone: [],
            },
            agents: [],
            mission: {
              title: null,
              status: null,
              milestonesCompleted: 0,
              validationPassRate: 0,
              wallClockMs: 0,
            },
            timeline: [],
          },
        });
        return;
      }

      await route.fulfill({ json: [] });
      return;
    }

    await route.continue();
  });

  // The dashboard opens a single shared WebSocket to /ws. Stub it so the
  // smoke doesn't hang waiting for the daemon push channel.
  await page.route("**/ws", async (route) => {
    await route.abort();
  });
}

interface CapturedConsole {
  errors: string[];
  warnings: string[];
}

function attachConsoleCapture(page: Page): CapturedConsole {
  const captured: CapturedConsole = { errors: [], warnings: [] };
  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() === "error") captured.errors.push(msg.text());
    else if (msg.type() === "warning") captured.warnings.push(msg.text());
  });
  page.on("pageerror", (err) => {
    captured.errors.push(`pageerror: ${err.message}`);
  });
  return captured;
}

/** Strings allowed to appear in console.error without failing the smoke.
 * Each entry is a substring match against the message body. Keep this
 * list short and load-bearing — every entry is a regression magnet. */
const CONSOLE_ERROR_ALLOWLIST: string[] = [
  // Stubbed `/ws` aborts produce a network-error log line — expected.
  "WebSocket",
  "failed to fetch",
  "Failed to fetch",
  "NetworkError",
  // Stubbed REST endpoints we don't bother mocking individually surface as
  // 404/empty-body parse errors; they're noise, not regressions.
  "404",
];

function filterErrors(errors: string[]): string[] {
  return errors.filter((msg) => !CONSOLE_ERROR_ALLOWLIST.some((allowed) => msg.includes(allowed)));
}

interface SmokeRoute {
  label: string;
  path: string;
  anchor: string;
}

const ROUTES: SmokeRoute[] = [
  { label: "overview", path: "/v2", anchor: '[data-testid="v2-topbar-palette"]' },
  { label: "widgets", path: "/v2/widgets", anchor: '[data-testid="widgets-gallery-page"]' },
  { label: "setup", path: "/v2/setup", anchor: '[data-testid="setup-step-tabs"]' },
  { label: "settings", path: "/v2/settings", anchor: '[data-testid="settings-page"]' },
  {
    label: "project default",
    path: `/v2/project/${encodeURIComponent(PROJECT)}`,
    anchor: '[data-testid="project-sidebar-files-link"]',
  },
  {
    label: "project chat",
    path: `/v2/project/${encodeURIComponent(PROJECT)}?view=chat`,
    anchor: '[data-testid="chat-v2-root"]',
  },
  {
    label: "project files",
    path: `/v2/project/${encodeURIComponent(PROJECT)}?view=files`,
    anchor: '[data-testid="project-sidebar-files-link"]',
  },
];

test.describe("/v2 smoke", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  for (const route of ROUTES) {
    test(`renders ${route.label} without console errors`, async ({ page }, testInfo) => {
      const captured = attachConsoleCapture(page);

      const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
      expect(response, `goto ${route.path}`).not.toBeNull();
      expect(response!.status(), `status for ${route.path}`).toBeLessThan(400);

      await expect(page.locator(route.anchor).first()).toBeVisible({ timeout: 15_000 });

      await testInfo.attach(`screenshot-${route.label.replace(/\s+/g, "-")}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });

      const realErrors = filterErrors(captured.errors);
      expect(realErrors, `console errors on ${route.path}:\n${realErrors.join("\n---\n")}`).toEqual(
        [],
      );
    });
  }

  test("chat thread click mounts chat-solid-bridge", async ({ page }) => {
    const captured = attachConsoleCapture(page);

    await page.goto(`/v2/project/${encodeURIComponent(PROJECT)}?view=chat`, {
      waitUntil: "domcontentloaded",
    });

    const rail = page.getByTestId("thread-list-rail");
    await expect(rail).toBeVisible({ timeout: 15_000 });

    const firstThread = page.getByTestId("thread-list-item").first();
    await expect(firstThread).toBeVisible({ timeout: 15_000 });
    await firstThread.click();

    // After picking a thread the bridge mounts (or shows its empty
    // state if chat-solid hasn't initialized providers yet). Either
    // testid proves the bridge container survived the click without
    // throwing.
    const bridge = page.locator(
      '[data-testid="chat-solid-bridge"], [data-testid="chat-solid-empty"]',
    );
    await expect(bridge.first()).toBeVisible({ timeout: 15_000 });

    const realErrors = filterErrors(captured.errors);
    expect(realErrors, `chat-click console errors:\n${realErrors.join("\n---\n")}`).toEqual([]);
  });
});
