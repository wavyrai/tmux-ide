/**
 * Chain: the mouse reaches tmux.
 *
 *   right-click a window card → the verb menu, in sections → rename it and see
 *   BOTH the card title and the tmux window name change → dock it into another
 *   window's stack → the tab strip appears and its inactive tab activates →
 *   close the window with the destructive confirm → tmux has one window fewer.
 *
 * One chain, because these are not independent claims. A menu that renders and
 * a rename that reaches tmux can each pass while the path between them — click
 * the item, get a field, commit it — is broken.
 *
 * Every mutation here is performed the way a person performs it. tmux is read
 * directly ONLY to check the world afterwards, which is the whole point: the
 * m48 audit's finding was that the app's controls moved the app's own document
 * and said nothing about not moving tmux.
 */
import { test, expect } from "./fixtures/live-app.ts";
import { proveGone, proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

const RENAMED = "e2e-renamed";

test("right-click reaches the multiplexer: rename, dock into a stack, and close a window", async ({
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

  const cards = page.locator("article.app-window-card:not(.app-window-card--ended)");
  await expect(
    cards,
    "the canvas did not render a card per tmux window of the promoted session",
  ).toHaveCount(2, { timeout: 60_000 });

  const menu = page.locator('[role="menu"][data-context-menu="true"]');
  const openMenuOn = async (target: ReturnType<typeof page.locator>): Promise<void> => {
    await target.click({ button: "right" });
    await proveVisible(menu, "the verb context menu", { minWidth: 180, minHeight: 100 });
  };
  const item = (id: string) => menu.locator(`[data-context-menu-item="${id}"]`);

  // --- Right-click on a window card ---------------------------------------
  const first = cards.first();
  const firstHeader = first.locator(".web-pane-frame__header");
  await openMenuOn(firstHeader);

  /*
   * Bug this catches: the menu renders as one undifferentiated list, so the
   * items that move the app's own canvas sit beside the items that change tmux
   * and a user cannot tell which of their arrangements an ssh client will see.
   * That indistinguishability IS m48 gap 1.
   */
  await expect(
    menu.locator("[data-section-id]"),
    "the verb menu no longer separates pane, window, session and app-layout verbs",
  ).toHaveCount(4);
  await proveVisible(item("pane.split.right"), "the split-right item", { minHeight: 16 });
  await expect(
    menu.locator('[data-section-id="arrange"] .tmi-context-menu__section-note'),
    "the app-layout section no longer says that it does not touch the tmux layout",
  ).toContainText("tmux layout is unchanged");
  // Bug this catches: unavailable verbs are hidden rather than refused, so a
  // person who cannot find "close pane" learns nothing about why.
  await expect(
    menu.locator('[data-context-menu-item="pane.select"]'),
    "the already-active pane's focus verb is missing instead of refused with its reason",
  ).toHaveAttribute("aria-disabled", /true|false/u);
  await page.screenshot({ path: testInfo.outputPath("1-window-menu.png") });

  // --- Rename, and prove it reached tmux ----------------------------------
  const beforeWindows = liveApp.fleet.listWindows(session);
  expect(
    beforeWindows.length,
    "the scratch session did not start with two windows to rename between",
  ).toBe(2);

  await item("window.rename").click();
  await proveGone(menu, "the verb menu after choosing rename");
  const field = first.locator(".app-window-card__rename-field");
  await proveVisible(field, "the inline rename field on the card header", { minHeight: 20 });
  await field.fill(RENAMED);
  await field.press("Enter");

  // Bug this catches: the rename edits the app's own title and never reaches
  // tmux, so the name is invisible to `tmux ls` and to any attached client.
  await expect
    .poll(() => liveApp.fleet.listWindows(session), {
      message: "the inline rename never reached tmux — the window name is unchanged in the server",
      timeout: 30_000,
    })
    .toContain(RENAMED);
  // …and the card says the same thing the server does.
  await expect(
    page.locator("article.app-window-card .web-pane-frame__title", { hasText: RENAMED }),
    "tmux renamed the window but the card kept the old title",
  ).toHaveCount(1, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("2-renamed.png") });

  // --- Dock into another window's stack ------------------------------------
  // The dock destinations are the OTHER windows' stacks, so the two cards have
  // to be in different placements first. Whichever way the saved layout starts,
  // this puts one card on the canvas and leaves the other docked.
  const placementItem = '[data-context-menu-item="app-layout:placement"]';
  const placementOf = (index: number) => cards.nth(index).getAttribute("data-placement");
  if ((await placementOf(1)) !== "docked") {
    await openMenuOn(cards.nth(1).locator(".web-pane-frame__header"));
    await menu.locator(placementItem).click();
    await expect
      .poll(() => placementOf(1), { message: "docking the second card did nothing" })
      .toBe("docked");
  }
  if ((await placementOf(0)) !== "floating") {
    await openMenuOn(cards.nth(0).locator(".web-pane-frame__header"));
    await menu.locator(placementItem).click();
    await expect
      .poll(() => placementOf(0), { message: "floating the first card did nothing" })
      .toBe("floating");
  }

  await openMenuOn(cards.nth(0).locator(".web-pane-frame__header"));
  const dockInto = menu.locator('[data-context-menu-item^="app-layout:dock-into:"]').first();
  await proveVisible(dockInto, "the dock-into-stack item", { minHeight: 16 });
  await dockInto.click();

  /*
   * Bug this catches — m48 gap 10: `stack.activate` has been implemented and
   * tested in the daemon kernel since the stack model shipped, and the renderer
   * had no affordance that could produce a stack with two members, so the tab
   * strip that dispatches it never appeared for anyone.
   */
  const tabs = page.locator(".app-window-card__stack-tab");
  await expect(
    tabs,
    "docking one window into another window's stack did not produce a two-tab strip",
  ).toHaveCount(2, { timeout: 30_000 });
  await proveVisible(tabs.first(), "the first stack tab", { minWidth: 40, minHeight: 14 });
  const inactiveTab = page.locator('.app-window-card__stack-tab[data-active="false"]');
  await proveVisible(inactiveTab, "the inactive stack tab", { minWidth: 40, minHeight: 14 });
  const inactiveLabel = (await inactiveTab.innerText()).trim();
  await inactiveTab.click();
  // Bug this catches: the tab strip renders and its clicks go nowhere, which is
  // the state the app shipped in — the command existed, the dispatch did not.
  await expect
    .poll(
      async () =>
        (await page.locator('.app-window-card__stack-tab[data-active="true"]').innerText()).trim(),
      {
        message: `clicking the "${inactiveLabel}" tab did not bring its window to the front of the stack`,
        timeout: 30_000,
      },
    )
    .toBe(inactiveLabel);
  // Only a stack's active member renders as a card, which is exactly why the
  // tab strip has to exist: without it the other window is unreachable.
  await expect(
    cards,
    "docking two windows into one stack did not collapse them to a single card",
  ).toHaveCount(1, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("3-stack-tabs.png") });

  // --- Close a window, with the destructive confirm ------------------------
  const panesBefore = liveApp.fleet.countPanes(session);
  await openMenuOn(cards.first().locator(".web-pane-frame__header"));
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

  // Bug this catches: the confirmed kill changes the app's own document and
  // leaves the tmux pane running — the exact divergence this milestone is about.
  await expect
    .poll(() => liveApp.fleet.countPanes(session), {
      message: "the confirmed close never reached tmux — the pane is still in the server",
      timeout: 30_000,
    })
    .toBe(panesBefore - 1);
  // The stack loses a member, so its tab strip — which only exists for a stack
  // of more than one — goes with it. Bug this catches: tmux closed the window
  // and the app kept a tab pointing at nothing.
  await expect(tabs, "tmux closed the window but its stack tab is still on screen").toHaveCount(0, {
    timeout: 30_000,
  });
  await page.screenshot({ path: testInfo.outputPath("4-window-closed.png") });

  expect(
    crashes,
    `the page threw uncaught errors while driving the verb menus: ${crashes.join(" | ")}`,
  ).toEqual([]);
});
