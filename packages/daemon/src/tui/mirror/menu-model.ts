/**
 * The right-click context-menu model (M19.2) — PURE so it unit-tests without
 * OpenTUI. app.tsx opens a small overlay at the pointer on a right-button press
 * (SGR button 2); the ITEM DESCRIPTORS per region and all the geometry (dims,
 * on-screen clamp, click hit-test) live here, while the closures that actually
 * attach / kill / split / rename stay in the app (a `run` switch over the
 * item's `id`).
 *
 * The overlay is late-mounted inside a <Show>, so — per the app's mouse
 * landmine laws — it carries NO per-item handlers: clicks are routed centrally
 * by coordinate math against {@link menuItemAt}, exactly the way the surface
 * tab bar and window strip resolve their clicks by x-span math. Keeping that
 * math in one tested place is the whole point.
 */

/** The surfaces a right-click can target. Each maps to a fixed item list; the
 *  concrete payload (session name, file path, pane id) rides in the app's menu
 *  state, not here. */
export type MenuRegion = "session" | "file" | "difffile" | "pane" | "window";

/** One menu entry. `id` is what the app dispatches on; `danger` items rearm to
 *  a "confirm: y" state instead of firing immediately; `input` items open an
 *  inline text line (the string is the prompt) before firing; `children` items
 *  open a SUBMENU column beside the row (one nesting level); `checkbox` items
 *  carry a live ✓/✗ state the app supplies (the toggle keeps the menu open). */
export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  input?: string;
  children?: MenuItem[];
  checkbox?: boolean;
}

/** PURE — the fixed item list for each region. The app supplies the context. */
export const MENU_ITEMS: Record<MenuRegion, MenuItem[]> = {
  session: [
    { id: "attach", label: "Attach" },
    { id: "rename", label: "Rename", input: "rename to" },
    { id: "kill", label: "Kill session", danger: true },
  ],
  file: [
    { id: "open", label: "Open" },
    { id: "newfile", label: "New file", input: "new file" },
    { id: "rename", label: "Rename", input: "rename to" },
    { id: "delete", label: "Delete", danger: true },
  ],
  difffile: [
    { id: "open", label: "Open in editor" },
    { id: "copypath", label: "Copy path" },
  ],
  pane: [
    { id: "split-h", label: "Split horizontal" },
    { id: "split-v", label: "Split vertical" },
    { id: "zoom", label: "Zoom toggle" },
    { id: "swap-next", label: "Swap with next" },
    { id: "break", label: "Break to window" },
    { id: "rotate", label: "Rotate panes" },
    {
      id: "layouts",
      label: "Layouts",
      children: [
        { id: "layout:even-horizontal", label: "even-horizontal" },
        { id: "layout:even-vertical", label: "even-vertical" },
        { id: "layout:main-horizontal", label: "main-horizontal" },
        { id: "layout:main-vertical", label: "main-vertical" },
        { id: "layout:tiled", label: "tiled" },
      ],
    },
    { id: "sync-toggle", label: "Synchronize panes", checkbox: true },
    { id: "kill", label: "Kill pane", danger: true },
  ],
  window: [
    { id: "new", label: "New window" },
    { id: "rename", label: "Rename window", input: "rename to" },
    { id: "kill", label: "Kill window", danger: true },
  ],
};

/** PURE — the pane menu's item list for a concrete pane (M22.9). App-mouse
 *  panes (the app turned mouse reporting on — presses are forwarded, so a drag
 *  can't start a selection) get a leading "Select text…" verb that pauses
 *  forwarding for that pane; while its select mode is active the entry flips to
 *  the exit verb. Ordinary panes keep the fixed list untouched. */
export function paneMenuItems(appMouse: boolean, selectModeOn: boolean): MenuItem[] {
  if (!appMouse) return MENU_ITEMS.pane;
  const entry: MenuItem = selectModeOn
    ? { id: "select-text-off", label: "Stop selecting" }
    : { id: "select-text", label: "Select text…" };
  return [entry, ...MENU_ITEMS.pane];
}

/** The overlay's border (1) + horizontal padding (1 each side). The header row
 *  and every item row live INSIDE this frame. */
