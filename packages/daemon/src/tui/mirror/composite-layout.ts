import type { WorkspaceAppLayoutNode, WorkspacePanelKind } from "@tmux-ide/contracts";
import stringWidth from "string-width";

export interface CompositeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompositeLayoutState {
  focusedLeafId: string | null;
  activeTabs: Record<string, string>;
  splitWeights: Record<string, number[]>;
}

export interface CompositePanelLeaf {
  nodeId: string;
  panel: WorkspacePanelKind;
  rect: CompositeRect;
  focused: boolean;
  title: string;
}

export interface CompositeLeafViewport {
  bordered: boolean;
  leftInset: number;
  rightInset: number;
  topInset: number;
  bottomInset: number;
  innerWidth: number;
  innerHeight: number;
  bodyLeft: number;
  bodyTop: number;
  bodyWidth: number;
  bodyHeight: number;
}

export interface CompositeSeparator {
  nodeId: string;
  direction: "horizontal" | "vertical";
  childBefore: string;
  childAfter: string;
  rect: CompositeRect;
  index: number;
  axisSize: number;
}

export interface CompositeTabChip {
  tabsNodeId: string;
  childId: string;
  label: string;
  rect: CompositeRect;
  active: boolean;
}

export interface CompositeResolvedLayout {
  viewId: string;
  rect: CompositeRect;
  leaves: CompositePanelLeaf[];
  separators: CompositeSeparator[];
  tabs: CompositeTabChip[];
  focusedLeafId: string | null;
  note: string | null;
}

export type CompositeHit =
  | { kind: "leaf"; leafId: string; panel: WorkspacePanelKind }
  | { kind: "separator"; nodeId: string; index: number; direction: "horizontal" | "vertical" }
  | { kind: "tab"; tabsNodeId: string; childId: string }
  | null;

export interface CompositeSeparatorResizeInput {
  splitNodeId: string;
  separatorIndex: number;
  delta: number;
  axisSize: number;
}

const PANEL_LABELS: Readonly<Record<WorkspacePanelKind, string>> = {
  home: "Home",
  terminals: "Terminals",
  files: "Files",
  diff: "Diff",
  missions: "Missions",
};

export function defaultCompositeLayoutState(): CompositeLayoutState {
  return { focusedLeafId: null, activeTabs: {}, splitWeights: {} };
}

export function compositeLeafViewport(
  rect: CompositeRect,
  chromeRows: number,
): CompositeLeafViewport {
  const normalized = normalizeRect(rect);
  // A border needs one cell on every side *and* at least one interior cell.
  // Below that, keep the scarce cells available for the panel fallback.
  const bordered = normalized.width >= 3 && normalized.height >= 3;
  const leftInset = bordered ? 1 : 0;
  const rightInset = bordered ? 1 : 0;
  const topInset = bordered ? 1 : 0;
  const bottomInset = bordered ? 1 : 0;
  const innerWidth = Math.max(0, normalized.width - leftInset - rightInset);
  const innerHeight = Math.max(0, normalized.height - topInset - bottomInset);
  const safeChromeRows = Math.max(0, Math.floor(chromeRows));
  return {
    bordered,
    leftInset,
    rightInset,
    topInset,
    bottomInset,
    innerWidth,
    innerHeight,
    bodyLeft: leftInset,
    bodyTop: topInset + safeChromeRows,
    bodyWidth: innerWidth,
    bodyHeight: Math.max(0, innerHeight - safeChromeRows),
  };
}

export function compositePanelIds(node: WorkspaceAppLayoutNode): string[] {
  if (node.type === "panel") return [node.id];
  return node.children.flatMap(compositePanelIds);
}

export function compositeContainsPanel(
  node: WorkspaceAppLayoutNode,
  panel: WorkspacePanelKind,
): boolean {
  if (node.type === "panel") return node.panel === panel;
  return node.children.some((child) => compositeContainsPanel(child, panel));
}

export function firstCompositePanelKind(node: WorkspaceAppLayoutNode): WorkspacePanelKind {
  if (node.type === "panel") return node.panel;
  return firstCompositePanelKind(node.children[0]!);
}

