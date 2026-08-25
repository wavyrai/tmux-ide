/* @vitest-environment happy-dom */
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
// @ts-expect-error The production ProductRig helper is intentionally authored as native ESM JavaScript.
import { captureAnsiCursorWebPresentation } from "../../../../scripts/lib/product-ansi-cursor-alt-screen.mjs";
import {
  XTERM_PALETTE_HEX,
  blankTerminalReplicaSnapshot,
  diffTerminalReplicaSnapshots,
  encodeAnsiTerminalPatchRepresentation,
  encodeAnsiTerminalRepresentation,
} from "@tmux-ide/core";

import {
  createXtermRenderer,
  TERMINAL_FONT_FAMILY,
  TERMINAL_THEME_FALLBACK,
  TERMINAL_THEME_TOKEN,
  resolveTerminalFontFamily,
  resolveTerminalTheme,
  type TerminalTokenReader,
} from "./xterm-renderer.ts";

vi.mock("../../../../scripts/lib/performance-reference-budgets.mjs", () => ({
  TUI_CURSOR_PRESENTATION_P99_CEILING_MICROS: 33_000,
  TUI_EVENT_LOOP_CURRENT_ENDPOINT_CEILING_MICROS: 33_000,
  TUI_EVENT_LOOP_GENERATION_STICKY_PEAK_CEILING_MICROS: 100_000,
  TUI_EVENT_LOOP_WORKLOAD_P99_CEILING_MS: 33,
  TUI_HEAP_ABSOLUTE_CEILING_BYTES: 512 * 1024 * 1024,
  TUI_RSS_ABSOLUTE_CEILING_BYTES: 1024 * 1024 * 1024,
}));

function readerFrom(values: Record<string, string>): TerminalTokenReader {
  return { getPropertyValue: (name) => values[name] ?? "" };
}

const THEME_ROLES = Object.keys(TERMINAL_THEME_TOKEN) as (keyof typeof TERMINAL_THEME_TOKEN)[];
const DARK_TOKENS: Record<string, string> = {
  "--tmux-ide-terminal-background": "rgb(18 19 26)",
  "--tmux-ide-terminal-foreground": "rgb(230 232 242)",
  "--tmux-ide-terminal-cursor": "rgb(199 212 255)",
  "--tmux-ide-terminal-cursor-accent": "rgb(18 19 26)",
  "--tmux-ide-terminal-selection": "rgb(51 64 107)",
  "--tmux-ide-terminal-ansi-black": "#2a2c37",
  "--tmux-ide-terminal-ansi-red": "#f0748c",
  "--tmux-ide-terminal-ansi-green": "#7fd88f",
  "--tmux-ide-terminal-ansi-yellow": "#e6c67a",
  "--tmux-ide-terminal-ansi-blue": "#8bb4ff",
  "--tmux-ide-terminal-ansi-magenta": "#cba6f7",
  "--tmux-ide-terminal-ansi-cyan": "#7fd4d8",
  "--tmux-ide-terminal-ansi-white": "#cdd0da",
  "--tmux-ide-terminal-ansi-bright-black": "#5c6072",
  "--tmux-ide-terminal-ansi-bright-red": "#ff92a6",
  "--tmux-ide-terminal-ansi-bright-green": "#9ce8a8",
  "--tmux-ide-terminal-ansi-bright-yellow": "#f4d99a",
  "--tmux-ide-terminal-ansi-bright-blue": "#aecbff",
  "--tmux-ide-terminal-ansi-bright-magenta": "#ddc4ff",
  "--tmux-ide-terminal-ansi-bright-cyan": "#a3e8ec",
  "--tmux-ide-terminal-ansi-bright-white": "#f6f8fc",
};
const ALTERNATE_TOKENS = Object.fromEntries(
  Object.keys(DARK_TOKENS).map((key, index) => [key, `#${(0x102030 + index).toString(16)}`]),
);

