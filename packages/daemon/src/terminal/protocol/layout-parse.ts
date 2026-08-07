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
): { width: number; height: number; pos: number } | null {
  const dims = readDims(s, pos);
  if (!dims) return null;
  const { width, height, left, top } = dims;
  pos = dims.pos;
  const ch = s[pos];
  if (ch === ",") {
    // Leaf: the numeric pane id.
    const id = readInt(s, pos + 1);
    if (!id) return null;
    leaves.push({ id: `%${id.value}`, left, top, width, height });
    return { width, height, pos: id.pos };
  }
  if (ch === "{" || ch === "[") {
    const close = ch === "{" ? "}" : "]";
    pos++;
    for (;;) {
      const child = parseCell(s, pos, leaves);
      if (!child) return null;
      pos = child.pos;
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] === close) return { width, height, pos: pos + 1 };
      return null;
    }
  }
  // A bare root leaf ends the string (`…,0,0,445`): ch is undefined only when
  // the leaf id was consumed above, so anything else here is malformed.
  return null;
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
