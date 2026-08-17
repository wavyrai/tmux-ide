import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Terminal as ForkTerminal } from "@tmux-ide/xterm-headless";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { TERMINAL_CONFORMANCE_FIXTURES } from "@tmux-ide/core";

const require = createRequire(import.meta.url);
const { Terminal: StockTerminal } = require("@xterm/headless-stock") as {
  Terminal: new (options: {
    cols: number;
    rows: number;
    scrollback: number;
    allowProposedApi: boolean;
  }) => StockTerminalShape;
};

interface StockTerminalShape {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: ForkTerminal["buffer"];
  readonly modes: ForkTerminal["modes"];
  readonly unicode: ForkTerminal["unicode"];
  loadAddon(addon: Unicode11Addon): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
}

function write(
  terminal: Pick<StockTerminalShape, "write">,
  data: string | Uint8Array,
): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function snapshot(terminal: Pick<StockTerminalShape, "buffer" | "cols" | "modes" | "rows">) {
  const core = (
    terminal as unknown as {
      _core?: {
        coreService?: {
          isCursorHidden?: boolean;
          decPrivateModes?: Record<string, unknown>;
          modes?: Record<string, unknown>;
        };
      };
    }
  )._core?.coreService;
  const snapshotBuffer = (buffer: ForkTerminal["buffer"]["active"]) => {
    const cell = buffer.getNullCell();
    return {
      type: buffer.type,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      viewportY: buffer.viewportY,
      baseY: buffer.baseY,
      length: buffer.length,
      lines: Array.from({ length: buffer.length }, (_, row) => {
        const line = buffer.getLine(row);
        return {
          wrapped: line?.isWrapped ?? false,
          cells: Array.from({ length: terminal.cols }, (_, column) => {
            line?.getCell(column, cell);
            return {
              chars: line ? cell.getChars() : "",
              code: line ? cell.getCode() : 0,
              width: line ? cell.getWidth() : 1,
              fg: line ? cell.getFgColor() : -1,
              bg: line ? cell.getBgColor() : -1,
              fgMode: line ? cell.getFgColorMode() : 0,
              bgMode: line ? cell.getBgColorMode() : 0,
              fgRgb: line ? cell.isFgRGB() : false,
              bgRgb: line ? cell.isBgRGB() : false,
              fgPalette: line ? cell.isFgPalette() : false,
              bgPalette: line ? cell.isBgPalette() : false,
              fgDefault: line ? cell.isFgDefault() : true,
              bgDefault: line ? cell.isBgDefault() : true,
              bold: line ? cell.isBold() : 0,
              dim: line ? cell.isDim() : 0,
              italic: line ? cell.isItalic() : 0,
              underline: line ? cell.isUnderline() : 0,
              blink: line ? cell.isBlink() : 0,
              inverse: line ? cell.isInverse() : 0,
              invisible: line ? cell.isInvisible() : 0,
              strikethrough: line ? cell.isStrikethrough() : 0,
              overline: line ? cell.isOverline() : 0,
              attributeDefault: line ? cell.isAttributeDefault() : true,
            };
          }),
        };
      }),
    };
  };
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    cursorHidden: core?.isCursorHidden,
    activeBuffer: terminal.buffer.active.type,
    normal: snapshotBuffer(terminal.buffer.normal),
    alternate: snapshotBuffer(terminal.buffer.alternate),
    modes: terminal.modes,
    decPrivateModes: core?.decPrivateModes,
    ansiModes: core?.modes,
  };
}

describe("pinned xterm headless fork", () => {
  it("admits exactly one prioritized idle write and leaves the next write asynchronous", async () => {
    const terminal = new ForkTerminal({ allowProposedApi: true });
    let first = false;
    terminal.prioritizeNextWrite();
    terminal.write("a", () => {
      first = true;
    });
    expect(first).toBe(true);

    let second = false;
    const completed = new Promise<void>((resolve) => {
      terminal.write("b", () => {
        second = true;
        resolve();
      });
    });
    expect(second).toBe(false);
    await completed;
    terminal.dispose();
  });

  it("is state-identical to stock xterm after every prioritized conformance chunk", async () => {
    for (const fixture of TERMINAL_CONFORMANCE_FIXTURES) {
      const options = {
        cols: fixture.cols,
        rows: fixture.rows,
        scrollback: 16,
        allowProposedApi: true,
      } as const;
      const fork = new ForkTerminal(options);
      const stock = new StockTerminal(options);
      fork.loadAddon(new Unicode11Addon());
      stock.loadAddon(new Unicode11Addon());
      fork.unicode.activeVersion = "11";
      stock.unicode.activeVersion = "11";
      for (const data of fixture.writes) {
        fork.prioritizeNextWrite();
        await Promise.all([write(fork, data), write(stock, data)]);
        expect(snapshot(fork), fixture.id).toEqual(snapshot(stock));
      }
      fork.dispose();
      stock.dispose();
    }
  });

  it("stays differential-identical for split UTF-8, resize, alt-screen, history and DEC sync", async () => {
    const options = { cols: 6, rows: 2, scrollback: 4, allowProposedApi: true } as const;
    const fork = new ForkTerminal(options);
    const stock = new StockTerminal(options);
    fork.loadAddon(new Unicode11Addon());
    stock.loadAddon(new Unicode11Addon());
    fork.unicode.activeVersion = "11";
    stock.unicode.activeVersion = "11";
    const operations: Array<
      { type: "write"; data: string | Uint8Array } | { type: "resize"; cols: number; rows: number }
    > = [
      { type: "write", data: Uint8Array.of(0xe7) },
      { type: "write", data: Uint8Array.of(0x95) },
      { type: "write", data: Uint8Array.of(0x8c) },
      { type: "resize", cols: 8, rows: 3 },
      { type: "write", data: "\u001b[?1049h" },
      { type: "write", data: "ALT" },
      { type: "write", data: "\u001b[?1049l" },
      { type: "write", data: "\r\n1\r\n2\r\n3\r\n4\r\n5" },
      { type: "write", data: "\u001b[?2026h" },
      { type: "write", data: "\u001b[31;53mSYNC\u001b[0m" },
      { type: "resize", cols: 7, rows: 2 },
      { type: "write", data: "\u001b[?2026l" },
    ];
    for (const operation of operations) {
      if (operation.type === "resize") {
        fork.resize(operation.cols, operation.rows);
        stock.resize(operation.cols, operation.rows);
      } else {
        fork.prioritizeNextWrite();
        await Promise.all([write(fork, operation.data), write(stock, operation.data)]);
      }
      expect(snapshot(fork)).toEqual(snapshot(stock));
    }
    fork.dispose();
    stock.dispose();
  });
});
