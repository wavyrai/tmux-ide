import { describe, expect, it } from "vitest";
import type { WorkspaceAppLayoutNode } from "@tmux-ide/contracts";
import {
  compositeHitTest,
  compositeLeafViewport,
  cycleCompositeFocus,
  defaultCompositeLayoutState,
  findCompositePanelLeaf,
  firstCompositePanelKind,
  reconcileCompositeLayoutState,
  resizeCompositeSeparator,
  resolveCompositeLayout,
  revealCompositePanel,
  setCompositeActiveTab,
} from "./composite-layout.ts";

const ideLayout: WorkspaceAppLayoutNode = {
  type: "split",
  id: "ide-root",
  direction: "horizontal",
  weights: [72, 28],
  children: [
    { type: "panel", id: "terminal-main", panel: "terminals", min_size: 40 },
    {
      type: "tabs",
      id: "dock",
      active: "files-tab",
      children: [
        { type: "panel", id: "files-tab", panel: "files", min_size: 24 },
        { type: "panel", id: "diff-tab", panel: "diff", min_size: 24 },
      ],
    },
  ],
};

describe("composite layout", () => {
  it("resolves split/tabs geometry with deterministic rounding and exact hits", () => {
    const layout = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 101, height: 30 },
      null,
    );

    expect(firstCompositePanelKind(ideLayout)).toBe("terminals");
    expect(findCompositePanelLeaf(ideLayout, "diff")).toBe("diff-tab");
    expect(layout.leaves.map((leaf) => [leaf.nodeId, leaf.panel, leaf.rect])).toEqual([
      ["terminal-main", "terminals", { x: 0, y: 0, width: 66, height: 30 }],
      ["files-tab", "files", { x: 67, y: 1, width: 34, height: 29 }],
    ]);
    expect(layout.separators[0]).toMatchObject({
      nodeId: "ide-root",
      direction: "horizontal",
      rect: { x: 66, y: 0, width: 1, height: 30 },
    });
    expect(layout.tabs.map((tab) => [tab.childId, tab.active, tab.rect.y])).toEqual([
      ["files-tab", true, 0],
      ["diff-tab", false, 0],
    ]);
    expect(compositeHitTest(layout, 1, 1)).toEqual({
      kind: "leaf",
      leafId: "terminal-main",
      panel: "terminals",
    });
    expect(compositeHitTest(layout, 66, 10)).toEqual({
      kind: "separator",
      nodeId: "ide-root",
      index: 0,
      direction: "horizontal",
    });
    expect(compositeHitTest(layout, 74, 0)).toEqual({
      kind: "tab",
      tabsNodeId: "dock",
      childId: "files-tab",
    });
  });

  it("reconciles active tabs/focus and cycles only visible leaves", () => {
    expect(reconcileCompositeLayoutState(ideLayout, null).splitWeights).toEqual({});

    const state = reconcileCompositeLayoutState(ideLayout, {
      focusedLeafId: "gone",
      activeTabs: { dock: "diff-tab", stale: "x" },
      splitWeights: { "ide-root": [1, 3], stale: [1, 1] },
    });
    expect(state.activeTabs.dock).toBe("diff-tab");
    expect(state.focusedLeafId).toBe("terminal-main");
    const diff = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 80, height: 20 },
      state,
    );
    expect(diff.leaves.map((leaf) => leaf.nodeId)).toEqual(["terminal-main", "diff-tab"]);

    const cycled = cycleCompositeFocus(ideLayout, state);
    expect(cycled.focusedLeafId).toBe("diff-tab");
    const files = setCompositeActiveTab(ideLayout, cycled, "dock", "files-tab");
    expect(files.activeTabs.dock).toBe("files-tab");
    expect(files.focusedLeafId).toBe("files-tab");
  });

  it("does not persist config/default split weights on focus, tab, or reveal changes", () => {
    const initial = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 101, height: 30 },
      null,
    );
    expect(initial.leaves.map((leaf) => [leaf.nodeId, leaf.rect.width])).toEqual([
      ["terminal-main", 66],
      ["files-tab", 34],
    ]);

    const cycled = cycleCompositeFocus(ideLayout, null);
    expect(cycled.focusedLeafId).toBe("files-tab");
    expect(cycled.splitWeights).toEqual({});
    expect(
      resolveCompositeLayout(
        "ide",
        ideLayout,
        { x: 0, y: 0, width: 101, height: 30 },
        cycled,
      ).leaves.map((leaf) => [leaf.nodeId, leaf.rect.width]),
    ).toEqual([
      ["terminal-main", 66],
      ["files-tab", 34],
    ]);

    const diffTab = setCompositeActiveTab(ideLayout, null, "dock", "diff-tab");
    expect(diffTab.splitWeights).toEqual({});
    expect(
      resolveCompositeLayout(
        "ide",
        ideLayout,
        { x: 0, y: 0, width: 101, height: 30 },
        diffTab,
      ).leaves.map((leaf) => [leaf.nodeId, leaf.rect.width]),
    ).toEqual([
      ["terminal-main", 66],
      ["diff-tab", 34],
    ]);

    const revealed = revealCompositePanel(ideLayout, null, "diff");
    expect(revealed?.splitWeights).toEqual({});
    expect(
      resolveCompositeLayout(
        "ide",
        ideLayout,
        { x: 0, y: 0, width: 101, height: 30 },
        revealed,
      ).leaves.map((leaf) => [leaf.nodeId, leaf.rect.width]),
    ).toEqual([
      ["terminal-main", 66],
      ["diff-tab", 34],
    ]);
  });

  it("exposes only visible leaf bodies for concurrent compiled rendering", () => {
    const filesVisible = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 80, height: 24 },
      { focusedLeafId: "terminal-main", activeTabs: { dock: "files-tab" }, splitWeights: {} },
    );
    expect(filesVisible.leaves.map((leaf) => [leaf.nodeId, leaf.panel])).toEqual([
      ["terminal-main", "terminals"],
      ["files-tab", "files"],
    ]);
    expect(filesVisible.leaves.some((leaf) => leaf.panel === "diff")).toBe(false);

    const diffVisible = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 80, height: 24 },
      setCompositeActiveTab(ideLayout, defaultCompositeLayoutState(), "dock", "diff-tab"),
    );
    expect(diffVisible.leaves.map((leaf) => [leaf.nodeId, leaf.panel])).toEqual([
      ["terminal-main", "terminals"],
      ["diff-tab", "diff"],
    ]);
    expect(diffVisible.leaves.some((leaf) => leaf.panel === "files")).toBe(false);
  });

  it("fails soft under impossible minimums without negative or out-of-bounds rectangles", () => {
    for (const rect of [
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 0, y: 0, width: 20, height: 4 },
    ]) {
      const layout = resolveCompositeLayout("ide", ideLayout, rect, {
        focusedLeafId: "diff-tab",
        activeTabs: { dock: "diff-tab" },
        splitWeights: {},
      });
      if (rect.width > 0 && rect.height > 0) expect(layout.note).toContain("below minimum");
      if (rect.width > 0 && rect.height > 0) {
        expect(layout.leaves.length).toBeGreaterThan(0);
        expect(layout.focusedLeafId).toBe(layout.leaves.find((leaf) => leaf.focused)?.nodeId);
      }
      for (const item of [...layout.leaves, ...layout.separators, ...layout.tabs]) {
        expect(item.rect.x).toBeGreaterThanOrEqual(0);
        expect(item.rect.y).toBeGreaterThanOrEqual(0);
        expect(item.rect.width).toBeGreaterThanOrEqual(0);
        expect(item.rect.height).toBeGreaterThanOrEqual(0);
        expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(rect.width);
        expect(item.rect.y + item.rect.height).toBeLessThanOrEqual(rect.height);
      }
    }
  });

  it("preserves the semantically focused subtree when split minima cannot fit", () => {
    const layout = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 20, height: 4 },
      {
        focusedLeafId: "diff-tab",
        activeTabs: { dock: "diff-tab" },
        splitWeights: {},
      },
    );

    expect(layout.note).toContain("below minimum");
    expect(layout.focusedLeafId).toBe("diff-tab");
    expect(layout.leaves.map((leaf) => [leaf.nodeId, leaf.panel, leaf.focused])).toEqual([
      ["diff-tab", "diff", true],
    ]);
    expect(layout.separators).toEqual([]);
    for (const item of [...layout.leaves, ...layout.tabs]) {
      expect(item.rect.x + item.rect.width).toBeLessThanOrEqual(20);
      expect(item.rect.y + item.rect.height).toBeLessThanOrEqual(4);
    }
  });

  it("derives bounded leaf viewports for border, chrome, render, and pointer math", () => {
    expect(compositeLeafViewport({ x: 0, y: 0, width: 0, height: 0 }, 2)).toMatchObject({
      bordered: false,
      innerWidth: 0,
      innerHeight: 0,
      bodyLeft: 0,
      bodyTop: 2,
      bodyWidth: 0,
      bodyHeight: 0,
    });
    expect(compositeLeafViewport({ x: 0, y: 0, width: 1, height: 1 }, 2)).toMatchObject({
      bordered: false,
      innerWidth: 1,
      innerHeight: 1,
      bodyLeft: 0,
      bodyTop: 2,
      bodyWidth: 1,
      bodyHeight: 0,
    });
    expect(compositeLeafViewport({ x: 0, y: 0, width: 2, height: 2 }, 2)).toMatchObject({
      bordered: false,
      leftInset: 0,
      topInset: 0,
      innerWidth: 2,
      innerHeight: 2,
      bodyLeft: 0,
      bodyTop: 2,
      bodyWidth: 2,
      bodyHeight: 0,
    });
    expect(compositeLeafViewport({ x: 0, y: 0, width: 20, height: 10 }, 2)).toMatchObject({
      bordered: true,
      leftInset: 1,
      topInset: 1,
      innerWidth: 18,
      innerHeight: 8,
      bodyLeft: 1,
      bodyTop: 3,
      bodyWidth: 18,
      bodyHeight: 6,
    });
    expect(compositeLeafViewport({ x: 4, y: 5, width: 20, height: 10 }, 3)).toMatchObject({
      innerWidth: 18,
      innerHeight: 8,
      bodyLeft: 1,
      bodyTop: 4,
      bodyWidth: 18,
      bodyHeight: 5,
    });
  });

  it("resizes horizontal and vertical separators with min clamping and stable weights", () => {
    const horizontal = resizeCompositeSeparator(ideLayout, null, {
      splitNodeId: "ide-root",
      separatorIndex: 0,
      delta: -100,
      axisSize: 101,
    });
    expect(horizontal.splitWeights["ide-root"]).toEqual([40, 60]);
    expect(reconcileCompositeLayoutState(ideLayout, horizontal).splitWeights).toEqual({
      "ide-root": [40, 60],
    });
    const horizontalLayout = resolveCompositeLayout(
      "ide",
      ideLayout,
      { x: 0, y: 0, width: 101, height: 30 },
      horizontal,
    );
    expect(horizontalLayout.leaves[0]?.rect.width).toBe(40);
    expect(horizontalLayout.leaves.every((leaf) => leaf.rect.width >= 0)).toBe(true);

    const verticalLayout: WorkspaceAppLayoutNode = {
      type: "split",
      id: "root",
      direction: "vertical",
      children: [
        { type: "panel", id: "top", panel: "terminals", min_size: 5 },
        { type: "panel", id: "bottom", panel: "files", min_size: 4 },
      ],
    };
    const vertical = resizeCompositeSeparator(verticalLayout, null, {
      splitNodeId: "root",
      separatorIndex: 0,
      delta: 100,
      axisSize: 20,
    });
    expect(vertical.splitWeights.root).toEqual([15, 4]);
    expect(
      resolveCompositeLayout(
        "v",
        verticalLayout,
        { x: 0, y: 0, width: 40, height: 20 },
        vertical,
      ).leaves.map((leaf) => leaf.rect.height),
    ).toEqual([15, 4]);
  });

  it("keeps multi-event separator drags origin-relative instead of compounding", () => {
    const rawOrigin = null;

    const firstTick = resizeCompositeSeparator(ideLayout, rawOrigin, {
      splitNodeId: "ide-root",
      separatorIndex: 0,
      delta: 1,
      axisSize: 101,
    });
    expect(firstTick.splitWeights["ide-root"]).toEqual([67, 33]);

    const secondTickFromOrigin = resizeCompositeSeparator(ideLayout, rawOrigin, {
      splitNodeId: "ide-root",
      separatorIndex: 0,
      delta: 2,
      axisSize: 101,
    });
    expect(secondTickFromOrigin.splitWeights["ide-root"]).toEqual([68, 32]);

    const compoundedIfUsingMutatedState = resizeCompositeSeparator(ideLayout, firstTick, {
      splitNodeId: "ide-root",
      separatorIndex: 0,
      delta: 2,
      axisSize: 101,
    });
    expect(compoundedIfUsingMutatedState.splitWeights["ide-root"]).toEqual([69, 31]);
    expect(secondTickFromOrigin.splitWeights["ide-root"]).not.toEqual(
      compoundedIfUsingMutatedState.splitWeights["ide-root"],
    );
  });

  it("reveals hidden nested tabs for a requested panel occurrence", () => {
    const nested: WorkspaceAppLayoutNode = {
      type: "tabs",
      id: "outer",
      active: "term",
      children: [
        { type: "panel", id: "term", panel: "terminals" },
        {
          type: "tabs",
          id: "inner",
          active: "files-a",
          children: [
            { type: "panel", id: "files-a", panel: "files" },
            { type: "panel", id: "diff-a", panel: "diff" },
            { type: "panel", id: "files-b", panel: "files" },
          ],
        },
      ],
    };
    const revealedDiff = revealCompositePanel(nested, null, "diff");
    expect(revealedDiff?.activeTabs).toMatchObject({ outer: "inner", inner: "diff-a" });
    expect(revealedDiff?.focusedLeafId).toBe("diff-a");

    const revealedSecondFiles = revealCompositePanel(nested, null, "files", "files-b");
    expect(revealedSecondFiles?.activeTabs).toMatchObject({ outer: "inner", inner: "files-b" });
    expect(revealedSecondFiles?.focusedLeafId).toBe("files-b");
  });

  it("handles vertical nesting and Unicode tab labels without overlap", () => {
    const layoutNode: WorkspaceAppLayoutNode = {
      type: "tabs",
      id: "tabs",
      children: [
        { type: "panel", id: "Pair 👨‍💻", panel: "files" },
        { type: "panel", id: "分析", panel: "diff" },
      ],
    };
    const layout = resolveCompositeLayout(
      "unicode",
      layoutNode,
      { x: 0, y: 0, width: 24, height: 8 },
      null,
    );
    for (const [index, tab] of layout.tabs.entries()) {
      const previous = layout.tabs[index - 1];
      if (previous)
        expect(tab.rect.x).toBeGreaterThanOrEqual(previous.rect.x + previous.rect.width);
      expect(tab.rect.x + tab.rect.width).toBeLessThanOrEqual(24);
    }
  });
});
