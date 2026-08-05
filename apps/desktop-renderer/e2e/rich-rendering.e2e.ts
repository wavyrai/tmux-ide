/**
 * Chain: a pane renders a document, and comes back (m49.7).
 *
 *   a live terminal → the user runs `tmux-ide widget markdown` in it → the pane
 *   is a rendered document with real headings, a real list and real code → the
 *   user presses Ctrl-C → the pane is a shell again, at a prompt.
 *
 * It is ONE test on purpose. "The widget appears" and "Ctrl-C restores it" each
 * passing alone is exactly the shape of a feature that traps the user inside a
 * surface they cannot leave, so the escape hatch is asserted in the same chain
 * that opened it.
 *
 * The only thing done outside the UI is writing the markdown file the user then
 * names — the trigger, not the assertion.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { test, expect } from "./fixtures/live-app.ts";
import {
  paintFingerprint,
  proveGone,
  proveVisible,
  provePaintChanged,
} from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

/** The published bin, built from this checkout — the path a user's PATH resolves. */
const CLI = fileURLToPath(new URL("../../../bin/cli.js", import.meta.url));

const DOCUMENT = [
  "# Deployment plan",
  "",
  "Two steps, then a check.",
  "",
  "- Build the bundle",
  "- Ship it",
  "",
  "Run `pnpm release` when both are green.",
  "",
].join("\n");

test("a pane renders markdown from one printed line, and Ctrl-C gives the shell back", async ({
  page,
  liveApp,
}, testInfo) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));

  /*
   * CSP is a claim this feature has to keep, not merely one it inherits.
   * A markdown renderer is the classic place a strict policy breaks — an
   * `innerHTML` path, an injected style element, a fetched font. Collecting
   * violations for the whole chain is what turns "we think it's fine" into
   * evidence taken while the document was actually on screen.
   */
  await page.addInitScript(() => {
    (globalThis as unknown as { __widgetCsp: string[] }).__widgetCsp = [];
    globalThis.document.addEventListener("securitypolicyviolation", (event) => {
      (globalThis as unknown as { __widgetCsp: string[] }).__widgetCsp.push(
        `${event.effectiveDirective} blocked ${event.blockedURI}`,
      );
    });
  });

  const documentPath = `${liveApp.fleet.root}/plan.md`;
  await writeFile(documentPath, DOCUMENT, "utf8");

  await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });
  await expect(
    page.locator(".app"),
    "the app did not boot against the live daemon, so nothing below tests real tmux",
  ).toHaveAttribute("data-shell-source", "runtime", { timeout: 60_000 });

  const terminal = page
    .locator(
      "article.app-window-card[data-active='true'] .terminal-surface[data-phase='connected']",
    )
    .first();
  await proveVisible(terminal, "the connected terminal tile", { minWidth: 200, minHeight: 120 });
  const beforeWidget = await paintFingerprint(terminal);

  // The user path: click the terminal, then type. No transport calls by hand.
  await terminal.locator(".xterm-screen").click();
  await expect(
    terminal,
    "clicking the terminal did not focus it, so the command below would go nowhere",
  ).toHaveAttribute("data-focused", "true");
  await page.keyboard.type(`${process.execPath} ${CLI} widget markdown ${documentPath}`);
  await page.keyboard.press("Enter");

  /*
   * Bug this catches: the marker reaches the pane and the grid holds it, but
   * detection never runs (or runs against a string instead of cells, and misses
   * the line the grid wrapped) — the user sees a line of base64 where their
   * document should be.
   */
  const widget = terminal.locator(".widget-surface");
  await proveVisible(widget, "the rendered markdown surface", {
    minWidth: 200,
    minHeight: 120,
    timeoutMs: 45_000,
  });
  await expect(
    terminal,
    "the pane rendered a widget surface without reporting which widget it is",
  ).toHaveAttribute("data-widget", "markdown");

  // Bug this catches: the document renders as escaped source, or as one
  // undifferentiated blob — the markdown was carried but never parsed.
  await proveVisible(
    widget.locator("h1", { hasText: "Deployment plan" }),
    "the document's heading",
    { minHeight: 12 },
  );
  await proveVisible(widget.locator("li", { hasText: "Ship it" }), "a list item in the document", {
    minHeight: 8,
  });
  await proveVisible(widget.locator("code", { hasText: "pnpm release" }), "an inline code span", {
    minWidth: 20,
    minHeight: 8,
  });

  // Bug this catches: the heading is a heading in the DOM and looks exactly
  // like body text, so the "first-class surface" claim is untrue in pixels.
  const [headingSize, bodySize] = await Promise.all([
    widget
      .locator("h1")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    widget
      .locator("p")
      .first()
      .evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
  ]);
  expect(
    headingSize,
    `the document's h1 renders at ${headingSize}px and its body at ${bodySize}px — the type ramp ` +
      "is not reaching the widget, so a rendered plan has no visible structure",
  ).toBeGreaterThan(bodySize);

  provePaintChanged(beforeWidget, await paintFingerprint(terminal), "the pane");
  await page.screenshot({ path: testInfo.outputPath("1-markdown-widget.png") });

  /*
   * Bug this catches: the swap REPLACED the grid. The emulator is gone, so the
   * keystroke below reaches nothing and the user is stuck inside the document
   * with no way to signal the process behind it.
   */
  await expect(
    terminal.locator(".terminal-surface__viewport"),
    "the emulator was unmounted by the widget swap, so the pane can no longer be signalled",
  ).toBeAttached();

  // The escape hatch, driven the way a user drives it.
  await terminal.locator(".widget-surface").click();
  await page.keyboard.press("Control+c");

  await proveGone(widget, "the widget surface after Ctrl-C", 45_000);
  await expect(
    terminal,
    "the pane still reports itself as a widget after the process was interrupted",
  ).not.toHaveAttribute("data-widget", "markdown");

  // And the pane behind it is a shell that answers, not a corpse that stopped
  // painting. Bug this catches: Ctrl-C killed the pane rather than the helper.
  await page.keyboard.type("echo WIDGET-RESTORED");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => liveApp.fleet.capturePane(liveApp.fleet.sessionNames[0]!), {
      message:
        "the pane never echoed after Ctrl-C — the widget went away but the shell behind it did not " +
        "come back",
      timeout: 30_000,
    })
    .toContain("WIDGET-RESTORED");
  await proveVisible(
    terminal.locator(".xterm-rows > div").filter({ hasText: "WIDGET-RESTORED" }).first(),
    "the restored shell's own output",
    { minWidth: 40, minHeight: 4 },
  );
  await page.screenshot({ path: testInfo.outputPath("2-restored-shell.png") });

  const violations = await page.evaluate(
    () => (globalThis as unknown as { __widgetCsp: string[] }).__widgetCsp,
  );
  expect(
    violations,
    "rendering a document in a pane violated the renderer's Content-Security-Policy",
  ).toEqual([]);
  expect(crashes, "the page threw while rendering or dismissing the widget").toEqual([]);
});
