import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { TerminalAttachmentViewport } from "@tmux-ide/contracts";

export interface TerminalRendererDisposable {
  dispose(): void;
}

export interface TerminalRenderer {
  open(container: HTMLElement): void;
  write(bytes: Uint8Array): Promise<void>;
  focus(): void;
  fit(): TerminalAttachmentViewport | null;
  /**
   * Resize the local grid to an explicit window-level viewport WITHOUT measuring
   * the DOM. Size-passive cards (m41 attach-5) render the origin window's own
   * grid — reported by the transport — and letterbox the remainder, so the
   * renderer must be sized from that grid rather than fit to the card.
   */
  resizeGrid(viewport: TerminalAttachmentViewport): void;
  refreshTheme(): void;
  setReducedMotion(reducedMotion: boolean): void;
  onInput(listener: (bytes: Uint8Array) => void): TerminalRendererDisposable;
  dispose(): void;
}

export type TerminalRendererFactory = (options: {
  readonly reducedMotion: boolean;
  readonly label: string;
}) => TerminalRenderer;

/**
 * A monospace cascade with good coverage on macOS (SF Mono / Menlo) and Linux
 * (JetBrains Mono / DejaVu / Liberation) plus a Windows fallback. The terminal
 * never inherits the chrome's proportional UI font — a non-monospace family
 * breaks xterm's cell grid — so this is applied explicitly rather than read from
 * the container's computed `font-family`.
 */
export const TERMINAL_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", "JetBrains Mono", "Cascadia Code", "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace';

/**
 * Full-screen TUIs (the whole point of this app) draw box characters that must
 * tile with zero vertical gap; a padded line height leaves seams between rows,
 * so cells are exactly one glyph tall.
 */
export const TERMINAL_LINE_HEIGHT = 1;
export const TERMINAL_FONT_SIZE = 12;
export const TERMINAL_SCROLLBACK_LINES = 10_000;

const TERMINAL_FONT_FAMILY_TOKEN = "--tmux-ide-terminal-font-family";

/** The complete set of xterm theme roles this renderer drives from CSS tokens. */
export const TERMINAL_THEME_TOKEN = {
  background: "--tmux-ide-terminal-background",
  foreground: "--tmux-ide-terminal-foreground",
  cursor: "--tmux-ide-terminal-cursor",
  cursorAccent: "--tmux-ide-terminal-cursor-accent",
  selectionBackground: "--tmux-ide-terminal-selection",
  black: "--tmux-ide-terminal-ansi-black",
  red: "--tmux-ide-terminal-ansi-red",
  green: "--tmux-ide-terminal-ansi-green",
  yellow: "--tmux-ide-terminal-ansi-yellow",
  blue: "--tmux-ide-terminal-ansi-blue",
  magenta: "--tmux-ide-terminal-ansi-magenta",
  cyan: "--tmux-ide-terminal-ansi-cyan",
  white: "--tmux-ide-terminal-ansi-white",
  brightBlack: "--tmux-ide-terminal-ansi-bright-black",
  brightRed: "--tmux-ide-terminal-ansi-bright-red",
  brightGreen: "--tmux-ide-terminal-ansi-bright-green",
  brightYellow: "--tmux-ide-terminal-ansi-bright-yellow",
  brightBlue: "--tmux-ide-terminal-ansi-bright-blue",
  brightMagenta: "--tmux-ide-terminal-ansi-bright-magenta",
  brightCyan: "--tmux-ide-terminal-ansi-bright-cyan",
  brightWhite: "--tmux-ide-terminal-ansi-bright-white",
} as const satisfies Record<string, `--tmux-ide-terminal-${string}`>;

type TerminalThemeRole = keyof typeof TERMINAL_THEME_TOKEN;

/**
 * styles.css is the source of truth for terminal colors, keyed on the app theme
 * so the palette follows light/dark live. These dark-first fallbacks only take
 * effect in isolated fixtures rendered without the app token cascade — the same
 * convention ui-system.css uses for its primitive fallbacks.
 */
export const TERMINAL_THEME_FALLBACK: Readonly<Record<TerminalThemeRole, string>> = Object.freeze({
  background: "#12131a",
  foreground: "#e6e8f2",
  cursor: "#c7d4ff",
  cursorAccent: "#12131a",
  selectionBackground: "#33406b",
  black: "#2a2c37",
  red: "#f0748c",
  green: "#7fd88f",
  yellow: "#e6c67a",
  blue: "#8bb4ff",
  magenta: "#cba6f7",
  cyan: "#7fd4d8",
  white: "#cdd0da",
  brightBlack: "#5c6072",
  brightRed: "#ff92a6",
  brightGreen: "#9ce8a8",
  brightYellow: "#f4d99a",
  brightBlue: "#aecbff",
  brightMagenta: "#ddc4ff",
  brightCyan: "#a3e8ec",
  brightWhite: "#f6f8fc",
});

export type TerminalTokenReader = Pick<CSSStyleDeclaration, "getPropertyValue">;

function readToken(reader: TerminalTokenReader, name: string, fallback: string): string {
  return reader.getPropertyValue(name).trim() || fallback;
}

/** Projects the app's CSS terminal tokens into a complete xterm theme. */
export function resolveTerminalTheme(reader: TerminalTokenReader): ITheme {
  const theme: Record<TerminalThemeRole, string> = { ...TERMINAL_THEME_FALLBACK };
  for (const role of Object.keys(TERMINAL_THEME_TOKEN) as TerminalThemeRole[]) {
    theme[role] = readToken(reader, TERMINAL_THEME_TOKEN[role], TERMINAL_THEME_FALLBACK[role]);
  }
  return theme;
}

export function resolveTerminalFontFamily(reader: TerminalTokenReader): string {
  return readToken(reader, TERMINAL_FONT_FAMILY_TOKEN, TERMINAL_FONT_FAMILY);
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
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: TERMINAL_FONT_SIZE,
    lineHeight: TERMINAL_LINE_HEIGHT,
    minimumContrastRatio: 1,
    rightClickSelectsWord: true,
    screenReaderMode: true,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    tabStopWidth: 4,
    theme: TERMINAL_THEME_FALLBACK,
  });

  const applyTheme = (): void => {
    if (!container) return;
    const style = getComputedStyle(container);
    terminal.options.fontFamily = resolveTerminalFontFamily(style);
    terminal.options.theme = resolveTerminalTheme(style);
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
    resizeGrid(viewport) {
      if (viewport.cols < 1 || viewport.rows < 1) return;
      if (viewport.cols !== terminal.cols || viewport.rows !== terminal.rows) {
        terminal.resize(viewport.cols, viewport.rows);
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
