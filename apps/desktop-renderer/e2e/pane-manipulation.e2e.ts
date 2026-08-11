/**
 * Card #183: pane manipulation feels local while tmux remains durable truth.
 *
 * One real-tmux chain proves the boundaries together: an optimistic border
 * preview precedes confirmation, a header drag can be cancelled with no tmux
 * mutation, an unequal source/target swap lands in tmux, and the one interactive
 * TerminalSurface stays mounted and live through every layout frame.
 */
import type { ElementHandle, Locator, Page } from "@playwright/test";

import { test, expect } from "./fixtures/live-app.ts";
import {
  MANIPULATION_PHASES,
  PaneManipulationProbe,
  tmuxLayoutSignature,
  tmuxPaneGeometry,
  type TmuxPaneGeometry,
} from "./fixtures/pane-manipulation.ts";
import {
  paintFingerprint,
  proveGone,
  provePaintChanged,
  proveVisible,
} from "./fixtures/visible.ts";

test.use({ scratchSessions: 1, promoteSessions: 1 });

const INITIAL_MARKER = "MANIPULATION-SEED-41C7";
// Keep the proof on one physical row even after a vertical split; the visible
// pane stream is narrower than the hidden whole-window controller by design.
const LIVE_MARKER = "STILL-LIVE-8A2D";

interface DomLayout {
  readonly semanticPaneId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

async function domLayout(page: Page): Promise<readonly DomLayout[]> {
  return await page.locator(".pane-tile[data-pane]").evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          semanticPaneId: node.getAttribute("data-pane") ?? "",
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        };
      })
      .sort((left, right) => left.semanticPaneId.localeCompare(right.semanticPaneId)),
  );
}

function pane(panes: readonly TmuxPaneGeometry[], semanticPaneId: string): TmuxPaneGeometry {
  const found = panes.find((candidate) => candidate.semanticPaneId === semanticPaneId);
  if (!found) throw new Error(`tmux has no pane carrying semantic identity ${semanticPaneId}`);
  return found;
}

function ownerFromBorder(borderId: string): string {
  return borderId.replace(/:(?:cols|rows)$/u, "");
}

async function expectSameTerminal(
  page: Page,
  original: ElementHandle<HTMLElement>,
  terminal: Locator,
  step: string,
): Promise<void> {
  const current = (await terminal.elementHandle()) as ElementHandle<HTMLElement> | null;
  expect(current, `${step}: the TerminalSurface disappeared`).not.toBeNull();
  expect(
    await page.evaluate(([before, after]) => before === after, [original, current!] as const),
    `${step}: the TerminalSurface DOM node was replaced, so xterm and its live attachment remounted`,
  ).toBe(true);
}

async function expectLiveCompositor(terminal: Locator, area: Locator, step: string): Promise<void> {
  await expect(terminal, `${step}: the interactive attachment did not recover`).toHaveAttribute(
    "data-phase",
    "connected",
    { timeout: 30_000 },
  );
  await expect(area, `${step}: the per-pane compositor did not recover`).toHaveAttribute(
    "data-pane-compositor",
    "true",
    { timeout: 30_000 },
  );
}

