/**
 * Renderer-neutral terminal protocol fixtures.
 *
 * tmux-ide has two terminal renderers (OpenTUI and xterm.js). They may paint
 * differently, but they must parse the same byte stream into the same cells.
 * Keeping the highest-risk sequences here prevents either adapter from growing
 * a private interpretation of ANSI colors, resets, attributes, or graphemes.
 */

/** The canonical xterm 256-color palette, packed as `0xRRGGBB`. */
export const XTERM_PALETTE: readonly number[] = Object.freeze(buildXtermPalette());

/** The same protocol palette in the CSS form accepted by xterm.js themes. */
export const XTERM_PALETTE_HEX: readonly string[] = Object.freeze(
  XTERM_PALETTE.map((color) => `#${color.toString(16).padStart(6, "0")}`),
);

function buildXtermPalette(): number[] {
  const base = [
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f,
    0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  const palette = [...base];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let index = 16; index < 232; index += 1) {
    const offset = index - 16;
    const red = levels[Math.floor(offset / 36)]!;
    const green = levels[Math.floor(offset / 6) % 6]!;
    const blue = levels[offset % 6]!;
    palette.push((red << 16) | (green << 8) | blue);
  }
  for (let index = 232; index < 256; index += 1) {
    const value = 8 + 10 * (index - 232);
    palette.push((value << 16) | (value << 8) | value);
  }
  return palette;
}

export type TerminalConformanceColor =
  | { readonly kind: "default" }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly value: number };

export type TerminalConformanceAttribute =
  | "bold"
  | "dim"
  | "italic"
  | "underline"
  | "blink"
  | "inverse"
  | "hidden"
  | "strikethrough";

export interface TerminalConformanceCell {
  readonly row: number;
  readonly column: number;
  readonly chars: string;
  /** 0 is a wide-glyph continuation; 1 and 2 are ordinary cell widths. */
  readonly width: 0 | 1 | 2;
  readonly foreground: TerminalConformanceColor;
  readonly background: TerminalConformanceColor;
  readonly attributes?: readonly TerminalConformanceAttribute[];
}

export interface TerminalConformanceFixture {
  readonly id: string;
  readonly description: string;
  readonly cols: number;
  readonly rows: number;
  /** Writes are separate deliberately: parsers must preserve state across chunks. */
  readonly writes: readonly string[];
  readonly cells: readonly TerminalConformanceCell[];
  readonly wrappedRows?: readonly number[];
  readonly historyRows?: number;
  readonly cursor?: {
    readonly x: number;
    readonly y: number;
    readonly hidden: boolean;
    readonly style: "block" | "underline" | "bar";
    readonly blink: boolean;
  };
  readonly modes?: Partial<{
    readonly alternateScreen: boolean;
    readonly applicationCursor: boolean;
    readonly applicationKeypad: boolean;
    readonly bracketedPaste: boolean;
    readonly insert: boolean;
    readonly origin: boolean;
    readonly wraparound: boolean;
    readonly mouseTracking: boolean;
    readonly synchronizedOutput: boolean;
  }>;
}

const DEFAULT = Object.freeze({ kind: "default" } as const);
const indexed = (index: number): TerminalConformanceColor => ({ kind: "indexed", index });
const rgb = (value: number): TerminalConformanceColor => ({ kind: "rgb", value });

/**
 * Small, diagnostic fixtures rather than screenshots. Every asserted cell has
 * one reason to exist and failures name the exact protocol boundary that drifted.
 */
