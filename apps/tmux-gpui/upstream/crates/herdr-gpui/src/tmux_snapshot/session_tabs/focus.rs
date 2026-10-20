//! Per-tab focus scope only. No handles, row capabilities, input or composition are retained.
use super::*;
use std::collections::HashMap;
#[derive(Clone, Copy)]
enum Scope {
    Terminal,
    Sidebar,
}
#[derive(Default)]
pub(in crate::tmux_snapshot) struct Focus {
    scopes: HashMap<String, Scope>,
    pub(in crate::tmux_snapshot) restore: bool,
}
impl SnapshotView {
    pub(in crate::tmux_snapshot) fn cancel_tab_focus_restore(&mut self) {
        self.session_tabs.focus.restore = false;
    }
    pub(super) fn remember_tab_focus(&mut self, window: &Window) {
        self.cancel_tab_focus_restore();
        let Some(tabs) = self.browser_state.session_tabs.as_ref() else {
            return;
        };
        let Some(id) = tabs.active.clone() else {
            return;
        };
        let scope = if self.sidebar_scope_focused(window) {
            Scope::Sidebar
        } else {
            Scope::Terminal
        };
        self.session_tabs
            .focus
            .scopes
            .retain(|id, _| tabs.rows.iter().any(|row| &row.id == id));
        self.session_tabs.focus.scopes.insert(id, scope);
        self.session_tabs.focus.restore = true;
    }
    pub(in crate::tmux_snapshot) fn restore_tab_focus(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.session_tabs.focus.restore {
            return;
        }
        if !self.presence.ready()
            || self.picker.is_some()
            || self.pane_actions.is_some()
            || self.new_session.is_some()
            || !self.marked.is_empty()
        {
            self.cancel_tab_focus_restore();
            return;
        }
        let state = &self.browser_state;
        if state.request != self.browser_request || self.session_tabs.pending.is_some() {
            return;
        }
        if state.surface != browser::Surface::Workspace {
            self.cancel_tab_focus_restore();
            return;
        }
        if state.retained_preview || state.frame.is_none() || state.selected_pane.is_none() {
            return;
        }
        let Some(tabs) = state
            .session_tabs
            .as_ref()
            .filter(|tabs| tabs.request == state.request && tabs.valid())
        else {
            self.cancel_tab_focus_restore();
            return;
        };
        let Some(active) = tabs.active.as_ref() else {
            return;
        };
        let scope = self
            .session_tabs
            .focus
            .scopes
            .get(active)
            .copied()
            .unwrap_or(Scope::Terminal);
        self.cancel_tab_focus_restore();
        if matches!(scope, Scope::Sidebar) && self.focus_sidebar_scope(window, cx) {
            return;
        }
        self.terminal_focus.focus(window, cx);
    }
}
