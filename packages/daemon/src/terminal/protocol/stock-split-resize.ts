/**
 * Moves one split boundary on a stock tmux server, which has neither
 * `tmux-ide-resize-split` nor the operation journal.
 *
 * `resize-pane` names a pane, and tmux applies it to that pane's nearest
 * same-axis ancestor, so the target is a leaf that reaches the split's parent
 * through opposite-axis splits only. The boundary is clamped to its two
 * neighbours, because tmux takes space from further siblings once they run out.
 *
 * The guard and the resize are one `if-shell -F`: tmux evaluates the format
 * inline and runs the commands it queues before any other client's command, so
 * a change from outside cannot land between the comparison and the resize. Send
 * it on a control connection, where if-shell and each branch command answer in
 * their own block, three in all, the last holding the answer. On tmux 3.8 only control clients read
 * `#{window_layout}` in the format the mirror holds; other clients read JSON.
 */
import { randomUUID } from "node:crypto";
import { parseLayoutTree, type LayoutTreeNode } from "./layout-parse.ts";
import {
  locateSplit,
  preservesSplitTree,
  splitEdge,
  validSplitTree,
  type NativeSplitResizeRequest,
  type NativeSplitResizeResult,
} from "./native-split-resize.ts";

type Axis = "cols" | "rows";
const span = (node: LayoutTreeNode, axis: Axis) => (axis === "cols" ? node.width : node.height);
const start = (node: LayoutTreeNode, axis: Axis) => (axis === "cols" ? node.left : node.top);

/** The smallest size tmux leaves a cell. A row also holds a pane border status line. */
function minimum(node: LayoutTreeNode, axis: Axis): number {
  if (node.kind === "leaf") return axis === "cols" ? 1 : 2;
  const sizes = node.children.map((child) => minimum(child, axis));
  return node.axis === axis
    ? sizes.reduce((sum, size) => sum + size, node.children.length - 1)
    : Math.max(...sizes);
}
/** A pane whose nearest ancestor on `axis` is the cell directly above `node`. */
function reachingLeaf(node: LayoutTreeNode, axis: Axis): string | null {
  if (node.kind === "leaf") return node.id;
  if (node.axis === axis) return null;
  for (const child of node.children) {
    const leaf = reachingLeaf(child, axis);
    if (leaf) return leaf;
  }
  return null;
}
export interface StockSplitTarget {
  readonly paneId: string;
  /** Whether `paneId` is in the cell after the boundary, which is its parent's last. */
  readonly trailing: boolean;
}
/** `path` names the cell before the boundary. Null means tmux has no way to address it. */
export function stockSplitTarget(
  tree: LayoutTreeNode,
  path: readonly number[],
  axis: Axis,
): StockSplitTarget | null {
  const located = locateSplit(tree, path);
  if (!located || located.parent.axis !== axis) return null;
  const leading = reachingLeaf(located.node, axis);
  if (leading) return { paneId: leading, trailing: false };
  const index = path.at(-1)!;
  if (index + 1 !== located.parent.children.length - 1) return null;
  const trailing = reachingLeaf(located.parent.children[index + 1]!, axis);
  return trailing ? { paneId: trailing, trailing: true } : null;
}
export interface StockSplitPlan extends StockSplitTarget {
  readonly boundary: number;
  readonly size: number;
}
export function planStockSplitResize(
  tree: LayoutTreeNode,
  path: readonly number[],
  axis: Axis,
  boundary: number,
): StockSplitPlan | null {
  const target = stockSplitTarget(tree, path, axis);
  const located = locateSplit(tree, path);
  if (!target || !located) return null;
  const before = located.node;
  const after = located.parent.children[path.at(-1)! + 1]!;
  const low = start(before, axis) + minimum(before, axis);
  const end = start(after, axis) + span(after, axis);
  const high = end - minimum(after, axis) - 1;
  if (high < low) return null;
  const clamped = Math.min(high, Math.max(low, boundary));
  return {
    ...target,
    boundary: clamped,
    size: target.trailing ? end - clamped - 1 : clamped - start(before, axis),
  };
}
/** Escapes a layout for the right side of a format comparison. */
function formatLiteral(layout: string): string {
  return layout.replaceAll(",", "#,").replaceAll("}", "#}");
}
function leafCount(node: LayoutTreeNode): number {
  return node.kind === "leaf" ? 1 : node.children.reduce((sum, child) => sum + leafCount(child), 0);
}
export function stockSplitCommand(
  request: NativeSplitResizeRequest,
  sessionCreated: string,
  plan: StockSplitPlan,
  panes: number,
  marker: string,
): string {
  const equal = (name: string, value: string | number) => `#{==:#{${name}},${value}}`;
  const condition = [
    equal("window_id", request.windowId),
    equal("session_id", request.sessionId),
    equal("session_created", sessionCreated),
    equal("window_zoomed_flag", 0),
    // Control clients' layouts leave out floating panes; this count includes them.
    equal("window_panes", panes),
    equal("window_layout", formatLiteral(request.expectedLayout)),
  ].reduceRight((rest, next) => `#{&&:${next},${rest}}`);
  const flag = request.axis === "cols" ? "-x" : "-y";
  const resize = `resize-pane -t ${plan.paneId} ${flag} ${plan.size}`;
  const readback = `display-message -p -t ${request.windowId} "${marker} #{window_layout}"`;
  return `if-shell -F -t '${request.sessionId}:${request.windowId}' '${condition}' '${resize} ; ${readback}' 'display-message -p ${marker} ; display-message -p ${marker}'`;
}
export type StockSplitResizeResult =
  | NativeSplitResizeResult
  | { status: "refused"; reason: "stale-layout" };

