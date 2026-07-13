/**
 * The unified app's color tokens — PURE data, hoisted out of app.tsx (M26) so
 * the surfaces extracted from it (starting with {@link ./sidebar.tsx}) carry
 * their palette with them instead of reaching back into a 21k-line module.
 *
 * Companion to {@link ./status-grammar.ts}: that file owns the per-AGENT-STATE
 * glyph + hue (a status signal), this one owns the CHROME (surface, accent,
 * hover, selection). Keep the two families distinct — focus is an accent signal,
 * agent state is a status signal, and they must never collide on a hue.
 *
 * Node-free on purpose: the web host (docs/tui-web) imports this module
 * verbatim, aliasing @opentui/core to a browser shim for RGBA.
 */
import { RGBA } from "@opentui/core";

export const DEFAULT_FG = RGBA.fromInts(212, 212, 216, 255);
export const DEFAULT_BG = RGBA.fromInts(16, 16, 22, 255);

/** The sidebar's surface — one lift above DEFAULT_BG so the nav column reads as
 *  chrome, not as content. */
export const SIDEBAR_BG = RGBA.fromInts(22, 22, 30, 255);
export const ACCENT = RGBA.fromInts(130, 170, 255, 255);
export const MUTED = RGBA.fromInts(110, 110, 130, 255);
export const BADGE_BG = RGBA.fromInts(60, 66, 92, 255);

/** Focused-pane gutter hairline (M22.7): the ACCENT family, drawn as │/─ glyphs
 *  so the gutter stays visually thin (a filled bar read as extra padding — user
 *  feedback). Doesn't compete with the blocked chip's red — focus is an accent
 *  signal, agent state is a status signal, never the same hue. */
export const FOCUS_BORDER_FG = RGBA.fromInts(110, 145, 230, 255);

/** The selected row/tab. Always wins over HOVER_BG. */
export const TAB_ACTIVE_BG = RGBA.fromInts(40, 46, 66, 255);

/** A single subtle pointer-hover tint, one lift above both DEFAULT_BG (16,16,22)
 *  and SIDEBAR_BG (22,22,30) and below TAB_ACTIVE_BG — the active/selected state
 *  always wins over hover. Used on every hoverable row/segment. */
export const HOVER_BG = RGBA.fromInts(30, 34, 48, 255);

/** A chip/button under the pointer. */
export const BUTTON_HOVER_BG = RGBA.fromInts(52, 60, 86, 255);

/** The attention flash (M25.1): a just-flipped hidden agent's row pulses this
 *  for a beat — the status-strip note's "look here" twin. */
export const CHIP_ATTN_BG = RGBA.fromInts(92, 44, 48, 255);
