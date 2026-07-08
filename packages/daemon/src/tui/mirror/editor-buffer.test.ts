import { describe, expect, it } from "vitest";
import {
  BINARY_SNIFF_BYTES,
  MAX_EDITABLE_BYTES,
  isBinary,
  classifyFile,
  readOnlyBanner,
  sanitizeForDisplay,
  gutterWidth,
  formatGutter,
  clampTop,
  visibleRange,
  scrollToCursor,
  clickToCursor,
} from "./editor-buffer.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("isBinary", () => {
  it("flags a NUL byte in the sniff window", () => {
    expect(isBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });
  it("treats plain text as non-binary", () => {
    expect(isBinary(bytes("hello\nworld\n"))).toBe(false);
  });
  it("only sniffs the leading window", () => {
    const buf = new Uint8Array(BINARY_SNIFF_BYTES + 10).fill(0x61);
    buf[BINARY_SNIFF_BYTES + 5] = 0x00; // NUL past the window
    expect(isBinary(buf)).toBe(false);
  });
});

describe("classifyFile / readOnlyBanner", () => {
  it("binary wins over size", () => {
    expect(classifyFile(10, true)).toBe("binary");
  });
  it("large text is read-only", () => {
    expect(classifyFile(MAX_EDITABLE_BYTES, false)).toBe("large");
    expect(classifyFile(MAX_EDITABLE_BYTES - 1, false)).toBe(null);
  });
  it("small text is editable (no banner)", () => {
    expect(classifyFile(500, false)).toBe(null);
    expect(readOnlyBanner(null)).toBe(null);
  });
  it("produces banners for read-only reasons", () => {
    expect(readOnlyBanner("binary")).toMatch(/binary/);
    expect(readOnlyBanner("large")).toMatch(/read-only/);
  });
});

describe("sanitizeForDisplay", () => {
  it("keeps printable + newlines/tabs, replaces the rest", () => {
    expect(sanitizeForDisplay(new Uint8Array([0x61, 0x00, 0x0a, 0x09, 0xff, 0x62]))).toBe(
      "a·\n\t·b",
    );
  });
});

describe("gutter", () => {
  it("widens with line count and pads a trailing space", () => {
    expect(gutterWidth(9)).toBe(4); // min 3 digits + space
    expect(gutterWidth(1000)).toBe(5); // 4 digits + space
  });
  it("right-aligns numbers within the gutter", () => {
    expect(formatGutter(7, 4)).toBe("  7 ");
    expect(formatGutter(123, 5)).toBe(" 123 ");
  });
});

describe("clampTop / visibleRange", () => {
  it("never scrolls past the last screenful", () => {
    expect(clampTop(100, 50, 20)).toBe(30);
    expect(clampTop(-5, 50, 20)).toBe(0);
  });
  it("clamps to 0 when everything fits", () => {
    expect(clampTop(5, 10, 20)).toBe(0);
  });
  it("computes the visible window", () => {
    expect(visibleRange(50, 10, 20)).toEqual({ start: 10, end: 30 });
    expect(visibleRange(5, 0, 20)).toEqual({ start: 0, end: 5 });
  });
});

describe("scrollToCursor", () => {
  it("scrolls up when the cursor is above the viewport", () => {
    expect(scrollToCursor(3, 10, 20, 100)).toBe(3);
  });
  it("scrolls down when the cursor is below the viewport", () => {
    expect(scrollToCursor(40, 10, 20, 100)).toBe(21);
  });
  it("keeps top when the cursor is already visible", () => {
    expect(scrollToCursor(15, 10, 20, 100)).toBe(10);
  });
});

describe("clickToCursor", () => {
  const lines = ["hello", "world wide", "x"];
  it("maps a click to line/col accounting for gutter + scroll", () => {
    expect(clickToCursor({ cx: 7, contentY: 1, gutterW: 4, top: 0, lines })).toEqual({
      line: 1,
      col: 3,
    });
  });
  it("clamps past end-of-line to the line length", () => {
    expect(clickToCursor({ cx: 40, contentY: 0, gutterW: 4, top: 0, lines })).toEqual({
      line: 0,
      col: 5,
    });
  });
  it("clamps below the gutter to column 0", () => {
    expect(clickToCursor({ cx: 1, contentY: 2, gutterW: 4, top: 0, lines })).toEqual({
      line: 2,
      col: 0,
    });
  });
  it("clamps past the last line", () => {
    expect(clickToCursor({ cx: 5, contentY: 50, gutterW: 4, top: 0, lines }).line).toBe(2);
  });
});