export const TERMINAL_CONFORMANCE_FIXTURES: readonly TerminalConformanceFixture[] = Object.freeze([
  {
    id: "claude-logo-black",
    description: "Claude's slot-174 foreground, explicit slot-16 black, and SGR 49 reset",
    cols: 12,
    rows: 2,
    writes: [
      "\u001b[38;5;",
      "174m \u2590\u001b[48;5;16m\u259b\u2588\u2588\u2588\u259c",
      "\u001b[49m\u258c\u001b[0m",
    ],
    cells: [
      {
        row: 0,
        column: 1,
        chars: "\u2590",
        width: 1,
        foreground: indexed(174),
        background: DEFAULT,
      },
      {
        row: 0,
        column: 2,
        chars: "\u259b",
        width: 1,
        foreground: indexed(174),
        background: indexed(16),
      },
      {
        row: 0,
        column: 3,
        chars: "\u2588",
        width: 1,
        foreground: indexed(174),
        background: indexed(16),
      },
      {
        row: 0,
        column: 4,
        chars: "\u2588",
        width: 1,
        foreground: indexed(174),
        background: indexed(16),
      },
      {
        row: 0,
        column: 5,
        chars: "\u2588",
        width: 1,
        foreground: indexed(174),
        background: indexed(16),
      },
      {
        row: 0,
        column: 6,
        chars: "\u259c",
        width: 1,
        foreground: indexed(174),
        background: indexed(16),
      },
      {
        row: 0,
        column: 7,
        chars: "\u258c",
        width: 1,
        foreground: indexed(174),
        background: DEFAULT,
      },
    ],
  },
  {
    id: "color-reset-boundaries",
    description: "39/49 reset one color channel while 0 resets both and all attributes",
    cols: 12,
    rows: 2,
    writes: [
      "A\u001b[31;44mB\u001b[39mC\u001b[49mD",
      "\u001b[38;2;10;200;30;48;2;1;2;3mT\u001b[0mZ",
    ],
    cells: [
      { row: 0, column: 0, chars: "A", width: 1, foreground: DEFAULT, background: DEFAULT },
      { row: 0, column: 1, chars: "B", width: 1, foreground: indexed(1), background: indexed(4) },
      { row: 0, column: 2, chars: "C", width: 1, foreground: DEFAULT, background: indexed(4) },
      { row: 0, column: 3, chars: "D", width: 1, foreground: DEFAULT, background: DEFAULT },
      {
        row: 0,
        column: 4,
        chars: "T",
        width: 1,
        foreground: rgb(0x0ac81e),
        background: rgb(0x010203),
      },
      { row: 0, column: 5, chars: "Z", width: 1, foreground: DEFAULT, background: DEFAULT },
    ],
  },
  {
    id: "supported-attributes",
    description: "Every attribute shared by xterm and OpenTUI, including conceal and inverse",
    cols: 12,
    rows: 2,
    writes: [
      "\u001b[1mB\u001b[0;2mD\u001b[0;3mI\u001b[0;4mU",
      "\u001b[0;5mK\u001b[0;8mH\u001b[0;9mS\u001b[0;7;31;44mR\u001b[0m",
    ],
    cells: [
      {
        row: 0,
        column: 0,
        chars: "B",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["bold"],
      },
      {
        row: 0,
        column: 1,
        chars: "D",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["dim"],
      },
      {
        row: 0,
        column: 2,
        chars: "I",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["italic"],
      },
      {
        row: 0,
        column: 3,
        chars: "U",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["underline"],
      },
      {
        row: 0,
        column: 4,
        chars: "K",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["blink"],
      },
      {
        row: 0,
        column: 5,
        chars: "H",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["hidden"],
      },
      {
        row: 0,
        column: 6,
        chars: "S",
        width: 1,
        foreground: DEFAULT,
        background: DEFAULT,
        attributes: ["strikethrough"],
      },
      {
        row: 0,
        column: 7,
        chars: "R",
        width: 1,
        foreground: indexed(1),
        background: indexed(4),
        attributes: ["inverse"],
      },
    ],
  },
  {
    id: "wide-and-combined-graphemes",
    description: "Wide CJK/emoji continuations and a combining grapheme keep cell alignment",
    cols: 12,
    rows: 2,
    writes: ["A\u754ce\u0301\ud83d\ude42"],
    cells: [
      { row: 0, column: 0, chars: "A", width: 1, foreground: DEFAULT, background: DEFAULT },
      { row: 0, column: 1, chars: "\u754c", width: 2, foreground: DEFAULT, background: DEFAULT },
      { row: 0, column: 2, chars: "", width: 0, foreground: DEFAULT, background: DEFAULT },
      { row: 0, column: 3, chars: "e\u0301", width: 1, foreground: DEFAULT, background: DEFAULT },
      {
        row: 0,
        column: 4,
        chars: "\ud83d\ude42",
        width: 2,
        foreground: DEFAULT,
        background: DEFAULT,
      },
      { row: 0, column: 5, chars: "", width: 0, foreground: DEFAULT, background: DEFAULT },
    ],
  },
  {
    id: "inverse-combined-grapheme",
    description: "The framebuffer grapheme post-pass preserves resolved inverse colors",
    cols: 8,
    rows: 2,
    writes: ["\u001b[7;38;5;1;48;5;4me\u0301\u001b[0m"],
    cells: [
      {
        row: 0,
        column: 0,
        chars: "e\u0301",
        width: 1,
        foreground: indexed(1),
        background: indexed(4),
        attributes: ["inverse"],
      },
    ],
  },
  {
    id: "codex-truecolor-status",
    description: "Codex status text preserves explicit P3-ready truecolor channels",
    cols: 12,
    rows: 2,
    writes: ["\u001b[38;2;99;102;241mCODEX\u001b[0m"],
    cells: [
      { row: 0, column: 0, chars: "C", width: 1, foreground: rgb(0x6366f1), background: DEFAULT },
      { row: 0, column: 1, chars: "O", width: 1, foreground: rgb(0x6366f1), background: DEFAULT },
    ],
  },
  {
    id: "opencode-indexed-status",
    description: "OpenCode indexed accent and inverse status remain application-owned",
    cols: 12,
    rows: 2,
    writes: ["\u001b[38;5;75;48;5;234;7mOC\u001b[0m"],
    cells: [
      {
        row: 0,
        column: 0,
        chars: "O",
        width: 1,
        foreground: indexed(75),
        background: indexed(234),
        attributes: ["inverse"],
      },
      {
        row: 0,
        column: 1,
        chars: "C",
        width: 1,
        foreground: indexed(75),
        background: indexed(234),
        attributes: ["inverse"],
      },
    ],
  },
  {
    id: "soft-wrap-row",
    description: "A soft-wrapped continuation row retains its wrapped bit",
    cols: 4,
    rows: 2,
    writes: ["ABCDE"],
    cells: [
      { row: 0, column: 0, chars: "A", width: 1, foreground: DEFAULT, background: DEFAULT },
      { row: 1, column: 0, chars: "E", width: 1, foreground: DEFAULT, background: DEFAULT },
    ],
    wrappedRows: [1],
  },
  {
    id: "wrapped-row-and-history",
    description: "Soft wrapping and styled scrollback remain canonical row state",
    cols: 4,
    rows: 2,
    writes: ["ABCD", "E\r\n", "\u001b[32mFG\u001b[0m", "\r\nHI"],
    cells: [
      { row: 0, column: 0, chars: "F", width: 1, foreground: indexed(2), background: DEFAULT },
      { row: 1, column: 0, chars: "H", width: 1, foreground: DEFAULT, background: DEFAULT },
    ],
    historyRows: 2,
  },
  {
    id: "cursor-and-modes",
    description: "Cursor presentation and DEC/ANSI input modes survive parser projection",
    cols: 8,
    rows: 3,
    writes: [
      "\u001b[?1h\u001b=\u001b[?2004h\u001b[4h\u001b[?6h",
      "\u001b[?7l\u001b[?1000h\u001b[?25l\u001b[5 qZ",
    ],
    cells: [{ row: 0, column: 0, chars: "Z", width: 1, foreground: DEFAULT, background: DEFAULT }],
    cursor: { x: 0, y: 0, hidden: true, style: "bar", blink: true },
    modes: {
      applicationCursor: true,
      applicationKeypad: true,
      bracketedPaste: true,
      insert: true,
      origin: true,
      wraparound: false,
      mouseTracking: true,
    },
  },
]);
