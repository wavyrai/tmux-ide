/**
 * Pure predicates for the multi-terminal tab keybinds (G20-P3).
 *
 * Contract:
 *   Cmd/Ctrl+T            → new tab
 *   Cmd/Ctrl+W            → close current tab
 *   Cmd/Ctrl+1..9         → switch to tab index 0..8
 *
 * Mac uses Cmd; everyone else uses Ctrl. Other modifiers reject —
 * users with custom keyboard layouts that need Cmd+Shift+T (reopen)
 * land later; G20-P3 stays minimal.
 *
 * All predicates are pure functions of `KeyEventLike + isMacPlatform`
 * so vitest can exercise every modifier permutation without a real
 * keyboard.
 */

export type KeyEventLike = {
  type: string;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

function isPrimaryModifierOnly(event: KeyEventLike, isMacPlatform: boolean): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (isMacPlatform) {
    return event.metaKey === true && event.ctrlKey !== true;
  }
  return event.ctrlKey === true && event.metaKey !== true;
}

export function shouldOpenNewTab(event: KeyEventLike, isMacPlatform: boolean): boolean {
  return (
    event.type === "keydown" &&
    event.key.toLowerCase() === "t" &&
    isPrimaryModifierOnly(event, isMacPlatform)
  );
}

export function shouldCloseCurrentTab(event: KeyEventLike, isMacPlatform: boolean): boolean {
  return (
    event.type === "keydown" &&
    event.key.toLowerCase() === "w" &&
    isPrimaryModifierOnly(event, isMacPlatform)
  );
}

/** Resolve a Cmd/Ctrl+1..9 keydown to a zero-based tab index, or null
 *  when the event doesn't match. `0` (the digit zero) is intentionally
 *  unbound — terminal apps frequently use Ctrl-0 / Cmd-0 to reset font
 *  size and stealing that would surprise users. */
export function resolveTabIndexShortcut(
  event: KeyEventLike,
  isMacPlatform: boolean,
): number | null {
  if (event.type !== "keydown") return null;
  if (!isPrimaryModifierOnly(event, isMacPlatform)) return null;
  const digit = Number.parseInt(event.key, 10);
  if (!Number.isFinite(digit) || digit < 1 || digit > 9) return null;
  return digit - 1;
}

/** Read once at module load so SSR builds don't try to touch
 *  `navigator`. Falls back to `false` when the navigator is missing. */
export function detectIsMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  const platform = typeof navigator.platform === "string" ? navigator.platform : "";
  return /mac|iphone|ipad|ipod/i.test(platform) || /Macintosh|Mac OS X/i.test(ua);
}
