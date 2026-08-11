import { expect, test } from "./fixtures/live-app.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

test("xterm pointer selection copies text without mutating tmux", async ({ page, liveApp }) => {
  const session = liveApp.fleet.sessionNames[0]!;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(liveApp.pageUrl).origin,
  });
  await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app")).toHaveAttribute("data-shell-source", "runtime", {
    timeout: 60_000,
  });

  const input = page.locator(".terminal-surface__viewport .xterm-helper-textarea").first();
  await expect(input).toBeAttached({ timeout: 60_000 });
  await expect(page.locator('.terminal-surface[data-phase="connected"]')).toHaveCount(1, {
    timeout: 60_000,
  });
  // Do not key readiness to the host shell's prompt: macOS' /bin/sh renders
  // `sh-3.2$`, while the Linux CI image renders `$`. A redeemed interactive
  // attachment and its mounted helper textarea are the portable input-ready
  // contract; the unique marker below proves the real shell consumed it.
  await page.locator(".terminal-surface__viewport").click({ position: { x: 24, y: 48 } });
  await input.focus();
  const marker = `TMUX_IDE_COPY_${Date.now()}`;
  await page.keyboard.type(`printf '${marker}\\n'`);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => liveApp.fleet.capturePane(session), {
      message: "the marker did not reach the live tmux pane",
      timeout: 30_000,
    })
    .toContain(marker);

  const before = {
    panes: liveApp.fleet.countPanes(session),
    sizes: liveApp.fleet.paneSizes(session).join(","),
    window: liveApp.fleet.currentWindow(session),
  };
  const row = page
    .locator(".terminal-surface__viewport .xterm-rows > div", { hasText: marker })
    .last();
  await expect(row).toBeVisible({ timeout: 30_000 });
  const box = (await row.boundingBox())!;
  // Triple-click is xterm's line-selection pointer gesture. It avoids making
  // this proof depend on a particular font's cell width while still exercising
  // the real selection/copy path through the live terminal surface.
  await page.mouse.click(box.x + 12, box.y + box.height / 2, { clickCount: 3 });
  await expect(
    page.locator(".terminal-surface__viewport .xterm-selection div").first(),
  ).toBeVisible();
  await page.evaluate(() => {
    const observed = window as Window & { __tmuxIdeCopiedText?: string };
    observed.__tmuxIdeCopiedText = "";
    window.addEventListener(
      "copy",
      (event) => {
        // This window-level bubble listener runs after the tiled surface's
        // copy authority has populated the browser ClipboardEvent. Reading
        // that payload is deterministic in headless Linux; the OS clipboard
        // backing navigator.clipboard is not.
        observed.__tmuxIdeCopiedText = event.clipboardData?.getData("text/plain") ?? "";
      },
      { once: true },
    );
  });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as Window & { __tmuxIdeCopiedText?: string }).__tmuxIdeCopiedText ?? "",
        ),
      {
        message: "the live xterm selection did not populate the browser copy event",
        timeout: 10_000,
      },
    )
    .toContain(marker);

  expect(liveApp.fleet.countPanes(session)).toBe(before.panes);
  expect(liveApp.fleet.paneSizes(session).join(",")).toBe(before.sizes);
  expect(liveApp.fleet.currentWindow(session)).toBe(before.window);
});
