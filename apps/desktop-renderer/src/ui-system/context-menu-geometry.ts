/**
 * Pointer-anchored menu placement and roving focus — the pure half of
 * {@link ./context-menu.tsx}.
 *
 * Both answers are computed rather than styled: a menu opened at the pointer
 * near the bottom-right of a window has to flip, and a menu whose arrow keys
 * skip its disabled items teaches nobody why they are disabled. Keeping the two
 * rules here means they are tested against numbers instead of against a
 * screenshot.
 */

export interface ContextMenuPoint {
  readonly x: number;
  readonly y: number;
}

export interface ContextMenuSize {
  readonly width: number;
  readonly height: number;
}

export interface ContextMenuPlacement {
  readonly left: number;
  readonly top: number;
  /** Which way the menu grew from the pointer, for the open transition's origin. */
  readonly originX: "left" | "right";
  readonly originY: "top" | "bottom";
}

/** Gap kept between the menu and the viewport edge. */
export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/**
 * Place a menu at the pointer.
 *
 * The menu opens down-and-right of the click, which is where a pointer user
 * expects it and what keeps the pointer outside the menu's first item. It flips
 * to the other side of the pointer when that side does not fit, and clamps to
 * the viewport when neither does — a menu partly off screen has items that
 * cannot be clicked at all, which is worse than one that overlaps the pointer.
 */
export function resolveContextMenuPlacement(
  pointer: ContextMenuPoint,
  menu: ContextMenuSize,
  viewport: ContextMenuSize,
  margin: number = CONTEXT_MENU_VIEWPORT_MARGIN,
): ContextMenuPlacement {
  const fitsRight = pointer.x + menu.width + margin <= viewport.width;
  const fitsLeft = pointer.x - menu.width - margin >= 0;
  const originX: ContextMenuPlacement["originX"] = fitsRight || !fitsLeft ? "left" : "right";
  const fitsBelow = pointer.y + menu.height + margin <= viewport.height;
  const fitsAbove = pointer.y - menu.height - margin >= 0;
  const originY: ContextMenuPlacement["originY"] = fitsBelow || !fitsAbove ? "top" : "bottom";

  const left = originX === "left" ? pointer.x : pointer.x - menu.width;
  const top = originY === "top" ? pointer.y : pointer.y - menu.height;
  return {
    originX,
    originY,
    left: clamp(left, margin, viewport.width - menu.width - margin),
    top: clamp(top, margin, viewport.height - menu.height - margin),
  };
}

export type ContextMenuNavigationKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * The next focused item index for a navigation key.
 *
 * Disabled items are INCLUDED in the ring. They are rendered with the reason
 * they are unavailable, and a keyboard user who cannot land on them is the one
 * user who never gets to read it. Activation is refused separately, by the
 * component, so nothing is dispatched from a stop here.
 *
 * Returns null for an empty menu; wraps in both directions otherwise.
 */
export function nextContextMenuIndex(
  itemCount: number,
  current: number | null,
  key: ContextMenuNavigationKey,
): number | null {
  if (itemCount <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  const step = key === "ArrowDown" ? 1 : -1;
  if (current === null) return step === 1 ? 0 : itemCount - 1;
  return (current + step + itemCount) % itemCount;
}

/**
 * The index of the first item a menu should focus when it opens with the
 * keyboard: the first item that can actually be activated, else the first item.
 */
export function initialContextMenuIndex(enabled: readonly boolean[]): number | null {
  if (enabled.length === 0) return null;
  const first = enabled.indexOf(true);
  return first === -1 ? 0 : first;
}