export function findCompositePanelLeaf(
  node: WorkspaceAppLayoutNode,
  panel: WorkspacePanelKind,
): string | null {
  if (node.type === "panel") return node.panel === panel ? node.id : null;
  for (const child of node.children) {
    const found = findCompositePanelLeaf(child, panel);
    if (found) return found;
  }
  return null;
}

export function reconcileCompositeLayoutState(
  node: WorkspaceAppLayoutNode,
  state: Partial<CompositeLayoutState> | null | undefined,
): CompositeLayoutState {
  const leafIds = new Set(compositePanelIds(node));
  const activeTabs: Record<string, string> = {};
  const splitWeights: Record<string, number[]> = {};
  const visit = (current: WorkspaceAppLayoutNode) => {
    if (current.type === "tabs") {
      const childIds = new Set(current.children.map((child) => child.id));
      const requested = state?.activeTabs?.[current.id] ?? current.active ?? null;
      activeTabs[current.id] =
        requested && childIds.has(requested) ? requested : current.children[0]!.id;
      current.children.forEach(visit);
    } else if (current.type === "split") {
      const saved = state?.splitWeights?.[current.id];
      if (
        saved &&
        saved.length === current.children.length &&
        saved.every((value) => Number.isFinite(value) && value > 0)
      ) {
        splitWeights[current.id] = [...saved];
      }
      current.children.forEach(visit);
    }
  };
  visit(node);
  return {
    focusedLeafId:
      state?.focusedLeafId && leafIds.has(state.focusedLeafId)
        ? state.focusedLeafId
        : (firstVisibleLeaf(node, activeTabs)?.id ?? null),
    activeTabs,
    splitWeights,
  };
}

