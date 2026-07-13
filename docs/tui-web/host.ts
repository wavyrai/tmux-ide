/**
 * The web host: a solid-js universal renderer that maps OpenTUI's intrinsics to
 * DOM instead of to a terminal cell grid.
 *
 * The app's entire UI vocabulary is three elements — <text> (268 uses), <box>
 * (180), <scrollbox> (5) — and OpenTUI lays out with Yoga, which is flexbox. So
 * the mapping is nearly 1:1: <box> is a flex div, <text> is a span, and terminal
 * cells become `ch` units on a monospace grid. Same components, same props, a
 * different backend.
 *
 * Sizing law: EVERY horizontal length is in `ch` and every vertical one in
 * `lh` (one cell = 1ch × 1lh). Mixing px in here is what makes a char-grid UI
 * drift a half-cell out of alignment, so don't.
 */
import { createRenderer } from "solid-js/universal";
import { RGBA } from "./opentui-shim.ts";

/** OpenTUI's `attributes` bitfield — only bold (1) is used by the surfaces we render. */
const ATTR_BOLD = 1;

type Props = Record<string, unknown>;

const isColor = (v: unknown): v is RGBA => v instanceof RGBA;
const cells = (v: unknown, axis: "ch" | "lh"): string | null =>
  typeof v === "number" ? `${v}${axis}` : null;

/**
 * Translate one OpenTUI prop onto an element's style/attrs. Unknown props are
 * ignored rather than thrown on, so a component using a prop the web host hasn't
 * learned yet renders *slightly* wrong instead of crashing the page.
 */
function applyProp(el: HTMLElement, name: string, value: unknown): void {
  const s = el.style;
  switch (name) {
    // --- layout (Yoga → flexbox) ---
    case "flexDirection":
      s.flexDirection = String(value);
      return;
    case "flexGrow":
      s.flexGrow = String(value);
      return;
    case "gap":
      s.gap = cells(value, "ch") ?? "";
      return;
    case "width":
      s.width = cells(value, "ch") ?? "";
      return;
    case "height":
      s.height = cells(value, "lh") ?? "";
      return;
    case "paddingLeft":
      s.paddingLeft = cells(value, "ch") ?? "";
      return;
    case "marginTop":
      s.marginTop = cells(value, "lh") ?? "";
      return;
    case "overflow":
      s.overflow = String(value);
      return;
    case "position":
      s.position = value === "absolute" ? "absolute" : "relative";
      return;
    case "left":
      s.left = cells(value, "ch") ?? "";
      return;
    case "top":
      s.top = cells(value, "lh") ?? "";
      return;
    case "right":
      s.right = cells(value, "ch") ?? "";
      return;

    // --- paint ---
    case "backgroundColor":
    case "bg":
      if (isColor(value)) s.backgroundColor = value.css();
      return;
    case "fg":
      if (isColor(value)) s.color = value.css();
      return;
    case "attributes":
      s.fontWeight = ((value as number) & ATTR_BOLD) === ATTR_BOLD ? "700" : "400";
      return;

    // --- input ---
    // OpenTUI hands the app ONE onMouse carrying CELL coordinates, and the app
    // resolves what was hit with pure routers (sidebarHit). We keep that exact
    // contract and synthesize the cells from DOM pixels, so the web reuses those
    // routers instead of re-deriving hit-testing from the DOM tree — the two
    // hosts can't drift on which row is under the pointer.
    case "onMouse":
      bindMouse(el, value as (e: CellMouseEvent) => void);
      return;
    default:
      return;
  }
}

/** The subset of OpenTUI's MouseEvent the shared surfaces read. */
export interface CellMouseEvent {
  type: "move" | "down" | "up" | "drag-end";
  x: number;
  y: number;
  button?: number;
}

/**
 * Pixels → cells. Measured from the live element rather than assumed, because
 * `ch` and `lh` depend on the font that actually loaded; hard-coding a cell size
 * is how a char-grid drifts a row off under a fallback font.
 */
function cellSize(el: HTMLElement): { w: number; h: number } {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  probe.textContent = "M".repeat(10);
  el.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  const cs = getComputedStyle(el);
  el.removeChild(probe);
  return {
    w: rect.width / 10 || 8,
    h: parseFloat(cs.lineHeight) || rect.height || 16,
  };
}

function bindMouse(el: HTMLElement, handler: (e: CellMouseEvent) => void): void {
  const toCells = (ev: MouseEvent): { x: number; y: number } => {
    const box = el.getBoundingClientRect();
    const { w, h } = cellSize(el);
    return {
      x: Math.floor((ev.clientX - box.left) / w),
      y: Math.floor((ev.clientY - box.top) / h),
    };
  };
  el.onmousemove = (ev) => handler({ type: "move", ...toCells(ev) });
  el.onmousedown = (ev) => handler({ type: "down", button: ev.button, ...toCells(ev) });
  el.onmouseup = (ev) => handler({ type: "up", button: ev.button, ...toCells(ev) });
  // Leaving the column clears hover — the terminal gets this for free because
  // the pointer lands on some other region's handler.
  el.onmouseleave = () => handler({ type: "move", x: -1, y: -1 });
}

export const {
  render,
  effect,
  memo,
  createComponent,
  createElement,
  createTextNode,
  insertNode,
  insert,
  spread,
  setProp,
  mergeProps,
} = createRenderer<HTMLElement | Text>({
  createElement(tag: string): HTMLElement {
    const el = document.createElement("div");
    el.dataset.tui = tag;
    const s = el.style;
    if (tag === "text") {
      s.display = "block";
      s.whiteSpace = "pre";
    } else {
      // box and scrollbox are flex containers; column is OpenTUI's default.
      s.display = "flex";
      s.flexDirection = "column";
      s.flexShrink = "0";
    }
    if (tag === "scrollbox") s.overflowY = "auto";
    return el;
  },

  createTextNode: (value: string) => document.createTextNode(value),
  replaceText: (node, value) => {
    (node as Text).data = value;
  },

  setProperty(node, name, value) {
    if (node instanceof HTMLElement) applyProp(node, name, value);
  },

  insertNode: (parent, node, anchor) => {
    parent.insertBefore(node, anchor ?? null);
  },
  removeNode: (parent, node) => {
    parent.removeChild(node);
  },
  isTextNode: (node) => node.nodeType === 3,
  // The DOM's traversal types are wider than our node union (ParentNode /
  // ChildNode); every node in this tree is one we created, so narrowing is safe.
  getParentNode: (node) => (node.parentNode as HTMLElement | null) ?? undefined,
  getFirstChild: (node) => (node.firstChild as HTMLElement | Text | null) ?? undefined,
  getNextSibling: (node) => (node.nextSibling as HTMLElement | Text | null) ?? undefined,
});
