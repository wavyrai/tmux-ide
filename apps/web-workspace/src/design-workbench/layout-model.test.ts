import { describe, expect, it } from "vitest";
import {
  initialLayout,
  movePane,
  paneIds,
  removePane,
  setSplitRatio,
  splitPane,
  swapPanes,
  type LayoutNode,
  type PaneEdge,
} from "./layout-model";

describe("design workbench layout", () => {
  it("starts with Claude beside a stacked Codex and shell", () => {
    expect(paneIds(initialLayout)).toEqual(["claude", "codex", "shell"]);
    expect(initialLayout).toMatchObject({ axis: "horizontal", second: { axis: "vertical" } });
  });

  it("moves every pane to every target edge without losing or duplicating panes", () => {
    const before = JSON.stringify(initialLayout);
    for (const source of paneIds(initialLayout)) {
      for (const target of paneIds(initialLayout)) {
        if (source === target) continue;
        for (const edge of ["left", "right", "top", "bottom"] as PaneEdge[]) {
          const result = movePane(initialLayout, source, target, edge, "moved");
          expect(paneIds(result).sort()).toEqual(["claude", "codex", "shell"]);
          const find = (node: LayoutNode): LayoutNode | undefined => {
            if (node.id === "moved") return node;
            return node.type === "split" ? (find(node.first) ?? find(node.second)) : undefined;
          };
          expect(find(result)).toMatchObject({
            axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
            first: { id: edge === "left" || edge === "top" ? source : target },
            second: { id: edge === "left" || edge === "top" ? target : source },
          });
        }
      }
    }
    expect(JSON.stringify(initialLayout)).toBe(before);
  });

  it("collapses a closed split and permits closing the final pane", () => {
    expect(removePane(initialLayout, "claude")).toBe(
      initialLayout.type === "split" ? initialLayout.second : null,
    );
    const result = removePane(initialLayout, "shell");
    expect(result).toMatchObject({ second: { type: "pane", id: "codex" } });
    expect(removePane({ type: "pane", id: "only" }, "only")).toBeNull();
    expect(removePane(initialLayout, "missing")).toBe(initialLayout);
  });

  it("swaps identities without changing split geometry and swaps back", () => {
    const result = swapPanes(initialLayout, "claude", "shell");
    expect(paneIds(result)).toEqual(["shell", "codex", "claude"]);
    expect(swapPanes(result, "shell", "claude")).toEqual(initialLayout);
    expect(result).toMatchObject({
      id: "main",
      ratio: 0.56,
      second: { id: "secondary", ratio: 0.58 },
    });
  });

  it("bounds resize ratios and keeps unaffected branches stable", () => {
    expect(setSplitRatio(initialLayout, "main", -5)).toMatchObject({ ratio: 0.15 });
    expect(setSplitRatio(initialLayout, "main", 9)).toMatchObject({ ratio: 0.85 });
    expect(setSplitRatio(initialLayout, "main", Number.NaN)).toBe(initialLayout);
    expect(setSplitRatio(initialLayout, "main", Number.POSITIVE_INFINITY)).toBe(initialLayout);
    const changed = setSplitRatio(initialLayout, "main", 0.6);
    if (changed.type === "split" && initialLayout.type === "split") {
      expect(changed.first).toBe(initialLayout.first);
      expect(changed.second).toBe(initialLayout.second);
    }
  });

  it("rejects invalid operations without dropping panes", () => {
    expect(movePane(initialLayout, "claude", "claude", "left")).toBe(initialLayout);
    expect(movePane(initialLayout, "missing", "claude", "left")).toBe(initialLayout);
    expect(movePane(initialLayout, "claude", "missing", "left")).toBe(initialLayout);
    expect(movePane(initialLayout, "shell", "claude", "left", "main")).toBe(initialLayout);
    expect(swapPanes(initialLayout, "claude", "missing")).toBe(initialLayout);
    expect(splitPane(initialLayout, "claude", "codex")).toBe(initialLayout);
    expect(splitPane(initialLayout, "claude", "main")).toBe(initialLayout);
    expect(splitPane(initialLayout, "claude", "")).toBe(initialLayout);
  });

  it("adds a fresh pane at the requested edge", () => {
    const result = splitPane(initialLayout, "shell", "logs", "bottom");
    expect(paneIds(result)).toEqual(["claude", "codex", "shell", "logs"]);
    expect(paneIds(initialLayout)).toEqual(["claude", "codex", "shell"]);
  });
});
