import { parseLayoutTree, type LayoutTreeNode } from "./layout-parse.ts";

export interface NativeSplitResizeRequest {
  readonly sessionId: string;
  readonly windowId: string;
  readonly expectedLayout: string;
  readonly path: readonly number[];
  readonly axis: "cols" | "rows";
  readonly boundary: number;
}

/** Caller-owned runner must pin server/binary and bound execution/output. At
 * mutation dispatch it must enforce generation/session/pane lifetime and
 * authorizeBeforeEffect. Neither capability nor layout is an authority proof. */
export type NativeSplitRunner = (args: readonly string[]) => string | Promise<string>;
export type NativeSplitResizeResult =
  | { status: "refused"; reason: "invalid-request" | "unsupported" }
  | { status: "uncertain"; reason: "command-failed" | "invalid-receipt" }
  | { status: "applied"; boundary: number; layout: string; tree: LayoutTreeNode; changed: boolean };

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function json(text: string, limit: number): unknown {
  if (typeof text !== "string" || text.length > limit || Buffer.byteLength(text) > limit)
    throw new Error("Bounded native response required");
  return JSON.parse(text);
}
function capability(text: string): boolean {
  const value = json(text, 1024);
  return (
    object(value, [
      "schemaVersion",
      "capability",
      "sessionMembership",
      "maxDepth",
      "maxLeaves",
      "maxGrid",
    ]) &&
    value.schemaVersion === 1 &&
    value.capability === "split-resize-v1" &&
    value.sessionMembership === "exact-session-link-v1" &&
    value.maxDepth === 64 &&
    value.maxLeaves === 512 &&
    value.maxGrid === 4096
  );
}
function validTree(tree: LayoutTreeNode): boolean {
  let budget = 5;
  const visit = (node: LayoutTreeNode): boolean => {
    if (node.left + node.width > 4096 || node.top + node.height > 4096) return false;
    budget += 21;
    if (node.kind === "leaf") {
      const id = node.id.slice(1);
      if (!/^(0|[1-9][0-9]*)$/.test(id) || Number(id) > 0xffffffff) return false;
      budget += id.length;
    } else if (!node.children.every(visit)) return false;
    return budget <= 8192;
  };
  return visit(tree);
}
function locate(tree: LayoutTreeNode, path: readonly number[]) {
  let node = tree;
  let parent: Extract<LayoutTreeNode, { kind: "split" }> | undefined;
  for (const index of path) {
    if (node.kind !== "split" || !node.children[index]) return null;
    parent = node;
    node = node.children[index]!;
  }
  return parent && path.at(-1)! < parent.children.length - 1 ? { parent, node } : null;
}
function edge(node: LayoutTreeNode, axis: "cols" | "rows") {
  return axis === "cols" ? node.left + node.width : node.top + node.height;
}
function sameRect(a: LayoutTreeNode, b: LayoutTreeNode) {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}
/** Only geometry inside the exact parent may change, along the requested axis.
 * Native redistribution can affect multiple siblings. This verifies convergence,
 * not exclusive causation or authentication of the returned layout. */
function preservesTree(
  before: LayoutTreeNode,
  after: LayoutTreeNode,
  affected: LayoutTreeNode,
  axis: "cols" | "rows",
  inside = false,
): boolean {
  const begins = before === affected;
  if (before.kind !== after.kind || ((!inside || begins) && !sameRect(before, after))) return false;
  inside ||= begins;
  if (
    inside &&
    (axis === "cols"
      ? before.top !== after.top || before.height !== after.height
      : before.left !== after.left || before.width !== after.width)
  )
    return false;
  if (before.kind === "leaf") return after.kind === "leaf" && before.id === after.id;
  return (
    after.kind === "split" &&
    before.axis === after.axis &&
    before.children.length === after.children.length &&
    before.children.every((child, index) =>
      preservesTree(child, after.children[index]!, affected, axis, inside),
    )
  );
}

