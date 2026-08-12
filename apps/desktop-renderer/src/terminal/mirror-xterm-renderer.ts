import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { TerminalAttachmentViewport } from "@tmux-ide/contracts";

import type { PaneMirrorSeedBatch } from "./pane-stream-transport.ts";
import type { WidgetCellRow } from "@tmux-ide/contracts";
import { readWidgetCellRows } from "./widgets/xterm-cell-rows.ts";
import { gridOverlayBox, type GridOverlayBox } from "../experience/grid-overlay.ts";
import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME_FALLBACK,
  resolveTerminalFontFamily,
  resolveTerminalTheme,
} from "./xterm-renderer.ts";
import type {
  GuiPerformanceRenderChannel,
  GuiPerformanceTelemetrySink,
} from "../runtime/gui-performance-telemetry.ts";

/**
 * Read-only VT mirror renderer for pane nodes (m43 card 3). It differs from
 * the interactive renderer in exactly two contract points:
 *  - stdin is disabled — a mirror node NEVER authors bytes or size votes;
 *  - it can apply an atomic reseed: reset the emulator, then paint ONE capture
 *    plus its held deltas and cursor as a single commit (the addendum rule —
 *    reseed REPLACES emulator state, never appends onto retained state).
 */
export interface MirrorTerminalRenderer {
  open(container: HTMLElement): void;
  /** ONE atomic paint: reset → grid → seed → held deltas → cursor. */
  applySeedBatch(batch: PaneMirrorSeedBatch): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  applyCursor(x: number, y: number): void;
  resizeGrid(viewport: TerminalAttachmentViewport): void;
  refreshTheme(): void;
  /**
   * Letterbox the RENDER into the container without touching the grid. The
   * mirror is size-passive — the grid belongs to the stream's reset dimensions
   * — so a grid wider than the card is scaled down, never clipped or resized.
   */
  fitToContainer(): void;
  setReducedMotion(reducedMotion: boolean): void;
  /** The text currently selected in this visible, read-only pane renderer. */
  getSelection(): string;
  /**
   * Observe xterm's selection rather than DOM Selection: xterm paints its own
   * selection layer, so `window.getSelection()` cannot see terminal text.
   */
  onSelectionChange(listener: (selection: string) => void): { dispose(): void };
  /** The most recent `maxRows` grid rows, as cells — see the interactive twin. */
  readCellRows(maxRows: number): WidgetCellRow[];
  /**
   * Where the letterboxed grid sits inside the card, and at what scale (m49.7).
   *
   * Anything painted over a mirror pane positions itself from THIS, never from
   * the container's own box: the render is scaled down to fit, so container
   * pixels and grid pixels are the same thing only at scale 1.
   */
  gridOverlayGeometry(): { box: GridOverlayBox; scale: number } | null;
  performanceChannel?(): GuiPerformanceRenderChannel | null;
  dispose(): void;
}

/**
 * PURE — the uniform scale that letterboxes `natural` into `container`.
 *
 * Only ever shrinks: a grid smaller than its card is centered at 1:1 rather
 * than blown up, because upscaled cell text reads as blur, not as detail.
 * Degenerate measurements (a container not laid out yet, a terminal with no
 * element) return 1 so the render is left exactly as the emulator drew it.
 */
export function mirrorFitScale(
  natural: { readonly width: number; readonly height: number },
  container: { readonly width: number; readonly height: number },
): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  if (container.width <= 0 || container.height <= 0) return 1;
  return Math.min(1, container.width / natural.width, container.height / natural.height);
}

/**
 * PURE — the full fit transform: the scale AND where the scaled grid lands.
 *
 * `transform-origin: center center` was wrong, and wrong in a way that only
 * appears once the grid outgrows its card. The emulator's element is sized by
 * its GRID, not by the card — a 157x36 window lays out about 1134x503px inside
 * a 318x176 card — so the box the origin is taken from is the overflowing one,
 * and scaling about its centre parks the render around a point far outside the
 * card. Measured: the card sat at y=657 with the terminal it contains rendered
 * at y=838, entirely below it and below the window; xterm pauses rendering for
 * an element outside the viewport, so the mirror painted its seed and then
 * silently stopped following the pane it was mirroring.
 *
 * So the origin is the element's top-left — a point that does not move with the
 * overflow — and the centring is an explicit translation into the card. That is
 * also the placement {@link gridOverlayBox} already assumes, so the pixels and
 * the overlay model now describe the same thing.
 *
 * `offset` is where the grid layer sits inside the transformed element (0,0 in
 * practice); it is carried so the translation stays correct if xterm ever puts
 * chrome above the screen.
 */