export function resolveCompositeLayout(
  viewId: string,
  node: WorkspaceAppLayoutNode,
  rect: CompositeRect,
  state: Partial<CompositeLayoutState> | null | undefined,
): CompositeResolvedLayout {
  const reconciled = reconcileCompositeLayoutState(node, state);
  const leaves: CompositePanelLeaf[] = [];
  const separators: CompositeSeparator[] = [];
  const tabs: CompositeTabChip[] = [];
  const noteParts: string[] = [];
  const rootRect = normalizeRect(rect);
  const focusedLeafId = visibleLeafIds(node, reconciled.activeTabs).includes(
    reconciled.focusedLeafId ?? "",
  )
    ? reconciled.focusedLeafId
    : (firstVisibleLeaf(node, reconciled.activeTabs)?.id ?? null);

  const emit = (current: WorkspaceAppLayoutNode, area: CompositeRect): void => {
    area = clampRect(area, rootRect);
    if (area.width <= 0 || area.height <= 0) {
      noteParts.push("Composite layout has no visible cells");
      return;
    }
    if (current.type === "panel") {
      leaves.push({
        nodeId: current.id,
        panel: current.panel,
        rect: area,
        focused: current.id === focusedLeafId,
        title: PANEL_LABELS[current.panel],
      });
      return;
    }
    if (current.type === "tabs") {
      if (area.height < 2) {
        noteParts.push(`Composite tabs "${current.id}" are below minimum size`);
        const leaf = firstVisibleLeaf(current, reconciled.activeTabs) ?? firstPanelLeaf(current);
        if (leaf) {
          leaves.push({
            nodeId: leaf.id,
            panel: leaf.panel,
            rect: area,
            focused: leaf.id === focusedLeafId,
            title: PANEL_LABELS[leaf.panel],
          });
        }
        return;
      }
      const active = reconciled.activeTabs[current.id] ?? current.children[0]!.id;
      let cursor = area.x;
      for (const child of current.children) {
        const label = ` ${child.id === active ? "[" : ""}${tabLabel(child)}${
          child.id === active ? "]" : ""
        } `;
        const width = Math.min(
          Math.max(1, stringWidth(label)),
          Math.max(0, area.x + area.width - cursor),
        );
        if (width > 0) {
          tabs.push({
            tabsNodeId: current.id,
            childId: child.id,
            label,
            rect: { x: cursor, y: area.y, width, height: 1 },
            active: child.id === active,
          });
          cursor += width;
        }
      }
      const child =
        current.children.find((candidate) => candidate.id === active) ?? current.children[0]!;
      emit(child, {
        x: area.x,
        y: area.y + 1,
        width: area.width,
        height: Math.max(0, area.height - 1),
      });
      return;
    }

    const axisSize = current.direction === "horizontal" ? area.width : area.height;
    const separatorCells = current.children.length - 1;
    const contentSize = Math.max(0, axisSize - separatorCells);
    const minSizes = current.children.map((child) => subtreeMinSize(child, current.direction));
    const minTotal = minSizes.reduce((sum, value) => sum + value, 0);
    if (axisSize < current.children.length + separatorCells || minTotal > contentSize) {
      noteParts.push(`Composite split "${current.id}" is below minimum size`);
      const preferred =
        childContainingLeaf(current, focusedLeafId) ??
        current.children.find((child) =>
          visibleLeafIds(child, reconciled.activeTabs).includes(focusedLeafId ?? ""),
        ) ??
        current.children[0]!;
      emit(preferred, area);
      return;
    }
    const override = reconciled.splitWeights[current.id];
    const weights = override ?? current.weights ?? current.children.map(() => 1);
    const sizes = override
      ? allocatePersistedSizes(contentSize, minSizes, weights)
      : allocateSizes(contentSize, minSizes, weights);
    if (
      sizes.reduce((sum, value) => sum + value, 0) < minSizes.reduce((sum, value) => sum + value, 0)
    ) {
      noteParts.push(`Composite split "${current.id}" is below minimum size`);
    }
    let cursor = current.direction === "horizontal" ? area.x : area.y;
    current.children.forEach((child, index) => {
      const size = sizes[index] ?? 0;
      if (size <= 0) return;
      const childRect =
        current.direction === "horizontal"
          ? { x: cursor, y: area.y, width: size, height: area.height }
          : { x: area.x, y: cursor, width: area.width, height: size };
      emit(child, childRect);
      cursor += size;
      if (index < current.children.length - 1) {
        if (
          cursor < (current.direction === "horizontal" ? area.x + area.width : area.y + area.height)
        ) {
          const separatorRect =
            current.direction === "horizontal"
              ? { x: cursor, y: area.y, width: 1, height: area.height }
              : { x: area.x, y: cursor, width: area.width, height: 1 };
          separators.push({
            nodeId: current.id,
            direction: current.direction,
            childBefore: child.id,
            childAfter: current.children[index + 1]!.id,
            rect: clampRect(separatorRect, rootRect),
            index,
            axisSize,
          });
        }
        cursor += 1;
      }
    });
  };

  emit(node, rootRect);
  if (leaves.length === 0) {
    const fallback =
      leafById(node, focusedLeafId) ??
      firstVisibleLeaf(node, reconciled.activeTabs) ??
      firstPanelLeaf(node);
    if (fallback && rootRect.width > 0 && rootRect.height > 0) {
      leaves.push({
        nodeId: fallback.id,
        panel: fallback.panel,
        rect: rootRect,
        focused: true,
        title: PANEL_LABELS[fallback.panel],
      });
    }
  }
  const effectiveFocusedLeafId =
    leaves.find((leaf) => leaf.nodeId === focusedLeafId)?.nodeId ?? leaves[0]?.nodeId ?? null;
  for (const leaf of leaves) leaf.focused = leaf.nodeId === effectiveFocusedLeafId;
  return {
    viewId,
    rect: rootRect,
    leaves,
    separators: separators.filter(
      (separator) => separator.rect.width > 0 && separator.rect.height > 0,
    ),
    tabs: tabs.filter((tab) => tab.rect.width > 0 && tab.rect.height > 0),
    focusedLeafId: effectiveFocusedLeafId,
    note: noteParts[0] ?? null,
  };
}

