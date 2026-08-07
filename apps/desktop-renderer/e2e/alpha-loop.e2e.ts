/**
 * Chain: the alpha loop — the path a user actually walks on a live fleet.
 *
 *   the fleet renders → open a second session from the sidebar → type into a
 *   terminal and see the bytes → compose every tmux pane in place → kill the open
 *   session out from under the app → get an honest, visible degraded state →
 *   watch the app recover when the session comes back.
 *
 * It is ONE test on purpose. Split into "the sidebar renders", "the terminal
 * attaches", "the pane compositor paints", each part could pass on its own while the
 * loop a user walks is broken between them.
 *
 * Only the fleet construction and the kill are done outside the UI. The kill is
 * the TRIGGER, not the assertion: what is asserted is the app's reaction to a
 * session disappearing, which no in-app affordance can cause.
 */
import { hostname } from "node:os";

import { test, expect } from "./fixtures/live-app.ts";
import {
  paintFingerprint,
  proveAllGone,
  proveGone,
  proveVisible,
  provePaintChanged,
} from "./fixtures/visible.ts";

/**
 * Two adopted sessions, one promoted during setup.
 *
 * The second stays unpromoted so the in-app open path has something to act on.
 * The first must be promoted by the harness because the app has no surface that
 * lists sessions until a workspace is already open — the fleet sidebar lives
 * inside the application shell, so with nothing promoted there is no in-app
 * route to a first workspace at all.
 */
test.use({ scratchSessions: 2, promoteSessions: 1 });

const MARKER = "E2E-MARKER-42";

