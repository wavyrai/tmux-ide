/* @vitest-environment happy-dom */
import { Terminal, type IBufferCell } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  TERMINAL_CONFORMANCE_FIXTURES,
  type TerminalConformanceAttribute,
  type TerminalConformanceColor,
} from "@tmux-ide/core";
import { describe, expect, it } from "vitest";

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function color(cell: IBufferCell, channel: "foreground" | "background"): TerminalConformanceColor {
  const foreground = channel === "foreground";
  if (foreground ? cell.isFgDefault() : cell.isBgDefault()) return { kind: "default" };
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
    return { kind: "indexed", index: foreground ? cell.getFgColor() : cell.getBgColor() };
  }
  return { kind: "rgb", value: foreground ? cell.getFgColor() : cell.getBgColor() };
}

function attributes(cell: IBufferCell): TerminalConformanceAttribute[] {
  const result: TerminalConformanceAttribute[] = [];
  if (cell.isBold()) result.push("bold");
  if (cell.isDim()) result.push("dim");
  if (cell.isItalic()) result.push("italic");
  if (cell.isUnderline()) result.push("underline");
  if (cell.isBlink()) result.push("blink");
  if (cell.isInverse()) result.push("inverse");
  if (cell.isInvisible()) result.push("hidden");
  if (cell.isStrikethrough()) result.push("strikethrough");
  return result;
}

describe("xterm.js terminal conformance", () => {
  for (const fixture of TERMINAL_CONFORMANCE_FIXTURES) {
    it(fixture.description, async () => {
      const terminal = new Terminal({
        allowProposedApi: true,
        cols: fixture.cols,
        rows: fixture.rows,
      });
      try {
        terminal.loadAddon(new Unicode11Addon());
        terminal.unicode.activeVersion = "11";
        for (const chunk of fixture.writes) await write(terminal, chunk);
        const buffer = terminal.buffer.active;
        for (const expected of fixture.cells) {
          // Fixture rows describe the canonical live grid, while xterm's line
          // indices include scrollback. Anchor reads to the bottom page so
          // history can never masquerade as viewport state.
          const cell = buffer.getLine(buffer.baseY + expected.row)?.getCell(expected.column);
          expect(cell, `${fixture.id} cell ${expected.row}:${expected.column}`).toBeDefined();
          expect(cell!.getChars()).toBe(expected.chars);
          expect(cell!.getWidth()).toBe(expected.width);
          expect(color(cell!, "foreground")).toEqual(expected.foreground);
          expect(color(cell!, "background")).toEqual(expected.background);
          expect(attributes(cell!)).toEqual(expected.attributes ?? []);
        }
        expect(
          Array.from({ length: fixture.rows }, (_, row) => row).filter(
            (row) => buffer.getLine(buffer.baseY + row)?.isWrapped,
          ),
          `${fixture.id} wrapped rows`,
        ).toEqual(fixture.wrappedRows ?? []);
        if (fixture.historyRows !== undefined) {
          expect(buffer.baseY, `${fixture.id} history rows`).toBe(fixture.historyRows);
        }
        // `fixture.cursor` is the authoritative PTY cursor supplied separately
        // to the canonical interpreter; this parser-only Web oracle has only
        // the ANSI writes, so its local post-write cursor is intentionally not
        // compared with that external authority.
        if (fixture.modes) {
          expect(
            {
              alternateScreen: buffer.type === "alternate",
              applicationCursor: terminal.modes.applicationCursorKeysMode,
              applicationKeypad: terminal.modes.applicationKeypadMode,
              bracketedPaste: terminal.modes.bracketedPasteMode,
              insert: terminal.modes.insertMode,
              origin: terminal.modes.originMode,
              wraparound: terminal.modes.wraparoundMode,
              mouseTracking: terminal.modes.mouseTrackingMode !== "none",
              synchronizedOutput: terminal.modes.synchronizedOutputMode,
            },
            `${fixture.id} modes`,
          ).toMatchObject(fixture.modes);
        }
      } finally {
        terminal.dispose();
      }
    });
  }
});