export function mirrorFitTransform(
  natural: { readonly width: number; readonly height: number },
  container: { readonly width: number; readonly height: number },
  offset: { readonly left: number; readonly top: number } = { left: 0, top: 0 },
): { scale: number; translateX: number; translateY: number } {
  const scale = mirrorFitScale(natural, container);
  const width = Math.min(container.width, natural.width * scale);
  const height = Math.min(container.height, natural.height * scale);
  const translateX = (container.width - width) / 2 - offset.left * scale;
  const translateY = (container.height - height) / 2 - offset.top * scale;
  return {
    scale,
    translateX: Number.isFinite(translateX) ? translateX : 0,
    translateY: Number.isFinite(translateY) ? translateY : 0,
  };
}

export type MirrorTerminalRendererFactory = (options: {
  readonly reducedMotion: boolean;
  readonly label: string;
  readonly performanceTelemetry?: GuiPerformanceTelemetrySink | null;
}) => MirrorTerminalRenderer;

/** 1-based ANSI cursor-position sequence from the wire's 0-based cell coordinates. */
export function cursorPositionSequence(x: number, y: number): string {
  const column = Math.max(0, Math.floor(x)) + 1;
  const row = Math.max(0, Math.floor(y)) + 1;
  return `\u001b[${row};${column}H`;
}