test("a live fleet opens, types, composes panes, survives its session being killed, and recovers", async ({
  page,
  liveApp,
}, testInfo) => {
  const crashes: string[] = [];
  page.on("pageerror", (error) => crashes.push(error.message));

  const [openedSession, secondSession] = liveApp.fleet.sessionNames;
  expect(openedSession, "the fixture did not build two scratch sessions").toBeTruthy();
  expect(secondSession, "the fixture did not build two scratch sessions").toBeTruthy();

  await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });

  // --- The app boots LIVE -------------------------------------------------
  // Bug this catches: the development host refuses (CSP, token, opt-in) and the
  // app quietly renders its preview surface, which would let every assertion
  // below pass against fixture data instead of a real daemon.
  await expect(
    page.locator(".app"),
    "the app did not boot against the live daemon — it fell back to the preview shell, so nothing " +
      "below would be testing real tmux",
  ).toHaveAttribute("data-shell-source", "runtime", { timeout: 60_000 });

  /*
   * Terminals are the landing surface, not a place you navigate to.
   *
   * The whole GUI-first premise is that opening a workspace puts you in front
   * of your terminals. Bug this catches: the shell lands on Home and a user who
   * opened a project sees a readiness card where their panes should be, with
   * the terminals one click away and no reason given.
   */
  await expect(
    page.locator("#primary-tab-terminals"),
    "opening a workspace no longer lands on the terminal canvas",
  ).toHaveAttribute("aria-selected", "true", { timeout: 60_000 });
  await proveVisible(page.locator("#workspace-panel-terminals"), "the terminal canvas on landing", {
    minWidth: 400,
    minHeight: 200,
  });
  await expect(
    page.locator("#workspace-panel-home"),
    "the Home canvas is showing under the terminal canvas on landing",
  ).toBeHidden();

  // --- The fleet is on screen --------------------------------------------
  const sidebar = page.locator(".fleet-sidebar");
  await proveVisible(sidebar, "the fleet sidebar", { minWidth: 120, minHeight: 40 });
  // Bug this catches: the catalog reaches the store but rows render collapsed
  // or clipped by the sidebar's overflow — the fleet count says 2 and the user
  // sees an empty column.
  for (const label of [openedSession!, secondSession!]) {
    await proveVisible(
      sidebar.locator(".fleet-sidebar__session", { hasText: label }),
      `the fleet row for ${label}`,
      { minHeight: 20 },
    );
  }
  await expect(
    sidebar.locator("h2 span"),
    "the fleet heading count disagrees with the two sessions the daemon can see",
  ).toHaveText("2");

  // Bug this catches: two fleet rows of the SAME width give their session names
  // different amounts of room, so one name truncates and the other does not and
  // the list looks unable to make up its mind. Every row reserves the same
  // trailing slot, so every name column measures the same.
  const identityWidths = await sidebar
    .locator(".fleet-sidebar__session-head .sidebar-row__identity")
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().width)));
  expect(
    identityWidths.length,
    "the fleet rows disappeared before their name columns could be measured",
  ).toBeGreaterThanOrEqual(2);
  expect(
    new Set(identityWidths).size,
    `fleet rows truncate at different widths (${identityWidths.join(", ")}px) despite being the ` +
      "same width — the trailing affordance is stealing a different amount of room per row",
  ).toBe(1);

  // Bug this catches: the app renders Windows chrome on a Mac because it read a
  // platform from a spoofed user agent. The suite no longer lies about the
  // browser it drives, so this is now a real fact about a real macOS run.
  await expect(
    page.locator(".app"),
    "the app reports a platform that is not the one it is running on",
  ).toHaveAttribute("data-platform", process.platform);

  await page.screenshot({ path: testInfo.outputPath("1-fleet-visible.png") });

  /*
   * The GUI-first scope call: the parked surfaces are parked, not deleted.
   *
   * A second page against the same live daemon, opened with the flag on, shows
   * all four dock tools. Bug this catches: the "flag" was a deletion wearing a
   * flag's name, so there is nothing left to turn back on — which is the whole
   * difference between a scope decision and an amputation. It runs here, while
   * exactly one workspace is promoted and a fresh page therefore lands on the
   * shell, and on its own page so the chain's own page is never reloaded.
   */
  const flagged = await page.context().newPage();
  try {
    // The dev host's page URL already carries `?devHost=1`, so the flag is
    // appended through URL rather than by string concatenation — a second `?`
    // would land inside the devHost value and the flag would silently not exist.
    const flaggedUrl = new URL(liveApp.pageUrl);
    flaggedUrl.searchParams.set("tmux-ide.experimental-surfaces", "1");
    await flagged.goto(flaggedUrl.toString(), { waitUntil: "domcontentloaded" });
    await expect(
      flagged.locator('.workbench-dock [role="tab"]'),
      "the experimental-surfaces flag no longer restores the parked dock tabs",
    ).toHaveCount(4, { timeout: 60_000 });
    await proveVisible(
      flagged.locator("#workbench-dock-tab-missions"),
      "the Missions tab with the flag on",
      { minHeight: 20 },
    );
  } finally {
    await flagged.close();
  }

  // --- User path: open the second session as a workspace ------------------
  const openAction = page.getByRole("button", { name: `Open ${secondSession} as workspace` });
  await proveVisible(openAction, `the Open action on the ${secondSession} row`, { minHeight: 16 });
  await openAction.click();

  const dialog = page.getByRole("dialog");
  await proveVisible(dialog, "the open-as-workspace confirmation dialog", {
    minWidth: 200,
    minHeight: 100,
  });
  // Bug this catches: the dialog explains an action it is not about to take.
  // It writes tmux-ide identity options onto a session the user already owns,
  // so the promise that nothing is rearranged is load-bearing.
  await expect(
    dialog,
    "the confirmation dialog no longer tells the user what opening a session will do to it",
  ).toContainText("Nothing is rearranged or restarted");

  const confirm = page.locator(".fleet-sidebar__dialog-confirm");
  await proveVisible(confirm, "the dialog's confirm button", { minHeight: 20 });
  await confirm.click();
  await proveGone(dialog, "the open-as-workspace dialog");

  // The session is now registered with the app: the "adopted" badge, which
  // marks a session the app did NOT create and has not registered, clears.
  // Bug this catches: the confirm button resolves without the promotion
  // landing, leaving the user staring at an unchanged row.
  await expect(
    sidebar.locator(".fleet-sidebar__session", { hasText: secondSession! }),
    `confirming the dialog did not register ${secondSession} — the row still reads as merely ` +
      "adopted, so the action reported success it did not achieve",
  ).not.toContainText("adopted", { timeout: 30_000 });
  // Bug this catches: the bottom dock shows a strip of tabs painted as though
  // their panel were open, above a panel of zero height — four tabs sitting
  // over a hole. Collapsed, no tab may claim the open-panel treatment.
  const dockMode = await page.locator(".workspace-main").getAttribute("data-dock-mode");
  if (dockMode === "collapsed") {
    const panelHeight = await page
      .locator(".workspace-main .dock-surface")
      .first()
      .boundingBox()
      .then((box) => box?.height ?? 0)
      .catch(() => 0);
    const selectedBackgrounds = await page
      .locator('.workbench-dock__tab[aria-selected="true"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).backgroundColor.replace(/\s/gu, "")),
      );
    const opaque = selectedBackgrounds.filter(
      (color) => color !== "rgba(0,0,0,0)" && color !== "transparent",
    );
    expect(
      opaque,
      `the collapsed dock paints ${opaque.length} tab(s) as an open panel above a ${Math.round(
        panelHeight,
      )}px panel — the tabs read as broken content rather than as the way to open one`,
    ).toEqual([]);
  }

  /*
   * The GUI-first scope call, on the live shell.
   *
   * Withheld means ABSENT — count, not visibility. A zero-height or off-screen
   * tab still answers a click and still takes a tab stop, so the only assertion
   * that can tell "parked" apart from "shipped badly" is that the node does not
   * exist. Bug this catches: the flag hides the surfaces with CSS and ships the
   * parked orchestration UI to every keyboard user anyway.
   */
  await expect(
    page.locator("#workbench-dock-tab-missions, #workbench-dock-tab-activity"),
    "the parked Missions/Activity dock tabs are in the live DOM with the flag off",
  ).toHaveCount(0);
  await expect(
    page.locator('.workbench-dock [role="tab"]'),
    "the reduced dock does not show exactly its two remaining tools",
  ).toHaveCount(2);

  await page.screenshot({ path: testInfo.outputPath("2-second-session-opened.png") });

  /*
   * The edge, close up. Elevation in this system is a crisp 1px ring rather
   * than a blur, and at 1x with a full-window screenshot that claim is
   * unfalsifiable. This clips the top-left corner of the front window card
   * where it meets the plane behind it; run with E2E_DEVICE_SCALE=3 for a
   * capture at the density the app actually ships at.
   */
  const cardBox = await page.locator(".tiled-pane-area").last().boundingBox();
  if (cardBox) {
    await page.screenshot({
      path: testInfo.outputPath("2b-card-ring-closeup.png"),
      clip: {
        x: Math.max(0, cardBox.x - 12),
        y: Math.max(0, cardBox.y - 12),
        width: 150,
        height: 90,
      },
    });
  }

  // --- The terminal paints REAL bytes ------------------------------------
  // The tiled view holds ONE terminal for the current window: tmux paints that
  // whole window into it, borders and all, so there is no second tile to pick
  // between and nothing cascading over it.
  const terminal = page
    .locator(".tiled-pane-area .terminal-surface[data-phase='connected']")
    .first();
  const terminalProof = await proveVisible(terminal, "the connected terminal tile", {
    minWidth: 200,
    minHeight: 120,
  });
  // Bug this catches: the tile attaches and sizes itself from a saved layout
  // rather than from its measured box, so tmux is driven at a grid that does
  // not match the pixels — the classic wrapped-and-garbled pane.
  await expect(
    terminal,
    "the connected terminal reports no client viewport, so it attached without measuring itself",
  ).toHaveAttribute("data-client-viewport", /^\d+x\d+$/u);

  /*
   * The window tab carries the LIVE tmux window name.
   *
   * Bug this catches — the m48 finding the layout-faithful view exists to
   * remove: every tab labelled "Terminal", because the labels came from the
   * app's own document instead of from the window names tmux actually has.
   */
  const activeTab = page.locator('.window-tabs__tab[data-active="true"]');
  await proveVisible(activeTab, "the active window tab", { minWidth: 30, minHeight: 16 });
  const tabLabel = (await activeTab.innerText()).trim();
  expect(
    tabLabel,
    "the active window tab carries no label, so the strip says nothing about where the user is",
  ).toMatch(/\S/u);
  expect(
    tabLabel.toLowerCase(),
    "the window tab is labelled with the app's generic word instead of tmux's window name",
  ).not.toBe("terminal");

  // Bug this catches: the window is titled with the machine's own hostname,
  // which tmux seeds pane_title with. It is the same string on every pane, says
  // nothing about it, and puts the user's machine name in every shared screenshot.
  const hostFirstLabel = hostname().split(".")[0]!.toLowerCase();
  expect(
    tabLabel.toLowerCase().split(".")[0],
    `the window is titled with this machine's name ("${tabLabel}") instead of a window name`,
  ).not.toBe(hostFirstLabel);

  /*
   * The tiles do not overlap.
   *
   * Bug this catches — the defect class the canvas model carried: cards
   * cascading over each other, so the thing behind the front one is a shadow
   * artifact with no grab target of its own. tmux's layout has no overlap by
   * construction, and a view that renders it faithfully cannot invent one.
   */
  const tileRects = await page.locator(".pane-tile").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }),
  );
  expect(
    tileRects.length,
    "the tiled view rendered no pane tiles for a live window",
  ).toBeGreaterThan(0);
  for (const [index, first] of tileRects.entries()) {
    for (const second of tileRects.slice(index + 1)) {
      const overlapWidth = Math.max(
        0,
        Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x),
      );
      const overlapHeight = Math.max(
        0,
        Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y),
      );
      expect(
        overlapWidth * overlapHeight,
        `two pane tiles overlap by ${Math.round(overlapWidth * overlapHeight)}px\u00b2 — the view ` +
          "is no longer rendering tmux's own non-overlapping layout",
      ).toBe(0);
    }
  }

  /*
   * The terminal ground is DARK in both appearances (m50.2, gap 2).
   *
   * It used to follow the app theme, which meant a light-mode user got a white
   * terminal and a sixteen-colour ANSI ramp re-tuned to survive it. Those
   * colours are authored by the programs being rendered, against a dark ground;
   * the light surface was the thing they were compensating for. So the terminal
   * is a machine surface with one ground, the way an emulator is, while the
   * chrome around it still follows light/dark.
   *
   * Bug this catches: a token refactor quietly re-attaches the terminal ground
   * to the appearance tokens, and light mode goes back to a glaring white
   * terminal under colours chosen for black.
   */
  const groundLuminance = await terminal.evaluate((element) => {
    const color = getComputedStyle(element).backgroundColor;
    // Rasterise the computed colour rather than parsing it. The token layer is
    // authored in oklch, so a regex over rgb() channels reads a lightness of
    // 1.0 as "almost black" — the browser is the only thing that reliably
    // converts an arbitrary CSS colour space to pixels.
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) return { color, value: 255 };
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return { color, value: (red! + green! + blue!) / 3 };
  });
  const appTheme = await page.locator(".app").getAttribute("data-theme");
  expect(
    groundLuminance.value < 128,
    `the app is in ${appTheme} mode and its terminal ground is ${groundLuminance.color} — ` +
      "the terminal is meant to keep one dark machine ground in both appearances",
  ).toBe(true);

  const beforeTyping = await paintFingerprint(terminal);

  // The user path: click the terminal screen, then type. Nothing is written
  // through the transport by hand — these are real key events.
  await terminal.locator(".xterm-screen").click();
  await expect(
    terminal,
    "clicking the terminal did not focus it, so a user's keystrokes would go nowhere",
  ).toHaveAttribute("data-focused", "true");
  await page.keyboard.type(`echo ${MARKER}`);
  await page.keyboard.press("Enter");

  // Bug this catches: input reaches xterm but never reaches tmux — the tile
  // echoes locally and the pane behind it never advances.
  await expect
    .poll(() => liveApp.fleet.capturePane(openedSession!), {
      message:
        "the keystrokes never reached the tmux pane — the terminal is accepting input it does " +
        "not deliver",
      timeout: 20_000,
    })
    .toContain(MARKER);

  // And the bytes come BACK and are painted where the user can read them.
  const markerRow = terminal.locator(".xterm-rows > div").filter({ hasText: MARKER }).first();
  await proveVisible(markerRow, `the terminal row showing "${MARKER}"`, {
    minWidth: 40,
    minHeight: 4,
  });
  provePaintChanged(beforeTyping, await paintFingerprint(terminal), "the terminal tile");
  expect(
    terminalProof.rect.width * terminalProof.rect.height,
    "the terminal tile has an area under 10,000px — it is a sliver, not a terminal",
  ).toBeGreaterThan(10_000);
  await page.screenshot({ path: testInfo.outputPath("3-terminal-typed.png") });

  // --- User path: tmux's panes are composed into its own layout -----------
  // There is no separate mirror deck in the GUI-first path. The pane streams
  // are the visible bodies of the non-overlapping tmux tiles, while one hidden
  // whole-window attachment remains the geometry and keyboard owner.
  const tiledArea = page.locator(".tiled-pane-area");
  await expect(
    tiledArea,
    "the tiled workspace never promoted its live pane streams into the visible compositor",
  ).toHaveAttribute("data-pane-compositor", "true", { timeout: 30_000 });

  const composedTiles = page.locator('.pane-tile[data-composed="true"]');
  await expect(
    composedTiles.first(),
    "no composed pane appeared for a workspace that has attachable panes",
  ).toBeVisible({ timeout: 30_000 });
  const composedCount = await composedTiles.count();
  expect(
    composedCount,
    "the compositor painted no tiles for a workspace that has attachable panes",
  ).toBeGreaterThan(0);
  const firstTile = composedTiles.first();
  const firstComposedPane = await firstTile.getAttribute("data-pane");
  const firstCompositorNode = firstTile.locator(".mirror-pane-node");
  await expect(firstCompositorNode, "the first composed pane body is not visible").toBeVisible();
  const compositorRect = await firstCompositorNode.boundingBox();
  expect(compositorRect, "the first composed pane body has no measurable box").not.toBeNull();
  expect(
    compositorRect!.width >= 120 && compositorRect!.height >= 100,
    `the first composed pane body is only ${Math.round(compositorRect!.width)}x${Math.round(compositorRect!.height)}px`,
  ).toBe(true);
  // Bug this catches: the pane body is laid out below the fold or under the
  // dock, so its frame technically exists and the user sees a strip or nothing.
  const windowSize = page.viewportSize()!;
  expect(
    compositorRect!.y + compositorRect!.height,
    `the first composed pane ends at y=${Math.round(compositorRect!.y + compositorRect!.height)} ` +
      `in a ${windowSize.height}px window — its body is below the visible area`,
  ).toBeLessThanOrEqual(windowSize.height);
  const dockTop = await page
    .locator(".workbench-dock, [data-workbench-dock]")
    .first()
    .boundingBox()
    .then((box) => box?.y ?? windowSize.height)
    .catch(() => windowSize.height);
  expect(
    compositorRect!.y + compositorRect!.height,
    "the first composed pane body runs under the dock",
  ).toBeLessThanOrEqual(dockTop);

  // Bug this catches: the tile frame appears but its stream never seeds, so the
  // user gets labelled chrome around an empty rectangle.
  await expect
    .poll(() => firstCompositorNode.getAttribute("data-state"), {
      message:
        "the composed pane never reached a live state — the frame is on screen with no pane " +
        "content behind it",
      timeout: 30_000,
    })
    .toBe("live");
  // Bug this catches: the compositor renders a terminal grid that never
  // receives the pane's bytes — a live-looking tile showing a blank screen.
  await expect
    .poll(() => firstCompositorNode.locator(".xterm-rows").first().innerText(), {
      message:
        "the composed pane painted no content — it reports a live stream but its terminal grid " +
        "is empty",
      timeout: 30_000,
    })
    .toMatch(/\S/u);

  /*
   * The GRID is inside the card, not merely the card inside the window.
   *
   * Bug this catches (m50.2): the letterbox fit scaled the emulator about its
   * own centre, which is the centre of the card only while the grid still fits
   * it. Once the app owned tmux's window geometry the element laid out at grid
   * size — far larger than the card — and the render was parked around a point
   * outside it: measured 180px below the card and off the bottom of the window,
   * where xterm stops painting. The card stayed on screen and reported a live
   * stream the whole time, which is why every existing placement assertion
   * passed; only the pixels the user reads were somewhere else.
   */
  const gridPlacement = await firstCompositorNode.evaluate((element) => {
    const screen = element.querySelector(".xterm-screen");
    if (!screen) return null;
    const card = element.parentElement?.getBoundingClientRect() ?? element.getBoundingClientRect();
    const grid = screen.getBoundingClientRect();
    return {
      card: { top: card.top, bottom: card.bottom, left: card.left, right: card.right },
      grid: { top: grid.top, bottom: grid.bottom, left: grid.left, right: grid.right },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(gridPlacement, "the composed pane has no rendered grid at all").not.toBeNull();
  const placement = gridPlacement!;
  const slack = 1; // sub-pixel: a fractional scale cannot round to an escape.
  expect(
    placement.grid.top >= placement.card.top - slack &&
      placement.grid.bottom <= placement.card.bottom + slack &&
      placement.grid.left >= placement.card.left - slack &&
      placement.grid.right <= placement.card.right + slack,
    `the composed pane's grid is rendered at ${JSON.stringify(placement.grid)} but its card is at ` +
      `${JSON.stringify(placement.card)} — the render escaped the card that frames it`,
  ).toBe(true);
  expect(
    placement.grid.bottom <= placement.viewport.height && placement.grid.top >= 0,
    `the composed pane's grid runs from ${Math.round(placement.grid.top)} to ` +
      `${Math.round(placement.grid.bottom)} in a ${placement.viewport.height}px window — the ` +
      "emulator stops painting outside the viewport, so the pane would freeze mid-stream",
  ).toBe(true);

  // Bug this catches — the defect this step was rewritten for: the compositor
  // rebuilt every pane body's DOM on each stream update, so each tick threw away the
  // xterm instance and re-initialized it. Identity is asserted on the element
  // itself, across ticks driven by real typing into the mirrored pane.
  const compositorHandle = (await firstCompositorNode.elementHandle())!;
  for (let tick = 0; tick < 3; tick += 1) {
    const echo = `MIRROR-TICK-${tick}`;
    /*
     * Click near the top of the terminal BODY, below the one-row pane header.
     * The header deliberately receives pointer input for drag, zoom, and menu
     * actions; the transparent remainder forwards input to the whole-window
     * attachment beneath the compositor.
     */
    await terminal.locator(".xterm-screen").click({ position: { x: 24, y: 48 } });
    await page.keyboard.type(`echo ${echo}`);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => firstCompositorNode.locator(".xterm-rows").first().innerText(), {
        message: `the composed pane never streamed the output of tick ${tick}`,
        timeout: 20_000,
      })
      .toContain(echo);
    const current = (await firstCompositorNode.elementHandle())!;
    expect(
      await page.evaluate(([before, after]) => before === after, [
        compositorHandle,
        current,
      ] as const),
      "the composed pane was replaced by a stream update — its xterm re-initializes every tick, " +
        "which is the re-mount defect",
    ).toBe(true);
    expect(
      await firstCompositorNode.getAttribute("data-pane"),
      "the composed pane list reordered under a stream update",
    ).toBe(firstComposedPane);
  }
  // And the pane is STILL fully on screen after those ticks: placement must
  // survive re-measurement, not merely be right on the first paint.
  await expect(
    firstCompositorNode,
    "the first composed pane disappeared after several stream updates",
  ).toBeVisible();
  const finalCompositorRect = await firstCompositorNode.boundingBox();
  expect(
    finalCompositorRect !== null &&
      finalCompositorRect.width >= 120 &&
      finalCompositorRect.height >= 100,
    "the first composed pane collapsed after several stream updates",
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("4-pane-compositor-live.png") });

  // --- The session dies under the app ------------------------------------
  // Setup-level, and deliberately so: no in-app affordance can make a tmux
  // session vanish, and the app's reaction is the whole point of this step.
  liveApp.fleet.killSession(openedSession!);

  // Bug this catches: the workspace surfaces linger with stale pixels, showing
  // a terminal that no longer exists as though it were live.
  await proveAllGone(
    page.locator(".terminal-surface[data-phase='connected']"),
    "the connected terminal tiles of the killed session",
  );

  const degraded = page.locator("main.runtime-state-surface");
  await expect(
    degraded,
    "the app did not enter a degraded state after its tmux session was killed — it is either " +
      "still claiming a live workspace or it blanked",
  ).toHaveAttribute("data-state", "degraded", { timeout: 45_000 });
  await proveVisible(degraded, "the degraded workspace surface", { minWidth: 400, minHeight: 300 });
  // Bug this catches: the degraded surface renders as an unnamed blank panel —
  // "something went wrong" with nothing the user can read or act on.
  await proveVisible(page.locator("#runtime-state-title"), "the degraded state's headline");
  await expect(
    page.locator("#runtime-state-title"),
    "the degraded state has no name, so the user cannot tell what broke",
  ).toHaveText(/\S/u);
  await proveVisible(
    page.getByRole("button", { name: "Reload workspace" }),
    "the degraded state's recovery action",
    { minHeight: 20 },
  );
  // Bug this catches: the shell itself unmounts on the failure, leaving a white
  // page — the failure mode that reads to a user as a crash.
  await proveVisible(page.locator(".app"), "the app shell during the degraded state", {
    minWidth: 400,
    minHeight: 400,
  });
  await expect(
    page.locator(".status-strip__connection"),
    "the status strip still claims a connection while the workspace surface says it is degraded",
  ).toHaveAttribute("data-state", "degraded");
  await page.screenshot({ path: testInfo.outputPath("5-degraded.png") });

  // --- Recovery -----------------------------------------------------------
  // There is no in-app path back while the session is gone (see the polish
  // findings: "Reload workspace" cannot reach the other live workspace). What
  // the app does do is rejoin by itself when the session returns.
  liveApp.fleet.createSession(openedSession!);
  // Bug this catches: the app latches its degraded state and stays there after
  // the world it was complaining about has come back.
  await expect(
    page.locator(".fleet-sidebar"),
    "the app stayed degraded after its tmux session came back — recovery requires restarting it",
  ).toBeVisible({ timeout: 60_000 });
  await proveVisible(page.locator(".fleet-sidebar"), "the fleet sidebar after recovery", {
    minWidth: 120,
    minHeight: 40,
  });
  await page.screenshot({ path: testInfo.outputPath("6-recovered.png") });

  expect(
    crashes,
    `the page threw uncaught errors while its session was killed and restored: ${crashes.join(" | ")}`,
  ).toEqual([]);
});
