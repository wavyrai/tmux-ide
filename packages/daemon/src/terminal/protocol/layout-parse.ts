/**
 * PURE — tmux layout-string and control-notification parsing (M23.5).
 *
 * `%layout-change` arrives sub-millisecond after the server applies a layout
 * and ALWAYS precedes the first new-size `%output` (measured on tmux 3.7b:
 * the follow-up output can trail by as little as 0.2ms). The mirror therefore
 * derives pane geometry from the notification PAYLOAD itself instead of a
 * debounced `list-panes` round-trip — these parsers are that push path.
 *
 * The layout grammar mirrors tmux's `layout_parse.c`: a 4-hex-digit checksum,
 * a comma, then a cell. A cell is `WxH,X,Y` followed by either `,<paneId>`
 * (a leaf; the numeric pane id sans `%`), `{…}` (horizontal split) or `[…]`
 * (vertical split) with comma-separated child cells. The ROOT cell's WxH is
 * the authoritative window size. Parse the VISIBLE layout — the THIRD field
 * of `%layout-change @win <layout> <visible-layout> <flags>` — because zoom
 * collapses it to the single zoomed pane (`*Z` in flags = zoomed); the second
 * field keeps reporting the saved multi-pane layout.
 *
 * Everything here is unit-tested against layout strings captured from a real
 * tmux 3.7b server (splits, zoom, storms) — no tmux at test time.
 */

// Internal parsing bound, matching fleet catalog capacity. This is NOT the
// smaller pane-stream publication limit; future wire callers must enforce that.
const MAX_TREE_LEAVES = 512;

/** One visible pane rectangle, in window cells. `id` is `%`-prefixed. */
export interface LayoutLeaf {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A parsed (visible) layout: the window size + the leaves in layout order. */
export interface ParsedLayout {
  /** The root cell's WxH — the authoritative window size. */
  width: number;
  height: number;
  leaves: LayoutLeaf[];
}

/** Opt-in validated ancestry. Runtime pane IDs are not semantic pane identities. */
export type LayoutTreeNode =
  | ({ kind: "leaf" } & LayoutLeaf)
  | {
      kind: "split";
      axis: "cols" | "rows";
      left: number;
      top: number;
      width: number;
      height: number;
      children: LayoutTreeNode[];
    };

interface TreeContext {
  nodes: number;
  ids: Set<string>;
}

/**
 * Bounded ancestry parser, deliberately stricter than the legacy flat parser.
 * Up to 512 leaves (fleet catalog bound), 1023 nodes, depth 64 and 64 KiB.
 * Validates exact ordered tiling with one separator cell, including parent
 * bounds. The checksum prefix is grammar only, not an authenticity proof.
 */
export function parseLayoutTree(layout: string): LayoutTreeNode | null {
  if (layout.length > 64 * 1024 || !/^[0-9a-fA-F]{4},/.test(layout)) return null;
  const s = layout.slice(5);
  const root = parseCell(s, 0, [], { nodes: 0, ids: new Set() });
  if (!root?.node || root.pos !== s.length || root.node.left !== 0 || root.node.top !== 0)
    return null;
  return root.node;
}

/** Parse a tmux layout string (`csum,WxH,X,Y…`). Null on any malformed input
 *  (the caller falls back to the slow list-panes path — never throw here). */
export function parseLayout(layout: string): ParsedLayout | null {
  if (!/^[0-9a-fA-F]{4},/.test(layout)) return null;
  const s = layout.slice(5);
  const leaves: LayoutLeaf[] = [];
  const root = parseCell(s, 0, leaves);
  if (!root || root.pos !== s.length) return null;
  return { width: root.width, height: root.height, leaves };
}

/** Recursive-descent cell parse from `pos`; appends leaves in layout order. */
function parseCell(
  s: string,
  pos: number,
  leaves: LayoutLeaf[],
  tree?: TreeContext,
  depth = 1,
): { width: number; height: number; pos: number; node?: LayoutTreeNode } | null {
  if (tree && (depth > 64 || ++tree.nodes > MAX_TREE_LEAVES * 2 - 1)) return null;
  const dims = readDims(s, pos);
  if (!dims) return null;
  const { width, height, left, top } = dims;
  if (
    tree &&
    (![width, height, left, top, left + width, top + height].every(Number.isSafeInteger) ||
      width <= 0 ||
      height <= 0 ||
      left < 0 ||
      top < 0)
  )
    return null;
  pos = dims.pos;
  const ch = s[pos];
  if (ch === ",") {
    // Leaf: the numeric pane id.
    const id = readInt(s, pos + 1);
    if (!id) return null;
    const leaf = { id: `%${id.value}`, left, top, width, height };
    if (tree) {
      if (
        !Number.isSafeInteger(id.value) ||
        tree.ids.has(leaf.id) ||
        tree.ids.size >= MAX_TREE_LEAVES
      )
        return null;
      tree.ids.add(leaf.id);
    }
    leaves.push(leaf);
    return {
      width,
      height,
      pos: id.pos,
      ...(tree ? { node: { kind: "leaf" as const, ...leaf } } : {}),
    };
  }
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    const children: LayoutTreeNode[] = [];
    pos++;
    for (;;) {
      const child = parseCell(s, pos, leaves, tree, depth + 1);
      if (!child) return null;
      if (tree && child.node) children.push(child.node);
      pos = child.pos;
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] === close) {
        if (!tree) return { width, height, pos: pos + 1 };
        const axis = ch === "{" ? "cols" : "rows";
        const node: LayoutTreeNode = { kind: "split", axis, left, top, width, height, children };
        if (!tilesParent(node)) return null;
        return { width, height, pos: pos + 1, node };
      }
      return null;
    }
  }
  // A bare root leaf ends the string (`…,0,0,445`): ch is undefined only when
  // the leaf id was consumed above, so anything else here is malformed.
  return null;
}