export const createMirrorXtermRenderer: MirrorTerminalRendererFactory = ({
  reducedMotion,
  label,
  performanceTelemetry,
}) => {
  let container: HTMLElement | null = null;
  let fitStyle: RuntimeStyleBinding | null = null;
  let appliedScale = 1;
  let appliedTransform: string | null = null;
  const encoder = new TextEncoder();
  const terminal = new Terminal({
    // Required by the official Unicode 11 width addon; see xterm-renderer.ts.
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: false,
    cursorStyle: "block",
    disableStdin: true,
    drawBoldTextInBrightColors: false,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    minimumContrastRatio: 1,
    screenReaderMode: true,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    tabStopWidth: 4,
    theme: TERMINAL_THEME_FALLBACK,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  let disposed = false;
  let performanceChannel = performanceTelemetry?.createRenderChannel() ?? null;
  const currentPerformanceChannel = (): GuiPerformanceRenderChannel | null => {
    if (disposed || !performanceTelemetry || !performanceChannel) return null;
    if (!performanceTelemetry.enabled) return performanceChannel;
    performanceChannel = performanceTelemetry.refreshRenderChannel(performanceChannel);
    return performanceChannel;
  };
  terminal.onRender(({ start, end }) => {
    if (disposed) return;
    performanceTelemetry?.recordRendered(currentPerformanceChannel(), end - start + 1);
  });
  void reducedMotion;

  const applyTheme = (): void => {
    if (!container) return;
    const style = getComputedStyle(container);
    terminal.options.fontFamily = resolveTerminalFontFamily(style);
    terminal.options.theme = resolveTerminalTheme(style);
  };

  const write = (data: Uint8Array | string): Promise<void> =>
    new Promise<void>((resolve) => terminal.write(data, resolve));

  /**
   * A CSS transform is the whole fit seam: it costs one composited layer, needs
   * no reflow of the emulator, and — unlike a font-size fit — cannot perturb the
   * cell metrics the stream's grid is measured in. The transform is written
   * through the runtime stylesheet because `style-src 'self'` forbids style
   * attributes.
   *
   * See {@link mirrorFitTransform} for why the origin is the top-left and the
   * centring is explicit.
   */
  const applyFit = (): void => {
    const element = terminal.element;
    if (!container || !element) return;
    // The grid's true size lives on the screen layer. offsetWidth/Height are
    // pre-transform, so measuring stays idempotent across repeated fits.
    const screen = element.querySelector<HTMLElement>(".xterm-screen") ?? element;
    const fit = mirrorFitTransform(
      { width: screen.offsetWidth, height: screen.offsetHeight },
      { width: container.clientWidth, height: container.clientHeight },
      { left: screen.offsetLeft, top: screen.offsetTop },
    );
    const transform =
      `translate(${fit.translateX}px, ${fit.translateY}px) scale(${fit.scale})` as const;
    if (transform === appliedTransform && fitStyle) return;
    appliedTransform = transform;
    appliedScale = fit.scale;
    fitStyle ??= createRuntimeStyleBinding(element);
    fitStyle.update({ transform, "transform-origin": "top left" });
  };

  return {
    open(nextContainer) {
      container = nextContainer;
      applyTheme();
      terminal.open(nextContainer);
      terminal.textarea?.setAttribute("aria-label", label);
      terminal.textarea?.setAttribute("readonly", "true");
      applyFit();
    },
    async applySeedBatch(batch) {
      // Reset FIRST: the previous screen is a different instant and may not be
      // composited with this capture. All parts are enqueued back-to-back in
      // one synchronous pass, so the emulator commits them as one paint.
      terminal.reset();
      if (batch.reset) {
        if (
          batch.reset.cols >= 1 &&
          batch.reset.rows >= 1 &&
          (batch.reset.cols !== terminal.cols || batch.reset.rows !== terminal.rows)
        ) {
          terminal.resize(batch.reset.cols, batch.reset.rows);
        }
      }
      const writes: Promise<void>[] = [];
      if (batch.seed.byteLength > 0) writes.push(write(batch.seed));
      for (const held of batch.held) {
        if (held.byteLength > 0) writes.push(write(held));
      }
      if (batch.cursor) {
        writes.push(write(encoder.encode(cursorPositionSequence(batch.cursor.x, batch.cursor.y))));
      }
      await Promise.all(writes);
      // A reseed is the only event that can change the grid, so it is the only
      // one that can change the fit.
      applyFit();
    },
    write(bytes) {
      return write(bytes);
    },
    applyCursor(x, y) {
      void write(encoder.encode(cursorPositionSequence(x, y)));
    },
    resizeGrid(viewport) {
      if (viewport.cols < 1 || viewport.rows < 1) return;
      if (viewport.cols !== terminal.cols || viewport.rows !== terminal.rows) {
        terminal.resize(viewport.cols, viewport.rows);
        applyFit();
      }
    },
    refreshTheme() {
      applyTheme();
    },
    fitToContainer() {
      applyFit();
    },
    setReducedMotion() {
      // Mirror cursors never blink; reduced motion changes nothing here.
    },
    getSelection() {
      return terminal.getSelection();
    },
    onSelectionChange(listener) {
      return terminal.onSelectionChange(() => listener(terminal.getSelection()));
    },
    readCellRows(maxRows) {
      return readWidgetCellRows(terminal, maxRows);
    },
    gridOverlayGeometry() {
      const element = terminal.element;
      if (!container || !element) return null;
      const screen = element.querySelector<HTMLElement>(".xterm-screen") ?? element;
      return {
        // The SAME scale the render was committed at, not a fresh derivation:
        // recomputing here is a second chance to disagree with the pixels.
        box: gridOverlayBox(
          { width: screen.offsetWidth, height: screen.offsetHeight },
          { width: container.clientWidth, height: container.clientHeight },
          appliedScale,
        ),
        scale: appliedScale,
      };
    },
    performanceChannel() {
      return currentPerformanceChannel();
    },
    dispose() {
      disposed = true;
      if (performanceChannel) performanceTelemetry?.retireRenderChannel(performanceChannel);
      performanceChannel = null;
      container = null;
      fitStyle?.dispose();
      fitStyle = null;
      appliedScale = 1;
      appliedTransform = null;
      terminal.dispose();
    },
  };
};
