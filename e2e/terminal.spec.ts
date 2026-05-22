import { expect, test, type Page } from "@playwright/test";

async function openTerminal(page: Page) {
  await page.goto("/terminal/default");
  const frame = page.getByTestId("terminal-frame");
  await expect(frame).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  await expect(frame.locator(".xterm-screen")).toBeVisible();
  return frame;
}

async function typeCommand(page: Page, command: string) {
  await page.getByTestId("terminal-frame").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test.describe("browser terminal", () => {
  test("renders prompt", async ({ page }) => {
    const frame = await openTerminal(page);
    await expect(frame).toHaveAttribute("data-state", "connected");
  });

  test("echo round-trip", async ({ page }) => {
    await openTerminal(page);
    await typeCommand(page, "echo hello-world");

    await expect(page.getByTestId("terminal-transcript")).toContainText("hello-world");
  });

  test("high-volume output remains responsive", async ({ page }) => {
    await openTerminal(page);
    await typeCommand(page, "i=1; while [ $i -le 100 ]; do echo line-$i; i=$((i+1)); done");

    await expect(page.getByTestId("terminal-transcript")).toContainText("line-100");
    await expect(page.getByTestId("terminal-frame")).toHaveAttribute("data-state", "connected");
  });

  test("resize forwards", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    const frame = await openTerminal(page);
    const initialCols = await frame.getAttribute("data-cols");
    const initialRows = await frame.getAttribute("data-rows");

    await page.setViewportSize({ width: 1280, height: 820 });

    await expect
      .poll(async () => {
        const cols = await frame.getAttribute("data-cols");
        const rows = await frame.getAttribute("data-rows");
        return `${cols}x${rows}`;
      })
      .not.toBe(`${initialCols}x${initialRows}`);
  });

  test("exit closes", async ({ page }) => {
    await openTerminal(page);
    await typeCommand(page, "exit");

    await expect(page.getByTestId("terminal-frame")).toHaveAttribute("data-state", "disconnected", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("terminal-transcript")).toContainText("session ended");
  });
});
