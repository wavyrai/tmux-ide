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
        for (const expected of fixture.cells) {
          const cell = terminal.buffer.active.getLine(expected.row)?.getCell(expected.column);
          expect(cell, `${fixture.id} cell ${expected.row}:${expected.column}`).toBeDefined();
          expect(cell!.getChars()).toBe(expected.chars);
          expect(cell!.getWidth()).toBe(expected.width);
          expect(color(cell!, "foreground")).toEqual(expected.foreground);
          expect(color(cell!, "background")).toEqual(expected.background);
          expect(attributes(cell!)).toEqual(expected.attributes ?? []);
        }
      } finally {
        terminal.dispose();
      }
    });
  }
});
