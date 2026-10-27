//! Retained tabs save bounded coordinates, never terminal frames or input authority.
use super::*;
use std::collections::HashMap;
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Selections {
    saved: HashMap<String, super::super::selection::Saved>,
    pub(in crate::tmux_snapshot) restore: bool,
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn cancel_tab_selection_restore(&mut self) {
        self.session_tabs.selections.restore = false;
    }
    pub(super) fn remember_tab_selection(&mut self) {
        let Some(tabs) = self.browser_state.session_tabs.as_ref() else {
            return;
        };
        let owner = &mut self.session_tabs.selections;
        owner
            .saved
            .retain(|id, _| tabs.rows.iter().any(|row| &row.id == id));
        if let Some(id) = tabs.active.as_ref() {
            owner.saved.remove(id);
            if let Some(saved) = self
                .selection
                .as_ref()
                .and_then(super::super::selection::Capture::save)
            {
                owner.saved.insert(id.clone(), saved);
            }
        }
        owner.restore = true;
    }
    pub(in crate::tmux_snapshot) fn restore_tab_selection(&mut self) {
        if !self.session_tabs.selections.restore {
            return;
        }
        if !self.presence.ready()
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || !self.marked.is_empty()
            || self.selection.is_some()
        {
            self.cancel_tab_selection_restore();
            return;
        }
        let state = &self.browser_state;
        if state.request != self.browser_request || self.session_tabs.pending.is_some() {
            return;
        }
        if state.retained_preview
            || state.frame.is_none()
            || state.selected_pane.is_none()
            || (!state.input_ready && state.history_offset == 0)
        {
            return;
        }
        self.session_tabs.selections.restore = false;
        if state.surface != browser::Surface::Workspace {
            return;
        }
        let Some(tabs) = state
            .session_tabs
            .as_ref()
            .filter(|tabs| tabs.request == state.request && tabs.valid())
        else {
            return;
        };
        self.session_tabs
            .selections
            .saved
            .retain(|id, _| tabs.rows.iter().any(|row| &row.id == id));
        let Some(active) = tabs.active.as_ref() else {
            return;
        };
        if let Some(saved) = self.session_tabs.selections.saved.remove(active) {
            self.selection = saved.restore(state);
        }
    }
}
