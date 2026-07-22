import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalAttachmentViewport } from "@tmux-ide/contracts";

export interface TerminalRendererDisposable {
  dispose(): void;
}

export interface TerminalRenderer {
  open(container: HTMLElement): void;
  write(bytes: Uint8Array): Promise<void>;
  focus(): void;
  fit(): TerminalAttachmentViewport | null;
  refreshTheme(): void;
  setReducedMotion(reducedMotion: boolean): void;
  onInput(listener: (bytes: Uint8Array) => void): TerminalRendererDisposable;
  dispose(): void;
}

export type TerminalRendererFactory = (options: {
  readonly reducedMotion: boolean;
  readonly label: string;
}) => TerminalRenderer;

function color(style: CSSStyleDeclaration, property: string, fallback: string): string {
  return style.getPropertyValue(property).trim() || fallback;
}

/** xterm is a VT renderer only here; the desktop host remains the terminal runtime. */
export const createXtermRenderer: TerminalRendererFactory = ({ reducedMotion, label }) => {
  let container: HTMLElement | null = null;
  let fitAddon: FitAddon | null = null;
  const encoder = new TextEncoder();
  const terminal = new Terminal({
    allowProposedApi: false,
    convertEol: false,
    cursorBlink: !reducedMotion,
    cursorStyle: "block",
    drawBoldTextInBrightColors: false,
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    minimumContrastRatio: 4.5,
    rightClickSelectsWord: true,
    screenReaderMode: true,
    scrollback: 10_000,
    tabStopWidth: 4,
  });

  const applyTheme = (): void => {
    if (!container) return;
    const style = getComputedStyle(container);
    terminal.options.fontFamily = style.fontFamily || "monospace";
    terminal.options.theme = {
      background: color(style, "--tmux-ide-surface-terminal", "#11121a"),
      foreground: color(style, "--tmux-ide-text-primary", "#f2f3f7"),
      cursor: color(style, "--tmux-ide-text-bright", "#ffffff"),
      cursorAccent: color(style, "--tmux-ide-surface-terminal", "#11121a"),
      selectionBackground: color(style, "--tmux-ide-selection-selection", "#293149"),
    };
  };

  return {
    open(nextContainer) {
      container = nextContainer;
      applyTheme();
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(nextContainer);
      terminal.textarea?.setAttribute("aria-label", label);
    },
    write(bytes) {
      return new Promise<void>((resolve) => terminal.write(bytes, resolve));
    },
    focus() {
      terminal.focus();
    },
    fit() {
      if (!container || !fitAddon || container.clientWidth <= 0 || container.clientHeight <= 0) {
        return null;
      }
      try {
        const dimensions = fitAddon.proposeDimensions();
        if (!dimensions || dimensions.cols < 1 || dimensions.rows < 1) return null;
        if (dimensions.cols !== terminal.cols || dimensions.rows !== terminal.rows) {
          terminal.resize(dimensions.cols, dimensions.rows);
        }
        return { cols: dimensions.cols, rows: dimensions.rows };
      } catch {
        return null;
      }
    },
    refreshTheme() {
      applyTheme();
    },
    setReducedMotion(nextReducedMotion) {
      terminal.options.cursorBlink = !nextReducedMotion;
    },
    onInput(listener) {
      return terminal.onData((data) => listener(encoder.encode(data)));
    },
    dispose() {
      container = null;
      fitAddon = null;
      terminal.dispose();
    },
  };
};