export function compositeHitTest(
  layout: CompositeResolvedLayout,
  x: number,
  y: number,
): CompositeHit {
  for (const tab of layout.tabs) {
    if (inside(tab.rect, x, y))
      return { kind: "tab", tabsNodeId: tab.tabsNodeId, childId: tab.childId };
  }
  for (const separator of layout.separators) {
    if (inside(separator.rect, x, y)) {
      return {
        kind: "separator",
        nodeId: separator.nodeId,
        index: separator.index,
        direction: separator.direction,
      };
    }
  }
  for (const leaf of layout.leaves) {
    if (inside(leaf.rect, x, y)) return { kind: "leaf", leafId: leaf.nodeId, panel: leaf.panel };
  }
  return null;
}

export function cycleCompositeFocus(
  node: WorkspaceAppLayoutNode,
  state: Partial<CompositeLayoutState> | null | undefined,
  direction = 1,
): CompositeLayoutState {
  const reconciled = reconcileCompositeLayoutState(node, state);
  const ids = visibleLeafIds(node, reconciled.activeTabs);
  if (ids.length === 0) return reconciled;
  const current = Math.max(0, ids.indexOf(reconciled.focusedLeafId ?? ids[0]!));
  return { ...reconciled, focusedLeafId: ids[(current + direction + ids.length) % ids.length]! };
}

export function setCompositeActiveTab(
  node: WorkspaceAppLayoutNode,
  state: Partial<CompositeLayoutState> | null | undefined,
  tabsNodeId: string,
  childId: string,
): CompositeLayoutState {
  const reconciled = reconcileCompositeLayoutState(node, state);
  const tab = findNode(node, tabsNodeId);
  if (!tab || tab.type !== "tabs" || !tab.children.some((child) => child.id === childId)) {
    return reconciled;
  }
  const activeTabs = { ...reconciled.activeTabs, [tabsNodeId]: childId };
  const focusedLeafId = firstVisibleLeaf(
    tab.children.find((child) => child.id === childId)!,
    activeTabs,
  )?.id;
  return reconcileCompositeLayoutState(node, {
    ...reconciled,
    activeTabs,
    focusedLeafId: focusedLeafId ?? reconciled.focusedLeafId,
  });
}

export function revealCompositePanel(
  node: WorkspaceAppLayoutNode,
  state: Partial<CompositeLayoutState> | null | undefined,
  panel: WorkspacePanelKind,
  preferredLeafId?: string | null,
): CompositeLayoutState | null {
  const reconciled = reconcileCompositeLayoutState(node, state);
  const match =
    findPanelOccurrence(node, panel, preferredLeafId ?? null) ??
    findPanelOccurrence(node, panel, null);
  if (!match) return null;
  return reconcileCompositeLayoutState(node, {
    ...reconciled,
    activeTabs: { ...reconciled.activeTabs, ...match.activeTabs },
    focusedLeafId: match.leafId,
  });
}

export function resizeCompositeSeparator(
  node: WorkspaceAppLayoutNode,
  state: Partial<CompositeLayoutState> | null | undefined,
  input: CompositeSeparatorResizeInput,
): CompositeLayoutState {
  const reconciled = reconcileCompositeLayoutState(node, state);
  const split = findNode(node, input.splitNodeId);
  if (!split || split.type !== "split") return reconciled;
  const beforeIndex = input.separatorIndex;
  const afterIndex = beforeIndex + 1;
  if (beforeIndex < 0 || afterIndex >= split.children.length) return reconciled;
  const separatorCells = split.children.length - 1;
  const contentSize = Math.max(0, input.axisSize - separatorCells);
  const minimums = split.children.map((child) => subtreeMinSize(child, split.direction));
  const override = reconciled.splitWeights[split.id];
  const currentWeights = override ?? split.weights ?? split.children.map(() => 1);
  const currentSizes = override
    ? allocatePersistedSizes(contentSize, minimums, currentWeights)
    : allocateSizes(contentSize, minimums, currentWeights);
  const resized = resizeAdjacentSizes(currentSizes, minimums, beforeIndex, input.delta);
  const splitWeights = {
    ...reconciled.splitWeights,
    [split.id]: sizesToWeights(resized),
  };
  return reconcileCompositeLayoutState(node, { ...reconciled, splitWeights });
}

