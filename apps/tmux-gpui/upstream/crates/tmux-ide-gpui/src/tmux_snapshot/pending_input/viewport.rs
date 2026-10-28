//! Hold keyboard input across a viewport resize explicitly sent by this view.
use super::*;
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn capture_viewport_input(&mut self, cols: u16, rows: u16) {
        if !self.terminal_input_ready()
            || self.input_interrupted
            || self.selection.is_some()
            || self.browser_state.history_offset != 0
            || self
                .frame
                .as_ref()
                .is_none_or(|f| f.view().width() == cols && f.view().height() == rows)
        {
            return;
        }
        let Some(id) = self.browser_state.selected_pane.as_deref() else {
            return;
        };
        if self
            .pending_input
            .as_ref()
            .is_some_and(|p| !p.compatible(self))
        {
            return;
        }
        if let Some(pending) = self.pending_input.as_mut() {
            // Existing selection/focus input retains its original bounded deadline and FIFO.
            pending.kind = Kind::Viewport { cols, rows };
            pending.presence = self.browser_state.presence_revision;
            return;
        }
        if let Some(mut pending) = Pending::capture(self, self.browser_request, id) {
            pending.kind = Kind::Viewport { cols, rows };
            self.pending_input = Some(pending);
        }
    }
}
