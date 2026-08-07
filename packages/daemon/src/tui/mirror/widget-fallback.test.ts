import { describe, expect, it } from "vitest";

import { tuiWidgetFallback } from "./widget-fallback.ts";

describe("OpenTUI widget fallback", () => {
  it("projects Markdown and cards without browser-only component assumptions", () => {
    expect(tuiWidgetFallback({ id: "markdown", args: { text: "# Plan" }, lineIndex: 0 })).toEqual({
      label: "Markdown",
      text: "# Plan",
      interactive: false,
    });
    expect(
      tuiWidgetFallback({
        id: "card",
        args: { title: "Build", items: [{ type: "progress", value: 60 }] },
        lineIndex: 0,
      })?.text,
    ).toBe("Build\n60%");
  });

  it("fails closed for malformed or unknown descriptors", () => {
    expect(tuiWidgetFallback({ id: "image", args: { assetId: "../x" }, lineIndex: 0 })).toBe(null);
    expect(tuiWidgetFallback({ id: "react", args: {}, lineIndex: 0 })).toBe(null);
  });
});
