/**
 * Pure terminal keybinding predicates (G20-P1).
 *
 * Eight side-effect-free `(event, isMacPlatform) → boolean` functions
 * the usePty hook (lands later) calls to decide whether to consume a
 * key event vs let xterm have it. Pure-state-machine design so the
 * test suite can drive every permutation without a real xterm.
 */

export type KeyEventLike = {
  type: string;
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
};

/** Ctrl-J sends LF — CLI agents that read line-by-line accept this as
 *  "soft newline" when the user typed Shift-Enter. */
export const CTRL_J_ASCII = "\x0A";

/** Ctrl-U → readline's "unix-line-discard". */
export const CTRL_U_ASCII = "\x15";

export function shouldMapShiftEnterToCtrlJ(event: KeyEventLike): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey === true &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

export function shouldHandleInterruptFromTerminal(event: KeyEventLike): boolean {
  return (
    event.type === "keydown" &&
    event.key === "Escape" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

export function shouldCopySelectionFromTerminal(
  event: KeyEventLike,
  isMacPlatform: boolean,
  hasSelection: boolean,
): boolean {
  if (!hasSelection) return false;
  if (event.type !== "keydown") return false;
  if (event.key.toLowerCase() !== "c") return false;
  const ctrl = event.ctrlKey === true;
  const meta = event.metaKey === true;
  const alt = event.altKey === true;
  const shift = event.shiftKey === true;
  // Ctrl+Shift+C copies on every platform.
  if (ctrl && shift && !meta && !alt) return true;
  if (isMacPlatform) return meta && !ctrl && !shift && !alt;
  return ctrl && !meta && !shift && !alt;
}

/** Cmd-Backspace on macOS → emit Ctrl-U so the shell treats it as
 *  unix-line-discard. Linux/Windows already get the right effect via
 *  the user's native Ctrl-U. */
export function shouldKillLineFromTerminal(event: KeyEventLike, isMacPlatform: boolean): boolean {
  if (!isMacPlatform) return false;
  if (event.type !== "keydown") return false;
  if (event.key !== "Backspace") return false;
  return event.metaKey === true && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Ctrl+Shift+V is the canonical Linux-terminal paste shortcut and
 *  doesn't reach the OS clipboard via the browser default — we
 *  intercept and re-dispatch through the clipboard API. */
export function shouldPasteToTerminal(event: KeyEventLike, isMacPlatform: boolean): boolean {
  if (event.type !== "keydown") return false;
  if (event.key.toLowerCase() !== "v") return false;
  const ctrl = event.ctrlKey === true;
  const meta = event.metaKey === true;
  const alt = event.altKey === true;
  const shift = event.shiftKey === true;
  if (!isMacPlatform && ctrl && shift && !meta && !alt) return true;
  return false;
}