function expectLayoutRestored(before: readonly DomLayout[], after: readonly DomLayout[]): void {
  expect(
    after.map(({ semanticPaneId }) => semanticPaneId),
    "cancelling the drag changed which semantic panes are present",
  ).toEqual(before.map(({ semanticPaneId }) => semanticPaneId));
  for (const previous of before) {
    const current = after.find(({ semanticPaneId }) => semanticPaneId === previous.semanticPaneId)!;
    for (const axis of ["left", "top", "width", "height"] as const) {
      expect(
        Math.abs(current[axis] - previous[axis]),
        `cancelling the drag left ${previous.semanticPaneId}'s ${axis} displaced ` +
          `(${previous[axis]} before, ${current[axis]} after)`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

async function dragFromHeaderToTile(
  page: Page,
  sourceHeader: Locator,
  targetTile: Locator,
  release: "drop" | "cancel",
): Promise<void> {
  const source = await sourceHeader.boundingBox();
  expect(source, "the pane drag handle has no pointer geometry").not.toBeNull();
  // Resolve the live hit target after any confirmed-layout FLIP has settled.
  await page.waitForTimeout(350);
  await sourceHeader.hover({ position: { x: source!.width / 2, y: source!.height / 2 } });
  const target = await targetTile.boundingBox();
  expect(target, "the pane drop target has no pointer geometry").not.toBeNull();
  await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, {
    steps: 8,
  });
  if (release === "cancel") await page.keyboard.press("Escape");
  await page.mouse.up();
}

test("resize previews locally; header drag cancels or swaps without remounting the live terminal", async ({
  page,
  liveApp,
}, testInfo) => {
  const sessionName = liveApp.fleet.sessionNames[0]!;
  liveApp.fleet.typeInPane(sessionName, `printf '${INITIAL_MARKER}\\n'`);
  const probe = new PaneManipulationProbe(page);

  try {
    await page.goto(liveApp.pageUrl, { waitUntil: "domcontentloaded" });
    await expect(
      page.locator(".app"),
      "the direct-manipulation chain did not boot against the live daemon",
    ).toHaveAttribute("data-shell-source", "runtime", { timeout: 60_000 });

    const terminal = page.locator(".tiled-pane-area .terminal-surface").first();
    await expect(
      terminal,
      "the interactive terminal did not attach before pane manipulation began",
    ).toHaveAttribute("data-phase", "connected", { timeout: 45_000 });
    await proveVisible(
      terminal.locator(".xterm-rows > div").filter({ hasText: INITIAL_MARKER }).first(),
      `the initial terminal row showing "${INITIAL_MARKER}"`,
      { minWidth: 80, minHeight: 4, timeoutMs: 30_000 },
    );
    const originalTerminal = (await terminal.elementHandle()) as ElementHandle<HTMLElement> | null;
    expect(originalTerminal, "the connected TerminalSurface has no DOM node").not.toBeNull();

    const area = page.locator(".tiled-pane-area");
    await probe.install();
    await expect(
      area,
      "the pane area does not expose the bounded manipulation lifecycle",
    ).toHaveAttribute("data-manipulation-phase", "idle");

    // Establish two real panes through the product surface. A direct tmux split
    // would prove the layout reader, but not the user's path into this feature.
    const menu = page.locator('[role="menu"][data-context-menu="true"]');
    const firstTileBox = (await page.locator(".pane-tile").first().boundingBox())!;
    await page.mouse.click(
      firstTileBox.x + Math.min(24, firstTileBox.width / 3),
      firstTileBox.y + firstTileBox.height / 2,
      { button: "right" },
    );
    await proveVisible(menu, "the pane verb menu used to create the target", {
      minWidth: 180,
      minHeight: 100,
    });
    await menu.locator('[data-context-menu-item="pane.split.right"]').click();
    await proveGone(menu, "the pane menu after splitting");
    const tiles = page.locator(".pane-tile[data-pane]");
    await expect(
      tiles,
      "the split reached tmux but the tiled view did not gain its target",
    ).toHaveCount(2, { timeout: 30_000 });
    await expect(
      area,
      "the confirmed split did not register an entering layout transition",
    ).toHaveAttribute("data-last-layout-transition", /^(?:enter|mixed)$/u);
    await expect
      .poll(
        () => {
          const panes = tmuxPaneGeometry(liveApp.fleet, sessionName);
          return (
            panes.length === 2 && panes.every(({ semanticPaneId }) => semanticPaneId.length > 0)
          );
        },
        {
          message: "tmux did not expose two durably stamped panes after the split",
          timeout: 30_000,
        },
      )
      .toBe(true);
    await expectSameTerminal(page, originalTerminal!, terminal, "after splitting the window");
    await expectLiveCompositor(terminal, area, "after splitting the window");

    // --- Resize: local preview first, then exact tmux confirmation ----------
    const border = page.locator('.pane-border[data-orientation="vertical"]').first();
    await proveVisible(border, "the direct-resize border", { minWidth: 1, minHeight: 20 });
    const borderId = await border.getAttribute("data-pane-border");
    expect(borderId, "the resize border does not name its semantic owner").not.toBeNull();
    const sourcePane = ownerFromBorder(borderId!);
    const allPaneIds = await tiles.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-pane") ?? ""),
    );
    const targetPane = allPaneIds.find((id) => id !== sourcePane);
    expect(targetPane, "the split target has no semantic identity").toBeTruthy();

    const sourceTile = page.locator(`.pane-tile[data-pane="${sourcePane}"]`);
    const targetTile = page.locator(`.pane-tile[data-pane="${targetPane!}"]`);
    const widthBeforePreview = (await sourceTile.boundingBox())!.width;
    const borderBox = (await border.boundingBox())!;
    await probe.mark("before-resize-grab");
    await border.hover({
      position: { x: borderBox.width / 2, y: borderBox.height / 2 },
    });
    const grabbedBorderBox = (await border.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(
      grabbedBorderBox.x - 100,
      grabbedBorderBox.y + grabbedBorderBox.height / 2,
      { steps: 2 },
    );

    await expect(
      area,
      "moving a held border did not enter the local preview phase before release",
    ).toHaveAttribute("data-manipulation-phase", "resize-preview");
    const previewCellsText = await area.getAttribute("data-manipulation-preview-cells");
    const previewCells = Number(previewCellsText);
    expect(
      Number.isSafeInteger(previewCells) && previewCells > 0,
      `the preview did not expose a positive whole-cell target (received ${previewCellsText})`,
    ).toBe(true);
    await proveVisible(page.locator(".pane-resize-hud"), "the live resize cell-count HUD", {
      minWidth: 48,
      minHeight: 18,
    });
    await expect(page.locator(".pane-resize-hud")).toContainText(`${previewCells} cols`);
    const widthDuringPreview = (await sourceTile.boundingBox())!.width;
    expect(
      Math.abs(widthDuringPreview - widthBeforePreview),
      "the phase said resize-preview but the pane stayed parked until tmux replied",
    ).toBeGreaterThan(8);
    const previewLatency = await probe.previewLatencyMs();
    expect(previewLatency, "the flight recorder did not observe resize-preview").not.toBeNull();
    expect(
      previewLatency!,
      `the local resize preview took ${previewLatency}ms, so it did not track the gesture frame`,
    ).toBeLessThanOrEqual(250);
    await probe.mark("resize-preview-proven");

    await page.mouse.up();
    await expect(
      area,
      "the resize never reconciled back to idle after tmux confirmation",
    ).toHaveAttribute("data-manipulation-phase", "idle", { timeout: 30_000 });
    await expect(
      area,
      "the pane area did not retain the exact cell count tmux confirmed",
    ).toHaveAttribute("data-last-confirmed-cells", String(previewCells), { timeout: 30_000 });
    await proveGone(page.locator(".pane-resize-hud"), "the resize HUD after confirmation");
    await expect
      .poll(() => pane(tmuxPaneGeometry(liveApp.fleet, sessionName), sourcePane).width, {
        message: `the UI confirmed ${previewCells} columns but tmux settled somewhere else`,
        timeout: 30_000,
      })
      .toBe(previewCells);
    const unequal = tmuxPaneGeometry(liveApp.fleet, sessionName);
    expect(
      pane(unequal, sourcePane).width,
      "the resize left equal panes, so the swap below cannot prove which pane moved",
    ).not.toBe(pane(unequal, targetPane!).width);
    await expectSameTerminal(page, originalTerminal!, terminal, "after confirmed resize");
    await expectLiveCompositor(terminal, area, "after confirmed resize");

    // --- Drag cancel: drop affordance, Escape rollback, zero tmux mutation --
    const header = page.locator(`[data-pane-drag-handle="${sourcePane}"]`);
    await proveVisible(header, "the semantic pane-header drag handle", {
      minWidth: 30,
      minHeight: 6,
    });
    const tmuxBeforeCancel = tmuxLayoutSignature(tmuxPaneGeometry(liveApp.fleet, sessionName));
    const domBeforeCancel = await domLayout(page);
    const sourceHeaderBox = (await header.boundingBox())!;
    await page.waitForTimeout(350);
    await header.hover({
      position: { x: sourceHeaderBox.width / 2, y: sourceHeaderBox.height / 2 },
    });
    const targetBox = (await targetTile.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
      steps: 8,
    });
    await expect(
      area,
      "the header drag reached a pane but did not expose an eligible drop phase",
    ).toHaveAttribute("data-manipulation-phase", "drop-ready");
    await expect(
      targetTile,
      "the unequal pane under the pointer was not identified as the one drop target",
    ).toHaveAttribute("data-drop-target", "true");
    await expect(
      page.locator('.pane-tile[data-drop-target="true"]'),
      "a pane drag must expose exactly one drop target",
    ).toHaveCount(1);
    await proveVisible(page.locator(".pane-drop-ghost__label"), "the labelled pane drop preview", {
      minWidth: 80,
      minHeight: 18,
    });
    await expect(page.locator(".pane-drop-ghost__label")).toContainText("Swap with");
    await page.keyboard.press("Escape");
    await expect(area, "Escape did not roll the pane drag back to idle").toHaveAttribute(
      "data-manipulation-phase",
      "idle",
    );
    await page.mouse.up();
    await expect(
      page.locator('.pane-tile[data-drop-target="true"]'),
      "the cancelled pane drag left a stale drop target",
    ).toHaveCount(0);
    expect(
      tmuxLayoutSignature(tmuxPaneGeometry(liveApp.fleet, sessionName)),
      "Escape cancelled the visual drag but still mutated tmux",
    ).toBe(tmuxBeforeCancel);
    expectLayoutRestored(domBeforeCancel, await domLayout(page));
    expect(
      await probe.observedPhases(),
      "the cancel path never named its rollback phase",
    ).toContain("rollback");
    await expectSameTerminal(page, originalTerminal!, terminal, "after cancelled pane drag");
    await expectLiveCompositor(terminal, area, "after cancelled pane drag");

    // --- Drag drop: unequal semantic panes swap in tmux --------------------
    const tmuxBeforeSwap = tmuxPaneGeometry(liveApp.fleet, sessionName);
    await dragFromHeaderToTile(page, header, targetTile, "drop");
    await expect(
      area,
      "the pane swap never reconciled its confirmed layout back to idle",
    ).toHaveAttribute("data-manipulation-phase", "idle", { timeout: 30_000 });
    await expect
      .poll(
        () => {
          const after = tmuxPaneGeometry(liveApp.fleet, sessionName);
          return {
            sourceLeft: pane(after, sourcePane).left,
            sourceWidth: pane(after, sourcePane).width,
            targetLeft: pane(after, targetPane!).left,
            targetWidth: pane(after, targetPane!).width,
          };
        },
        {
          message: "dropping one semantic pane on the other never swapped tmux's own geometry",
          timeout: 30_000,
        },
      )
      .toEqual({
        sourceLeft: pane(tmuxBeforeSwap, targetPane!).left,
        sourceWidth: pane(tmuxBeforeSwap, targetPane!).width,
        targetLeft: pane(tmuxBeforeSwap, sourcePane).left,
        targetWidth: pane(tmuxBeforeSwap, sourcePane).width,
      });
    const phases = await probe.observedPhases();
    expect(phases, `the phase trace escaped its bounded vocabulary: ${phases.join(", ")}`).toEqual(
      expect.arrayContaining([
        "idle",
        "resize-preview",
        "resize-committing",
        "dragging",
        "drop-ready",
        "swap-committing",
        "rollback",
      ]),
    );
    expect(
      phases.every((phase) => (MANIPULATION_PHASES as readonly string[]).includes(phase)),
      `the surface emitted an unbounded manipulation phase: ${phases.join(", ")}`,
    ).toBe(true);
    await expect(
      page.locator('.pane-tile[data-drop-target="true"]'),
      "the completed pane swap left a stale drop target",
    ).toHaveCount(0);
    await expectSameTerminal(page, originalTerminal!, terminal, "after confirmed pane swap");
    await expectLiveCompositor(terminal, area, "after confirmed pane swap");

    // The identity assertion above proves the geometry/input attachment did
    // not remount. In a split window the visible per-pane compositor owns
    // pixels and hit testing, so exercise the pane body a user actually clicks
    // rather than reaching through it to the intentionally hidden controller.
    const visiblePane = page.locator('.pane-tile[data-composed="true"] .mirror-pane-node').first();
    await proveVisible(visiblePane, "the active composed pane after manipulation", {
      minWidth: 80,
      minHeight: 40,
      timeoutMs: 30_000,
    });
    const beforeTyping = await paintFingerprint(visiblePane);
    await visiblePane.click({ position: { x: 28, y: 24 } });
    await page.keyboard.type(`echo ${LIVE_MARKER}`);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => liveApp.fleet.captureWindowPanes(sessionName), {
        message: "the stable TerminalSurface stopped forwarding input after pane manipulation",
        timeout: 30_000,
      })
      .toContain(LIVE_MARKER);
    await proveVisible(
      visiblePane.locator(".xterm-rows > div").filter({ hasText: LIVE_MARKER }).first(),
      `the post-manipulation terminal row showing "${LIVE_MARKER}"`,
      { minWidth: 80, minHeight: 4, timeoutMs: 30_000 },
    );
    provePaintChanged(
      beforeTyping,
      await paintFingerprint(visiblePane),
      "the visible manipulated terminal",
    );
    await expectSameTerminal(page, originalTerminal!, terminal, "after post-swap terminal input");

    // --- Header double-click: tmux zoom, then exact restoration ------------
    const zoomRevision = Number(await area.getAttribute("data-layout-transition-revision"));
    await page.locator(`[data-pane-drag-handle="${sourcePane}"]`).dblclick();
    await expect(
      area,
      "double-clicking panel chrome did not zoom tmux's own window",
    ).toHaveAttribute("data-zoomed", "true", { timeout: 30_000 });
    await expect(tiles, "zoomed tmux still exposed hidden pane tiles").toHaveCount(1);
    await expect
      .poll(async () => Number(await area.getAttribute("data-layout-transition-revision")), {
        message: "the zoom layout change did not run through the FLIP transition planner",
      })
      .toBeGreaterThan(zoomRevision);
    await page.locator("[data-pane-drag-handle]").dblclick();
    await expect(
      area,
      "double-clicking zoomed panel chrome did not restore the layout",
    ).toHaveAttribute("data-zoomed", "false", { timeout: 30_000 });
    await expect(tiles, "unzoom did not restore both semantic panes").toHaveCount(2);

    // --- Close: immediate ending feedback, then a confirmed exit FLIP -----
    const closeRevision = Number(await area.getAttribute("data-layout-transition-revision"));
    const close = page.locator(`[data-pane-close="${targetPane!}"]`);
    await close.click();
    await close.click();
    await expect(
      targetTile,
      "confirmed close did not mark the panel as ending before tmux replied",
    ).toHaveAttribute("data-ending", "true");
    await expect(
      tiles,
      "closing one split pane did not reconcile to one remaining pane",
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(area).toHaveAttribute("data-last-layout-transition", /^(?:exit|mixed)$/u);
    await expect
      .poll(async () => Number(await area.getAttribute("data-layout-transition-revision")), {
        message: "the pane close did not register a confirmed exit transition",
      })
      .toBeGreaterThan(closeRevision);

    await page.screenshot({ path: testInfo.outputPath("pane-manipulation-complete.png") });
    await probe.attachArtifact({ fleet: liveApp.fleet, sessionName, testInfo });
  } catch (error) {
    await probe.attachArtifact({
      fleet: liveApp.fleet,
      sessionName,
      testInfo,
      failure: error,
    });
    throw new Error(
      `pane manipulation failed — see pane-manipulation-phases.json for the last named phase\n` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
});
