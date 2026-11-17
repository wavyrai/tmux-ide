//! Keys typed while a window shown again waits for its panes' fresh state.
//!
//! A window whose panes were hidden (their window was not on screen) is held
//! for at most a moment after it is shown again, until the daemon's fresh
//! state for them is in (herdr-client `REVEAL_MS`). The switch may not be the
//! app's own: a tmux binding typed into the pane or another client can change
//! the window. Keys typed during that hold are never dropped and never leave
//! input blocked (review of ccbf7006): they wait, and go to the pane selected
//! once the window is up, in order. Anything that makes that unsafe drops them
//! and shows "Not sent…", as every other hold does.
use super::*;

/// From the first held key to the window taking input. The hold itself lasts
/// at most 150 ms plus a round trip; this bounds a window that never comes.
pub(super) const REVEAL_LIMIT: Duration = Duration::from_secs(3);

pub(in crate::tmux_snapshot) struct Hold {
    /// The window is up: `Pending::id` and `token` name the selected pane.
    bound: bool,
}
impl Pending {
    /// Whether a reveal hold may go on waiting, or deliver, in `view`.
    pub(super) fn reveal_compatible(&self, hold: &Hold, view: &SnapshotView) -> bool {
        let state = &view.browser_state;
        self.started.elapsed() < REVEAL_LIMIT
            && self.request == view.browser_request
            && state.request == self.request
            && state.surface == browser::Surface::Workspace
            && state.selected_session.as_ref() == Some(&self.session)
            && state.presence_revision == self.presence
            && view.presence.ready()
            && !view.input_interrupted
            && !state.input_target_rejected
            && state.reconnect_attempt.is_none()
            && state.history_offset == 0
            && view.picker.is_none()
            && view.pane_actions.is_none()
            && view.new_session.is_none()
            && view.selection.is_none()
            && view.divider.is_none()
            && view.browser_commands.is_some()
            && (!hold.bound
                || (state.selected_pane.as_ref() == Some(&self.id)
                    && (state.input_targets.iter())
                        .any(|t| t.id == self.id && t.token == self.token)))
    }
}
impl SnapshotView {
    /// Starts holding keys while a window shown again waits for its fresh
    /// state. `false`: not such a wait, so the key is refused as before.
    pub(in crate::tmux_snapshot) fn hold_reveal_input(&mut self) -> bool {
        let state = &self.browser_state;
        if self.pending_input.is_some()
            || self.input_interrupted
            || !state.reveal_hold
            || state.reconnect_attempt.is_some()
            || state.surface != browser::Surface::Workspace
            || state.request != self.browser_request
            || state.history_offset != 0
            || !self.presence.ready()
            || self.selection.is_some()
            || self.resize_gesture.busy()
            || self.browser_commands.is_none()
        {
            return false;
        }
        let Some(session) = state.selected_session.clone() else {
            return false;
        };
        self.pending_input = Some(Pending {
            kind: Kind::Reveal(Hold { bound: false }),
            request: self.browser_request,
            id: String::new(),
            token: String::new(),
            session,
            presence: state.presence_revision,
            started: Instant::now(),
            inputs: Vec::new(),
            bytes: 0,
        });
        true
    }
    /// Binds the hold to the pane selected once the window takes input.
    pub(super) fn observe_reveal_hold(&mut self) {
        let waiting = (self.pending_input.as_ref())
            .is_some_and(|p| matches!(&p.kind, Kind::Reveal(hold) if !hold.bound));
        if !waiting || !self.terminal_input_ready() {
            return;
        }
        let Some(id) = self.browser_state.selected_pane.clone() else {
            return;
        };
        let token = (self.browser_state.input_targets.iter())
            .find(|t| t.id == id)
            .map(|t| t.token.clone());
        if let (Some(pending), Some(token)) = (self.pending_input.as_mut(), token)
            && let Kind::Reveal(hold) = &mut pending.kind
        {
            hold.bound = true;
            pending.id = id;
            pending.token = token;
        }
    }
}
