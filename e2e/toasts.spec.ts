import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __pushTestToast?: (toast: {
      kind: "info" | "success" | "error" | "warning";
      title: string;
      body?: string;
      durationMs?: number;
    }) => string;
  }
}

async function mockApi(page: Page) {
  await page.addInitScript(() => window.localStorage.clear());
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/sessions") {
      await route.fulfill({ json: { sessions: [] } });
      return;
    }
    await route.fulfill({ json: [] });
  });
}

test.describe("toast stack", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("info auto-dismisses and error stays sticky", async ({ page }) => {
    await page.goto("/");

    await page.waitForFunction(() => typeof window.__pushTestToast === "function");
    await page.evaluate(() => {
      window.__pushTestToast?.({
        kind: "info",
        title: "Saved",
        body: "This will dismiss",
        durationMs: 200,
      });
      window.__pushTestToast?.({
        kind: "error",
        title: "Failed",
        body: "This stays visible",
      });
    });

    await expect(page.getByTestId("toast")).toHaveCount(2);
    await expect(page.getByText("Saved")).toBeVisible();
    await expect(page.getByText("Failed")).toBeVisible();

    await expect(page.getByText("Saved")).toHaveCount(0, { timeout: 2000 });
    await expect(page.getByText("Failed")).toBeVisible();
  });
});
