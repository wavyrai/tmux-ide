/** Compatibility seam for the OpenTUI renderer. Protocol data lives in core so
 * the browser/xterm and TUI/framebuffer adapters consume the same palette. */
export { XTERM_PALETTE } from "@tmux-ide/core";
