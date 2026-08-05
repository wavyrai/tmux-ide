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

  /*
   * Address cards by their DURABLE window id, never by DOM position.
   *
   * Focusing a card raises it, and the canvas paints in z-order, so the card a
   * user just right-clicked is very often no longer the first one in the DOM.
   * A positional locator here would silently act on the other window.
   */
  const windowIds = await cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-window-id") ?? "",
      active: node.getAttribute("data-active") === "true",
    })),
  );
  // The subject is the ACTIVE window: it is the one a user is working in, and
  // it is the one whose terminal is attached rather than retrying, so its card
  // is not being torn down and rebuilt under the pointer.
  const subjectId = (windowIds.find((entry) => entry.active) ?? windowIds[0])?.id;
  const otherId = windowIds.find((entry) => entry.id !== subjectId)?.id;
  expect(subjectId, "the canvas rendered a card with no durable window id").toBeTruthy();
  expect(otherId, "the canvas rendered only one card for a two-window session").toBeTruthy();
  const cardFor = (windowId: string) =>
    page.locator(`article.app-window-card[data-window-id="${windowId}"]`);

  const menu = page.locator('[role="menu"][data-context-menu="true"]');

  /**
   * A viewport point where this card's header is the topmost thing.
   *
   * Cards cascade, so the centre of the back card's header is under the front
   * card. A `position` guess would be a bet on the offset; this asks the page
   * which pixels of the header actually belong to it, which is the same
   * question a user answers with their eyes before aiming.
   */
  const headerPoint = async (windowId: string): Promise<{ x: number; y: number }> => {
    const point = await page.evaluate((id) => {
      const header = document
        .querySelector(`article.app-window-card[data-window-id="${id}"]`)
        ?.querySelector(".web-pane-frame__header");
      if (!header) return null;
      const rect = header.getBoundingClientRect();
      for (let ratioX = 0.1; ratioX <= 0.9; ratioX += 0.1) {
        for (let ratioY = 0.3; ratioY <= 0.8; ratioY += 0.25) {
          const x = Math.round(rect.left + rect.width * ratioX);
          const y = Math.round(rect.top + rect.height * ratioY);
          const hit = document.elementFromPoint(x, y);
          if (hit && header.contains(hit)) return { x, y };
        }
      }
      return null;
    }, windowId);
    expect(
      point,
      `no pixel of the ${windowId} card's header is reachable — it is entirely under another card`,
    ).not.toBeNull();
    return point!;
  };

  const openMenuOn = async (windowId: string): Promise<void> => {
    const point = await headerPoint(windowId);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await proveVisible(menu, "the verb context menu", { minWidth: 180, minHeight: 100 });
  };
  const item = (id: string) => menu.locator(`[data-context-menu-item="${id}"]`);

  // --- Right-click on a window card ---------------------------------------
  await openMenuOn(subjectId!);

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
  const field = cardFor(subjectId!).locator(".app-window-card__rename-field");
  await proveVisible(field, "the inline rename field on the card header", { minHeight: 20 });
  // Typed, not filled: real key events are what a user produces, and they are
  // the only way to prove the editor's own input handling works.
  await field.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
  await page.keyboard.type(RENAMED);
  // Bug this catches: the card is rebuilt under the editor, so the field the
  // user typed into is replaced by a fresh one and their typing is gone before
  // they press Enter.
  expect(
    await field.inputValue(),
    "the rename field lost what was typed into it before it could be committed",
  ).toBe(RENAMED);
  await page.keyboard.press("Enter");
  // Bug this catches: Enter never reaches the editor's handler, so the field
  // just sits there and the user presses it again on an unchanged window.
  await proveGone(field, "the rename editor after Enter");

  /*
   * Bug this catches: the rename edits the app's own title and never reaches
   * tmux, so the name is invisible to `tmux ls` and to any attached client.
   *
   * The poll also reads the app's own refusal line, so a rename the daemon
   * declined fails with the daemon's sentence rather than with "the name is
   * still 'one'" — and a refusal that appears with no line at all is itself the
   * regression, because a silently swallowed verb is the worst of the outcomes.
   */
  const verbError = page.locator("[data-verb-error]");
  const observed: string[] = [];
  await expect
    .poll(
      async () => {
        const names = liveApp.fleet.listWindows(session).join(",");
        const refusal = (await verbError.count()) > 0 ? (await verbError.innerText()).trim() : "";
        observed.push(refusal ? `${names} | ${refusal}` : names);
        if (names.split(",").includes(RENAMED)) return RENAMED;
        return `observed: ${[...new Set(observed)].join(" >> ")}`;
      },
      { message: "the inline rename did not reach tmux", timeout: 20_000, intervals: [50, 50, 50] },
    )
    .toBe(RENAMED);
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
  const placementOf = (windowId: string) => cardFor(windowId).getAttribute("data-placement");
  if ((await placementOf(otherId!)) !== "docked") {
    await openMenuOn(otherId!);
    await menu.locator(placementItem).click();
    await expect
      .poll(() => placementOf(otherId!), { message: "docking the other card did nothing" })
      .toBe("docked");
  }
  if ((await placementOf(subjectId!)) !== "floating") {
    await openMenuOn(subjectId!);
    await menu.locator(placementItem).click();
    await expect
      .poll(() => placementOf(subjectId!), { message: "floating the subject card did nothing" })
      .toBe("floating");
  }

  await openMenuOn(subjectId!);
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
  // After docking, only the stack's active member renders; open its menu.
  const activeCardId = (await cards.first().getAttribute("data-window-id"))!;
  await openMenuOn(activeCardId);
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
  /*
   * The killed window stops showing a live terminal.
   *
   * Bug this catches: the card keeps painting the last bytes of a pane that no
   * longer exists, so a user reads a dead terminal as a live one. The window's
   * entry in the app's own layout document outlives the pane — the daemon
   * prunes that on its own schedule — which is why this asserts the terminal
   * rather than the card.
   */
  await expect(
    page.locator(
      `article.app-window-card[data-window-id="${activeCardId}"] .terminal-surface[data-phase="connected"]`,
    ),
    "the killed window still shows a connected terminal",
  ).toHaveCount(0, { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath("4-window-closed.png") });

  expect(
    crashes,
    `the page threw uncaught errors while driving the verb menus: ${crashes.join(" | ")}`,
  ).toEqual([]);
});
