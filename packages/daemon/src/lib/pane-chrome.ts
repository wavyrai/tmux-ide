/**
 * Shared tmux pane-chrome contract.
 *
 * This is deliberately engine-neutral: launch/promotion reserve the row, the
 * TUI updater fills the chip option, and the GUI paints its interactive header
 * over exactly the same row. Keeping the wire-format constants here prevents
 * either presentation adapter from becoming the other's dependency.
 */

/** Per-pane chip rendered by native tmux when the GUI is not covering the row. */
export const PANE_CHROME_CHIP_OPTION = "@tmux_ide_chip";

/** One information-bearing tmux row shared by native tmux and browser chrome. */
export const PANE_CHROME_BORDER_FORMAT = ` #{?#{${PANE_CHROME_CHIP_OPTION}},#{${PANE_CHROME_CHIP_OPTION}},#{pane_title}} `;
