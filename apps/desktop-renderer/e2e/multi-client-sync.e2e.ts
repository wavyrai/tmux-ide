import { expect, test } from "./fixtures/live-app.ts";
import { proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

test("two browsers keep local navigation independent and share canonical mutations", async ({
  page: first,
  browser,
  liveApp,
}) => {
  const session = liveApp.fleet.sessionNames[0]!;
  const secondContext = await browser.newContext({ viewport: { width: 1_400, height: 900 } });
  const second = await secondContext.newPage();
  const ready = async (page: typeof first): Promise<void> => {
    await expect(page.locator(".app")).toHaveAttribute("data-shell-source", "runtime", {
      timeout: 60_000,
    });
    await expect(page.locator('.terminal-surface[data-phase="connected"]')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(page.locator(".pane-tile")).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(async () => {
        const box = await page.locator(".pane-tile").boundingBox();
        return box && box.width >= 100 && box.height >= 100 ? "ready" : "not-ready";
      })
      .toBe("ready");
  };

  // Sequential readiness makes the authority claim deterministic: the first
  // independent client owns control; the second joins as a passive viewer.
  await first.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });
  await ready(first);
  await expect(first.locator('.terminal-surface[data-phase="connected"]')).toHaveAttribute(
    "data-viewer-mode",
    "interactive",
  );
  await second.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });
  await ready(second);
  await expect(first.locator('.terminal-surface[data-phase="connected"]')).toHaveAttribute(
    "data-viewer-mode",
    "interactive",
  );
  await expect(second.locator('.terminal-surface[data-phase="connected"]')).toHaveAttribute(
    "data-viewer-mode",
    "read-only",
  );

  const sharedCurrent = liveApp.fleet.currentWindow(session);
  const inactive = first.locator('.window-tabs__tab[data-active="false"]').first();
  const locallySelected = (await inactive.innerText()).trim();
  await inactive.click();
  await expect(first.locator('.window-tabs__tab[data-active="true"]')).toHaveText(locallySelected);
  await expect(first.locator('.terminal-surface[data-phase="connected"]')).toHaveCount(1, {
    timeout: 60_000,
  });
  await expect
    .poll(async () => {
      const box = await first.locator(".pane-tile").boundingBox();
      return box && box.width >= 100 && box.height >= 100 ? "ready" : "not-ready";
    })
    .toBe("ready");
  await expect(second.locator('.window-tabs__tab[data-active="true"]')).toHaveText(sharedCurrent);

  const tile = (await first.locator(".pane-tile").first().boundingBox())!;
  await first.mouse.click(tile.x + 20, tile.y + tile.height / 2, { button: "right" });
  const menu = first.locator('[role="menu"][data-context-menu="true"]');
  await proveVisible(menu, "the first browser's pane menu", { minWidth: 180, minHeight: 100 });
  await menu.locator('[data-context-menu-item="window.rename"]').click();
  const field = first.locator(".window-tabs__rename-field");
  await field.fill("shared-rename");
  await field.press("Enter");
  await expect(field).toHaveCount(0);

  await expect
    .poll(() => liveApp.fleet.listWindows(session), { timeout: 30_000 })
    .toContain("shared-rename");
  await expect(first.locator(".window-tabs__tab", { hasText: "shared-rename" })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(second.locator(".window-tabs__tab", { hasText: "shared-rename" })).toHaveCount(1, {
    timeout: 30_000,
  });
  await expect(second.locator('.window-tabs__tab[data-active="true"]')).toHaveText(sharedCurrent);
  await secondContext.close();
});
