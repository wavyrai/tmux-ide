import { describe, expect, it } from "vitest";

import { RichCardWidgetArgsSchemaZ, richCardTextFallback } from "../rich-card-widget.ts";

describe("renderer-neutral rich card", () => {
  it("has a useful plain-text fallback for the TUI", () => {
    const card = RichCardWidgetArgsSchemaZ.parse({
      title: "Build",
      subtitle: "Release candidate",
      items: [
        { type: "badge", text: "Tests passed", tone: "success" },
        { type: "progress", label: "Coverage", value: 91.6 },
        { type: "button", label: "Rerun", input: "pnpm test" },
      ],
    });
    expect(richCardTextFallback(card)).toBe(
      "Build\nRelease candidate\nTests passed\nCoverage: 92%\n[Rerun]",
    );
  });

  it("refuses executable or unknown component types", () => {
    expect(
      RichCardWidgetArgsSchemaZ.safeParse({
        title: "Unsafe",
        items: [{ type: "html", html: "<script>" }],
      }).success,
    ).toBe(false);
  });
});
