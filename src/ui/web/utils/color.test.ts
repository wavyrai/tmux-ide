import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rgbaToCSS, attributesToStyle } from "./color.ts";
import { rgbaFromInts, TextAttributes } from "../../types.ts";

describe("rgbaToCSS", () => {
  it("converts opaque color to rgb()", () => {
    assert.strictEqual(rgbaToCSS({ r: 255, g: 128, b: 0, a: 255 }), "rgb(255,128,0)");
  });

  it("converts transparent (a=0) to 'transparent'", () => {
    assert.strictEqual(rgbaToCSS({ r: 100, g: 100, b: 100, a: 0 }), "transparent");
  });

  it("converts semi-transparent color to rgba()", () => {
    assert.strictEqual(rgbaToCSS({ r: 10, g: 20, b: 30, a: 128 }), "rgba(10,20,30,0.50)");
  });

  it("handles rgbaFromInts()", () => {
    const color = rgbaFromInts(75, 0, 130);
    assert.strictEqual(rgbaToCSS(color), "rgb(75,0,130)");
  });

  it("rgbaFromInts defaults a to 255", () => {
    const color = rgbaFromInts(1, 2, 3);
    assert.strictEqual(color.a, 255);
  });

  it("rgbaFromInts accepts explicit alpha", () => {
    const color = rgbaFromInts(1, 2, 3, 100);
    assert.strictEqual(color.a, 100);
    assert.strictEqual(rgbaToCSS(color), "rgba(1,2,3,0.39)");
  });
});

describe("attributesToStyle", () => {
  it("returns empty object for NONE", () => {
    assert.deepStrictEqual(attributesToStyle(TextAttributes.NONE), {});
  });

  it("maps BOLD to font-weight", () => {
    const style = attributesToStyle(TextAttributes.BOLD);
    assert.strictEqual(style["font-weight"], "bold");
  });

  it("maps DIM to opacity", () => {
    const style = attributesToStyle(TextAttributes.DIM);
    assert.strictEqual(style.opacity, "0.6");
  });

  it("maps ITALIC to font-style", () => {
    const style = attributesToStyle(TextAttributes.ITALIC);
    assert.strictEqual(style["font-style"], "italic");
  });

  it("maps UNDERLINE to text-decoration", () => {
    const style = attributesToStyle(TextAttributes.UNDERLINE);
    assert.strictEqual(style["text-decoration"], "underline");
  });

  it("maps STRIKETHROUGH to text-decoration", () => {
    const style = attributesToStyle(TextAttributes.STRIKETHROUGH);
    assert.strictEqual(style["text-decoration"], "line-through");
  });

  it("composes UNDERLINE + STRIKETHROUGH", () => {
    const style = attributesToStyle(TextAttributes.UNDERLINE | TextAttributes.STRIKETHROUGH);
    assert.strictEqual(style["text-decoration"], "underline line-through");
  });

  it("maps BLINK to animation", () => {
    const style = attributesToStyle(TextAttributes.BLINK);
    assert.ok(style.animation?.includes("blink"));
  });

  it("maps INVERSE to filter invert", () => {
    const style = attributesToStyle(TextAttributes.INVERSE);
    assert.strictEqual(style.filter, "invert(1)");
  });

  it("maps HIDDEN to visibility hidden", () => {
    const style = attributesToStyle(TextAttributes.HIDDEN);
    assert.strictEqual(style.visibility, "hidden");
  });

  it("composes multiple attributes", () => {
    const style = attributesToStyle(
      TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE,
    );
    assert.strictEqual(style["font-weight"], "bold");
    assert.strictEqual(style["font-style"], "italic");
    assert.strictEqual(style["text-decoration"], "underline");
  });
});
