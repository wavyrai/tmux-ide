import { describe, expect, it } from "vitest";
import {
  hasUnsafeText,
  plainTextSchema,
  terminalSafe,
  terminalSafeBlock,
  terminalSafeDeep,
} from "../plain-text.ts";

const UNSAFE = [
  "\u0000",
  "\u0007",
  "\t",
  "\n",
  "\r",
  "\u001b",
  "\u007f",
  "\u0080",
  "\u0085",
  "\u009b",
  "\u009f",
  "\u061c",
  "\u200e",
  "\u200f",
  "\u202a",
  "\u202e",
  "\u2066",
  "\u2069",
];

describe("plain text", () => {
  it("finds every control, DEL, C1 and bidi control character", () => {
    for (const char of UNSAFE) expect(hasUnsafeText(`a${char}b`), JSON.stringify(char)).toBe(true);
    for (const text of ["", "plain", "Café ✓ 日本 🚀", " ", "‍", " x"])
      expect(hasUnsafeText(text), JSON.stringify(text)).toBe(false);
  });

  it("replaces unsafe characters with spaces and caps the length", () => {
    expect(terminalSafe("a\u001b[2Jb\u202ec")).toBe("a [2Jb c");
    expect(terminalSafe("x".repeat(50), 10)).toBe("x".repeat(10));
    expect(terminalSafeBlock("one\n\ttwo\r\u001bthree")).toBe("one\n\ttwo  three");
  });

  it("cleans every string in a JSON value, keys included", () => {
    expect(
      terminalSafeDeep({ "k\u0007\n": ["v\u009b", 1, true, null, { n: "\u202e\nx\ty\r" }] }),
    ).toEqual({ "k  ": ["v ", 1, true, null, { n: " \nx\ty " }] });
  });

  it("schema refuses unsafe text and enforces the length", () => {
    const schema = plainTextSchema(1, 5);
    expect(schema.safeParse("ok").success).toBe(true);
    expect(schema.safeParse("").success).toBe(false);
    expect(schema.safeParse("toolong").success).toBe(false);
    expect(schema.safeParse("a\nb").success).toBe(false);
  });
});