const BORDER = 1;
const PAD = 1;
/** A minimum inner text width so a short menu still reads as a panel. */
const MIN_INNER = 16;
/** The suffix a destructive item rearms to (label + this). Reserved in the
 *  width so "confirm: y" is never clipped — the render appends the SAME string. */
export const CONFIRM_SUFFIX = "  confirm: y";
/** The caret a `children` item renders flush-right ("› Layouts        ▸"): a
 *  leading space + the glyph, reserved in the width so a submenu row's caret is
 *  never clipped. The base "› " prefix (2) already sits on every row. */
export const SUBMENU_CARET = " ▸";

/** PURE — the overlay's cell dimensions for `title` + `items`. Width fits the
 *  longest of the title and item rows (each item reserves 2 cells for the "› "
 *  selection prefix); height is the top border + header + items + bottom border.
 *  Item labels leave slack for the longer "confirm: y" / input renderings, which
 *  never need to exceed the base width in practice. */
export function menuDims(title: string, items: MenuItem[]): { width: number; height: number } {
  const inner = Math.max(
    MIN_INNER,
    title.length,
    // A danger item's rearmed "label  confirm: y" must fit; a `children` item
    // reserves the "› " prefix AND the flush-right submenu caret; a `checkbox`
    // item's ✓/✗ mark is the same width as the "› " prefix it replaces. Others
    // reserve 2 cells for the "› " selection prefix.
    ...items.map((it) => {
      if (it.danger) return it.label.length + CONFIRM_SUFFIX.length;
      if (it.children) return it.label.length + 2 + SUBMENU_CARET.length;
      return it.label.length + 2;
    }),
  );
  return { width: inner + PAD * 2 + BORDER * 2, height: items.length + 3 };
}

/** PURE — the on-screen top-left for a menu of `width`×`height` opened at
 *  (`x`,`y`), clamped so the whole box stays on a `screenW`×`screenH` grid. */
export function clampMenuPos(
  x: number,
  y: number,
  width: number,
  height: number,
  screenW: number,
  screenH: number,
): { left: number; top: number } {
  const left = Math.max(0, Math.min(x, screenW - width));
  const top = Math.max(0, Math.min(y, screenH - height));
  return { left, top };
}

/** The placed overlay's geometry — what the hit-tests need. */
export interface MenuGeom {
  left: number;
  top: number;
  width: number;
  height: number;
  itemCount: number;
}

/** PURE — the item index under (`x`,`y`), or -1 when the point is not on an item
 *  row (the border, the header, or outside the box). Item `i` renders one row
 *  below the top border + header, i.e. at screen y = top + 2 + i. */
export function menuItemAt(m: MenuGeom, x: number, y: number): number {
  if (x < m.left || x >= m.left + m.width) return -1;
  const i = y - (m.top + BORDER + 1);
  return i >= 0 && i < m.itemCount ? i : -1;
}

/** PURE — is (`x`,`y`) anywhere inside the overlay box (item, header, or border)?
 *  A down INSIDE that isn't on an item is a no-op (menu stays); a down OUTSIDE
 *  closes the menu. */
export function pointInMenu(m: MenuGeom, x: number, y: number): boolean {
  return x >= m.left && x < m.left + m.width && y >= m.top && y < m.top + m.height;
}

/** PURE — the on-screen top-left for the SUBMENU column that opens beside the
 *  `parent` item at `parentItemIndex`. It opens to the RIGHT of the parent, its
 *  top border aligned with the parent item's row, then clamps fully on-screen
 *  (sliding left over the parent if the right edge would overflow — acceptable
 *  since the keyboard/coordinate router owns whichever column is focused). */
export function submenuPos(
  parent: MenuGeom,
  parentItemIndex: number,
  width: number,
  height: number,
  screenW: number,
  screenH: number,
): { left: number; top: number } {
  const x = parent.left + parent.width;
  // The parent item renders at y = parent.top + BORDER + header(1) + index; put
  // the submenu's top border on that same row so the columns read as connected.
  const y = parent.top + BORDER + 1 + parentItemIndex;
  return clampMenuPos(x, y, width, height, screenW, screenH);
}
