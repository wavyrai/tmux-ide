/**
 * Chain: the terminal fills the window, and tmux is the one that resized.
 *
 *   open a workspace → the terminal surface occupies the tile area rather than
 *   sitting letterboxed inside it → resize the browser window → tmux's OWN
 *   window cols/rows follow → the surface still fills the new area.
 *
 * This is m50.2 gap 1's exit criterion, and it is one chain because the two
 * halves are the same claim seen from two sides. A terminal that fills its box
 * proves nothing on its own — a CSS stretch would do that while tmux kept
 * wrapping output at some other width. tmux's window changing proves nothing on
 * its own either, since the app could resize the window and still render it
 * badly. Only together do they say what the feature says: the app measured
 * itself, told tmux, and rendered what came back.
 *
 * The pre-m50.2 picture this replaces: a size-passive attachment rendered the
 * origin window's own grid centred in the card, so a window sized for somebody
 * else's terminal sat in the middle of the app under a sea of empty space, and
 * no window resize ever reached tmux.
 */
import { test, expect } from "./fixtures/live-app.ts";
import { proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

/**
 * How much of the tile area the terminal must cover.
 *
 * Not 100%: the surface floors its box into whole CELLS, so up to one cell of
 * width and one of height are legitimately unreachable, and the viewport keeps a
 * few pixels of padding so glyphs do not touch the frame. 90% is far below that
 * remainder and far above the ~35% a letterboxed 80x24 window covered.
 */
const MIN_FILL = 0.9;

test("the terminal fills its area, and an app resize moves tmux's own window", async ({
  page,
  liveApp,
}, testInfo) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));

  const session = liveApp.fleet.sessionNames[0]!;
  await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });

  await expect(
    page.locator(".app"),
    "the app did not boot against the live daemon, so nothing below tests real tmux",
  ).toHaveAttribute("data-shell-source", "runtime", { timeout: 60_000 });
  await expect(
    page.locator("#primary-tab-terminals"),
    "opening a workspace no longer lands on the terminal canvas",
  ).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });

  const surface = page.locator(".terminal-surface");
  await expect(
    surface,
    "the terminal never connected, so there is no grid whose size could be measured",
  ).toHaveAttribute("data-phase", "connected", { timeout: 60_000 });

  /*
   * The attachment must SAY it owns geometry.
   *
   * Bug this catches: the surface fills its box by CSS while the attachment is
   * still passive, so tmux keeps the old window size and every line of output
   * wraps at a width the user cannot see. The attribute is the renderer's own
   * report of what it asked the daemon for.
   */
  await expect(
    surface,
    "the tiled view's attachment is not the geometry owner, so tmux is not being resized at all",
  ).toHaveAttribute("data-geometry-ownership", "owner");

  // --- The terminal fills the area it was given -----------------------------
  const area = page.locator(".tiled-pane-area");
  await proveVisible(area, "the tiled pane area", { minWidth: 200, minHeight: 200 });

  const fillRatio = async (): Promise<number> => {
    const areaBox = (await area.boundingBox())!;
    const viewportBox = (await page.locator(".terminal-surface__viewport").boundingBox())!;
    return (viewportBox.width * viewportBox.height) / (areaBox.width * areaBox.height);
  };

  await expect
    .poll(fillRatio, {
      message:
        "the terminal surface covers less than 90% of the tile area — the size-passive letterbox is back",
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(MIN_FILL);
  await page.screenshot({ path: testInfo.outputPath("1-terminal-fills-area.png") });

  // --- An app window resize reaches tmux ------------------------------------
  const before = liveApp.fleet.windowGrid(session);
  expect(
    before.cols,
    "tmux reports a zero-width window, so there is no baseline to compare against",
  ).toBeGreaterThan(0);

  /*
   * A real viewport change, not a CSS one.
   *
   * `setViewportSize` is the browser resizing, which is what a user dragging the
   * app window produces: a ResizeObserver callback, a re-fit, and a resize down
   * the attachment. Narrowing by a third is far more than the debounce or a
   * rounding could absorb.
   */
  await page.setViewportSize({ width: 940, height: 700 });

  /*
   * Bug this catches — the whole of gap 1: the app's card gets smaller and tmux
   * never hears about it. The window stays the size some other client set,
   * output keeps wrapping at that width, and the app quietly letterboxes the
   * difference. This assertion reads tmux directly, so no amount of renderer
   * bookkeeping can satisfy it.
   */
  await expect
    .poll(() => liveApp.fleet.windowGrid(session).cols, {
      message: "resizing the app window never changed tmux's own window width",
      timeout: 30_000,
    })
    .toBeLessThan(before.cols);

  // …and the terminal still fills the smaller area, rather than the grid
  // shrinking and leaving a margin where the old one was.
  await expect
    .poll(fillRatio, {
      message: "after the resize the terminal no longer fills its area",
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(MIN_FILL);
  await page.screenshot({ path: testInfo.outputPath("2-resized-and-refilled.png") });

  expect(crashes, `the page threw uncaught errors while resizing: ${crashes.join(" | ")}`).toEqual(
    [],
  );
});
