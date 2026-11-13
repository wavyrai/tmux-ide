/**
 * Moves one split boundary on a stock tmux server, which has neither
 * `tmux-ide-resize-split` nor the operation journal.
 *
 * `resize-pane` names a pane, and tmux applies it to that pane's nearest
 * same-axis ancestor, so the target is a leaf that reaches the split's parent
 * through opposite-axis splits only. The boundary is clamped to its two
 * neighbours, because tmux takes space from further siblings once they run out.
 * The move is relative, because an absolute -y adds one on the status line's edge.
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

/** The window options that decide how small tmux lets a pane get. */
export interface StockSplitSizes {
  readonly borderStatus: string;
  /** Columns a pane scrollbar takes, or 0 with scrollbars off. */
  readonly scrollbar: number;
}
/** tmux's own minimum (`layout_resize_check`): a leaf holds one cell, plus the pane
 * status line on the window's top or bottom edge, and any scrollbar. */
function minimum(
  node: LayoutTreeNode,
  axis: Axis,
  sizes: StockSplitSizes,
  root: LayoutTreeNode,
): number {
  if (node.kind === "leaf") {
    if (axis === "cols") return 1 + sizes.scrollbar;
    const onEdge =
      (sizes.borderStatus === "top" && node.top === root.top) ||
      (sizes.borderStatus === "bottom" && node.top + node.height === root.top + root.height);
    return onEdge ? 2 : 1;
  }
  const mins = node.children.map((child) => minimum(child, axis, sizes, root));
  return node.axis === axis
    ? mins.reduce((sum, size) => sum + size, node.children.length - 1)
    : Math.max(...mins);
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
/** The pane to name in `resize-pane` for the boundary after the cell at `path`.
 * Null means tmux has no way to address that boundary. In its last cell a pane
 * acts on the boundary before it, so either side's pane moves it the same way. */
export function stockSplitTarget(
  tree: LayoutTreeNode,
  path: readonly number[],
  axis: Axis,
): string | null {
  const located = locateSplit(tree, path);
  if (!located || located.parent.axis !== axis) return null;
  const leading = reachingLeaf(located.node, axis);
  if (leading) return leading;
  const index = path.at(-1)!;
  if (index + 1 !== located.parent.children.length - 1) return null;
  return reachingLeaf(located.parent.children[index + 1]!, axis);
}
/** Where the boundary may go without tmux taking space from further siblings. */
export function stockSplitRange(
  tree: LayoutTreeNode,
  path: readonly number[],
  axis: Axis,
  sizes: StockSplitSizes,
): { readonly low: number; readonly high: number } | null {
  const located = locateSplit(tree, path);
  if (!located) return null;
  const after = located.parent.children[path.at(-1)! + 1]!;
  const low = start(located.node, axis) + minimum(located.node, axis, sizes, tree);
  const high = start(after, axis) + span(after, axis) - minimum(after, axis, sizes, tree) - 1;
  return { low, high };
}
/** Whether a handle on this boundary could move it at all. */
export function stockSplitMovable(
  tree: LayoutTreeNode,
  path: readonly number[],
  axis: Axis,
  sizes: StockSplitSizes,
): boolean {
  const range = stockSplitRange(tree, path, axis, sizes);
  return stockSplitTarget(tree, path, axis) !== null && range !== null && range.high > range.low;
}
export interface StockSplitPlan {
  readonly paneId: string;
  readonly boundary: number;
  /** How far the boundary moves; negative is left or up. */
  readonly delta: number;
}
export function planStockSplitResize(
  tree: LayoutTreeNode,
  path: readonly number[],
  axis: Axis,
  boundary: number,
  sizes: StockSplitSizes,
): StockSplitPlan | null {
  const paneId = stockSplitTarget(tree, path, axis);
  const range = stockSplitRange(tree, path, axis, sizes);
  const located = locateSplit(tree, path);
  if (!paneId || !range || !located || range.high < range.low) return null;
  const clamped = Math.min(range.high, Math.max(range.low, boundary));
  return { paneId, boundary: clamped, delta: clamped - splitEdge(located.node, axis) };
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
  options: StockSplitOptions,
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
    equal("pane-border-status", options.borderStatus),
    equal("pane-scrollbars", options.scrollbars),
    equal("window_layout", formatLiteral(request.expectedLayout)),
  ].reduceRight((rest, next) => `#{&&:${next},${rest}}`);
  // Relative, because tmux adds one to an absolute -y on the status line's edge.
  const flag =
    request.axis === "cols" ? (plan.delta > 0 ? "-R" : "-L") : plan.delta > 0 ? "-D" : "-U";
  const move =
    plan.delta === 0
      ? `display-message -p ""`
      : `resize-pane -t ${plan.paneId} ${flag} ${Math.abs(plan.delta)}`;
  const readback = `display-message -p -t ${request.windowId} "${marker} #{window_layout}"`;
  return `if-shell -F -t '${request.sessionId}:${request.windowId}' '${condition}' '${move} ; ${readback}' 'display-message -p ${marker} ; display-message -p ${marker}'`;
}
export type StockSplitResizeResult =
  | NativeSplitResizeResult
  | { status: "refused"; reason: "stale-layout" };

