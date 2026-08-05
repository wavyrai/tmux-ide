/**
 * Chain: cold start against an EMPTY fleet.
 *
 * A user who installs tmux-ide and opens it before adopting anything must see
 * an invitation, not a fault. The daemon's readiness ladder already draws this
 * distinction — an empty catalog is `satisfied`, not `stuck` — and this chain
 * proves the app honours it all the way to the pixels: onboarding, on screen,
 * with a working way forward and no error vocabulary anywhere on it.
 */
import { test, expect } from "./fixtures/live-app.ts";
import { proveVisible } from "./fixtures/visible.ts";

test.use({ scratchSessions: 0, promoteSessions: 0 });

test("a cold start with nothing adopted shows the onboarding invitation, not a fault", async ({
  page,
  liveApp,
}, testInfo) => {
  // Setup-level, and the premise of the whole chain: the daemon considers an
  // empty fleet READY. If this rung were stuck, an error screen downstream
  // would be honest and the chain would be testing the wrong thing.
  const catalogRung = liveApp.readinessAtStart.rungs.find(
    (rung) => rung.rung === "catalog-populated",
  );
  expect(
    catalogRung?.status,
    "the readiness ladder reports an empty fleet as stuck — an empty fleet is not a fault, and " +
      "treating it as one is what makes a first-run user see an error screen",
  ).toBe("satisfied");
  expect(
    catalogRung?.population?.fleet,
    "the ladder did not distinguish an EMPTY catalog from a populated one, so the app cannot tell " +
      "'nothing adopted yet' from 'sessions exist but none are reachable'",
  ).toBe("empty");

  await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });

  // The onboarding surface, seen. Bug this catches: an empty fleet lands on the
  // loading or degraded surface and the user is told something is broken.
  const surface = page.locator("main.runtime-state-surface");
  await expect(
    surface,
    "an empty fleet did not settle on the onboarding surface — the first thing a new user sees " +
      "is a connection fault instead of an invitation",
  ).toHaveAttribute("data-state", "onboarding", { timeout: 60_000 });
  await proveVisible(surface, "the onboarding surface", { minWidth: 400, minHeight: 300 });

  // Bug this catches: the card renders but its copy collapses behind the
  // onboarding aside, so the invitation exists in the DOM and not on screen.
  await proveVisible(page.locator("#runtime-state-title"), "the onboarding headline");
  await expect(
    page.locator("#runtime-state-title"),
    "the onboarding headline stopped inviting the user to open a project",
  ).toHaveText("Open a project to begin");

  // Bug this catches: the only way forward is rendered disabled or off screen,
  // leaving a first-run user with a screen they cannot act on.
  const openProject = page.getByRole("button", { name: "Open Folder" });
  await proveVisible(openProject, "the Open Folder button");
  await expect(
    openProject,
    "the Open Folder button is disabled on a cold empty start, so the onboarding screen is a " +
      "dead end",
  ).toBeEnabled();

  // Bug this catches: an empty fleet is described with failure vocabulary —
  // the copy lying about what happened is itself the defect.
  const surfaceText = (await surface.innerText()).toLowerCase();
  for (const word of ["unavailable", "failed", "error", "needs attention"]) {
    expect(
      surfaceText,
      `the empty-fleet screen says "${word}" — nothing failed, the user simply has no adopted ` +
        "sessions yet",
    ).not.toContain(word);
  }

  // And the status strip must agree with the main surface; a strip still
  // reporting a fault under an invitation is the mixed-message bug.
  await expect(
    page.locator(".status-strip__connection"),
    "the status strip contradicts the onboarding surface it sits under",
  ).toHaveAttribute("data-state", "onboarding");

  // Bug this catches: a bullet whose copy is split across several grid items
  // gets placed into the dot column and onto the next row, so the line paints
  // on top of itself — "No ide.yml required" rendered as overlapping text.
  // Each bullet's copy must occupy exactly one line box.
  const bulletOverlaps = await page.locator(".runtime-onboarding-notes li").evaluateAll((nodes) =>
    nodes.map((node) => {
      // The COPY element's own line boxes. A Range over the whole <li> would
      // also enumerate nested inline elements (the <code>), whose rect sits
      // inside its parent's line box and would read as a false overlap.
      const copy = node.querySelector("span");
      const lines = [...(copy?.getClientRects() ?? [])].filter((rect) => rect.width > 0);
      let overlapping = 0;
      for (let left = 0; left < lines.length; left += 1) {
        for (let right = left + 1; right < lines.length; right += 1) {
          const a = lines[left]!;
          const b = lines[right]!;
          const sharedY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          const sharedX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          if (sharedY > 2 && sharedX > 2) overlapping += 1;
        }
      }
      return { text: node.textContent?.trim() ?? "", overlapping };
    }),
  );
  expect(
    bulletOverlaps.length,
    "the onboarding aside rendered no bullets, so its copy could not be checked",
  ).toBeGreaterThan(0);
  for (const bullet of bulletOverlaps) {
    expect(
      bullet.overlapping,
      `the onboarding bullet "${bullet.text}" paints ${bullet.overlapping} of its line boxes on ` +
        "top of each other — the words are stacked over one another and unreadable",
    ).toBe(0);
  }

  await page.screenshot({ path: testInfo.outputPath("empty-fleet-onboarding.png") });
});
