/**
 * Visual truth: the only assertions this suite is allowed to make about a
 * feature being present.
 *
 * Playwright's own `toBeVisible()` is a necessary but insufficient check — it
 * proves a non-empty box and a non-`hidden` style, and stops there. It passes
 * for an element scrolled a thousand pixels off screen, for a panel rendered
 * behind an opaque modal, and for a terminal that has laid out but painted
 * nothing. Those are three real product bugs, so this module proves the three
 * things separately and reports which one failed.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

export interface VisibleProof {
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** How the centre hit test resolved: on the element, inside it, or on its own widget. */
  readonly hit: "self" | "descendant" | "ancestor";
  /** The tag/class of whatever the browser found on top at the centre point. */
  readonly hitDescription: string;
}

export interface ProveVisibleOptions {
  /** Reject boxes thinner than this. A 1px sliver is a layout bug, not a feature. */
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly timeoutMs?: number;
  /**
   * How long to keep re-measuring before reporting a geometry failure.
   *
   * Measurement is a two-step conversation with a live page, and some surfaces
   * re-mount between the steps — the mirror node list rebuilds its DOM on each
   * stream update — which detaches the handle mid-measurement and yields a null
   * box. Re-measuring removes that race without weakening anything: a genuinely
   * collapsed or covered element fails every attempt and still fails here.
   */
  readonly settleMs?: number;
}

interface CentreHit {
  readonly relation: "self" | "descendant" | "ancestor" | "foreign" | "none";
  readonly description: string;
}

/**
 * Assert that a user can actually see `locator`, and say what is wrong if not.
 *
 * `what` names the thing in product terms; it is the subject of every failure
 * message, so it should read like the bug report the failure represents.
 */
export async function proveVisible(
  locator: Locator,
  what: string,
  options: ProveVisibleOptions = {},
): Promise<VisibleProof> {
  // Bug this catches: the element never renders at all, or renders and is then
  // removed by a store that treats a refresh as a teardown.
  await expect(locator, `${what} never became visible to the user`).toBeVisible({
    timeout: options.timeoutMs ?? 15_000,
  });

  const deadline = Date.now() + (options.settleMs ?? 5_000);
  for (;;) {
    try {
      return await measureVisible(locator, what, options);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((done) => setTimeout(done, 150));
    }
  }
}

/** One measurement pass. Every assertion in here is the real, strict one. */
async function measureVisible(
  locator: Locator,
  what: string,
  options: ProveVisibleOptions,
): Promise<VisibleProof> {
  const minWidth = options.minWidth ?? 8;
  const minHeight = options.minHeight ?? 8;

  // Bug this catches: the element renders but collapses — a flex child with no
  // basis, a grid row of 0fr, a panel clipped by an ancestor's overflow.
  const rect = await locator.boundingBox();
  expect(rect, `${what} has no bounding box, so nothing of it is on screen`).not.toBeNull();
  expect(
    rect!.width,
    `${what} is ${rect!.width}px wide — it laid out collapsed, so the user sees nothing`,
  ).toBeGreaterThanOrEqual(minWidth);
  expect(
    rect!.height,
    `${what} is ${rect!.height}px tall — it laid out collapsed, so the user sees nothing`,
  ).toBeGreaterThanOrEqual(minHeight);

  // Bug this catches: the element is positioned outside the window — a stale
  // canvas transform, an overlay anchored to a coordinate space it does not
  // live in, a sidebar translated away by a collapse animation that never ran.
  const viewport = locator.page().viewportSize();
  expect(
    viewport,
    "the browser has no viewport size, so nothing can be proven visible",
  ).not.toBeNull();
  const centre = { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 };
  expect(
    centre.x >= 0 && centre.x <= viewport!.width && centre.y >= 0 && centre.y <= viewport!.height,
    `${what} has its centre at (${Math.round(centre.x)}, ${Math.round(centre.y)}), outside the ` +
      `${viewport!.width}x${viewport!.height} window — it is laid out off screen`,
  ).toBe(true);

  // Bug this catches: something opaque sits on top — a modal that was never
  // dismissed, a loading veil that outlived its load, a z-index accident.
  const hit = await locator.evaluate((element): CentreHit => {
    const box = element.getBoundingClientRect();
    const found = element.ownerDocument.elementFromPoint(
      box.x + box.width / 2,
      box.y + box.height / 2,
    );
    const describe = (node: Element | null): string =>
      node === null
        ? "nothing"
        : `${node.tagName.toLowerCase()}${node.className && typeof node.className === "string" ? `.${node.className.trim().split(/\s+/u).join(".")}` : ""}`;
    if (found === null) return { relation: "none", description: "nothing" };
    if (found === element) return { relation: "self", description: describe(found) };
    if (element.contains(found)) return { relation: "descendant", description: describe(found) };
    if (found.contains(element)) return { relation: "ancestor", description: describe(found) };
    return { relation: "foreign", description: describe(found) };
  });
  expect(
    hit.relation === "self" || hit.relation === "descendant" || hit.relation === "ancestor",
    `${what} is covered at its centre by ${hit.description}, which is not part of it — the user ` +
      `cannot see or click it`,
  ).toBe(true);

  return { rect: rect!, hit: hit.relation as VisibleProof["hit"], hitDescription: hit.description };
}

/**
 * Assert that a thing the user destroyed is really gone from the screen — not
 * merely detached while its pixels linger in a stale layer.
 */
export async function proveGone(locator: Locator, what: string, timeoutMs = 20_000): Promise<void> {
  await expect(locator, `${what} is still on screen after it was destroyed`).toBeHidden({
    timeout: timeoutMs,
  });
}

/**
 * Assert that EVERY instance of something is gone — the plural of
 * {@link proveGone}, for surfaces the app renders more than one of.
 */
export async function proveAllGone(
  locator: Locator,
  what: string,
  timeoutMs = 45_000,
): Promise<void> {
  await expect(
    locator,
    `${what}: instances of it are still on screen after the thing behind them was destroyed`,
  ).toHaveCount(0, { timeout: timeoutMs });
}

export interface PaintFingerprint {
  readonly hash: string;
  /** PNG byte length. A uniformly blank region compresses to almost nothing. */
  readonly bytes: number;
}

/**
 * Fingerprint the PIXELS of a region. This is the only way to tell a terminal
 * that painted real bytes from one that laid out a correctly sized empty box.
 */
export async function paintFingerprint(locator: Locator): Promise<PaintFingerprint> {
  const buffer = await locator.screenshot({ animations: "disabled" });
  return { hash: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.byteLength };
}

/**
 * Assert that a region's pixels changed between two fingerprints.
 *
 * Bug this catches: input reaches the daemon and the pane advances, but the
 * renderer never repaints — the classic "the terminal is frozen but the data is
 * fine" report, which every DOM-level assertion passes straight through.
 */
export function provePaintChanged(
  before: PaintFingerprint,
  after: PaintFingerprint,
  what: string,
): void {
  expect(
    after.hash,
    `${what} painted identical pixels before and after the interaction (${after.bytes} bytes both ` +
      `times) — the surface is not repainting`,
  ).not.toBe(before.hash);
}

/** Save a screenshot into the run's artifact directory and return its path. */
export async function captureArtifact(
  page: Page,
  directory: string,
  name: string,
): Promise<string> {
  const path = `${directory}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  return path;
}
