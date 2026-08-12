import { describe, expect, it, spyOn } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import { encodeWidgetMarkerLine, type TerminalReplicaRow } from "@tmux-ide/contracts";
import { blankTerminalReplicaSnapshot, hashTerminalWidgetContent } from "@tmux-ide/core";

import { createSemanticThemeSnapshot } from "../../theme.ts";
import type { RichPreviewRequest } from "./contract.ts";
import { createRichPreviewFeatureSession } from "./feature.tsx";

function request(text: string): RichPreviewRequest {
  const args = { text };
  const digest = hashTerminalWidgetContent("markdown", args);
  const snapshot = structuredClone(blankTerminalReplicaSnapshot(80, 10));
  const marker = encodeWidgetMarkerLine("markdown", args);
  const row: TerminalReplicaRow = {
    wrapped: false,
    cells: [...marker].map((grapheme) => ({
      grapheme,
      width: 1,
      foreground: { kind: "default" },
      background: { kind: "default" },
      attributes: 0,
    })),
  };
  snapshot.grid[0] = row;
  const placement = {
    id: "markdown",
    kind: "widget",
    row: 0,
    column: 0,
    rows: 8,
    columns: 80,
    contentDigest: digest,
  };
  snapshot.placements = [placement];
  return {
    authority: {
      workspaceId: "workspace",
      workspaceGeneration: "11111111-1111-4111-8111-111111111111",
      paneId: "pane",
      paneGeneration: "pane:g1",
      renderableId: "rich:markdown",
      contentDigest: digest,
    },
    snapshot,
    placement,
    visible: true,
  };
}

describe("rich preview feature lifecycle", () => {
  it("owns SyntaxStyle only while resolved Markdown is visible and retires replacements after a native frame", () => {
    let theme = createSemanticThemeSnapshot({ mode: "dark" });
    const frames: Array<() => void> = [];
    const destroyed = spyOn(SyntaxStyle.prototype, "destroy");
    const feature = createRichPreviewFeatureSession({
      theme: () => theme,
      loadAsset: async () => ({ status: "error", reason: "unavailable" }),
      onChange: () => undefined,
      afterNativeFrame: (callback) => frames.push(callback),
    });
    expect(feature.syntaxStyle()).toBeNull();
    feature.sync([request("# One")]);
    feature.publications();
    const first = feature.syntaxStyle();
    expect(first).toBeInstanceOf(SyntaxStyle);

    theme = createSemanticThemeSnapshot({ mode: "light" });
    feature.syncTheme();
    const second = feature.syntaxStyle();
    expect(second).toBeInstanceOf(SyntaxStyle);
    expect(second).not.toBe(first);
    expect(destroyed).not.toHaveBeenCalled();
    frames.splice(0).forEach((frame) => frame());
    expect(destroyed).toHaveBeenCalledTimes(1);

    feature.sync([]);
    expect(feature.syntaxStyle()).toBeNull();
    frames.splice(0).forEach((frame) => frame());
    expect(destroyed).toHaveBeenCalledTimes(2);
    feature.dispose();
    frames.splice(0).forEach((frame) => frame());
    expect(destroyed).toHaveBeenCalledTimes(2);
    destroyed.mockRestore();
  });

  it("destroys frame-pending native styles exactly once during shutdown", () => {
    let theme = createSemanticThemeSnapshot({ mode: "dark" });
    const frames: Array<() => void> = [];
    const destroyed = spyOn(SyntaxStyle.prototype, "destroy");
    const feature = createRichPreviewFeatureSession({
      theme: () => theme,
      loadAsset: async () => ({ status: "error", reason: "unavailable" }),
      onChange: () => undefined,
      afterNativeFrame: (callback) => frames.push(callback),
    });
    feature.sync([request("# One")]);
    feature.publications();
    theme = createSemanticThemeSnapshot({ mode: "light" });
    feature.syncTheme();
    feature.dispose();
    expect(destroyed).not.toHaveBeenCalled();
    frames.splice(0).forEach((frame) => frame());
    expect(destroyed).toHaveBeenCalledTimes(2);
    destroyed.mockRestore();
  });
});