export function compositeSubtreeMinSize(
  node: WorkspaceAppLayoutNode,
  axis: "horizontal" | "vertical",
): number {
  return subtreeMinSize(node, axis);
}

function inside(rect: CompositeRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function normalizeRect(rect: CompositeRect): CompositeRect {
  return {
    x: Math.max(0, Math.trunc(rect.x)),
    y: Math.max(0, Math.trunc(rect.y)),
    width: Math.max(0, Math.trunc(rect.width)),
    height: Math.max(0, Math.trunc(rect.height)),
  };
}

function clampRect(rect: CompositeRect, bounds: CompositeRect): CompositeRect {
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height));
  const right = Math.max(x, Math.min(rect.x + rect.width, bounds.x + bounds.width));
  const bottom = Math.max(y, Math.min(rect.y + rect.height, bounds.y + bounds.height));
  return { x, y, width: right - x, height: bottom - y };
}

function tabLabel(node: WorkspaceAppLayoutNode): string {
  if (node.type === "panel") return PANEL_LABELS[node.panel];
  return node.id;
}

function subtreeMinSize(node: WorkspaceAppLayoutNode, axis: "horizontal" | "vertical"): number {
  if (node.type === "panel") return node.min_size ?? 1;
  if (node.type === "tabs")
    return axis === "vertical"
      ? 1 + Math.max(1, ...node.children.map((child) => subtreeMinSize(child, axis)))
      : Math.max(1, ...node.children.map((child) => subtreeMinSize(child, axis)));
  const childMins = node.children.map((child) => subtreeMinSize(child, axis));
  return node.direction === axis
    ? childMins.reduce((sum, value) => sum + value, 0) + node.children.length - 1
    : Math.max(...childMins);
}

function allocateSizes(total: number, minimums: number[], weights: number[]): number[] {
  if (minimums.length === 0) return [];
  if (total <= 0) return minimums.map(() => 0);
  const minTotal = minimums.reduce((sum, value) => sum + value, 0);
  if (minTotal >= total) {
    const out = minimums.map(() => 0);
    let remaining = total;
    for (const [index, min] of minimums.entries()) {
      const size = Math.min(min, remaining);
      out[index] = size;
      remaining -= size;
    }
    return out;
  }
  const extra = total - minTotal;
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || weights.length;
  const exact = weights.map((weight) => (extra * weight) / weightTotal);
  const floors = exact.map(Math.floor);
  let remainder = extra - floors.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const item of order) {
    if (remainder <= 0) break;
    floors[item.index]! += 1;
    remainder -= 1;
  }
  return minimums.map((min, index) => min + (floors[index] ?? 0));
}

function allocatePersistedSizes(total: number, minimums: number[], weights: number[]): number[] {
  if (minimums.length === 0) return [];
  if (total <= 0) return minimums.map(() => 0);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || weights.length;
  const exact = weights.map((weight) => (total * weight) / weightTotal);
  const sizes = exact.map(Math.floor);
  let remainder = total - sizes.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const item of order) {
    if (remainder <= 0) break;
    sizes[item.index]! += 1;
    remainder -= 1;
  }
  return clampSizesToMinimums(sizes, minimums, total);
}

function clampSizesToMinimums(sizes: number[], minimums: number[], total: number): number[] {
  const out = sizes.map((size) => Math.max(0, size));
  for (const [index, min] of minimums.entries()) {
    const deficit = min - (out[index] ?? 0);
    if (deficit <= 0) continue;
    out[index] = min;
    let remaining = deficit;
    for (const donor of out.keys()) {
      if (donor === index) continue;
      const available = Math.max(0, (out[donor] ?? 0) - (minimums[donor] ?? 1));
      const take = Math.min(available, remaining);
      out[donor]! -= take;
      remaining -= take;
      if (remaining <= 0) break;
    }
  }
  const diff = total - out.reduce((sum, value) => sum + value, 0);
  if (diff !== 0 && out.length > 0) out[out.length - 1]! += diff;
  return out.map((size) => Math.max(0, size));
}

