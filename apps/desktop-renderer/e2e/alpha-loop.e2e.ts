/**
 * Chain: the alpha loop — the path a user actually walks on a live fleet.
 *
 *   the fleet renders → open a second session from the sidebar → type into a
 *   terminal and see the bytes → mirror the workspace's panes → kill the open
 *   session out from under the app → get an honest, visible degraded state →
 *   watch the app recover when the session comes back.
 *
 * It is ONE test on purpose. Split into "the sidebar renders", "the terminal
 * attaches", "the mirror toggles", each part could pass on its own while the
 * loop a user walks is broken between them.
 *
 * Only the fleet construction and the kill are done outside the UI. The kill is
 * the TRIGGER, not the assertion: what is asserted is the app's reaction to a
 * session disappearing, which no in-app affordance can cause.
 */
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

test("a live fleet opens, types, mirrors, survives its session being killed, and recovers", async ({
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
  await page.screenshot({ path: testInfo.outputPath("1-fleet-visible.png") });

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
  await page.screenshot({ path: testInfo.outputPath("2-second-session-opened.png") });

  // --- The terminal paints REAL bytes ------------------------------------
  // Scoped to the ACTIVE window card, not merely the first terminal in the
  // DOM: the canvas cascades floating windows, so the DOM-first tile is the one
  // underneath and is largely covered by the window in front of it.
  const terminal = page
    .locator(
      "article.app-window-card[data-active='true'] .terminal-surface[data-phase='connected']",
    )
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

  // --- User path: mirror the workspace's panes ---------------------------
  const mirrorToggle = page.locator("[data-mirror-toggle]");
  await proveVisible(mirrorToggle, "the mirror toggle in the canvas controls", { minHeight: 16 });
  // Bug this catches: the control loses its pressed state, so a user cannot
  // tell whether mirroring is on without hunting for the nodes themselves.
  await expect(
    mirrorToggle,
    "the mirror toggle does not report an off state before it is pressed",
  ).toHaveAttribute("aria-pressed", "false");
  await mirrorToggle.click();
  await expect(
    mirrorToggle,
    "pressing the mirror toggle did not flip its pressed state",
  ).toHaveAttribute("aria-pressed", "true");

  const mirrorNodes = page.locator("[data-mirror-node-id]");
  await expect(
    mirrorNodes.first(),
    "no mirror node appeared after the toggle was pressed — the mirror is on and shows nothing",
  ).toBeVisible({ timeout: 30_000 });
  const mirrorCount = await mirrorNodes.count();
  expect(
    mirrorCount,
    "the mirror painted no nodes for a workspace that has attachable panes",
  ).toBeGreaterThan(0);
  const firstMirror = mirrorNodes.first();
  // Polled rather than measured once: the mirror rebuilds its node DOM on each
  // stream update (polish finding 2), so a single measurement can land on a
  // detached element. A node that genuinely paints nothing fails every attempt.
  await expect
    .poll(
      async () => {
        const box = await firstMirror.boundingBox().catch(() => null);
        return box ? box.width * box.height : 0;
      },
      {
        message:
          "the first mirror node never settled into a box with area — the mirror is on and paints " +
          "nothing",
        timeout: 20_000,
      },
    )
    .toBeGreaterThan(10_000);
  // The node's header is what a user can actually see of it today: the card
  // body extends below the window and under the bottom dock (polish finding 1),
  // so the centre hit test is asserted on the header rather than on the card.
  await proveVisible(
    firstMirror.locator(".mirror-pane-card__header, header").first(),
    "the first mirror node's header",
    { minWidth: 80, minHeight: 12 },
  );
  // Bug this catches: the node frame appears but its stream never seeds, so the
  // user gets a labelled empty rectangle where a pane should be.
  await expect
    .poll(() => firstMirror.getAttribute("data-state"), {
      message:
        "the mirror node never reached a live state — the frame is on screen with no pane " +
        "content behind it",
      timeout: 30_000,
    })
    .toBe("live");
  // Bug this catches: the mirror renders a terminal grid that never receives
  // the pane's bytes — a live-looking node showing a blank screen.
  await expect
    .poll(() => firstMirror.locator(".xterm-rows").first().innerText(), {
      message:
        "the mirror node painted no pane content — it reports a live stream but its terminal grid " +
        "is empty",
      timeout: 30_000,
    })
    .toMatch(/\S/u);
  await page.screenshot({ path: testInfo.outputPath("4-mirror-on.png") });

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
