import { Terminal } from "@xterm/xterm";
import type { TerminalAttachmentViewport } from "@tmux-ide/contracts";

import type { PaneMirrorSeedBatch } from "./pane-stream-transport.ts";
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
  setReducedMotion(reducedMotion: boolean): void;
  dispose(): void;
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

  return {
    open(nextContainer) {
      container = nextContainer;
      applyTheme();
      terminal.open(nextContainer);
      terminal.textarea?.setAttribute("aria-label", label);
      terminal.textarea?.setAttribute("readonly", "true");
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
      }
    },
    refreshTheme() {
      applyTheme();
    },
    setReducedMotion() {
      // Mirror cursors never blink; reduced motion changes nothing here.
    },
    dispose() {
      container = null;
      terminal.dispose();
    },
  };
};
