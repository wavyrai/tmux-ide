//! Selecting painted cells with the pointer, and the text a release copies.
//!
//! Selection is client-local: the daemon owns the terminal, and nothing here
//! sends input to it. Columns are addressed in the grid of the frame that
//! paints them, so a pane selection never leaves its inner rect and a popup
//! selection never reaches the panes underneath it. Rows are content rows: a
//! pane's absolute screen-buffer row (the one `pane.selection.read` takes),
//! which stays with its text while the pane scrolls, and a popup's own grid
//! row. A selection that reaches rows the pane no longer shows is read back
//! from the daemon instead of from the painted cells.

use super::HIDDEN;
use herdr_client::protocol::CellData;

/// Terminal content is untrusted and one cell's symbol carries as many bytes as
/// it likes, so a copy is bounded rather than trusted to be screen-sized.
pub(crate) const MAX_SELECTION_BYTES: usize = 4 << 20;

/// What a cell reads as: concealed cells read as blanks, never their hidden
/// text, and an empty cell as the blank a terminal paints.
pub(super) fn shown(cell: &CellData) -> &str {
    if cell.modifier & HIDDEN != 0 || cell.symbol.is_empty() {
        " "
    } else {
        cell.symbol.as_str()
    }
}
