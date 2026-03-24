import { describe, it, expect } from "bun:test";
import { rgbaToCSS, attributesToStyle } from "./color.ts";
import { rgbaFromInts, TextAttributes } from "../../types.ts";

describe("rgbaToCSS", () => {
  it("converts opaque color to rgb()", () => {
    expect(rgbaToCSS({ r: 255, g: 128, b: 0, a: 255 })).toBe("rgb(255,128,0)");
  });

  it("converts transparent (a=0) to 'transparent'", () => {
    expect(rgbaToCSS({ r: 100, g: 100, b: 100, a: 0 })).toBe("transparent");
  });

  it("converts semi-transparent color to rgba()", () => {
    expect(rgbaToCSS({ r: 10, g: 20, b: 30, a: 128 })).toBe("rgba(10,20,30,0.50)");
  });

  it("handles rgbaFromInts()", () => {
    const color = rgbaFromInts(75, 0, 130);
    expect(rgbaToCSS(color)).toBe("rgb(75,0,130)");
  });

  it("rgbaFromInts defaults a to 255", () => {
    const color = rgbaFromInts(1, 2, 3);
    expect(color.a).toBe(255);
  });

  it("rgbaFromInts accepts explicit alpha", () => {
    const color = rgbaFromInts(1, 2, 3, 100);
    expect(color.a).toBe(100);
    expect(rgbaToCSS(color)).toBe("rgba(1,2,3,0.39)");
  });
});

describe("attributesToStyle", () => {
  it("returns empty object for NONE", () => {
    expect(attributesToStyle(TextAttributes.NONE)).toEqual({});
  });

  it("maps BOLD to font-weight", () => {
    const style = attributesToStyle(TextAttributes.BOLD);
    expect(style["font-weight"]).toBe("bold");
  });

  it("maps DIM to opacity", () => {
    const style = attributesToStyle(TextAttributes.DIM);
    expect(style.opacity).toBe("0.6");
  });

  it("maps ITALIC to font-style", () => {
    const style = attributesToStyle(TextAttributes.ITALIC);
    expect(style["font-style"]).toBe("italic");
  });

  it("maps UNDERLINE to text-decoration", () => {
    const style = attributesToStyle(TextAttributes.UNDERLINE);
    expect(style["text-decoration"]).toBe("underline");
  });

  it("maps STRIKETHROUGH to text-decoration", () => {
    const style = attributesToStyle(TextAttributes.STRIKETHROUGH);
    expect(style["text-decoration"]).toBe("line-through");
  });

  it("composes UNDERLINE + STRIKETHROUGH", () => {
    const style = attributesToStyle(TextAttributes.UNDERLINE | TextAttributes.STRIKETHROUGH);
    expect(style["text-decoration"]).toBe("underline line-through");
  });

  it("maps BLINK to animation", () => {
    const style = attributesToStyle(TextAttributes.BLINK);
    expect(style.animation?.includes("blink")).toBeTruthy();
  });

  it("maps INVERSE to filter invert", () => {
    const style = attributesToStyle(TextAttributes.INVERSE);
    expect(style.filter).toBe("invert(1)");
  });

  it("maps HIDDEN to visibility hidden", () => {
    const style = attributesToStyle(TextAttributes.HIDDEN);
    expect(style.visibility).toBe("hidden");
  });

  it("composes multiple attributes", () => {
    const style = attributesToStyle(
      TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE,
    );
    expect(style["font-weight"]).toBe("bold");
    expect(style["font-style"]).toBe("italic");
    expect(style["text-decoration"]).toBe("underline");
  });
});
