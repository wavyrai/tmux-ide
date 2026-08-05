/**
 * Chain: the engine stops under a live app.
 *
 *   a live workspace → the engine process dies → the app says WHICH startup
 *   step is stalled, in words, on screen.
 *
 * The daemon computes a five-rung readiness ladder; until m45 nothing fetched
 * it and the renderer re-derived a ladder from the host state alone, so a
 * blocked startup reached the user as generic connection copy. This chain holds
 * the wiring to its promise at the pixels: the degraded surface must NAME the
 * stalled rung, not merely report that something is wrong.
 */
import { test, expect } from "./fixtures/live-app.ts";
import { proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

test("a stopped engine is reported as a named startup step, not generic failure", async ({
  page,
  liveApp,
}, testInfo) => {
  await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });

  // Bug this catches: the app never reached the live daemon at all, which would
  // make every assertion below pass against the preview shell.
  await expect(
    page.locator(".app"),
    "the app did not boot against the live daemon — it fell back to the preview shell",
  ).toHaveAttribute("data-shell-source", "runtime", { timeout: 60_000 });

  // Setup-level, and the trigger of the whole chain: no in-app affordance can
  // make the engine process vanish, and the app's reaction is the assertion.
  await liveApp.daemon.stop();
  await page.reload({ waitUntil: "domcontentloaded" });

  const surface = page.locator("main.runtime-state-surface");
  await expect(
    surface,
    "the app did not report a degraded state after its engine stopped — it is either still " +
      "claiming a live workspace or it blanked",
  ).toHaveAttribute("data-state", "degraded", { timeout: 60_000 });
  await proveVisible(surface, "the degraded surface after the engine stopped", {
    minWidth: 400,
    minHeight: 300,
  });

  // Bug this catches: the diagnostics are composed but never rendered, or the
  // details block collapses to nothing — the user is told "connection failed"
  // and given no way to see which step stalled.
  const details = page.locator(".runtime-diagnostics");
  await details.locator("summary").click();
  await proveVisible(details, "the expanded connection details", { minHeight: 20 });
  await expect(
    details,
    "the degraded surface does not name which startup step is stalled, so the user is left with " +
      "generic connection copy",
  ).toContainText(/Startup stalled at: .+ — .+\./u);
  // The engine is genuinely gone here, so the rung the user is shown is the
  // first one: nothing above `daemon-spawned` can be known.
  await expect(
    details,
    "the stalled step is not the engine itself, even though the engine process was stopped",
  ).toContainText("starting the engine");

  await page.screenshot({ path: testInfo.outputPath("engine-stopped-diagnostics.png") });
});
