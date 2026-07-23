/**
 * Unit tests for the pure tmux control-mode protocol helpers.
 */
import { describe, expect, it } from "vitest";
import { decodeControlBytes, parseControlLine, textToHexKeys } from "./control.ts";

const dec = new TextDecoder();

describe("decodeControlBytes", () => {
  it("passes plain text through", () => {
    expect(dec.decode(decodeControlBytes("hello"))).toBe("hello");
  });

  it("decodes octal escapes to control bytes", () => {
    expect(dec.decode(decodeControlBytes("a\\015\\012b"))).toBe("a\r\nb");
    expect(dec.decode(decodeControlBytes("\\033[31m"))).toBe("\x1b[31m");
  });

  it("decodes an escaped backslash", () => {
    expect(dec.decode(decodeControlBytes("a\\134b"))).toBe("a\\b");
  });

  it("keeps a lone backslash that is not an octal escape", () => {
    expect(dec.decode(decodeControlBytes("a\\zb"))).toBe("a\\zb");
  });

  it("reassembles multi-byte UTF-8 from escaped bytes", () => {
    // "é" = 0xC3 0xA9 → \303\251
    expect(dec.decode(decodeControlBytes("caf\\303\\251"))).toBe("café");
  });
});

describe("parseControlLine", () => {
  it("parses begin/end/error with their reply number", () => {
    expect(parseControlLine("%begin 123 7 0", false)).toEqual({ kind: "begin", num: 7 });
    expect(parseControlLine("%end 123 7 0", true)).toEqual({ kind: "end", num: 7 });
    expect(parseControlLine("%error 123 7 0", true)).toEqual({ kind: "error", num: 7 });
  });

  it("parses %output with pane id and decoded bytes", () => {
    const evt = parseControlLine("%output %3 hi\\015", false);
    expect(evt.kind).toBe("output");
    if (evt.kind === "output") {
      expect(evt.pane).toBe("%3");
      expect(dec.decode(evt.data)).toBe("hi\r");
    }
  });

  it("treats %-prefixed lines inside a reply block as body text", () => {
    expect(parseControlLine("%output %3 fake", true)).toEqual({
      kind: "reply-line",
      line: "%output %3 fake",
    });
  });

  it("parses %exit with and without a reason", () => {
    expect(parseControlLine("%exit", false)).toEqual({ kind: "exit", reason: null });
    expect(parseControlLine("%exit detached", false)).toEqual({
      kind: "exit",
      reason: "detached",
    });
  });

  it("surfaces other notifications with name and rest", () => {
    expect(parseControlLine("%layout-change @1 abc", false)).toEqual({
      kind: "notify",
      name: "layout-change",
      rest: "@1 abc",
    });
  });

  it("parses %extended-output with age telemetry and decoded bytes", () => {
    const evt = parseControlLine("%extended-output %5 1234 : hi\\015\\012", false);
    expect(evt.kind).toBe("extended-output");
    if (evt.kind === "extended-output") {
      expect(evt.pane).toBe("%5");
      expect(evt.ageMs).toBe(1234);
      expect(dec.decode(evt.data)).toBe("hi\r\n");
    }
  });

  it("keeps an %extended-output payload containing the separator intact", () => {
    const evt = parseControlLine("%extended-output %5 0 : a : b", false);
    if (evt.kind === "extended-output") {
      expect(dec.decode(evt.data)).toBe("a : b");
    } else {
      expect.unreachable("expected extended-output");
    }
  });

  it("degrades an unparseable %extended-output age to null", () => {
    const evt = parseControlLine("%extended-output %5 soon extra : x", false);
    if (evt.kind === "extended-output") {
      expect(evt.ageMs).toBeNull();
      expect(dec.decode(evt.data)).toBe("x");
    } else {
      expect.unreachable("expected extended-output");
    }
  });

  it("treats %extended-output inside a reply block as body text", () => {
    expect(parseControlLine("%extended-output %5 0 : fake", true)).toEqual({
      kind: "reply-line",
      line: "%extended-output %5 0 : fake",
    });
  });
});

describe("textToHexKeys", () => {
  it("encodes ASCII and multi-byte UTF-8 as hex bytes", () => {
    expect(textToHexKeys("hi")).toEqual(["68", "69"]);
    expect(textToHexKeys("é")).toEqual(["c3", "a9"]);
  });
});