/** Authorizes, then sends the command without awaiting in between. A sent command
 * that does not answer as expected is uncertain: the caller must not retry it. */
export async function resizeStockSplit(
  request: NativeSplitResizeRequest,
  sessionCreated: string,
  authorizeBeforeEffect: () => void,
  send: (command: string) => Promise<string[]>,
): Promise<StockSplitResizeResult> {
  const before = parseLayoutTree(request.expectedLayout);
  if (
    !before ||
    !validSplitTree(before) ||
    !/^\$\d+$/u.test(request.sessionId) ||
    !/^@\d+$/u.test(request.windowId) ||
    !/^[1-9]\d*$/u.test(sessionCreated)
  )
    return { status: "refused", reason: "invalid-request" };
  const plan = planStockSplitResize(before, request.path, request.axis, request.boundary);
  if (!plan) return { status: "refused", reason: "invalid-request" };
  const marker = `tmux-ide-split-${randomUUID()}`;
  const command = stockSplitCommand(request, sessionCreated, plan, leafCount(before), marker);
  authorizeBeforeEffect();
  let reply: string[];
  try {
    reply = await send(command);
  } catch {
    return { status: "uncertain", reason: "command-failed" };
  }
  const answer = reply.join("\n");
  if (answer === marker) return { status: "refused", reason: "stale-layout" };
  if (reply.length !== 1 || !answer.startsWith(`${marker} `))
    return { status: "uncertain", reason: "invalid-receipt" };
  const layout = answer.slice(marker.length + 1);
  const after = parseLayoutTree(layout);
  const original = locateSplit(before, request.path)!;
  const actual = after && locateSplit(after, request.path);
  if (
    !after ||
    !validSplitTree(after) ||
    !actual ||
    !preservesSplitTree(before, after, original.parent, request.axis)
  )
    return { status: "uncertain", reason: "invalid-receipt" };
  const boundary = splitEdge(actual.node, request.axis);
  const previous = splitEdge(original.node, request.axis);
  if (boundary < Math.min(previous, plan.boundary) || boundary > Math.max(previous, plan.boundary))
    return { status: "uncertain", reason: "invalid-receipt" };
  return {
    status: "applied",
    boundary,
    layout,
    tree: after,
    changed: layout !== request.expectedLayout,
  };
}
