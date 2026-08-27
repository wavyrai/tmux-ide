import { describe, expect, it } from "vitest";

import { memorablePaneName, resolvePaneDisplayName } from "./pane-display-name.ts";

describe("pane display names", () => {
  it("creates stable memorable names from semantic identity", () => {
    expect(memorablePaneName("pane.alpha")).toBe(memorablePaneName("pane.alpha"));
    expect(memorablePaneName("pane.alpha")).toMatch(/^[a-z]+-[a-z]+$/u);
    expect(memorablePaneName("pane.alpha")).not.toBe(memorablePaneName("pane.beta"));
  });

  it("uses a foreground application and returns to the stable idle name", () => {
    expect(
      resolvePaneDisplayName({ semanticPaneId: "pane.alpha", currentCommand: "macmon" }),
    ).toEqual({ name: "macmon", source: "process" });
    expect(resolvePaneDisplayName({ semanticPaneId: "pane.alpha", currentCommand: "zsh" })).toEqual(
      { name: memorablePaneName("pane.alpha"), source: "generated" },
    );
  });

  it("does not mistake a shell hostname for the pane's job", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.alpha",
        currentCommand: "zsh",
        title: "Thijs-MacBook-Pro.fritz.box",
      }),
    ).toEqual({ name: memorablePaneName("pane.alpha"), source: "generated" });
  });

  it("recognizes a persisted deterministic fallback without source metadata", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.alpha",
        configuredName: memorablePaneName("pane.alpha"),
        currentCommand: "macmon",
      }),
    ).toEqual({ name: "macmon", source: "process" });
  });

  it("keeps manual names authoritative over process and title changes", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.alpha",
        configuredName: "My monitor",
        configuredNameSource: "manual",
        currentCommand: "macmon",
        title: "other",
      }),
    ).toEqual({ name: "My monitor", source: "manual" });
  });

  it("preserves agent names and ignores old generic Terminal labels", () => {
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.agent",
        configuredName: "Codex",
        configuredNameSource: "agent",
        currentCommand: "node",
      }),
    ).toEqual({ name: "Codex", source: "agent" });
    expect(
      resolvePaneDisplayName({
        semanticPaneId: "pane.legacy",
        configuredName: "Terminal",
        currentCommand: "zsh",
      }),
    ).toEqual({ name: memorablePaneName("pane.legacy"), source: "generated" });
  });
});
