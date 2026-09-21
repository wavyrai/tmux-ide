import { Terminal } from "@tmux-ide/xterm-headless";
import { describe, expect, it } from "vitest";

import { optimizeRendererFrame } from "./renderer-frame-optimizer.ts";

const start = "\x1b[?2026h\x1b[?25l";
const end = "\x1b[0m\x1b[?25h\x1b[?2026l";
const reset = "\x1b[0m";
const style = "\x1b[38;2;222;222;230m\x1b[48;2;11;11;16m";
const frame = (body: string) => Buffer.from(start + body + end);

async function snapshot(bytes: Uint8Array) {
  const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  try {
    // Deliberately inherit attributes from before the frame, then inspect
    // subsequent unstyled text to catch a changed final attribute state too.
    await new Promise<void>((resolve) => terminal.write("\x1b[3m\x1b[31m", resolve));
    await new Promise<void>((resolve) => terminal.write(bytes, resolve));
    await new Promise<void>((resolve) => terminal.write("\x1b[10;1Hafter", resolve));
    return {
      x: terminal.buffer.active.cursorX,
      y: terminal.buffer.active.cursorY,
      cells: Array.from({ length: 10 }, (_, y) =>
        Array.from({ length: 40 }, (_, x) => {
          const cell = terminal.buffer.active.getLine(y)!.getCell(x)!;
          return [
            cell.getChars(),
            cell.getWidth(),
            cell.getFgColor(),
            cell.getBgColor(),
            cell.getFgColorMode(),
            cell.getBgColorMode(),
            cell.isBold(),
            cell.isItalic(),
            cell.isUnderline(),
            cell.isInverse(),
            cell.isDim(),
          ];
        }),
      ),
    };
  } finally {
    terminal.dispose();
  }
}

describe("conservative renderer SGR optimization", () => {
  it("elides only repeated style transitions while retaining cursor positions and final reset", async () => {
    const input = frame(
      reset +
        "\x1b[2;2H" +
        style +
        "first" +
        reset +
        "\x1b[3;2H" +
        style +
        "second" +
        reset +
        "\x1b[4;2H" +
        style +
        "third",
    );
    const output = optimizeRendererFrame(input);
    expect(Buffer.from(output).toString()).toBe(
      start + reset + "\x1b[2;2H" + style + "first\x1b[3;2Hsecond\x1b[4;2Hthird" + end,
    );
    expect(output.byteLength).toBeLessThan(input.byteLength);
    expect(await snapshot(output)).toEqual(await snapshot(input));
  });

  it("does not assume reset attributes on entry", async () => {
    const input = frame(
      "\x1b[2;2H" + style + "inherited italic" + reset + "\x1b[3;2H" + style + "plain",
    );
    expect(optimizeRendererFrame(input)).toBe(input);
    expect(await snapshot(optimizeRendererFrame(input))).toEqual(await snapshot(input));
  });

  it.each(["界 café e\u0301 😀", "styled", "at the right edge 123456789012345678901234567890"])(
    "preserves cells and attributes for %s",
    async (text) => {
      const input = frame(
        reset +
          "\x1b[2;2H" +
          style +
          "\x1b[1m" +
          text +
          reset +
          "\x1b[3;2H" +
          style +
          "\x1b[1m" +
          text +
          reset +
          "\x1b[5;3H\x1b[32mchanged",
      );
      const optimized = optimizeRendererFrame(input);
      expect(optimized.byteLength).toBeLessThan(input.byteLength);
      expect(await snapshot(optimized)).toEqual(await snapshot(input));
    },
  );

  it.each([
    "\x1b]8;;https://example.com\x1b\\",
    "\x1b[2J",
    "\x1b[38;2;999;0;0m",
    "\x1b[1;3m",
    "\n",
    "\x1b[",
    "\x1b[?2026h",
  ])("returns the complete input unchanged for unsupported or malformed control %j", (control) => {
    const input = frame(
      reset + "\x1b[2;2H" + style + "first" + reset + "\x1b[3;2H" + style + "second" + control,
    );
    expect(optimizeRendererFrame(input)).toBe(input);
  });

  it("returns incomplete frames, multiple frames, BOM-prefixed data and malformed UTF-8 unchanged", () => {
    const valid = frame(
      reset + "\x1b[2;2H" + style + "first" + reset + "\x1b[3;2H" + style + "second",
    );
    for (const input of [
      valid.subarray(0, -1),
      Buffer.concat([valid, valid]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
      Buffer.concat([valid.subarray(0, 20), Buffer.from([0xff]), valid.subarray(20)]),
    ]) {
      expect(optimizeRendererFrame(input)).toBe(input);
    }
  });
});
