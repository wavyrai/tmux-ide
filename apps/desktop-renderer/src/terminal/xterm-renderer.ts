import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal, type IBufferCell, type ITheme } from "@xterm/xterm";
import type { TerminalAttachmentViewport } from "@tmux-ide/contracts";
import { XTERM_PALETTE_HEX } from "@tmux-ide/core";

import type { WidgetCellRow } from "@tmux-ide/contracts";
import { readWidgetCellRows } from "./widgets/xterm-cell-rows.ts";
import type {
  GuiPerformanceRenderChannel,
  GuiPerformanceTelemetrySink,
} from "../runtime/gui-performance-telemetry.ts";

export interface TerminalRendererDisposable {
  dispose(): void;
}

export interface TerminalRenderer {
  open(container: HTMLElement): void;
  write(bytes: Uint8Array): Promise<void>;
  focus(): void;
  /** Measure the DOM-backed grid proposal without mutating the accepted terminal grid. */
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
  /**
   * The most recent `maxRows` grid rows, as cells (m49.7).
   *
   * Widget detection has to read the grid AFTER the emulator has parsed it —
   * cells are the only place a wrapped, multi-code-unit line exists correctly —
   * so the renderer is the only thing that can answer this.
   */
  readCellRows(maxRows: number): WidgetCellRow[];
  /** Bounded state from this exact xterm instance; no second parser or raw grid. */
  readPresentation?(): Readonly<{
    activeBuffer: "normal" | "alternate";
    cursorX: number;
    cursorY: number;
    cursorHidden: boolean;
    cursorStyle: "block" | "underline" | "bar";
    cursorBlink: boolean;
  }>;
  /** Explicit detailed-only probe; raw cells never leave this renderer. */
  probeRendition?(keyHex: string): Promise<Readonly<{
    renditionHmac: string;
    positionWrappedHmac: string;
    graphemeWidthHmac: string;
    colorHmac: string;
    attributesHmac: string;
    cellHmacs: readonly string[] | null;
    defaultForeground: string;
    defaultBackground: string;
    rendererCols: number;
    rendererRows: number;
    renditionCellCount: number;
    wideContinuationCount: number;
    combiningCount: number;
    styledCellCount: number;
  }> | null>;
  performanceChannel?(): GuiPerformanceRenderChannel | null;
  dispose(): void;
}

