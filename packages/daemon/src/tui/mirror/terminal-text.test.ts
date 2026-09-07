import { describe, expect, it } from "vitest";
import { terminalDisplayWidth } from "./panel-host.ts";
import { clipTerminal, clipTerminalEnd } from "./terminal-text.ts";

describe("terminal text", () => {
  it("keeps an input caret and complete final graphemes in view", () => {
    expect(clipTerminalEnd("a long name é▏", 4)).toBe("… é▏");
    expect(clipTerminalEnd("a long name 👨‍💻▏", 4)).toBe("…👨‍💻▏");
    expect(clipTerminalEnd("x", 0)).toBe("");
  });
  it("clips by terminal cells without splitting Unicode graphemes", () => {
    const source = "ASCII 分析 Café 👨‍💻 🇳🇱 1️⃣";
    const clipped = clipTerminal(source, 14);

    expect(terminalDisplayWidth(clipped)).toBeLessThanOrEqual(14);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipTerminal(source, terminalDisplayWidth(source))).toBe(source);
    expect(clipTerminal(source, 0)).toBe("");
  });
});