async function renditionProofFor(projection: unknown, keyHex: string, domain = "web-rendition") {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyHex.match(/.{2}/gu)!.map((value) => Number.parseInt(value, 16))),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${domain}\0${JSON.stringify(projection)}`),
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function richWrappedSnapshot() {
  const blank = blankTerminalReplicaSnapshot(132, 41);
  const firstForeground = Object.freeze({ kind: "indexed" as const, index: 196 });
  const firstBackground = Object.freeze({ kind: "rgb" as const, value: 0x010203 });
  const wrappedForeground = Object.freeze({ kind: "rgb" as const, value: 0x5ab4ff });
  const wrappedBackground = Object.freeze({ kind: "indexed" as const, index: 17 });
  const styled = (grapheme: string, width = 1, wrapped = false) =>
    Object.freeze({
      grapheme,
      width: width as 0 | 1 | 2,
      foreground: wrapped ? wrappedForeground : firstForeground,
      background: wrapped ? wrappedBackground : firstBackground,
      attributes: wrapped ? 9 : 13,
    });
  const row = (
    index: number,
    entries: ReadonlyArray<readonly [number, string, 0 | 1 | 2]>,
    wrapped = false,
  ) => {
    const cells = [...blank.grid[index]!.cells];
    for (const [column, grapheme, width] of entries)
      cells[column] = styled(grapheme, width, index > 0);
    return { cells, wrapped };
  };
  const first = [..."ANSI_RICH"].map((grapheme, column) => [column, grapheme, 1] as const);
  return {
    ...blank,
    grid: [
      row(0, [...first, [9, "界", 2], [10, "", 0], [11, "é", 1]]),
      row(1, [
        [128, "W", 1],
        [129, "界", 2],
        [130, "", 0],
        [131, "é", 1],
      ]),
      row(2, [[0, "Z", 1]], true),
      ...blank.grid.slice(3),
    ],
    cursor: { x: 6, y: 3, hidden: false, style: "bar" as const, blink: true },
  };
}

function richWrappedProjection(wrapped: boolean) {
  const firstStyle = {
    foreground: "indexed:196",
    background: "rgb:010203",
    bold: true,
    italic: true,
    underline: true,
  };
  const wrappedStyle = {
    foreground: "rgb:5ab4ff",
    background: "indexed:17",
    bold: true,
    italic: false,
    underline: true,
  };
  return [
    ...[..."ANSI_RICH"].map((chars, column) => ({
      row: 0,
      column,
      chars,
      width: 1,
      wrapped: false,
      ...firstStyle,
    })),
    { row: 0, column: 9, chars: "界", width: 2, wrapped: false, ...firstStyle },
    { row: 0, column: 10, chars: "", width: 0, wrapped: false, ...firstStyle },
    { row: 0, column: 11, chars: "é", width: 1, wrapped: false, ...firstStyle },
    { row: 1, column: 128, chars: "W", width: 1, wrapped: false, ...wrappedStyle },
    { row: 1, column: 129, chars: "界", width: 2, wrapped: false, ...wrappedStyle },
    { row: 1, column: 130, chars: "", width: 0, wrapped: false, ...wrappedStyle },
    { row: 1, column: 131, chars: "é", width: 1, wrapped: false, ...wrappedStyle },
    { row: 2, column: 0, chars: "Z", width: 1, wrapped, ...wrappedStyle },
  ];
}

async function writeChunked(renderer: ReturnType<typeof createXtermRenderer>, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.byteLength; offset += 4093)
    await renderer.write(bytes.slice(offset, offset + 4093));
}

describe("resolveTerminalTheme", () => {
  it("derives every xterm theme role from the dark appearance tokens", () => {
    const theme = resolveTerminalTheme(readerFrom(DARK_TOKENS));
    for (const role of THEME_ROLES) {
      expect(theme[role]).toBe(DARK_TOKENS[TERMINAL_THEME_TOKEN[role]]);
    }
  });

  it("derives every role from the tokens it is given, not from a built-in ramp", () => {
    const theme = resolveTerminalTheme(readerFrom(ALTERNATE_TOKENS));
    for (const role of THEME_ROLES) {
      expect(theme[role]).toBe(ALTERNATE_TOKENS[TERMINAL_THEME_TOKEN[role]]);
    }
    expect(theme.background).not.toBe(DARK_TOKENS["--tmux-ide-terminal-background"]);
    expect(theme.foreground).not.toBe(DARK_TOKENS["--tmux-ide-terminal-foreground"]);
  });

  it("supplies a complete theme even when no tokens resolve", () => {
    const theme = resolveTerminalTheme(readerFrom({}));
    for (const role of THEME_ROLES) {
      expect(theme[role]).toBe(TERMINAL_THEME_FALLBACK[role]);
      expect(theme[role]!).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  it("derives every xterm theme role from appearance tokens", () => {
    const dark = resolveTerminalTheme(readerFrom(DARK_TOKENS));
    const alternate = resolveTerminalTheme(readerFrom(ALTERNATE_TOKENS));
    for (const role of THEME_ROLES) {
      expect(dark[role]).toBe(DARK_TOKENS[TERMINAL_THEME_TOKEN[role]]);
      expect(alternate[role]).toBe(ALTERNATE_TOKENS[TERMINAL_THEME_TOKEN[role]]);
    }
  });

  it("supplies complete fallbacks and trims non-empty token values", () => {
    const fallback = resolveTerminalTheme(readerFrom({}));
    for (const role of THEME_ROLES) expect(fallback[role]).toBe(TERMINAL_THEME_FALLBACK[role]);
    expect(
      resolveTerminalTheme(
        readerFrom({
          "--tmux-ide-terminal-background": "  #010203  ",
          "--tmux-ide-terminal-foreground": "   ",
        }),
      ).background,
    ).toBe("#010203");
    expect(
      resolveTerminalTheme(readerFrom({ "--tmux-ide-terminal-foreground": "   " })).foreground,
    ).toBe(TERMINAL_THEME_FALLBACK.foreground);
  });

  it("keeps explicit ANSI colors protocol-faithful", () => {
    const theme = resolveTerminalTheme(readerFrom(DARK_TOKENS));
    expect([
      theme.black,
      theme.red,
      theme.green,
      theme.yellow,
      theme.blue,
      theme.magenta,
      theme.cyan,
      theme.white,
      theme.brightBlack,
      theme.brightRed,
      theme.brightGreen,
      theme.brightYellow,
      theme.brightBlue,
      theme.brightMagenta,
      theme.brightCyan,
      theme.brightWhite,
    ]).toEqual(XTERM_PALETTE_HEX.slice(0, 16));
    expect(theme.extendedAnsi).toEqual(XTERM_PALETTE_HEX.slice(16));
    expect(theme.red).not.toBe(DARK_TOKENS["--tmux-ide-terminal-ansi-red"]);
  });

  it("never emits an empty color for a whitespace-only token", () => {
    const theme = resolveTerminalTheme(readerFrom({ "--tmux-ide-terminal-foreground": "   " }));
    expect(theme.foreground).toBe(TERMINAL_THEME_FALLBACK.foreground);
  });

  it("trims surrounding whitespace from resolved token values", () => {
    const theme = resolveTerminalTheme(
      readerFrom({ "--tmux-ide-terminal-background": "  #010203  " }),
    );
    expect(theme.background).toBe("#010203");
  });
});

describe("resolveTerminalFontFamily", () => {
  it("reads the monospace cascade from the font token", () => {
    const family = resolveTerminalFontFamily(
      readerFrom({ "--tmux-ide-terminal-font-family": '"JetBrains Mono", monospace' }),
    );
    expect(family).toBe('"JetBrains Mono", monospace');
  });

  it("falls back to the built-in monospace cascade when unset", () => {
    expect(resolveTerminalFontFamily(readerFrom({}))).toBe(TERMINAL_FONT_FAMILY);
    expect(TERMINAL_FONT_FAMILY).toMatch(/monospace$/u);
  });

  it("reads and falls back the monospace cascade", () => {
    expect(
      resolveTerminalFontFamily(
        readerFrom({ "--tmux-ide-terminal-font-family": '"JetBrains Mono", monospace' }),
      ),
    ).toBe('"JetBrains Mono", monospace');
    expect(resolveTerminalFontFamily(readerFrom({}))).toBe(TERMINAL_FONT_FAMILY);
    expect(TERMINAL_FONT_FAMILY).toMatch(/monospace$/u);
  });
});

describe("xterm presentation projection", () => {
  it("restores input modes on a fresh xterm and resets them with a mode-only patch", async () => {
    const terminal = new Terminal({ cols: 8, rows: 3, screenReaderMode: true });
    const container = document.body.appendChild(document.createElement("div"));
    terminal.open(container);
    const blank = blankTerminalReplicaSnapshot(8, 3);
    const enabled = {
      ...blank,
      modes: {
        ...blank.modes,
        applicationCursor: true,
        applicationKeypad: true,
        bracketedPaste: true,
        insert: true,
        origin: true,
        mouseTracking: true,
        mouseProtocol: "drag" as const,
        mouseEncoding: "sgr" as const,
        synchronizedOutput: true,
      },
    };
    const write = async (bytes: Uint8Array): Promise<void> =>
      await new Promise<void>((resolve) => terminal.write(bytes, resolve));
    await write(encodeAnsiTerminalRepresentation(null, enabled));
    expect(terminal.modes).toMatchObject({
      applicationCursorKeysMode: true,
      applicationKeypadMode: true,
      bracketedPasteMode: true,
      insertMode: true,
      originMode: true,
      mouseTrackingMode: "drag",
      synchronizedOutputMode: true,
    });

    const reset = {
      ...enabled,
      modes: { ...blank.modes, mouseProtocol: "none" as const, mouseEncoding: "default" as const },
    };
    await write(
      encodeAnsiTerminalPatchRepresentation({ rows: [], modes: reset.modes }, reset, enabled),
    );
    expect(terminal.modes).toMatchObject({
      applicationCursorKeysMode: false,
      applicationKeypadMode: false,
      bracketedPasteMode: false,
      insertMode: false,
      originMode: false,
      mouseTrackingMode: "none",
      synchronizedOutputMode: false,
    });
    terminal.dispose();
    container.remove();
  });

  it("preserves a real xterm selection while rolling a 5k canonical history", async () => {
    const terminal = new Terminal({
      cols: 8,
      rows: 3,
      screenReaderMode: true,
      scrollback: 10_000,
    });
    const container = document.body.appendChild(document.createElement("div"));
    terminal.open(container);
    const blank = blankTerminalReplicaSnapshot(8, 3);
    const row = (text: string) => ({
      ...blank.grid[0]!,
      cells: blank.grid[0]!.cells.map((cell, index) => ({
        ...cell,
        grapheme: text[index] ?? " ",
      })),
    });
    const history = Array.from({ length: 5_000 }, (_, index) =>
      row(index === 100 ? "SELECTED" : `h${String(index).padStart(4, "0")}`),
    );
    const baseline = {
      ...blank,
      history,
      grid: [row("view-a"), row("view-b"), row("view-c")],
    };
    const write = async (bytes: Uint8Array): Promise<void> =>
      await new Promise<void>((resolve) => terminal.write(bytes, resolve));
    await write(encodeAnsiTerminalRepresentation(null, baseline));
    terminal.select(0, 100, 8);
    expect(terminal.getSelection()).toBe("SELECTED");

    const appended = baseline.grid[0]!;
    const target = {
      ...baseline,
      history: [...history, appended],
      grid: [row("view-b"), row("view-c"), row("latest")],
    };
    const bytes = encodeAnsiTerminalPatchRepresentation(
      {
        historyDelta: { trim: 0, append: [appended] },
        rows: [
          { index: 0, row: target.grid[0]! },
          { index: 1, row: target.grid[1]! },
          { index: 2, row: target.grid[2]! },
        ],
      },
      target,
      baseline,
    );
    expect(new TextDecoder().decode(bytes)).not.toContain("\u001b[2J");
    expect(new TextDecoder().decode(bytes)).not.toContain("\u001b[3J");
    expect(bytes.byteLength).toBeLessThan(256);
    await write(bytes);
    expect(terminal.getSelection()).toBe("SELECTED");
    expect(
      terminal.buffer.active.getLine(terminal.buffer.active.baseY + 2)?.translateToString(false),
    ).toBe("latest  ");
    terminal.dispose();
    container.remove();
  });

  it("binds the exact browser DOM projection to expected cells and cursor geometry", async () => {
    const keyHex = "0d".repeat(32);
    const pane = "pane-dom-proof";
    const staleSurface = document.body.appendChild(document.createElement("div"));
    staleSurface.className = "terminal-surface";
    staleSurface.dataset.phase = "connected";
    staleSurface.dataset.semanticPaneId = pane;
    staleSurface.innerHTML = '<div class="xterm-rows"><div><span>STALE</span></div></div>';
    const surface = document.body.appendChild(document.createElement("div"));
    surface.className = "terminal-surface";
    surface.dataset.phase = "connected";
    surface.dataset.semanticPaneId = pane;
    const container = surface.appendChild(document.createElement("div"));
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 1320 },
      clientHeight: { configurable: true, value: 410 },
    });
    const renderer = createXtermRenderer({ reducedMotion: true, label: "DOM binding proof" });
    renderer.open(container);
    renderer.resizeGrid({ cols: 132, rows: 41 });
    await renderer.write(
      encodeAnsiTerminalRepresentation(null, blankTerminalReplicaSnapshot(132, 41)),
    );
    await renderer.write(
      new TextEncoder().encode(
        "\u001b[1;1H\u001b[1;3;4;38;5;196;48;2;1;2;3mA\u001b[0mB" +
          "\u001b[2;1H\u001b[1;3;4;38;5;196;48;2;1;2;3m \u001b[0m" +
          "\u001b[3;1H界é\u001b[4;132HZQ\u001b[1;1H\u001b[2 q\u001b[?25l",
      ),
    );
    const rows = [...container.querySelectorAll<HTMLElement>(".xterm-rows > div")];
    await vi.waitFor(() => expect(rows[0]?.textContent).toContain("AB"));
    for (const row of rows) {
      row.style.color = "rgb(230, 232, 242)";
      for (const span of row.querySelectorAll<HTMLElement>("span")) {
        span.style.color = "rgb(230, 232, 242)";
        span.style.backgroundColor = "transparent";
      }
    }
    const spans = rows[0]!.querySelectorAll<HTMLElement>("span");
    spans[0]!.style.color = "rgb(255, 0, 0)";

    spans[0]!.style.backgroundColor = "rgb(1, 2, 3)";
    spans[0]!.style.fontWeight = "700";
    spans[0]!.style.fontStyle = "italic";
    spans[0]!.style.textDecorationLine = "underline";
    const styledSpaceSpan = rows[1]!.querySelector<HTMLElement>("span")!;
    styledSpaceSpan.style.color = "rgb(255, 0, 0)";
    styledSpaceSpan.style.backgroundColor = "rgb(1, 2, 3)";
    styledSpaceSpan.style.fontWeight = "700";
    styledSpaceSpan.style.fontStyle = "italic";
    styledSpaceSpan.style.textDecorationLine = "underline";
    const rendition = await renderer.probeRendition?.(keyHex);
    const presentation = renderer.readPresentation?.();
    expect(rendition).not.toBeNull();
    expect(getComputedStyle(rows[0]!).backgroundColor).toBe("");
    expect(rendition).toMatchObject({
      defaultForeground: TERMINAL_THEME_FALLBACK.foreground,
      defaultBackground: TERMINAL_THEME_FALLBACK.background,
    });
    expect(presentation).not.toBeNull();
    const globals = globalThis as Record<string, unknown>;
    globals.__TMUX_IDE_PROBE_TERMINAL_RENDITION__ = async () => ({
      surface,
      rendition,
      presentation,
      canonical: {
        generation: "generation",
        incarnation: "incarnation",
        stateHash: "state",
        deliveryRequestId: "request",
        revision: 1,
        sourceEpoch: 1,
        rendererEpoch: 1,
        cols: 132,
        rows: 41,
        gridRowsRead: 41,
        gridCellsRead: 5_412,
        fullGridWalks: 0,
        alternateScreen: false,
        cursor: { x: 0, y: 0, hidden: true, style: "block", blink: false },
      },
    });
    const page = {
      evaluate: async (callback: (value: unknown) => unknown, value: unknown) => callback(value),
    };
    const expectedRendition = [
      {
        row: 0,
        column: 0,
        chars: "A",
        width: 1,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 1,
        column: 0,
        chars: " ",
        width: 1,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 2,
        column: 0,
        chars: "界",
        width: 2,
        wrapped: false,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
      {
        row: 2,
        column: 1,
        chars: "",
        width: 0,
        wrapped: false,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
      {
        row: 2,
        column: 2,
        chars: "é",
        width: 1,
        wrapped: false,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
      {
        row: 3,
        column: 131,
        chars: "Z",
        width: 1,
        wrapped: false,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
      {
        row: 4,
        column: 0,
        chars: "Q",
        width: 1,
        wrapped: true,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
      {
        row: 0,
        column: 1,
        chars: "B",
        width: 1,
        wrapped: false,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
    ];
    const request = {
      keyHex,
      stage: "normal",
      semanticPaneId: pane,
      expectedRendition,
      expectedCursor: { x: 0, y: 0, hidden: true, style: "block", blink: false },
    };
    const initialCapture = await captureAnsiCursorWebPresentation(page, request);
    expect({
      row: initialCapture.domRowCountExact,
      text: initialCapture.domTextExact,
      style: initialCapture.domStyleExact,
      mismatchRow: initialCapture.domFirstMismatchRow,
      mismatchColumn: initialCapture.domFirstMismatchColumn,
      mismatchComponent: initialCapture.domFirstMismatchComponent,
    }).toEqual({
      row: true,
      text: true,
      style: true,
      mismatchRow: null,
      mismatchColumn: null,
      mismatchComponent: null,
    });
    expect(initialCapture).toMatchObject({
      domSemanticExact: true,
      domCursorExact: true,
    });

    spans[1]!.style.color = "rgb(230, 232, 242)";
    spans[1]!.style.backgroundColor = "transparent";
    expect(await captureAnsiCursorWebPresentation(page, request)).toMatchObject({
      domSemanticExact: true,
      domStyleExact: true,
    });
    for (const background of ["rgb:000000", "indexed:16"]) {
      const expectedBlackBackground = expectedRendition.map((cell) =>
        cell.row === 0 && cell.column === 1 ? { ...cell, background } : cell,
      );
      expect(
        await captureAnsiCursorWebPresentation(page, {
          ...request,
          expectedRendition: expectedBlackBackground,
        }),
      ).toMatchObject({
        domSemanticExact: false,
        domStyleExact: false,
        domFirstMismatchRow: 0,
        domFirstMismatchColumn: 1,
        domFirstMismatchComponent: "background",
      });
    }
    spans[1]!.style.color = "rgba(230, 232, 242, 0)";
    expect(await captureAnsiCursorWebPresentation(page, request)).toMatchObject({
      domSemanticExact: false,
      domStyleExact: false,
      domFirstMismatchComponent: "foreground",
    });
    for (const foreground of ["rgb:ff0000", "indexed:196"]) {
      spans[1]!.style.color = "rgba(255, 0, 0, 0.5)";
      const expectedFractionalForeground = expectedRendition.map((cell) =>
        cell.row === 0 && cell.column === 1 ? { ...cell, foreground } : cell,
      );
      expect(
        await captureAnsiCursorWebPresentation(page, {
          ...request,
          expectedRendition: expectedFractionalForeground,
        }),
      ).toMatchObject({
        domSemanticExact: false,
        domStyleExact: false,
        domFirstMismatchComponent: "foreground",
      });
    }
    spans[1]!.style.color = "rgb(230, 232, 242)";
    for (const background of ["rgb:000000", "indexed:16"]) {
      spans[1]!.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
      const expectedFractionalBackground = expectedRendition.map((cell) =>
        cell.row === 0 && cell.column === 1 ? { ...cell, background } : cell,
      );
      expect(
        await captureAnsiCursorWebPresentation(page, {
          ...request,
          expectedRendition: expectedFractionalBackground,
        }),
      ).toMatchObject({
        domSemanticExact: false,
        domStyleExact: false,
        domFirstMismatchComponent: "background",
      });
    }
    spans[1]!.style.backgroundColor = "transparent";

    spans[1]!.textContent = "C";
    expect(await captureAnsiCursorWebPresentation(page, request)).toMatchObject({
      domSemanticExact: false,
    });
    spans[1]!.textContent = "B";
    spans[0]!.style.color = "rgb(0, 255, 0)";
    expect(await captureAnsiCursorWebPresentation(page, request)).toMatchObject({
      domSemanticExact: false,
    });
    spans[0]!.style.color = "rgb(255, 0, 0)";

    const styledSpaceText = styledSpaceSpan.firstChild!;
    styledSpaceText.nodeValue = "";
    expect(await captureAnsiCursorWebPresentation(page, request)).toMatchObject({
      domSemanticExact: false,
      domTextExact: false,
      domFirstMismatchRow: 1,
      domFirstMismatchColumn: 0,
      domFirstMismatchComponent: "cell-missing",
    });
    styledSpaceText.nodeValue = "\u00a0";

    const screen = container.querySelector<HTMLElement>(".xterm-screen")!;
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1320, height: 410, right: 1320, bottom: 410 }) as DOMRect;
    const cursor = spans[0]!;
    cursor.classList.add("xterm-cursor", "xterm-cursor-block");
    cursor.style.display = "block";
    cursor.style.visibility = "visible";
    cursor.style.opacity = "1";
    cursor.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 10, height: 10, right: 10, bottom: 10 }) as DOMRect;
    const visibleRequest = {
      ...request,
      expectedCursor: { x: 0, y: 0, hidden: false, style: "block", blink: false },
    };
    expect(await captureAnsiCursorWebPresentation(page, visibleRequest)).toMatchObject({
      domSemanticExact: true,
      domCursorExact: true,
    });
    cursor.getBoundingClientRect = () =>
      ({ left: 10, top: 0, width: 10, height: 10, right: 20, bottom: 10 }) as DOMRect;
    expect(await captureAnsiCursorWebPresentation(page, visibleRequest)).toMatchObject({
      domCursorExact: false,
    });
    cursor.classList.remove("xterm-cursor", "xterm-cursor-block");
    const plainCursor = spans[1]!;
    plainCursor.classList.add("xterm-cursor", "xterm-cursor-block");
    plainCursor.style.display = "block";
    plainCursor.style.visibility = "visible";
    plainCursor.style.opacity = "1";
    plainCursor.getBoundingClientRect = () =>
      ({ left: 10, top: 0, width: 10, height: 10, right: 20, bottom: 10 }) as DOMRect;
    expect(
      await captureAnsiCursorWebPresentation(page, {
        ...visibleRequest,
        expectedCursor: { ...visibleRequest.expectedCursor, x: 1 },
      }),
    ).toMatchObject({ domSemanticExact: true, domCursorExact: true });

    globals.__TMUX_IDE_PROBE_TERMINAL_RENDITION__ = async () => ({
      surface: staleSurface,
      rendition,
      presentation,
      canonical: {
        generation: "generation",
        incarnation: "incarnation",
        stateHash: "state",
        deliveryRequestId: "request",
        revision: 1,
        sourceEpoch: 1,
        rendererEpoch: 1,
        cols: 132,
        rows: 41,
        gridRowsRead: 41,
        gridCellsRead: 5_412,
        fullGridWalks: 0,
        alternateScreen: false,
        cursor: { x: 1, y: 0, hidden: false, style: "block", blink: false },
      },
    });
    expect(
      await captureAnsiCursorWebPresentation(page, {
        ...visibleRequest,
        expectedCursor: { ...visibleRequest.expectedCursor, x: 1 },
      }),
    ).toMatchObject({ domSemanticExact: false, domRowCountExact: false });

    delete globals.__TMUX_IDE_PROBE_TERMINAL_RENDITION__;
    renderer.dispose();
    surface.remove();
    staleSurface.remove();
  });

  it("keeps actual DOM row semantics stable across a canonical cursor relocation", async () => {
    const renderer = createXtermRenderer({ reducedMotion: true, label: "DOM cursor proof" });
    const container = document.body.appendChild(document.createElement("div"));
    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 240 },
    });
    renderer.open(container);
    renderer.resizeGrid({ cols: 8, rows: 3 });
    await renderer.write(new TextEncoder().encode("AB\u001b[1;1H\u001b[2 q\u001b[?25h"));
    const rows = [...container.querySelectorAll<HTMLElement>(".xterm-rows > div")];
    await vi.waitFor(() => expect(rows[0]?.textContent).toContain("AB"));
    const firstRowsText = rows.map((row) => row.textContent);
    expect(renderer.readPresentation?.()).toMatchObject({ cursorX: 0, cursorY: 0 });

    await renderer.write(new TextEncoder().encode("\u001b[2;4H\u001b[4 q"));
    await vi.waitFor(() => expect(renderer.readPresentation?.().cursorY).toBe(1));
    expect(rows.map((row) => row.textContent)).toEqual(firstRowsText);
    expect(renderer.readPresentation?.()).toMatchObject({
      cursorX: 3,
      cursorY: 1,
      cursorStyle: "underline",
      cursorHidden: false,
    });
    renderer.dispose();
    container.remove();
  });

  it("reads actual cursor and alternate-buffer state after parser settlement", async () => {
    const renderer = createXtermRenderer({ reducedMotion: false, label: "ANSI proof" });
    await renderer.write(
      new TextEncoder().encode("\u001b[?1049h\u001b[8;12H\u001b[4 q\u001b[?25l"),
    );
    expect(renderer.readPresentation?.()).toEqual({
      activeBuffer: "alternate",
      cursorX: 11,
      cursorY: 7,
      cursorHidden: true,
      cursorStyle: "underline",
      cursorBlink: false,
    });
    await renderer.write(new TextEncoder().encode("\u001b[?1049l\u001b[4;7H\u001b[5 q\u001b[?25h"));
    expect(renderer.readPresentation?.()).toEqual({
      activeBuffer: "normal",
      cursorX: 6,
      cursorY: 3,
      cursorHidden: false,
      cursorStyle: "bar",
      cursorBlink: true,
    });
    renderer.dispose();
  });

  it("reseed-switches an existing alternate xterm back to normal atomically", async () => {
    const renderer = createXtermRenderer({ reducedMotion: false, label: "reseed proof" });
    const normal = blankTerminalReplicaSnapshot(8, 3);
    const alternate = { ...normal, modes: { ...normal.modes, alternateScreen: true } };
    await renderer.write(encodeAnsiTerminalRepresentation(null, alternate));
    expect(renderer.readPresentation?.().activeBuffer).toBe("alternate");
    await renderer.write(encodeAnsiTerminalRepresentation(null, normal));
    expect(renderer.readPresentation?.()).toMatchObject({
      activeBuffer: "normal",
      cursorX: 0,
      cursorY: 0,
      cursorHidden: false,
      cursorStyle: "block",
      cursorBlink: false,
    });
    renderer.dispose();
  });

  it("projects indexed/RGB rendition, wide continuation, combining and wrap from xterm cells", async () => {
    const renderer = createXtermRenderer({ reducedMotion: false, label: "rendition proof" });
    renderer.resizeGrid({ cols: 4, rows: 3 });
    await renderer.write(
      new TextEncoder().encode("\u001b[1;3;4;38;5;196;48;2;1;2;3m界é\u001b[0mWZ"),
    );
    const projection = [
      {
        row: 0,
        column: 0,
        chars: "界",
        width: 2,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 0,
        column: 1,
        chars: "",
        width: 0,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 0,
        column: 2,
        chars: "é",
        width: 1,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 0,
        column: 3,
        chars: "W",
        width: 1,
        wrapped: false,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
      {
        row: 1,
        column: 0,
        chars: "Z",
        width: 1,
        wrapped: true,
        foreground: "default",
        background: "default",
        bold: false,
        italic: false,
        underline: false,
      },
    ];
    const keyHex = "07".repeat(32);
    const proof = await renderer.probeRendition?.(keyHex);
    expect(proof).toMatchObject({
      renditionHmac: await renditionProofFor(projection, keyHex),
      renditionCellCount: 5,
      wideContinuationCount: 1,
      combiningCount: 1,
      styledCellCount: 3,
    });
    expect(proof).not.toHaveProperty("projection");
    expect(await renderer.probeRendition?.("bad-key")).toBeNull();
    renderer.dispose();
  });

  it("preserves canonical wrapped rows through semantic ANSI seeds and patches", async () => {
    const keyHex = "09".repeat(32);
    const target = richWrappedSnapshot();
    const expected = richWrappedProjection(true);
    const seedRenderer = createXtermRenderer({ reducedMotion: false, label: "semantic wrap seed" });
    seedRenderer.resizeGrid({ cols: target.cols, rows: target.rows });
    await seedRenderer.write(encodeAnsiTerminalRepresentation(null, target));
    expect(await seedRenderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(expected, keyHex),
    });
    seedRenderer.dispose();

    const diffRenderer = createXtermRenderer({ reducedMotion: false, label: "semantic wrap diff" });
    diffRenderer.resizeGrid({ cols: target.cols, rows: target.rows });
    const baseline = blankTerminalReplicaSnapshot(target.cols, target.rows);
    await diffRenderer.write(encodeAnsiTerminalRepresentation(null, baseline));
    await diffRenderer.write(encodeAnsiTerminalRepresentation(baseline, target));
    expect(await diffRenderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(expected, keyHex),
    });
    diffRenderer.dispose();

    const renderer = createXtermRenderer({ reducedMotion: false, label: "semantic wrap proof" });
    renderer.resizeGrid({ cols: target.cols, rows: target.rows });
    await renderer.write(encodeAnsiTerminalRepresentation(null, baseline));
    await renderer.write(
      encodeAnsiTerminalPatchRepresentation(
        {
          rows: [0, 1, 2].map((index) => ({ index, row: target.grid[index]! })),
        },
        target,
        baseline,
      ),
    );
    const richProof = await renderer.probeRendition?.(keyHex);
    expect(richProof).toMatchObject({
      renditionHmac: await renditionProofFor(expected, keyHex),
      renditionCellCount: 17,
      wideContinuationCount: 2,
      combiningCount: 2,
      styledCellCount: 17,
      rendererCols: 132,
      rendererRows: 41,
      positionWrappedHmac: await renditionProofFor(
        expected.map(({ row, column, wrapped }) => ({ row, column, wrapped })),
        keyHex,
        "web-rendition-position-wrapped",
      ),
      graphemeWidthHmac: await renditionProofFor(
        expected.map(({ chars, width }) => ({ chars, width })),
        keyHex,
        "web-rendition-grapheme-width",
      ),
      colorHmac: await renditionProofFor(
        expected.map(({ foreground, background }) => ({ foreground, background })),
        keyHex,
        "web-rendition-color",
      ),
      attributesHmac: await renditionProofFor(
        expected.map(({ bold, italic, underline }) => ({ bold, italic, underline })),
        keyHex,
        "web-rendition-attributes",
      ),
    });
    expect(richProof?.cellHmacs).toEqual(
      await Promise.all(
        expected.map((cell) => renditionProofFor(cell, keyHex, "web-rendition-cell")),
      ),
    );

    const unwrapped = {
      ...target,
      grid: [
        ...target.grid.slice(0, 2),
        { ...target.grid[2]!, wrapped: false },
        ...target.grid.slice(3),
      ],
    };
    await renderer.write(
      encodeAnsiTerminalPatchRepresentation(
        { rows: [{ index: 2, row: unwrapped.grid[2]! }] },
        unwrapped,
        target,
      ),
    );
    expect(await renderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(richWrappedProjection(false), keyHex),
    });

    await renderer.write(
      encodeAnsiTerminalPatchRepresentation(
        { rows: [{ index: 2, row: target.grid[2]! }] },
        target,
        unwrapped,
      ),
    );
    expect(await renderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(expected, keyHex),
    });
    expect(await renditionProofFor(expected, keyHex)).not.toBe(
      await renditionProofFor(richWrappedProjection(false), keyHex),
    );
    expect(renderer.readPresentation?.()).toMatchObject({ cursorX: 6, cursorY: 3 });
    renderer.dispose();
  });

  it("replaces stale predecessor wrap topology before the production rich patch", async () => {
    const keyHex = "0c".repeat(32);
    const blank = blankTerminalReplicaSnapshot(132, 41);
    const markerCells = [...blank.grid[0]!.cells];
    for (const [column, grapheme] of [..."ANSI_BASELINE_MARKER"].entries())
      markerCells[column] = { ...markerCells[column]!, grapheme };
    const normal = {
      ...blank,
      grid: [{ cells: markerCells, wrapped: false }, ...blank.grid.slice(1)],
      cursor: { ...blank.cursor, y: 1 },
    };
    const staleCells = [...blank.grid[1]!.cells];
    staleCells[0] = Object.freeze({
      ...staleCells[0]!,
      grapheme: "S",
    });
    const stale = {
      ...blank,
      history: Array.from({ length: 5_000 }, () => ({ cells: staleCells, wrapped: false })),
      grid: [blank.grid[0]!, { cells: staleCells, wrapped: true }, ...blank.grid.slice(2)],
    };
    const target = richWrappedSnapshot();
    const renderer = createXtermRenderer({ reducedMotion: false, label: "stale wrap proof" });
    renderer.resizeGrid({ cols: 80, rows: 24 });
    renderer.resizeGrid({ cols: 132, rows: 41 });
    await renderer.write(encodeAnsiTerminalRepresentation(null, stale));
    const normalBytes = encodeAnsiTerminalPatchRepresentation(
      diffTerminalReplicaSnapshots(stale, normal),
      normal,
      stale,
    );
    const richBytes = encodeAnsiTerminalPatchRepresentation(
      diffTerminalReplicaSnapshots(normal, target),
      target,
      normal,
    );
    expect(
      new TextDecoder().decode(normalBytes).startsWith("\u001b[?1049l\u001b[0m\u001b[2J"),
    ).toBe(true);
    expect(new TextDecoder().decode(richBytes).startsWith("\u001b[?1049l\u001b[0m\u001b[2J")).toBe(
      true,
    );
    await writeChunked(renderer, normalBytes);
    await writeChunked(renderer, richBytes);
    const proof = await renderer.probeRendition?.(keyHex);
    const expected = richWrappedProjection(true);
    expect(proof).toMatchObject({
      renditionHmac: await renditionProofFor(richWrappedProjection(true), keyHex),
      positionWrappedHmac: await renditionProofFor(
        expected.map(({ row, column, wrapped }) => ({ row, column, wrapped })),
        keyHex,
        "web-rendition-position-wrapped",
      ),
      graphemeWidthHmac: await renditionProofFor(
        expected.map(({ chars, width }) => ({ chars, width })),
        keyHex,
        "web-rendition-grapheme-width",
      ),
      colorHmac: await renditionProofFor(
        expected.map(({ foreground, background }) => ({ foreground, background })),
        keyHex,
        "web-rendition-color",
      ),
      attributesHmac: await renditionProofFor(
        expected.map(({ bold, italic, underline }) => ({ bold, italic, underline })),
        keyHex,
        "web-rendition-attributes",
      ),
    });
    renderer.dispose();
  });

  it("repaints an unchanged predecessor without scrolling when the bottom row is wrapped", async () => {
    const baseline = blankTerminalReplicaSnapshot(8, 3);
    const styled = Object.freeze({
      grapheme: "界",
      width: 2 as const,
      foreground: Object.freeze({ kind: "indexed" as const, index: 196 }),
      background: Object.freeze({ kind: "rgb" as const, value: 0x010203 }),
      attributes: 13,
    });
    const predecessorCells = [...baseline.grid[1]!.cells];
    predecessorCells[6] = styled;
    predecessorCells[7] = Object.freeze({ ...styled, grapheme: "", width: 0 as const });
    const predecessor = { cells: predecessorCells, wrapped: false };
    const bottomCells = [...baseline.grid[2]!.cells];
    bottomCells[0] = Object.freeze({ ...styled, grapheme: "é", width: 1 as const });
    const bottom = { cells: bottomCells, wrapped: true };
    const target = {
      ...baseline,
      grid: [baseline.grid[0]!, predecessor, bottom],
      cursor: { ...baseline.cursor, x: 0, y: 2 },
    };
    const renderer = createXtermRenderer({ reducedMotion: false, label: "bottom wrap proof" });
    renderer.resizeGrid({ cols: 8, rows: 3 });
    await renderer.write(encodeAnsiTerminalRepresentation(null, baseline));
    await renderer.write(
      encodeAnsiTerminalPatchRepresentation(
        { rows: [{ index: 2, row: bottom }] },
        target,
        baseline,
      ),
    );
    const projection = [
      {
        row: 1,
        column: 6,
        chars: "界",
        width: 2,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 1,
        column: 7,
        chars: "",
        width: 0,
        wrapped: false,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
      {
        row: 2,
        column: 0,
        chars: "é",
        width: 1,
        wrapped: true,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
    ];
    const keyHex = "0a".repeat(32);
    expect(await renderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(projection, keyHex),
      renditionCellCount: 3,
    });
    expect(renderer.readPresentation?.()).toMatchObject({ cursorX: 0, cursorY: 2 });
    renderer.dispose();
  });

  it("falls back to an exact seed when a patch must create a wrapped first viewport row", async () => {
    const baseline = blankTerminalReplicaSnapshot(8, 3);
    const cells = [...baseline.grid[0]!.cells];
    cells[0] = {
      grapheme: "A",
      width: 1,
      foreground: { kind: "indexed", index: 196 },
      background: { kind: "rgb", value: 0x010203 },
      attributes: 13,
    };
    const first = { cells, wrapped: true };
    const target = { ...baseline, grid: [first, ...baseline.grid.slice(1)] };
    const renderer = createXtermRenderer({ reducedMotion: false, label: "top wrap fallback" });
    renderer.resizeGrid({ cols: 8, rows: 3 });
    await renderer.write(encodeAnsiTerminalRepresentation(null, baseline));
    await renderer.write(
      encodeAnsiTerminalPatchRepresentation({ rows: [{ index: 0, row: first }] }, target, baseline),
    );
    const projection = [
      {
        row: 0,
        column: 0,
        chars: "A",
        width: 1,
        wrapped: true,
        foreground: "indexed:196",
        background: "rgb:010203",
        bold: true,
        italic: true,
        underline: true,
      },
    ];
    const keyHex = "0b".repeat(32);
    expect(await renderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(projection, keyHex),
      renditionCellCount: 1,
    });
    renderer.dispose();
  });

  it("normalizes a 132x41 full-space seed to sparse semantic cells and retains styled spaces", async () => {
    const renderer = createXtermRenderer({ reducedMotion: false, label: "sparse seed proof" });
    renderer.resizeGrid({ cols: 132, rows: 41 });
    const blank = blankTerminalReplicaSnapshot(132, 41);
    await renderer.write(encodeAnsiTerminalRepresentation(null, blank));
    const marker = "ANSI_SPARSE_MARKER";
    await renderer.write(new TextEncoder().encode(`\u001b[1;1H${marker}`));
    const projection = [...marker].map((chars, column) => ({
      row: 0,
      column,
      chars,
      width: 1,
      wrapped: false,
      foreground: "default",
      background: "default",
      bold: false,
      italic: false,
      underline: false,
    }));
    const keyHex = "08".repeat(32);
    expect(await renderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor(projection, keyHex),
      renditionCellCount: marker.length,
      wideContinuationCount: 0,
      combiningCount: 0,
      styledCellCount: 0,
    });

    await renderer.write(
      new TextEncoder().encode("\u001b[2;1H\u001b[38;5;196;48;2;1;2;3;1;3;4m \u001b[0m"),
    );
    const styledSpace = {
      row: 1,
      column: 0,
      chars: " ",
      width: 1,
      wrapped: false,
      foreground: "indexed:196",
      background: "rgb:010203",
      bold: true,
      italic: true,
      underline: true,
    };
    expect(await renderer.probeRendition?.(keyHex)).toMatchObject({
      renditionHmac: await renditionProofFor([...projection, styledSpace], keyHex),
      renditionCellCount: marker.length + 1,
      wideContinuationCount: 0,
      combiningCount: 0,
      styledCellCount: 1,
    });
    renderer.dispose();
  });
});
