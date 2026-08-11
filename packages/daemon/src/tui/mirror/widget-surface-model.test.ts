import { describe, expect, it } from "vitest";

import type { StoredWidgetAsset } from "../../lib/widget-asset-store.ts";
import { normalizeMarkdownForTui, resolveTuiWidgetSurface } from "./widget-surface-model.ts";

describe("normalizeMarkdownForTui", () => {
  it("drops README HTML scaffolding without touching fenced HTML examples", () => {
    expect(
      normalizeMarkdownForTui(`
<p align="center">
  <picture>
    <img src="badge.png" />
  </picture>
</p>
<h1 align="center">Hidden browser heading</h1>
## Install

\`\`\`html
<main>kept as code</main>
\`\`\`
Use <kbd>Enter</kbd> to continue.
`),
    ).toBe(`## Install

\`\`\`html
<main>kept as code</main>
\`\`\`
Use Enter to continue.
`);
  });
});

const ASSET_ID = "a".repeat(64);

function markdownAsset(text: string): StoredWidgetAsset {
  return {
    version: 1,
    assetId: ASSET_ID,
    media: "text/markdown",
    name: "PLAN.md",
    byteLength: Buffer.byteLength(text),
    createdAt: new Date().toISOString(),
    bytes: Buffer.from(text),
  };
}

describe("OpenTUI rich widget projection", () => {
  it("projects inline Markdown into the native Markdown surface", () => {
    expect(
      resolveTuiWidgetSurface(
        { id: "markdown", args: { text: "# Plan", title: "Roadmap" }, lineIndex: 0 },
        () => null,
      ),
    ).toEqual({ kind: "markdown", label: "Markdown", title: "Roadmap", text: "# Plan" });
  });

  it("loads content-addressed Markdown without exposing its original path", () => {
    expect(
      resolveTuiWidgetSurface({ id: "markdown", args: { assetId: ASSET_ID }, lineIndex: 0 }, () =>
        markdownAsset("# Asset plan"),
      ),
    ).toEqual({
      kind: "markdown",
      label: "Markdown",
      title: "PLAN.md",
      text: "# Asset plan",
    });
  });

  it("keeps image behavior capability-honest in a generic terminal host", () => {
    const surface = resolveTuiWidgetSurface(
      { id: "image", args: { assetId: ASSET_ID, name: "demo.gif" }, lineIndex: 0 },
      () => null,
    );
    expect(surface).toMatchObject({ kind: "fallback", label: "Image" });
    expect(surface?.text).toContain("Animated images render in the web GUI");
  });

  it("shows an honest fallback for canonical placement metadata without content", () => {
    expect(
      resolveTuiWidgetSurface(
        {
          id: "markdown",
          args: {
            semanticPlacement: {
              id: "markdown",
              kind: "widget",
              row: 2,
              column: 0,
              columns: 80,
              rows: 1,
              contentDigest: "abcd1234",
            },
          },
          lineIndex: 2,
        },
        () => null,
      ),
    ).toMatchObject({ kind: "fallback", label: "Markdown" });
  });

  it("leaves ordinary terminal content outside the widget surface", () => {
    expect(
      resolveTuiWidgetSurface({ id: "shell-output", args: null, lineIndex: 0 }, () => null),
    ).toBeNull();
  });
});