function firstPanelLeaf(
  node: WorkspaceAppLayoutNode,
): Extract<WorkspaceAppLayoutNode, { type: "panel" }> | null {
  if (node.type === "panel") return node;
  for (const child of node.children) {
    const found = firstPanelLeaf(child);
    if (found) return found;
  }
  return null;
}

function leafById(
  node: WorkspaceAppLayoutNode,
  id: string | null | undefined,
): Extract<WorkspaceAppLayoutNode, { type: "panel" }> | null {
  if (!id) return null;
  if (node.type === "panel") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = leafById(child, id);
    if (found) return found;
  }
  return null;
}

function childContainingLeaf(
  node: Extract<WorkspaceAppLayoutNode, { type: "split" }>,
  leafId: string | null | undefined,
): WorkspaceAppLayoutNode | null {
  if (!leafId) return null;
  return node.children.find((child) => leafById(child, leafId)) ?? null;
}

function firstVisibleLeaf(
  node: WorkspaceAppLayoutNode,
  activeTabs: Record<string, string>,
): Extract<WorkspaceAppLayoutNode, { type: "panel" }> | null {
  if (node.type === "panel") return node;
  if (node.type === "tabs") {
    const active = activeTabs[node.id] ?? node.active ?? node.children[0]!.id;
    return firstVisibleLeaf(
      node.children.find((child) => child.id === active) ?? node.children[0]!,
      activeTabs,
    );
  }
  for (const child of node.children) {
    const found = firstVisibleLeaf(child, activeTabs);
    if (found) return found;
  }
  return null;
}

function visibleLeafIds(
  node: WorkspaceAppLayoutNode,
  activeTabs: Record<string, string>,
): string[] {
  if (node.type === "panel") return [node.id];
  if (node.type === "tabs") {
    const active = activeTabs[node.id] ?? node.active ?? node.children[0]!.id;
    return visibleLeafIds(
      node.children.find((child) => child.id === active) ?? node.children[0]!,
      activeTabs,
    );
  }
  return node.children.flatMap((child) => visibleLeafIds(child, activeTabs));
}

function findNode(node: WorkspaceAppLayoutNode, id: string): WorkspaceAppLayoutNode | null {
  if (node.id === id) return node;
  if (node.type === "panel") return null;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function resizeAdjacentSizes(
  sizes: number[],
  minimums: number[],
  beforeIndex: number,
  delta: number,
): number[] {
  const out = [...sizes];
  const afterIndex = beforeIndex + 1;
  const before = out[beforeIndex] ?? 0;
  const after = out[afterIndex] ?? 0;
  const beforeMin = minimums[beforeIndex] ?? 1;
  const afterMin = minimums[afterIndex] ?? 1;
  const clampedDelta = Math.max(beforeMin - before, Math.min(delta, after - afterMin));
  out[beforeIndex] = before + clampedDelta;
  out[afterIndex] = after - clampedDelta;
  return out.map((size, index) => Math.max(minimums[index] ?? 1, size));
}

function sizesToWeights(sizes: number[]): number[] {
  return sizes.map((size) => Math.max(1, Math.trunc(size)));
}

function findPanelOccurrence(
  node: WorkspaceAppLayoutNode,
  panel: WorkspacePanelKind,
  preferredLeafId: string | null,
  activeTabs: Record<string, string> = {},
): { leafId: string; activeTabs: Record<string, string> } | null {
  if (node.type === "panel") {
    if (node.panel !== panel) return null;
    if (preferredLeafId && node.id !== preferredLeafId) return null;
    return { leafId: node.id, activeTabs };
  }
  if (node.type === "tabs") {
    const preferredChild = preferredLeafId
      ? node.children.find((child) => leafById(child, preferredLeafId))
      : null;
    const ordered = preferredChild
      ? [preferredChild, ...node.children.filter((child) => child.id !== preferredChild.id)]
      : node.children;
    for (const child of ordered) {
      const found = findPanelOccurrence(child, panel, preferredLeafId, {
        ...activeTabs,
        [node.id]: child.id,
      });
      if (found) return found;
    }
    return null;
  }
  for (const child of node.children) {
    const found = findPanelOccurrence(child, panel, preferredLeafId, activeTabs);
    if (found) return found;
  }
  return null;
}
