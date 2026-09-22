import { describe, expect, it } from "vitest";
import { parseTerminalHostColor, terminalHostMode } from "./terminal-host-color.ts";

describe("terminal host color replies", () => {
  it.each([
    "#abc",
    "#aabbcc",
    " RGB:a/b/c ",
    "rgb:aa/bb/cc",
    "rgb:aaa/bbb/ccc",
    "rgb:aaaa/bbbb/cccc",
  ])("normalizes %s to the same renderer-neutral color", (value) => {
    expect(parseTerminalHostColor(value)).toEqual({
      space: "srgb",
      red: 170,
      green: 187,
      blue: 204,
      alpha: 255,
    });
    expect(terminalHostMode(value)).toBe("light");
  });
  it.each([null, undefined, "", "#12", "#gggggg", "rgb:fffff/0/0", "black"])(
    "ignores malformed or unsupported reply %s",
    (value) => {
      expect(parseTerminalHostColor(value)).toBeNull();
      expect(terminalHostMode(value)).toBeNull();
    },
  );
  it("uses the same luminance boundary for hexadecimal and X11 backgrounds", () => {
    for (const [hex, x11, mode] of [
      ["#7f7f7f", "rgb:7f/7f/7f", "dark"],
      ["#808080", "rgb:80/80/80", "light"],
    ]) {
      expect(terminalHostMode(hex)).toBe(mode);
      expect(terminalHostMode(x11)).toBe(mode);
    }
  });
});
