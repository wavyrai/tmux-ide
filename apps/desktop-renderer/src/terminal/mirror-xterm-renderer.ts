import { Terminal } from "@xterm/xterm";
import type { TerminalAttachmentViewport } from "@tmux-ide/contracts";

import type { PaneMirrorSeedBatch } from "./pane-stream-transport.ts";
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

export type MirrorTerminalRendererFactory = (options: {
  readonly reducedMotion: boolean;
  readonly label: string;
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
}) => {
  let container: HTMLElement | null = null;
  let fitStyle: RuntimeStyleBinding | null = null;
  let appliedScale = 1;
  const encoder = new TextEncoder();
  const terminal = new Terminal({
    allowProposedApi: false,
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
   * cell metrics the stream's grid is measured in. The scale is written through
   * the runtime stylesheet because `style-src 'self'` forbids style attributes.
   */
  const applyFit = (): void => {
    const element = terminal.element;
    if (!container || !element) return;
    // The grid's true size lives on the screen layer; `.xterm` itself stretches
    // to the container and would measure as already-fitting. offsetWidth/Height
    // are pre-transform, so measuring stays idempotent across repeated fits.
    const screen = element.querySelector<HTMLElement>(".xterm-screen") ?? element;
    const scale = mirrorFitScale(
      { width: screen.offsetWidth, height: screen.offsetHeight },
      { width: container.clientWidth, height: container.clientHeight },
    );
    if (scale === appliedScale && fitStyle) return;
    appliedScale = scale;
    fitStyle ??= createRuntimeStyleBinding(element);
    fitStyle.update({ transform: `scale(${scale})`, "transform-origin": "center center" });
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
    dispose() {
      container = null;
      fitStyle?.dispose();
      fitStyle = null;
      appliedScale = 1;
      terminal.dispose();
    },
  };
};
