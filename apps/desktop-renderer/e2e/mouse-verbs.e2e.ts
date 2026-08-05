/**
 * Chain: the mouse reaches tmux, through the layout-faithful view.
 *
 *   the window tabs show the session's real windows → clicking an inactive tab
 *   moves tmux's OWN current window → right-click a pane tile for the verb menu,
 *   in sections → rename the window and see both the tab and `tmux list-windows`
 *   change → split from the menu and watch the view re-tile to match the layout
 *   frame → drag the new border and watch the tmux pane actually resize → close
 *   the pane with the destructive confirm.
 *
 * One chain, because these are not independent claims. A tab that renders and a
 * rename that reaches tmux can each pass while the path between them is broken.
 *
 * The point of every step is the same one m48 found missing and m50 rebuilt
 * around: the app's controls must move TMUX, not a second layout beside it. So
 * tmux is read directly only to check the world afterwards, and the geometry
 * assertions compare the view's own rectangles against the proportions tmux
 * reports — which is the claim "layout-faithful" actually makes.
 */
import { test, expect } from "./fixtures/live-app.ts";
import { proveGone, proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

const RENAMED = "e2e-renamed";

test("the mouse reaches the multiplexer: switch windows, rename, split, resize, close", async ({
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

  // --- The window tabs are the session's real windows ----------------------
  const tabs = page.locator(".window-tabs__tab");
  await expect(
    tabs,
    "the tab strip did not render a tab per tmux window of the promoted session",
  ).toHaveCount(2, { timeout: 60_000 });
  await proveVisible(tabs.first(), "the first window tab", { minWidth: 30, minHeight: 16 });

  /*
   * Bug this catches — the m48 finding this whole view exists to remove: six
   * indistinguishable "Terminal" tabs, because the labels came from the app's
   * own document instead of from the live window names.
   */
  const startingWindows = liveApp.fleet.listWindows(session);
  expect(startingWindows.length, "the scratch session did not start with two windows").toBe(2);
  await expect
    .poll(async () => (await tabs.allInnerTexts()).map((text) => text.trim()).sort(), {
      message: "the window tabs do not carry the live tmux window names",
      timeout: 30_000,
    })
    .toEqual([...startingWindows].sort());

  // --- Clicking an inactive tab moves tmux's current window ----------------
  const inactiveTab = page.locator('.window-tabs__tab[data-active="false"]').first();
  await proveVisible(inactiveTab, "the inactive window tab", { minWidth: 30, minHeight: 16 });
  const targetWindow = (await inactiveTab.innerText()).trim();
  const startingCurrent = liveApp.fleet.currentWindow(session);
  expect(targetWindow, "the inactive tab names the window that is already current").not.toBe(
    startingCurrent,
  );
  await inactiveTab.click();

  /*
   * Bug this catches: the tab switches which window the APP shows and never
   * tells tmux, so a client attached over ssh stays on the old window and the
   * two views of one session disagree about where the user is.
   */
  await expect
    .poll(() => liveApp.fleet.currentWindow(session), {
      message: "clicking the window tab did not change tmux's own current window",
      timeout: 30_000,
    })
    .toBe(targetWindow);
  await expect(
    page.locator('.window-tabs__tab[data-active="true"]'),
    "tmux switched windows but the tab strip still marks the old one",
  ).toHaveText(targetWindow, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("1-window-tabs.png") });

  // --- The verb menu, on a pane tile ---------------------------------------
  const menu = page.locator('[role="menu"][data-context-menu="true"]');
  const item = (id: string) => menu.locator(`[data-context-menu-item="${id}"]`);
  /*
   * Right-click INSIDE a tile, but aimed at the pane area.
   *
   * The tiles take no pointer events — a left click has to reach the terminal
   * underneath, which is a real tmux client — so the menu is opened by pointing
   * at the pixels a tile covers rather than at the tile element.
   */
  const openTileMenu = async (): Promise<void> => {
    const box = (await page.locator(".pane-tile").first().boundingBox())!;
    await page.mouse.click(box.x + Math.min(24, box.width / 3), box.y + box.height / 2, {
      button: "right",
    });
    await proveVisible(menu, "the verb context menu", { minWidth: 180, minHeight: 100 });
  };
  await openTileMenu();

  // Bug this catches: the menu renders as one undifferentiated list, so verbs
  // that change tmux sit beside ones that do not and a user cannot tell which.
  await expect(
    menu.locator("[data-section-id]"),
    "the verb menu no longer separates pane, window, session and app-layout verbs",
  ).toHaveCount(4);
  await proveVisible(item("pane.split.right"), "the split-right item", { minHeight: 16 });

  // --- Rename, and prove it reached tmux -----------------------------------
  await item("window.rename").click();
  await proveGone(menu, "the verb menu after choosing rename");
  const field = page.locator(".window-tabs__rename-field");
  await proveVisible(field, "the inline rename field on the window tab", { minHeight: 16 });
  // Typed, not filled: real key events are what a user produces, and they are
  // the only way to prove the editor's own input handling works.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.type(RENAMED);
  // Bug this catches: the tab is rebuilt under the editor by an incoming layout
  // frame, so what the user typed is gone before they press Enter.
  expect(
    await field.inputValue(),
    "the rename field lost what was typed into it before it could be committed",
  ).toBe(RENAMED);
  await page.keyboard.press("Enter");
  await proveGone(field, "the rename editor after Enter");

  /*
   * Bug this catches: the rename edits the app's own label and never reaches
   * tmux, so the name is invisible to `tmux ls` and to any attached client.
   */
  await expect
    .poll(() => liveApp.fleet.listWindows(session).join(","), {
      message: "the inline rename did not reach tmux",
      timeout: 20_000,
    })
    .toContain(RENAMED);
  // …and the tab says the same thing the server does.
  await expect(
    page.locator(".window-tabs__tab", { hasText: RENAMED }),
    "tmux renamed the window but the tab kept the old label",
  ).toHaveCount(1, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("2-menu-and-rename.png") });

  // --- Split, and prove the view re-tiles to tmux's own layout -------------
  const panesBeforeSplit = liveApp.fleet.countPanes(session);
  await openTileMenu();
  await item("pane.split.right").click();
  await proveGone(menu, "the verb menu after choosing split");

  await expect
    .poll(() => liveApp.fleet.countPanes(session), {
      message: "the split never reached tmux — the session has the same pane count",
      timeout: 30_000,
    })
    .toBe(panesBeforeSplit + 1);
  /*
   * Bug this catches: the split reaches tmux and the view does not follow, so
   * the app shows one pane where the server has two. In the parked canvas that
   * was a whole class of defect; here the view is a pure function of the layout
   * frame, and this is the assertion that says so.
   */
  const tiles = page.locator(".pane-tile");
  await expect(tiles, "the view did not re-tile after the split").toHaveCount(2, {
    timeout: 30_000,
  });

  /*
   * The proportions, compared against tmux's own.
   *
   * The tiles are rendered from the layout frame's cell rectangles, so the ratio
   * of the two tiles' widths must match the ratio of the two tmux panes' widths.
   * Bug this catches: the view renders two panes at a convenient 50/50 while
   * tmux's layout is something else entirely — visually plausible, and wrong.
   */
  await expect
    .poll(
      async () => {
        const widths = await tiles.evaluateAll((nodes) =>
          nodes
            .map((node) => node.getBoundingClientRect().width)
            .sort((left, right) => left - right),
        );
        const cells = liveApp.fleet
          .paneSizes(session)
          .map((size) => Number(size.split("x")[0]))
          .sort((left, right) => left - right);
        if (widths.length !== 2 || cells.length !== 2 || widths[0]! === 0) return "not measurable";
        const rendered = widths[0]! / widths[1]!;
        const actual = cells[0]! / cells[1]!;
        return Math.abs(rendered - actual) < 0.06
          ? "matches"
          : `rendered ${rendered.toFixed(3)} vs tmux ${actual.toFixed(3)}`;
      },
      {
        message: "the tiles' proportions do not match the proportions tmux reports",
        timeout: 30_000,
      },
    )
    .toBe("matches");
  await page.screenshot({ path: testInfo.outputPath("3-split-retiled.png") });

  // --- Drag the border, and prove tmux resized ----------------------------
  const border = page.locator(".pane-border").first();
  await proveVisible(border, "the draggable pane border", { minWidth: 1, minHeight: 20 });
  const borderBox = (await border.boundingBox())!;
  const sizesBefore = liveApp.fleet.paneSizes(session).join(",");

  await page.mouse.move(borderBox.x + borderBox.width / 2, borderBox.y + borderBox.height / 2);
  await page.mouse.down();
  // Two moves, then a release. The verb is dispatched on RELEASE only — a
  // resize per pointermove would spend a serialized daemon round trip per frame
  // of mouse movement, every one of them superseded before it landed.
  await page.mouse.move(borderBox.x - 60, borderBox.y + borderBox.height / 2, { steps: 8 });
  await page.mouse.move(borderBox.x - 120, borderBox.y + borderBox.height / 2, { steps: 8 });
  await page.mouse.up();

  /*
   * Bug this catches: the border drags visibly and changes only the app's own
   * rectangle, so the pane an ssh client sees is untouched — the m48 divergence
   * in its purest form, since a resize has no other observable effect.
   */
  await expect
    .poll(() => liveApp.fleet.paneSizes(session).join(","), {
      message: "the border drag never reached tmux — the panes are the same size",
      timeout: 30_000,
    })
    .not.toBe(sizesBefore);
  await page.screenshot({ path: testInfo.outputPath("4-border-dragged.png") });

  // --- Close a pane, with the destructive confirm --------------------------
  const panesBefore = liveApp.fleet.countPanes(session);
  await openTileMenu();
  const kill = item("pane.kill");
  await proveVisible(kill, "the close-pane item", { minHeight: 16 });
  await expect(
    kill,
    "the destructive item is not marked destructive, so it is styled like every other row",
  ).toHaveAttribute("data-destructive", "true");

  // The first click ARMS. Bug this catches: a destructive verb fires on the
  // first click, one row below a harmless one, with no way back.
  await kill.click();
  await expect(
    kill,
    "the first click on a destructive item did not arm a confirm — it either fired or did nothing",
  ).toHaveAttribute("data-confirm-pending", "true");
  await expect(
    kill,
    "the armed destructive item does not say that the next click cannot be undone",
  ).toContainText("cannot be undone");
  await kill.click();
  await proveGone(menu, "the verb menu after confirming the kill");

  await expect
    .poll(() => liveApp.fleet.countPanes(session), {
      message: "the confirmed close never reached tmux — the pane is still in the server",
      timeout: 30_000,
    })
    .toBe(panesBefore - 1);
  // …and the view follows it back down, from the next layout frame.
  await expect(
    page.locator(".pane-tile"),
    "the killed pane still has a tile — the view is no longer following the layout frame",
  ).toHaveCount(1, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("5-pane-closed.png") });

  expect(
    crashes,
    `the page threw uncaught errors while driving the verb menus: ${crashes.join(" | ")}`,
  ).toEqual([]);
});
