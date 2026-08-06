/**
 * Card #169: a cold browser load reaches its first terminal paint exactly once.
 *
 * The marker exists in real tmux BEFORE navigation. Seeing it therefore proves
 * the initial attachment seeded the emulator; no post-connect keystroke or
 * refresh can make this test pass accidentally. The flight recorder turns any
 * failure into an issue → redeem → ready → seed → paint ledger.
 */
import { test, expect } from "./fixtures/live-app.ts";
import { FIRST_ATTACH_PHASES, FirstAttachProbe } from "./fixtures/first-attach.ts";
import { proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

const INITIAL_MARKER = "FIRST-ATTACH-SEED-9F31";

test("a cold load deterministically issues, redeems, seeds, and paints its first terminal", async ({
  page,
  liveApp,
}, testInfo) => {
  const sessionName = liveApp.fleet.sessionNames[0]!;
  liveApp.fleet.typeInPane(sessionName, `printf '${INITIAL_MARKER}\\n'`);
  await expect
    .poll(() => liveApp.fleet.capturePane(sessionName), {
      message: "the scratch pane did not contain the marker before browser navigation",
      timeout: 10_000,
    })
    .toContain(INITIAL_MARKER);

  const probe = new FirstAttachProbe(page);
  const context = {
    page,
    daemon: liveApp.daemon,
    fleet: liveApp.fleet,
    sessionName,
    testInfo,
  };

  try {
    await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator(".app"),
      "the cold load did not boot against the real daemon",
    ).toHaveAttribute("data-shell-source", "runtime", { timeout: 60_000 });

    for (const phase of FIRST_ATTACH_PHASES.slice(0, 6)) await probe.require(phase);

    const terminal = page.locator(".tiled-pane-area .terminal-surface").first();
    await expect(
      terminal,
      `first attachment stalled after "${probe.lastCompleted()}"; its surface never connected`,
    ).toHaveAttribute("data-phase", "connected", { timeout: 30_000 });
    probe.mark(
      "surface-connected",
      (await terminal.getAttribute("data-client-viewport")) ?? undefined,
    );

    await expect(
      terminal,
      `first attachment stalled after "${probe.lastCompleted()}"; initial output was not committed`,
    ).toHaveAttribute("data-preserves-frame", "true", { timeout: 30_000 });
    probe.mark("seed-committed", (await terminal.getAttribute("data-source-grid")) ?? undefined);

    await proveVisible(
      terminal.locator(".xterm-rows > div").filter({ hasText: INITIAL_MARKER }).first(),
      `the initially seeded terminal row showing "${INITIAL_MARKER}"`,
      { minWidth: 80, minHeight: 4, timeoutMs: 30_000 },
    );
    probe.mark("first-paint", "pre-navigation tmux marker is visible in xterm pixels");

    expect(
      probe.entries().map(({ phase }) => phase),
      "the first attachment crossed its boundaries out of order",
    ).toEqual(FIRST_ATTACH_PHASES);
    await page.screenshot({ path: testInfo.outputPath("first-attach-painted.png") });
    await probe.attachArtifact(context);
  } catch (error) {
    await probe.attachArtifact(context, error);
    throw new Error(
      `first attachment failed after "${probe.lastCompleted()}" — see first-attach-phases.json\n` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
});