export type TerminalRendererFactory = (options: {
  readonly reducedMotion: boolean;
  readonly label: string;
  readonly performanceTelemetry?: GuiPerformanceTelemetrySink | null;
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
} as const satisfies Record<string, `--tmux-ide-terminal-${string}`>;

type TerminalThemeRole = keyof typeof TERMINAL_THEME_TOKEN;

/**
 * styles.css is the source of truth for terminal colors, keyed on the app theme
 * so the palette follows light/dark live. These dark-first fallbacks only take
 * effect in isolated fixtures rendered without the app token cascade — the same
 * convention ui-system.css uses for its primitive fallbacks.
 */
export const TERMINAL_THEME_FALLBACK: Readonly<ITheme> = Object.freeze({
  background: "#12131a",
  foreground: "#e6e8f2",
  cursor: "#c7d4ff",
  cursorAccent: "#12131a",
  selectionBackground: "#33406b",
  black: XTERM_PALETTE_HEX[0],
  red: XTERM_PALETTE_HEX[1],
  green: XTERM_PALETTE_HEX[2],
  yellow: XTERM_PALETTE_HEX[3],
  blue: XTERM_PALETTE_HEX[4],
  magenta: XTERM_PALETTE_HEX[5],
  cyan: XTERM_PALETTE_HEX[6],
  white: XTERM_PALETTE_HEX[7],
  brightBlack: XTERM_PALETTE_HEX[8],
  brightRed: XTERM_PALETTE_HEX[9],
  brightGreen: XTERM_PALETTE_HEX[10],
  brightYellow: XTERM_PALETTE_HEX[11],
  brightBlue: XTERM_PALETTE_HEX[12],
  brightMagenta: XTERM_PALETTE_HEX[13],
  brightCyan: XTERM_PALETTE_HEX[14],
  brightWhite: XTERM_PALETTE_HEX[15],
  extendedAnsi: XTERM_PALETTE_HEX.slice(16),
});

export type TerminalTokenReader = Pick<CSSStyleDeclaration, "getPropertyValue">;

function readToken(reader: TerminalTokenReader, name: string, fallback: string): string {
  return reader.getPropertyValue(name).trim() || fallback;
}

/** Projects the app's CSS terminal tokens into a complete xterm theme. */
export function resolveTerminalTheme(reader: TerminalTokenReader): ITheme {
  const theme: ITheme = { ...TERMINAL_THEME_FALLBACK };
  for (const role of Object.keys(TERMINAL_THEME_TOKEN) as TerminalThemeRole[]) {
    theme[role] = readToken(reader, TERMINAL_THEME_TOKEN[role], TERMINAL_THEME_FALLBACK[role]!);
  }
  return theme;
}

export function resolveTerminalFontFamily(reader: TerminalTokenReader): string {
  return readToken(reader, TERMINAL_FONT_FAMILY_TOKEN, TERMINAL_FONT_FAMILY);
}

/** xterm is a VT renderer only here; the desktop host remains the terminal runtime. */
export const createXtermRenderer: TerminalRendererFactory = ({
  reducedMotion,
  label,
  performanceTelemetry,
}) => {
  let container: HTMLElement | null = null;
  let fitAddon: FitAddon | null = null;
  const encoder = new TextEncoder();
  const terminal = new Terminal({
    // Required by the official Unicode 11 width addon. tmux-ide uses the
    // proposed surface only during local renderer construction; none of it is
    // exposed across the daemon/client contract.
    allowProposedApi: true,
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
    readCellRows(maxRows) {
      return readWidgetCellRows(terminal, maxRows);
    },
    readPresentation() {
      const service = (
        terminal as unknown as {
          _core?: {
            coreService?: {
              isCursorHidden?: boolean;
              decPrivateModes?: {
                cursorStyle?: "block" | "underline" | "bar";
                cursorBlink?: boolean;
              };
            };
          };
        }
      )._core?.coreService;
      return Object.freeze({
        activeBuffer: terminal.buffer.active.type === "alternate" ? "alternate" : "normal",
        cursorX: terminal.buffer.active.cursorX,
        cursorY: terminal.buffer.active.cursorY,
        cursorHidden: service?.isCursorHidden === true,
        cursorStyle:
          service?.decPrivateModes?.cursorStyle ?? terminal.options.cursorStyle ?? "block",
        cursorBlink: service?.decPrivateModes?.cursorBlink ?? terminal.options.cursorBlink ?? false,
      });
    },
    async probeRendition(keyHex) {
      if (!/^[0-9a-f]{64}$/u.test(keyHex) || disposed) return null;
      const active = terminal.buffer.active;
      const rows = Math.min(256, active.length);
      const projection: Array<
        Readonly<{
          row: number;
          column: number;
          chars: string;
          width: number;
          wrapped: boolean;
          foreground: string;
          background: string;
          bold: boolean;
          italic: boolean;
          underline: boolean;
        }>
      > = [];
      const color = (cell: IBufferCell, foreground: boolean): string => {
        if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return "default";
        const value = foreground ? cell.getFgColor() : cell.getBgColor();
        if (foreground ? cell.isFgRGB() : cell.isBgRGB())
          return `rgb:${value.toString(16).padStart(6, "0")}`;
        return `indexed:${value}`;
      };
      for (let row = Math.max(0, active.length - rows); row < active.length; row += 1) {
        const line = active.getLine(row);
        if (!line) continue;
        let retainContinuation = false;
        for (let column = 0; column < line.length; column += 1) {
          const cell = line.getCell(column);
          if (!cell) continue;
          const chars = cell.getChars();
          const width = cell.getWidth();
          const foreground = color(cell, true);
          const background = color(cell, false);
          const bold = Boolean(cell.isBold());
          const italic = Boolean(cell.isItalic());
          const underline = Boolean(cell.isUnderline());
          if (chars.length === 0 && width !== 0) {
            retainContinuation = false;
            continue;
          }
          if (width === 0 && !retainContinuation) continue;
          if (
            chars === " " &&
            width === 1 &&
            foreground === "default" &&
            background === "default" &&
            !bold &&
            !italic &&
            !underline
          ) {
            retainContinuation = false;
            continue;
          }
          projection.push(
            Object.freeze({
              row,
              column,
              chars,
              width,
              wrapped: line.isWrapped,
              foreground,
              background,
              bold,
              italic,
              underline,
            }),
          );
          retainContinuation = width === 2;
        }
      }
      try {
        const key = await crypto.subtle.importKey(
          "raw",
          new Uint8Array(keyHex.match(/.{2}/gu)!.map((value) => Number.parseInt(value, 16))),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const hmac = async (domain: string, value: unknown): Promise<string> => {
          const digest = await crypto.subtle.sign(
            "HMAC",
            key,
            encoder.encode(`${domain}\0${JSON.stringify(value)}`),
          );
          return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        };
        const cellHmacs =
          projection.length <= 256
            ? await Promise.all(projection.map((cell) => hmac("web-rendition-cell", cell)))
            : null;
        return Object.freeze({
          renditionHmac: await hmac("web-rendition", projection),
          positionWrappedHmac: await hmac(
            "web-rendition-position-wrapped",
            projection.map(({ row, column, wrapped }) => ({ row, column, wrapped })),
          ),
          graphemeWidthHmac: await hmac(
            "web-rendition-grapheme-width",
            projection.map(({ chars, width }) => ({ chars, width })),
          ),
          colorHmac: await hmac(
            "web-rendition-color",
            projection.map(({ foreground, background }) => ({ foreground, background })),
          ),
          attributesHmac: await hmac(
            "web-rendition-attributes",
            projection.map(({ bold, italic, underline }) => ({ bold, italic, underline })),
          ),
          cellHmacs: cellHmacs ? Object.freeze(cellHmacs) : null,
          defaultForeground:
            terminal.options.theme?.foreground ?? TERMINAL_THEME_FALLBACK.foreground!,
          defaultBackground:
            terminal.options.theme?.background ?? TERMINAL_THEME_FALLBACK.background!,
          rendererCols: terminal.cols,
          rendererRows: terminal.rows,
          renditionCellCount: projection.length,
          wideContinuationCount: projection.filter(({ width }) => width === 0).length,
          combiningCount: projection.filter(
            ({ chars }) => typeof chars === "string" && /\p{Mark}/u.test(chars),
          ).length,
          styledCellCount: projection.filter(
            ({ foreground, background, bold, italic, underline }) =>
              foreground !== "default" || background !== "default" || bold || italic || underline,
          ).length,
        });
      } catch {
        return null;
      }
    },
    performanceChannel() {
      return currentPerformanceChannel();
    },
    dispose() {
      disposed = true;
      if (performanceChannel) performanceTelemetry?.retireRenderChannel(performanceChannel);
      performanceChannel = null;
      container = null;
      fitAddon = null;
      terminal.dispose();
    },
  };
};