/** Internal foundation only; no route or native capability is enabled here.
 * Capability is checked on every invocation, never cached across generations.
 * A failed command or invalid post-dispatch receipt is uncertain: do not retry. */
export async function resizeNativeSplit(
  request: NativeSplitResizeRequest,
  runTmux: NativeSplitRunner,
): Promise<NativeSplitResizeResult> {
  let captured: NativeSplitResizeRequest, before: LayoutTreeNode;
  try {
    if (
      !object(request, ["sessionId", "windowId", "expectedLayout", "path", "axis", "boundary"]) ||
      typeof request.sessionId !== "string" ||
      !/^\$(0|[1-9][0-9]{0,9})$/.test(request.sessionId) ||
      Number(request.sessionId.slice(1)) > 0xffffffff ||
      typeof request.windowId !== "string" ||
      !/^@(0|[1-9][0-9]{0,9})$/.test(request.windowId) ||
      Number(request.windowId.slice(1)) > 0xffffffff ||
      typeof request.expectedLayout !== "string" ||
      !Array.isArray(request.path) ||
      request.path.length < 1 ||
      request.path.length >= 64 ||
      request.path.some((index) => !Number.isInteger(index) || index < 0 || index > 511) ||
      request.path.join(".").length > 256 ||
      (request.axis !== "cols" && request.axis !== "rows") ||
      !Number.isInteger(request.boundary) ||
      request.boundary < 0 ||
      request.boundary > 4096
    )
      return { status: "refused", reason: "invalid-request" };
    const tree = parseLayoutTree(request.expectedLayout);
    if (!tree || !validTree(tree)) return { status: "refused", reason: "invalid-request" };
    const selected = locate(tree, request.path);
    if (!selected || selected.parent.axis !== request.axis)
      return { status: "refused", reason: "invalid-request" };
    before = tree;
    // Snapshot all command data before any await or externally supplied callback.
    captured = { ...request, path: [...request.path] };
  } catch {
    return { status: "refused", reason: "invalid-request" };
  }
  try {
    if (!capability(await runTmux(["tmux-ide-resize-split", "-V"])))
      return { status: "refused", reason: "unsupported" };
  } catch {
    return { status: "refused", reason: "unsupported" };
  }
  let response: string;
  try {
    response = await runTmux([
      "tmux-ide-resize-split",
      "-t",
      captured.windowId,
      "-s",
      captured.sessionId,
      "-E",
      captured.expectedLayout,
      "-p",
      captured.path.join("."),
      "-a",
      captured.axis,
      "-c",
      String(captured.boundary),
    ]);
  } catch {
    return { status: "uncertain", reason: "command-failed" };
  }
  try {
    const receipt = json(response, 16 * 1024);
    if (
      !object(receipt, ["schemaVersion", "boundary", "layout"]) ||
      receipt.schemaVersion !== 1 ||
      typeof receipt.layout !== "string" ||
      typeof receipt.boundary !== "number" ||
      !Number.isInteger(receipt.boundary) ||
      receipt.boundary < 0 ||
      receipt.boundary > 4096
    )
      return { status: "uncertain", reason: "invalid-receipt" };
    const after = parseLayoutTree(receipt.layout);
    const original = locate(before, captured.path)!;
    const actual = after && locate(after, captured.path);
    const previous = edge(original.node, captured.axis);
    if (
      !after ||
      !validTree(after) ||
      !actual ||
      !preservesTree(before, after, original.parent, captured.axis) ||
      receipt.boundary !== edge(actual.node, captured.axis) ||
      receipt.boundary < Math.min(previous, captured.boundary) ||
      receipt.boundary > Math.max(previous, captured.boundary)
    )
      return { status: "uncertain", reason: "invalid-receipt" };
    return {
      status: "applied",
      boundary: receipt.boundary,
      layout: receipt.layout,
      tree: after,
      changed: receipt.layout !== captured.expectedLayout,
    };
  } catch {
    return { status: "uncertain", reason: "invalid-receipt" };
  }
}
