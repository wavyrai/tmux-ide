/** Presentation-only layout used to qualify workbench interactions before transport wiring. */
export type PaneLayout = Readonly<{ type: "pane"; id: string }>;
export type SplitAxis = "horizontal" | "vertical";
export type PaneEdge = "left" | "right" | "top" | "bottom";
export type SplitLayout = Readonly<{
  type: "split";
  id: string;
  axis: SplitAxis;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}>;
export type LayoutNode = PaneLayout | SplitLayout;

export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export const initialLayout: LayoutNode = {
  type: "split",
  id: "main",
  axis: "horizontal",
  ratio: 0.56,
  first: { type: "pane", id: "claude" },
  second: {
    type: "split",
    id: "secondary",
    axis: "vertical",
    ratio: 0.58,
    first: { type: "pane", id: "codex" },
    second: { type: "pane", id: "shell" },
  },
};

export function paneIds(layout: LayoutNode | null): string[] {
  if (!layout) return [];
  return layout.type === "pane"
    ? [layout.id]
    : [...paneIds(layout.first), ...paneIds(layout.second)];
}

function mapLayout(layout: LayoutNode, transform: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (layout.type === "pane") return transform(layout);
  const first = mapLayout(layout.first, transform);
  const second = mapLayout(layout.second, transform);
  return transform(
    first === layout.first && second === layout.second ? layout : { ...layout, first, second },
  );
}

function nodeIds(layout: LayoutNode): string[] {
  return layout.type === "pane"
    ? [layout.id]
    : [layout.id, ...nodeIds(layout.first), ...nodeIds(layout.second)];
}

function uniqueSplitId(layout: LayoutNode, base: string): string {
  const ids = new Set(nodeIds(layout));
  let candidate = base;
  for (let suffix = 2; ids.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}

export function swapPanes(layout: LayoutNode, firstId: string, secondId: string): LayoutNode {
  const ids = paneIds(layout);
  if (firstId === secondId || !ids.includes(firstId) || !ids.includes(secondId)) return layout;
  return mapLayout(layout, (node) => {
    if (node.type !== "pane") return node;
    if (node.id === firstId) return { ...node, id: secondId };
    if (node.id === secondId) return { ...node, id: firstId };
    return node;
  });
}

export function removePane(layout: LayoutNode, paneId: string): LayoutNode | null {
  if (layout.type === "pane") return layout.id === paneId ? null : layout;
  const first = removePane(layout.first, paneId);
  const second = removePane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

export function splitPane(
  layout: LayoutNode,
  targetId: string,
  newPaneId: string,
  edge: PaneEdge = "right",
  splitId?: string,
): LayoutNode {
  const ids = nodeIds(layout);
  if (!paneIds(layout).includes(targetId) || ids.includes(newPaneId) || !newPaneId.trim())
    return layout;
  if (splitId && (ids.includes(splitId) || splitId === newPaneId || !splitId.trim())) return layout;
  const id = splitId ?? uniqueSplitId(layout, `split-${targetId}-${newPaneId}`);
  const pane: PaneLayout = { type: "pane", id: newPaneId };
  const before = edge === "left" || edge === "top";
  return mapLayout(layout, (node) =>
    node.type === "pane" && node.id === targetId
      ? {
          type: "split",
          id,
          axis: edge === "left" || edge === "right" ? "horizontal" : "vertical",
          ratio: 0.5,
          first: before ? pane : node,
          second: before ? node : pane,
        }
      : node,
  );
}

export function movePane(
  layout: LayoutNode,
  sourceId: string,
  targetId: string,
  edge: PaneEdge,
  splitId?: string,
): LayoutNode {
  const ids = paneIds(layout);
  if (sourceId === targetId || !ids.includes(sourceId) || !ids.includes(targetId)) return layout;
  const reduced = removePane(layout, sourceId);
  if (!reduced) return layout;
  const result = splitPane(reduced, targetId, sourceId, edge, splitId);
  // An invalid split must never silently remove the source pane.
  return result === reduced ? layout : result;
}

export function setSplitRatio(layout: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (!Number.isFinite(ratio)) return layout;
  const bounded = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
  return mapLayout(layout, (node) =>
    node.type === "split" && node.id === splitId && node.ratio !== bounded
      ? { ...node, ratio: bounded }
      : node,
  );
}