/** The format that reads a window's sizing options, and its parser. */
export const STOCK_SPLIT_OPTIONS_FORMAT =
  "#{pane-border-status}\t#{pane-scrollbars}\t#{pane-scrollbars-style}";
export interface StockSplitOptions extends StockSplitSizes {
  readonly scrollbars: string;
}
export function parseStockSplitOptions(line: string | undefined): StockSplitOptions | null {
  const [borderStatus, scrollbars, style] = (line ?? "").split("\t");
  // The raw value stays: the guarded command compares it with the option. A
  // floating value leaves tiled panes without a status line, like "off".
  if (
    !/^(off|top|bottom|top-floating|bottom-floating)$/u.test(borderStatus ?? "") ||
    !/^[a-z]+$/u.test(scrollbars ?? "")
  )
    return null;
  const field = (name: string) =>
    Number(new RegExp(`\\b${name}=(\\d+)`, "u").exec(style ?? "")?.[1] ?? 0);
  return {
    borderStatus: borderStatus!,
    scrollbars: scrollbars!,
    scrollbar: scrollbars === "off" ? 0 : Math.max(field("width"), 1) + field("pad"),
  };
}
export interface StockSplitIo {
  readonly readOptions: (windowId: string) => Promise<string[]>;
  readonly send: (command: string) => Promise<string[]>;
}

/** Authorizes, then sends the command without awaiting in between. A sent command
 * that does not answer as expected is uncertain: the caller must not retry it. */
export async function resizeStockSplit(
  request: NativeSplitResizeRequest,
  sessionCreated: string,
  authorizeBeforeEffect: () => void,
  io: StockSplitIo,
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
  let options: StockSplitOptions | null;
  try {
    options = parseStockSplitOptions((await io.readOptions(request.windowId))[0]);
  } catch {
    return { status: "refused", reason: "unsupported" };
  }
  if (!options) return { status: "refused", reason: "unsupported" };
  const plan = planStockSplitResize(before, request.path, request.axis, request.boundary, options);
  if (!plan) return { status: "refused", reason: "invalid-request" };
  const marker = `tmux-ide-split-${randomUUID()}`;
  const command = stockSplitCommand(
    request,
    sessionCreated,
    plan,
    leafCount(before),
    options,
    marker,
  );
  authorizeBeforeEffect();
  let reply: string[];
  try {
    reply = await io.send(command);
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
  // Only this boundary may have moved: its parent's other children keep their edges.
  const edges = (parent: typeof original.parent) =>
    parent.children.map((child) => splitEdge(child, request.axis));
  const moved = request.path.at(-1)!;
  const others = edges(actual.parent);
  if (edges(original.parent).some((edge, index) => index !== moved && edge !== others[index]))
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