/** Child ordering and separator widths must describe precisely this parent. */
function tilesParent(node: Extract<LayoutTreeNode, { kind: "split" }>): boolean {
  if (node.children.length < 2) return false;
  const cols = node.axis === "cols";
  let next = cols ? node.left : node.top;
  for (const child of node.children) {
    if (
      (cols ? child.left : child.top) !== next ||
      (cols ? child.top : child.left) !== (cols ? node.top : node.left) ||
      (cols ? child.height : child.width) !== (cols ? node.height : node.width)
    )
      return false;
    next += (cols ? child.width : child.height) + 1;
    if (!Number.isSafeInteger(next)) return false;
  }
  return next - 1 === (cols ? node.left + node.width : node.top + node.height);
}

/** Read `WxH,X,Y` at `pos`. */
function readDims(
  s: string,
  pos: number,
): { width: number; height: number; left: number; top: number; pos: number } | null {
  const w = readInt(s, pos);
  if (!w || s[w.pos] !== "x") return null;
  const h = readInt(s, w.pos + 1);
  if (!h || s[h.pos] !== ",") return null;
  const x = readInt(s, h.pos + 1);
  if (!x || s[x.pos] !== ",") return null;
  const y = readInt(s, x.pos + 1);
  if (!y) return null;
  return { width: w.value, height: h.value, left: x.value, top: y.value, pos: y.pos };
}

/** Read a decimal integer at `pos` (at least one digit). */
function readInt(s: string, pos: number): { value: number; pos: number } | null {
  let end = pos;
  while (end < s.length && s.charCodeAt(end) >= 0x30 && s.charCodeAt(end) <= 0x39) end++;
  if (end === pos) return null;
  return { value: Number(s.slice(pos, end)), pos: end };
}

/** A parsed `%layout-change` notification body. */
export interface LayoutChange {
  windowId: string;
  /** The saved (full) layout — kept for debugging; geometry uses `visible`. */
  layout: string;
  /** The VISIBLE layout — collapses to the single zoomed pane under zoom. */
  visible: string;
  /** `Z` present in the flags field (`*Z`). */
  zoomed: boolean;
}

/** Parse the body after `%layout-change ` (tmux 3.7b:
 *  `@387 <layout> <visible-layout> *Z`). Null when the shape is off. */
export function parseLayoutChange(rest: string): LayoutChange | null {
  const parts = rest.trim().split(/\s+/);
  const [windowId = "", layout = "", visible = "", flags = ""] = parts;
  if (parts.length < 3 || !windowId.startsWith("@")) return null;
  return { windowId, layout, visible, zoomed: flags.includes("Z") };
}

/** Parse the body after `%window-pane-changed ` (`@387 %443`). */
export function parseWindowPaneChanged(rest: string): { windowId: string; paneId: string } | null {
  const [windowId = "", paneId = ""] = rest.trim().split(/\s+/);
  if (!windowId.startsWith("@") || !paneId.startsWith("%")) return null;
  return { windowId, paneId };
}

/** Parse the body after `%session-window-changed ` (`$353 @388`). */
export function parseSessionWindowChanged(rest: string): { windowId: string } | null {
  const [, windowId = ""] = rest.trim().split(/\s+/);
  if (!windowId.startsWith("@")) return null;
  return { windowId };
}

/** Parse the body after `%subscription-changed ` for the mirror's `mouse`
 *  subscription (tmux 3.7b: `mouse $353 @387 0 %445 : 1`). Null for other
 *  subscription names or an off shape. */
export function parseMouseSubscription(rest: string): { paneId: string; on: boolean } | null {
  const m = /^mouse\s+\$\S+\s+@\S+\s+\S+\s+(%\S+)\s*:\s*(.*)$/.exec(rest.trim());
  if (!m) return null;
  return { paneId: m[1]!, on: m[2]!.trim() === "1" };
}
